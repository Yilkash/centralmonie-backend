import { chainFromAddress, chainNamed, isMoveAddress, isStellarAddress, isTonAddress, isTronAddress, USDC_CHAINS } from './usdc-chains';

describe('send networks', () => {
  it('knows a real Stellar account, and catches a one-letter typo through the checksum', () => {
    expect(isStellarAddress('GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB')).toBe(true);
    expect(isStellarAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')).toBe(true);
    expect(isStellarAddress('GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6Q5')).toBe(false);
    expect(isStellarAddress('GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6O')).toBe(false);
    // A secret key starts with S. It must never be taken as an address.
    expect(isStellarAddress('SAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB')).toBe(false);
  });

  it('knows a real Tron address, and catches a typo', () => {
    expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBe(false);
    expect(isTronAddress('0x2840EF4DF9987626EEe1F16c83383F81b752E85c')).toBe(false);
  });

  it('knows a real TON address in both forms, and catches a typo', () => {
    expect(isTonAddress('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')).toBe(true);
    expect(isTonAddress('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt')).toBe(false);
    expect(isTonAddress('0:' + 'a'.repeat(64))).toBe(true);
  });

  it('works out the network from addresses only one network uses, and leaves 0x addresses to the user', () => {
    expect(chainFromAddress('GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB')?.key).toBe('stellar');
    expect(chainFromAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')?.key).toBe('tron');
    expect(chainFromAddress('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')?.key).toBe('ton');
    expect(chainFromAddress('0x2840EF4DF9987626EEe1F16c83383F81b752E85c')).toBeNull();
    expect(chainFromAddress('0x' + 'ab'.repeat(32))).toBeNull();
    expect(isMoveAddress('0x' + 'ab'.repeat(32))).toBe(true);
  });

  it('understands the names people use', () => {
    expect(chainNamed('BEP20')?.key).toBe('bsc');
    expect(chainNamed('TRC20')?.key).toBe('tron');
    expect(chainNamed('erc20')?.key).toBe('ethereum');
    expect(chainNamed('Stellar')?.key).toBe('stellar');
  });

  it('has sixteen networks, each with its token decimals and a contract that is never a wallet', () => {
    const chains = Object.values(USDC_CHAINS);
    expect(chains).toHaveLength(16);
    for (const chain of chains) {
      expect(chain.decimals).toBeGreaterThanOrEqual(6);
      expect(chain.valid(chain.usdc) || chain.key === 'near' || chain.key === 'sui' || chain.key === 'aptos').toBe(true);
    }
    expect(USDC_CHAINS.tron.token).toBe('USDT');
    expect(USDC_CHAINS.ton.token).toBe('USDT');
  });
});
