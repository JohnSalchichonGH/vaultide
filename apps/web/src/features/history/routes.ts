import type { Route } from 'next';

/**
 * Where Bulk History lives, and where its links start (blueprint 15.1; ADR
 * 0011 D1, D11).
 *
 * The route's month is the grid's **first row**, and the rows run from it
 * through the current month. Every link to it is built here, with an explicit
 * `Route` return type, so `typedRoutes` sees one cast in one place rather than
 * one at every call site.
 */

/** `/monthly/<first row>/history`. */
export const historyHref = (firstRow: string): Route => `/monthly/${firstRow}/history` as Route;

/** Back to one month's own page, optionally at an anchor on it. */
export const monthlyHref = (month: string, anchor?: string): Route =>
  `/monthly/${month}${anchor === undefined ? '' : `#${anchor}`}` as Route;

/** `YYYY-MM` shifted by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [year = '0', index = '1'] = month.split('-');
  const zeroBased = Number(year) * 12 + (Number(index) - 1) + by;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}

/**
 * The first row a link from the **current** month opens on (ADR 0011 D1):
 * twelve months back, so the grid shows twelve completed months and the
 * current month's disabled row.
 */
export const defaultHistoryStart = (currentMonth: string): string => shiftMonth(currentMonth, -12);

/**
 * The first row the `first_balance` action opens on (ADR 0011 D11): the year
 * before the month the account was first tracked, so the months it could not
 * be reconciled in are the ones on screen.
 */
export const firstBalanceHistoryStart = (firstTrackedMonth: string): string =>
  shiftMonth(firstTrackedMonth, -12);

/** Whether `value` is a month the grid can start from: `YYYY-MM`, completed. */
export function isHistoryStart(value: string, currentMonth: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(value) && value < currentMonth;
}
