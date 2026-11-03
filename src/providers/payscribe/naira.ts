// Ported from Tokkenly (src/payscribe/naira.ts). Payscribe sends one kind of figure in several
// shapes: "35200.00", 147.75, 250, and floats with binary noise such as
// 12189.29999999999927240423858165740966796875. They become integer kobo the moment they arrive.

export class NairaError extends Error {}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * A Payscribe naira figure, as kobo. A float goes through String, not toFixed, because String gives
 * the shortest decimal that reads back as the same double, which is the figure Payscribe meant.
 * Rounded half-up to the kobo. Refuses negatives, non-finite numbers and exponent notation.
 */
export function nairaToKobo(value: unknown, what = 'amount'): bigint {
  let text: string;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new NairaError(`${what}: expected a non-negative naira figure, got ${value}`);
    }
    text = String(value);
    if (/e/i.test(text)) {
      throw new NairaError(`${what}: ${text} is not a plausible naira figure`);
    }
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new NairaError(`${what}: expected a naira figure, got ${typeof value}`);
  }

  const match = DECIMAL.exec(text);
  if (!match) {
    throw new NairaError(`${what}: "${text}" is not a naira figure`);
  }

  const whole = BigInt(match[1]!);
  const fraction = match[2] ?? '';
  const kobo = BigInt((fraction + '00').slice(0, 2));
  // Only the third decimal decides the rounding: half-up on the kobo.
  const next = fraction.length > 2 ? Number(fraction[2]) : 0;

  return whole * 100n + kobo + (next >= 5 ? 1n : 0n);
}
