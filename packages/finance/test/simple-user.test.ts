import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { endOfMonthKey, monthKey, startOfMonthKey } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import { isUnavailable } from '../src/unavailable';
import {
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type BucketResult,
  type MonthToDateResult,
} from '../src/reconciliation/index';
import { classifyBucketInterval, reconcileSavings, type SavingsResult } from '../src/savings/index';
import * as simpleUser from './golden/simple-user/fixture';

/**
 * Golden fixture `simple-user`, Phase 3 (blueprint 21.6, 8.2, 8.6, 12.5; 25
 * Phase 3 "Acceptance").
 *
 * The figures were computed by hand from the fixture's records before these
 * assertions were written; the working is in the fixture's README. Phase 2's
 * assertions on the same fixture live in `unit/networth.test.ts` and are
 * untouched: Phase 3 reads the same balances and adds its records on top.
 */

const EUR = currencyCode('EUR');

function eurBucket(month: string): BucketResult {
  const bucket = reconcileCompletedMonth(simpleUser.completedMonth(month)).buckets.find(
    (b) => b.currency === 'EUR',
  );
  if (bucket === undefined) throw new Error(`no EUR bucket in ${month}`);
  return bucket;
}

/** 12.5 over one completed month's EUR bucket, composed as the application composes it. */
function savingsOf(month: string): SavingsResult {
  const input = simpleUser.completedMonth(month);
  const bucket = eurBucket(month);
  const classified = classifyBucketInterval(
    input,
    input.expenses,
    EUR,
    bucket.accounts,
    startOfMonthKey(input.month),
    endOfMonthKey(input.month),
  );
  return reconcileSavings({
    currency: EUR,
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
    countAdditionalSpending: true,
  });
}

/** The `asOf`-defined shape, or a failure that names what came back instead. */
function computed(result: MonthToDateResult) {
  if (result.asOf === null) throw new Error(`expected a month-to-date date, got ${result.reason}`);
  return result;
}

describe('golden: simple-user, Phase 3 — the completed months', () => {
  /** README "Inferred spending": month, Δ, tracked total spending = 2,100 − Δ. */
  const months: readonly [string, string, string][] = [
    ['2026-04', '350', '1750'],
    ['2026-05', '260', '1840'],
    ['2026-06', '395', '1705'],
    ['2026-07', '205', '1895'],
    ['2026-08', '154', '1946'],
  ];

  it.each(months)('reconciles %s: Δ %s, inferred spending %s, all of it unclassified', (month, delta, spending) => {
    const bucket = eurBucket(month);
    expect(bucket.status).toBe('reliable');
    expect(bucket.totals.externalInflows.toString()).toBe('2100');
    expect(bucket.totals.nonIncomeInflows.toString()).toBe('0');
    expect(bucket.totals.nonExpenseOutflows.toString()).toBe('0');
    expect(bucket.totals.cashDelta?.toString()).toBe(delta);
    expect(bucket.totals.trackedTotalSpending?.toString()).toBe(spending);
    expect(bucket.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket.totals.unclassified?.toString()).toBe(spending);
    // The salary was accepted every month, so no month expected one it lacks,
    // and neither account is savings-shaped, so no interest is suspected.
    expect(bucket.issues).toEqual([]);
  });

  it('cannot read March, the month both accounts were first tracked', () => {
    // 8.1, R5: a pre-existing account's first balance is excluded from its
    // month, and with both excluded nothing is left to reconcile. Not a zero.
    const bucket = eurBucket('2026-03');
    expect(bucket.status).toBe('unavailable');
    expect(bucket.totals.cashDelta).toBeUndefined();
    expect(bucket.totals.trackedTotalSpending).toBeUndefined();
    expect(bucket.accounts.map((account) => account.opening.state)).toEqual(['first_balance', 'first_balance']);
    // The salary was attributed to an excluded account, so it leaves with it.
    expect(bucket.totals.externalInflows.toString()).toBe('0');
    expect(bucket.issues.map((issue) => issue.key)).toEqual(['first_balance', 'first_balance']);
  });

  /** README "Saved from income": month, saved = Δ, rate = Δ / 2,100 to two places. */
  const savings: readonly [string, string, string][] = [
    ['2026-04', '350', '16.67'],
    ['2026-05', '260', '12.38'],
    ['2026-06', '395', '18.81'],
    ['2026-07', '205', '9.76'],
    ['2026-08', '154', '7.33'],
  ];

  it.each(savings)('saves %s from income: %s, a rate of %s %%', (month, saved, percent) => {
    const result = savingsOf(month);
    expect(result.source.externalIncome.toString()).toBe('2100');
    expect(result.source.additionalSpending.toString()).toBe('0');
    if (result.derived.kind !== 'available') throw new Error('expected available savings');
    expect(result.derived.quality).toBe('reliable');
    // Nothing is known, so the whole tracked total is consumption.
    expect(result.derived.consumption.toString()).toBe(new Decimal(2100).minus(saved).toString());
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe(saved);
    // No additional spending, so counting it changes nothing.
    expect(result.derived.personalSavings.toString()).toBe(saved);
    expect(result.derived.totalSpending.toString()).toBe(new Decimal(2100).minus(saved).toString());

    const rate = result.derived.savingsRate;
    if (isUnavailable(rate)) throw new Error('expected a rate');
    // Exact and unrounded; 7.3 rounds only where it is shown.
    expect(rate.toString()).toBe(new Decimal(saved).dividedBy(2100).toString());
    expect(rate.times(100).toDecimalPlaces(2).toString()).toBe(percent);
  });

  it('has no savings figure for March, only what its records said', () => {
    const result = savingsOf('2026-03');
    expect(result.derived.kind).toBe('unavailable');
    expect(result.source.externalIncome.toString()).toBe('0');
  });
});

describe('golden: simple-user, Phase 3 — the current month', () => {
  describe('both accounts on the 6th, BBVA again on the 8th', () => {
    const result = reconcileMonthToDate(simpleUser.currentMonth());

    it('is provisional through the 6th, the latest day both accounts share', () => {
      expect(result.asOf).toBe('2026-09-06');
      expect(result.status).toBe('provisional');
    });

    it('says BBVA has a newer balance, and only BBVA', () => {
      const mtd = computed(result);
      expect(mtd.accountsWithNewerBalances).toEqual([simpleUser.ids.bbva]);
      const advisory = mtd.issues.find((issue) => issue.key === 'mtd_newer_balances');
      expect(advisory?.class).toBe('advisory');
      expect(advisory?.positionIds).toEqual([simpleUser.ids.bbva]);
    });

    it('computes the identity through the 6th, and nothing from the 8th', () => {
      const bucket = computed(result).buckets.find((b) => b.currency === 'EUR');
      expect(bucket?.status).toBe('provisional');
      // (8,120 − 8,055) + (8,509 − 8,509) = 65; the 8th's 8,050 would give −5.
      expect(bucket?.totals.cashDelta?.toString()).toBe('65');
      expect(bucket?.totals.externalInflows.toString()).toBe('2100');
      expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('2035');
      expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
      expect(bucket?.totals.unclassified?.toString()).toBe('2035');
    });

    it('saves 65 from income through the 6th, a provisional 3.10 %', () => {
      const input = simpleUser.currentMonth();
      const mtd = computed(result);
      const bucket = mtd.buckets.find((b) => b.currency === 'EUR');
      if (bucket === undefined) throw new Error('no EUR bucket');
      const classified = classifyBucketInterval(
        input,
        input.expenses,
        EUR,
        bucket.accounts,
        startOfMonthKey(monthKey(simpleUser.PHASE3_TODAY)),
        mtd.asOf,
      );
      const savings = reconcileSavings({
        currency: EUR,
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
        countAdditionalSpending: true,
      });
      if (savings.derived.kind !== 'available') throw new Error('expected available savings');
      expect(savings.derived.quality).toBe('provisional');
      expect(savings.derived.trackedSavingsFromIncome.toString()).toBe('65');
      const rate = savings.derived.savingsRate;
      if (isUnavailable(rate)) throw new Error('expected a rate');
      expect(rate.times(100).toFixed(2)).toBe('3.10');
    });
  });

  describe('the variant: BBVA only on the 6th, Savings only on the 3rd', () => {
    const result = reconcileMonthToDate(simpleUser.currentMonthWithoutCommonDate());

    it('is unavailable, for want of a common date', () => {
      expect(result.asOf).toBeNull();
      expect(result.status).toBe('unavailable');
      if (result.asOf !== null) throw new Error('expected no common date');
      expect(result.reason).toBe('mtd_no_common_date');
      const issue = result.issues.find((i) => i.key === 'mtd_no_common_date');
      expect(issue?.class).toBe('blocking');
    });

    it('computes nothing at all rather than a figure through some other day', () => {
      // 8.6: no D, no interval, so not even the salary's ΣI is summed.
      expect(JSON.stringify(result)).not.toContain('trackedTotalSpending');
      expect(JSON.stringify(result)).not.toContain('2100');
    });
  });
});
