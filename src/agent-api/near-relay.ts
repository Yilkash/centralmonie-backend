import { AgentPayment } from '../database/schema';

export const USDC_ON_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const MAX_GAS = 50_000_000_000_000n;

/** What an agent signed, in plain form. Signing costs it nothing, and only the relayer can put it on the chain. */
export interface SignedDelegate {
  senderId: string;
  receiverId: string;
  actions: { method: string | null; args: string; deposit: bigint; gas: bigint }[];
}

/**
 * Sends an agent's signed USDC transfer and pays its gas. Tests and test mode replace it. Null relayer settings
 * mean none is available, and agents pay their own gas.
 */
export abstract class NearRelayer {
  abstract decode(signedDelegateBase64: string): SignedDelegate;
  /** An account must be registered with the USDC contract before it can receive USDC. */
  abstract ensureRegistered(account: string): Promise<void>;
  abstract send(signedDelegateBase64: string): Promise<string | null>;
}

/**
 * Why the relayer must not pay for this, or null. It pays for exactly one thing: moving the USDC this payment
 * asked for, from the agent, to this payment's own deposit address. Anything else could drain its NEAR.
 */
export function relayProblem(delegate: SignedDelegate, payment: AgentPayment): string | null {
  if (payment.payFrom !== 'near') return 'Only a payment from NEAR can use the relayer.';
  if (payment.status !== 'awaiting_deposit' || !payment.depositAddress) return 'This payment is not waiting for money.';
  if (delegate.senderId !== payment.refundTo) return 'This must be signed by the refund account given in the quote.';
  if (delegate.receiverId !== USDC_ON_NEAR) return 'The relayer only pays for USDC transfers.';
  if (delegate.actions.length !== 1) return 'The relayer only pays for a single transfer.';
  const [action] = delegate.actions;
  if (action!.method !== 'ft_transfer') return 'The relayer only pays for USDC transfers.';
  if (action!.deposit !== 1n) return 'A USDC transfer attaches exactly one yoctoNEAR.';
  if (action!.gas > MAX_GAS) return 'That asks for too much gas.';
  let args: { receiver_id?: unknown; amount?: unknown };
  try {
    args = JSON.parse(action!.args) as { receiver_id?: unknown; amount?: unknown };
  } catch {
    return 'The transfer details could not be read.';
  }
  if (args.receiver_id !== payment.depositAddress) return "The transfer must go to this payment's deposit address.";
  if (args.amount !== String(payment.payInMinor)) return `The transfer must be exactly ${payment.payInMinor} in USDC units.`;
  return null;
}

/** Loaded when first used, so nothing else depends on it, and tests never touch the network. */
export class LiveNearRelayer extends NearRelayer {
  private readonly accountId: string;
  private readonly privateKey: string;
  private readonly rpcUrl: string;
  private loaded?: { near: Record<string, any>; borsh: { deserialize: (schema: unknown, bytes: Uint8Array) => any }; account: any; provider: any };

  constructor(accountId: string, privateKey: string, rpcUrl: string) {
    super();
    this.accountId = accountId;
    this.privateKey = privateKey;
    this.rpcUrl = rpcUrl;
  }

  private load() {
    if (!this.loaded) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const near = require('near-api-js') as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const borsh = require('borsh') as { deserialize: (schema: unknown, bytes: Uint8Array) => any };
      const provider = new near.JsonRpcProvider({ url: this.rpcUrl });
      this.loaded = { near, borsh, provider, account: new near.Account(this.accountId, provider, this.privateKey) };
    }
    return this.loaded;
  }

  private raw(signedDelegateBase64: string) {
    const { near, borsh } = this.load();
    return borsh.deserialize(near.SCHEMA.SignedDelegate, Buffer.from(signedDelegateBase64, 'base64'));
  }

  decode(signedDelegateBase64: string): SignedDelegate {
    const { delegateAction } = this.raw(signedDelegateBase64);
    return {
      senderId: delegateAction.senderId,
      receiverId: delegateAction.receiverId,
      actions: delegateAction.actions.map((item: any) => {
        const call = item.functionCall;
        return call
          ? { method: call.methodName as string, args: Buffer.from(call.args).toString('utf8'), deposit: BigInt(call.deposit), gas: BigInt(call.gas) }
          : { method: null, args: '', deposit: 0n, gas: 0n };
      }),
    };
  }

  async ensureRegistered(account: string): Promise<void> {
    const { near, provider, account: relayer } = this.load();
    if (await provider.callFunction({ contractId: USDC_ON_NEAR, method: 'storage_balance_of', args: { account_id: account } })) return;
    await relayer.callFunction({ contractId: USDC_ON_NEAR, methodName: 'storage_deposit', args: { account_id: account, registration_only: true }, gas: near.teraToGas('30'), deposit: 1_250_000_000_000_000_000_000n });
  }

  async send(signedDelegateBase64: string): Promise<string | null> {
    const outcome = await this.load().account.relayMetaTransaction(this.raw(signedDelegateBase64));
    return outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? null;
  }
}
