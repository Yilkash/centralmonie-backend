import { echoesAmount, fromSwitchNumber, KOBO_DECIMALS, switchNumberToMinor, toSwitchNumber, USDC_DECIMALS } from './switch-money';

describe('switch money', () => {
  it('turns minor units into the exact number Switch expects', () => {
    expect(toSwitchNumber(1_234_567, USDC_DECIMALS)).toBe(1.234567);
    expect(toSwitchNumber(5_000_000, KOBO_DECIMALS)).toBe(50000);
    expect(toSwitchNumber(5, KOBO_DECIMALS)).toBe(0.05);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])('refuses %s minor units', (minor) => {
    expect(() => toSwitchNumber(minor, USDC_DECIMALS)).toThrow();
  });

  it('reads numbers from Switch into integers', () => {
    expect(switchNumberToMinor(32.878514, USDC_DECIMALS)).toBe(32_878_514);
    expect(switchNumberToMinor(150050, KOBO_DECIMALS)).toBe(15_005_000);
    expect(fromSwitchNumber(1500.5, USDC_DECIMALS)).toBe('1500.500000');
  });

  it.each([['1500'], [null], [Number.NaN], [-1]])('refuses %s from Switch', (value) => {
    expect(() => switchNumberToMinor(value, KOBO_DECIMALS)).toThrow();
  });

  it('compares an echoed amount to within half a minor unit', () => {
    expect(echoesAmount(1.234567, 1_234_567, USDC_DECIMALS)).toBe(true);
    expect(echoesAmount(1.234568, 1_234_567, USDC_DECIMALS)).toBe(false);
    expect(echoesAmount('1.234567', 1_234_567, USDC_DECIMALS)).toBe(false);
  });
});
