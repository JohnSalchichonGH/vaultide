import { z } from 'zod';

/**
 * Financial dates (blueprint 7.7, M5, R15, R17, D43).
 *
 * Two rules live here and nowhere in the database, because they depend on the
 * moving present and a CHECK constraint must express a timeless row invariant:
 *
 *  - no **actual** record may be dated after today in the user's timezone;
 *  - a `month_end` balance for month M may be written only once `today > end(M)`.
 *
 * `today` is always supplied by the caller from the request context, never read
 * from the process clock, so a bypassed client is judged by the server's rule.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Any valid calendar date, past or future (terms and scenario dates use this). */
export const plainDate = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter a real calendar date (YYYY-MM-DD).');

/** The last day of the month a date belongs to. */
export function endOfMonth(date: string): string {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new RangeError(`"${date}" is not a calendar date.`);
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  return `${match[1] as string}-${match[2] as string}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

export function isMonthEnd(date: string): boolean {
  return date === endOfMonth(date);
}

/**
 * A date for an **actual** record: never after today (M5, R17).
 * ISO dates compare correctly as strings, so no parsing is involved.
 */
export function plainDateNotAfter(today: string) {
  return plainDate.refine(
    (value) => value <= today,
    'This date is in the future. Records can only be dated up to today.',
  );
}

/** A date that must fall on or after a given day (e.g. a position's opening). */
export function plainDateNotBefore(earliest: string) {
  return plainDate.refine((value) => value >= earliest, `This date cannot be before ${earliest}.`);
}

export interface MonthEndValuationInput {
  readonly valuedOn: string;
  readonly datePrecision: 'exact' | 'month_end';
}

/**
 * A valuation date plus its precision, judged against today (R15, M5):
 *
 *  - the date may not be in the future;
 *  - `month_end` requires the date to be the month's last day **and** the month
 *    to be over, so on 30 September a September month-end balance is refused
 *    and on 1 October it is accepted.
 */
export function valuationDateSchema(today: string) {
  return z
    .object({
      valuedOn: plainDate,
      datePrecision: z.enum(['exact', 'month_end']).default('exact'),
    })
    .superRefine((value, ctx) => {
      if (value.valuedOn > today) {
        ctx.addIssue({
          code: 'custom',
          path: ['valuedOn'],
          message: 'This date is in the future. Balances can only be dated up to today.',
        });
        return;
      }
      if (value.datePrecision !== 'month_end') return;

      if (!isMonthEnd(value.valuedOn)) {
        ctx.addIssue({
          code: 'custom',
          path: ['valuedOn'],
          message: 'A month-end balance must be dated the last day of its month.',
        });
        return;
      }
      if (today <= value.valuedOn) {
        ctx.addIssue({
          code: 'custom',
          path: ['datePrecision'],
          message:
            'This month has not ended yet. Enter the end-of-month balance from the first day of the next month.',
        });
      }
    });
}

/** A month, addressed as `YYYY-MM`. */
export const monthKey = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Enter a month as YYYY-MM.');

/** An IANA time zone the runtime actually knows. */
export const timeZone = z
  .string()
  .trim()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid time zone.');

/** A BCP 47 locale tag the runtime can format with. */
export const locale = z
  .string()
  .trim()
  .refine((value) => {
    try {
      return Intl.NumberFormat.supportedLocalesOf([value]).length > 0;
    } catch {
      return false;
    }
  }, 'Choose a valid locale.');
