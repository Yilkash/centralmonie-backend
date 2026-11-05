import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAddress } from 'viem';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { AgentKey, agentKeys, AgentPayment, agentPayments } from '../database/schema';
import { formatNaira, koboToUsdcMinor } from '../money/money';
import { AuditService } from '../ops/audit.service';
import { AGENT_STATUSES_THAT_COUNT, GuardsService } from '../ops/guards.service';
import { AgentPayout, BankLookup, ExchangeRates, PaymentProvider } from '../providers/providers';
import { CrossChain, PayFrom } from './cross-chain';

const QUOTE_LIFETIME_MS = 10 * 60_000;
const DEPOSIT_WINDOW_MS = 30 * 60_000;
const STUCK_CREATING_MS = 2 * 60_000;
const MAX_QUOTES_A_DAY = 200;
/** The partner fixes the naira when the payment is created. A smaller gap than this is ordinary rate movement. */
const PRICE_TOLERANCE = 0.995;
const OPEN = ['awaiting_deposit', 'processing', 'paying'] as const;

/** The shared key behind every keyless payment, so they use the same code, limits and records as any other. */
export const KEYLESS_KEY_ID = '00000000-0000-4000-8000-000000000402';
const KEYLESS = {
  perPaymentKobo: 50_000 * 100,
  perWalletDayKobo: 100_000 * 100,
  perAccountDayKobo: 100_000 * 100,
  totalDayKobo: 200_000 * 100,
  quotesPerIpHour: 30,
};

const startOfLagosDay = sql`(date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`;

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** A refusal an agent's code can act on: a stable code, a sentence, and the HTTP status. */
export class AgentRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Test mode moves nothing, so it is open. With real money, it needs its own switch as well. */
export function agentApiOpen(mode: 'simulated' | 'chain', enabled: boolean): boolean {
  return mode === 'simulated' || enabled;
}

export function validRefundAddress(payFrom: PayFrom, address: string): boolean {
  if (payFrom === 'near') return /^[a-z0-9._-]{2,64}$/.test(address);
  if (payFrom === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return isAddress(address);
}

export interface QuoteInput {
  amountNaira: number;
  bankName: string;
  accountNumber: string;
  payFrom: PayFrom;
  refundTo: string;
  payerName?: string;
  payerEmail?: string;
  purpose?: string;
  clientIp?: string;
}

/** The way in for other AI agents. It uses no AI: ordinary code checks the request and tracks the money. */
@Injectable()
export class AgentApiService {
  private readonly logger = new Logger(AgentApiService.name);
  private readonly ipWindows = new Map<string, { until: number; count: number }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
    private readonly rates: ExchangeRates,
    private readonly banks: BankLookup,
    private readonly provider: PaymentProvider,
    private readonly payout: AgentPayout,
    private readonly crossChain: CrossChain,
    private readonly guards: GuardsService,
    private readonly audit: AuditService,
  ) {}

  get open(): boolean {
    return agentApiOpen(this.config.get('PAYMENTS_MODE', { infer: true }), this.config.get('AGENT_API_ENABLED', { infer: true }));
  }

  get keylessOpen(): boolean {
    return this.config.get('PAYMENTS_MODE', { infer: true }) === 'simulated' || (this.open && this.config.get('X402_KEYLESS_ENABLED', { infer: true }));
  }

  /** Its random hash is only ever a signing secret: nobody holds a key that matches it. */
  async keylessKey(): Promise<AgentKey> {
    await this.db
      .insert(agentKeys)
      .values({ id: KEYLESS_KEY_ID, name: 'Keyless x402', keyHash: hashKey(randomBytes(32).toString('hex')), dailyLimitKobo: KEYLESS.totalDayKobo })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(agentKeys).where(eq(agentKeys.id, KEYLESS_KEY_ID));
    if (row!.revokedAt) throw new AgentRefusal('unavailable', 'Paying without a key is stopped for now.', 503);
    return row!;
  }

  /** In memory, so a restart clears it. It slows abuse of the bank lookup: the money limits are elsewhere. */
  private countIp(ip: string): void {
    const now = Date.now();
    if (this.ipWindows.size > 10_000) this.ipWindows.clear();
    const window = this.ipWindows.get(ip);
    const current = window && window.until > now ? window : { until: now + 3_600_000, count: 0 };
    current.count += 1;
    this.ipWindows.set(ip, current);
    if (current.count > KEYLESS.quotesPerIpHour) throw new AgentRefusal('too_many_quotes', 'Too many quotes from this address. Try again later.', 429);
  }

  /** The key is returned here and never again. */
  async createKey(name: string, dailyLimitNaira: number): Promise<{ id: string; key: string }> {
    const key = `10k_${randomBytes(32).toString('base64url')}`;
    const [row] = await this.db.insert(agentKeys).values({ name, keyHash: hashKey(key), dailyLimitKobo: dailyLimitNaira * 100 }).returning();
    await this.audit.record('admin', 'agent_key.created', row!.id, { name, dailyLimitNaira });
    return { id: row!.id, key };
  }

  async revokeKey(id: string): Promise<boolean> {
    const rows = await this.db.update(agentKeys).set({ revokedAt: new Date() }).where(eq(agentKeys.id, id)).returning({ id: agentKeys.id });
    if (rows.length > 0) await this.audit.record('admin', 'agent_key.revoked', id);
    return rows.length > 0;
  }

  async keyFrom(key: string): Promise<AgentKey | null> {
    const [row] = await this.db.select().from(agentKeys).where(eq(agentKeys.keyHash, hashKey(key)));
    return row && !row.revokedAt ? row : null;
  }

  /** Reserves nothing and moves nothing. The agent sees the bank's name for the account before it commits. */
  async quote(key: AgentKey, input: QuoteInput): Promise<AgentPayment> {
    const amountKobo = input.amountNaira * 100;
    if (!validRefundAddress(input.payFrom, input.refundTo)) throw new AgentRefusal('invalid_refund_address', `That is not a valid ${input.payFrom} address to refund.`, 400);

    const keyless = key.id === KEYLESS_KEY_ID;
    if (keyless) {
      this.countIp(input.clientIp ?? 'unknown');
      if (amountKobo > KEYLESS.perPaymentKobo) throw new AgentRefusal('over_payment_limit', `Without an API key, the most for one payment is ${formatNaira(KEYLESS.perPaymentKobo)}.`, 422);
      await this.assertKeylessCaps(amountKobo, input.refundTo, input.accountNumber, this.db);
    }

    const [{ made } = { made: 0 }] = keyless ? [] : await this.db
      .select({ made: count() })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
    if (made >= MAX_QUOTES_A_DAY) throw new AgentRefusal('too_many_quotes', 'This key has asked for too many quotes today.', 429);

    await this.assertAllowed(key, amountKobo, this.db);

    const accountName = await this.banks.accountName(input.bankName, input.accountNumber).catch(() => {
      throw new AgentRefusal('bank_unavailable', 'We could not check that account just now. Nothing was sent. Please try again.', 503);
    });
    if (!accountName) throw new AgentRefusal('account_not_found', 'We could not find that account. Check the bank and the account number.', 404);

    const rate = await this.rates.nairaPerUsdc().catch(() => {
      throw new AgentRefusal('rate_unavailable', 'We could not get a rate just now. Nothing was sent. Please try again.', 503);
    });
    const usdcMinor = koboToUsdcMinor(amountKobo, rate);
    const minimum = this.provider.minimumUsdcMinor('bank');
    if (usdcMinor < minimum) throw new AgentRefusal('below_minimum', `The smallest payment is about ${formatNaira(Math.ceil((minimum * rate) / 10_000 / 100) * 100)}.`, 422);

    const { payInMinor } = await this.crossChain
      .priceCheck({ payFrom: input.payFrom, usdcMinor, recipient: this.config.get('COLLECTION_ADDRESS', { infer: true }) ?? input.refundTo, refundTo: input.refundTo, deadline: new Date(Date.now() + DEPOSIT_WINDOW_MS) })
      .catch((error: Error) => {
        this.logger.warn(`price check failed: ${error.message.slice(0, 200)}`);
        throw new AgentRefusal('route_unavailable', 'We could not price that route just now. Nothing was sent. Please try again.', 503);
      });

    const [row] = await this.db
      .insert(agentPayments)
      .values({
        id: randomUUID(),
        keyId: key.id,
        amountKobo,
        usdcMinor,
        payInMinor,
        bankName: input.bankName,
        accountNumber: input.accountNumber,
        accountName,
        payFrom: input.payFrom,
        refundTo: input.refundTo,
        payerName: input.payerName ?? null,
        payerEmail: input.payerEmail ?? null,
        purpose: input.purpose ?? null,
        clientIp: input.clientIp ?? null,
        quoteExpiresAt: new Date(Date.now() + QUOTE_LIFETIME_MS),
      })
      .returning();
    return row!;
  }

  /**
   * Accepting twice gives the same payment, so an agent can safely retry after a lost connection. The
   * limits are checked under a lock on the key, so two requests at once cannot both use the last of them.
   */
  async accept(key: AgentKey, id: string): Promise<AgentPayment> {
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key.id}))`);
      const [row] = await tx.select().from(agentPayments).where(and(eq(agentPayments.id, id), eq(agentPayments.keyId, key.id)));
      if (!row) throw new AgentRefusal('not_found', 'No such quote.', 404);
      if (row.status === 'creating') throw new AgentRefusal('in_progress', 'This payment is being set up. Try again in a moment.', 409);
      if (row.status === 'expired' && !row.depositAddress) throw new AgentRefusal('quote_expired', 'This quote has expired. Ask for a new one.', 410);
      if (row.status !== 'quoted') return { row, fresh: false };
      if (row.quoteExpiresAt.getTime() <= Date.now()) {
        await tx.update(agentPayments).set({ status: 'expired', updatedAt: new Date() }).where(eq(agentPayments.id, id));
        return { row: null, fresh: false };
      }
      await this.assertAllowed(key, row.amountKobo, tx);
      if (key.id === KEYLESS_KEY_ID) await this.assertKeylessCaps(row.amountKobo, row.refundTo, row.accountNumber, tx);
      const [updated] = await tx.update(agentPayments).set({ status: 'creating', updatedAt: new Date() }).where(eq(agentPayments.id, id)).returning();
      return { row: updated!, fresh: true };
    });
    if (!claimed.row) throw new AgentRefusal('quote_expired', 'This quote has expired. Ask for a new one.', 410);
    if (!claimed.fresh) return claimed.row;
    return this.setUp(claimed.row);
  }

  private async setUp(payment: AgentPayment): Promise<AgentPayment> {
    let refused: AgentRefusal | null = null;
    try {
      const refundOnBase = isAddress(payment.refundTo) ? payment.refundTo : null;
      const deposit = await this.payout.deposit({
        reference: payment.id,
        route: 'bank',
        amountKobo: payment.amountKobo,
        usdcMinor: payment.usdcMinor,
        destination: { bankName: payment.bankName, accountNumber: payment.accountNumber, accountName: payment.accountName, ...(refundOnBase ? { refundAddress: refundOnBase } : {}) },
      });
      if (deposit.destinationKobo !== null && deposit.destinationKobo < payment.amountKobo * PRICE_TOLERANCE) {
        // Nothing can reach the partner's address without the deposit address below, so nothing is at risk.
        refused = new AgentRefusal('price_changed', 'The rate moved. Nothing was sent. Ask for a new quote.', 409);
        await this.db.update(agentPayments).set({ status: 'expired', updatedAt: new Date() }).where(eq(agentPayments.id, payment.id));
        throw refused;
      }
      const deadline = new Date(Date.now() + DEPOSIT_WINDOW_MS);
      const quote = await this.crossChain.quote({ payFrom: payment.payFrom as PayFrom, usdcMinor: payment.usdcMinor, recipient: deposit.address, refundTo: payment.refundTo, deadline });
      const [row] = await this.db
        .update(agentPayments)
        .set({ status: 'awaiting_deposit', payoutAddress: deposit.address, payoutKobo: deposit.destinationKobo, depositAddress: quote.depositAddress, payInMinor: quote.payInMinor, depositDeadline: deadline, updatedAt: new Date() })
        .where(eq(agentPayments.id, payment.id))
        .returning();
      await this.audit.record('agent_api', 'agent_payment.accepted', payment.id, { keyId: payment.keyId, kobo: payment.amountKobo, usdcMinor: payment.usdcMinor, payFrom: payment.payFrom });
      return row!;
    } catch (error) {
      if (error === refused && refused) throw refused;
      this.logger.warn(`agent payment ${payment.id} could not be set up: ${(error as Error).message.slice(0, 200)}`);
      // No deposit address went out, so the agent cannot have paid. The same id may safely ask again.
      await this.db.update(agentPayments).set({ status: 'quoted', updatedAt: new Date() }).where(eq(agentPayments.id, payment.id));
      throw new AgentRefusal('setup_failed', 'We could not set up this payment. Nothing was sent. Please try again.', 503);
    }
  }

  async get(key: AgentKey, id: string): Promise<AgentPayment> {
    const [row] = await this.db.select().from(agentPayments).where(and(eq(agentPayments.id, id), eq(agentPayments.keyId, key.id)));
    if (!row) throw new AgentRefusal('not_found', 'No such payment.', 404);
    return (OPEN as readonly string[]).includes(row.status) ? this.refresh(row) : row;
  }

  /** For the background job. */
  async reconcile(): Promise<void> {
    await this.db
      .update(agentPayments)
      .set({ status: 'quoted', updatedAt: new Date() })
      .where(and(eq(agentPayments.status, 'creating'), lt(agentPayments.updatedAt, new Date(Date.now() - STUCK_CREATING_MS))));
    const open = await this.db.select().from(agentPayments).where(inArray(agentPayments.status, [...OPEN])).limit(50);
    for (const payment of open) await this.refresh(payment);
  }

  /** Only ever reads where the money is, so it is safe to run at any time. If it cannot ask, nothing changes. */
  private async refresh(payment: AgentPayment): Promise<AgentPayment> {
    try {
      const change = await this.nextState(payment);
      if (!change) return payment;
      const [row] = await this.db
        .update(agentPayments)
        .set({ ...change, updatedAt: new Date() })
        // Only from the state just read, so two checks at once cannot undo each other.
        .where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, payment.status)))
        .returning();
      if (row?.status === 'needs_support') this.logger.error(`agent payment ${payment.id} needs a person: ${row.failureReason}`);
      return row ?? payment;
    } catch (error) {
      this.logger.warn(`agent payment ${payment.id} could not be checked: ${(error as Error).message.slice(0, 200)}`);
      return payment;
    }
  }

  private async nextState(payment: AgentPayment): Promise<Partial<AgentPayment> | null> {
    let transactions = payment.transactions;
    if (payment.status !== 'paying') {
      const state = await this.crossChain.status(payment.depositAddress!);
      transactions = state.transactions.length > 0 ? state.transactions : transactions;
      switch (state.status) {
        case 'waiting':
          return payment.depositDeadline && payment.depositDeadline.getTime() <= Date.now() ? { status: 'expired', failureReason: 'No payment arrived in time.' } : null;
        case 'underpaid':
          return payment.depositDeadline && payment.depositDeadline.getTime() <= Date.now()
            ? { status: 'processing', failureReason: 'Less than the amount asked for arrived. It should be refunded.', transactions }
            : { status: 'processing', failureReason: 'Less than the amount asked for has arrived.', transactions };
        case 'moving':
          return { status: 'processing', failureReason: null, transactions };
        case 'refunded':
          return { status: 'refunded', failureReason: 'The USDC was returned to your refund address. No naira was paid.', transactions };
        case 'failed':
          return { status: 'needs_support', failureReason: 'The transfer between chains failed. Do not send again.', transactions };
        case 'delivered':
          break;
      }
    }
    const paid = await this.payout.status(payment.id);
    if (paid.state === 'completed') return { status: 'paid', paidAt: new Date(), failureReason: null, transactions };
    if (paid.state === 'failed') return { status: 'needs_support', failureReason: 'The USDC arrived, but the bank payment failed. Do not send again.', transactions };
    return payment.status === 'paying' ? null : { status: 'paying', failureReason: null, transactions };
  }

  /** Per wallet and per bank account, so one wallet cannot repeat and many wallets cannot flood one account. */
  private async assertKeylessCaps(addedKobo: number, refundTo: string, accountNumber: string, db: Pick<Database, 'select'>): Promise<void> {
    const used = async (column: typeof agentPayments.refundTo | typeof agentPayments.accountNumber, value: string) => {
      const [row] = await db
        .select({ used: sql<string>`coalesce(sum(${agentPayments.amountKobo}), 0)` })
        .from(agentPayments)
        .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), eq(column, value), inArray(agentPayments.status, [...AGENT_STATUSES_THAT_COUNT]), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
      return Number(row!.used);
    };
    if ((await used(agentPayments.refundTo, refundTo)) + addedKobo > KEYLESS.perWalletDayKobo) throw new AgentRefusal('over_wallet_limit', 'This wallet has reached its limit for today.', 422);
    if ((await used(agentPayments.accountNumber, accountNumber)) + addedKobo > KEYLESS.perAccountDayKobo) throw new AgentRefusal('over_account_limit', 'This bank account has reached its limit for today.', 422);
  }

  private async assertAllowed(key: AgentKey, addedKobo: number, db: Pick<Database, 'select'>): Promise<void> {
    const refused = await this.guards.refusal(['bank'], addedKobo, db);
    if (refused) throw new AgentRefusal('paused', refused, 503);
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${agentPayments.amountKobo}), 0)` })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), inArray(agentPayments.status, [...AGENT_STATUSES_THAT_COUNT]), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
    const left = key.dailyLimitKobo - Number(row!.used);
    if (addedKobo > left) throw new AgentRefusal('over_daily_limit', `This would go over this key's daily limit. ${formatNaira(Math.max(left, 0))} is left today.`, 422);
  }
}
