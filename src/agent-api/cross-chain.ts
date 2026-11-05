import { randomBytes } from 'node:crypto';

/** Where an agent can pay from. Asset ids are from the NEAR Intents token list, checked on 4 Nov 2026. */
export const PAY_FROM = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  near: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  ethereum: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
} as const;
export type PayFrom = keyof typeof PAY_FROM;

/** USDT is accepted only where NEAR Intents lists it, checked on 5 Nov 2026. Each still needs a real delivery test. */
export const USDT_ON: Partial<Record<PayFrom, string>> = {
  near: 'nep141:usdt.tether-token.near',
  ethereum: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
  solana: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
};
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
  recipient: string;
  refundTo: string;
  deadline: Date;
  dry: boolean;
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

  priceCheck(request: CrossChainRequest): Promise<CrossChainQuote> {
    return this.ask(request, true);
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
    const receiverMinor = Number(answer.quote?.amountOut);
    if (!Number.isSafeInteger(receiverMinor) || receiverMinor <= 0 || receiverMinor > request.usdcMinor) throw new Error('NEAR Intents gave an unusable amount');
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
    const received = Number(details.amountOut);
    return {
      status,
      transactions: [...hashes('originChainTxHashes'), ...hashes('nearTxHashes'), ...hashes('destinationChainTxHashes')].filter(Boolean),
      destinationTx: hashes('destinationChainTxHashes').filter(Boolean).at(-1) ?? null,
      receivedMinor: Number.isSafeInteger(received) && received > 0 ? received : null,
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
    const payInMinor = Number(answer.quote?.amountIn);
    if (!Number.isSafeInteger(payInMinor) || payInMinor < request.usdcMinor) throw new Error('NEAR Intents gave an unusable amount');
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

  /** Waiting on the first check, delivered from the second. */
  async status(depositAddress: string): Promise<CrossChainState> {
    const seen = this.checks.get(depositAddress) ?? 1;
    this.checks.set(depositAddress, seen + 1);
    return seen === 0 ? { status: 'waiting', transactions: [] } : { status: 'delivered', transactions: ['simulated'] };
  }
}
