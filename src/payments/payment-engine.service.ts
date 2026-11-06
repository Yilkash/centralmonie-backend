import { CrossChain } from '../agent-api/cross-chain';
import { chainOfWallet } from '../chain/usdc-chains';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { Payment, payments, users } from '../database/schema';
import { formatUsdc } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentProvider, PaymentRequest } from '../providers/providers';

const STUCK_AFTER_MS = 10 * 60 * 1000;
const PENDING_LIMIT_MS = 24 * 60 * 60 * 1000;

const requestFor = (payment: Payment): PaymentRequest => ({
  // The same reference the partner saw when it gave the funding address.
  reference: payment.planItemId ?? payment.scheduleRunId ?? payment.id,
  route: payment.route,
  destination: payment.destination,
  amountKobo: payment.amountKobo,
  usdcMinor: payment.usdcMinor,
});

/**
 * The only code that tells a partner to pay. It runs after the USDC has been seen on the chain,
 * and each step claims the row first, so two runs cannot deliver one payment twice.
 */
@Injectable()
export class PaymentEngine {
  private readonly logger = new Logger(PaymentEngine.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly provider: PaymentProvider,
    private readonly chain: Chain,
    private readonly notifications: NotificationsService,
    private readonly crossChain: CrossChain,
  ) {}

  /** Simulated mode: no USDC moves, so the partner step is all there is. */
  async paySimulated(payment: Payment): Promise<void> {
    const result = await this.provider.pay(requestFor(payment)).catch((error: Error) => ({ ok: false as const, reason: error.message }));
    await this.db
      .update(payments)
      .set(result.ok ? { status: 'completed', providerReference: result.providerReference } : { status: 'failed', failureReason: result.reason })
      .where(eq(payments.id, payment.id));
  }

  async deliver(paymentId: string): Promise<void> {
    const [payment] = await this.db
      .update(payments)
      .set({ status: 'paying' })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'funded')))
      .returning();
    if (!payment) return;
    if (payment.route === 'usdc') {
      if (chainOfWallet(payment.destination as { walletAddress?: string; network?: string | null }).key !== 'base') {
        // On its way, not there. The background job follows it, and Paid waits for delivery.
        await this.finish(payment.id, { providerReference: payment.fundingAddress });
        return;
      }
      // The funding transfer went straight to the recipient, so it is the payment.
      await this.finish(payment.id, { status: 'completed', providerReference: payment.fundingTxHash });
      return;
    }
    await this.callPartner(payment);
  }

  private async callPartner(payment: Payment): Promise<void> {
    let result;
    try {
      result = await this.provider.pay(requestFor(payment));
    } catch (error) {
      // We do not know if the partner took it. Leave it paying: pay() is safe to repeat, so a later pass asks again.
      this.logger.error(`Partner call failed for ${payment.id}: ${(error as Error).name}`);
      return;
    }
    if (!result.ok) return this.giveBack(payment, result.reason);
    if (result.pending) await this.finish(payment.id, { providerReference: result.providerReference });
    else await this.finish(payment.id, { status: 'completed', providerReference: result.providerReference });
  }

  private async finish(paymentId: string, values: Partial<Payment>): Promise<void> {
    await this.db.update(payments).set(values).where(eq(payments.id, paymentId));
  }

  /** Delivery failed after the USDC left the wallet. Return it if it is in our own hands. */
  private async giveBack(payment: Payment, reason: string): Promise<void> {
    const name = payment.recipientName ?? 'the recipient';
    const claimed = await this.db
      .update(payments)
      .set({ status: 'returning', failureReason: reason })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'paying')))
      .returning();
    if (claimed.length === 0) return;

    const support = async (text: string) => {
      await this.finish(payment.id, { status: 'needs_support' });
      await this.notifications.notify(payment.userId, text);
    };
    const keep = `Your payment to ${name} failed, and ${formatUsdc(payment.usdcMinor)} has not come back yet. Our team is on it.`;
    if (!payment.refundable) return support(keep);

    const [owner] = await this.db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, payment.userId));
    try {
      const hash = owner?.wallet ? await this.chain.sendFromCollection(owner.wallet, payment.usdcMinor) : null;
      if (!hash) return await support(keep);
      await this.finish(payment.id, { status: 'returned', refundTxHash: hash });
      await this.notifications.notify(payment.userId, `Your payment to ${name} failed, so ${formatUsdc(payment.usdcMinor)} went back to your wallet.`, hash);
    } catch (error) {
      // The refund may or may not have gone out. A person must check before anything is sent again.
      this.logger.error(`Refund failed for ${payment.id}: ${(error as Error).name}`);
      await support(keep);
    }
  }

  /** Picks up whatever a crash or a slow partner left behind. */
  async reconcile(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const open = await this.db.select().from(payments).where(inArray(payments.status, ['funded', 'paying'])).limit(100);
    for (const payment of open) {
      try {
        if (payment.status === 'funded') await this.deliver(payment.id);
        else if (payment.providerReference) await this.checkPartner(payment);
        else if (payment.createdAt < cutoff) await this.callPartner(payment);
      } catch (error) {
        this.logger.error(`Could not reconcile ${payment.id}: ${(error as Error).name}`);
      }
    }
    // A refund interrupted part way is never retried blindly, because it might have gone out.
    await this.db
      .update(payments)
      .set({ status: 'needs_support' })
      .where(and(eq(payments.status, 'returning'), lt(payments.createdAt, cutoff)));
  }

  /** Only reads where the money is. NEAR Intents holds it from here, and refunds the user's wallet itself. */
  private async followDelivery(payment: Payment): Promise<void> {
    const chain = chainOfWallet(payment.destination as { walletAddress?: string; network?: string | null });
    const name = payment.recipientName ?? 'the recipient';
    const state = await this.crossChain.status(payment.fundingAddress!);
    const closed = async (values: Partial<Payment>, text: string) => {
      const moved = await this.db.update(payments).set(values).where(and(eq(payments.id, payment.id), eq(payments.status, 'paying'))).returning({ id: payments.id });
      if (moved.length > 0) await this.notifications.notify(payment.userId, text);
    };
    if (state.status === 'delivered') {
      const received = state.receivedMinor ? `${(state.receivedMinor / 1_000_000).toFixed(2)} ${chain.token}` : formatUsdc(payment.usdcMinor);
      await closed({ status: 'completed', providerReference: state.destinationTx ?? state.transactions.at(-1) ?? payment.fundingAddress, deliveredMinor: state.receivedMinor ?? null }, `${received} reached ${name} on ${chain.name}.`);
    } else if (state.status === 'refunded') {
      await closed({ status: 'returned', failureReason: `It could not be delivered on ${chain.name}.` }, `Your payment to ${name} on ${chain.name} could not be delivered, so your USDC was sent back to your wallet, less a small fee.`);
    } else if (state.status === 'failed') {
      await closed({ status: 'needs_support', failureReason: `It could not be delivered on ${chain.name}.` }, `Your payment to ${name} on ${chain.name} failed, and ${formatUsdc(payment.usdcMinor)} has not come back yet. Our team is on it.`);
    } else if (payment.createdAt.getTime() < Date.now() - PENDING_LIMIT_MS) {
      await closed({ status: 'needs_support', failureReason: 'This has not arrived after a day.' }, `Your payment to ${name} on ${chain.name} has not arrived after a day. Our team is checking. Please do not send it again.`);
      this.logger.error(`Payment ${payment.id} has been on its way for over a day`);
    }
  }

  private async checkPartner(payment: Payment): Promise<void> {
    if (payment.route === 'usdc') return this.followDelivery(payment);
    const state = await this.provider.status(requestFor(payment).reference, payment.providerReference!, payment.route);
    if (state.state === 'completed') {
      await this.finish(payment.id, { status: 'completed' });
      await this.notifications.notify(payment.userId, `Your payment to ${payment.recipientName ?? 'the recipient'} has been delivered.`);
    } else if (state.state === 'failed') {
      await this.giveBack(payment, state.reason);
    } else if (payment.createdAt.getTime() < Date.now() - PENDING_LIMIT_MS) {
      // Refunding here could pay twice if the partner delivers late, so a person decides.
      await this.finish(payment.id, { status: 'needs_support', failureReason: 'The partner has not settled this after a day.' });
      this.logger.error(`Payment ${payment.id} has been pending for over a day`);
    }
  }
}
