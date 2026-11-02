import { formatNaira, koboToUsdcMinor, nairaToKobo, parseUsdc, usdcMinorToKobo } from './money';

describe('money', () => {
  it('converts N5,000 at N1,500 per USDC, rounding up', () => {
    expect(koboToUsdcMinor(nairaToKobo(5000), 1500)).toBe(3_333_334);
  });

  it('values USDC in kobo', () => {
    expect(usdcMinorToKobo(20_000_000, 1500)).toBe(nairaToKobo(30_000));
  });

  it.each([
    ['20', 20_000_000],
    ['20.5', 20_500_000],
    ['0.000001', 1],
  ])('parses %s exactly', (input, minor) => {
    expect(parseUsdc(input)).toBe(minor);
  });

  it.each(['', '-1', '1e5', '1.1234567', 'abc', '1,000'])('refuses %s', (input) => {
    expect(parseUsdc(input)).toBeNull();
  });

  it('formats naira', () => {
    expect(formatNaira(nairaToKobo(105050))).toBe('₦105,050');
  });
});
