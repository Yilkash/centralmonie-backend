import { blockRanges, transfersCover } from './chain';

const WALLET = '0xAAaa000000000000000000000000000000000001';
const A = '0xbbbb000000000000000000000000000000000002';
const B = '0xCcCc000000000000000000000000000000000003';
const t = (from: string, to: string, value: bigint) => ({ from, to, value });

describe('blockRanges', () => {
  it('covers every block once, in pieces no bigger than the limit', () => {
    expect(blockRanges(1, 450)).toEqual([[1, 200], [201, 400], [401, 450]]);
    expect(blockRanges(5, 5)).toEqual([[5, 5]]);
    expect(blockRanges(6, 5)).toEqual([]);
  });

  it('treats a span of exactly the limit as one piece, which the RPC accepts', () => {
    expect(blockRanges(1, 200)).toEqual([[1, 200]]);
  });
});

describe('transfersCover', () => {
  it('accepts exact transfers, whatever the letter case', () => {
    expect(transfersCover([t(WALLET.toLowerCase(), A.toUpperCase().replace('0X', '0x'), 5n), t(WALLET, B, 7n)], WALLET, [
      { address: A, usdcMinor: 5 },
      { address: B, usdcMinor: 7 },
    ])).toBe(true);
  });

  it('refuses a wrong amount, a wrong address and a wrong sender', () => {
    expect(transfersCover([t(WALLET, A, 4n)], WALLET, [{ address: A, usdcMinor: 5 }])).toBe(false);
    expect(transfersCover([t(WALLET, A, 6n)], WALLET, [{ address: A, usdcMinor: 5 }])).toBe(false);
    expect(transfersCover([t(WALLET, B, 5n)], WALLET, [{ address: A, usdcMinor: 5 }])).toBe(false);
    expect(transfersCover([t(B, A, 5n)], WALLET, [{ address: A, usdcMinor: 5 }])).toBe(false);
  });

  it('never lets one transfer pay for two payments', () => {
    const two = [{ address: A, usdcMinor: 5 }, { address: A, usdcMinor: 5 }];
    expect(transfersCover([t(WALLET, A, 5n)], WALLET, two)).toBe(false);
    expect(transfersCover([t(WALLET, A, 5n), t(WALLET, A, 5n)], WALLET, two)).toBe(true);
  });
});
