import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import {
  endOfMonthKey,
  monthKeyOf,
  plainDate,
  startOfMonthKey,
  type MonthKey,
} from '../src/dates/plain-date';
import { createFxTable } from '../src/fx/index';
import { currencyCode } from '../src/money/types';
import type { ExpenseFlow, IncomeFlow } from '../src/flows/types';
import { isUnavailable } from '../src/unavailable';
import {
  reconcileCompletedMonth,
  type CashAccountInput,
  type CompletedMonthInput,
} from '../src/reconciliation/index';
import {
  bucketContributions,
  buildRollingTrackedSpendingSeries,
  isRollingEligible,
  reportCashFlow,
  reportUnobservedMonth,
  untrackedContributions,
  type ReportingCashFlow,
  type RollingTrackedSpendingObservation,
} from '../src/reporting/index';
import { monthEnd, position, valuation } from './helpers/records';

/**
 * A completed month that observed no tracked cash (blueprint 8.3, 8.4, 12.5,
 * v2.1.17 30.20 items 10–13).
 *
 * With no participating cash account and no null-leg flow there is no bucket.
 * The worst of no statuses used to read `reliable` and the sum of no
 * contributions an available zero, so the months before a user began tracking
 * entered their rolling averages as observations of zero spending. Observed
 * zero is a valid answer; no observation is not zero.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const TODAY = plainDate('2026-09-18');
const M = (month: number, year = 2026): MonthKey => monthKeyOf(year, month);
const fx = createFxTable([], { today: TODAY });

const account = (
  id: string,
  valuations: CashAccountInput['valuations'],
  options: { openedOn?: string; closedOn?: string } = {},
): CashAccountInput => ({
  position: position(id, {
    id,
    ...(options.openedOn === undefined ? {} : { openedOn: options.openedOn }),
    ...(options.closedOn === undefined ? {} : { closedOn: options.closedOn, status: 'closed' }),
  }),
  valuations,
  accountType: 'checking',
});

const input = (month: MonthKey, over: Partial<CompletedMonthInput> = {}): CompletedMonthInput => ({
  month,
  today: TODAY,
  cashAccounts: [],
  income: [],
  expenses: [],
  transfers: [],
  templates: [],
  resolvedOccurrences: new Set(),
  ...over,
});

const expense = (
  id: string,
  on: string,
  amount: string,
  settlement: ExpenseFlow['settlement'],
  currency = EUR,
): ExpenseFlow => ({
  id,
  categoryKind: 'general',
  incurredOn: plainDate(on),
  amount: new Decimal(amount),
  currency,
  settlement,
  cashPositionId: null,
});

describe('a month with no bucket is unavailable, not a reliable nothing', () => {
  const opened = account(
    'main',
    [monthEnd('main', '2026-06-30', '1000'), monthEnd('main', '2026-07-31', '1000')],
    { openedOn: '2026-06-10' },
  );

  it.each([
    ['no cash account exists', []],
    ['the month is before the first account opened', [opened]],
    [
      'every account had closed before the month',
      [
        account('old', [monthEnd('old', '2025-12-31', '50'), valuation('old', '2026-01-15', '0')], {
          openedOn: '2025-01-01',
          closedOn: '2026-01-15',
        }),
      ],
    ],
  ])('when %s', (_label, cashAccounts) => {
    const result = reconcileCompletedMonth(input(M(3), { cashAccounts }));
    expect(result.buckets).toEqual([]);
    expect(result.monthStatus).toBe('unavailable');
  });

  it('is still unavailable when the month holds untracked records, which make no bucket', () => {
    const result = reconcileCompletedMonth(
      input(M(3), { expenses: [expense('e1', '2026-03-12', '50', 'untracked_self')] }),
    );
    expect(result.buckets).toEqual([]);
    expect(result.monthStatus).toBe('unavailable');
  });
});

describe('what the correction leaves alone', () => {
  it('keeps an observed zero reliable: statements at both ends and nothing moved', () => {
    const result = reconcileCompletedMonth(
      input(M(7), {
        cashAccounts: [
          account('main', [monthEnd('main', '2026-06-30', '1000'), monthEnd('main', '2026-07-31', '1000')]),
        ],
      }),
    );
    expect(result.monthStatus).toBe('reliable');
    expect(result.buckets[0]?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('keeps a tracked account with missing evidence a bucket with its own blocking issue', () => {
    // Not "nothing was tracked": the account took part, and what is missing is
    // named so it can be supplied.
    const result = reconcileCompletedMonth(
      input(M(3), { cashAccounts: [account('pre', [monthEnd('pre', '2026-06-30', '1000')])] }),
    );
    expect(result.monthStatus).toBe('unavailable');
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.issues.map((issue) => issue.key)).toEqual(['missing_month_end']);
  });

  it('keeps a month whose only account is first tracked in it unavailable with its info issue', () => {
    const result = reconcileCompletedMonth(
      input(M(6), { cashAccounts: [account('pre', [monthEnd('pre', '2026-06-30', '1000')])] }),
    );
    expect(result.monthStatus).toBe('unavailable');
    expect(result.buckets[0]?.issues.map((issue) => issue.key)).toEqual(['first_balance']);
  });

  it('keeps a first_balance exclusion beside a steady account estimated', () => {
    const result = reconcileCompletedMonth(
      input(M(6), {
        cashAccounts: [
          account('pre', [monthEnd('pre', '2026-06-30', '1000')]),
          account('steady', [monthEnd('steady', '2026-05-31', '200'), monthEnd('steady', '2026-06-30', '200')]),
        ],
      }),
    );
    expect(result.monthStatus).toBe('estimated');
  });
});

describe('reporting a month nobody observed', () => {
  const TRACKED = [
    'externalIncome',
    'knownConsumption',
    'propertyOperatingCosts',
    'interestAndFees',
    'transactionCosts',
    'externalOutflows',
    'unclassified',
    'consumption',
    'trackedTotalSpending',
    'trackedSavingsFromIncome',
    'personalSavings',
    'totalSpending',
  ] as const satisfies readonly (keyof ReportingCashFlow)[];

  const report = (expenses: readonly ExpenseFlow[], countAdditionalSpending = true) =>
    reportUnobservedMonth({
      reportingCurrency: EUR,
      fx,
      contributions: [EUR, USD].flatMap((currency) =>
        untrackedContributions(expenses, currency, startOfMonthKey(M(3)), endOfMonthKey(M(3))),
      ),
      countAdditionalSpending,
    });

  // No tracked cash; 50 paid by the user from outside it, 80 paid by someone else.
  const flow = report([
    expense('e1', '2026-03-12', '50', 'untracked_self'),
    expense('e2', '2026-03-20', '80', 'third_party'),
  ]);

  it('states no tracked figure, and names no missing currency, because none is missing', () => {
    for (const key of TRACKED) {
      expect(flow[key]).toMatchObject({ availability: 'unavailable', missing: [], statedCount: 0 });
    }
  });

  it('keeps the two settlements that never needed tracked cash', () => {
    expect(flow.additionalSpending).toMatchObject({ availability: 'available', statedCount: 1 });
    expect(flow.additionalSpending.value.amount.toString()).toBe('50');
    expect(flow.thirdPartyPaid).toMatchObject({ availability: 'available', statedCount: 1 });
    expect(flow.thirdPartyPaid.value.amount.toString()).toBe('80');
  });

  it('builds no total from them: total spending exists only when tracked spending does', () => {
    // 30.15 item 1. Not 50, and not a partial 50 either.
    expect(flow.totalSpending.availability).toBe('unavailable');
    expect(flow.personalSavings.availability).toBe('unavailable');
    expect(flow.trackedSavingsFromIncome.availability).toBe('unavailable');
  });

  it('has no savings rate, and says why without blaming a zero income', () => {
    if (!isUnavailable(flow.savingsRate)) throw new Error('expected no savings rate');
    expect(flow.savingsRate.reason).toBe('not_applicable');
    expect(flow.savingsRate.detail).toBe('no cash account took part in this month');
    expect(report([], false).countsAdditionalSpending).toBe(false);
  });

  it('lets a source-only figure answer for its own missing rate, and only that figure', () => {
    const unconvertible = report([expense('e3', '2026-03-12', '50', 'untracked_self', USD)]);
    expect(unconvertible.additionalSpending).toMatchObject({
      availability: 'unavailable',
      missing: [{ currency: USD, reason: 'fx_missing' }],
    });
    expect(unconvertible.trackedTotalSpending.missing).toEqual([]);
  });

  it('is what summing nothing used to claim instead', () => {
    // The shape this replaces, kept as the reason it exists: an empty
    // contribution list through the ordinary algebra is fifteen confident zeroes.
    const summed = reportCashFlow({
      reportingCurrency: EUR,
      fx,
      contributions: untrackedContributions(
        [expense('e1', '2026-03-12', '50', 'untracked_self')],
        EUR,
        startOfMonthKey(M(3)),
        endOfMonthKey(M(3)),
      ),
      missing: [],
      countAdditionalSpending: true,
    });
    expect(summed.trackedTotalSpending).toMatchObject({ availability: 'available' });
    expect(summed.personalSavings.value.amount.toString()).toBe('-50');
  });
});

describe('rolling averages for someone who began tracking four months ago', () => {
  // Opened at zero on 1 May. Salary 2,000 a month; the balance shows what stayed.
  const main = account(
    'main',
    [
      monthEnd('main', '2026-05-31', '800'),
      monthEnd('main', '2026-06-30', '1400'),
      monthEnd('main', '2026-07-31', '2200'),
      monthEnd('main', '2026-08-31', '2700'),
    ],
    { openedOn: '2026-05-01' },
  );
  const salary = (month: number): IncomeFlow => ({
    id: `salary-${String(month)}`,
    kind: 'employment',
    receivedOn: plainDate(`2026-0${String(month)}-25`),
    netAmount: new Decimal('2000'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: 'main',
  });
  const income = [5, 6, 7, 8].map(salary);

  /** One completed month as the application reports it: the engine's own two paths. */
  function observe(month: MonthKey): RollingTrackedSpendingObservation {
    const monthInput = input(month, { cashAccounts: [main], income });
    const result = reconcileCompletedMonth(monthInput);
    if (result.buckets.length === 0) {
      const flow = reportUnobservedMonth({ reportingCurrency: EUR, fx, contributions: [], countAdditionalSpending: true });
      return { month, monthStatus: result.monthStatus, trackedTotalSpending: flow.trackedTotalSpending };
    }
    const built = result.buckets.map((bucket) =>
      bucketContributions({
        records: monthInput,
        expenses: monthInput.expenses,
        currency: bucket.currency,
        accounts: bucket.accounts,
        month,
        from: startOfMonthKey(month),
        to: endOfMonthKey(month),
        status: bucket.status,
        unclassified: bucket.totals.unclassified,
      }),
    );
    const flow = reportCashFlow({
      reportingCurrency: EUR,
      fx,
      contributions: built.flatMap((entry) => entry.contributions),
      missing: built.flatMap((entry) => entry.missing),
      countAdditionalSpending: true,
    });
    return { month, monthStatus: result.monthStatus, trackedTotalSpending: flow.trackedTotalSpending };
  }

  // September 2025 … August 2026: eight months before tracking, four inside it.
  const months = [M(9, 2025), M(10, 2025), M(11, 2025), M(12, 2025), M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8)];
  const observations = months.map(observe);

  it('observes four months and nothing before them', () => {
    expect(observations.map((o) => isRollingEligible(o))).toEqual([
      false, false, false, false, false, false, false, false, true, true, true, true,
    ]);
    expect(observations.slice(8).map((o) => o.trackedTotalSpending.value.amount.toString())).toEqual([
      '1200', '1400', '1200', '1500',
    ]);
  });

  it('averages the months that were observed, and counts them', () => {
    const [august] = buildRollingTrackedSpendingSeries(observations, { from: M(8), to: M(8) });
    // (1400 + 1200 + 1500) / 3, and (1200 + 1400 + 1200 + 1500) / 4 — not / 6 and not / 12.
    expect(august?.rolling3?.count).toBe(3);
    expect(august?.rolling6).toMatchObject({ count: 4 });
    expect(august?.rolling6?.value.amount.toString()).toBe('1325');
    expect(august?.rolling12).toMatchObject({ count: 4 });
    expect(august?.rolling12?.value.amount.toString()).toBe('1325');
  });

  it('keeps the calendar window fixed: an unobserved month is not replaced by reaching further back', () => {
    // A 3-month window ending in June holds April, May and June. April observed
    // nothing, so the average is over two months — never March's, never three.
    const [june] = buildRollingTrackedSpendingSeries(observations, { from: M(6), to: M(6) });
    expect(june?.rolling3).toMatchObject({ count: 2 });
    expect(june?.rolling3?.value.amount.toString()).toBe('1300');
    // And a window wholly before tracking has no average at all, not a zero one.
    const [april] = buildRollingTrackedSpendingSeries(observations, { from: M(4), to: M(4) });
    expect(april).toMatchObject({ rolling3: null, rolling6: null, rolling12: null });
  });

  it('still counts an observed zero as the observation it is', () => {
    const quiet = account('quiet', [monthEnd('quiet', '2026-06-30', '500'), monthEnd('quiet', '2026-07-31', '500')]);
    const monthInput = input(M(7), { cashAccounts: [quiet] });
    const result = reconcileCompletedMonth(monthInput);
    const bucket = result.buckets[0];
    if (bucket === undefined) throw new Error('expected a bucket');
    const built = bucketContributions({
      records: monthInput,
      expenses: [],
      currency: bucket.currency,
      accounts: bucket.accounts,
      month: M(7),
      from: startOfMonthKey(M(7)),
      to: endOfMonthKey(M(7)),
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
    });
    const flow = reportCashFlow({ reportingCurrency: EUR, fx, ...built, countAdditionalSpending: true });
    const observation = { month: M(7), monthStatus: result.monthStatus, trackedTotalSpending: flow.trackedTotalSpending };
    expect(isRollingEligible(observation)).toBe(true);
    const [july] = buildRollingTrackedSpendingSeries([observation], { from: M(7), to: M(7) });
    expect(july?.rolling3).toMatchObject({ count: 1 });
    expect(july?.rolling3?.value.amount.toString()).toBe('0');
  });
});
