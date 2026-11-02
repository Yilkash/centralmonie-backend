/** Money is whole kobo and whole USDC minor units (6 decimals), never floats. */
export const DAILY_LIMIT_KOBO = 500_000 * 100;

export const nairaToKobo = (naira: number): number => naira * 100;

export function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export function formatUsdc(minor: number): string {
  return `${(minor / 1_000_000).toFixed(2)} USDC`;
}

/** Parses "20" or "20.5" exactly, refusing anything finer than USDC can hold. */
export function parseUsdc(value: string): number | null {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

/** Rounds up: the user covers the whole naira amount even when it does not divide evenly. */
export function koboToUsdcMinor(kobo: number, nairaPerUsdc: number): number {
  return Math.ceil((kobo * 10_000) / nairaPerUsdc);
}

export function usdcMinorToKobo(minor: number, nairaPerUsdc: number): number {
  return Math.ceil((minor * nairaPerUsdc) / 10_000);
}
