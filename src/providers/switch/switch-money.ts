// The one place a number crosses between CentralMonie's integers and Switch's JSON numbers. Ported from
// Tokkenly (src/switch/switch-money.ts). Switch sends and receives money as JSON numbers such as
// `amount: 100` and `rate: 1500.5`. Everything here takes or returns integer minor units.

export const KOBO_DECIMALS = 2;
export const USDC_DECIMALS = 6;

export class SwitchMoneyError extends Error {}

/** Minor units to the JSON number Switch expects, built from an exact decimal string. Exact, or it throws. */
export function toSwitchNumber(minor: number, decimals: number): number {
  if (!Number.isSafeInteger(minor)) throw new SwitchMoneyError('amount must be a whole number of minor units');
  if (minor < 0) throw new SwitchMoneyError('amount must not be negative');
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(minor);
  return Number(`${value / scale}.${(value % scale).toString().padStart(decimals, '0')}`);
}

/** A number from Switch to a fixed-decimal string, so nothing downstream does arithmetic on a double. */
export function fromSwitchNumber(value: unknown, decimals: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SwitchMoneyError('expected a finite number');
  return value.toFixed(decimals);
}

/** A number from Switch to integer minor units. */
export function switchNumberToMinor(value: unknown, decimals: number): number {
  const text = fromSwitchNumber(value, decimals);
  if (text.startsWith('-')) throw new SwitchMoneyError('expected a non-negative number');
  const minor = Number(text.replace('.', ''));
  if (!Number.isSafeInteger(minor)) throw new SwitchMoneyError('amount is too large to represent exactly');
  return minor;
}

/** Whether Switch priced the amount asked about, within half a minor unit because it has been through a double. */
export function echoesAmount(echoed: unknown, requestedMinor: number, decimals: number): boolean {
  if (typeof echoed !== 'number' || !Number.isFinite(echoed)) return false;
  return Math.abs(echoed - toSwitchNumber(requestedMinor, decimals)) < 0.5 / 10 ** decimals;
}
