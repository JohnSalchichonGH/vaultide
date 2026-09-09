import {
  classifyBucketInterval,
  endOfMonthKey,
  isUnavailable,
  monthKey,
  plainDate,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  reconcileSavings,
  startOfMonthKey,
  type Decimal,
  type MonthKey,
  type PlainDate,
  type SavingsResult,
  type Unavailable,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { moneyDto } from '../positions/mapping';
import { readSettings } from '../settings/service';
import { ValidationError } from '../errors';
import { loadCompletedMonth, type CompletedMonthData, type MonthDataDependencies } from './loader';
import { loadMonthToDate, type MonthToDateData } from './mtd-loader';
import type {
  MonthSavingsDto,
  MonthToDateSavingsDto,
  NativeSavingsDto,
  SavingsRateDto,
  SourceOnlySpendingDto,
} from './types';

/**
 * Savings and the spending decomposition, read from the database (12.3, 12.5,
 * 23.2, v2.1.12 30.15).
 *
 * A thin composition and deliberately nothing more. Reconciliation decides what
 * happened to tracked cash; the finance savings module classifies the amounts it
 * established; this file loads the rows, hands both the same window, and
 * serializes the answer. No arithmetic of its own — a second implementation of
 * 12.5 living next to a read model is exactly how two screens start disagreeing.
 *
 * The classification is scoped through 8.1's own predicate, from the bucket's
 * own account list, so the set classified here is the set the identity summed:
 * an account excluded as `first_balance` contributes no income and no cost, for
 * the same reason it contributed no `ΣI` (30.15 item 3).
 *
 * Nothing is stored (5.3) and nothing is converted: reporting-currency
 * aggregation is a later slice and no rate is read here.
 */

export type SavingsDependencies = MonthDataDependencies;

const amountDto = (value: Decimal, currency: string): ReturnType<typeof moneyDto> =>
  moneyDto(value.toString(), currency);

function rateDto(rate: Decimal | Unavailable): SavingsRateDto {
  return isUnavailable(rate)
    ? { kind: 'unavailable', reason: rate.reason }
    : { kind: 'ratio', value: rate.toString() };
}

function savingsDto(result: SavingsResult): NativeSavingsDto {
  const currency = result.currency;
  const money = (value: Decimal): ReturnType<typeof moneyDto> => amountDto(value, currency);
  const { source, derived } = result;

  return {
    currency,
    reconciliationStatus: result.reconciliationStatus,
    source: {
      externalIncome: money(source.externalIncome),
      knownConsumption: money(source.knownConsumption),
      propertyOperatingCosts: money(source.propertyOperatingCosts),
      interestAndFees: money(source.interestAndFees),
      transactionCosts: money(source.transactionCosts),
      externalOutflows: money(source.externalOutflows),
      additionalSpending: money(source.additionalSpending),
      thirdPartyPaid: money(source.thirdPartyPaid),
    },
    derived:
      derived.kind === 'available'
        ? {
            kind: 'available',
            quality: derived.quality,
            consumption: money(derived.consumption),
            trackedSavingsFromIncome: money(derived.trackedSavingsFromIncome),
            personalSavings: money(derived.personalSavings),
            totalSpending: money(derived.totalSpending),
            savingsRate: rateDto(derived.savingsRate),
            countsAdditionalSpending: derived.countsAdditionalSpending,
          }
        : { kind: 'unavailable', because: derived.because },
  };
}

/** The engine input both loaders produce, in the shape the classifier needs. */
interface ClassifiableInput {
  readonly income: CompletedMonthData['input']['income'];
  readonly expenses: CompletedMonthData['input']['expenses'];
  readonly transfers: CompletedMonthData['input']['transfers'];
}

/** One bucket's savings, over the interval its own figures used. */
function savingsForBucket(
  input: ClassifiableInput,
  bucket: {
    readonly currency: string;
    readonly status: NativeSavingsDto['reconciliationStatus'];
    readonly accounts: readonly { readonly positionId: string; readonly excludedFirstBalance: boolean }[];
    readonly totals: {
      readonly knownTrackedExpenses: Decimal;
      readonly trackedTotalSpending?: Decimal | undefined;
      readonly unclassified?: Decimal | undefined;
    };
  },
  from: PlainDate,
  to: PlainDate,
  countAdditionalSpending: boolean,
): NativeSavingsDto {
  const currency = bucket.currency as Parameters<typeof classifyBucketInterval>[2];
  const classified = classifyBucketInterval(
    input,
    input.expenses,
    currency,
    bucket.accounts,
    from,
    to,
  );

  return savingsDto(
    reconcileSavings({
      currency,
      reconciliation: {
        status: bucket.status,
        knownTrackedExpenses: bucket.totals.knownTrackedExpenses,
        trackedTotalSpending: bucket.totals.trackedTotalSpending,
        unclassified: bucket.totals.unclassified,
      },
      externalIncome: classified.externalIncome,
      nonConsumptionCosts: classified.nonConsumptionCosts,
      additionalSpending: classified.additionalSpending,
      thirdPartyPaid: classified.thirdPartyPaid,
      countAdditionalSpending,
    }),
  );
}

/**
 * The currencies in which the user recorded untracked spending but reconciles
 * nothing, over `[from, to]`.
 *
 * Absence of a bucket is not absence of the spending: `untracked_self` and
 * `third_party` have no cash role, so they need no cash account and can name a
 * currency the reconciliation never saw. They are reported as themselves, in
 * currency order, and nothing derived is invented for them.
 */
function sourceOnlySpending(
  input: ClassifiableInput,
  reconciled: ReadonlySet<string>,
  from: PlainDate,
  to: PlainDate,
): SourceOnlySpendingDto[] {
  const currencies = new Set(
    input.expenses
      .filter(
        (expense) =>
          (expense.settlement === 'untracked_self' || expense.settlement === 'third_party') &&
          expense.incurredOn >= from &&
          expense.incurredOn <= to &&
          !reconciled.has(expense.currency),
      )
      .map((expense) => expense.currency as string),
  );

  return [...currencies].sort().map((code) => {
    const currency = code as Parameters<typeof classifyBucketInterval>[2];
    // No bucket, so no account is in scope; the tracked classification is
    // empty by construction and only the two settlements survive.
    const classified = classifyBucketInterval(input, input.expenses, currency, [], from, to);
    return {
      currency: code,
      additionalSpending: amountDto(classified.additionalSpending, code),
      thirdPartyPaid: amountDto(classified.thirdPartyPaid, code),
    };
  });
}

/**
 * A completed month's savings from rows already loaded.
 *
 * Exported so a later composite read — the Monthly Overview, the Spending
 * series — can have both the reconciliation and the savings from one window
 * instead of loading the month twice.
 */
export function monthSavingsFrom(
  data: CompletedMonthData,
  countAdditionalSpending: boolean,
): MonthSavingsDto {
  const month = data.input.month;
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  const result = reconcileCompletedMonth(data.input);

  return {
    month: (month as string).slice(0, 7),
    buckets: result.buckets.map((bucket) =>
      savingsForBucket(data.input, bucket, from, to, countAdditionalSpending),
    ),
    sourceOnlyByCurrency: sourceOnlySpending(
      data.input,
      new Set(result.buckets.map((bucket) => bucket.currency as string)),
      from,
      to,
    ),
  };
}

/**
 * The current month's savings from rows already loaded.
 *
 * With a common date the tracked figures and the two settlements both stop at
 * it. Without one there is no interval to derive anything from, so there are no
 * buckets at all — and the settlements, which never needed the interval, are
 * reported through today instead, with `sourceOnlyThrough` saying which it was
 * (30.15 item 3).
 */
export function monthToDateSavingsFrom(
  data: MonthToDateData,
  today: PlainDate,
  countAdditionalSpending: boolean,
): MonthToDateSavingsDto {
  const month = monthKey(today);
  const from = startOfMonthKey(month);
  const result = reconcileMonthToDate(data.input);
  const asOf = result.asOf;
  const through = asOf ?? today;

  const buckets =
    asOf === null
      ? null
      : result.buckets.map((bucket) =>
          savingsForBucket(data.input, bucket, from, asOf, countAdditionalSpending),
        );

  return {
    month: (month as string).slice(0, 7),
    asOf,
    buckets,
    sourceOnlyByCurrency: sourceOnlySpending(
      data.input,
      new Set((buckets ?? []).map((bucket) => bucket.currency)),
      from,
      through,
    ),
    sourceOnlyThrough: through,
  };
}

/**
 * A completed month's savings.
 *
 * Reuses the completed-month loader rather than adding a second one: one bulk
 * read of the window, plus the user's setting. The count does not grow with the
 * number of accounts, flows, categories or currencies.
 */
export async function getMonthSavings(
  deps: SavingsDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthSavingsDto> {
  // The same rule 8.1 gives reconciliation: a month is completed when today is
  // past its last day. Savings never reach into a month that has not ended.
  if (endOfMonthKey(month) >= plainDate(ctx.today)) {
    throw new ValidationError('That month is not over yet.', {
      month: ['Savings can only be computed once the month has ended.'],
    });
  }

  const [data, settings] = await Promise.all([
    loadCompletedMonth(deps, ctx.userId, month, ctx.today),
    readSettings(deps.db, ctx.userId),
  ]);

  return monthSavingsFrom(data, settings.countAdditionalSpending);
}

/** The current month's savings, through the date the evidence reaches. */
export async function getMonthToDateSavings(
  deps: SavingsDependencies,
  ctx: RequestContext,
): Promise<MonthToDateSavingsDto> {
  const [data, settings] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, ctx.today),
    readSettings(deps.db, ctx.userId),
  ]);

  return monthToDateSavingsFrom(data, plainDate(ctx.today), settings.countAdditionalSpending);
}
