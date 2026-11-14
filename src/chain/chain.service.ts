import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Env } from '../config/env';
import { blockRanges, erc20Abi, managerAbi, smartWalletAbi, SpendPermission, SPEND_PERMISSION_MANAGER, Transfer, TxOutcome, WalletCall } from './chain';

/** The contract refused the spend in a dry run, so no transaction was sent and nothing moved. */
export class SpendRefused extends Error {}

const NETWORK_NAMES: Record<number, string> = { 8453: 'Base', 84532: 'Base Sepolia (test network)' };

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
  /**
   * One transaction: take from the user's wallet and pass it on. If either fails, neither happens.
   * SpendRefused means nothing was sent. Any other error means it may have gone out, so never retry on that.
   * onSent runs as soon as the hash is known, before waiting for the result.
   */
  abstract spendAndForward(permission: SpendPermission, usdcMinor: number, to: string, onSent?: (hash: string) => Promise<void>): Promise<string>;
  abstract usdcAddress(): string;
  /** The network's name as a person would say it. Taken from the chain the money really moves on. */
  abstract networkName(): string;
  /** Whether an address has any history on this network. Says nothing about who owns it. */
  abstract addressActivity(address: string): Promise<'used' | 'contract' | 'new'>;
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
  private readonly bundlerUrl: string | undefined;
  private serverAccount: Promise<Address> | undefined;

  private rpcUrls(): string[] {
    return this.rpcUrl.split(',').map((url) => url.trim()).filter(Boolean);
  }

  /** Free public nodes refuse when busy (429), so with several URLs each request moves on to the next. */
  private transport() {
    const urls = this.rpcUrls();
    if (urls.length === 1) return http(urls[0], { retryCount: 3, timeout: 20000 });
    return fallback(urls.map((url) => http(url, { retryCount: 1, timeout: 15000 })), { retryCount: 2 });
  }

  constructor(config: ConfigService<Env, true>) {
    super();
    this.rpcUrl = config.get('CHAIN_RPC_URL', { infer: true });
    this.usdc = config.get('USDC_ADDRESS', { infer: true }) as Address;
    this.collectionKey = config.get('COLLECTION_KEY', { infer: true });
    this.serverKey = config.get('SERVER_OWNER_KEY', { infer: true });
    this.bundlerUrl = config.get('SERVER_BUNDLER_URL', { infer: true });
    this.chainDef = defineChain({
      id: config.get('CHAIN_ID', { infer: true }),
      name: 'configured',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: this.rpcUrls() } },
    });
    this.client = createPublicClient({ chain: this.chainDef, transport: this.transport() });
  }

  usdcAddress(): string {
    return this.usdc;
  }

  networkName(): string {
    return NETWORK_NAMES[this.chainDef.id] ?? `Network ${this.chainDef.id}`;
  }

  async addressActivity(address: string): Promise<'used' | 'contract' | 'new'> {
    const target = address as Address;
    const [code, sent, eth, usdc] = await Promise.all([
      this.client.getCode({ address: target }),
      this.client.getTransactionCount({ address: target }),
      this.client.getBalance({ address: target }),
      this.usdcBalance(target),
    ]);
    if (code) return 'contract';
    return sent > 0 || eth > 0n || usdc > 0n ? 'used' : 'new';
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
    const found: Transfer[] = [];
    // toBlock - fromBlock must stay under the limit, so each piece is one block short of it.
    for (const [start, end] of blockRanges(fromBlock, toBlock, 199)) {
      const logs = await this.client.getContractEvents({
        address: this.usdc,
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: filter.from as Address[] | undefined, to: filter.to as Address[] | undefined },
        fromBlock: BigInt(start),
        toBlock: BigInt(end),
      });
      found.push(...logs.map((log) => this.toTransfer(log)));
    }
    return found;
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
    return createWalletClient({ account: privateKeyToAccount(key as Hex), chain: this.chainDef, transport: this.transport() });
  }

  async sendFromCollection(to: string, usdcMinor: number): Promise<string | null> {
    if (!this.collectionKey) return null;
    const wallet = this.wallet(this.collectionKey);
    const hash = await wallet.writeContract({ address: this.usdc, abi: erc20Abi, functionName: 'transfer', args: [to as Address, BigInt(usdcMinor)] });
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (receipt.status !== 'success') throw new Error('The refund reverted');
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
    // Through a bundler, the first operation deploys it, so the owner key never needs ETH.
    if (!this.bundlerUrl && !(await this.client.getCode({ address: account.address }))) {
      const { factory, factoryData } = await account.getFactoryArgs();
      const hash = await this.wallet(this.serverKey!).sendTransaction({ to: factory!, data: factoryData! });
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (receipt.status !== 'success') throw new Error('The server account could not be deployed');
      this.logger.log(`Server account deployed at ${account.address}`);
    }
    return account.address;
  }

  async spendAndForward(permission: SpendPermission, usdcMinor: number, to: string, onSent?: (hash: string) => Promise<void>): Promise<string> {
    if (!this.serverKey) throw new Error('No server key is set');
    if (this.bundlerUrl) return this.spendThroughBundler(this.bundlerUrl, permission, usdcMinor, to, onSent);
    const account = await this.ensureServerAccount();
    const value = BigInt(usdcMinor);
    // The owner key calls the account directly and pays gas in ETH. Both steps run in one transaction.
    const request = {
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
    } as const;
    // A dry run first, because a refusal here is certain to have moved nothing. After this, doubt means stop.
    const owner = privateKeyToAccount(this.serverKey as Hex);
    try {
      await this.client.simulateContract({ ...request, account: owner });
    } catch (error) {
      if ((error as Error).name === 'ContractFunctionExecutionError') throw new SpendRefused('The wallet permission refused it');
      throw error;
    }
    const hash = await this.wallet(this.serverKey).writeContract(request);
    await onSent?.(hash);
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (receipt.status !== 'success') throw new SpendRefused('The spend transaction reverted');
    return hash;
  }

  /**
   * The same one transaction, sent as a user operation so a paymaster pays the gas. Everything before
   * the send is certain to have moved nothing. From the send onwards, doubt means stop and never resend.
   */
  private async spendThroughBundler(url: string, permission: SpendPermission, usdcMinor: number, to: string, onSent?: (hash: string) => Promise<void>): Promise<string> {
    const { createBundlerClient, toCoinbaseSmartAccount } = await import('viem/account-abstraction');
    const value = BigInt(usdcMinor);
    const account = await toCoinbaseSmartAccount({ client: this.client, owners: [privateKeyToAccount(this.serverKey as Hex)], version: '1.1' });
    const bundler = createBundlerClient({ account, client: this.client, transport: http(url), paymaster: true });

    let signed;
    try {
      await this.client.simulateContract({
        address: SPEND_PERMISSION_MANAGER,
        abi: managerAbi,
        functionName: 'spend',
        args: [toContractPermission(permission), value],
        account: account.address,
      });
      const prepared = await bundler.prepareUserOperation({
        calls: [
          { to: SPEND_PERMISSION_MANAGER, data: encodeFunctionData({ abi: managerAbi, functionName: 'spend', args: [toContractPermission(permission), value] }) },
          { to: this.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, value] }) },
        ],
      });
      signed = { ...prepared, signature: await account.signUserOperation(prepared) };
    } catch (error) {
      // The name only: a bundler's error can carry its URL, and that holds a key.
      this.logger.warn(`Could not prepare a scheduled payment: ${(error as Error).name}`);
      throw new SpendRefused('The payment could not be prepared');
    }

    const operation = await bundler.sendUserOperation(signed as Parameters<typeof bundler.sendUserOperation>[0]);
    this.logger.log(`Scheduled payment sent as operation ${operation}`);
    const receipt = await bundler.waitForUserOperationReceipt({ hash: operation, timeout: 120000 });
    const hash = receipt.receipt.transactionHash;
    await onSent?.(hash);
    // The batch stands or falls together, so a failed operation moved nothing.
    if (!receipt.success) throw new SpendRefused('The spend operation reverted');
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
