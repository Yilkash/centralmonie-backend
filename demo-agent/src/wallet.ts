import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';

/** Sends USDC. The agent's model never sees the key, and only code calls this. */
export interface Wallet {
  sendUsdc(to: string, usdcMinor: number): Promise<void>;
}

const USDC_ON_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** What the USDC contract charges to register an account, from its storage_balance_bounds. */
const REGISTRATION_YOCTO = 1_250_000_000_000_000_000_000n;

export class NearWallet implements Wallet {
  private readonly account: Account;
  private readonly provider: JsonRpcProvider;

  constructor(accountId: string, privateKey: string, rpcUrl = 'https://rpc.mainnet.near.org') {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.account = new Account(accountId, this.provider, privateKey as `ed25519:${string}`);
  }

  async sendUsdc(to: string, usdcMinor: number): Promise<void> {
    // A NEAR account must be registered with a token before it can hold it.
    const registered = await this.provider.callFunction({ contractId: USDC_ON_NEAR, method: 'storage_balance_of', args: { account_id: to } });
    if (!registered) {
      await this.account.callFunction({ contractId: USDC_ON_NEAR, methodName: 'storage_deposit', args: { account_id: to, registration_only: true }, gas: teraToGas('30'), deposit: REGISTRATION_YOCTO });
    }
    await this.account.callFunction({ contractId: USDC_ON_NEAR, methodName: 'ft_transfer', args: { receiver_id: to, amount: String(usdcMinor) }, gas: teraToGas('30'), deposit: 1n });
  }
}

/** Test mode: moves nothing. */
export class SimulatedWallet implements Wallet {
  sent: { to: string; usdcMinor: number }[] = [];

  async sendUsdc(to: string, usdcMinor: number): Promise<void> {
    this.sent.push({ to, usdcMinor });
  }
}
