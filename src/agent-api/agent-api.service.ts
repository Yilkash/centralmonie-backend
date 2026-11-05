import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAddress } from 'viem';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { AgentKey, agentKeys, AgentPayment, agentPayments } from '../database/schema';
import { formatNaira, koboToUsdcMinor } from '../money/money';
import { AuditService } from '../ops/audit.service';
import { AGENT_STATUSES_THAT_COUNT, GuardsService } from '../ops/guards.service';
import { AgentPayout, BankLookup, ExchangeRates, PaymentProvider } from '../providers/providers';
import { CrossChain, PayFrom, PayToken, USDT_ON } from './cross-chain';
import { NearRelayer, relayProblem, SignedDelegate } from './near-relay';

const QUOTE_LIFETIME_MS = 10 * 60_000;
/** What the agent is told. Limits hold the payment for this long, so it stays short. */
const DEPOSIT_WINDOW_MS = 20 * 60_000;
/** NEAR Intents' own deadline is later, so a deposit sent at the last moment still completes. */
const ROUTE_DEADLINE_MS = 30 * 60_000;
const SHORTEST_ROUTE_MS = 10 * 60_000;
/** Only after this do we call it expired, and for a day after that we keep looking in case money still moved. */
const EXPIRE_AFTER_MS = 35 * 60_000;
const KEEP_CHECKING_EXPIRED_MS = 24 * 60 * 60_000;
const PAYING_TOO_LONG_MS = 24 * 60 * 60_000;
/** Longer than the slowest setup can take (about 144 seconds), so this cannot fire on one still running. */
const STUCK_CREATING_MS = 5 * 60_000;
/** A ceiling on what the relayer can spend in a day, whoever is asking. */
const RELAYS_PER_DAY = 100;
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
  acceptsPerIpHour: 10,
  quotesPerDay: 2000,
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

/** IPv6 hands out whole /64 blocks, so one caller can hold billions of addresses. */
export function ipGroup(ip: string): string {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const [head = ''] = ip.split('::');
  return head.split(':').slice(0, 4).join(':');
}

/** Keeps enough to compare with an invoice, without handing out names to anyone who asks about an account. */
export function maskName(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((word) => word.slice(0, 2) + '*'.repeat(Math.max(word.length - 2, 0))).join(' ');
}

const csvCell = (value: unknown): string => {
  const text = String(value ?? '');
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function paymentsToCsv(rows: AgentPayment[]): string {
  const header = ['Date', 'Status', 'Paid to', 'Bank or network', 'Account', 'Naira', 'Paid in', 'Amount paid', 'From network', 'Purpose', 'Reference', 'Transactions'];
  const lines = rows.map((row) =>
    [
      row.createdAt.toISOString(),
      row.status,
      row.accountName,
      row.bankName,
      `****${row.accountNumber.slice(-4)}`,
      ((row.payoutKobo ?? row.amountKobo) / 100).toFixed(2),
      row.payToken,
      (row.payInMinor / 1_000_000).toFixed(6),
      row.payFrom,
      row.purpose ?? '',
      row.id,
      row.transactions.join(' '),
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
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
  payToken?: PayToken;
  /** USDC straight to this NEAR account, with no bank payout. */
  deliverTo?: string;
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
    @Inject(NearRelayer) private readonly relayer: NearRelayer | null,
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
  private countIp(kind: 'quote' | 'accept', ip: string): void {
    const now = Date.now();
    if (this.ipWindows.size > 10_000) {
      for (const [key, value] of this.ipWindows) if (value.until <= now) this.ipWindows.delete(key);
    }
    // When full, new addresses share one counter: filling the map must not clear anyone's count.
    const tracked = `${kind}:${ipGroup(ip)}`;
    const key = this.ipWindows.size > 10_000 && !this.ipWindows.has(tracked) ? `${kind}:overflow` : tracked;
    const window = this.ipWindows.get(key);
    const current = window && window.until > now ? window : { until: now + 3_600_000, count: 0 };
    current.count += 1;
    this.ipWindows.set(key, current);
    if (current.count > (kind === 'quote' ? KEYLESS.quotesPerIpHour : KEYLESS.acceptsPerIpHour)) throw new AgentRefusal('too_many_requests', 'Too many requests from this address. Try again later.', 429);
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
    if (input.payToken === 'USDT' && !USDT_ON[input.payFrom]) throw new AgentRefusal('token_unavailable', `USDT cannot be used from ${input.payFrom}. Use USDC, or pay from NEAR, Ethereum or Solana.`, 422);
    if (!validRefundAddress(input.payFrom, input.refundTo)) throw new AgentRefusal('invalid_refund_address', `That is not a valid ${input.payFrom} address to refund.`, 400);

    const keyless = key.id === KEYLESS_KEY_ID;
    if (keyless) {
      this.countIp('quote', input.clientIp ?? 'unknown');
      const [{ today } = { today: 0 }] = await this.db
        .select({ today: count() })
        .from(agentPayments)
        .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
      if (today >= KEYLESS.quotesPerDay) throw new AgentRefusal('too_many_requests', 'Paying without a key is busy today. Try again tomorrow.', 429);
      if (amountKobo > KEYLESS.perPaymentKobo) throw new AgentRefusal('over_payment_limit', `Without an API key, the most for one payment is ${formatNaira(KEYLESS.perPaymentKobo)}.`, 422);
      await this.assertKeylessCaps(amountKobo, input.refundTo, input.accountNumber, this.db);
    }

    const [{ made } = { made: 0 }] = keyless ? [] : await this.db
      .select({ made: count() })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
    if (made >= MAX_QUOTES_A_DAY) throw new AgentRefusal('too_many_quotes', 'This key has asked for too many quotes today.', 429);

    await this.assertAllowed(key, amountKobo, this.db);

    const rate = await this.rates.nairaPerUsdc().catch(() => {
      throw new AgentRefusal('rate_unavailable', 'We could not get a rate just now. Nothing was sent. Please try again.', 503);
    });
    const usdcMinor = koboToUsdcMinor(amountKobo, rate);
    const minimum = input.deliverTo ? 0 : this.provider.minimumUsdcMinor('bank');
    if (usdcMinor < minimum) throw new AgentRefusal('below_minimum', `The smallest payment is about ${formatNaira(Math.ceil((minimum * rate) / 10_000 / 100) * 100)}.`, 422);

    const accountName = input.deliverTo ?? (await this.bankName(input));
    const { payInMinor } = await this.crossChain
      .priceCheck({ payFrom: input.payFrom, usdcMinor, recipient: input.deliverTo ?? this.config.get('COLLECTION_ADDRESS', { infer: true }) ?? input.refundTo, refundTo: input.refundTo, deadline: new Date(Date.now() + DEPOSIT_WINDOW_MS), payToken: input.payToken ?? 'USDC', toNear: Boolean(input.deliverTo) })
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
        payToken: input.payToken ?? 'USDC',
        deliverTo: input.deliverTo ?? null,
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

  private async bankName(input: QuoteInput): Promise<string> {
    // Last of the checks: this asks the bank, and tells the caller a name.
    const accountName = await this.banks.accountName(input.bankName, input.accountNumber).catch(() => {
      throw new AgentRefusal('bank_unavailable', 'We could not check that account just now. Nothing was sent. Please try again.', 503);
    });
    if (!accountName) throw new AgentRefusal('account_not_found', 'We could not find that account. Check the bank and the account number.', 404);

    return accountName;
  }

  /**
   * Accepting twice gives the same payment, so an agent can safely retry after a lost connection. The
   * limits are checked under a lock on the key, so two requests at once cannot both use the last of them.
   */
  async accept(key: AgentKey, id: string, clientIp?: string): Promise<AgentPayment> {
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
      if (key.id === KEYLESS_KEY_ID) this.countIp('accept', clientIp ?? row.clientIp ?? 'unknown');
      await this.assertAllowed(key, row.amountKobo, tx);
      if (key.id === KEYLESS_KEY_ID) await this.assertKeylessCaps(row.amountKobo, row.refundTo, row.accountNumber, tx);
      const [updated] = await tx.update(agentPayments).set({ status: 'creating', acceptedAt: new Date(), updatedAt: new Date() }).where(eq(agentPayments.id, id)).returning();
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
      // Going straight to a NEAR account, there is no bank partner to set up.
      const deposit = payment.deliverTo
        ? { address: payment.deliverTo, usdcMinor: payment.usdcMinor, destinationKobo: null, expiresAt: null }
        : await this.payout.deposit({
            reference: payment.id,
            route: 'bank',
            amountKobo: payment.amountKobo,
            usdcMinor: payment.usdcMinor,
            destination: { bankName: payment.bankName, accountNumber: payment.accountNumber, accountName: payment.accountName, ...(refundOnBase ? { refundAddress: refundOnBase } : {}) },
          });
      if (deposit.destinationKobo !== null && deposit.destinationKobo < payment.amountKobo * PRICE_TOLERANCE) {
        // Nothing can reach the partner's address without the deposit address below, so nothing is at risk.
        refused = new AgentRefusal('price_changed', 'The rate moved. Nothing was sent. Ask for a new quote.', 409);
        await this.db.update(agentPayments).set({ status: 'expired', acceptedAt: null, updatedAt: new Date() }).where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'creating')));
        throw refused;
      }
      // The route must end before the partner's address stops accepting, with time left for the USDC to arrive.
      const partnerEnds = deposit.expiresAt ? new Date(deposit.expiresAt).getTime() - 5 * 60_000 : Number.POSITIVE_INFINITY;
      const routeEnds = Math.min(Date.now() + ROUTE_DEADLINE_MS, partnerEnds);
      if (routeEnds - Date.now() < SHORTEST_ROUTE_MS) throw new Error('The partner gave too little time for the deposit');
      const deadline = new Date(Math.min(Date.now() + DEPOSIT_WINDOW_MS, routeEnds - 5 * 60_000));
      const quote = await this.crossChain.quote({ payFrom: payment.payFrom as PayFrom, usdcMinor: payment.usdcMinor, recipient: deposit.address, refundTo: payment.refundTo, deadline: new Date(routeEnds), payToken: payment.payToken as PayToken, toNear: Boolean(payment.deliverTo) });
      const [row] = await this.db
        .update(agentPayments)
        .set({ status: 'awaiting_deposit', payoutAddress: deposit.address, payoutKobo: deposit.destinationKobo, depositAddress: quote.depositAddress, payInMinor: quote.payInMinor, depositDeadline: deadline, updatedAt: new Date() })
        .where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'creating')))
        .returning();
      if (!row) throw new Error('This payment changed while it was being set up');
      await this.audit.record('agent_api', 'agent_payment.accepted', payment.id, { keyId: payment.keyId, kobo: payment.amountKobo, usdcMinor: payment.usdcMinor, payFrom: payment.payFrom });
      return row!;
    } catch (error) {
      if (error === refused && refused) throw refused;
      this.logger.warn(`agent payment ${payment.id} could not be set up: ${(error as Error).message.slice(0, 200)}`);
      // No deposit address went out, so the agent cannot have paid. The same id may safely ask again.
      await this.db.update(agentPayments).set({ status: 'quoted', acceptedAt: null, updatedAt: new Date() }).where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'creating')));
      throw new AgentRefusal('setup_failed', 'We could not set up this payment. Nothing was sent. Please try again.', 503);
    }
  }

  async get(key: AgentKey, id: string): Promise<AgentPayment> {
    const [row] = await this.db.select().from(agentPayments).where(and(eq(agentPayments.id, id), eq(agentPayments.keyId, key.id)));
    if (!row) throw new AgentRefusal('not_found', 'No such payment.', 404);
    return this.stillWatched(row) ? this.refresh(row) : row;
  }

  private stillWatched(row: AgentPayment): boolean {
    if ((OPEN as readonly string[]).includes(row.status)) return true;
    return row.status === 'expired' && row.depositAddress !== null && Date.now() - row.updatedAt.getTime() < KEEP_CHECKING_EXPIRED_MS;
  }

  /**
   * Pays the gas for an agent's signed USDC transfer. Claimed before sending, and never tried twice for one
   * payment: if it fails partway the transfer may still have gone, and the agent can see that from the status.
   */
  async relay(key: AgentKey, id: string, signedDelegate: string): Promise<AgentPayment> {
    if (!this.relayer) throw new AgentRefusal('relayer_unavailable', 'Gas-free sending is not available. Send the USDC from your own wallet.', 503);
    const payment = await this.get(key, id);
    let delegate: SignedDelegate;
    try {
      delegate = this.relayer.decode(signedDelegate);
    } catch {
      throw new AgentRefusal('invalid_request', 'The signed transfer could not be read.', 400);
    }
    const problem = relayProblem(delegate, payment);
    if (problem) throw new AgentRefusal('relay_refused', problem, 422);
    const [{ today } = { today: 0 }] = await this.db
      .select({ today: count() })
      .from(agentPayments)
      .where(gte(agentPayments.relayedAt, sql`${startOfLagosDay}`));
    if (today >= RELAYS_PER_DAY) throw new AgentRefusal('relayer_busy', 'Gas-free sending is busy today. Send the USDC from your own wallet.', 429);
    const [claimed] = await this.db
      .update(agentPayments)
      .set({ relayedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentPayments.id, id), eq(agentPayments.status, 'awaiting_deposit'), isNull(agentPayments.relayedAt)))
      .returning();
    if (!claimed) throw new AgentRefusal('already_relayed', 'The relayer has already sent this payment. Check its status.', 409);
    try {
      await this.relayer.ensureRegistered(payment.depositAddress!);
      const hash = await this.relayer.send(signedDelegate);
      await this.audit.record('agent_api', 'agent_payment.relayed', id, { keyId: key.id, hash });
      if (!hash) return claimed;
      const [row] = await this.db.update(agentPayments).set({ transactions: [hash], updatedAt: new Date() }).where(eq(agentPayments.id, id)).returning();
      return row ?? claimed;
    } catch (error) {
      this.logger.error(`relay for ${id} failed: ${(error as Error).message.slice(0, 200)}`);
      throw new AgentRefusal('relay_failed', 'The relayer could not confirm the transfer, and it may still have gone. Check the status before doing anything else.', 502);
    }
  }

  /** A key's payments as a spreadsheet an accountant can read. Account numbers stay masked. */
  async paymentsCsv(key: AgentKey): Promise<string> {
    const rows = await this.db.select().from(agentPayments).where(and(eq(agentPayments.keyId, key.id), notInArray(agentPayments.status, ['quoted', 'creating']))).orderBy(desc(agentPayments.createdAt)).limit(5000);
    return paymentsToCsv(rows);
  }

  /** For the background job. */
  async reconcile(): Promise<void> {
    await this.db
      .update(agentPayments)
      .set({ status: 'quoted', acceptedAt: null, updatedAt: new Date() })
      .where(and(eq(agentPayments.status, 'creating'), lt(agentPayments.updatedAt, new Date(Date.now() - STUCK_CREATING_MS))));
    // Oldest check first, so a slow partner cannot leave the same rows at the back every time.
    const open = await this.db.select().from(agentPayments).where(inArray(agentPayments.status, [...OPEN, 'expired'])).orderBy(asc(agentPayments.updatedAt)).limit(100);
    for (const payment of open.filter((row) => this.stillWatched(row)).slice(0, 50)) await this.refresh(payment);
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
          if (payment.status === 'expired') return null;
          // Measured from acceptance, so a deposit sent at the last moment has time to be seen.
          return payment.depositDeadline && payment.depositDeadline.getTime() + (EXPIRE_AFTER_MS - DEPOSIT_WINDOW_MS) <= Date.now() ? { status: 'expired', failureReason: 'No payment arrived in time.' } : null;
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
    if (payment.deliverTo) return { status: 'paid', paidAt: new Date(), failureReason: null, transactions };
    const paid = await this.payout.status(payment.id);
    if (paid.state === 'completed') return { status: 'paid', paidAt: new Date(), failureReason: null, transactions };
    if (paid.state === 'failed') return { status: 'needs_support', failureReason: 'The USDC arrived, but the bank payment failed. Do not send again.', transactions };
    if (payment.status === 'paying') {
      const stuck = payment.acceptedAt && Date.now() - payment.acceptedAt.getTime() > PAYING_TOO_LONG_MS;
      return stuck ? { status: 'needs_support', failureReason: 'The bank payment has not finished after a day. A person is checking. Do not send again.' } : null;
    }
    return { status: 'paying', failureReason: null, transactions };
  }

  /** Per wallet and per bank account, so one wallet cannot repeat and many wallets cannot flood one account. */
  private async assertKeylessCaps(addedKobo: number, refundTo: string, accountNumber: string, db: Pick<Database, 'select'>): Promise<void> {
    const used = async (column: typeof agentPayments.refundTo | typeof agentPayments.accountNumber, value: string) => {
      const [row] = await db
        .select({ used: sql<string>`coalesce(sum(${agentPayments.amountKobo}), 0)` })
        .from(agentPayments)
        .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), eq(column, value), inArray(agentPayments.status, [...AGENT_STATUSES_THAT_COUNT]), gte(agentPayments.acceptedAt, sql`${startOfLagosDay}`)));
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
      .where(and(eq(agentPayments.keyId, key.id), inArray(agentPayments.status, [...AGENT_STATUSES_THAT_COUNT]), gte(agentPayments.acceptedAt, sql`${startOfLagosDay}`)));
    const left = key.dailyLimitKobo - Number(row!.used);
    if (addedKobo > left) throw new AgentRefusal('over_daily_limit', `This would go over this key's daily limit. ${formatNaira(Math.max(left, 0))} is left today.`, 422);
  }
}
