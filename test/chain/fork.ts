import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, pad, parseAbi, publicActions, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toCoinbaseSmartAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { smartWalletAbi } from '../../src/chain/chain';

export const FORK_PORT = 18545;
// A fixed block lets Anvil keep what it fetches on disk, so later runs start fast and do not depend on the network.
const FORK_BLOCK = 53690000;
export const RPC = `http://127.0.0.1:${FORK_PORT}`;
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const SOURCES = ['https://sepolia.base.org', 'https://base-sepolia.drpc.org', 'https://84532.rpc.thirdweb.com'];

// Anvil's published test keys, which hold nothing outside this local copy of the chain.
export const KEYS = {
  user: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  server: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  collection: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  attacker: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
export const test = createTestClient({ chain: baseSepolia, mode: 'anvil', transport: http(RPC) }).extend(publicActions);
export const address = (key: Hex) => privateKeyToAccount(key).address;

/** A local copy of Base Sepolia, with the real USDC and Spend Permission Manager contracts. Nothing here reaches the network. */
export async function startFork(): Promise<ChildProcess> {
  for (const source of SOURCES) {
    const process_ = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--fork-url', source, '--fork-block-number', String(FORK_BLOCK), '--port', String(FORK_PORT), '--silent', '--chain-id', '84532'], { stdio: 'ignore' });
    for (let i = 0; i < 120; i += 1) {
      const ok = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then((r) => r.ok, () => false);
      if (ok) return process_;
      await new Promise((done) => setTimeout(done, 500));
    }
    process_.kill();
  }
  throw new Error('Could not start a fork from any source');
}

/** Sets a USDC balance directly. On this USDC contract, balances live in the mapping at storage slot 9. */
export async function dealUsdc(to: Address, minor: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, 9n]));
  await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(minor), { size: 32 }) });
}

export const usdcBalance = (who: string): Promise<bigint> =>
  client.readContract({ address: USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [who as Address] });

export const eoa = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: baseSepolia, transport: http(RPC) });

/** A real Coinbase Smart Wallet, deployed on the fork, like the one each user gets. */
export async function smartWallet(ownerKey: Hex): Promise<Address> {
  const owner = privateKeyToAccount(ownerKey);
  const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: '1.1' });
  if (!(await client.getCode({ address: account.address }))) {
    const { factory, factoryData } = await account.getFactoryArgs();
    const hash = await eoa(ownerKey).sendTransaction({ to: factory!, data: factoryData! });
    await client.waitForTransactionReceipt({ hash });
  }
  return account.address;
}

/** Sends the calls the app asks for, the way the user's wallet would: one transaction, all or nothing. */
export async function walletSend(ownerKey: Hex, wallet: Address, calls: readonly { to: string; data: string }[], gas?: bigint): Promise<Hex> {
  const hash = await eoa(ownerKey).sendTransaction({
    to: wallet,
    gas,
    data: encodeFunctionData({
      abi: smartWalletAbi,
      functionName: 'executeBatch',
      args: [calls.map((call) => ({ target: call.to as Address, value: 0n, data: call.data as Hex }))],
    }),
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/** The pinned block is older than today, and permissions start from today, so the chain's clock must catch up. */
export async function syncClock(): Promise<void> {
  const block = await test.getBlock();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (block.timestamp < now) {
    await test.setNextBlockTimestamp({ timestamp: now });
    await test.mine({ blocks: 1 });
  }
}
