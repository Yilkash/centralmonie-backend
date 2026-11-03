import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { transfersCover } from '../chain/chain';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { fundingTransactions, Payment, payments, planItems, plans, users } from '../database/schema';
import { PlanRefused } from '../plans/plan-refused';
import { PaymentEngine } from './payment-engine.service';

const SIGNATURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOG_RANGE = 2000;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const OPEN: Payment['status'][] = ['awaiting_signature', 'funding'];

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

  /**
   * Safe to call twice with one transaction. The chain is read before anything is claimed, and only a
   * transfer from this user's own wallet counts, so nobody can use up another person's transaction.
   */
  async confirm(userId: string, planId: string, txHash: string): Promise<void> {
    if (!HASH.test(txHash)) throw new PlanRefused('That is not a transaction hash.');
    const [plan] = await this.db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
    if (!plan) throw new PlanRefused('Plan not found.');
    const waiting = (await this.planPayments(planId)).filter((payment) => OPEN.includes(payment.status));
    if (waiting.length === 0) return;

    const hash = txHash.toLowerCase();
    const result = await this.settle(userId, planId, hash);
    if (result === 'mismatch') throw new PlanRefused('That transaction does not match this payment.');
    if (result === 'taken') throw new PlanRefused('That transaction was already used for another payment.');
  }

  /** Every status write names the status it expects, so a slower caller can never undo a faster one. */
  private async settle(userId: string, planId: string, hash: string): Promise<'settled' | 'pending' | 'mismatch' | 'taken'> {
    const rows = (await this.planPayments(planId)).filter((payment) => OPEN.includes(payment.status));
    if (rows.length === 0) return 'settled';
    const ids = rows.map((payment) => payment.id);
    const open = and(inArray(payments.id, ids), inArray(payments.status, OPEN));

    const outcome = await this.chain.outcome(hash);
    if (outcome.state === 'pending') {
      await this.db.update(payments).set({ status: 'funding', fundingTxHash: hash }).where(open);
      return 'pending';
    }
    if (outcome.state === 'reverted') {
      await this.db.update(payments).set({ status: 'failed', failureReason: 'The transaction failed, so nothing moved.' }).where(open);
      return 'settled';
    }
    const [owner] = await this.db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, userId));
    const expected = rows.map((payment) => ({ address: payment.fundingAddress!, usdcMinor: payment.usdcMinor }));
    if (!owner?.wallet || !transfersCover(outcome.transfers, owner.wallet, expected)) {
      await this.db.update(payments).set({ status: 'awaiting_signature', fundingTxHash: null }).where(open);
      return 'mismatch';
    }
    // Per wallet, because a bundler can put two users' operations in one transaction.
    const wallet = owner.wallet.toLowerCase();
    await this.db.insert(fundingTransactions).values({ txHash: hash, wallet, ownerId: planId }).onConflictDoNothing();
    const [claim] = await this.db.select().from(fundingTransactions).where(and(eq(fundingTransactions.txHash, hash), eq(fundingTransactions.wallet, wallet)));
    if (claim!.ownerId !== planId) {
      await this.db.update(payments).set({ status: 'awaiting_signature', fundingTxHash: null }).where(open);
      return 'taken';
    }
    const funded = await this.db.update(payments).set({ status: 'funded', fundingTxHash: hash }).where(open).returning({ id: payments.id });
    await Promise.all(funded.map((row) => this.engine.deliver(row.id)));
    return 'settled';
  }

  /** Looks on the chain for a transaction this plan's wallet already sent, and settles it. True if found. */
  private async findSent(userId: string, planId: string): Promise<boolean> {
    const rows = (await this.planPayments(planId)).filter((payment) => OPEN.includes(payment.status));
    const [owner] = await this.db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, userId));
    if (rows.length === 0 || !owner?.wallet) return false;
    const latest = await this.chain.latestBlock();
    // Only blocks after approval, so an earlier payment of the same amount cannot be mistaken for this one.
    const from = (rows[0]!.fundingFromBlock ?? latest) + 1;
    if (from > latest) return false;
    const seen = await this.chain.transfers({ from: [owner.wallet] }, from, Math.min(latest, from + MAX_LOG_RANGE));
    const expected = rows.map((row) => ({ address: row.fundingAddress!, usdcMinor: row.usdcMinor }));
    const candidates = [...new Set(seen.map((transfer) => transfer.txHash.toLowerCase()))];
    const taken = candidates.length
      ? await this.db
          .select({ txHash: fundingTransactions.txHash })
          .from(fundingTransactions)
          .where(and(inArray(fundingTransactions.txHash, candidates), eq(fundingTransactions.wallet, owner.wallet.toLowerCase())))
      : [];
    const hash = candidates
      .filter((candidate) => !taken.some((row) => row.txHash === candidate))
      .find((candidate) => transfersCover(seen.filter((transfer) => transfer.txHash.toLowerCase() === candidate), owner.wallet!, expected));
    if (!hash) return false;
    return (await this.settle(userId, planId, hash)) === 'settled';
  }

  /** Called before the wallet is asked to sign again: if the first send landed, there is nothing to sign. */
  async recheck(userId: string, planId: string): Promise<void> {
    await this.findSent(userId, planId);
  }

  /** The user said no. Only drops what truly has not gone to the chain, after looking. */
  async abandon(userId: string, planId: string): Promise<void> {
    if (await this.findSent(userId, planId)) return;
    const rows = (await this.planPayments(planId)).filter((payment) => payment.status === 'awaiting_signature' && payment.userId === userId);
    if (rows.length === 0) return;
    await this.db
      .update(payments)
      .set({ status: 'failed', failureReason: 'Not signed, so nothing moved.' })
      .where(and(inArray(payments.id, rows.map((payment) => payment.id)), eq(payments.status, 'awaiting_signature')));
  }

  async reconcile(): Promise<void> {
    const funding = await this.db
      .selectDistinct({ planId: planItems.planId, userId: payments.userId, hash: payments.fundingTxHash, createdAt: payments.createdAt })
      .from(payments)
      .innerJoin(planItems, eq(payments.planItemId, planItems.id))
      .where(eq(payments.status, 'funding'))
      .orderBy(asc(payments.createdAt))
      .limit(100);
    const cutoff = new Date(Date.now() - SIGNATURE_WINDOW_MS);
    for (const row of funding) {
      try {
        const result = await this.settle(row.userId, row.planId, row.hash!);
        if (result === 'mismatch' || result === 'taken') this.logger.warn(`Funding transaction did not fit plan ${row.planId}: ${result}`);
        // A hash the chain never heard of, real or made up, cannot hold a payment open for ever.
        if (result === 'pending' && row.createdAt < cutoff) {
          await this.db
            .update(payments)
            .set({ status: 'awaiting_signature', fundingTxHash: null })
            .where(and(eq(payments.fundingTxHash, row.hash!), eq(payments.status, 'funding'), eq(payments.userId, row.userId)));
        }
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
      .selectDistinct({ planId: planItems.planId, userId: payments.userId, createdAt: payments.createdAt })
      .from(payments)
      .innerJoin(planItems, eq(payments.planItemId, planItems.id))
      .where(and(eq(payments.status, 'awaiting_signature'), lt(payments.createdAt, cutoff)))
      .orderBy(asc(payments.createdAt))
      .limit(100);
    for (const { planId, userId } of late) {
      try {
        if (await this.findSent(userId, planId)) continue;
        const rows = (await this.planPayments(planId)).filter((payment) => payment.status === 'awaiting_signature');
        if (rows.length === 0) continue;
        await this.db
          .update(payments)
          .set({ status: 'failed', failureReason: 'Not signed in time, so nothing moved.' })
          .where(and(inArray(payments.id, rows.map((row) => row.id)), eq(payments.status, 'awaiting_signature')));
      } catch (error) {
        this.logger.error(`Could not expire plan ${planId}: ${(error as Error).name}`);
      }
    }
  }
}
