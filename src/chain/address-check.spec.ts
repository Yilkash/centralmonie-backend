import { addressRefusal, checkAddress } from './address-check';
import { chainFromAddress, chainNamed, chainOfWallet, isNearAccount, isSolanaAddress, USDC_CHAINS } from './usdc-chains';
import { Chain } from './chain.service';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OWN = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';
const OTHER = '0xe1a9cDb2907134c35E8d055DD72605331f4E642d';
const known = { usdc: USDC, own: OWN };
const chainThat = (addressActivity: Chain['addressActivity']) => ({ addressActivity }) as unknown as Chain;

describe('addressRefusal', () => {
  it('refuses the zero address, the token contract and the sender, in any letter case', () => {
    expect(addressRefusal(`0x${'0'.repeat(40)}`, known)).toContain('zero address');
    expect(addressRefusal(USDC.toLowerCase(), known)).toContain('USDC token contract');
    expect(addressRefusal(OWN.toLowerCase(), known)).toContain('your own wallet');
  });

  it('allows any other address, and works when the sender has no wallet yet', () => {
    expect(addressRefusal(OTHER, known)).toBeNull();
    expect(addressRefusal(OTHER, { usdc: USDC, own: null })).toBeNull();
  });
});

describe('checkAddress', () => {
  it('passes on what the chain says', async () => {
    await expect(checkAddress(chainThat(async () => 'new'), OTHER)).resolves.toBe('new');
    await expect(checkAddress(chainThat(async () => 'contract'), OTHER)).resolves.toBe('contract');
  });

  it('says unknown when the chain cannot be read', async () => {
    await expect(checkAddress(chainThat(() => Promise.reject(new Error('down'))), OTHER)).resolves.toBe('unknown');
  });

  it('says unknown when the chain is too slow', async () => {
    await expect(checkAddress(chainThat(() => new Promise(() => undefined)), OTHER, 5)).resolves.toBe('unknown');
  });
});

describe('isNearAccount', () => {
  it.each(['ada.near', '10kobo.near', 'pay.ada-b.near', 'a'.repeat(64)])('accepts %s', (value) => expect(isNearAccount(value)).toBe(true));
  it.each(['ada', 'ADA.near', '.near', 'ada..near', OTHER, 'a'.repeat(63), 'ada.near ', 'ada.testnet'])('refuses %s', (value) => expect(isNearAccount(value)).toBe(false));
});

describe('isSolanaAddress', () => {
  it.each(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '11111111111111111111111111111111'])('accepts %s', (value) => expect(isSolanaAddress(value)).toBe(true));
  it.each(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O', 'short', OTHER, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'])('refuses %s', (value) => expect(isSolanaAddress(value)).toBe(false));
});

describe('choosing a chain', () => {
  it('understands the usual names, and nothing else', () => {
    expect(chainNamed('Arb')?.key).toBe('arbitrum');
    expect(chainNamed(' MATIC ')?.key).toBe('polygon');
    expect(chainNamed('tron')).toBeNull();
    expect(chainNamed(null)).toBeNull();
  });

  it('knows only the chains an address can belong to on its own', () => {
    expect(chainFromAddress('ada.near')?.key).toBe('near');
    expect(chainFromAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')?.key).toBe('solana');
    expect(chainFromAddress(OTHER)).toBeNull();
  });

  it('treats a wallet saved before chains existed as on Base', () => {
    expect(chainOfWallet({ walletAddress: OTHER })).toBe(USDC_CHAINS.base);
    expect(chainOfWallet({ walletAddress: OTHER, network: 'arbitrum' })).toBe(USDC_CHAINS.arbitrum);
  });
});
