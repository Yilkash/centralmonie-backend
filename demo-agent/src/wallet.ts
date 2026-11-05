import { Account, actions, encodeSignedDelegate, JsonRpcProvider, teraToGas } from 'near-api-js';

/** Sends USDC. The agent's model never sees the key, and only code calls this. */
export interface Wallet {
  /** Returns the transaction hash when it is known. */
  sendUsdc(to: string, usdcMinor: number, paymentId?: string): Promise<string | null>;
}

const USDC_ON_NEAR: string = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** What the USDC contract charges to register an account, from its storage_balance_bounds. */
const REGISTRATION_YOCTO = 1_250_000_000_000_000_000_000n;

export class NearWallet implements Wallet {
  private readonly account: Account;
  private readonly provider: JsonRpcProvider;

  constructor(accountId: string, privateKey: string, rpcUrl = 'https://rpc.mainnet.near.org') {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.account = new Account(accountId, this.provider, privateKey as `ed25519:${string}`);
  }

  async sendUsdc(to: string, usdcMinor: number): Promise<string | null> {
    // A NEAR account must be registered with a token before it can hold it.
    const registered = await this.provider.callFunction({ contractId: USDC_ON_NEAR, method: 'storage_balance_of', args: { account_id: to } });
    if (!registered) {
      await this.account.callFunction({ contractId: USDC_ON_NEAR, methodName: 'storage_deposit', args: { account_id: to, registration_only: true }, gas: teraToGas('30'), deposit: REGISTRATION_YOCTO });
    }
    const sent = await this.account.callFunctionRaw({ contractId: USDC_ON_NEAR, methodName: 'ft_transfer', args: { receiver_id: to, amount: String(usdcMinor) }, gas: teraToGas('30'), deposit: 1n });
    return sent.transaction_outcome?.id ?? null;
  }
}

/** Signs the transfer only. 10kobo's relayer sends it and pays the gas, so this wallet needs USDC and no NEAR. */
export class GaslessNearWallet implements Wallet {
  private readonly account: Account;
  private readonly baseUrl: string;
  private readonly key: string | undefined;

  constructor(options: { accountId: string; privateKey: string; baseUrl: string; key?: string | undefined; rpcUrl?: string }) {
    this.account = new Account(options.accountId, new JsonRpcProvider({ url: options.rpcUrl ?? 'https://rpc.mainnet.near.org' }), options.privateKey as `ed25519:${string}`);
    this.baseUrl = options.baseUrl;
    this.key = options.key;
  }

  async sendUsdc(to: string, usdcMinor: number, paymentId?: string): Promise<string | null> {
    if (!paymentId) throw new Error('Gas-free sending needs the payment');
    const { signedDelegate } = await this.account.createSignedMetaTransaction({
      receiverId: USDC_ON_NEAR,
      actions: [actions.functionCall('ft_transfer', { receiver_id: to, amount: String(usdcMinor) }, teraToGas('30'), 1n)],
      blockHeightTtl: 200,
    });
    const response = await fetch(`${this.baseUrl}/v1/agent/x402/pay/${encodeURIComponent(paymentId)}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ signed_delegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as { code?: string; message?: string; transactions?: string[] };
    if (body.code) throw new Error(`${body.code}: ${body.message}`);
    return body.transactions?.[0] ?? null;
  }
}

/** Test mode: moves nothing. */
export class SimulatedWallet implements Wallet {
  sent: { to: string; usdcMinor: number }[] = [];

  async sendUsdc(to: string, usdcMinor: number): Promise<string | null> {
    this.sent.push({ to, usdcMinor });
    return 'simulated';
  }
}
