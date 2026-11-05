import { isAddress } from 'viem';

/**
 * Where a user can send USDC from their Base wallet. Identifiers are from the NEAR Intents token list, checked on
 * 5 Nov 2026. A chain goes on this list only after a real delivery has been tested, or is marked as not live.
 */
export type ChainKey = 'base' | 'near' | 'arbitrum' | 'optimism' | 'polygon' | 'avalanche' | 'solana';

export interface UsdcChain {
  key: ChainKey;
  name: string;
  /** NEAR Intents' name for USDC on this chain. */
  assetId: string;
  /** USDC's own contract here, which is never a wallet. */
  usdc: string;
  aliases: string[];
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

const evm = (address: string) => isAddress(address);

export const USDC_CHAINS: Record<ChainKey, UsdcChain> = {
  base: { key: 'base', name: 'Base', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', aliases: ['base'], valid: evm },
  near: { key: 'near', name: 'NEAR', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', aliases: ['near', 'near protocol'], valid: isNearAccount },
  arbitrum: { key: 'arbitrum', name: 'Arbitrum', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', aliases: ['arbitrum', 'arb', 'arbitrum one'], valid: evm },
  optimism: { key: 'optimism', name: 'Optimism', assetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ', usdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', aliases: ['optimism', 'op'], valid: evm },
  polygon: { key: 'polygon', name: 'Polygon', assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', aliases: ['polygon', 'matic', 'pol'], valid: evm },
  avalanche: { key: 'avalanche', name: 'Avalanche', assetId: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o', usdc: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', aliases: ['avalanche', 'avax'], valid: evm },
  solana: { key: 'solana', name: 'Solana', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', aliases: ['solana', 'sol'], valid: isSolanaAddress },
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
  return null;
}

/** The chain a saved wallet is on. Wallets saved before other chains existed are on Base. */
export function chainOfWallet(destination: { network?: string | null; walletAddress?: string | null }): UsdcChain {
  return (destination.network && USDC_CHAINS[destination.network as ChainKey]) || (destination.walletAddress && chainFromAddress(destination.walletAddress)) || USDC_CHAINS.base;
}
