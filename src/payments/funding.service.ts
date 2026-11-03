import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { transfersCover } from '../chain/chain';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { fundingTransactions, Payment, payments, planItems, plans, users } from '../database/schema';
import { PlanRefused } from '../plans/plan-refused';
import { PaymentEngine } from './payment-engine.service';

const SIGNATURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOG_RANGE = 2000;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Decides that the user's USDC really left, by reading the chain. A browser's word is never enough. */
@Injectable()
export class FundingService {
  private readonly logger = new Logger(FundingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly chain: Chain,
    private readonly engine: PaymentEngine,
  ) {}

  private async planPayments(planId: string): Promise<Payment[]> {
    const rows = await this.db
      .select({ payment: payments })
      .from(payments)
      .innerJoin(planItems, eq(payments.planItemId, planItems.id))
      .where(eq(planItems.planId, planId));
    return rows.map((row) => row.payment);
  }

  /** Safe to call twice with one transaction. A transaction that backed another plan is refused. */
  async confirm(userId: string, planId: string, txHash: string): Promise<void> {
    if (!HASH.test(txHash)) throw new PlanRefused('That is not a transaction hash.');
    const [plan] = await this.db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
    if (!plan) throw new PlanRefused('Plan not found.');

    const hash = txHash.toLowerCase();
    await this.db.insert(fundingTransactions).values({ txHash: hash, ownerId: planId }).onConflictDoNothing();
    const [claim] = await this.db.select().from(fundingTransactions).where(eq(fundingTransactions.txHash, hash));
    if (claim!.ownerId !== planId) throw new PlanRefused('That transaction was already used for another payment.');

    const waiting = (await this.planPayments(planId)).filter((payment) => payment.status === 'awaiting_signature' || payment.status === 'funding');
    if (waiting.length === 0) return;
    await this.db
      .update(payments)
      .set({ status: 'funding', fundingTxHash: hash })
      .where(inArray(payments.id, waiting.map((payment) => payment.id)));
    const matched = await this.settle(userId, planId, hash);
    if (matched === 'mismatch') {
      await this.db.delete(fundingTransactions).where(eq(fundingTransactions.txHash, hash));
      throw new PlanRefused('That transaction does not match this payment.');
    }
  }

  /** Reads the transaction once. Pending means try again on a later pass. */
  private async settle(userId: string, planId: string, hash: string): Promise<'settled' | 'pending' | 'mismatch'> {
    const rows = (await this.planPayments(planId)).filter((payment) => payment.status === 'funding');
    if (rows.length === 0) return 'settled';
    const outcome = await this.chain.outcome(hash);
    if (outcome.state === 'pending') return 'pending';
    const ids = rows.map((payment) => payment.id);
    if (outcome.state === 'reverted') {
      await this.db
        .update(payments)
        .set({ status: 'failed', failureReason: 'The transaction failed, so nothing moved.' })
        .where(inArray(payments.id, ids));
      return 'settled';
    }
    const [owner] = await this.db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, userId));
    const expected = rows.map((payment) => ({ address: payment.fundingAddress!, usdcMinor: payment.usdcMinor }));
    if (!owner?.wallet || !transfersCover(outcome.transfers, owner.wallet, expected)) {
      await this.db.update(payments).set({ status: 'awaiting_signature', fundingTxHash: null }).where(inArray(payments.id, ids));
      return 'mismatch';
    }
    await this.db.update(payments).set({ status: 'funded' }).where(inArray(payments.id, ids));
    await Promise.all(ids.map((id) => this.engine.deliver(id)));
    return 'settled';
  }

  /** The user declined to sign. Only a payment that has not gone to the chain can be dropped. */
  async abandon(userId: string, planId: string): Promise<void> {
    const rows = (await this.planPayments(planId)).filter((payment) => payment.status === 'awaiting_signature' && payment.userId === userId);
    if (rows.length === 0) return;
    await this.db
      .update(payments)
      .set({ status: 'failed', failureReason: 'Not signed, so nothing moved.' })
      .where(inArray(payments.id, rows.map((payment) => payment.id)));
  }

  async reconcile(): Promise<void> {
    const funding = await this.db
      .selectDistinct({ planId: planItems.planId, userId: payments.userId, hash: payments.fundingTxHash })
      .from(payments)
      .innerJoin(planItems, eq(payments.planItemId, planItems.id))
      .where(eq(payments.status, 'funding'))
      .limit(100);
    for (const row of funding) {
      try {
        const result = await this.settle(row.userId, row.planId, row.hash!);
        if (result === 'mismatch') this.logger.warn(`Funding transaction did not match plan ${row.planId}`);
      } catch (error) {
        this.logger.error(`Could not read funding for ${row.planId}: ${(error as Error).name}`);
      }
    }
    await this.expireUnsigned();
  }

  /**
   * Past the signing window, look on the chain before giving up: the browser may have closed
   * after the wallet sent the transaction, and that money must still be delivered.
   */
  private async expireUnsigned(): Promise<void> {
    const cutoff = new Date(Date.now() - SIGNATURE_WINDOW_MS);
    const late = await this.db
      .select({ payment: payments, planId: planItems.planId, wallet: users.walletAddress })
      .from(payments)
      .innerJoin(planItems, eq(payments.planItemId, planItems.id))
      .innerJoin(users, eq(payments.userId, users.id))
      .where(and(eq(payments.status, 'awaiting_signature'), lt(payments.createdAt, cutoff)))
      .limit(200);
    const byPlan = new Map<string, typeof late>();
    for (const row of late) byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), row]);

    for (const [planId, rows] of byPlan) {
      const first = rows[0]!;
      try {
        const latest = await this.chain.latestBlock();
        // Only blocks after approval, so an earlier payment of the same amount cannot be mistaken for this one.
        const from = (first.payment.fundingFromBlock ?? latest) + 1;
        const seen = first.wallet && from <= latest ? await this.chain.transfers({ from: [first.wallet] }, from, Math.min(latest, from + MAX_LOG_RANGE)) : [];
        const expected = rows.map((row) => ({ address: row.payment.fundingAddress!, usdcMinor: row.payment.usdcMinor }));
        const candidates = [...new Set(seen.map((transfer) => transfer.txHash.toLowerCase()))];
        const taken = candidates.length
          ? await this.db.select({ txHash: fundingTransactions.txHash }).from(fundingTransactions).where(inArray(fundingTransactions.txHash, candidates))
          : [];
        const hashes = candidates.filter((candidate) => !taken.some((row) => row.txHash === candidate));
        const hash = hashes.find((candidate) => transfersCover(seen.filter((transfer) => transfer.txHash.toLowerCase() === candidate), first.wallet!, expected));
        if (hash) {
          await this.confirm(first.payment.userId, planId, hash);
          continue;
        }
        await this.db
          .update(payments)
          .set({ status: 'failed', failureReason: 'Not signed in time, so nothing moved.' })
          .where(inArray(payments.id, rows.map((row) => row.payment.id)));
      } catch (error) {
        this.logger.error(`Could not expire plan ${planId}: ${(error as Error).name}`);
      }
    }
  }
}
