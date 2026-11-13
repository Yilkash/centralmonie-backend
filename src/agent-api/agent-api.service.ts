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
import { AGENT_STATUSES_MONEY_ARRIVED, AGENT_STATUSES_THAT_COUNT, GuardsService } from '../ops/guards.service';
import { AgentPayout, BankLookup, ExchangeRates, NairaOnramp, PaymentProvider } from '../providers/providers';
import { Chain } from '../chain/chain.service';
import { ChainKey, isNearAccount, USDC_CHAINS } from '../chain/usdc-chains';
import { CrossChain, PayFrom, PayToken, USDT_ON, USDT_ONLY } from './cross-chain';
import { NearExactFacilitator, NearExactPayload, nearExactRequirements, NearRelayer, relayProblem, SignedDelegate } from './near-relay';

const QUOTE_LIFETIME_MS = 10 * 60_000;
/** What the agent is told. Limits hold the payment for this long, so it stays short. */
const DEPOSIT_WINDOW_MS = 20 * 60_000;
/** NEAR Intents' own deadline is later, so a deposit sent at the last moment still completes. */
const ROUTE_DEADLINE_MS = 30 * 60_000;
const SHORTEST_ROUTE_MS = 10 * 60_000;
/** Only after this do we call it expired, and for a day after that we keep looking in case money still moved. */
const EXPIRE_AFTER_MS = 35 * 60_000;
/** After the time to send ends, money sent at the last moment is still looked for this long. */
export const LATE_ARRIVAL_MS = EXPIRE_AFTER_MS - DEPOSIT_WINDOW_MS;
const KEEP_CHECKING_EXPIRED_MS = 24 * 60 * 60_000;
const PAYING_TOO_LONG_MS = 24 * 60 * 60_000;
/** Longer than the slowest setup can take (about 144 seconds), so this cannot fire on one still running. */
const STUCK_CREATING_MS = 5 * 60_000;
/**
 * A naira payment is only paid once its USDC is seen on Base: the partner's word "completed" came a block before the
 * transfer in the first real test, and its reply repeats the quoted amount rather than what was sent.
 */
const NAIRA_DELIVERY_WAIT_MS = 20 * 60_000;
/** The rate can move between the quote and the transfer, so a little less than quoted still counts. */
const NAIRA_SHORTFALL_ALLOWED = 0.02;
const BASE_BLOCK_MS = 2_000;
/** How far back from the start of a payment its delivery is searched for, against clocks that disagree. */
const DELIVERY_SEARCH_MARGIN_BLOCKS = 150;
/** Longest stretch searched in one check, so a long-forgotten payment cannot start a huge search. */
const DELIVERY_SEARCH_MAX_BLOCKS = 6 * 60 * 30;
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
  /** Unpaid payments open at once to one bank account. Unpaid ones no longer count toward the money caps, so this
   * bounds how far real payments arriving together can go past them. */
  openUnpaidPerAccount: 3,
  /** Quotes one pay link or checkout can ask for in an hour. These do not use the shared daily quote budget. */
  quotesPerLinkHour: 40,
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
  if (!ip.includes(':')) return ip;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.slice(7);
  const bare = ip.split('%')[0]!.toLowerCase();
  const [head = '', tail] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : Math.max(8 - left.length - right.length, 0);
  const full = [...left, ...Array<string>(missing).fill('0'), ...right].map((part) => (part.replace(/^0+(?=.)/, '') || '0'));
  return full.slice(0, 4).join(':');
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
  const chain = USDC_CHAINS[payFrom as ChainKey];
  return chain ? chain.valid(address) : false;
}

/** Paying naira by bank transfer instead of crypto. Only for a receiver of USDC on Base, through a pay link. */
export const NAIRA = 'naira';
/** Naira payers have no wallet to count by, so each network gets its own daily allowance under a name like this. */
export const NAIRA_PAYER = 'naira-bank-transfer';
export const nairaPayer = (clientIp: string | undefined) => `${NAIRA_PAYER}:${ipGroup(clientIp ?? 'unknown')}`;

export interface QuoteInput {
  amountNaira: number;
  bankName: string;
  accountNumber: string;
  payFrom: PayFrom | typeof NAIRA;
  refundTo: string;
  payerName?: string;
  payerEmail?: string;
  purpose?: string;
  clientIp?: string;
  payToken?: PayToken;
  /** USDC straight to this NEAR account or Base address, with no bank payout. */
  deliverTo?: string;
  /** The pay link or checkout this quote is for. It gets its own quote budget instead of the shared daily one. */
  viaLink?: string;
}

/** The way in for other AI agents. It uses no AI: ordinary code checks the request and tracks the money. */
@Injectable()
export class AgentApiService {
  private readonly logger = new Logger(AgentApiService.name);
  private readonly ipWindows = new Map<string, { until: number; count: number }>();
  /** When each payment was last asked about, so a page checking every few seconds does not ask the partners each time. */
  private readonly lastChecked = new Map<string, number>();
  /** Up to which block each naira payment's delivery has been searched for, so a repeat check reads only new blocks. */
  private readonly searchedTo = new Map<string, number>();

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
    @Inject(NearExactFacilitator) private readonly nearExact: NearExactFacilitator | null,
    @Inject(NairaOnramp) private readonly onramp: NairaOnramp | null,
    private readonly chain: Chain,
  ) {}

  get open(): boolean {
    return agentApiOpen(this.config.get('PAYMENTS_MODE', { infer: true }), this.config.get('AGENT_API_ENABLED', { infer: true }));
  }

  /** A naira partner is connected, so a bank transfer can be offered. */
  get nairaReady(): boolean {
    return this.onramp !== null;
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

  /** In memory, like countIp. One pay link cannot be used to flood quotes, and links do not share one daily budget. */
  private countLink(linkId: string): void {
    const now = Date.now();
    const key = `link:${linkId}`;
    const window = this.ipWindows.get(key);
    const current = window && window.until > now ? window : { until: now + 3_600_000, count: 0 };
    current.count += 1;
    this.ipWindows.set(key, current);
    if (current.count > KEYLESS.quotesPerLinkHour) throw new AgentRefusal('too_many_requests', 'This link has had many payment attempts. Try again later.', 429);
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
  async quote(key: AgentKey, given: QuoteInput): Promise<AgentPayment> {
    // Tron and TON have no USDC route, so a payer there pays in USDT without having to say so.
    const input = USDT_ONLY.has(given.payFrom as PayFrom) ? { ...given, payToken: 'USDT' as const } : given;
    const amountKobo = input.amountNaira * 100;
    if (input.payToken === 'USDT' && !USDT_ON[input.payFrom as PayFrom]) throw new AgentRefusal('token_unavailable', `USDT cannot be used from ${input.payFrom}. Use USDC, or pay from NEAR, Ethereum, Solana, BNB Chain, Tron or TON.`, 422);
    const naira = input.payFrom === NAIRA;
    if (naira) {
      // The partner sends USDC to one Base address. NEAR and other chains come later, through NEAR Intents.
      if (!this.onramp || !input.deliverTo || !isAddress(input.deliverTo)) throw new AgentRefusal('naira_unavailable', 'Paying in naira is not available for this payment.', 422);
      if (input.payToken && input.payToken !== 'USDC') throw new AgentRefusal('token_unavailable', 'Paying in naira needs no token choice.', 422);
    } else if (!validRefundAddress(input.payFrom as PayFrom, input.refundTo)) throw new AgentRefusal('invalid_refund_address', `That is not a valid ${input.payFrom} address to refund.`, 400);

    // Counted per network, so one person starting many naira payments cannot use up the allowance for everyone.
    const refundTo = naira ? nairaPayer(input.clientIp) : input.refundTo;
    const keyless = key.id === KEYLESS_KEY_ID;
    if (keyless) {
      this.countIp('quote', input.clientIp ?? 'unknown');
      const [{ today } = { today: 0 }] = await this.db
        .select({ today: count() })
        .from(agentPayments)
        .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
      if (input.viaLink) this.countLink(input.viaLink);
      else if (today >= KEYLESS.quotesPerDay) throw new AgentRefusal('too_many_requests', 'Paying without a key is busy today. Try again tomorrow.', 429);
      if (amountKobo > KEYLESS.perPaymentKobo) throw new AgentRefusal('over_payment_limit', `Without an API key, the most for one payment is ${formatNaira(KEYLESS.perPaymentKobo)}.`, 422);
      await this.assertKeylessCaps(amountKobo, refundTo, input.accountNumber, this.db);
    }

    const [{ made } = { made: 0 }] = keyless ? [] : await this.db
      .select({ made: count() })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), gte(agentPayments.createdAt, sql`${startOfLagosDay}`)));
    if (made >= MAX_QUOTES_A_DAY) throw new AgentRefusal('too_many_quotes', 'This key has asked for too many quotes today.', 429);

    await this.assertAllowed(key, amountKobo, this.db);
    if (naira) return this.quoteNaira(key, { ...input, refundTo }, amountKobo);
    if (input.payFrom === 'near' && (await this.crossChain.nearAccountMissing(input.refundTo))) throw new AgentRefusal('invalid_refund_address', `The NEAR account ${input.refundTo} does not exist. Check the spelling.`, 400);

    const rate = await this.rates.nairaPerUsdc().catch(() => {
      throw new AgentRefusal('rate_unavailable', 'We could not get a rate just now. Nothing was sent. Please try again.', 503);
    });
    const usdcMinor = koboToUsdcMinor(amountKobo, rate);
    const minimum = input.deliverTo ? 0 : this.provider.minimumUsdcMinor('bank');
    if (usdcMinor < minimum) throw new AgentRefusal('below_minimum', `The smallest payment is about ${formatNaira(Math.ceil((minimum * rate) / 10_000 / 100) * 100)}.`, 422);

    const accountName = input.deliverTo ?? (await this.bankName(input));
    const { payInMinor } = await this.crossChain
      .priceCheck({ payFrom: input.payFrom as PayFrom, usdcMinor, recipient: input.deliverTo ?? this.config.get('COLLECTION_ADDRESS', { infer: true }) ?? input.refundTo, refundTo: input.refundTo, deadline: new Date(Date.now() + DEPOSIT_WINDOW_MS), payToken: input.payToken ?? 'USDC', toNear: Boolean(input.deliverTo && isNearAccount(input.deliverTo)) })
      .catch((error: Error) => {
        this.logger.warn(`price check failed: ${error.message.slice(0, 200)}`);
        const hint = input.payFrom === 'near' ? ' Check that the NEAR account is spelled right.' : '';
        throw new AgentRefusal('route_unavailable', `We could not price that route just now. Nothing was sent.${hint} Please try again.`, 503);
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
    // One more try after a short wait, because a phone or home connection often drops for a moment.
    const ask = () => this.banks.accountName(input.bankName, input.accountNumber);
    const accountName = await ask()
      .catch(async () => {
        await new Promise((done) => setTimeout(done, 1500));
        return ask();
      })
      .catch(() => {
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

  /** Prices a naira payment at the partner's buying rate. Nothing is asked of the bank yet. */
  private async quoteNaira(key: AgentKey, input: QuoteInput, amountKobo: number): Promise<AgentPayment> {
    const terms = await this.onramp!.onrampTerms().catch(() => {
      throw new AgentRefusal('rate_unavailable', 'We could not get a rate just now. Nothing was sent. Please try again.', 503);
    });
    if (amountKobo < terms.minimumKobo) throw new AgentRefusal('below_minimum', `The smallest naira payment is ${formatNaira(terms.minimumKobo)}.`, 422);
    const usdcMinor = Math.floor((amountKobo / 100 / terms.nairaPerUsdc) * 1_000_000);
    const [row] = await this.db
      .insert(agentPayments)
      .values({
        id: randomUUID(),
        keyId: key.id,
        amountKobo,
        usdcMinor,
        payInMinor: usdcMinor,
        bankName: input.bankName,
        accountNumber: input.accountNumber,
        accountName: input.deliverTo!,
        payFrom: NAIRA,
        payToken: 'USDC',
        deliverTo: input.deliverTo!,
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
   * Asks the partner for a temporary bank account. When the naira lands there, the partner sends USDC straight to the
   * receiver, so CentralMonie never holds it. Like the crypto route, a failure before any account is shown leaves nothing at risk.
   */
  private async setUpNaira(payment: AgentPayment): Promise<AgentPayment> {
    try {
      const order = await this.onramp!.nairaOnramp({ reference: payment.id, amountKobo: payment.amountKobo, walletAddress: payment.deliverTo! });
      const expiresAt = order.expiresAt ? new Date(order.expiresAt) : null;
      // Without a deadline we could not show a true countdown, so this account is not handed out.
      if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error('The partner gave no usable deadline');
      const [row] = await this.db
        .update(agentPayments)
        .set({
          status: 'awaiting_deposit',
          usdcMinor: order.usdcMinor,
          payInMinor: order.usdcMinor,
          payoutAddress: payment.deliverTo,
          nairaAccount: { bankName: order.bankName, accountNumber: order.accountNumber, accountName: order.accountName, amountKobo: order.amountKobo, rate: order.rate },
          depositDeadline: expiresAt,
          updatedAt: new Date(),
        })
        .where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'creating')))
        .returning();
      if (!row) throw new Error('This payment changed while it was being set up');
      await this.audit.record('agent_api', 'agent_payment.accepted', payment.id, { keyId: payment.keyId, kobo: payment.amountKobo, usdcMinor: order.usdcMinor, payFrom: NAIRA });
      return row;
    } catch (error) {
      this.logger.warn(`naira payment ${payment.id} could not be set up: ${(error as Error).message.slice(0, 200)}`);
      await this.db.update(agentPayments).set({ status: 'quoted', acceptedAt: null, updatedAt: new Date() }).where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'creating')));
      throw new AgentRefusal('setup_failed', 'We could not set up a bank transfer just now. Nothing was paid. Please try again.', 503);
    }
  }

  private async setUp(payment: AgentPayment): Promise<AgentPayment> {
    if (payment.payFrom === NAIRA) return this.setUpNaira(payment);
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
      const quote = await this.crossChain.quote({ payFrom: payment.payFrom as PayFrom, usdcMinor: payment.usdcMinor, recipient: deposit.address, refundTo: payment.refundTo, deadline: new Date(routeEnds), payToken: payment.payToken as PayToken, toNear: Boolean(payment.deliverTo && isNearAccount(payment.deliverTo)) });
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
    return this.stillWatched(row) && this.dueForCheck(row.id) ? this.refresh(row) : row;
  }

  /** At most one partner check per payment every few seconds from page views. The background job checks regardless. */
  private dueForCheck(id: string, now = Date.now()): boolean {
    if (now - (this.lastChecked.get(id) ?? 0) < this.config.get('PAYMENT_RECHECK_MS', { infer: true })) return false;
    if (this.lastChecked.size > 5000) for (const [key, at] of this.lastChecked) if (now - at > 60 * 60_000) this.lastChecked.delete(key);
    this.lastChecked.set(id, now);
    return true;
  }

  private stillWatched(row: AgentPayment): boolean {
    if ((OPEN as readonly string[]).includes(row.status)) return true;
    return row.status === 'expired' && (row.depositAddress !== null || row.nairaAccount !== null) && Date.now() - row.updatedAt.getTime() < KEEP_CHECKING_EXPIRED_MS;
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

  /** The payment a standard x402 NEAR payload is for: the one whose deposit account it pays, under this key. */
  async byNearDeposit(key: AgentKey, depositAddress: string): Promise<AgentPayment> {
    const [row] = await this.db
      .select()
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), eq(agentPayments.depositAddress, depositAddress), eq(agentPayments.payFrom, 'near')));
    if (!row) throw new AgentRefusal('not_found', 'No payment is waiting for that deposit account.', 404);
    return row;
  }

  /**
   * Standard x402 `exact` on NEAR. Our own rules first (this payment, from its refund account, enough USDC), so the
   * relayer never spends NEAR on a payload that cannot pay; then the official facilitator verifies and settles.
   * The requirements always come from our record, never from the client.
   */
  async settleNearExact(key: AgentKey, payment: AgentPayment, payload: NearExactPayload) {
    if (!this.nearExact || !this.relayer) throw new AgentRefusal('relayer_unavailable', 'Standard x402 on NEAR is not available right now. Send the USDC from your own wallet.', 503);
    const requirements = nearExactRequirements(payment);
    let delegate: SignedDelegate;
    try {
      delegate = this.relayer.decode(payload.payload.signedDelegateAction);
    } catch {
      throw new AgentRefusal('invalid_payload', 'signedDelegateAction is not a valid NEAR SignedDelegate.', 400);
    }
    const problem = relayProblem(delegate, payment);
    if (problem) throw new AgentRefusal('relay_refused', problem, 422);
    const balance = await this.relayer.usdcBalance(delegate.senderId);
    if (balance === null || balance < BigInt(payment.payInMinor)) throw new AgentRefusal('insufficient_funds', 'The paying account does not hold enough USDC on NEAR.', 402);
    const [{ today } = { today: 0 }] = await this.db.select({ today: count() }).from(agentPayments).where(gte(agentPayments.relayedAt, sql`${startOfLagosDay}`));
    if (today >= RELAYS_PER_DAY) throw new AgentRefusal('relayer_busy', 'Gas-free sending is busy today. Send the USDC from your own wallet.', 429);
    // The deposit account must be able to hold USDC before the spec's checks will pass.
    await this.relayer.ensureRegistered(payment.depositAddress!);
    const verified = await this.nearExact.verify(payload, requirements);
    if (!verified.isValid) return { settlement: { success: false, errorReason: verified.invalidReason ?? 'invalid_payload', transaction: '', network: requirements.network }, payment };
    const [claimed] = await this.db
      .update(agentPayments)
      .set({ relayedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentPayments.id, payment.id), eq(agentPayments.status, 'awaiting_deposit'), isNull(agentPayments.relayedAt)))
      .returning();
    if (!claimed) throw new AgentRefusal('already_relayed', 'This payment has already been sent. Check its status.', 409);
    const settlement = await this.nearExact.settle(payload, requirements);
    await this.audit.record('agent_api', 'agent_payment.x402_near_exact', payment.id, { keyId: key.id, success: settlement.success, reason: settlement.errorReason ?? null, hash: settlement.transaction || null });
    if (!settlement.success) {
      // The signed transfer can only ever land once (the NEAR nonce), so a failed settlement may be tried again.
      await this.db.update(agentPayments).set({ relayedAt: null, updatedAt: new Date() }).where(eq(agentPayments.id, payment.id));
      return { settlement, payment: claimed };
    }
    const [row] = await this.db.update(agentPayments).set({ transactions: [settlement.transaction], updatedAt: new Date() }).where(eq(agentPayments.id, payment.id)).returning();
    return { settlement, payment: row ?? claimed };
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
    for (const payment of open.filter((row) => this.stillWatched(row)).slice(0, 50)) {
      this.lastChecked.set(payment.id, Date.now());
      await this.refresh(payment);
    }
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

  /** The partner's word on a naira payment. "unknown" changes nothing. */
  private async nextNairaState(payment: AgentPayment): Promise<Partial<AgentPayment> | null> {
    const state = await this.onramp!.onrampState(payment.id);
    const gone = (payment.depositDeadline?.getTime() ?? 0) + (EXPIRE_AFTER_MS - DEPOSIT_WINDOW_MS) <= Date.now();
    switch (state) {
      case 'waiting':
        if (payment.status === 'expired') return null;
        return gone ? { status: 'expired', failureReason: 'No transfer arrived in time.' } : null;
      case 'expired':
        return payment.status === 'expired' ? null : { status: 'expired', failureReason: 'No transfer arrived in time.' };
      case 'processing':
        return payment.status === 'processing' ? null : { status: 'processing', failureReason: null };
      case 'completed':
        return this.nairaDelivery(payment);
      case 'failed':
        return { status: 'needs_support', failureReason: 'The bank transfer did not complete. A person is checking it with our partner. Do not pay again.' };
      default:
        return null;
    }
  }

  /**
   * Paid only when a USDC transfer to the receiver shows up on Base: after the payment started, close to the amount
   * promised, and not already counted for another payment. Until then the payer sees "on its way", and a person is
   * asked to look if it never shows up.
   */
  private async nairaDelivery(payment: AgentPayment): Promise<Partial<AgentPayment> | null> {
    const waiting = (): Partial<AgentPayment> | null => {
      if (payment.status === 'processing' && Date.now() - payment.updatedAt.getTime() > NAIRA_DELIVERY_WAIT_MS) {
        return { status: 'needs_support', failureReason: 'Our partner says the USDC was sent, but it has not shown up on Base. A person is checking it. Do not pay again.' };
      }
      return payment.status === 'processing' ? null : { status: 'processing', failureReason: null };
    };
    const receiver = payment.deliverTo;
    if (!receiver || !isAddress(receiver)) return waiting();
    try {
      const latest = await this.chain.latestBlock();
      const started = (payment.acceptedAt ?? payment.createdAt).getTime();
      const startBlock = Math.max(0, latest - Math.ceil((Date.now() - started) / BASE_BLOCK_MS) - DELIVERY_SEARCH_MARGIN_BLOCKS);
      const from = Math.max(startBlock, this.searchedTo.get(payment.id) ?? 0, latest - DELIVERY_SEARCH_MAX_BLOCKS);
      const transfers = from <= latest ? await this.chain.transfers({ to: [receiver] }, from, latest) : [];
      // A few blocks are read again next time, in case the node had not seen the newest ones yet.
      this.searchedTo.set(payment.id, Math.max(startBlock, latest - 5));
      const lowest = BigInt(Math.floor(payment.usdcMinor * (1 - NAIRA_SHORTFALL_ALLOWED)));
      const highest = BigInt(Math.ceil(payment.usdcMinor * (1 + NAIRA_SHORTFALL_ALLOWED)));
      for (const transfer of transfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
        if (transfer.value < lowest || transfer.value > highest) continue;
        const [claimed] = await this.db
          .select({ id: agentPayments.id })
          .from(agentPayments)
          .where(and(sql`${agentPayments.transactions} @> ${JSON.stringify([transfer.txHash])}::jsonb`, sql`${agentPayments.id} <> ${payment.id}`))
          .limit(1);
        if (claimed) continue;
        this.searchedTo.delete(payment.id);
        return { status: 'paid', paidAt: new Date(), failureReason: null, transactions: [transfer.txHash] };
      }
    } catch (error) {
      this.logger.warn(`naira payment ${payment.id}: could not read Base: ${(error as Error).message.slice(0, 200)}`);
      return payment.status === 'processing' ? null : { status: 'processing', failureReason: null };
    }
    return waiting();
  }

  private async nextState(payment: AgentPayment): Promise<Partial<AgentPayment> | null> {
    if (payment.payFrom === NAIRA) return this.onramp ? this.nextNairaState(payment) : null;
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
        .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), eq(column, value), inArray(agentPayments.status, [...AGENT_STATUSES_MONEY_ARRIVED]), gte(agentPayments.acceptedAt, sql`${startOfLagosDay}`)));
      return Number(row!.used);
    };
    const [open] = await db
      .select({ open: count() })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, KEYLESS_KEY_ID), eq(agentPayments.accountNumber, accountNumber), inArray(agentPayments.status, ['creating', 'awaiting_deposit']), gte(agentPayments.acceptedAt, sql`${startOfLagosDay}`), sql`(${agentPayments.depositDeadline} is null or ${agentPayments.depositDeadline} > now())`));
    if (Number(open!.open) >= KEYLESS.openUnpaidPerAccount) throw new AgentRefusal('too_many_open', 'Several payments to this account are waiting for money. Finish one, or try again in a few minutes.', 429);
    if ((await used(agentPayments.refundTo, refundTo)) + addedKobo > KEYLESS.perWalletDayKobo) throw new AgentRefusal('over_wallet_limit', 'This wallet has reached its limit for today.', 422);
    if ((await used(agentPayments.accountNumber, accountNumber)) + addedKobo > KEYLESS.perAccountDayKobo) throw new AgentRefusal('over_account_limit', 'This bank account has reached its limit for today.', 422);
  }

  private async assertAllowed(key: AgentKey, addedKobo: number, db: Pick<Database, 'select'>): Promise<void> {
    const refused = await this.guards.refusal(['bank'], addedKobo, db);
    if (refused) throw new AgentRefusal('paused', refused, 503);
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${agentPayments.amountKobo}), 0)` })
      .from(agentPayments)
      .where(and(eq(agentPayments.keyId, key.id), inArray(agentPayments.status, [...(key.id === KEYLESS_KEY_ID ? AGENT_STATUSES_MONEY_ARRIVED : AGENT_STATUSES_THAT_COUNT)]), gte(agentPayments.acceptedAt, sql`${startOfLagosDay}`)));
    const left = key.dailyLimitKobo - Number(row!.used);
    if (addedKobo > left) throw new AgentRefusal('over_daily_limit', `This would go over this key's daily limit. ${formatNaira(Math.max(left, 0))} is left today.`, 422);
  }
}
