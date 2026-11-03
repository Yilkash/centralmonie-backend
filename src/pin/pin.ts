import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;

const derive = (pin: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(pin, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))));

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await derive(pin, salt)).toString('hex')}`;
}

export async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  return timingSafeEqual(await derive(pin, Buffer.from(salt, 'hex')), Buffer.from(key, 'hex'));
}

const OBVIOUS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1212', '0123']);

/** Why a PIN is not acceptable, or null. */
export function weakPin(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'A PIN is 4 digits.';
  return OBVIOUS.has(pin) ? 'That PIN is too easy to guess. Please pick another.' : null;
}
