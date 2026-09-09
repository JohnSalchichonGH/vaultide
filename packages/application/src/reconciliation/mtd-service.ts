import {
  reconcileMonthToDate,
  type Decimal,
  type Issue,
  type MonthToDateResult,
  type MtdBucketResult,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { moneyDto } from '../positions/mapping';
import { loadMonthToDate } from './mtd-loader';
import type { MonthDataDependencies } from './loader';
import type {
  MonthToDateDto,
  MtdBucketDto,
  ReconciliationIssueDto,
} from './types';

/**
 * The current month's month-to-date read (blueprint 8.6, 8.9, v2.1.10 30.13).
 *
 * Load, run the pure engine, serialize. Nothing is written and nothing is
 * stored: 5.3 makes the source rows the only truth, and 8.6 adds that nothing
 * provisional feeds averages, baselines or completeness, so there is no
 * counterpart to this function that saves its answer anywhere.
 *
 * The month is the one containing `ctx.today`, and there is no parameter for
 * it. A month-to-date figure for any other month is not a thing this engine can
 * mean, and a completed month has its own read in `service.ts`.
 */

export type MonthToDateDependencies = MonthDataDependencies;

function issueDto(issue: Issue, fallbackCurrency: string | null): ReconciliationIssueDto {
  // The two `mtd_*` keys carry no currency: they are facts about the month's
  // evidence date rather than about one bucket (30.13 items 3 and 5).
  const currency = issue.currency ?? fallbackCurrency;
  return {
    key: issue.key,
    class: issue.class,
    currency,
    positionId: issue.positionId ?? null,
    positionName: null,
    amount:
      issue.amount === undefined || currency === null
        ? null
        : moneyDto(issue.amount.toString(), currency),
    variant: issue.variant ?? null,
    templateId: null,
    templateName: null,
    occurrenceDate: null,
    expectedAmount: null,
    positionIds: issue.positionIds === undefined ? null : [...issue.positionIds],
  };
}

function bucketDto(bucket: MtdBucketResult): MtdBucketDto {
  const amount = (value: Decimal): ReturnType<typeof moneyDto> =>
    moneyDto(value.toString(), bucket.currency);

  return {
    currency: bucket.currency,
    status: bucket.status,
    reason: bucket.reason ?? null,
    accounts: bucket.accounts.map((account) => ({
      positionId: account.positionId,
      name: account.name,
      openState: account.opening.state,
      opening: account.opening.amount === undefined ? null : amount(account.opening.amount),
      asOfState: account.atAsOf.state,
      asOfAmount: account.atAsOf.amount === undefined ? null : amount(account.atAsOf.amount),
      included: account.included,
      excludedFirstBalance: account.excludedFirstBalance,
      dormant: account.dormant,
      snapshotRequired: account.snapshotRequired,
      newerBalanceOn: account.newerBalanceOn ?? null,
    })),
    totals: {
      externalInflows: amount(bucket.totals.externalInflows),
      nonIncomeInflows: amount(bucket.totals.nonIncomeInflows),
      nonExpenseOutflows: amount(bucket.totals.nonExpenseOutflows),
      knownTrackedExpenses: amount(bucket.totals.knownTrackedExpenses),
      // Absent, not zero: a bucket the engine could not compute has no figure
      // and the interface must show the reason instead (8.4, 30.12).
      cashDelta: bucket.totals.cashDelta === undefined ? null : amount(bucket.totals.cashDelta),
      trackedTotalSpending:
        bucket.totals.trackedTotalSpending === undefined
          ? null
          : amount(bucket.totals.trackedTotalSpending),
      unclassified:
        bucket.totals.unclassified === undefined ? null : amount(bucket.totals.unclassified),
    },
    additionalSpending: amount(bucket.additionalSpending),
    thirdPartyPaid: amount(bucket.thirdPartyPaid),
    issues: bucket.issues.map((issue) => issueDto(issue, bucket.currency)),
    explanation: bucket.explanation,
  };
}

export async function getMonthToDate(
  deps: MonthToDateDependencies,
  ctx: RequestContext,
): Promise<MonthToDateDto> {
  const data = await loadMonthToDate(deps, ctx.userId, ctx.today);
  const result: MonthToDateResult = reconcileMonthToDate(data.input);
  const month = (result.month as string).slice(0, 7);

  // 30.13 item 5: without a common date there is no interval, so there is
  // nothing to report but the reason. The DTO says that with `null`s rather
  // than with an empty bucket list carrying zeros.
  if (result.asOf === null) {
    return {
      month,
      asOf: null,
      status: result.status,
      reason: result.reason,
      buckets: null,
      accountsWithNewerBalances: [],
      issues: result.issues.map((issue) => issueDto(issue, null)),
    };
  }

  return {
    month,
    asOf: result.asOf,
    status: result.status,
    reason: null,
    buckets: result.buckets.map(bucketDto),
    accountsWithNewerBalances: [...result.accountsWithNewerBalances],
    issues: result.issues.map((issue) => issueDto(issue, null)),
  };
}
