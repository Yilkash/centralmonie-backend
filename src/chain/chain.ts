import { parseAbi, type Abi } from 'viem';

export const USDC_DECIMALS = 6;
export const SPEND_PERMISSION_MANAGER = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad' as const;

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const permission = [
  { name: 'account', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'allowance', type: 'uint160' },
  { name: 'period', type: 'uint48' },
  { name: 'start', type: 'uint48' },
  { name: 'end', type: 'uint48' },
  { name: 'salt', type: 'uint256' },
  { name: 'extraData', type: 'bytes' },
] as const;
const permissionInput = { name: 'spendPermission', type: 'tuple', components: permission } as const;

export const managerAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [permissionInput], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [permissionInput], outputs: [] },
  { type: 'function', name: 'spend', stateMutability: 'nonpayable', inputs: [permissionInput, { name: 'value', type: 'uint160' }], outputs: [] },
  { type: 'function', name: 'isApproved', stateMutability: 'view', inputs: [permissionInput], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isValid', stateMutability: 'view', inputs: [permissionInput], outputs: [{ type: 'bool' }] },
] as const satisfies Abi;

export const smartWalletAbi = [
  { type: 'function', name: 'addOwnerAddress', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'isOwnerAddress', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** The exact permission a user approves. Stored as strings, because JSON has no big integers. */
export interface SpendPermission {
  account: string;
  spender: string;
  token: string;
  allowance: string;
  period: number;
  start: number;
  end: number;
  salt: string;
  extraData: string;
}

export interface WalletCall {
  to: string;
  data: string;
}

export interface Transfer {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  block: number;
}

export type TxOutcome = { state: 'pending' } | { state: 'reverted' } | { state: 'success'; transfers: Transfer[] };

/**
 * Pairs each expected payment with its own transfer: right sender, right address, exact amount.
 * One transfer can never satisfy two payments.
 */
export function transfersCover(
  transfers: readonly Pick<Transfer, 'from' | 'to' | 'value'>[],
  wallet: string,
  expected: readonly { address: string; usdcMinor: number }[],
): boolean {
  const left = transfers.filter((transfer) => same(transfer.from, wallet));
  return expected.every((payment) => {
    const index = left.findIndex((transfer) => same(transfer.to, payment.address) && transfer.value === BigInt(payment.usdcMinor));
    if (index === -1) return false;
    left.splice(index, 1);
    return true;
  });
}

/** Splits a block range into pieces a public RPC will answer. Base Sepolia's limit was seen to be 200 blocks. */
export function blockRanges(from: number, to: number, size = 200): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = from; start <= to; start += size) ranges.push([start, Math.min(start + size - 1, to)]);
  return ranges;
}

export const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
