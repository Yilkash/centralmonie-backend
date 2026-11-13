import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAddress } from 'viem';
import { BankLookup, ExchangeRates, NairaOnramp, OnrampState, PaymentProvider, PaymentRequest, PaymentResult, PaymentState } from '../providers';
import { echoesAmount, fromSwitchNumber, KOBO_DECIMALS, switchNumberToMinor, toSwitchNumber, USDC_DECIMALS } from './switch-money';

// Naira to a bank and naira to USDC through Switch. Ported from Tokkenly's src/switch. Never run
// against the live partner from CentralMonie.
//
// Off-ramp order, and the safety argument Tokkenly makes for it: deposit() asks Switch to create
// the payment with a stable reference, and only then is USDC sent to the address it names. Switch
// pays the bank itself once the deposit lands. So pay() only reads status: it cannot start a
// payment or pay twice, because nothing here is an instruction to pay.

export interface SwitchConfig {
  /**
   * The sandbox answers with a placeholder deposit address that nothing can be sent to. With this on,
   * that answer is accepted and the test USDC goes to the platform's collection address instead.
   */
  sandbox?: boolean;
  /** Tokkenly uses https://api.onswitch.xyz. Sandbox and live share it and differ only by key. */
  baseUrl: string;
  apiKey: string;
  /** Where Switch returns USDC that arrives too late, unless the destination names its own refundAddress. */
  refundAddress: string;
  /** Switch signs callbacks with the API key unless a separate secret is set on its side. */
  webhookSecret?: string;
  callbackUrl?: string;
  onrampCallbackUrl?: string;
  /** Switch's name for the network: the first half of `base:usdc`. Defaults to base. */
  network?: string;
  /** The name sent for every on-ramp beneficiary. CentralMonie has no identity checks. */
  holderName?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Switch refused, or could not be reached. The message is the partner's: never show it to a customer. */
export class SwitchError extends Error {
  constructor(
    message: string,
    /** Switch's own HTTP status, or null when the call never landed. */
    readonly status: number | null,
    /** True when an answer arrived and could not be read. */
    readonly unreadable = false,
  ) {
    super(message);
  }

  get unreachable(): boolean {
    return this.status === null;
  }

  /** True when asking again could get a different answer. Only a readable 4xx from Switch is a refusal. */
  get retryable(): boolean {
    return this.unreachable || this.unreadable || this.status === 429 || (this.status !== null && this.status >= 500);
  }

  /** Our key or account was refused, which says nothing about a payment or an account. */
  get authFault(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** What the off-ramp was created as. The naira figure is Switch's, at its rate when the payment was made. */
export interface SwitchDeposit {
  address: string;
  /** After this Switch returns late USDC to the refund address. Null if it named no time. */
  expiresAt: string | null;
  usdcMinor: number;
  destinationKobo: number;
  rate: string;
  providerStatus: string;
}

/** Where the customer sends naira, and what they get for it. Fields Switch leaves out are null. */
export interface SwitchOnrampInstructions {
  reference: string;
  providerStatus: string;
  amountKobo: number;
  usdcMinor: number;
  rate: string;
  bankName: string | null;
  bankCode: string | null;
  accountNumber: string;
  accountName: string | null;
  expiresAt: string | null;
  note: string[];
}

export interface SwitchBank {
  code: string;
  name: string;
}

interface Envelope<T> {
  success: boolean;
  message: string;
  data: T | null;
}

interface RawAmount {
  amount?: number;
  currency?: string;
}

interface RawPayment {
  status?: string;
  rate?: number;
  source?: RawAmount;
  destination?: RawAmount;
  deposit?: {
    amount?: number;
    address?: string;
    note?: string[];
    expires_at?: string;
    account_number?: string;
    account_name?: string;
    bank_code?: string;
    bank_name?: string;
  };
}

interface Payout {
  bankName: string;
  accountNumber: string;
  accountName: string;
  refundAddress: string | null;
}

// Only Nigeria is a corridor, as in Tokkenly's src/switch/corridors.ts.
const COUNTRY = 'NG';
const CURRENCY = 'NGN';
const CHANNEL = 'BANK';
const HOLDER_TYPE = 'INDIVIDUAL';

// The bank name lookup was seen taking 14 seconds in the sandbox.
const TIMEOUT_MS = 30_000;
const RATE_TTL_MS = 30_000;
const STALE_RATE_MS = 10 * 60_000;
const BANKS_TTL_MS = 60 * 60_000;
const MAX_REFERENCE_BYTES = 64;
const REPLAY_WINDOW_MS = 5 * 60_000;
const SECONDS_CEILING = 100_000_000_000;

const COMPLETED = 'COMPLETED';
const STOPPED = new Set(['FAILED', 'REVERSED', 'BLOCKED']);

export const SWITCH_SIGNATURE_HEADER = 'x-switch-signature';
export const SWITCH_TIMESTAMP_HEADER = 'x-switch-timestamp';
export const GENERIC_HOLDER_NAME = '10kobo Customer'; // The name agreed with the partner; changing it needs their OK.

// Customer-facing. Provider text is not customer copy, so Switch's own sentences are only logged.
const BANK_UNAVAILABLE = 'Sending to a bank is unavailable right now. Please try again shortly.';
const BUYING_UNAVAILABLE = 'Buying USDC is unavailable right now. Please try again shortly.';
const BANK_NOT_PAID = 'The bank payment could not be completed. Any USDC sent goes back to the refund address.';
const NEVER_STARTED = 'The partner has no record of this bank payment. Check it before refunding.';
const NO_SUCH_BANK = 'I could not find that bank.';

/** The bank half of PaymentProvider, plus real exchange rates and bank account lookup. */
export class SwitchProvider extends PaymentProvider implements ExchangeRates, BankLookup, NairaOnramp {
  private readonly logger = new Logger(SwitchProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly refundAddress: string;
  private readonly callbackUrl: string | undefined;
  private readonly onrampCallbackUrl: string | undefined;
  private readonly assetCode: string;
  private readonly holderName: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private rateCache: { until: number; rate: number } | null = null;
  private banksCache: { until: number; banks: SwitchBank[] } | null = null;
  private readonly sandbox: boolean;
  private lastRate: { at: number; rate: number } | undefined;
  private readonly deposits = new Map<string, Promise<SwitchDeposit>>();

  constructor(config: SwitchConfig) {
    super();
    if (!config.baseUrl || !config.apiKey) throw new Error('SwitchProvider needs a baseUrl and an apiKey');
    if (!isAddress(config.refundAddress)) throw new Error('SwitchProvider needs a valid refundAddress');
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.sandbox = config.sandbox ?? false;
    this.apiKey = config.apiKey;
    this.refundAddress = config.refundAddress;
    this.callbackUrl = config.callbackUrl;
    this.onrampCallbackUrl = config.onrampCallbackUrl;
    this.assetCode = `${config.network ?? 'base'}:usdc`;
    this.holderName = switchBeneficiaryName(config.holderName);
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? Date.now;
  }

  /** Turned away before any USDC moves: a bad destination, or an amount Switch will not price. */
  /** Switch refuses anything under 1 USDC per transaction. */
  override minimumUsdcMinor(): number {
    return 1_000_000;
  }

  async refusal(request: PaymentRequest): Promise<string | null> {
    const payout = readPayout(request);
    if (typeof payout === 'string') return payout;
    try {
      if ((await this.bankCode(payout.bankName)) === null) return NO_SUCH_BANK;
      const quote = await this.call<RawPayment>('POST', '/offramp/quote', {
        amount: toSwitchNumber(request.usdcMinor, USDC_DECIMALS),
        country: COUNTRY,
        currency: CURRENCY,
        asset: this.assetCode,
        channel: CHANNEL,
        exact_output: false,
      });
      return echoesAmount(quote.source?.amount, request.usdcMinor, USDC_DECIMALS) ? null : BANK_UNAVAILABLE;
    } catch (err) {
      return err instanceof SwitchError ? refusedSentence(err, BANK_UNAVAILABLE, 'send to a bank') : BANK_UNAVAILABLE;
    }
  }

  /** Never null for a bank payment, because the platform's collection address would not pay the bank. */
  async fundingAddress(request: PaymentRequest): Promise<string | null> {
    const { address } = await this.deposit(request);
    return this.sandbox && isSandboxPlaceholder(address) ? null : address;
  }

  /**
   * Creates the payment at Switch, or returns the one this reference already made. Switch treats
   * the reference as its idempotency key, and this process does not even ask twice. The USDC must
   * reach the address before expiresAt, and the caller should keep the address it was given.
   */
  deposit(request: PaymentRequest): Promise<SwitchDeposit> {
    const earlier = this.deposits.get(request.reference);
    if (earlier) return earlier;
    const created = this.createDeposit(request).catch((err: unknown) => {
      // Nothing was handed over, so the same reference may ask again.
      this.deposits.delete(request.reference);
      throw err;
    });
    this.deposits.set(request.reference, created);
    return created;
  }

  /** Reads where the payment is. Never starts or repeats one, so it is safe to call any number of times. */
  async pay(request: PaymentRequest): Promise<PaymentResult> {
    const payout = readPayout(request);
    if (typeof payout === 'string') return { ok: false, reason: payout };

    const providerReference = request.reference;
    const state = await this.status(request.reference, providerReference);
    if (state.state === 'completed') return { ok: true, providerReference };
    if (state.state === 'pending') return { ok: true, providerReference, pending: true };
    return { ok: false, reason: state.reason };
  }

  async status(reference: string, providerReference: string): Promise<PaymentState> {
    const id = providerReference || reference;
    let word: string;
    try {
      const payment = await this.call<RawPayment>('GET', `/payment/status?${new URLSearchParams({ reference: id }).toString()}`);
      word = String(payment.status ?? '').toUpperCase();
    } catch (err) {
      // "We could not ask" and "they said no" are different facts.
      if (err instanceof SwitchError && !err.retryable && !err.authFault) return { state: 'failed', reason: NEVER_STARTED };
      return { state: 'pending' };
    }
    if (word === COMPLETED) return { state: 'completed' };
    if (STOPPED.has(word)) return { state: 'failed', reason: BANK_NOT_PAID };
    // AWAITING_DEPOSIT, PROCESSING, SCHEDULED, and any word not seen before.
    return { state: 'pending' };
  }

  /** Where a deposit stands. An unseen word changes nothing, so nobody is told their money arrived when it did not. */
  async onrampState(reference: string): Promise<OnrampState> {
    let word: string;
    try {
      const payment = await this.call<RawPayment>('GET', `/payment/status?${new URLSearchParams({ reference }).toString()}`);
      word = String(payment.status ?? '').toUpperCase();
    } catch {
      return 'unknown';
    }
    if (word === 'AWAITING_DEPOSIT') return 'waiting';
    if (word === COMPLETED) return 'completed';
    if (STOPPED.has(word)) return 'failed';
    if (word.includes('EXPIRE')) return 'expired';
    if (word === 'PROCESSING' || word === 'SCHEDULED' || word.includes('RECEIVED')) return 'processing';
    this.logger.warn(`onramp ${reference}: status word not seen before: ${word}`);
    return 'unknown';
  }

  /** Switch states its floor as 1 US dollar. Rounded up to ₦100, so a small rate move cannot put it under. */
  async onrampTerms(): Promise<{ nairaPerUsdc: number; minimumKobo: number }> {
    const result = await this.call<{ rate?: number }>('POST', '/onramp/rate', { country: COUNTRY, currency: CURRENCY, asset: this.assetCode, channel: CHANNEL });
    const rate = Number(fromSwitchNumber(result.rate, 6));
    if (rate <= 0) throw new SwitchError('the rate was not positive', 200, true);
    return { nairaPerUsdc: rate, minimumKobo: Math.ceil((rate * 1.01) / 100) * 100 * 100 };
  }

  /** The off-ramp rate. Buying and selling carry different spreads, so this does not price an on-ramp. */
  async nairaPerUsdc(): Promise<number> {
    if (this.rateCache && this.rateCache.until > this.now()) return this.rateCache.rate;
    try {
      const result = await this.call<{ rate?: number }>('POST', '/offramp/rate', {
        country: COUNTRY,
        currency: CURRENCY,
        asset: this.assetCode,
        channel: CHANNEL,
      });
      const rate = Number(fromSwitchNumber(result.rate, 6));
      if (rate <= 0) throw new SwitchError('the rate was not positive', 200, true);
      this.rateCache = { until: this.now() + RATE_TTL_MS, rate };
      this.lastRate = { at: this.now(), rate };
      return rate;
    } catch (err) {
      // A short outage keeps the recent rate. This only prices the card: Switch quotes again before any payment.
      if (this.lastRate && this.now() - this.lastRate.at < STALE_RATE_MS) return this.lastRate.rate;
      throw err;
    }
  }

  /** Null when the bank or account does not exist. Throws when Switch cannot answer, which is not the same. */
  async accountName(bankName: string, accountNumber: string): Promise<string | null> {
    if (!/^\d{10}$/.test(accountNumber)) return null;
    const bankCode = await this.bankCode(bankName);
    if (bankCode === null) return null;
    try {
      const result = await this.call<{ account_name?: string }>('POST', '/institution/lookup', {
        country: COUNTRY,
        beneficiary: { account_number: accountNumber, bank_code: bankCode },
      });
      return result.account_name || null;
    } catch (err) {
      if (err instanceof SwitchError && !err.retryable && !err.authFault) return null;
      throw err;
    }
  }

  /** The banks Switch can pay, so a caller can offer exact names. */
  async banks(): Promise<SwitchBank[]> {
    if (this.banksCache && this.banksCache.until > this.now()) return this.banksCache.banks;
    const query = new URLSearchParams({ country: COUNTRY, channel: CHANNEL });
    const rows = await this.call<SwitchBank[]>('GET', `/institution?${query.toString()}`);
    const banks = rows.map((row) => ({ code: row.code, name: row.name }));
    this.banksCache = { until: this.now() + BANKS_TTL_MS, banks };
    return banks;
  }

  /**
   * Naira to USDC. Moves nothing: it issues an account to transfer into, and Switch delivers USDC
   * to the wallet once the naira arrives. The reference is Switch's idempotency key, so a retry
   * returns the original order rather than a second account.
   */
  async nairaOnramp(input: { reference: string; amountKobo: number; walletAddress: string }): Promise<SwitchOnrampInstructions> {
    const problem = referenceProblem(input.reference) ?? (validMinor(input.amountKobo) ? null : 'That is not a valid naira amount.');
    if (problem) throw new Error(problem);
    if (!isAddress(input.walletAddress)) throw new Error('That is not a valid wallet address.');

    let payment: RawPayment;
    try {
      payment = await this.call<RawPayment>('POST', '/onramp/initiate', {
        amount: toSwitchNumber(input.amountKobo, KOBO_DECIMALS),
        country: COUNTRY,
        currency: CURRENCY,
        asset: this.assetCode,
        channel: CHANNEL,
        beneficiary: { holder_type: HOLDER_TYPE, holder_name: this.holderName, wallet_address: input.walletAddress },
        reference: input.reference,
        ...(this.onrampCallbackUrl ? { callback_url: this.onrampCallbackUrl } : {}),
        exact_output: false,
      });
    } catch (err) {
      throw new Error(err instanceof SwitchError ? refusedSentence(err, BUYING_UNAVAILABLE, 'buy') : BUYING_UNAVAILABLE);
    }

    // Priced for an amount nobody asked about, or named no account: refused rather than passed on.
    const deposit = payment.deposit;
    if (!echoesAmount(payment.source?.amount, input.amountKobo, KOBO_DECIMALS) || !deposit?.account_number) {
      this.logger.error(`onramp ${input.reference}: the answer did not match the request or named no account`);
      throw new Error(BUYING_UNAVAILABLE);
    }
    try {
      return {
        reference: input.reference,
        providerStatus: String(payment.status ?? ''),
        amountKobo: input.amountKobo,
        usdcMinor: switchNumberToMinor(payment.destination?.amount, USDC_DECIMALS),
        rate: fromSwitchNumber(payment.rate, 6),
        bankName: deposit.bank_name ?? null,
        bankCode: deposit.bank_code ?? null,
        accountNumber: deposit.account_number,
        accountName: deposit.account_name ?? null,
        expiresAt: deposit.expires_at ?? null,
        note: deposit.note ?? [],
      };
    } catch {
      this.logger.error(`onramp ${input.reference}: the answer carried unreadable figures`);
      throw new Error(BUYING_UNAVAILABLE);
    }
  }

  private async createDeposit(request: PaymentRequest): Promise<SwitchDeposit> {
    const payout = readPayout(request);
    if (typeof payout === 'string') throw new Error(payout);

    let payment: RawPayment;
    try {
      const bankCode = await this.bankCode(payout.bankName);
      if (bankCode === null) throw new Error(NO_SUCH_BANK);
      payment = await this.call<RawPayment>('POST', '/offramp/initiate', {
        amount: toSwitchNumber(request.usdcMinor, USDC_DECIMALS),
        country: COUNTRY,
        currency: CURRENCY,
        asset: this.assetCode,
        channel: CHANNEL,
        // Lookup wants only the number and code. Initiating also requires the holder type and name.
        beneficiary: {
          account_number: payout.accountNumber,
          bank_code: bankCode,
          holder_type: HOLDER_TYPE,
          holder_name: payout.accountName,
        },
        reference: request.reference,
        ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
        refund_address: payout.refundAddress ?? this.refundAddress,
        narration: `CentralMonie payout to ${payout.accountName}`,
        exact_output: false,
      });
    } catch (err) {
      if (err instanceof SwitchError) throw new Error(refusedSentence(err, BANK_UNAVAILABLE, 'send to a bank'));
      throw err;
    }

    // The customer is never handed an address that is not one, or asked for a different amount
    // from the one that was approved.
    const address = payment.deposit?.address;
    const depositAmount = payment.deposit?.amount;
    const amountsAgree =
      echoesAmount(payment.source?.amount, request.usdcMinor, USDC_DECIMALS) &&
      (depositAmount === undefined || echoesAmount(depositAmount, request.usdcMinor, USDC_DECIMALS));
    // A real address while we are on test money means the key is really a live one: stop before anything is sent.
    const usable = typeof address === 'string' && (this.sandbox ? isSandboxPlaceholder(address) : isAddress(address, { strict: false }));
    if (!usable || !amountsAgree) {
      this.logger.error(`offramp ${request.reference}: the answer named no usable deposit address or a different amount`);
      throw new Error(BANK_UNAVAILABLE);
    }
    try {
      return {
        address: address as string,
        expiresAt: payment.deposit?.expires_at ?? null,
        usdcMinor: request.usdcMinor,
        destinationKobo: switchNumberToMinor(payment.destination?.amount, KOBO_DECIMALS),
        rate: fromSwitchNumber(payment.rate, 6),
        providerStatus: String(payment.status ?? ''),
      };
    } catch {
      this.logger.error(`offramp ${request.reference}: the answer carried unreadable figures`);
      throw new Error(BANK_UNAVAILABLE);
    }
  }

  /**
   * Exact names only, ignoring case and punctuation, plus the short names people really use. A loose
   * match could pay the wrong bank, and the account name check still has to pass afterwards.
   */
  private async bankCode(bankName: string): Promise<string | null> {
    const typed = comparableName(bankName);
    const wanted = BANK_ALIASES[typed] ?? typed;
    if (wanted === '') return null;
    const matches = (await this.banks()).filter((bank) => comparableName(bank.name) === wanted);
    return matches.length === 1 ? matches[0]!.code : null;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const where = `${method} ${path.split('?')[0]}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-service-key': this.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`${where} did not complete: ${safeForLog(err instanceof Error ? err.message : String(err))}`);
      throw new SwitchError('could not reach Switch', null);
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new SwitchError('unreadable response', response.status, true);
    }

    if (!response.ok || envelope?.success !== true || envelope.data === null || envelope.data === undefined) {
      const message = envelope?.message || 'refused';
      // The path without its query and never the body, which can carry an account number.
      this.logger.warn(`${where} refused ${response.status}: ${safeForLog(message)}`);
      throw new SwitchError(message, response.status);
    }
    return envelope.data;
  }
}

/**
 * A beneficiary name Switch will accept. It requires an alphanumeric name, so accents go, anything
 * but letters, digits and spaces goes, and a generic stands in when nothing usable is left. Tokkenly
 * passes a verified legal name here. CentralMonie has no identity checks, so the generic is what it sends.
 */
export function switchBeneficiaryName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[a-zA-Z]/.test(cleaned) ? cleaned : GENERIC_HOLDER_NAME;
}

/**
 * Whether a callback came from Switch: hex HMAC-SHA256 of the raw body, from the
 * x-switch-signature header. Verify against the raw string, because re-serialising changes the bytes.
 * The secret is the webhook secret if one is configured, or else the API key.
 */
export function verifySwitchWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const mine = Buffer.from(expected, 'utf8');
  return given.length === mine.length && timingSafeEqual(given, mine);
}

/** Whether x-switch-timestamp is recent. Seconds in practice; the unit is detected. Unparseable falls back to the signature alone. */
export function withinSwitchReplayWindow(timestamp: string, now = Date.now()): boolean {
  const asNumber = Number(timestamp);
  const sent = Number.isFinite(asNumber) && asNumber > 0 ? (asNumber < SECONDS_CEILING ? asNumber * 1000 : asNumber) : Date.parse(timestamp);
  if (!Number.isFinite(sent)) return true;
  return Math.abs(now - sent) <= REPLAY_WINDOW_MS;
}

/** The payout as Switch needs it, or the reason it cannot be one. Nothing here calls out. */
function readPayout(request: PaymentRequest): Payout | string {
  if (request.route !== 'bank') return 'Switch only handles bank payments.';
  const problem = referenceProblem(request.reference);
  if (problem) return problem;
  if (!validMinor(request.amountKobo)) return 'That is not a valid naira amount.';
  if (!validMinor(request.usdcMinor)) return 'That is not a valid USDC amount.';

  const destination = (request.destination ?? {}) as Record<string, unknown>;
  const { bankName, accountNumber, accountName, refundAddress } = destination;
  if (typeof bankName !== 'string' || bankName.trim() === '') return 'A bank payment needs a bank.';
  // NUBAN is exactly ten digits.
  if (typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber)) return 'A bank account number has 10 digits.';
  if (typeof accountName !== 'string' || accountName.trim() === '') return 'A bank payment needs the name the bank gave.';
  if (refundAddress !== undefined && refundAddress !== null && (typeof refundAddress !== 'string' || !isAddress(refundAddress))) {
    return 'That is not a valid refund address.';
  }
  return { bankName, accountNumber, accountName, refundAddress: typeof refundAddress === 'string' ? refundAddress : null };
}

function referenceProblem(reference: unknown): string | null {
  if (typeof reference !== 'string' || reference === '') return 'A payment needs a reference.';
  return Buffer.byteLength(reference) > MAX_REFERENCE_BYTES ? 'That payment reference is too long.' : null;
}

function validMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Tokkenly's switchRefusal: a fault is ours or theirs, and any other 4xx is about the amount. */
function refusedSentence(err: SwitchError, unavailable: string, action: string): string {
  if (err.retryable || err.authFault) return unavailable;
  // Switch's sentence about names also says "at least one letter", so this is checked first.
  if (/^name /i.test(err.message)) return 'The bank details for this person need to be saved again. Nothing was sent.';
  return /minimum|at least|below|too small|less than/i.test(err.message)
    ? `That is below the smallest amount you can ${action}. Try a larger amount.`
    : 'We could not price that amount. Try a different amount.';
}

const isSandboxPlaceholder = (address: unknown): boolean => typeof address === 'string' && /sandbox/i.test(address);

/** Everyday names for banks, each checked against the list Switch returned on 3 November 2026. */
const BANK_ALIASES: Record<string, string> = {
  gtbank: 'guaranty trust bank',
  gtb: 'guaranty trust bank',
  gt: 'guaranty trust bank',
  'gt bank': 'guaranty trust bank',
  firstbank: 'first bank',
  fbn: 'first bank',
  uba: 'united bank for africa plc',
  access: 'access bank',
  zenith: 'zenith bank',
  fcmb: 'first city monument bank plc',
  stanbic: 'stanbic ibtc bank ltd',
  'stanbic ibtc': 'stanbic ibtc bank ltd',
  ecobank: 'ecobank nigeria plc',
  kuda: 'kuda microfinance bank',
  'kuda bank': 'kuda microfinance bank',
  moniepoint: 'moniepoint microfinance bank',
  wema: 'wema bank',
  fidelity: 'fidelity bank',
  sterling: 'sterling bank',
  union: 'union bank',
  polaris: 'polaris bank',
  keystone: 'keystone bank',
  providus: 'providus bank',
  unity: 'unity bank plc',
  'unity bank': 'unity bank plc',
};

function comparableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A partner's sentence for a log: one line, short, and with no account number in it. */
function safeForLog(message: string): string {
  return message.replace(/\d{7,}/g, '[number]').replace(/\s+/g, ' ').trim().slice(0, 300);
}
