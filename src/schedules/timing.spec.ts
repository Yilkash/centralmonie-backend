import { describeTiming, firstRun, nextRun, normalise, permissionPeriodSeconds, Timing, TimingRefused } from './timing';

// Monday 2 Nov 2026, 22:30 in Nigeria.
const NOW = new Date('2026-11-02T21:30:00Z');
const once = (fields: Partial<Extract<Timing, { kind: 'once' }>>): Timing => ({ kind: 'once', delayMinutes: null, date: null, time: null, ...fields });
const repeat = (fields: Partial<Extract<Timing, { kind: 'recurring' }>>): Timing => ({
  kind: 'recurring', frequency: 'monthly', interval: 1, weekday: null, dayOfMonth: null, lastDayOfMonth: false, time: null, occurrences: null, startDate: null, ...fields,
});
const iso = (moment: Date | null) => moment?.toISOString();

describe('one-time payments', () => {
  it.each([[1, '2026-11-02T21:31:00.000Z'], [30, '2026-11-02T22:00:00.000Z'], [240, '2026-11-03T01:30:00.000Z']])('runs %i minutes later', (minutes, expected) => {
    expect(iso(firstRun(once({ delayMinutes: minutes }), NOW))).toBe(expected);
  });

  it('refuses no delay, a delay under a minute and a delay over a year', () => {
    expect(() => normalise(once({ delayMinutes: 0 }), NOW)).toThrow(TimingRefused);
    expect(() => normalise(once({ delayMinutes: 1.5 }), NOW)).toThrow(TimingRefused);
    expect(() => normalise(once({ delayMinutes: 600000 }), NOW)).toThrow(TimingRefused);
    expect(() => normalise(once({}), NOW)).toThrow(TimingRefused);
  });

  it('uses Nigerian time for a date and time', () => {
    expect(iso(firstRun(once({ date: '2026-11-06', time: '15:00' }), NOW))).toBe('2026-11-06T14:00:00.000Z');
  });

  it('defaults a date with no time to 09:00', () => {
    expect(iso(firstRun(once({ date: '2026-11-03' }), NOW))).toBe('2026-11-03T08:00:00.000Z');
  });

  it('takes a time with no date as the next time that clock comes round', () => {
    expect(iso(firstRun(once({ time: '23:00' }), NOW))).toBe('2026-11-02T22:00:00.000Z');
    expect(iso(firstRun(once({ time: '08:00' }), NOW))).toBe('2026-11-03T07:00:00.000Z');
  });

  it('refuses the past, a date that does not exist and a date over a year ahead', () => {
    expect(() => firstRun(once({ date: '2026-11-01' }), NOW)).toThrow(/already passed/);
    expect(() => firstRun(once({ date: '2026-02-30' }), NOW)).toThrow(/no such date/);
    expect(() => firstRun(once({ date: '2028-01-01' }), NOW)).toThrow(/a year/);
  });

  it('does not repeat', () => {
    expect(nextRun(once({ delayMinutes: 5 }), NOW)).toBeNull();
  });
});

describe('repeating payments', () => {
  it('defaults monthly to the 28th at 09:00', () => {
    const timing = normalise(repeat({}), NOW);
    expect(iso(firstRun(timing, NOW))).toBe('2026-11-28T08:00:00.000Z');
    expect(describeTiming(timing, null)).toBe('Every month on the 28th at 09:00');
  });

  it('moves to next month when the day has passed', () => {
    const timing = normalise(repeat({ dayOfMonth: 1 }), NOW);
    expect(iso(firstRun(timing, NOW))).toBe('2026-12-01T08:00:00.000Z');
    expect(iso(nextRun(timing, firstRun(timing, NOW)))).toBe('2027-01-01T08:00:00.000Z');
  });

  it.each([29, 30, 31])('offers choices for the %ith instead of guessing', (day) => {
    expect(() => normalise(repeat({ dayOfMonth: day }), NOW)).toThrow(/last day of each month, the 28th, or another date/);
  });

  it('keeps the last day of each month through February', () => {
    const timing = normalise(repeat({ lastDayOfMonth: true }), NOW);
    let run = firstRun(timing, NOW);
    expect(iso(run)).toBe('2026-11-30T08:00:00.000Z');
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      run = nextRun(timing, run)!;
      seen.push(iso(run));
    }
    expect(seen).toEqual(['2026-12-31T08:00:00.000Z', '2027-01-31T08:00:00.000Z', '2027-02-28T08:00:00.000Z', '2027-03-31T08:00:00.000Z']);
  });

  it('crosses a year end, and skips months for every 2 months', () => {
    const timing = normalise(repeat({ dayOfMonth: 15, interval: 2 }), NOW);
    expect(iso(nextRun(timing, new Date('2026-12-15T08:00:00Z')))).toBe('2027-02-15T08:00:00.000Z');
  });

  it('finds the coming weekday, and next week if today has passed', () => {
    expect(iso(firstRun(normalise(repeat({ frequency: 'weekly', weekday: 5 }), NOW), NOW))).toBe('2026-11-06T08:00:00.000Z');
    expect(iso(firstRun(normalise(repeat({ frequency: 'weekly', weekday: 1 }), NOW), NOW))).toBe('2026-11-09T08:00:00.000Z');
  });

  it('runs daily, and every two weeks', () => {
    const daily = normalise(repeat({ frequency: 'daily', time: '23:00' }), NOW);
    expect(iso(firstRun(daily, NOW))).toBe('2026-11-02T22:00:00.000Z');
    const fortnight = normalise(repeat({ frequency: 'weekly', weekday: 5, interval: 2 }), NOW);
    expect(iso(nextRun(fortnight, firstRun(fortnight, NOW)))).toBe('2026-11-20T08:00:00.000Z');
  });

  it('honours a start date', () => {
    expect(iso(firstRun(normalise(repeat({ dayOfMonth: 5, startDate: '2027-01-01' }), NOW), NOW))).toBe('2027-01-05T08:00:00.000Z');
    expect(iso(firstRun(normalise(repeat({ frequency: 'daily', startDate: '2026-12-01' }), NOW), NOW))).toBe('2026-12-01T08:00:00.000Z');
  });

  it('never lands two monthly payments in one 28-day period', () => {
    const timing = normalise(repeat({}), NOW);
    let run = firstRun(timing, NOW);
    const period = permissionPeriodSeconds(timing, run, NOW) * 1000;
    for (let i = 0; i < 36; i += 1) {
      const next = nextRun(timing, run)!;
      expect(next.getTime() - run.getTime()).toBeGreaterThanOrEqual(period);
      run = next;
    }
  });
});

describe('describeTiming', () => {
  it('says plainly when a delay starts', () => {
    expect(describeTiming(once({ delayMinutes: 30 }), null)).toBe('In 30 minutes, from when you approve');
    expect(describeTiming(once({ delayMinutes: 240 }), null)).toBe('In 4 hours, from when you approve');
    expect(describeTiming(once({ delayMinutes: 90 }), null)).toBe('In 1 hour 30 minutes, from when you approve');
    expect(describeTiming(once({ delayMinutes: 1 }), null)).toBe('In 1 minute, from when you approve');
  });

  it('names the date once known', () => {
    expect(describeTiming(once({ delayMinutes: 30 }), new Date('2026-11-02T22:00:00Z'))).toBe('Once, Mon 2 Nov 2026 at 23:00');
  });

  it('counts limited runs', () => {
    expect(describeTiming(normalise(repeat({ frequency: 'weekly', weekday: 5, occurrences: 3 }), NOW), null)).toBe('Every Friday at 09:00, 3 payments');
  });
});
