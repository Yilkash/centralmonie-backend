import { addressRefusal, checkAddress } from './address-check';
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
