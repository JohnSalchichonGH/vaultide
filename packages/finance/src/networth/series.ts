import {
  addMonths,
  endOfMonth,
  monthKey,
  startOfMonth,
  type PlainDate,
} from '../dates/plain-date';
import type { FxTable } from '../fx/types';
import type { CurrencyCode } from '../money/types';
import type { PositionWithValuations } from '../positions/types';
import { netWorthAt } from './engine';
import type { NetWorthSeriesPoint } from './types';

/**
 * The net-worth history series (blueprint 15.4, 12.1).
 *
 * One point per month end, plus the current month as a **provisional** point
 * dated today rather than at a month end that has not happened. 15.4 draws that
 * last point hollow for exactly this reason: it is a real figure about a real
 * date, but it is not a month's closing value and must not be read as one.
 *
 * Every point is the same engine at a different date, so a point can be
 * partial, and the chart says which ones are.
 */

export interface NetWorthSeriesInput {
  readonly positions: readonly PositionWithValuations[];
  readonly reportingCurrency: CurrencyCode | string;
  readonly fx: FxTable;
  /** Today in the user's timezone. No engine reads a clock (7.7). */
  readonly today: PlainDate;
  /** How many completed months to include before the current one. */
  readonly months: number;
}

/** The month-end dates of the last `months` completed months, oldest first. */
export function completedMonthEnds(today: PlainDate, months: number): PlainDate[] {
  const ends: PlainDate[] = [];
  // The current month is not complete, so the newest month end is the previous
  // month's — which is also the newest date a `month_end` balance may exist for.
  for (let index = months; index >= 1; index -= 1) {
    ends.push(endOfMonth(addMonths(startOfMonth(today), -index)));
  }
  return ends;
}

export function netWorthSeries(input: NetWorthSeriesInput): NetWorthSeriesPoint[] {
  const dates = completedMonthEnds(input.today, input.months);

  const points: NetWorthSeriesPoint[] = dates.map((asOf) => {
    const result = netWorthAt({
      positions: input.positions,
      asOf,
      reportingCurrency: input.reportingCurrency,
      fx: input.fx,
    });
    return {
      asOf,
      provisional: false,
      totalNetWorth: result.totalNetWorth,
      financialNetWorth: result.financialNetWorth,
    };
  });

  const current = netWorthAt({
    positions: input.positions,
    asOf: input.today,
    reportingCurrency: input.reportingCurrency,
    fx: input.fx,
  });

  points.push({
    asOf: input.today,
    // True whenever today is not itself a month end: the point is "where things
    // stand", not "how the month closed".
    provisional: input.today !== endOfMonth(input.today),
    totalNetWorth: current.totalNetWorth,
    financialNetWorth: current.financialNetWorth,
  });

  return points;
}

/** The month a series point belongs to, for labelling. */
export function seriesPointMonth(point: NetWorthSeriesPoint): string {
  return monthKey(point.asOf).slice(0, 7);
}
