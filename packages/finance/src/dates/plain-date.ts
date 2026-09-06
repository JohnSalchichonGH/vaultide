/**
 * Financial dates (blueprint 7.7): calendar dates, never timestamps.
 *
 * A `PlainDate` is an ISO `YYYY-MM-DD` string. Engines never call `Date.now()`;
 * "today" is computed once per request in the user's timezone and passed in.
 */

export type PlainDate = string & { readonly __brand: 'PlainDate' };
/** A month, as its first day: `YYYY-MM-01`. */
export type MonthKey = string & { readonly __brand: 'MonthKey' };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class InvalidPlainDateError extends Error {
  readonly code = 'INVALID_PLAIN_DATE';
  constructor(readonly value: string) {
    super(`"${value}" is not a valid calendar date (expected YYYY-MM-DD).`);
    this.name = 'InvalidPlainDateError';
  }
}

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function partsOf(date: PlainDate): Parts {
  const match = DATE_PATTERN.exec(date);
  /* v8 ignore next 2 -- a PlainDate is only ever produced by `plainDate()`,
     which validates the shape, so this guard cannot be reached. */
  if (match === null) throw new InvalidPlainDateError(date);
  return {
    year: Number.parseInt(match[1] as string, 10),
    month: Number.parseInt(match[2] as string, 10),
    day: Number.parseInt(match[3] as string, 10),
  };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function build(year: number, month: number, day: number): PlainDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as PlainDate;
}

export function isValidPlainDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export function plainDate(value: string): PlainDate {
  if (!isValidPlainDate(value)) throw new InvalidPlainDateError(value);
  return value as PlainDate;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLeapYear(year: number): boolean {
  return daysInMonth(year, 2) === 29;
}

export function startOfMonth(date: PlainDate): PlainDate {
  const { year, month } = partsOf(date);
  return build(year, month, 1);
}

export function endOfMonth(date: PlainDate): PlainDate {
  const { year, month } = partsOf(date);
  return build(year, month, daysInMonth(year, month));
}

export function isMonthEnd(date: PlainDate): boolean {
  return date === endOfMonth(date);
}

export function addMonths(date: PlainDate, count: number): PlainDate {
  const { year, month, day } = partsOf(date);
  const zeroBased = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  // Clamp to the target month's length (31 Jan + 1 month = 28/29 Feb).
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return build(targetYear, targetMonth, targetDay);
}

export function addDays(date: PlainDate, count: number): PlainDate {
  const { year, month, day } = partsOf(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + count));
  return build(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

const MS_PER_DAY = 86_400_000;

function toUtcMillis(date: PlainDate): number {
  const { year, month, day } = partsOf(date);
  return Date.UTC(year, month - 1, day);
}

/** Signed whole days from `from` to `to` (calendar arithmetic, no DST effects). */
export function daysBetween(from: PlainDate, to: PlainDate): number {
  return (toUtcMillis(to) - toUtcMillis(from)) / MS_PER_DAY;
}

/** Whole months from `from` to `to`, counting only complete months. */
export function monthsBetween(from: PlainDate, to: PlainDate): number {
  const a = partsOf(from);
  const b = partsOf(to);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return b.day < a.day ? months - 1 : months;
}

/** −1, 0 or 1. ISO dates order lexicographically, which is why this is trivial. */
export function compareDates(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: PlainDate, b: PlainDate): PlainDate {
  return a <= b ? a : b;
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return a >= b ? a : b;
}

/** The month a date belongs to, as its first day. */
export function monthKey(date: PlainDate): MonthKey {
  return startOfMonth(date) as string as MonthKey;
}

export function monthKeyOf(year: number, month: number): MonthKey {
  return build(year, month, 1) as string as MonthKey;
}

export function startOfMonthKey(month: MonthKey): PlainDate {
  return month as string as PlainDate;
}

export function endOfMonthKey(month: MonthKey): PlainDate {
  return endOfMonth(month as string as PlainDate);
}

/** `true` when month `M` is over on `today`, i.e. `today > end(M)` (M5, R15). */
export function isMonthCompleted(month: MonthKey, today: PlainDate): boolean {
  return today > endOfMonthKey(month);
}

/** `true` when `today` falls inside month `M`. */
export function isCurrentMonth(month: MonthKey, today: PlainDate): boolean {
  return monthKey(today) === month;
}

/** Human-stable label used in logs and explanations, e.g. `2026-09`. */
export function monthLabel(month: MonthKey): string {
  return (month as string).slice(0, 7);
}
