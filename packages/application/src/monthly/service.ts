import { findMonthReview } from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  plainDate,
  startOfMonthKey,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import { currencyCatalogue } from '../currencies/service';
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
import { completedAccountsOf, currentAccountsOf } from './accounts';
import { currentMonthlyIncomeOf, monthlyIncomeOf } from './income';
import { loadCompletedMonthIncome, loadCurrentMonthIncome } from './income-loader';
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
 * The Accounts section is built from the same loaded rows — the positions and
 * valuations the reconciliation read — so it adds no read of its own.
 *
 * Nothing is computed here. The review state comes back beside the results and
 * is applied by the page's presentation, never by any result: a dismissed key
 * is still in every issue list this returns.
 *
 * The Income section adds exactly one read, and only what no other read can
 * answer: the rows behind the occurrences **scheduled** in the month. Its
 * financial half — the entries received in the month — is the same income the
 * loaders already read, handed on rather than fetched again (15.3 section 2).
 *
 * The bound is a constant number of user-scoped repository transactions — the
 * loader's, one for the Income rows, one for settings, one for the currency
 * catalogue, one for the review, and the exchange-rate reads the reporting and
 * diagnostic rules already make — whatever the size of the month.
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
  const [range, settings, review, currencies] = await Promise.all([
    loadCompletedRange(deps, ctx.userId, reconciliationRangeStart(month), month, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    // One catalogue read answers both questions the page has of it: how to
    // format every amount, and which currencies a picker may offer.
    currencyCatalogue(deps.db),
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

  // The month's own income entries, by financial date, sliced from the range
  // the loader already read — the same rows, never a second query.
  const receivedInMonth = range.income.filter(
    (row) => row.receivedOn >= (startOfMonthKey(month) as string) && row.receivedOn <= base.monthEndsOn,
  );

  const [reconciliation, reporting, incomeRows] = await Promise.all([
    monthReconciliationFrom(deps, range, month, ctx.today),
    completedReportingFrom(deps, data, settings, ctx.today),
    loadCompletedMonthIncome(
      deps,
      ctx.userId,
      month,
      receivedInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
    ),
  ]);

  return {
    kind: 'completed',
    ...base,
    minorUnitsByCurrency: currencies.minorUnitsByCurrency,
    selectableCurrencyCodes: currencies.selectableCurrencyCodes,
    review: reviewDtoOf(review),
    reconciliation,
    reporting,
    completeness: monthCompletenessFrom(data),
    accounts: completedAccountsOf(month, range.positionsWithValuations, range.valuations),
    income: monthlyIncomeOf({
      month,
      today: plainDate(ctx.today),
      receivedInMonth,
      // Archived included: `archived_at` is present-tense visibility and never a
      // schedule boundary, so a source archived today still expected an
      // occurrence last September (§30.10, 12.6).
      scheduleTemplates: range.templates,
      terms: range.terms,
      positions: range.positions,
      rows: incomeRows,
      shape: 'completed',
    }),
  };
}

async function currentMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  base: PageBase,
): Promise<CurrentMonthlyPageDto> {
  const month = monthKey(ctx.today);
  const [data, settings, review, currencies] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    currencyCatalogue(deps.db),
  ]);

  // Everything the month-to-date read holds is already dated on or before
  // today, and no actual record may be dated later (M5), so these are all of
  // the month's income entries there can be.
  const receivedInMonth = data.income;
  const incomeRows = await loadCurrentMonthIncome(
    deps,
    ctx.userId,
    month,
    plainDate(ctx.today),
    receivedInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
  );

  return {
    kind: 'current',
    ...base,
    minorUnitsByCurrency: currencies.minorUnitsByCurrency,
    selectableCurrencyCodes: currencies.selectableCurrencyCodes,
    review: reviewDtoOf(review),
    monthToDate: monthToDateFrom(data),
    reporting: await monthToDateReportingFrom(deps, data, settings, ctx.today),
    accounts: currentAccountsOf(ctx.today, data.input.cashAccounts, data.valuations),
    income: currentMonthlyIncomeOf({
      month,
      today: plainDate(ctx.today),
      receivedInMonth,
      // The operational feed's set: an archived source offers no new suggestion,
      // and the resolved occurrences it already has stay visible (§30.10).
      scheduleTemplates: incomeRows.activeTemplates,
      terms: incomeRows.operationalTerms,
      positions: data.positions,
      rows: incomeRows,
      shape: 'current',
    }),
  };
}
