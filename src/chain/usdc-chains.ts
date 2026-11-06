import { createHash } from 'node:crypto';
import { isAddress } from 'viem';

/**
 * Where a user can send from their Base wallet. Identifiers and decimals are from the NEAR Intents token list
 * (https://1click.chaindefuser.com/v0/tokens), checked on 5 Nov 2026 for the first seven and 6 Nov 2026 for the rest.
 * Real deliveries: Base, Arbitrum and NEAR. The others have had free quotes only until their first real send.
 */
export type ChainKey =
  | 'base' | 'near' | 'arbitrum' | 'optimism' | 'polygon' | 'avalanche' | 'solana'
  | 'stellar' | 'tron' | 'bsc' | 'ethereum' | 'ton' | 'sui' | 'aptos' | 'gnosis' | 'monad';

export interface UsdcChain {
  key: ChainKey;
  name: string;
  /** NEAR Intents' name for the token delivered on this chain. */
  assetId: string;
  /** What the receiver gets. Tron and TON have no USDC on NEAR Intents, so they get USDT. */
  token: 'USDC' | 'USDT';
  /** The token's decimals on this chain, which NEAR Intents' raw amounts are written in. */
  decimals: number;
  /** The token's own contract or issuer here, which is never a wallet. */
  usdc: string;
  /** Said before the user approves, where the network has a catch. */
  caution?: string;
  aliases: string[];
  /** Where anyone can look up a transaction on this chain. */
  explorerTx: string;
  valid: (address: string) => boolean;
}

/** A named NEAR account, or the 64-character kind. A Base address never matches. */
export function isNearAccount(address: string): boolean {
  return /^[0-9a-f]{64}$/.test(address) || /^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.near$/.test(address);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A Solana address is 32 bytes written in base 58, so a typo usually changes the length. */
export function isSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let value = 0n;
  for (const letter of address) value = value * 58n + BigInt(BASE58.indexOf(letter));
  // Each leading 1 stands for a zero byte, and the rest must make up exactly the remaining bytes.
  const zeros = address.length - address.replace(/^1+/, '').length;
  const hex = value === 0n ? '' : value.toString(16);
  return Math.ceil(hex.length / 2) + zeros === 32;
}

/** Stellar's account address: G, then 55 letters of base 32 holding the key and a checksum. */
export function isStellarAddress(address: string): boolean {
  if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
  const bytes = base32(address);
  if (!bytes || bytes.length !== 35 || bytes[0] !== 6 << 3) return false;
  const sum = crc16(bytes.subarray(0, 33));
  return bytes[33] === (sum & 0xff) && bytes[34] === sum >> 8;
}

/** Tron's address: T, then base 58 holding 0x41, 20 bytes and a 4-byte checksum. */
export function isTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  let value = 0n;
  for (const letter of address) value = value * 58n + BigInt(BASE58.indexOf(letter));
  const bytes = Buffer.from(value.toString(16).padStart(50, '0'), 'hex');
  if (bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const check = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
  return check.subarray(0, 4).equals(bytes.subarray(21));
}

/** TON's usual address (48 letters of base 64 with a checksum), or its raw form 0:… on the main workchain. */
export function isTonAddress(address: string): boolean {
  if (/^0:[0-9a-fA-F]{64}$/.test(address)) return true;
  if (!/^[A-Za-z0-9_\-+/]{48}$/.test(address)) return false;
  const bytes = Buffer.from(address.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 36 || bytes[1] !== 0) return false;
  const sum = crc16(bytes.subarray(0, 34));
  return bytes[34] === sum >> 8 && bytes[35] === (sum & 0xff);
}

/** Sui and Aptos both write a 32-byte address as 0x and 64 hex digits, so only the network named can tell them apart. */
export const isMoveAddress = (address: string) => /^0x[0-9a-fA-F]{64}$/.test(address);

function base32(text: string): Buffer | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const letter of text) {
    const index = alphabet.indexOf(letter);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** CRC-16/XMODEM, the checksum both Stellar and TON put in their addresses. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const evm = (address: string) => isAddress(address);
const MEMO_CAUTION = 'Only send to a personal wallet. An exchange address that needs a memo or tag would lose it, because the memo cannot be passed on.';

export const USDC_CHAINS: Record<ChainKey, UsdcChain> = {
  base: { key: 'base', name: 'Base', token: 'USDC', decimals: 6, explorerTx: 'https://basescan.org/tx/', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', aliases: ['base'], valid: evm },
  near: { key: 'near', name: 'NEAR', token: 'USDC', decimals: 6, explorerTx: 'https://nearblocks.io/txns/', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', aliases: ['near', 'near protocol'], valid: isNearAccount },
  arbitrum: { key: 'arbitrum', name: 'Arbitrum', token: 'USDC', decimals: 6, explorerTx: 'https://arbiscan.io/tx/', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', aliases: ['arbitrum', 'arb', 'arbitrum one'], valid: evm },
  optimism: { key: 'optimism', name: 'Optimism', token: 'USDC', decimals: 6, explorerTx: 'https://optimistic.etherscan.io/tx/', assetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ', usdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', aliases: ['optimism', 'op'], valid: evm },
  polygon: { key: 'polygon', name: 'Polygon', token: 'USDC', decimals: 6, explorerTx: 'https://polygonscan.com/tx/', assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', aliases: ['polygon', 'matic', 'pol'], valid: evm },
  avalanche: { key: 'avalanche', name: 'Avalanche', token: 'USDC', decimals: 6, explorerTx: 'https://snowtrace.io/tx/', assetId: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o', usdc: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', aliases: ['avalanche', 'avax'], valid: evm },
  solana: { key: 'solana', name: 'Solana', token: 'USDC', decimals: 6, explorerTx: 'https://solscan.io/tx/', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', aliases: ['solana', 'sol'], valid: isSolanaAddress },
  stellar: { key: 'stellar', name: 'Stellar', token: 'USDC', decimals: 7, explorerTx: 'https://stellar.expert/explorer/public/tx/', assetId: 'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu', usdc: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', aliases: ['stellar', 'xlm', 'lumens'], valid: isStellarAddress, caution: MEMO_CAUTION },
  tron: { key: 'tron', name: 'Tron', token: 'USDT', decimals: 6, explorerTx: 'https://tronscan.org/#/transaction/', assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', usdc: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', aliases: ['tron', 'trx', 'trc20', 'trc-20'], valid: isTronAddress, caution: 'Tron has no USDC here, so the receiver gets USDT.' },
  bsc: { key: 'bsc', name: 'BNB Chain', token: 'USDC', decimals: 18, explorerTx: 'https://bscscan.com/tx/', assetId: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', aliases: ['bnb', 'bnb chain', 'bnb smart chain', 'bsc', 'binance smart chain', 'bep20', 'bep-20'], valid: evm },
  ethereum: { key: 'ethereum', name: 'Ethereum', token: 'USDC', decimals: 6, explorerTx: 'https://etherscan.io/tx/', assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', aliases: ['ethereum', 'eth', 'erc20', 'erc-20', 'ethereum mainnet'], valid: evm },
  ton: { key: 'ton', name: 'TON', token: 'USDT', decimals: 6, explorerTx: 'https://tonviewer.com/transaction/', assetId: 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR', usdc: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', aliases: ['ton', 'the open network', 'toncoin'], valid: isTonAddress, caution: `TON has no USDC here, so the receiver gets USDT. ${MEMO_CAUTION}` },
  sui: { key: 'sui', name: 'Sui', token: 'USDC', decimals: 6, explorerTx: 'https://suivision.xyz/txblock/', assetId: 'nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near', usdc: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7', aliases: ['sui'], valid: isMoveAddress },
  aptos: { key: 'aptos', name: 'Aptos', token: 'USDC', decimals: 6, explorerTx: 'https://explorer.aptoslabs.com/txn/', assetId: 'nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near', usdc: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', aliases: ['aptos', 'apt'], valid: isMoveAddress },
  gnosis: { key: 'gnosis', name: 'Gnosis', token: 'USDC', decimals: 6, explorerTx: 'https://gnosisscan.io/tx/', assetId: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near', usdc: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', aliases: ['gnosis', 'gnosis chain', 'xdai'], valid: evm },
  monad: { key: 'monad', name: 'Monad', token: 'USDC', decimals: 6, explorerTx: 'https://monadscan.com/tx/', assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', usdc: '0x754704bc059f8c67012fed69bc8a327a5aafb603', aliases: ['monad', 'mon'], valid: evm },
};

export const CHAIN_NAMES = Object.values(USDC_CHAINS).map((chain) => chain.name).join(', ');

export function chainNamed(text: string | null | undefined): UsdcChain | null {
  const wanted = text?.trim().toLowerCase();
  return Object.values(USDC_CHAINS).find((chain) => wanted && chain.aliases.includes(wanted)) ?? null;
}

/** A chain only this address could be on. A 0x address could be any of several, so it says nothing. */
export function chainFromAddress(address: string): UsdcChain | null {
  if (isNearAccount(address)) return USDC_CHAINS.near;
  if (isSolanaAddress(address)) return USDC_CHAINS.solana;
  if (isStellarAddress(address)) return USDC_CHAINS.stellar;
  if (isTronAddress(address)) return USDC_CHAINS.tron;
  if (isTonAddress(address)) return USDC_CHAINS.ton;
  return null;
}

/** The chain a saved wallet is on. Wallets saved before other chains existed are on Base. */
export function chainOfWallet(destination: { network?: string | null; walletAddress?: string | null }): UsdcChain {
  return (destination.network && USDC_CHAINS[destination.network as ChainKey]) || (destination.walletAddress && chainFromAddress(destination.walletAddress)) || USDC_CHAINS.base;
}
