import { NairaError, nairaToKobo } from './naira';

describe('nairaToKobo', () => {
  it.each([
    ['35200.00', 3520000n],
    [147.75, 14775n],
    [250, 25000n],
    [12189.299999999999, 1218930n],
    [40149.35, 4014935n],
    ['1.005', 101n],
  ])('reads %s', (value, kobo) => {
    expect(nairaToKobo(value)).toBe(kobo);
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY], [1e21], ['1e3'], ['-5'], [''], [null], [undefined], [{}]])(
    'refuses %s',
    (value) => {
      expect(() => nairaToKobo(value)).toThrow(NairaError);
    },
  );
});
