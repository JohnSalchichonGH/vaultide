import {
  addMonths,
  buildRollingTrackedSpendingSeries,
  money,
  monthKey,
  startOfMonthKey,
  type MonthKey,
  type RollingAverage,
  type RollingTrackedSpendingObservation,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { moneyDto } from '../positions/mapping';
import { parseMonth } from './service';
import { getCompletedReportingCashFlowSeries, type ReportingDependencies } from './reporting-service';
import type {
  MonthReportingCashFlowDto,
  RollingAverageDto,
  RollingTrackedSpendingPointDto,
} from './types';

/**
 * Rolling 3/6/12-month tracked spending in the reporting currency (blueprint
 * 15.2, 15.5, v2.1.12 30.15 item 5, v2.1.13 30.16 item 11).
 *
 * A consumer of the completed reporting series, and nothing more. That series
 * was built with exactly this reader in mind: one result per completed month,
 * each carrying its own overall status and its own per-figure availability, so
 * eligibility can be decided here without recomputing anything. This function
 * loads it **once**, narrows every month to the three facts rolling needs, and
 * hands them to the pure calculator. It reads no flow, classifies nothing,
 * converts nothing, and never asks for a span or a month-to-date figure.
 *
 * The one thing it adds is history. A truthful twelve-month average for the
 * first display month needs the eleven completed months before it, so the
 * series is read from `from − 11` — that is the calculation window 30.15
 * defines, not a reach further back than it. Those eleven months are read and
 * never returned.
 */

/** How far before the first display month a 12-month window begins. */
const CALCULATION_LEAD_MONTHS = 11;

const averageDto = (average: RollingAverage | null): RollingAverageDto | null =>
  average === null
    ? null
    : {
        value: moneyDto(average.value.amount.toString(), average.value.currency),
        count: average.count,
      };

/**
 * The three facts a completed month contributes to eligibility and value.
 *
 * Read off the series DTO rather than recomputed: the month's overall status is
 * 8.4's worst across buckets as the series already stated it, and the figure's
 * availability and exact decimal string are the ones the series serialised.
 * Nothing else on the month — additional spending, the savings rate, a memo's
 * missing rate — is carried, so nothing else can reach the decision.
 */
function observationOf(month: MonthReportingCashFlowDto): RollingTrackedSpendingObservation {
  return {
    month: parseMonth(month.month),
    monthStatus: month.monthStatus,
    trackedTotalSpending: {
      value: money(month.trackedTotalSpending.value.amount, month.trackedTotalSpending.value.currency),
      availability: month.trackedTotalSpending.availability,
    },
  };
}

/**
 * One point per completed display month in `[from, to]`, oldest first.
 *
 * Completed months only: the boundary is the series' own, so a range reaching
 * into the current month is refused there rather than answered here with a
 * provisional observation.
 */
export async function getRollingTrackedSpendingSeries(
  deps: ReportingDependencies,
  ctx: RequestContext,
  range: { readonly from: MonthKey; readonly to: MonthKey },
): Promise<readonly RollingTrackedSpendingPointDto[]> {
  if (range.to < range.from) return [];

  const calculationFrom = monthKey(addMonths(startOfMonthKey(range.from), -CALCULATION_LEAD_MONTHS));
  const series = await getCompletedReportingCashFlowSeries(deps, ctx, {
    from: calculationFrom,
    to: range.to,
  });

  const [first] = series;
  /* v8 ignore next -- a non-inverted range always yields at least one month. */
  if (first === undefined) return [];
  const reportingCurrency = first.reportingCurrency;

  const points = buildRollingTrackedSpendingSeries(series.map(observationOf), range);
  return points.map((point) => ({
    month: (point.month as string).slice(0, 7),
    reportingCurrency,
    rolling3: averageDto(point.rolling3),
    rolling6: averageDto(point.rolling6),
    rolling12: averageDto(point.rolling12),
  }));
}
