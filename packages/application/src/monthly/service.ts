import { findMonthReview } from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  startOfMonthKey,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import { minorUnitsByCurrency } from '../currencies/service';
import { readSettings } from '../settings/service';
import { monthCompletenessFrom } from '../reconciliation/completeness-service';
import type { LoadedCompletedMonth } from '../reconciliation/loader';
import { loadMonthToDate } from '../reconciliation/mtd-loader';
import { monthToDateFrom } from '../reconciliation/mtd-service';
import { loadCompletedRange } from '../reconciliation/range-loader';
import { completedReportingFrom, monthToDateReportingFrom } from '../reconciliation/reporting-service';
import {
  monthReconciliationFrom,
  reconciliationRangeStart,
  type ReconciliationDependencies,
} from '../reconciliation/service';
import { reviewDtoOf } from './review-service';
import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  MonthlyNavigationDto,
  MonthlyPageDto,
} from './types';

/**
 * The Monthly page's read (blueprint 15.2, 15.3, 23.2).
 *
 * One call per page, one load of the month. The completed variant reads the
 * `M−6 … M` range the reconciliation read already uses and hands the same rows
 * to reconciliation, reporting and completeness through their own `…From`
 * helpers — each the exact code path behind its standalone read, so the page
 * shows precisely what those reads would, the `large_unclassified` baseline and
 * the `possible_missing_conversion` signature included. The current variant
 * reads the month-to-date window once and does the same with its two reads.
 *
 * Nothing is computed here. The review state comes back beside the results and
 * is applied by the page's presentation, never by any result: a dismissed key
 * is still in every issue list this returns.
 *
 * The bound is a constant number of user-scoped repository transactions — the
 * loader's, one for settings, one for the currency catalogue, one for the
 * review, and the exchange-rate reads the reporting and diagnostic rules
 * already make — whatever the size of the month.
 */

export type MonthlyDependencies = ReconciliationDependencies;

const label = (month: MonthKey): string => (month as string).slice(0, 7);

function navigationOf(month: MonthKey, current: MonthKey): MonthlyNavigationDto {
  return {
    previous: label(monthKey(addMonths(startOfMonthKey(month), -1))),
    next: month === current ? null : label(monthKey(addMonths(startOfMonthKey(month), 1))),
    current: label(current),
  };
}

export async function getMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthlyPageDto> {
  const current = monthKey(ctx.today);
  if (month > current) {
    // A month that has not begun has no evidence of any kind; answering with an
    // empty result would be a synthetic one.
    throw new ValidationError('That month has not started yet.', {
      month: ['Monthly covers completed months and the current month.'],
    });
  }

  const base = {
    month: label(month),
    monthEndsOn: endOfMonthKey(month) as string,
    today: ctx.today as string,
    navigation: navigationOf(month, current),
  };

  return month === current
    ? currentMonthlyPage(deps, ctx, base)
    : completedMonthlyPage(deps, ctx, month, base);
}

type PageBase = Pick<CompletedMonthlyPageDto, 'month' | 'monthEndsOn' | 'today' | 'navigation'>;

async function completedMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  month: MonthKey,
  base: PageBase,
): Promise<CompletedMonthlyPageDto> {
  const [range, settings, review, minorUnits] = await Promise.all([
    loadCompletedRange(deps, ctx.userId, reconciliationRangeStart(month), month, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    minorUnitsByCurrency(deps.db),
  ]);

  const input = range.inputs.get(month);
  /* v8 ignore next -- the range ends at `month`, so its input is always there. */
  if (input === undefined) throw new Error(`no input for ${month}`);

  // The month as the single-month loader would have shaped it, from the same
  // rows: the range slices flows on the month's bounds, and completeness reads
  // the whole window's positions, valued to the month's end.
  const data: LoadedCompletedMonth = {
    input,
    positions: range.positions,
    categories: range.categories,
    templates: range.templates,
    terms: range.terms,
    positionsWithValuations: range.positionsWithValuations,
  };

  const [reconciliation, reporting] = await Promise.all([
    monthReconciliationFrom(deps, range, month, ctx.today),
    completedReportingFrom(deps, data, settings, ctx.today),
  ]);

  return {
    kind: 'completed',
    ...base,
    minorUnitsByCurrency: minorUnits,
    review: reviewDtoOf(review),
    reconciliation,
    reporting,
    completeness: monthCompletenessFrom(data),
  };
}

async function currentMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  base: PageBase,
): Promise<CurrentMonthlyPageDto> {
  const month = monthKey(ctx.today);
  const [data, settings, review, minorUnits] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    minorUnitsByCurrency(deps.db),
  ]);

  return {
    kind: 'current',
    ...base,
    minorUnitsByCurrency: minorUnits,
    review: reviewDtoOf(review),
    monthToDate: monthToDateFrom(data),
    reporting: await monthToDateReportingFrom(deps, data, settings, ctx.today),
  };
}
