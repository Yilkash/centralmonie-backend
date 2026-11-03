import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Env } from '../config/env';
import { erc20Abi, managerAbi, smartWalletAbi, SpendPermission, SPEND_PERMISSION_MANAGER, Transfer, TxOutcome, WalletCall } from './chain';

/** Everything the app reads from or sends to the blockchain, so tests and later networks can replace it. */
export abstract class Chain {
  abstract usdcBalance(address: string): Promise<bigint>;
  abstract latestBlock(): Promise<number>;
  abstract outcome(txHash: string): Promise<TxOutcome>;
  /** USDC transfers in a block range, filtered by sender or receiver. */
  abstract transfers(filter: { from?: string[]; to?: string[] }, fromBlock: number, toBlock: number): Promise<Transfer[]>;
  /** Sends USDC out of the collection address. Null if no collection key is set. */
  abstract sendFromCollection(to: string, usdcMinor: number): Promise<string | null>;
  abstract managerIsOwner(wallet: string): Promise<boolean>;
  abstract permissionActive(permission: SpendPermission): Promise<boolean>;
  /** The address that spends permissions, or null if no server key is set. */
  abstract spender(): Promise<string | null>;
  /** One transaction: take from the user's wallet and pass it on. If either fails, neither happens. */
  abstract spendAndForward(permission: SpendPermission, usdcMinor: number, to: string): Promise<string>;
  abstract usdcAddress(): string;
}

@Injectable()
export class ViemChain extends Chain {
  private readonly logger = new Logger(ViemChain.name);
  private readonly usdc: Address;
  private readonly client;
  private readonly chainDef;
  private readonly rpcUrl: string;
  private readonly collectionKey: string | undefined;
  private readonly serverKey: string | undefined;
  private serverAccount: Promise<Address> | undefined;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.rpcUrl = config.get('CHAIN_RPC_URL', { infer: true });
    this.usdc = config.get('USDC_ADDRESS', { infer: true }) as Address;
    this.collectionKey = config.get('COLLECTION_KEY', { infer: true });
    this.serverKey = config.get('SERVER_OWNER_KEY', { infer: true });
    this.chainDef = defineChain({
      id: config.get('CHAIN_ID', { infer: true }),
      name: 'configured',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    });
    this.client = createPublicClient({ chain: this.chainDef, transport: http(this.rpcUrl, { retryCount: 3, timeout: 20000 }) });
  }

  usdcAddress(): string {
    return this.usdc;
  }

  usdcBalance(address: string): Promise<bigint> {
    return this.client.readContract({ address: this.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address as Address] });
  }

  async latestBlock(): Promise<number> {
    return Number(await this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async outcome(txHash: string): Promise<TxOutcome> {
    const receipt = await this.client.getTransactionReceipt({ hash: txHash as Hash }).catch((error: Error) => {
      if (error.name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    });
    if (!receipt) return { state: 'pending' };
    if (receipt.status !== 'success') return { state: 'reverted' };
    const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.usdc.toLowerCase()) });
    return { state: 'success', transfers: logs.map((log) => this.toTransfer(log)) };
  }

  async transfers(filter: { from?: string[]; to?: string[] }, fromBlock: number, toBlock: number): Promise<Transfer[]> {
    const logs = await this.client.getContractEvents({
      address: this.usdc,
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: filter.from as Address[] | undefined, to: filter.to as Address[] | undefined },
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
    return logs.map((log) => this.toTransfer(log));
  }

  private toTransfer(log: { transactionHash: Hash; logIndex: number; blockNumber: bigint; args: { from?: Address; to?: Address; value?: bigint } }): Transfer {
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      block: Number(log.blockNumber),
      from: log.args.from!,
      to: log.args.to!,
      value: log.args.value!,
    };
  }

  private wallet(key: string) {
    return createWalletClient({ account: privateKeyToAccount(key as Hex), chain: this.chainDef, transport: http(this.rpcUrl, { retryCount: 3, timeout: 20000 }) });
  }

  async sendFromCollection(to: string, usdcMinor: number): Promise<string | null> {
    if (!this.collectionKey) return null;
    const wallet = this.wallet(this.collectionKey);
    const hash = await wallet.writeContract({ address: this.usdc, abi: erc20Abi, functionName: 'transfer', args: [to as Address, BigInt(usdcMinor)] });
    await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
    return hash;
  }

  async managerIsOwner(wallet: string): Promise<boolean> {
    // A wallet that has never sent a transaction is not deployed yet, so it has no owners to read.
    const code = await this.client.getCode({ address: wallet as Address });
    if (!code) return false;
    return this.client.readContract({ address: wallet as Address, abi: smartWalletAbi, functionName: 'isOwnerAddress', args: [SPEND_PERMISSION_MANAGER] });
  }

  async permissionActive(permission: SpendPermission): Promise<boolean> {
    const args = [toContractPermission(permission)] as const;
    const [approved, valid] = await Promise.all([
      this.client.readContract({ address: SPEND_PERMISSION_MANAGER, abi: managerAbi, functionName: 'isApproved', args }),
      this.client.readContract({ address: SPEND_PERMISSION_MANAGER, abi: managerAbi, functionName: 'isValid', args }),
    ]);
    return approved && valid;
  }

  async spender(): Promise<string | null> {
    if (!this.serverKey) return null;
    return this.ensureServerAccount();
  }

  /** The server's smart account: its owner key can be swapped later without any user approving again. */
  private ensureServerAccount(): Promise<Address> {
    this.serverAccount ??= this.deployServerAccount().catch((error: unknown) => {
      this.serverAccount = undefined;
      throw error;
    });
    return this.serverAccount;
  }

  private async deployServerAccount(): Promise<Address> {
    const { toCoinbaseSmartAccount } = await import('viem/account-abstraction');
    const owner = privateKeyToAccount(this.serverKey as Hex);
    const account = await toCoinbaseSmartAccount({ client: this.client, owners: [owner], version: '1.1' });
    if (!(await this.client.getCode({ address: account.address }))) {
      const { factory, factoryData } = await account.getFactoryArgs();
      const hash = await this.wallet(this.serverKey!).sendTransaction({ to: factory!, data: factoryData! });
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (receipt.status !== 'success') throw new Error('The server account could not be deployed');
      this.logger.log(`Server account deployed at ${account.address}`);
    }
    return account.address;
  }

  async spendAndForward(permission: SpendPermission, usdcMinor: number, to: string): Promise<string> {
    if (!this.serverKey) throw new Error('No server key is set');
    const account = await this.ensureServerAccount();
    const value = BigInt(usdcMinor);
    // The owner key calls the account directly and pays gas in ETH. Both steps run in one transaction.
    const hash = await this.wallet(this.serverKey).writeContract({
      address: account,
      abi: smartWalletAbi,
      functionName: 'executeBatch',
      args: [
        [
          {
            target: SPEND_PERMISSION_MANAGER,
            value: 0n,
            data: encodeFunctionData({ abi: managerAbi, functionName: 'spend', args: [toContractPermission(permission), value] }),
          },
          {
            target: this.usdc,
            value: 0n,
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, value] }),
          },
        ],
      ],
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (receipt.status !== 'success') throw new Error('The spend transaction reverted');
    return hash;
  }
}

export function toContractPermission(permission: SpendPermission) {
  return {
    account: permission.account as Address,
    spender: permission.spender as Address,
    token: permission.token as Address,
    allowance: BigInt(permission.allowance),
    period: permission.period,
    start: permission.start,
    end: permission.end,
    salt: BigInt(permission.salt),
    extraData: permission.extraData as Hex,
  };
}

export const usdcTransferCall = (usdc: string, to: string, usdcMinor: number): WalletCall => ({
  to: usdc,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, BigInt(usdcMinor)] }),
});

export const addManagerOwnerCall = (wallet: string): WalletCall => ({
  to: wallet,
  data: encodeFunctionData({ abi: smartWalletAbi, functionName: 'addOwnerAddress', args: [SPEND_PERMISSION_MANAGER] }),
});

export const approvePermissionCall = (permission: SpendPermission): WalletCall => ({
  to: SPEND_PERMISSION_MANAGER,
  data: encodeFunctionData({ abi: managerAbi, functionName: 'approve', args: [toContractPermission(permission)] }),
});

export const revokePermissionCall = (permission: SpendPermission): WalletCall => ({
  to: SPEND_PERMISSION_MANAGER,
  data: encodeFunctionData({ abi: managerAbi, functionName: 'revoke', args: [toContractPermission(permission)] }),
});
