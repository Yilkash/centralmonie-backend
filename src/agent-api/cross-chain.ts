import { randomBytes } from 'node:crypto';

/** Where an agent can pay from. Asset ids are from the NEAR Intents token list, checked on 4 Nov 2026. */
/**
 * Where a payer can pay from, and what NEAR Intents calls the token there. Stellar is missing because NEAR Intents
 * would not quote Stellar to Base on 6 Nov 2026 ("Quoting for this pair is not available"). Tron and TON have only
 * USDT. Tron (from $100) and BNB Chain (from $1,000) had temporary minimums that day.
 */
export const PAY_FROM = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  near: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  ethereum: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  optimism: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
  polygon: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
  avalanche: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o',
  bsc: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r',
  gnosis: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near',
  monad: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
  sui: 'nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near',
  aptos: 'nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near',
  tron: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
  ton: 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR',
} as const;
export type PayFrom = keyof typeof PAY_FROM;

/** USDT is accepted only where NEAR Intents lists it, checked on 5 and 6 Nov 2026. Each still needs a real delivery test. */
export const USDT_ON: Partial<Record<PayFrom, string>> = {
  near: 'nep141:usdt.tether-token.near',
  ethereum: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
  solana: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
  bsc: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
  tron: PAY_FROM.tron,
  ton: PAY_FROM.ton,
};

/** Networks with no USDC route, where a payer always pays in USDT. */
export const USDT_ONLY: ReadonlySet<PayFrom> = new Set<PayFrom>(['tron', 'ton']);

/** Token decimals where they are not six. BNB Chain's USDC and USDT both use eighteen. */
const PAY_DECIMALS: Partial<Record<PayFrom, number>> = { bsc: 18 };
export type PayToken = 'USDC' | 'USDT';

export interface CrossChainRequest {
  payFrom: PayFrom;
  /** Exactly this much USDC must arrive at `recipient` on Base. */
  usdcMinor: number;
  recipient: string;
  refundTo: string;
  deadline: Date;
  /** Paying in something other than USDC. */
  payToken?: PayToken;
  /** Delivering USDC on NEAR rather than Base. */
  toNear?: boolean;
}

export interface CrossChainQuote {
  /** Null for a price check, which reserves nothing. */
  depositAddress: string | null;
  payInMinor: number;
}

export interface SendRequest {
  usdcMinor: number;
  destinationAsset: string;
  /** The delivered token's decimals, which the route's raw amounts are written in. Six when left out. */
  destinationDecimals?: number;
  recipient: string;
  refundTo: string;
  deadline: Date;
  dry: boolean;
}

/** Money coming from another network into a user's own wallet as USDC on Base. */
export interface DepositRequest {
  payFrom: PayFrom;
  payToken: PayToken;
  /** What the user will send, in six decimals. */
  amountMinor: number;
  /** The user's own Base wallet. */
  recipient: string;
  /** The user's own address on the network they pay from. */
  refundTo: string;
  deadline: Date;
}

export interface DepositQuote {
  depositAddress: string;
  /** What should arrive on Base, in USDC's six decimals. */
  receiverMinor: number;
  seconds: number | null;
}

export interface SendQuote {
  depositAddress: string | null;
  receiverMinor: number;
  seconds: number | null;
}

/** A sentence for the user about why a route refused, and nothing from the partner they should not see. */
export function routeProblem(error: unknown, chainName: string): string {
  const text = String((error as Error)?.message ?? '');
  if (/too low/i.test(text)) return `That amount is too small to send to ${chainName}. Nothing was sent. Try at least 0.5 USDC.`;
  if (/trustline/i.test(text)) return `That account on ${chainName} is not set up to receive USDC yet. Nothing was sent.`;
  if (/swap limits/i.test(text)) return `Sending that amount to ${chainName} is limited for the moment. Nothing was sent. Please try again later.`;
  return `Sending to ${chainName} is not available right now. Nothing was sent. Please try again later.`;
}

export type CrossChainStatus = 'waiting' | 'moving' | 'delivered' | 'underpaid' | 'refunded' | 'failed';

export interface CrossChainState {
  status: CrossChainStatus;
  transactions: string[];
  /** The delivery on the other chain, and how much arrived, once known. */
  destinationTx?: string | null;
  receivedMinor?: number | null;
}

/** Moves USDC between chains. Tests and test mode replace it, so nothing here needs real money to run. */
export abstract class CrossChain {
  abstract priceCheck(request: CrossChainRequest): Promise<CrossChainQuote>;
  abstract quote(request: CrossChainRequest): Promise<CrossChainQuote>;
  /** Exactly this much USDC leaves Base, and a little less arrives on the other chain. With dry, it only prices it. */
  abstract sendFromBase(request: SendRequest): Promise<SendQuote>;
  abstract status(depositAddress: string): Promise<CrossChainState>;
  /** True only when NEAR itself says the account does not exist. Any doubt is false, and the route then decides. */
  async nearAccountMissing(_account: string): Promise<boolean> {
    return false;
  }
  /** A one-time address on another network that turns what is sent there into USDC in the user's Base wallet. */
  async depositToBase(_request: DepositRequest): Promise<DepositQuote> {
    throw new Error('Deposits from other networks are not available here');
  }
  /** A sentence when the receiver's account cannot take the token yet, checked before anything is sent. Null when fine or unsure. */
  async recipientProblem(_chain: string, _address: string): Promise<string | null> {
    return null;
  }
}

const STATES: Record<string, CrossChainStatus> = {
  PENDING_DEPOSIT: 'waiting',
  KNOWN_DEPOSIT_TX: 'moving',
  PROCESSING: 'moving',
  SUCCESS: 'delivered',
  INCOMPLETE_DEPOSIT: 'underpaid',
  REFUNDED: 'refunded',
  FAILED: 'failed',
};

/**
 * A raw token amount in USDC's own six decimals, rounded down, so 0.5 USDC on Stellar (5000000 at seven decimals) and
 * 0.5 USDC on BNB Chain (at eighteen) both read as 500000. Null when it is not a whole positive number.
 */
export function inSixDecimals(raw: unknown, decimals: number): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  const value = decimals >= 6 ? BigInt(text) / 10n ** BigInt(decimals - 6) : BigInt(text) * 10n ** BigInt(6 - decimals);
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** Like inSixDecimals, but rounded up: for what someone must pay, where a hair too little would fall short. */
export function inSixDecimalsUp(raw: unknown, decimals: number): number | null {
  if (decimals <= 6) return inSixDecimals(raw, decimals);
  const down = inSixDecimals(raw, decimals);
  if (down === null) return null;
  return BigInt(String(raw)) % 10n ** BigInt(decimals - 6) === 0n ? down : down + 1;
}

/** NEAR Intents' "1.234567" written out, in six decimals. Status replies give this, and it does not need the chain's decimals. */
export function formattedInSixDecimals(formatted: unknown): number | null {
  if (typeof formatted !== 'string' || !/^\d+(\.\d+)?$/.test(formatted)) return null;
  const [whole, fraction = ''] = formatted.split('.');
  const value = BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

const STELLAR_HORIZON = 'https://horizon.stellar.org';
/** Circle's USDC on Stellar, the one NEAR Intents delivers. */
const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const ATTEMPTS = 4;
const BASE_USDC = PAY_FROM.base;
/** Stablecoin to stablecoin, so a small margin. Anything sent above the need comes back less a refund fee. */
const SLIPPAGE_BPS = 10;
/** Sending stablecoins between chains, where a route can move a little before it settles. */
const SEND_SLIPPAGE_BPS = 50;

export class OneClickCrossChain extends CrossChain {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly waitMs = 1500,
    private readonly fee: { bps: number; recipient: string | undefined } = { bps: 0, recipient: undefined },
    private readonly nearRpcUrl: string = 'https://rpc.mainnet.near.org',
  ) {
    super();
  }

  override async nearAccountMissing(account: string): Promise<boolean> {
    // A 64-character account can receive before it has ever been used, so it is never missing.
    if (/^[0-9a-f]{64}$/.test(account)) return false;
    try {
      const response = await this.fetchFn(this.nearRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
        // The public NEAR server can take several seconds.
        signal: AbortSignal.timeout(8000),
      });
      const answer = (await response.json()) as { error?: { cause?: { name?: string } }; result?: { error?: string } };
      return answer.error?.cause?.name === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(answer.result?.error ?? '');
    } catch {
      return false;
    }
  }

  /**
   * Stellar only takes USDC into an account that exists and has chosen to hold Circle's USDC (a trustline). Without
   * one the delivery fails and comes back less fees, so it is caught first. Any doubt lets the route decide.
   */
  override async recipientProblem(chain: string, address: string): Promise<string | null> {
    if (chain !== 'stellar') return null;
    try {
      const response = await this.fetchFn(`${STELLAR_HORIZON}/accounts/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(8000) });
      if (response.status === 404) return 'That Stellar account has not been opened yet, so it cannot receive USDC. Nothing was sent.';
      if (!response.ok) return null;
      const account = (await response.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
      const holdsUsdc = (account.balances ?? []).some((line) => line.asset_code === 'USDC' && line.asset_issuer === STELLAR_USDC_ISSUER);
      return holdsUsdc ? null : 'That Stellar account has not added USDC yet. They need to add USDC (a trustline) in their wallet first. Nothing was sent.';
    } catch {
      return null;
    }
  }

  priceCheck(request: CrossChainRequest): Promise<CrossChainQuote> {
    return this.ask(request, true);
  }

  /**
   * Exact input: what the user sends is converted, and anything above the amount is converted too. Less than the
   * amount, or too late, goes back to their refund address on that network.
   */
  override async depositToBase(request: DepositRequest): Promise<DepositQuote> {
    const decimals = PAY_DECIMALS[request.payFrom] ?? 6;
    const origin = request.payToken === 'USDT' ? USDT_ON[request.payFrom] : PAY_FROM[request.payFrom];
    if (!origin) throw new Error('That token cannot be sent from there');
    const answer = await this.call<{ quote?: { depositAddress?: string; amountOut?: string; timeEstimate?: number } }>('POST', '/v0/quote', {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: SEND_SLIPPAGE_BPS,
      originAsset: origin,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: BASE_USDC,
      amount: (BigInt(request.amountMinor) * 10n ** BigInt(Math.max(0, decimals - 6))).toString(),
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline.toISOString(),
    });
    const receiverMinor = inSixDecimals(answer.quote?.amountOut, 6);
    if (receiverMinor === null || !answer.quote?.depositAddress) throw new Error('NEAR Intents gave an unusable quote');
    return { depositAddress: answer.quote.depositAddress, receiverMinor, seconds: answer.quote.timeEstimate ?? null };
  }

  quote(request: CrossChainRequest): Promise<CrossChainQuote> {
    return this.ask(request, false);
  }

  async sendFromBase(request: SendRequest): Promise<SendQuote> {
    const answer = await this.call<{ quote?: { depositAddress?: string; amountOut?: string; timeEstimate?: number } }>('POST', '/v0/quote', {
      dry: request.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: SEND_SLIPPAGE_BPS,
      originAsset: PAY_FROM.base,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: request.destinationAsset,
      amount: String(request.usdcMinor),
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline.toISOString(),
    });
    const receiverMinor = inSixDecimals(answer.quote?.amountOut, request.destinationDecimals ?? 6);
    if (receiverMinor === null || receiverMinor > request.usdcMinor) throw new Error('NEAR Intents gave an unusable amount');
    if (!request.dry && !answer.quote?.depositAddress) throw new Error('NEAR Intents gave no deposit address');
    return { depositAddress: answer.quote?.depositAddress ?? null, receiverMinor, seconds: answer.quote?.timeEstimate ?? null };
  }

  async status(depositAddress: string): Promise<CrossChainState> {
    const answer = await this.call<{ status?: string; swapDetails?: Record<string, unknown> }>(
      'GET',
      `/v0/status?${new URLSearchParams({ depositAddress }).toString()}`,
    );
    const status = STATES[String(answer.status)];
    if (!status) throw new Error(`Unknown NEAR Intents status: ${String(answer.status).slice(0, 40)}`);
    const details = answer.swapDetails ?? {};
    const hashes = (name: string) => (Array.isArray(details[name]) ? (details[name] as unknown[]).map((item) => hashOf(item)) : []);
    // The formatted figure is already in whole tokens, so it reads the same at any number of decimals.
    const raw = Number(details.amountOut);
    const received = formattedInSixDecimals(details.amountOutFormatted) ?? (Number.isSafeInteger(raw) && raw > 0 ? raw : null);
    return {
      status,
      transactions: [...hashes('originChainTxHashes'), ...hashes('nearTxHashes'), ...hashes('destinationChainTxHashes')].filter(Boolean),
      destinationTx: hashes('destinationChainTxHashes').filter(Boolean).at(-1) ?? null,
      receivedMinor: received,
    };
  }

  private async ask(request: CrossChainRequest, dry: boolean): Promise<CrossChainQuote> {
    const answer = await this.call<{ quote?: { depositAddress?: string; amountIn?: string; amountOut?: string } }>('POST', '/v0/quote', {
      dry,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: SLIPPAGE_BPS,
      originAsset: request.payToken === 'USDT' ? USDT_ON[request.payFrom] : PAY_FROM[request.payFrom],
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: request.toNear ? PAY_FROM.near : BASE_USDC,
      amount: String(request.usdcMinor),
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline.toISOString(),
      ...(this.fee.bps > 0 && this.fee.recipient ? { appFees: [{ recipient: this.fee.recipient, fee: this.fee.bps }] } : {}),
    });
    // Rounded up into six decimals, so a payer who sends what is shown never sends too little.
    const payInMinor = inSixDecimalsUp(answer.quote?.amountIn, PAY_DECIMALS[request.payFrom] ?? 6);
    if (payInMinor === null || payInMinor < request.usdcMinor) throw new Error('NEAR Intents gave an unusable amount');
    // It must deliver at least what the bank partner is waiting for, or the payout would never start.
    if (answer.quote?.amountOut !== undefined && Number(answer.quote.amountOut) < request.usdcMinor) throw new Error('NEAR Intents would deliver too little');
    if (!dry && !answer.quote?.depositAddress) throw new Error('NEAR Intents gave no deposit address');
    return { depositAddress: answer.quote?.depositAddress ?? null, payInMinor };
  }

  /** Its server errors and dropped connections usually pass on a retry: seen in the first tests against it. */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let failure: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.waitMs));
      try {
        const response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await response.text();
        if (response.ok) return JSON.parse(text) as T;
        const problem = new Error(`NEAR Intents answered ${response.status}: ${text.slice(0, 200)}`);
        // A plain refusal stays a refusal. It also reports some server faults as a 400.
        if (response.status < 500 && !/internal server error/i.test(text)) return Promise.reject(problem);
        failure = problem;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }
}

function hashOf(item: unknown): string {
  if (typeof item === 'string') return item;
  const hash = (item as { hash?: unknown } | null)?.hash;
  return typeof hash === 'string' ? hash : '';
}

/** Test mode: the same steps with no chain and no money, so anyone can try the API without keys. */
export class SimulatedCrossChain extends CrossChain {
  private readonly checks = new Map<string, number>();

  async priceCheck(request: CrossChainRequest): Promise<CrossChainQuote> {
    return { depositAddress: null, payInMinor: Math.ceil(request.usdcMinor * 1.002) };
  }

  async quote(request: CrossChainRequest): Promise<CrossChainQuote> {
    const depositAddress = `0x${randomBytes(20).toString('hex')}`;
    this.checks.set(depositAddress, 0);
    return { depositAddress, payInMinor: Math.ceil(request.usdcMinor * 1.002) };
  }

  async sendFromBase(request: SendRequest): Promise<SendQuote> {
    const depositAddress = request.dry ? null : `0x${randomBytes(20).toString('hex')}`;
    if (depositAddress) this.checks.set(depositAddress, 0);
    return { depositAddress, receiverMinor: Math.floor(request.usdcMinor * 0.998), seconds: 40 };
  }

  override async depositToBase(request: DepositRequest): Promise<DepositQuote> {
    const depositAddress = `0x${randomBytes(20).toString('hex')}`;
    this.checks.set(depositAddress, 0);
    return { depositAddress, receiverMinor: Math.floor(request.amountMinor * 0.995), seconds: 60 };
  }

  /** Waiting on the first check, delivered from the second. */
  async status(depositAddress: string): Promise<CrossChainState> {
    const seen = this.checks.get(depositAddress) ?? 1;
    this.checks.set(depositAddress, seen + 1);
    return seen === 0 ? { status: 'waiting', transactions: [] } : { status: 'delivered', transactions: ['simulated'] };
  }
}
