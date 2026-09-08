import {
  addMonths,
  daysInMonth,
  plainDate,
  startOfMonth,
  type PlainDate,
} from '../dates/plain-date';

/**
 * Recurring occurrence generation (blueprint 6.2, v2.1.6 §30.9 item 3).
 *
 * Pure and deterministic: the same template and the same range always produce
 * the same list. Nothing here is a financial fact — an occurrence becomes real
 * only when the user accepts it, and the row that results carries the
 * occurrence's date as its scheduling identity.
 *
 * ## Fixed anchor, clamped per month
 *
 * The anchor day is `day_of_month`, or `start_date`'s day when that is NULL.
 * For each target month the day is `min(anchor, daysInMonth(target))`, computed
 * **from the anchor** every time.
 *
 * Deriving the next occurrence by adding a month to the previous one would look
 * equivalent and is not: `addMonths` clamps, so a 31st anchor becomes 28 Feb in
 * February and then stays on the 28th for ever. The bug is silent — every date
 * is a real date, the sequence is still monthly, and a user only notices that
 * their salary suggestion has drifted a few days earlier. So the previous
 * occurrence is never an input here.
 *
 * ## Bounds
 *
 * The first target month is `start_date`'s, which for a template starting on
 * the 20th with an anchor of the 5th contains a date before the template
 * existed. Such an occurrence is discarded and the anchor does **not** move: the
 * sequence is 5 Feb, 5 Mar, …, not 20 Jan or 20 Feb. `end_date` truncates the
 * same way.
 */

export const RECURRENCE_FREQUENCIES = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

const MONTHS_PER_PERIOD: Readonly<Record<RecurrenceFrequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface RecurrenceSchedule {
  readonly frequency: RecurrenceFrequency;
  /** 1–31, or `null` to take `start_date`'s day. */
  readonly dayOfMonth: number | null;
  readonly startDate: PlainDate;
  readonly endDate: PlainDate | null;
}

/** The period length in months. Exported so callers need not restate the map. */
export function monthsPerPeriod(frequency: RecurrenceFrequency): number {
  return MONTHS_PER_PERIOD[frequency];
}

function dayOf(date: PlainDate): number {
  return Number.parseInt(date.slice(8, 10), 10);
}

function yearOf(date: PlainDate): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

function monthOf(date: PlainDate): number {
  return Number.parseInt(date.slice(5, 7), 10);
}

/** The anchor day a schedule uses (6.2). */
export function anchorDay(schedule: RecurrenceSchedule): number {
  return schedule.dayOfMonth ?? dayOf(schedule.startDate);
}

/**
 * The occurrence in the `index`-th period after the schedule's first target
 * month, before the start/end bounds are applied. Exposed for tests that pin
 * the clamping itself.
 */
export function occurrenceAt(schedule: RecurrenceSchedule, index: number): PlainDate {
  const firstTargetMonth = startOfMonth(schedule.startDate);
  const targetMonth = addMonths(firstTargetMonth, index * monthsPerPeriod(schedule.frequency));
  const day = Math.min(anchorDay(schedule), daysInMonth(yearOf(targetMonth), monthOf(targetMonth)));
  return plainDate(
    `${targetMonth.slice(0, 8)}${String(day).padStart(2, '0')}`,
  );
}

/**
 * Every occurrence of a schedule that falls within `[from, to]`.
 *
 * Ordered, unique, and bounded by the template's own dates as well as by the
 * requested range.
 */
export function occurrencesInRange(
  schedule: RecurrenceSchedule,
  from: PlainDate,
  to: PlainDate,
): PlainDate[] {
  if (from > to) return [];

  const step = monthsPerPeriod(schedule.frequency);
  const firstTargetMonth = startOfMonth(schedule.startDate);
  const lastMonth = startOfMonth(to);

  // How many whole periods separate the first target month from the last month
  // the caller asked about. Generating past it can only produce dates after
  // `to`, and a clamped day never moves an occurrence into a later month.
  const monthSpan =
    (yearOf(lastMonth) - yearOf(firstTargetMonth)) * 12 +
    (monthOf(lastMonth) - monthOf(firstTargetMonth));
  if (monthSpan < 0) return [];

  const occurrences: PlainDate[] = [];
  for (let index = 0; index * step <= monthSpan; index += 1) {
    const date = occurrenceAt(schedule, index);

    // Discard rather than shift: the anchor is fixed, so a discarded occurrence
    // does not move the ones after it (§30.9 item 3).
    if (date < schedule.startDate) continue;
    if (schedule.endDate !== null && date > schedule.endDate) break;
    if (date > to) continue;
    if (date < from) continue;

    occurrences.push(date);
  }

  return occurrences;
}

/**
 * The first occurrence a schedule ever has, if it has one at all.
 *
 * At most one period can be discarded by the start bound: the next period's
 * occurrence is a whole period later than the first target month, so it cannot
 * also precede `start_date`.
 */
export function firstOccurrence(schedule: RecurrenceSchedule): PlainDate | undefined {
  for (let index = 0; index <= 1; index += 1) {
    const date = occurrenceAt(schedule, index);
    if (date < schedule.startDate) continue;
    if (schedule.endDate !== null && date > schedule.endDate) return undefined;
    return date;
  }
  /* v8 ignore next -- unreachable: the second candidate is always >= start. */
  return undefined;
}

/**
 * The earliest scheduled occurrence after `today` that nothing has resolved yet
 * (blueprint 30.10).
 *
 * This is the bound on early materialization — "received today" reaches this
 * occurrence and no other. It is deliberately **not** a horizon in days or
 * months: the schedule already knows the right answer, and any fixed window
 * would be too short for an annual source whose genuine next payment is eight
 * months away and too long for a monthly one.
 *
 * What it protects is the sequence. Letting somebody claim November while
 * October is still unresolved would leave a hole that completeness (12.6) then
 * reports for ever, and no later action can tell whether October was missed or
 * never happened. Taking the first unresolved occurrence means a user can always
 * record what actually arrived early, and can never step over an earlier one.
 *
 * `resolved` holds the occurrence dates already carrying a materialized flow or
 * a skip row. The search is bounded by that set rather than by a constant: at
 * most `resolved.size` future candidates can be resolved, so the answer is found
 * within one more than that, or `end_date` ends the schedule first.
 */
export function nextUnresolvedOccurrence(
  schedule: RecurrenceSchedule,
  today: PlainDate,
  resolved: ReadonlySet<string>,
): PlainDate | undefined {
  const step = monthsPerPeriod(schedule.frequency);
  const firstTargetMonth = startOfMonth(schedule.startDate);
  const todayMonth = startOfMonth(today);

  const monthSpan =
    (yearOf(todayMonth) - yearOf(firstTargetMonth)) * 12 +
    (monthOf(todayMonth) - monthOf(firstTargetMonth));

  // Start a whole period before today's month so a day clamped backwards inside
  // its month is never skipped over.
  let index = Math.max(0, Math.floor(monthSpan / step) - 1);
  let futureChecked = 0;

  for (;;) {
    const date = occurrenceAt(schedule, index);
    index += 1;

    if (schedule.endDate !== null && date > schedule.endDate) return undefined;
    // Dates increase with the index, so both of these stop being true.
    if (date < schedule.startDate) continue;
    if (date <= today) continue;

    if (!resolved.has(date)) return date;

    futureChecked += 1;
    /* v8 ignore next -- unreachable: only `resolved.size` candidates can match. */
    if (futureChecked > resolved.size) return undefined;
  }
}
