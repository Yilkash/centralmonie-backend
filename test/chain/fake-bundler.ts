import { createServer, type Server } from 'node:http';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint06Abi, entryPoint06Address, getUserOperationHash } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { RPC } from './fork';

type Op = Record<string, Hex>;

/** A small bundler for the fork: a real EntryPoint runs each operation, so the real contracts decide the result. */
export class FakeBundler {
  private server: Server | undefined;
  private readonly sent = new Map<Hash, Hash>();
  refusePaymaster = false;
  refuseSend = false;
  private readonly client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  private readonly wallet;

  constructor(key: Hex, private readonly port: number) {
    this.wallet = createWalletClient({ account: privateKeyToAccount(key), chain: baseSepolia, transport: http(RPC) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let body = '';
      request.on('data', (part) => (body += part));
      request.on('end', async () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        const answer = await this.handle(method, params).then(
          (result) => ({ jsonrpc: '2.0', id, result }),
          (error: Error) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }),
        );
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((done) => this.server!.listen(this.port, '127.0.0.1', done));
  }

  async stop(): Promise<void> {
    await new Promise((done) => this.server?.close(done));
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return `0x${baseSepolia.id.toString(16)}`;
      case 'eth_supportedEntryPoints':
        return [entryPoint06Address];
      case 'pm_getPaymasterStubData':
      case 'pm_getPaymasterData':
        if (this.refusePaymaster) throw new Error('request denied - policy rejected');
        return { paymasterAndData: '0x', isFinal: true };
      case 'eth_estimateUserOperationGas':
        return { preVerificationGas: '0x186a0', verificationGasLimit: '0x7a120', callGasLimit: '0x7a120' };
      case 'eth_sendUserOperation':
        if (this.refuseSend) throw new Error('bundler is having a bad day');
        return this.send(params[0] as Op);
      case 'eth_getUserOperationReceipt':
        return this.receipt(params[0] as Hash);
      default:
        throw new Error(`Not supported: ${method}`);
    }
  }

  private async send(op: Op): Promise<Hash> {
    const operation = {
      sender: op.sender as Address,
      nonce: BigInt(op.nonce!),
      initCode: op.initCode ?? '0x',
      callData: op.callData!,
      callGasLimit: BigInt(op.callGasLimit!),
      verificationGasLimit: BigInt(op.verificationGasLimit!),
      preVerificationGas: BigInt(op.preVerificationGas!),
      maxFeePerGas: BigInt(op.maxFeePerGas!),
      maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas!),
      paymasterAndData: op.paymasterAndData ?? '0x',
      signature: op.signature!,
    } as const;
    const hash = getUserOperationHash({ chainId: baseSepolia.id, entryPointAddress: entryPoint06Address, entryPointVersion: '0.6', userOperation: operation as never });
    const tx = await this.wallet.sendTransaction({
      to: entryPoint06Address,
      gas: 3_000_000n,
      data: encodeFunctionData({ abi: entryPoint06Abi, functionName: 'handleOps', args: [[operation], this.wallet.account.address] }),
    });
    await this.client.waitForTransactionReceipt({ hash: tx });
    this.sent.set(hash, tx);
    return hash;
  }

  private async receipt(hash: Hash): Promise<unknown> {
    const tx = this.sent.get(hash);
    if (!tx) return null;
    const receipt = await this.client.getTransactionReceipt({ hash: tx });
    // A first operation also logs AccountDeployed with the same hash, so the event is picked by its signature.
    const event = receipt.logs.find((log) => log.topics[0]?.startsWith('0x49628fd1') && log.topics[1]?.toLowerCase() === hash.toLowerCase());
    // UserOperationEvent carries (nonce, success, gasCost, gasUsed): success is the second word.
    const success = event ? BigInt(`0x${event.data.slice(66, 130)}`) === 1n : false;
    const hexReceipt = await this.client.request({ method: 'eth_getTransactionReceipt', params: [tx] });
    return { userOpHash: hash, entryPoint: entryPoint06Address, sender: receipt.from, nonce: '0x0', actualGasCost: '0x0', actualGasUsed: '0x0', success, logs: [], receipt: hexReceipt };
  }
}
