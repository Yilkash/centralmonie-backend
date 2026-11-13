import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { DataPlan, DataPlans, PaymentProvider, PaymentRequest, PaymentResult, PaymentState } from '../providers';
import { nairaToKobo } from './naira';

// Airtime and data from the platform's prefunded naira at Payscribe. Ported from Tokkenly's
// src/payscribe/payscribe.client.ts and src/bills. Never run against the live partner from CentralMonie.

export interface PayscribeConfig {
  /** Sandbox is https://sandbox.payscribe.ng/api/v1/, live is https://api.payscribe.ng/api/v1/. */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** How long a network's plan list is reused. Five minutes unless set. */
  planCacheMs?: number;
  now?: () => number;
}

/** Payscribe refused, or could not be reached. The message is the partner's: never show it to a customer. */
export class PayscribeError extends Error {
  constructor(
    message: string,
    /** Payscribe's own HTTP status, or null when the call never landed. */
    readonly status: number | null,
    /** True when an answer arrived and could not be read. */
    readonly unreadable = false,
  ) {
    super(message);
  }

  get unreachable(): boolean {
    return this.status === null;
  }

  /** True when nothing can be concluded from this answer about the transaction. */
  get retryable(): boolean {
    return this.unreachable || this.unreadable || this.status === 429 || (this.status !== null && this.status >= 500);
  }

  /** Our key or account was refused, which says nothing about the transaction either. */
  get authFault(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Payscribe's sentence when the prefunded balance is short: it has no code for this. */
export function isInsufficientProviderBalance(err: unknown): boolean {
  return err instanceof PayscribeError && /insufficient\s+(funds|balance)|facility\s+balance/i.test(err.message);
}

// Customer-facing. Payscribe's own sentences can state the platform's balance, so they are only logged.
const UNAVAILABLE = 'Airtime and data are temporarily unavailable. Please try again later.';
const NOT_DELIVERED = 'The airtime or data could not be delivered.';

const NETWORKS: Record<string, string> = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', '9mobile': '9mobile' };
const MIN_AIRTIME_KOBO = 50_00;
const MAX_AIRTIME_KOBO = 20_000_00;
const MAX_REFERENCE_BYTES = 64;
const MAX_PLAN_ID_LENGTH = 100;

const TIMEOUT_MS = 15_000;
// Node's default of 250 ms per address abandoned Payscribe's slower IPv4 handshake from some Nigerian networks.
const CONNECTION_ATTEMPT_TIMEOUT_MS = 1_500;
const DEFAULT_PLAN_CACHE_MS = 5 * 60_000;
const MAX_REMEMBERED_ATTEMPTS = 10_000;
const REPLAY_WINDOW_SECONDS = 300;

interface Envelope<T> {
  status: boolean;
  description?: string;
  message?: { details?: T };
  status_code?: number;
}

interface RawVend {
  trans_id?: string;
  status?: string;
  transaction_status?: string;
}

interface RawBalance {
  currency?: unknown;
  available_balance?: unknown;
}

interface RawDataNetwork {
  network_name?: string;
  plans?: RawDataPlan[];
}

interface RawDataPlan {
  plan_code?: unknown;
  name?: unknown;
  category?: unknown;
  amount?: unknown;
  plans?: unknown;
}

interface Reading {
  state: 'completed' | 'processing' | 'failed';
  transactionId: string | null;
}

type Order =
  | { route: 'airtime'; network: string; phone: string; naira: number }
  | { route: 'data'; network: string; phone: string; plan: string };

/** The airtime and data half of PaymentProvider, plus the real data plan list. */
export class PayscribeProvider extends PaymentProvider implements DataPlans {
  private readonly logger = new Logger(PayscribeProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  private readonly planCacheMs: number;
  private readonly now: () => number;
  private readonly planCache = new Map<string, { until: number; plans: DataPlan[] }>();
  /** Every reference this process has sent a vend for. Never sent a second time. */
  private readonly attempts = new Map<string, Promise<PaymentResult>>();

  constructor(config: PayscribeConfig) {
    super();
    if (!config.baseUrl || !config.apiKey) throw new Error('PayscribeProvider needs a baseUrl and an apiKey');
    if (getDefaultAutoSelectFamilyAttemptTimeout() < CONNECTION_ATTEMPT_TIMEOUT_MS) {
      setDefaultAutoSelectFamilyAttemptTimeout(CONNECTION_ATTEMPT_TIMEOUT_MS);
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.planCacheMs = config.planCacheMs ?? DEFAULT_PLAN_CACHE_MS;
    this.now = config.now ?? Date.now;
  }

  /**
   * Turned away before the customer pays. Unlike Tokkenly this cannot subtract bills already paid
   * for and not yet vended, because that figure lives in the caller's tables.
   */
  async refusal(request: PaymentRequest): Promise<string | null> {
    const order = readOrder(request);
    if (typeof order === 'string') return order;
    try {
      if (order.route === 'data') {
        const plan = (await this.forNetwork(order.network)).find((candidate) => candidate.id === order.plan);
        if (!plan) return 'That data plan is no longer available.';
        if (plan.priceKobo !== request.amountKobo) return 'The price of that data plan has changed.';
      }
      const available = await this.availableNairaKobo();
      if (available < BigInt(request.amountKobo)) {
        this.logger.warn('the prefunded naira balance cannot cover this payment');
        return UNAVAILABLE;
      }
      return null;
    } catch (err) {
      // Charging somebody blind is the failure this exists to prevent.
      this.logger.warn(`could not check the prefunded balance: ${summary(err)}`);
      return UNAVAILABLE;
    }
  }

  async fundingAddress(): Promise<string | null> {
    return null;
  }

  /**
   * Idempotent on request.reference, in three layers:
   * 1. The reference goes to Payscribe as `ref`, and stays the same across calls.
   * 2. Inside this process a reference is never vended twice, even when the first answer was lost.
   * 3. Before any vend the reference is requeried, so a repeat after a restart finds the first
   *    purchase. A vend with a reused `ref` is the last resort, as in Tokkenly.
   * Throws, having sent no vend, if that requery gets no usable answer: the caller repeats pay() later.
   */
  async pay(request: PaymentRequest): Promise<PaymentResult> {
    const order = readOrder(request);
    if (typeof order === 'string') return { ok: false, reason: order };

    const earlier = this.attempts.get(request.reference);
    if (earlier) return earlier;

    const shared = this.attempt(request.reference, order).then(
      ({ result, vendSent }) => {
        // Nothing went to the partner, so a later call may still try.
        if (!vendSent) this.attempts.delete(request.reference);
        return result;
      },
      (err: unknown) => {
        this.attempts.delete(request.reference);
        throw err;
      },
    );
    this.attempts.set(request.reference, shared);
    if (this.attempts.size > MAX_REMEMBERED_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return shared;
  }

  /**
   * Asks Payscribe, and calls it delivered only when Payscribe says so. A refused requery stays
   * pending and logs an error: "no record" is not proof a vend did not land, and failed would refund
   * USDC for airtime that may have been delivered. Tokkenly hands this case to a person too.
   */
  async status(reference: string, providerReference: string): Promise<PaymentState> {
    try {
      const reading = await this.requery(providerReference || reference);
      if (!reading) return { state: 'pending' };
      if (reading.state === 'completed') return { state: 'completed' };
      if (reading.state === 'failed') return { state: 'failed', reason: NOT_DELIVERED };
      return { state: 'pending' };
    } catch (err) {
      if (err instanceof PayscribeError && !err.retryable) {
        this.logger.error(`payment ${reference}: requery refused, so a person must check it: ${summary(err)}`);
      }
      return { state: 'pending' };
    }
  }

  /** Current plans for a network, whatever its case. An unknown network has none. */
  async forNetwork(network: string): Promise<DataPlan[]> {
    const key = network.trim().toLowerCase();
    if (!Object.hasOwn(NETWORKS, key)) return [];
    const cached = this.planCache.get(key);
    if (cached && cached.until > this.now()) return cached.plans;

    const details = await this.call<RawDataNetwork[]>('GET', `/data/lookup?network=${encodeURIComponent(key)}`);
    const catalogue = Array.isArray(details) ? details.find((entry) => entry.network_name?.toLowerCase() === key) : undefined;
    const plans = flattenDataPlans(catalogue?.plans ?? [])
      // Awoof bundles are targeted offers with no eligibility check, so MTN can refuse them after payment.
      .filter((plan) => plan.category !== 'awoof')
      .map((plan) => ({ id: plan.code, network: NETWORKS[key]!, label: plan.name, priceKobo: plan.kobo }));
    this.planCache.set(key, { until: this.now() + this.planCacheMs, plans });
    return plans;
  }

  async find(id: string): Promise<DataPlan | null> {
    const lists = await Promise.allSettled(Object.keys(NETWORKS).map((network) => this.forNetwork(network)));
    for (const list of lists) {
      const plan = list.status === 'fulfilled' ? list.value.find((candidate) => candidate.id === id) : undefined;
      if (plan) return plan;
    }
    // "No such plan" would be a guess while a list could not be read.
    const failed = lists.find((list) => list.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return null;
  }

  /** The spendable naira at Payscribe, in kobo. Any facility on top is deliberately not counted. */
  async availableNairaKobo(): Promise<bigint> {
    const rows = await this.call<RawBalance[]>('GET', '/my-account/balances');
    const naira = Array.isArray(rows) ? rows.find((row) => row?.currency === 'NGN') : undefined;
    if (!naira) throw new PayscribeError('no naira balance in the response', 200);
    return nairaToKobo(naira.available_balance, 'available balance');
  }

  private async attempt(reference: string, order: Order): Promise<{ result: PaymentResult; vendSent: boolean }> {
    try {
      const known = await this.requery(reference);
      if (known) return { result: toResult(known, reference), vendSent: false };
    } catch (err) {
      const notFound = err instanceof PayscribeError && !err.retryable && !err.authFault;
      // Nothing is known about any earlier attempt, so this is not the moment to vend.
      if (!notFound) throw new Error(UNAVAILABLE);
    }

    try {
      return { result: toResult(await this.vend(reference, order), reference), vendSent: true };
    } catch (err) {
      if (err instanceof PayscribeError && !err.retryable) {
        if (isInsufficientProviderBalance(err)) this.logger.error('the prefunded naira balance ran short during a vend');
        return { result: { ok: false, reason: err.authFault ? UNAVAILABLE : NOT_DELIVERED }, vendSent: true };
      }
      // The vend may have landed. Only a requery can say, so status() must be asked.
      this.logger.warn(`vend ${reference}: outcome unknown: ${summary(err)}`);
      return { result: { ok: true, providerReference: reference, pending: true }, vendSent: true };
    }
  }

  private async vend(reference: string, order: Order): Promise<Reading> {
    const body =
      order.route === 'airtime'
        ? { network: order.network, amount: order.naira, recipient: order.phone, ported: false, ref: reference }
        : { plan: order.plan, recipient: [order.phone], network: order.network, ref: reference };
    const envelope = await this.callEnvelope<RawVend>('POST', order.route === 'airtime' ? '/airtime' : '/data/vend', body);
    // A vend answering with no details says nothing about delivery, so it is never read as delivered.
    if (!envelope.message?.details) return { state: 'processing', transactionId: null };
    return readVend(envelope);
  }

  /** What Payscribe says about a transaction, or null if the answer does not actually describe one. */
  private async requery(id: string): Promise<Reading | null> {
    const envelope = await this.callEnvelope<RawVend>('GET', `/requery?trans_id=${encodeURIComponent(id)}`);
    const details = envelope.message?.details;
    if (!details?.trans_id && !details?.status && !details?.transaction_status) return null;
    const reading = readVend(envelope);
    // Tokkenly's specs only show a requery that names a status, so silence is not delivery here.
    if (!details.status && !details.transaction_status) return { ...reading, state: 'processing' };
    return reading;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const envelope = await this.callEnvelope<T>(method, path, body);
    const details = envelope.message?.details;
    if (details === undefined) throw new PayscribeError('incomplete response', 200, true);
    return details;
  }

  private async callEnvelope<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Envelope<T>> {
    const where = `${method} ${path.split('?')[0]}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`${where} did not complete: ${summary(err)}`);
      throw new PayscribeError('could not reach Payscribe', null);
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new PayscribeError('unreadable response', response.status, true);
    }

    if (!response.ok || envelope?.status !== true) {
      const description = envelope?.description || 'refused';
      this.logger.warn(`${where} refused: status=${response.status}; ${safeForLog(description)}`);
      throw new PayscribeError(description, response.status);
    }
    return envelope;
  }
}

/** The payment as Payscribe needs it, or the reason it cannot be one. Nothing here calls out. */
function readOrder(request: PaymentRequest): Order | string {
  if (request.route !== 'airtime' && request.route !== 'data') return 'Payscribe only handles airtime and data.';
  if (typeof request.reference !== 'string' || request.reference === '') return 'A payment needs a reference.';
  if (Buffer.byteLength(request.reference) > MAX_REFERENCE_BYTES) return 'That payment reference is too long.';
  if (!Number.isSafeInteger(request.amountKobo) || request.amountKobo <= 0) return 'That is not a valid naira amount.';
  if (!Number.isSafeInteger(request.usdcMinor) || request.usdcMinor <= 0) return 'That is not a valid USDC amount.';

  const destination = (request.destination ?? {}) as { phone?: unknown; network?: unknown; dataPlanId?: unknown };
  const phone = typeof destination.phone === 'string' ? destination.phone : '';
  if (!/^0[789]\d{9}$/.test(phone)) return 'That is not a valid 11-digit Nigerian number.';
  const network = typeof destination.network === 'string' ? destination.network.trim().toLowerCase() : '';
  if (!Object.hasOwn(NETWORKS, network)) return 'The network must be MTN, Airtel, Glo or 9mobile.';

  if (request.route === 'airtime') {
    if (request.amountKobo % 100 !== 0 || request.amountKobo < MIN_AIRTIME_KOBO || request.amountKobo > MAX_AIRTIME_KOBO) {
      return 'Airtime must be a whole-naira amount between N50 and N20,000.';
    }
    return { route: 'airtime', network, phone, naira: request.amountKobo / 100 };
  }

  const plan = typeof destination.dataPlanId === 'string' ? destination.dataPlanId.trim() : '';
  if (plan === '' || plan.length > MAX_PLAN_ID_LENGTH) return 'A data payment needs a data plan.';
  return { route: 'data', network, phone, plan };
}

function toResult(reading: Reading, reference: string): PaymentResult {
  const providerReference = reading.transactionId ?? reference;
  if (reading.state === 'failed') return { ok: false, reason: NOT_DELIVERED };
  if (reading.state === 'processing') return { ok: true, providerReference, pending: true };
  return { ok: true, providerReference };
}

/** Tokkenly's vendResult. Delivered only on a recognised word; an unknown word stays processing. */
function readVend(envelope: Envelope<RawVend>): Reading {
  const details = envelope.message?.details;
  const word =
    (details?.transaction_status ?? details?.status)?.toLowerCase() ?? (envelope.status_code === 201 ? 'processing' : 'success');
  const state =
    /pending|processing/.test(word) || envelope.status_code === 201
      ? 'processing'
      : // "unsuccess" is added to Tokkenly's list: it contains "success" and would otherwise read as delivered.
        /fail|declin|revers|unsuccess/.test(word)
        ? 'failed'
        : /success|complete|deliver|approved/.test(word)
          ? 'completed'
          : 'processing';
  return { state, transactionId: details?.trans_id ?? null };
}

function flattenDataPlans(
  rows: RawDataPlan[],
  inherited: string | null = null,
): Array<{ code: string; name: string; category: string | null; kobo: number }> {
  const plans: Array<{ code: string; name: string; category: string | null; kobo: number }> = [];
  for (const row of rows) {
    const category = typeof row.category === 'string' && row.category.trim() ? row.category.trim().toLowerCase() : inherited;
    if (Array.isArray(row.plans)) {
      plans.push(...flattenDataPlans(row.plans as RawDataPlan[], category));
      continue;
    }
    if (typeof row.plan_code !== 'string' || row.plan_code === '' || typeof row.name !== 'string' || row.name === '') continue;
    if (typeof row.amount !== 'string' && typeof row.amount !== 'number') continue;
    try {
      const kobo = Number(nairaToKobo(row.amount, `data plan ${row.plan_code}`));
      if (kobo > 0 && Number.isSafeInteger(kobo)) plans.push({ code: row.plan_code, name: row.name, category, kobo });
    } catch {
      // One malformed row must not hide every valid plan.
    }
  }
  return plans;
}

/**
 * Whether a webhook came from Payscribe: "v1=" + hex(HMAC-SHA256(timestamp.eventId.rawBody, secret)),
 * within five minutes. Payscribe's key signs its webhooks. Tokkenly warns its collection documents
 * this two ways and to confirm against the sandbox. It has no controller using this, so it does
 * not show the header names either.
 */
export function verifyPayscribeWebhook(
  rawBody: string,
  headers: { signature?: string; timestamp?: string; eventId?: string },
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(headers.signature ?? '');
  if (!match) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > REPLAY_WINDOW_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(`${headers.timestamp}.${headers.eventId ?? ''}.${rawBody}`).digest('hex');
  const given = Buffer.from(match[1]!, 'utf8');
  const mine = Buffer.from(expected, 'utf8');
  return given.length === mine.length && timingSafeEqual(given, mine);
}

/** A partner's sentence for a log: one line, short, and with no phone or account number in it. */
function safeForLog(message: string): string {
  return message.replace(/\d{7,}/g, '[number]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function summary(err: unknown): string {
  return safeForLog(err instanceof Error ? err.message : String(err));
}
