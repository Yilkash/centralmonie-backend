/**
 * When a scheduled payment runs. The model fills in plain fields and this code does the date arithmetic,
 * so a model that miscounts days cannot produce a wrong date without it showing on the card.
 * Nigeria is UTC+1 all year, with no daylight saving.
 */
export type Timing =
  | { kind: 'once'; delayMinutes: number | null; date: string | null; time: string | null }
  | {
      kind: 'recurring';
      frequency: 'daily' | 'weekly' | 'monthly';
      interval: number;
      weekday: number | null; // 0 is Sunday
      dayOfMonth: number | null;
      lastDayOfMonth: boolean;
      time: string | null;
      occurrences: number | null;
      startDate: string | null;
    };

/** A timing that cannot be used as asked. The message is safe to show the user. */
export class TimingRefused extends Error {}

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_TIME = '09:00';
const DEFAULT_DAY_OF_MONTH = 28;
const MAX_AHEAD_MS = 366 * DAY;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A moment shifted so its UTC fields read as Nigerian wall-clock time. */
const lagos = (moment: Date): Date => new Date(moment.getTime() + LAGOS_OFFSET_MS);
const fromLagos = (year: number, month: number, day: number, minutes: number): Date =>
  new Date(Date.UTC(year, month, day, 0, minutes) - LAGOS_OFFSET_MS);

function minutesOf(time: string | null): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time ?? DEFAULT_TIME);
  if (!match) throw new TimingRefused('I could not read that time.');
  return Number(match[1]) * 60 + Number(match[2]);
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TimingRefused('I could not read that date.');
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) throw new TimingRefused(`There is no such date as ${date}.`);
  return { year, month, day };
}

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Checks a timing and fills in the defaults: the 28th for monthly, 09:00 for any time not given. */
export function normalise(timing: Timing, now: Date): Timing {
  minutesOf(timing.time);
  if (timing.kind === 'once') {
    if (timing.delayMinutes !== null) {
      if (!Number.isInteger(timing.delayMinutes) || timing.delayMinutes < 1) throw new TimingRefused('The delay must be at least one minute.');
      if (timing.delayMinutes * MINUTE > MAX_AHEAD_MS) throw new TimingRefused('I can only schedule up to a year ahead.');
    } else if (timing.date === null && timing.time === null) {
      throw new TimingRefused('I need to know when to send this.');
    }
    return timing;
  }
  if (!Number.isInteger(timing.interval) || timing.interval < 1 || timing.interval > 12) {
    throw new TimingRefused('The repeat must be between every 1 and every 12 days, weeks or months.');
  }
  if (timing.occurrences !== null && (!Number.isInteger(timing.occurrences) || timing.occurrences < 1)) {
    throw new TimingRefused('The number of payments must be at least one.');
  }
  if (timing.startDate) dateParts(timing.startDate);
  if (timing.frequency === 'monthly') {
    if (timing.lastDayOfMonth) return { ...timing, dayOfMonth: null };
    const day = timing.dayOfMonth ?? DEFAULT_DAY_OF_MONTH;
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new TimingRefused('A day of the month must be between 1 and 31.');
    if (day > 28) {
      throw new TimingRefused(
        `Not every month has a ${ordinal(day)}. Ask the user to choose: the last day of each month, the 28th, or another date.`,
      );
    }
    return { ...timing, dayOfMonth: day };
  }
  if (timing.frequency === 'weekly') {
    const weekday = timing.weekday ?? lagos(now).getUTCDay();
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new TimingRefused('I could not read that day of the week.');
    return { ...timing, weekday };
  }
  return timing;
}

/** The first run, counted from the moment given. Relative delays are counted from approval, not from the question. */
export function firstRun(timing: Timing, now: Date): Date {
  const run = timing.kind === 'once' ? firstOnce(timing, now) : firstRecurring(timing, now);
  if (run.getTime() - now.getTime() > MAX_AHEAD_MS) throw new TimingRefused('I can only schedule up to a year ahead.');
  return run;
}

function firstOnce(timing: Extract<Timing, { kind: 'once' }>, now: Date): Date {
  if (timing.delayMinutes !== null) return new Date(now.getTime() + timing.delayMinutes * MINUTE);
  const minutes = minutesOf(timing.time);
  if (timing.date) {
    const { year, month, day } = dateParts(timing.date);
    const run = fromLagos(year, month, day, minutes);
    if (run <= now) throw new TimingRefused(`${describeMoment(run)} has already passed.`);
    return run;
  }
  const today = lagos(now);
  const run = fromLagos(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), minutes);
  return run > now ? run : new Date(run.getTime() + DAY);
}

function firstRecurring(timing: Extract<Timing, { kind: 'recurring' }>, now: Date): Date {
  const minutes = minutesOf(timing.time);
  let from = lagos(now);
  if (timing.startDate) {
    const { year, month, day } = dateParts(timing.startDate);
    const start = fromLagos(year, month, day, 0);
    if (start > now) from = lagos(start);
  }
  const floor = timing.startDate ? fromLagos(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0) : now;
  const afterFloor = (run: Date) => (timing.startDate ? run >= floor && run > now : run > now);
  const [year, month, date] = [from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()];

  if (timing.frequency === 'daily') {
    const run = fromLagos(year, month, date, minutes);
    return afterFloor(run) ? run : new Date(run.getTime() + DAY);
  }
  if (timing.frequency === 'weekly') {
    const ahead = (timing.weekday! - from.getUTCDay() + 7) % 7;
    const run = fromLagos(year, month, date + ahead, minutes);
    return afterFloor(run) ? run : new Date(run.getTime() + 7 * DAY);
  }
  for (let step = 0; step < 3; step += 1) {
    const run = monthlyRun(timing, year, month + step, minutes);
    if (afterFloor(run)) return run;
  }
  throw new TimingRefused('I could not work out the first payment date.');
}

function monthlyRun(timing: Extract<Timing, { kind: 'recurring' }>, year: number, month: number, minutes: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const [y, m] = [first.getUTCFullYear(), first.getUTCMonth()];
  return fromLagos(y, m, timing.lastDayOfMonth ? daysInMonth(y, m) : timing.dayOfMonth!, minutes);
}

/** The next run after a scheduled one, or null for a one-time payment. */
export function nextRun(timing: Timing, scheduledFor: Date): Date | null {
  if (timing.kind === 'once') return null;
  if (timing.frequency === 'daily') return new Date(scheduledFor.getTime() + timing.interval * DAY);
  if (timing.frequency === 'weekly') return new Date(scheduledFor.getTime() + timing.interval * 7 * DAY);
  const local = lagos(scheduledFor);
  return monthlyRun(timing, local.getUTCFullYear(), local.getUTCMonth() + timing.interval, minutesOf(timing.time));
}

/** How long a spend permission's limit lasts: 28 days a month, so no month's payment ever lands in a used period. */
export function permissionPeriodSeconds(timing: Timing, firstRunAt: Date, now: Date): number {
  if (timing.kind === 'once') return Math.ceil((firstRunAt.getTime() - now.getTime()) / 1000) + 8 * 86400;
  const base = { daily: 1, weekly: 7, monthly: 28 }[timing.frequency];
  return base * timing.interval * 86400;
}

const ordinal = (day: number): string => {
  const tail = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
  return `${day}${tail}`;
};

const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function describeMoment(moment: Date): string {
  const local = lagos(moment);
  return `${WEEKDAYS[local.getUTCDay()]!.slice(0, 3)} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} at ${clock(local.getUTCHours() * 60 + local.getUTCMinutes())}`;
}

const plural = (count: number, unit: string): string => (count === 1 ? `1 ${unit}` : `${count} ${unit}s`);

function describeDelay(minutes: number): string {
  if (minutes < 60) return `In ${plural(minutes, 'minute')}`;
  if (minutes % 1440 === 0) return `In ${plural(minutes / 1440, 'day')}`;
  if (minutes % 60 === 0) return `In ${plural(minutes / 60, 'hour')}`;
  return `In ${plural(Math.floor(minutes / 60), 'hour')} ${plural(minutes % 60, 'minute')}`;
}

/** The plain sentence on the approval card. nextRunAt is left out for a delay not yet approved. */
export function describeTiming(timing: Timing, nextRunAt: Date | null): string {
  if (timing.kind === 'once') {
    if (timing.delayMinutes !== null && !nextRunAt) return `${describeDelay(timing.delayMinutes)}, from when you approve`;
    return `Once, ${nextRunAt ? describeMoment(nextRunAt) : 'soon'}`;
  }
  const time = clock(minutesOf(timing.time));
  const every = (unit: string) => (timing.interval === 1 ? `Every ${unit}` : `Every ${timing.interval} ${unit}s`);
  const rule =
    timing.frequency === 'daily'
      ? `${every('day')} at ${time}`
      : timing.frequency === 'weekly'
        ? `${timing.interval === 1 ? `Every ${WEEKDAYS[timing.weekday!]}` : `Every ${timing.interval} weeks on ${WEEKDAYS[timing.weekday!]}`} at ${time}`
        : `${every('month')} on the ${timing.lastDayOfMonth ? 'last day' : ordinal(timing.dayOfMonth!)} at ${time}`;
  const limit = timing.occurrences ? `, ${plural(timing.occurrences, 'payment')}` : '';
  return `${rule}${limit}${nextRunAt ? `. Next: ${describeMoment(nextRunAt)}` : ''}`;
}

/** For the agent: today and now in Nigeria, so it can turn "next Friday" into a date. */
export function describeNow(now: Date): string {
  const local = lagos(now);
  const date = local.toISOString().slice(0, 10);
  return `${WEEKDAYS[local.getUTCDay()]} ${date}, ${clock(local.getUTCHours() * 60 + local.getUTCMinutes())} in Nigeria`;
}
