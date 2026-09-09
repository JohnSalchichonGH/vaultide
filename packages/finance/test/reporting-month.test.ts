import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey } from '../src/dates/plain-date';
import { createFxTable } from '../src/fx/index';
import { currencyCode } from '../src/money/index';
import { isUnavailable } from '../src/unavailable';
import { monthEnd, position, valuation } from './helpers/records';
import type { ExpenseFlow, IncomeFlow } from '../src/flows/types';
import {
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type CashAccountInput,
  type CompletedMonthInput,
  type MonthToDateInput,
} from '../src/reconciliation/index';
import {
  bucketContributions,
  reportCashFlow,
  untrackedContributions,
  type ReportingCashFlow,
} from '../src/reporting/index';

/**
 * The bridge from a reconciled bucket to its reporting contributions (8.1,
 * 12.5, v2.1.13 30.16).
 *
 * These fixtures drive the real engines, so what is classified here is what the
 * identity summed there — the same scoped facts through the same predicate.
 * Every currency is the reporting currency unless a case needs otherwise, which
 * keeps the arithmetic hand-checkable and the FX out of the way.
 */

const EUR = currencyCode('EUR');
const GBP = currencyCode('GBP');
const SEPTEMBER: MonthKey = monthKeyOf(2026, 9);
const A = 'account-a';
const B = 'account-b';

const emptyFx = createFxTable([], { today: plainDate('2026-10-01') });

function account(id: string, name: string, valuations: CashAccountInput['valuations']): CashAccountInput {
  return {
    position: position(name, { id, currency: 'EUR' }),
    valuations,
    accountType: 'checking',
  };
}

let sequence = 0;
const nextId = (): string => `row-${String((sequence += 1))}`;

const income = (over: Partial<IncomeFlow> = {}): IncomeFlow => ({
  id: nextId(),
  kind: 'employment',
  receivedOn: plainDate('2026-09-25'),
  netAmount: new Decimal('100'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: A,
  ...over,
});

const expense = (over: Partial<ExpenseFlow> = {}): ExpenseFlow => ({
  id: nextId(),
  categoryKind: 'food',
  incurredOn: plainDate('2026-09-12'),
  amount: new Decimal('100'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: A,
  ...over,
});

const completed = (over: Partial<CompletedMonthInput> = {}): CompletedMonthInput => ({
  month: SEPTEMBER,
  today: plainDate('2026-10-01'),
  cashAccounts: [],
  income: [],
  expenses: [],
  transfers: [],
  templates: [],
  resolvedOccurrences: new Set<string>(),
  ...over,
});

/** Reconcile, classify and report one completed EUR month. */
function report(input: CompletedMonthInput, countAdditionalSpending = true): ReportingCashFlow {
  const result = reconcileCompletedMonth(input);
  const contributions = [];
  const missing = [];

  for (const bucket of result.buckets) {
    const gap =
      bucket.status === 'unresolved'
        ? { reason: 'not_applicable' as const, detail: 'unresolved' }
        : bucket.status === 'unavailable'
          ? { reason: 'no_valuation' as const, detail: 'reconciliation_unavailable' }
          : undefined;
    const built = bucketContributions({
      records: input,
      expenses: input.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month: SEPTEMBER,
      from: plainDate('2026-09-01'),
      to: plainDate('2026-09-30'),
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
      ...(gap === undefined ? {} : { residualReason: gap.reason, residualDetail: gap.detail }),
    });
    contributions.push(...built.contributions);
    missing.push(...built.missing);
  }

  return reportCashFlow({
    reportingCurrency: EUR,
    fx: emptyFx,
    contributions,
    missing,
    countAdditionalSpending,
  });
}

const value = (a: { value: { amount: Decimal } }): string => a.value.amount.toString();

/* -------------------------------------------------------------------------- */

describe('a reliable completed month', () => {
  it('classifies every scoped fact into the figure its kind names', () => {
    const result = report(
      completed({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1200')]),
        ],
        income: [income({ netAmount: new Decimal('900') })],
        expenses: [
          expense({ categoryKind: 'food', amount: new Decimal('200') }),
          expense({ categoryKind: 'transfer_fee', amount: new Decimal('10') }),
          expense({ categoryKind: 'acquisition_cost', amount: new Decimal('15') }),
          expense({ categoryKind: 'external_outflow', amount: new Decimal('40') }),
          expense({ categoryKind: 'property_operating', amount: new Decimal('25') }),
          expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('30') }),
          expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('70') }),
        ],
      }),
    );

    // ΣK 290, Δ 200 → tracked 700, unclassified 410.
    expect(value(result.externalIncome)).toBe('900');
    // Consumption's known part is the food and the non-rental property cost.
    expect(value(result.knownConsumption)).toBe('225');
    expect(value(result.interestAndFees)).toBe('10');
    expect(value(result.transactionCosts)).toBe('15');
    expect(value(result.externalOutflows)).toBe('40');
    expect(value(result.propertyOperatingCosts)).toBe('0');
    expect(value(result.unclassified)).toBe('410');
    expect(value(result.consumption)).toBe('635');
    expect(value(result.trackedTotalSpending)).toBe('700');
    expect(value(result.additionalSpending)).toBe('30');
    expect(value(result.thirdPartyPaid)).toBe('70');
    expect(value(result.trackedSavingsFromIncome)).toBe('240');
    expect(value(result.personalSavings)).toBe('210');
    expect(value(result.totalSpending)).toBe('730');
    expect(result.unclassified.quality).toBe('reliable');
  });

  it('leaves a capital improvement out of every cost bucket', () => {
    const result = report(
      completed({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '900')]),
        ],
        expenses: [expense({ categoryKind: 'capital_improvement', amount: new Decimal('100') })],
      }),
    );
    // 7.4 gives it `Nout`, so it is outside ΣK and outside the decomposition.
    expect(value(result.knownConsumption)).toBe('0');
    expect(value(result.transactionCosts)).toBe('0');
    expect(value(result.trackedTotalSpending)).toBe('0');
  });
});

describe('the role correction survives into reporting', () => {
  it('counts all three inflows as cash and only the salary as income', () => {
    const input = completed({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '0'), monthEnd(A, '2026-09-30', '600')]),
      ],
      income: [
        income({ kind: 'employment', netAmount: new Decimal('100') }),
        income({ kind: 'external_inflow', netAmount: new Decimal('200') }),
        income({ kind: 'adjustment', netAmount: new Decimal('300') }),
      ],
    });

    const bucket = reconcileCompletedMonth(input).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('600');
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('0');

    const result = report(input);
    expect(value(result.externalIncome)).toBe('100');
    expect(value(result.unclassified)).toBe('0');
    expect(value(result.trackedSavingsFromIncome)).toBe('100');
  });
});

describe('an excluded account takes its flows with it', () => {
  it('never lets a first_balance account’s income or cost into the reporting figures', () => {
    const result = report(
      completed({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1300')]),
          // Pre-existing, first tracked this month: 8.1 excludes it and its legs.
          account(B, 'Newly tracked', [monthEnd(B, '2026-09-30', '5000')]),
        ],
        income: [
          income({ netAmount: new Decimal('400') }),
          income({ netAmount: new Decimal('999'), cashPositionId: B }),
        ],
        expenses: [expense({ categoryKind: 'transfer_fee', amount: new Decimal('77'), cashPositionId: B })],
      }),
    );

    // The same set the identity summed, and nothing more.
    expect(value(result.externalIncome)).toBe('400');
    expect(value(result.interestAndFees)).toBe('0');
    expect(value(result.knownConsumption)).toBe('0');
    expect(result.unclassified.quality).toBe('estimated');
    expect(value(result.consumption)).toBe('100');
  });
});

describe('a bucket whose residual is not a spending figure', () => {
  it('keeps the source classifications and withholds the rest, saying which', () => {
    const result = report(
      completed({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '2291')]),
        ],
        expenses: [
          expense({ categoryKind: 'insurance', amount: new Decimal('300') }),
          expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
        ],
      }),
    );

    expect(value(result.knownConsumption)).toBe('300');
    expect(result.knownConsumption.availability).toBe('available');
    expect(value(result.additionalSpending)).toBe('50');
    expect(result.unclassified.availability).toBe('unavailable');
    expect(result.unclassified.missing[0]?.detail).toBe('unresolved');
    expect(result.consumption.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
  });

  it('does the same for a month that never reconciled, with its own reason', () => {
    const result = report(
      completed({
        cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000')])],
        income: [income({ netAmount: new Decimal('2100') })],
      }),
    );

    expect(value(result.externalIncome)).toBe('2100');
    expect(result.unclassified.availability).toBe('unavailable');
    expect(result.unclassified.missing[0]?.detail).toBe('reconciliation_unavailable');
    expect(result.trackedSavingsFromIncome.availability).toBe('partial');

    // The spending side has no rows of its own here, so its known part is an
    // exact zero — a stated operand, not an absent one. What it adds up with is
    // missing, so the totals are partial at that zero rather than blank: the
    // month is known to have spent at least nothing, and the residual is why it
    // cannot say more (30.16 item 7).
    expect(result.knownConsumption.availability).toBe('available');
    expect(value(result.knownConsumption)).toBe('0');
    for (const figure of [result.consumption, result.trackedTotalSpending, result.totalSpending]) {
      expect(figure.availability).toBe('partial');
      expect(value(figure)).toBe('0');
      expect(figure.missing[0]?.detail).toBe('reconciliation_unavailable');
    }
    // A missing residual never becomes a zero on the way through.
    expect(result.unclassified.statedCount).toBe(0);
  });
});

describe('the untracked settlements', () => {
  it('are found in a currency that reconciles nothing', () => {
    const expenses = [
      expense({ currency: GBP, cashPositionId: null, settlement: 'untracked_self', amount: new Decimal('50') }),
      expense({ currency: GBP, cashPositionId: null, settlement: 'third_party', amount: new Decimal('80') }),
      expense({ currency: GBP, cashPositionId: null, settlement: 'untracked_self', amount: new Decimal('5'), incurredOn: plainDate('2026-10-02') }),
    ];
    const contributions = untrackedContributions(
      expenses,
      GBP,
      plainDate('2026-09-01'),
      plainDate('2026-09-30'),
    );

    expect(contributions).toHaveLength(2);
    expect(contributions.map((c) => c.field).sort()).toEqual([
      'additionalSpending',
      'thirdPartyPaid',
    ]);
    // The October row is outside the interval and is not in it.
    expect(
      contributions.every((c) => c.amount.amount.toString() !== '5'),
    ).toBe(true);
  });
});

describe('the edges of the classifier', () => {
  it('ignores an untracked row of another currency', () => {
    const result = report(
      completed({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1000')]),
        ],
        expenses: [
          expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('30') }),
          // Same settlement, another currency: the euro bucket must not take it.
          expense({
            settlement: 'untracked_self',
            cashPositionId: null,
            currency: GBP,
            amount: new Decimal('999'),
          }),
        ],
      }),
    );
    expect(value(result.additionalSpending)).toBe('30');
  });

  it('falls back to a neutral reason when the caller names none', () => {
    // The caller normally supplies the bucket's own reason; without one the
    // dependency is still recorded rather than silently dropped.
    const built = bucketContributions({
      records: { income: [], expenses: [], transfers: [] },
      expenses: [],
      currency: EUR,
      accounts: [],
      month: SEPTEMBER,
      from: plainDate('2026-09-01'),
      to: plainDate('2026-09-30'),
      status: 'unavailable',
    });
    expect(built.missing).toEqual([
      { field: 'unclassified', currency: EUR, reason: 'not_applicable' },
    ]);
  });

  it('orders several missing contributions of one currency by their reason', () => {
    const result = reportCashFlow({
      reportingCurrency: EUR,
      fx: emptyFx,
      contributions: [],
      missing: [
        { field: 'unclassified', currency: GBP, reason: 'not_applicable' },
        { field: 'unclassified', currency: GBP, reason: 'fx_missing' },
        { field: 'unclassified', currency: EUR, reason: 'no_valuation' },
      ],
      countAdditionalSpending: true,
    });

    expect(result.unclassified.missing.map((m) => `${m.currency}/${m.reason}`)).toEqual([
      'EUR/no_valuation',
      'GBP/fx_missing',
      'GBP/not_applicable',
    ]);
  });
});

describe('the current month', () => {
  it('cuts the residual’s own average at D', () => {
    const input: MonthToDateInput = {
      today: plainDate('2026-09-10'),
      cashAccounts: [
        {
          position: position('BBVA', { id: A, currency: 'EUR' }),
          valuations: [monthEnd(A, '2026-08-31', '1000'), valuation(A, '2026-09-06', '1400')],
          accountType: 'checking',
        },
      ],
      income: [income({ receivedOn: plainDate('2026-09-03'), netAmount: new Decimal('600') })],
      expenses: [expense({ incurredOn: plainDate('2026-09-04'), amount: new Decimal('150') })],
      transfers: [],
    };

    const mtd = reconcileMonthToDate(input);
    if (mtd.asOf === null) throw new Error('expected a date');
    const bucket = mtd.buckets[0];
    if (bucket === undefined) throw new Error('expected a bucket');

    const built = bucketContributions({
      records: input,
      expenses: input.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month: SEPTEMBER,
      from: plainDate('2026-09-01'),
      to: mtd.asOf,
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
    });

    const residual = built.contributions.find((c) => c.field === 'unclassified');
    expect(residual?.basis).toEqual({
      kind: 'average',
      month: SEPTEMBER,
      through: plainDate('2026-09-06'),
    });
    expect(residual?.quality).toBe('provisional');
  });
});
