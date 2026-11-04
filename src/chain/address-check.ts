import { Chain } from './chain.service';

/** What the blockchain says about an address. It cannot say who owns it. */
export type AddressCheck = 'used' | 'contract' | 'new' | 'unknown';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Addresses that are valid but where a payment is certainly a mistake. Null means none of them. */
export function addressRefusal(address: string, known: { usdc: string; own: string | null }): string | null {
  const target = address.toLowerCase();
  if (target === ZERO_ADDRESS) return 'That is the zero address. Nobody controls it, so anything sent there is lost.';
  if (target === known.usdc.toLowerCase()) return 'That is the USDC token contract, not a wallet. Anything sent there is lost.';
  if (known.own && target === known.own.toLowerCase()) return 'That is your own wallet, so nothing would move.';
  return null;
}

/** Never throws and never waits long: a failed check is shown as unchecked, and must not stop the payment being offered. */
export async function checkAddress(chain: Chain, address: string, timeoutMs = 5000): Promise<AddressCheck> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AddressCheck>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  try {
    return await Promise.race([chain.addressActivity(address).catch((): AddressCheck => 'unknown'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
