import {
  addDays,
  bucketContributions,
  endOfMonthKey,
  isUnavailable,
  monthKey,
  plainDate,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  reportCashFlow,
  reportSourceOnly,
  startOfMonthKey,
  untrackedContributions,
  type BucketResult,
  type CurrencyCode,
  type FxTable,
  type Issue,
  type IssueKey,
  type MissingContributionInput,
  type MonthKey,
  type MtdBucketResult,
  type PlainDate,
  type ReportingAmount,
  type ReportingCashFlow,
  type ReportingContribution,
  type SourceOnlyReportingFigures,
  type UnavailableReason,
} from '@vaultide/finance';
import type { FxService } from '../fx/service';
import type { RequestContext } from '../context';
import { moneyDto } from '../positions/mapping';
import { readSettings } from '../settings/service';
import { ValidationError } from '../errors';
import {
  loadCompletedMonth,
  type CompletedMonthData,
  type MonthDataDependencies,
} from './loader';
import { loadMonthToDate, type MonthToDateData } from './mtd-loader';
import { loadCompletedRange } from './range-loader';
import type {
  MissingReportingContributionDto,
  MonthReportingCashFlowDto,
  MonthToDateReportingCashFlowDto,
  ReportingAmountDto,
  ReportingCashFlowFiguresDto,
  SourceOnlyReportingFiguresDto,
} from './types';

/**
 * Cash flow and savings in the user's reporting currency (12.3, 12.5, 8.11,
 * v2.1.13 30.16).
 *
 * Downstream of everything: reconciliation decides what happened to tracked
 * cash, the native savings layer classifies it, and this converts the same
 * scoped source facts and the native residual. Reconciliation knows nothing
 * about it and no reporting arithmetic lives here — the engine does that; this
 * loads rows, hands them one FX table, and serialises the answer.
 *
 * Rates come from what is already stored. This path calls no provider: a
 * conversion with no rate is honestly missing (10.5), and warming the cache
 * belongs to the write and cron paths that already do it.
 */

export interface ReportingDependencies extends MonthDataDependencies {
  readonly fx: Pick<FxService, 'loadTable'>;
}

/** The ten days `rateOn` may look back, so the earliest flow can find its rate. */
const FX_LEAD_DAYS = 10;

const amountDto = (
  amount: ReportingAmount,
): ReportingAmountDto => ({
  value: moneyDto(amount.value.amount.toString(), amount.value.currency),
  availability: amount.availability,
  missing: amount.missing.map(
    (item): MissingReportingContributionDto => ({
      currency: item.currency,
      reason: item.reason,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    }),
  ),
  ...(amount.quality === undefined ? {} : { quality: amount.quality }),
  provenance: { ...amount.provenance },
});

/** The two figures that needed no interval, whether or not there was one. */
function sourceOnlyDto(figures: SourceOnlyReportingFigures): SourceOnlyReportingFiguresDto {
  return {
    reportingCurrency: figures.reportingCurrency,
    additionalSpending: amountDto(figures.additionalSpending),
    thirdPartyPaid: amountDto(figures.thirdPartyPaid),
  };
}

function cashFlowDto(flow: ReportingCashFlow): ReportingCashFlowFiguresDto {
  const rate = flow.savingsRate;
  return {
    reportingCurrency: flow.reportingCurrency,
    externalIncome: amountDto(flow.externalIncome),
    knownConsumption: amountDto(flow.knownConsumption),
    propertyOperatingCosts: amountDto(flow.propertyOperatingCosts),
    interestAndFees: amountDto(flow.interestAndFees),
    transactionCosts: amountDto(flow.transactionCosts),
    externalOutflows: amountDto(flow.externalOutflows),
    unclassified: amountDto(flow.unclassified),
    consumption: amountDto(flow.consumption),
    trackedTotalSpending: amountDto(flow.trackedTotalSpending),
    additionalSpending: amountDto(flow.additionalSpending),
    thirdPartyPaid: amountDto(flow.thirdPartyPaid),
    trackedSavingsFromIncome: amountDto(flow.trackedSavingsFromIncome),
    personalSavings: amountDto(flow.personalSavings),
    totalSpending: amountDto(flow.totalSpending),
    savingsRate: isUnavailable(rate)
      ? { kind: 'unavailable', reason: rate.reason, ...(rate.detail === undefined ? {} : { detail: rate.detail }) }
      : { kind: 'ratio', value: rate.toString() },
    countsAdditionalSpending: flow.countsAdditionalSpending,
  };
}

/** One reconciled bucket, from either engine, with the causes each one records. */
type NativeBucket = BucketResult | MtdBucketResult;

/** 12.5's token for a bucket that never reached the identity, as Slice 9 named it. */
const RECONCILIATION_UNAVAILABLE = 'reconciliation_unavailable';

const raises = (bucket: NativeBucket, key: IssueKey): boolean =>
  bucket.issues.some((issue: Issue) => issue.key === key);

/**
 * Why a bucket's residual is not a spending figure, in that bucket's own words.
 *
 * The cause is read off the bucket, never inferred from its status alone. Both
 * engines already know it: the month-to-date one carries a dedicated
 * `missing_opening`, the completed one names its evidence failure
 * `missing_month_end` in 8.5's catalogue, and 7.6's vocabulary happens to have a
 * member for each. Passing the status and letting this layer guess would throw
 * away an answer that had already been worked out.
 *
 * `no_valuation` is never emitted from here, whatever the cause. It means one
 * thing in this repository — nothing has ever been recorded about a position's
 * value, which is what `positions/valuation` says when it returns it and what
 * net worth reports when it propagates it — and a missing statement, an
 * unusable opening, a flow with no account and an excluded account are four
 * other things. Where 7.6 has no member for the cause, the generic
 * derived-result fallback carries the native key in `detail` instead of
 * borrowing a reason that already means something else.
 *
 * `detail` keeps 12.5's category token wherever the bucket simply never reached
 * the identity, so a reader that only knows Slice 9's two words still
 * understands it.
 */
function residualGap(
  bucket: NativeBucket,
): { reason: UnavailableReason; detail: string } | undefined {
  // An unresolved bucket computed an identity that contradicts itself, which is
  // an answer rather than an evidence failure, and is settled before any of the
  // causes below (30.12).
  if (bucket.status === 'unresolved') {
    return { reason: 'not_applicable', detail: 'unresolved' };
  }
  if (bucket.status !== 'unavailable') return undefined;

  // Fixed precedence, decided by looking each key up rather than by reading
  // whichever issue the engine happened to raise first, so the order of
  // `issues` cannot change the answer.
  if ('reason' in bucket && bucket.reason === 'missing_opening') {
    return { reason: 'missing_opening', detail: RECONCILIATION_UNAVAILABLE };
  }
  if (raises(bucket, 'missing_month_end')) {
    return { reason: 'missing_month_end', detail: RECONCILIATION_UNAVAILABLE };
  }
  if (raises(bucket, 'flow_without_cash_account')) {
    return { reason: 'not_applicable', detail: 'flow_without_cash_account' };
  }
  if (raises(bucket, 'first_balance')) {
    return { reason: 'not_applicable', detail: 'first_balance' };
  }
  // No cause the engines can currently produce is missing from the list above,
  // so this makes no claim rather than inventing one.
  return { reason: 'not_applicable', detail: RECONCILIATION_UNAVAILABLE };
}

interface BuiltMonth {
  readonly contributions: ReportingContribution[];
  readonly missing: MissingContributionInput[];
  readonly currencies: Set<string>;
}

/**
 * Every contribution one month makes, from its buckets and from the currencies
 * that have only untracked rows.
 *
 * A currency with no cash account has no bucket and none is invented for it
 * (30.15 item 3, 30.16 item 9); its `untracked_self` and `third_party` rows are
 * real, so they convert at their own dates into the figures they belong to and
 * into nothing else.
 */
function buildMonth(
  input: CompletedMonthData['input'] | MonthToDateData['input'],
  // The engines' own result types, not a structural subset of them: the subset
  // this used to take had no `issues` and no `reason` in it, so the causes those
  // carry were dropped before anything could read them.
  buckets: readonly NativeBucket[],
  month: MonthKey,
  from: PlainDate,
  to: PlainDate,
): BuiltMonth {
  const contributions: ReportingContribution[] = [];
  const missing: MissingContributionInput[] = [];
  const currencies = new Set<string>();

  for (const bucket of buckets) {
    currencies.add(bucket.currency);
    const gap = residualGap(bucket);
    const built = bucketContributions({
      records: input,
      expenses: input.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month,
      from,
      to,
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
      ...(gap === undefined ? {} : { residualReason: gap.reason, residualDetail: gap.detail }),
    });
    contributions.push(...built.contributions);
    missing.push(...built.missing);
  }

  for (const expense of input.expenses) {
    if (currencies.has(expense.currency)) continue;
    if (expense.settlement !== 'untracked_self' && expense.settlement !== 'third_party') continue;
    currencies.add(expense.currency);
    contributions.push(...untrackedContributions(input.expenses, expense.currency, from, to));
  }

  return { contributions, missing, currencies };
}

/** One FX table for every currency and every date the month could need. */
async function loadRates(
  deps: ReportingDependencies,
  currencies: ReadonlySet<string>,
  reporting: string,
  from: PlainDate,
  to: PlainDate,
  today: PlainDate,
): Promise<FxTable> {
  const quotes = [...new Set([...currencies, reporting])];
  return deps.fx.loadTable(quotes, addDays(from, -FX_LEAD_DAYS), to, today);
}

/** A completed month's cash flow, from rows already loaded. */
export function monthReportingFrom(
  data: CompletedMonthData,
  fx: FxTable,
  reporting: CurrencyCode,
  countAdditionalSpending: boolean,
): MonthReportingCashFlowDto {
  const month = data.input.month;
  const result = reconcileCompletedMonth(data.input);
  const built = buildMonth(
    data.input,
    result.buckets,
    month,
    startOfMonthKey(month),
    endOfMonthKey(month),
  );

  return {
    month: (month as string).slice(0, 7),
    monthStatus: result.monthStatus,
    ...cashFlowDto(
      reportCashFlow({
        reportingCurrency: reporting,
        fx,
        contributions: built.contributions,
        missing: built.missing,
        countAdditionalSpending,
      }),
    ),
  };
}

/** The currencies a month could need converted, without loading any rate. */
function currenciesOf(
  input: CompletedMonthData['input'] | MonthToDateData['input'],
): Set<string> {
  const currencies = new Set<string>();
  for (const account of input.cashAccounts) currencies.add(account.position.currency);
  for (const flow of input.income) currencies.add(flow.currency);
  for (const flow of input.expenses) currencies.add(flow.currency);
  for (const flow of input.transfers) {
    currencies.add(flow.fromCurrency);
    currencies.add(flow.toCurrency);
  }
  return currencies;
}

/** The two settings a cash-flow report depends on (12.5, 30.16). */
export interface ReportingSettings {
  readonly reportingCurrency: string;
  readonly countAdditionalSpending: boolean;
}

/**
 * A completed month's cash flow from rows already loaded, reading the one FX
 * table its figures need.
 *
 * `getMonthReportingCashFlow` is exactly this after its own load, so a
 * composite read that already holds the month gets the same answer from it.
 */
export async function completedReportingFrom(
  deps: ReportingDependencies,
  data: CompletedMonthData,
  settings: ReportingSettings,
  today: PlainDate,
): Promise<MonthReportingCashFlowDto> {
  const month = data.input.month;
  const fx = await loadRates(
    deps,
    currenciesOf(data.input),
    settings.reportingCurrency,
    startOfMonthKey(month),
    endOfMonthKey(month),
    today,
  );

  return monthReportingFrom(
    data,
    fx,
    settings.reportingCurrency as CurrencyCode,
    settings.countAdditionalSpending,
  );
}

export async function getMonthReportingCashFlow(
  deps: ReportingDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthReportingCashFlowDto> {
  if (endOfMonthKey(month) >= plainDate(ctx.today)) {
    throw new ValidationError('That month is not over yet.', {
      month: ['Cash flow can only be reported once the month has ended.'],
    });
  }

  const [data, settings] = await Promise.all([
    loadCompletedMonth(deps, ctx.userId, month, ctx.today),
    readSettings(deps.db, ctx.userId),
  ]);

  return completedReportingFrom(deps, data, settings, plainDate(ctx.today));
}

/**
 * The current month's cash flow, through `D`.
 *
 * With no `D` there is no month-to-date interval (8.6), and therefore no tracked
 * arithmetic to do: the result is the other variant of the union, carrying the
 * engine's own reason and the two untracked settlements only. Those two never
 * needed the interval — they carry no cash role and were never scoped — so they
 * run through today, and `sourceOnlyThrough` says so (30.15 item 3, 30.16 item
 * 6).
 *
 * Nothing tracked is built in that case, not even a zero. Feeding an empty
 * contribution list to `reportCashFlow` would produce fifteen exact zeroes,
 * `TotalSpending` equal to `AdditionalSpending` and a negative `PersonalSavings`
 * — every one of them an assertion the month is in no position to make.
 */
export async function getMonthToDateReportingCashFlow(
  deps: ReportingDependencies,
  ctx: RequestContext,
): Promise<MonthToDateReportingCashFlowDto> {
  const [data, settings] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, plainDate(ctx.today)),
    readSettings(deps.db, ctx.userId),
  ]);

  return monthToDateReportingFrom(deps, data, settings, plainDate(ctx.today));
}

/**
 * The current month's cash flow from rows already loaded, through `D` — or,
 * without a `D`, the two untracked settlements through today and nothing
 * tracked at all.
 *
 * `getMonthToDateReportingCashFlow` is exactly this after its own load, so a
 * composite read that already holds the month gets the same answer from it.
 */
export async function monthToDateReportingFrom(
  deps: ReportingDependencies,
  data: MonthToDateData,
  settings: ReportingSettings,
  today: PlainDate,
): Promise<MonthToDateReportingCashFlowDto> {
  const month = monthKey(today);
  const from = startOfMonthKey(month);
  const key = (month as string).slice(0, 7);
  const result = reconcileMonthToDate(data.input);
  const reporting = settings.reportingCurrency as CurrencyCode;

  if (result.asOf === null) {
    const currencies = currenciesOf(data.input);
    const fx = await loadRates(deps, currencies, reporting, from, today, today);
    return {
      kind: 'no_tracked_interval',
      month: key,
      asOf: null,
      reason: result.reason,
      monthStatus: result.status,
      sourceOnlyThrough: today,
      ...sourceOnlyDto(
        reportSourceOnly({
          reportingCurrency: reporting,
          fx,
          contributions: [...currencies].flatMap((currency) =>
            untrackedContributions(data.input.expenses, currency as CurrencyCode, from, today),
          ),
        }),
      ),
    };
  }

  const asOf = result.asOf;
  const built = buildMonth(data.input, result.buckets, month, from, asOf);
  const fx = await loadRates(deps, built.currencies, reporting, from, asOf, today);

  return {
    kind: 'tracked_interval',
    month: key,
    asOf,
    monthStatus: result.status,
    sourceOnlyThrough: asOf,
    ...cashFlowDto(
      reportCashFlow({
        reportingCurrency: reporting,
        fx,
        contributions: built.contributions,
        missing: built.missing,
        countAdditionalSpending: settings.countAdditionalSpending,
      }),
    ),
  };
}

/**
 * One reporting result per completed month in the range, oldest first.
 *
 * Not a rolling average and deliberately not: each month keeps its own status
 * and its own field availability, which is exactly what a later rolling slice
 * needs in order to decide eligibility without recomputing anything (30.15
 * item 5). Nothing is averaged, no gap is filled, and no span is divided.
 */
export async function getCompletedReportingCashFlowSeries(
  deps: ReportingDependencies,
  ctx: RequestContext,
  range: { readonly from: MonthKey; readonly to: MonthKey },
): Promise<readonly MonthReportingCashFlowDto[]> {
  if (range.to < range.from) return [];
  if (endOfMonthKey(range.to) >= plainDate(ctx.today)) {
    throw new ValidationError('That range reaches into a month that is not over yet.', {
      to: ['A cash-flow series covers completed months only.'],
    });
  }

  const [data, settings] = await Promise.all([
    loadCompletedRange(deps, ctx.userId, range.from, range.to, ctx.today),
    readSettings(deps.db, ctx.userId),
  ]);

  const currencies = new Set<string>();
  for (const input of data.inputs.values()) {
    for (const code of currenciesOf(input)) currencies.add(code);
  }

  const fx = await loadRates(
    deps,
    currencies,
    settings.reportingCurrency,
    startOfMonthKey(range.from),
    endOfMonthKey(range.to),
    plainDate(ctx.today),
  );

  const reporting = settings.reportingCurrency as CurrencyCode;
  return data.months.map((month) => {
    const input = data.inputs.get(month);
    /* v8 ignore next -- every month in `months` was put in `inputs` beside it. */
    if (input === undefined) throw new Error(`no input for ${month}`);
    return monthReportingFrom(
      { input, positions: [], categories: [], templates: [], terms: [] },
      fx,
      reporting,
      settings.countAdditionalSpending,
    );
  });
}
