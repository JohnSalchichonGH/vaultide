import { addMonths, monthKey, startOfMonthKey, type MonthKey } from '../dates/plain-date';
import { add, div } from '../money/money';
import type { Money } from '../money/types';
import type { ReconciliationStatus } from '../reconciliation/types';
import type { ReportingAmount } from './aggregate';

/**
 * Rolling averages of reporting-currency tracked spending (blueprint 15.2,
 * 15.5, v2.1.12 30.15 item 5, v2.1.13 30.16 item 11).
 *
 * Phase 3 rolls one series — `TrackedTotalSpending` in the reporting currency
 * — over fixed windows of 3, 6 and 12 **calendar** months ending at a completed
 * display month. This is arithmetic over observations that were already
 * measured, converted and judged; it reads no flow, no rate, no span and no
 * month-to-date figure, and it decides nothing about a month except whether the
 * month's own verdict lets it into the mean.
 *
 * Two rules do the whole job:
 *
 *  - **The window is calendar, not count.** For display month `M` and `N`, the
 *    window is exactly `M−(N−1) … M`. A month that does not qualify keeps its
 *    calendar seat and is not replaced by reaching further back — a three-month
 *    average never quietly becomes a nine-month lookback (30.15 item 5).
 *  - **A month qualifies on two conditions and nothing else.** Its overall
 *    month status (8.4's worst across buckets) is `reliable`, and its reporting
 *    `TrackedTotalSpending` is `available`. A partial reporting total is a
 *    number nobody measured and is never averaged; FX provenance — a dated
 *    fallback, an average rate, an `estimatedConversion` flag — says how a rate
 *    was found, not that data is missing, and never disqualifies (30.16 item 11).
 *
 * The mean is arithmetic, unweighted and unrounded; a February and a March each
 * weigh one. With no survivors the average is absent; with one it is that
 * observation; with any it carries how many it is over, because a three-month
 * window holding one observation must be able to say so. No minimum count is
 * imposed. A qualifying zero is an observation. `is_one_off` is not consulted:
 * that exclusion belongs to the projection baseline (13.6), and this layer only
 * sees a month's total.
 */

/** The three windows Phase 3 defines, in the order the result presents them. */
export const ROLLING_WINDOWS = [3, 6, 12] as const;
export type RollingWindow = (typeof ROLLING_WINDOWS)[number];

/**
 * One completed month as the rolling series sees it.
 *
 * Deliberately the narrowest shape that decides eligibility and carries a
 * value: the month, its overall status, and its reporting tracked-spending
 * figure's availability and value. No other figure is here, so an unconvertible
 * memo or an unavailable savings rate cannot reach the decision; and a span or a
 * month-to-date result is not expressible in it, because neither has one
 * `month` and a completed-month status of its own to offer. A full
 * `ReportingAmount` satisfies the figure structurally.
 */
export interface RollingTrackedSpendingObservation {
  readonly month: MonthKey;
  /** 8.4's worst-across-buckets status for the month. */
  readonly monthStatus: ReconciliationStatus;
  readonly trackedTotalSpending: Pick<ReportingAmount, 'value' | 'availability'>;
}

/** A present average, and how many qualifying months it is over. */
export interface RollingAverage {
  readonly value: Money;
  /** `1 … N`. Never zero: with no survivors there is no average to carry it. */
  readonly count: number;
}

/**
 * One display month's three windows.
 *
 * `null` is "no month in this window qualified", which is a different fact from
 * an average of zero over months that did. Both are stated as themselves.
 */
export interface RollingTrackedSpendingPoint {
  readonly month: MonthKey;
  readonly rolling3: RollingAverage | null;
  readonly rolling6: RollingAverage | null;
  readonly rolling12: RollingAverage | null;
}

export interface RollingRange {
  /** The first display month wanted. Not where the calculation begins. */
  readonly from: MonthKey;
  readonly to: MonthKey;
}

/** Raised when two observations claim the same month: neither may silently win. */
export class DuplicateObservationError extends Error {
  readonly code = 'DUPLICATE_OBSERVATION';
  constructor(readonly month: MonthKey) {
    super(`Two rolling observations were given for ${month}; a month has one completed result.`);
    this.name = 'DuplicateObservationError';
  }
}

/**
 * The eligibility rule, in one place (30.15 item 5, 30.16 item 11).
 *
 * `reliable` excludes `estimated`, `unresolved`, `unavailable` and the
 * provisional current month; `available` excludes a partial or unavailable
 * reporting total. Nothing about provenance, quality or missing-list length is
 * consulted, and nothing about any other figure of the month.
 */
export function isRollingEligible(observation: RollingTrackedSpendingObservation): boolean {
  return (
    observation.monthStatus === 'reliable' &&
    observation.trackedTotalSpending.availability === 'available'
  );
}

const shiftMonth = (month: MonthKey, count: number): MonthKey =>
  monthKey(addMonths(startOfMonthKey(month), count));

/** The `N` calendar months ending at `last`, oldest first. */
function windowEndingAt(last: MonthKey, size: RollingWindow): MonthKey[] {
  const months: MonthKey[] = [];
  for (let offset = size - 1; offset >= 0; offset -= 1) months.push(shiftMonth(last, -offset));
  return months;
}

/**
 * The unweighted mean of the qualifying observations in one window.
 *
 * Exact Decimal throughout: the sum is exact, and the division is the engine's
 * working-precision quotient with no financial rounding on top of it (7.3 puts
 * rounding at the display boundary). `add` refuses to mix currencies, so a
 * stray observation in the wrong currency fails loudly rather than averaging.
 */
function averageOf(
  byMonth: ReadonlyMap<MonthKey, RollingTrackedSpendingObservation>,
  window: readonly MonthKey[],
): RollingAverage | null {
  const values: Money[] = [];
  for (const month of window) {
    const observation = byMonth.get(month);
    if (observation !== undefined && isRollingEligible(observation)) {
      values.push(observation.trackedTotalSpending.value);
    }
  }

  const [first, ...rest] = values;
  if (first === undefined) return null;
  const total = rest.reduce(add, first);
  return { value: div(total, values.length), count: values.length };
}

/**
 * One point per calendar month of `[from, to]`, oldest first.
 *
 * Observations may — and for a truthful first point, must — extend up to eleven
 * months before `from`: that is the calculation history the windows read, and it
 * is not returned. Observations later than `to` are ignored. Input order is
 * irrelevant, because months are looked up by key; a month given twice is an
 * error, because the completed series has exactly one result per month and
 * letting position decide which to keep would be a silent choice.
 *
 * The display month itself is a window boundary, not a required survivor: an
 * `estimated` June still gets a June point, averaged over whichever of April and
 * May qualified. Only a month that is not yet complete has no place here, and
 * that is the caller's boundary to hold — this function reads no clock.
 */
export function buildRollingTrackedSpendingSeries(
  observations: readonly RollingTrackedSpendingObservation[],
  range: RollingRange,
): RollingTrackedSpendingPoint[] {
  const byMonth = new Map<MonthKey, RollingTrackedSpendingObservation>();
  for (const observation of observations) {
    if (byMonth.has(observation.month)) throw new DuplicateObservationError(observation.month);
    byMonth.set(observation.month, observation);
  }

  const points: RollingTrackedSpendingPoint[] = [];
  for (let month = range.from; month <= range.to; month = shiftMonth(month, 1)) {
    points.push({
      month,
      rolling3: averageOf(byMonth, windowEndingAt(month, 3)),
      rolling6: averageOf(byMonth, windowEndingAt(month, 6)),
      rolling12: averageOf(byMonth, windowEndingAt(month, 12)),
    });
  }
  return points;
}
