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
  startOfMonthKey,
  untrackedContributions,
  type CurrencyCode,
  type Decimal,
  type FxTable,
  type MissingContributionInput,
  type MonthKey,
  type PlainDate,
  type ReportingAmount,
  type ReportingCashFlow,
  type ReportingContribution,
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

function cashFlowDto(flow: ReportingCashFlow): Omit<MonthReportingCashFlowDto, 'month' | 'monthStatus'> {
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

/** Why a bucket's residual is not a spending figure, in that bucket's own words. */
function residualGap(
  status: string,
): { reason: UnavailableReason; detail: string } | undefined {
  if (status === 'unresolved') {
    return { reason: 'not_applicable', detail: 'unresolved' };
  }
  if (status === 'unavailable') {
    return { reason: 'no_valuation', detail: 'reconciliation_unavailable' };
  }
  return undefined;
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
  buckets: readonly {
    readonly currency: CurrencyCode;
    readonly status: string;
    readonly accounts: readonly { readonly positionId: string; readonly excludedFirstBalance: boolean }[];
    readonly totals: { readonly unclassified?: Decimal | undefined };
  }[],
  month: MonthKey,
  from: PlainDate,
  to: PlainDate,
): BuiltMonth {
  const contributions: ReportingContribution[] = [];
  const missing: MissingContributionInput[] = [];
  const currencies = new Set<string>();

  for (const bucket of buckets) {
    currencies.add(bucket.currency);
    const gap = residualGap(bucket.status);
    const built = bucketContributions({
      records: input,
      expenses: input.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month,
      from,
      to,
      status: bucket.status as Parameters<typeof bucketContributions>[0]['status'],
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

  const fx = await loadRates(
    deps,
    currenciesOf(data.input),
    settings.reportingCurrency,
    startOfMonthKey(month),
    endOfMonthKey(month),
    plainDate(ctx.today),
  );

  return monthReportingFrom(
    data,
    fx,
    settings.reportingCurrency as CurrencyCode,
    settings.countAdditionalSpending,
  );
}

/**
 * The current month's cash flow, through `D`.
 *
 * With no `D` there is no month-to-date interval (8.6), so there are no tracked
 * figures at all — and the two untracked settlements, which never needed the
 * interval, are reported through today instead with `sourceOnlyThrough` saying
 * which cut-off was used (30.15 item 3, 30.16 item 6).
 */
export async function getMonthToDateReportingCashFlow(
  deps: ReportingDependencies,
  ctx: RequestContext,
): Promise<MonthToDateReportingCashFlowDto> {
  const [data, settings] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, plainDate(ctx.today)),
    readSettings(deps.db, ctx.userId),
  ]);

  const today = plainDate(ctx.today);
  const month = monthKey(today);
  const from = startOfMonthKey(month);
  const result = reconcileMonthToDate(data.input);
  const asOf = result.asOf;
  const through = asOf ?? today;
  const reporting = settings.reportingCurrency as CurrencyCode;

  const built =
    asOf === null
      ? {
          // No interval, so no bucket and no tracked contribution: only the two
          // settlements, over the month so far.
          contributions: [...currenciesOf(data.input)].flatMap((currency) =>
            untrackedContributions(data.input.expenses, currency as CurrencyCode, from, today),
          ),
          missing: [] as MissingContributionInput[],
          currencies: currenciesOf(data.input),
        }
      : buildMonth(data.input, result.buckets, month, from, asOf);

  const fx = await loadRates(deps, built.currencies, reporting, from, through, today);

  return {
    month: (month as string).slice(0, 7),
    asOf,
    monthStatus: result.status,
    sourceOnlyThrough: through,
    hasTrackedInterval: asOf !== null,
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
