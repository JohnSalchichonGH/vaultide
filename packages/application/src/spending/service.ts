import {
  addMonths,
  endOfMonthKey,
  isRollingEligible,
  knownSpendingItems,
  monthKey,
  plainDate,
  rankKnownSpending,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  startOfMonthKey,
  sumKnownSpending,
  trackedKindOfCategory,
  type BucketResult,
  type CurrencyCode,
  type FlowRecords,
  type KnownSpendingItem,
  type MonthKey,
  type MonthReconciliation,
  type MonthToDateResult,
  type MtdBucketResult,
  type ReportingAmount,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import { expenseFormOptionsOf } from '../monthly/expenses';
import { moneyDto } from '../positions/mapping';
import { monthToDateInputOf } from '../reconciliation/mtd-loader';
import { completedMonthInputsOf, monthsInRange } from '../reconciliation/range-loader';
import {
  currenciesOf,
  loadReportingRates,
  monthReportingOf,
  monthToDateReportingOf,
  reportingAmountDto,
  type ReportingDependencies,
} from '../reconciliation/reporting-service';
import { rollingObservationOf, rollingPointsFrom } from '../reconciliation/rolling-service';
import { parseMonth } from '../reconciliation/service';
import { spansFrom } from '../reconciliation/span-service';
import type {
  MissingReportingContributionDto,
  MonthReportingCashFlowDto,
  MonthToDateReportingCashFlowDto,
  RollingAverageDto,
} from '../reconciliation/types';
import { loadSpendingData, type SpendingData } from './loader';
import type {
  SpendingBucketDto,
  SpendingCategoriesDto,
  SpendingCategoryRowDto,
  SpendingFocusDto,
  SpendingHistoryRowDto,
  SpendingIntervalDto,
  SpendingLargestKnownDto,
  SpendingLargestRowDto,
  SpendingPageDto,
  SpendingRollingDto,
  SpendingSpanDto,
} from './types';

/**
 * The standalone Spending page's read (blueprint 15.2 "Spending", 8.x, 12.5,
 * 30.15, 30.16, 30.20; ADR 0008).
 *
 * One call, one shared load (`loadSpendingData`), then the existing engines in
 * memory: completed-month reconciliation for every history month, month to date
 * for the current one, the reporting month over one FX table, the rolling
 * engine, spans, and the known-spending breakdown. Every figure is the engine's,
 * with the engine's availability; nothing here adds, splits or averages a money
 * amount itself.
 *
 * The page's months:
 *
 *  - the **focus** month — the last completed month by default, or any month up
 *    to the current one from `?month=`;
 *  - the **history** window — twelve completed calendar months ending at the
 *    focus when it is completed, else at the last completed month, plus the
 *    current month when the window ends at the last completed one;
 *  - the **rolling** display month, the history window's last completed month
 *    (ADR 0008 §2).
 */

export type SpendingDependencies = ReportingDependencies;

export interface SpendingQuery {
  /** `YYYY-MM`, from the address. Absent means the last completed month. */
  readonly month?: string | undefined;
}

/** How many completed months the history window holds — the longest rolling window. */
const HISTORY_MONTHS = 12;

/** The default length of the largest-known list (ADR 0008 §6). */
const LARGEST_KNOWN = 5;

const ROLLING = [3, 6, 12] as const;

const label = (month: MonthKey): string => (month as string).slice(0, 7);
const shift = (month: MonthKey, count: number): MonthKey => monthKey(addMonths(startOfMonthKey(month), count));

/** The focus month, or a validation error for one that is not a month or has not begun. */
function focusMonthOf(query: SpendingQuery, current: MonthKey): MonthKey {
  if (query.month === undefined) return shift(current, -1);
  const month = parseMonth(query.month);
  if (month > current) {
    // A month that has not begun has no evidence of any kind; answering with an
    // empty result would be a synthetic one.
    throw new ValidationError('That month has not started yet.', {
      month: ['Spending covers completed months and the current month.'],
    });
  }
  return month;
}

/** Why one bucket could not be reconciled, read off the bucket, in a fixed order. */
function bucketDtoOf(
  bucket: BucketResult | MtdBucketResult,
  names: ReadonlyMap<string, string>,
): SpendingBucketDto {
  const raised = (key: string): boolean => bucket.issues.some((issue) => issue.key === key);
  let cause: SpendingBucketDto['cause'] = null;
  if (bucket.status === 'unavailable') {
    if ('reason' in bucket && bucket.reason === 'missing_opening') cause = 'missing_opening';
    else if (raised('missing_month_end')) cause = 'missing_month_end';
    else if (raised('flow_without_cash_account')) cause = 'flow_without_cash_account';
    else if (raised('first_balance')) cause = 'first_balance';
    else cause = 'unknown';
  }

  const missing = new Set<string>();
  for (const issue of bucket.issues) {
    if (issue.key !== 'missing_month_end' || issue.positionId === undefined) continue;
    missing.add(names.get(issue.positionId) ?? 'An account');
  }

  const inflow = bucket.issues.find((issue) => issue.key === 'unexplained_inflow');
  return {
    currency: bucket.currency,
    status: bucket.status,
    cause,
    accountsMissingEvidence: [...missing],
    firstBalanceAccounts: bucket.accounts
      .filter((account) => account.excludedFirstBalance)
      .map((account) => account.name),
    unexplainedInflow:
      inflow?.amount === undefined
        ? null
        : { amount: moneyDto(inflow.amount.toString(), bucket.currency), variant: inflow.variant ?? 'a' },
  };
}

const missingDto = (amount: ReportingAmount): MissingReportingContributionDto[] =>
  amount.missing.map((item) => ({
    currency: item.currency,
    reason: item.reason,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }));

/** One history row from a completed month's reporting result. */
function completedRow(
  reporting: MonthReportingCashFlowDto,
  observed: boolean,
  spans: readonly string[],
): SpendingHistoryRowDto {
  return {
    month: reporting.month,
    shape: 'completed',
    status: reporting.monthStatus,
    observed,
    asOf: null,
    rollingEligible: isRollingEligible(rollingObservationOf(reporting)),
    spans,
    tracked: reporting.trackedTotalSpending,
    known: reporting.knownTrackedSpending,
    unclassified: reporting.unclassified,
    additional: reporting.additionalSpending,
    total: reporting.totalSpending,
    thirdPartyPaid: reporting.thirdPartyPaid,
    savingsRate: reporting.savingsRate,
  };
}

/** The current month's history row. It is never a rolling observation (8.6). */
function currentRow(reporting: MonthToDateReportingCashFlowDto): SpendingHistoryRowDto {
  if (reporting.kind === 'no_tracked_interval') {
    return {
      month: reporting.month,
      shape: 'current',
      status: reporting.monthStatus,
      observed: false,
      asOf: null,
      rollingEligible: false,
      spans: [],
      tracked: null,
      known: null,
      unclassified: null,
      additional: reporting.additionalSpending,
      total: null,
      thirdPartyPaid: reporting.thirdPartyPaid,
      savingsRate: null,
    };
  }
  return {
    month: reporting.month,
    shape: 'current',
    status: reporting.monthStatus,
    observed: true,
    asOf: reporting.asOf,
    rollingEligible: false,
    spans: [],
    tracked: reporting.trackedTotalSpending,
    known: reporting.knownTrackedSpending,
    unclassified: reporting.unclassified,
    additional: reporting.additionalSpending,
    total: reporting.totalSpending,
    thirdPartyPaid: reporting.thirdPartyPaid,
    savingsRate: reporting.savingsRate,
  };
}

/**
 * Categories and the largest known rows of the focus interval (ADR 0008 §6, §7).
 *
 * Both read the one breakdown, whose rows are the reporting figures' own
 * contributions; nothing here classifies an expense a second way.
 */
function breakdownOf(args: {
  readonly items: readonly KnownSpendingItem[];
  readonly data: SpendingData;
  readonly reporting: CurrencyCode;
  readonly trackedInterval: SpendingIntervalDto | null;
  readonly additionalInterval: SpendingIntervalDto;
  readonly figures: {
    readonly knownTrackedSpending: SpendingCategoriesDto['knownTrackedSpending'];
    readonly unclassified: SpendingCategoriesDto['unclassified'];
    readonly additionalSpending: SpendingCategoriesDto['additionalSpending'];
  };
  readonly sourceOnly: boolean;
}): { readonly categories: SpendingCategoriesDto; readonly largestKnown: SpendingLargestKnownDto } {
  const { items, data, reporting } = args;
  const rowsById = new Map(data.expenseRows.map((row) => [row.id, row]));
  const categoriesById = new Map(data.categories.map((row) => [row.id, row]));
  const accountNames = new Map(data.positions.map((row) => [row.id, row.name]));

  const itemsByCategory = new Map<string, KnownSpendingItem[]>();
  for (const item of items) {
    const row = rowsById.get(item.sourceId);
    /* v8 ignore next -- every item comes from a loaded expense row. */
    if (row === undefined) continue;
    const list = itemsByCategory.get(row.categoryId);
    if (list === undefined) itemsByCategory.set(row.categoryId, [item]);
    else list.push(item);
  }

  const sumOrNull = (list: readonly KnownSpendingItem[]) =>
    list.length === 0 ? null : reportingAmountDto(sumKnownSpending(list, reporting));

  // The user's own category order, from the read; a category appears once it
  // holds a row of the interval.
  const rows: SpendingCategoryRowDto[] = [];
  const totals = new Map<string, ReportingAmount>();
  for (const category of data.categories) {
    const list = itemsByCategory.get(category.id);
    if (list === undefined) continue;
    const total = sumKnownSpending(list, reporting);
    totals.set(category.id, total);
    rows.push({
      categoryId: category.id,
      name: category.name,
      archived: category.archivedAt !== null,
      group: trackedKindOfCategory(category.kind),
      trackedKnown: sumOrNull(list.filter((item) => item.kind !== 'additional')),
      additional: sumOrNull(list.filter((item) => item.kind === 'additional')),
      total: reportingAmountDto(total),
    });
  }

  const complete = [...totals.values()].every((total) => total.availability === 'available');
  if (complete) {
    // Stable: equal totals keep the user's order.
    rows.sort((a, b) => {
      const x = totals.get(a.categoryId);
      const y = totals.get(b.categoryId);
      /* v8 ignore next -- every row's total was recorded beside it. */
      if (x === undefined || y === undefined) return 0;
      return y.value.amount.comparedTo(x.value.amount);
    });
  }

  const all = sumKnownSpending(items, reporting);
  const ranking = rankKnownSpending(items, LARGEST_KNOWN);
  const rowOf = (item: KnownSpendingItem): SpendingLargestRowDto => {
    const row = rowsById.get(item.sourceId);
    const category = row === undefined ? undefined : categoriesById.get(row.categoryId);
    return {
      entryId: item.sourceId,
      kind: item.kind,
      categoryName: category?.name ?? 'Unknown category',
      description: row?.description ?? null,
      incurredOn: item.on,
      cashAccountName:
        row?.cashPositionId === null || row?.cashPositionId === undefined
          ? null
          : (accountNames.get(row.cashPositionId) ?? null),
      native: moneyDto(item.native.amount.toString(), item.native.currency),
      reporting: reportingAmountDto(item.reporting),
    };
  };

  return {
    categories: {
      trackedInterval: args.trackedInterval,
      additionalInterval: args.additionalInterval,
      order: complete ? 'amount' : 'category',
      rows,
      knownTrackedSpending: args.figures.knownTrackedSpending,
      unclassified: args.figures.unclassified,
      additionalSpending: args.figures.additionalSpending,
      missing: missingDto(all),
    },
    largestKnown: {
      interval: args.trackedInterval ?? args.additionalInterval,
      mode: items.length === 0 ? 'none' : args.sourceOnly ? 'source_only' : ranking.mode,
      perNativeCurrency: ranking.mode === 'per_native_currency',
      groups:
        items.length === 0
          ? []
          : ranking.groups.map((group) => ({ currency: group.currency, rows: group.items.map(rowOf) })),
      missing: missingDto(all),
    },
  };
}

export async function getSpendingPage(
  deps: SpendingDependencies,
  ctx: RequestContext,
  query: SpendingQuery = {},
): Promise<SpendingPageDto> {
  const today = plainDate(ctx.today);
  const current = monthKey(today);
  const lastCompleted = shift(current, -1);
  const focus = focusMonthOf(query, current);
  const focusIsCurrent = focus === current;

  const historyTo = focusIsCurrent ? lastCompleted : focus;
  const historyFrom = shift(historyTo, -(HISTORY_MONTHS - 1));
  const withCurrent = historyTo === lastCompleted;
  const flowsFrom = startOfMonthKey(historyFrom);
  const flowsTo = withCurrent ? today : endOfMonthKey(historyTo);

  const data = await loadSpendingData(deps, {
    userId: ctx.userId,
    today,
    historyFrom,
    historyTo,
    flowsFrom,
    flowsTo,
  });
  const reporting = data.settings.reportingCurrency as CurrencyCode;
  const names = new Map(data.positions.map((row) => [row.id, row.name]));

  // Every completed month of the window, reconciled once each. No template is
  // passed: `suggested_income_missing` is an advisory, which moves no status and
  // no figure, and Spending shows no completeness (8.4, 8.5).
  const months = monthsInRange(historyFrom, historyTo);
  const inputs = completedMonthInputsOf({
    months,
    today: ctx.today,
    cashAccounts: data.cashAccounts,
    income: data.flows.income,
    expenses: data.flows.expenses,
    transfers: data.flows.transfers,
    templates: [],
    resolvedOccurrences: new Set<string>(),
  });
  const results = new Map<MonthKey, MonthReconciliation>();
  for (const [month, input] of inputs) results.set(month, reconcileCompletedMonth(input));

  const mtdInput = withCurrent
    ? monthToDateInputOf({
        today,
        cashAccounts: data.cashAccounts,
        income: data.flows.income,
        expenses: data.flows.expenses,
        transfers: data.flows.transfers,
      })
    : null;
  const mtd: MonthToDateResult | null = mtdInput === null ? null : reconcileMonthToDate(mtdInput);

  // One rate table for every month and every currency on the page (10.2, 10.3).
  const currencies = new Set<string>();
  for (const input of inputs.values()) for (const code of currenciesOf(input)) currencies.add(code);
  if (mtdInput !== null) for (const code of currenciesOf(mtdInput)) currencies.add(code);
  const fx = await loadReportingRates(deps, currencies, reporting, flowsFrom, flowsTo, today);

  const monthly = months.map((month) => {
    const input = inputs.get(month);
    const result = results.get(month);
    /* v8 ignore next -- every month in `months` was put in both maps beside it. */
    if (input === undefined || result === undefined) throw new Error(`no input for ${month}`);
    return monthReportingOf(input, result, fx, reporting, data.settings.countAdditionalSpending);
  });
  const mtdReporting =
    mtdInput === null || mtd === null
      ? null
      : monthToDateReportingOf(mtdInput, mtd, fx, data.settings, today);

  // Spans, whole, in their own currency, over the flows the loader made sure
  // reach back to each one's start (ADR 0008 §8).
  const spans: SpendingSpanDto[] = spansFrom({
    today,
    cashAccounts: data.cashAccounts,
    income: data.spanFlows.income,
    expenses: data.spanFlows.expenses,
    transfers: data.spanFlows.transfers,
    from: historyFrom,
    through: historyTo,
  }).map((span) => ({ ...span, key: `${span.currency}:${span.from}` }));
  const spansOfMonth = new Map<string, string[]>();
  for (const span of spans) {
    for (const month of span.months) {
      const list = spansOfMonth.get(month);
      if (list === undefined) spansOfMonth.set(month, [span.key]);
      else list.push(span.key);
    }
  }

  const history: SpendingHistoryRowDto[] = months.map((month, index) => {
    const row = monthly[index];
    /* v8 ignore next -- `monthly` was mapped from `months`, one to one. */
    if (row === undefined) throw new Error(`no report for ${month}`);
    const observed = (results.get(month)?.buckets.length ?? 0) > 0;
    return completedRow(row, observed, spansOfMonth.get(row.month) ?? []);
  });
  if (mtdReporting !== null) history.push(currentRow(mtdReporting));

  // Rolling, from the months already reported (30.15 item 5).
  const [point] = rollingPointsFrom(monthly, { from: historyTo, to: historyTo }, reporting);
  const averages: Record<3 | 6 | 12, RollingAverageDto | null> = {
    3: point?.rolling3 ?? null,
    6: point?.rolling6 ?? null,
    12: point?.rolling12 ?? null,
  };
  const rolling: SpendingRollingDto = {
    displayMonth: label(historyTo),
    endsBeforeFocus: focusIsCurrent,
    windows: ROLLING.map((size) => ({
      months: size,
      from: label(shift(historyTo, -(size - 1))),
      to: label(historyTo),
      average: averages[size],
    })),
  };

  // The focus month and the interval its known rows belong to.
  const focusStart = startOfMonthKey(focus);
  let focusDto: SpendingFocusDto;
  let records: FlowRecords;
  let buckets: readonly (BucketResult | MtdBucketResult)[];
  let trackedInterval: SpendingIntervalDto | null;
  let additionalInterval: SpendingIntervalDto;
  let sourceOnly = false;
  let figures: Parameters<typeof breakdownOf>[0]['figures'];

  if (!focusIsCurrent) {
    const input = inputs.get(focus);
    const result = results.get(focus);
    const reported = monthly.find((row) => row.month === label(focus));
    /* v8 ignore next -- a completed focus is the history window's last month. */
    if (input === undefined || result === undefined || reported === undefined) throw new Error('no focus month');
    const interval = { from: focusStart as string, to: endOfMonthKey(focus) as string };
    focusDto = {
      shape: 'completed',
      month: label(focus),
      status: result.monthStatus,
      observed: result.buckets.length > 0,
      interval,
      figures: reported,
      buckets: result.buckets.map((bucket) => bucketDtoOf(bucket, names)),
    };
    records = input;
    buckets = result.buckets;
    trackedInterval = result.buckets.length > 0 ? interval : null;
    additionalInterval = interval;
    figures = {
      knownTrackedSpending: result.buckets.length > 0 ? reported.knownTrackedSpending : null,
      unclassified: result.buckets.length > 0 ? reported.unclassified : null,
      additionalSpending: reported.additionalSpending,
    };
  } else {
    /* v8 ignore next -- the current month in focus always puts it in the history. */
    if (mtd === null || mtdInput === null || mtdReporting === null) throw new Error('no current month');
    records = mtdInput;
    if (mtd.asOf === null || mtdReporting.kind === 'no_tracked_interval') {
      focusDto = {
        shape: 'current',
        month: label(focus),
        status: 'unavailable',
        observed: false,
        asOf: null,
        reason: 'mtd_no_common_date',
        sourceOnly: {
          reportingCurrency: mtdReporting.reportingCurrency,
          additionalSpending: mtdReporting.additionalSpending,
          thirdPartyPaid: mtdReporting.thirdPartyPaid,
        },
        sourceOnlyThrough: today,
      };
      buckets = [];
      trackedInterval = null;
      additionalInterval = { from: focusStart, to: today };
      sourceOnly = true;
      figures = {
        knownTrackedSpending: null,
        unclassified: null,
        additionalSpending: mtdReporting.additionalSpending,
      };
    } else {
      const interval = { from: focusStart as string, to: mtd.asOf as string };
      focusDto = {
        shape: 'current',
        month: label(focus),
        status: mtd.status,
        observed: true,
        asOf: mtd.asOf,
        interval,
        figures: mtdReporting,
        buckets: mtd.buckets.map((bucket) => bucketDtoOf(bucket, names)),
        newerBalances: mtd.accountsWithNewerBalances.length > 0,
      };
      buckets = mtd.buckets;
      trackedInterval = interval;
      additionalInterval = interval;
      figures = {
        knownTrackedSpending: mtdReporting.knownTrackedSpending,
        unclassified: mtdReporting.unclassified,
        additionalSpending: mtdReporting.additionalSpending,
      };
    }
  }

  const items = knownSpendingItems({
    records,
    buckets,
    from: plainDate(additionalInterval.from),
    to: plainDate(additionalInterval.to),
    reportingCurrency: reporting,
    fx,
  });
  const { categories, largestKnown } = breakdownOf({
    items,
    data,
    reporting,
    trackedInterval,
    additionalInterval,
    figures,
    sourceOnly,
  });

  const form = expenseFormOptionsOf(data.categories, data.positions);

  return {
    month: label(focus),
    today: ctx.today,
    reportingCurrency: reporting,
    countsAdditionalSpending: data.settings.countAdditionalSpending,
    minorUnitsByCurrency: data.catalogue.minorUnitsByCurrency,
    selectableCurrencyCodes: data.catalogue.selectableCurrencyCodes,
    hasCashAccounts: data.positions.some((row) => row.kind === 'cash'),
    navigation: {
      previous: label(shift(focus, -1)),
      next: focusIsCurrent ? null : label(shift(focus, 1)),
      currentMonth: label(current),
      lastCompletedMonth: label(lastCompleted),
    },
    focus: focusDto,
    rolling,
    history,
    spans,
    categories,
    largestKnown,
    expenseForm: {
      bounds: {
        min: focusStart,
        max: focusIsCurrent ? ctx.today : endOfMonthKey(focus),
      },
      eligibleCategories: form.eligibleCategories,
      cashAccounts: form.cashAccounts,
    },
  };
}
