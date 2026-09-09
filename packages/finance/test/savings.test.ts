import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey, type PlainDate } from '../src/dates/plain-date';
import { currencyCode, type CurrencyCode } from '../src/money/types';
import { CATEGORY_KINDS } from '../src/flows/types';
import { isUnavailable } from '../src/unavailable';
import { monthEnd, position, valuation } from './helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../src/flows/types';
import {
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type CashAccountInput,
  type CompletedMonthInput,
  type MonthToDateInput,
} from '../src/reconciliation/index';
import {
  classifyBucketInterval,
  costBucket,
  isExternalIncomeKind,
  reconcileSavings,
  CostClassificationExceedsKnownError,
  NO_NON_CONSUMPTION_COSTS,
  type SavingsResult,
} from '../src/savings/index';

/**
 * Savings, savings rate and the spending decomposition (blueprint 12.3, 12.5,
 * v2.1.12 30.15).
 *
 * Every fixture was written from 12.5 and 30.15 before the engine ran against
 * it. September 2026 is the completed month throughout; the current-month cases
 * say so.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const GBP = currencyCode('GBP');
const SEPTEMBER: MonthKey = monthKeyOf(2026, 9);
const AFTER_SEPTEMBER = plainDate('2026-10-01');
const SEP_START = plainDate('2026-09-01');
const SEP_END = plainDate('2026-09-30');

const A = 'account-a';
const B = 'account-b';

function account(
  id: string,
  name: string,
  valuations: CashAccountInput['valuations'],
  options: { currency?: string; openedOn?: string } = {},
): CashAccountInput {
  return {
    position: position(name, {
      id,
      currency: options.currency ?? 'EUR',
      ...(options.openedOn === undefined ? {} : { openedOn: options.openedOn }),
    }),
    valuations,
    accountType: 'checking',
  };
}

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String((sequence += 1))}`;

function income(over: Partial<IncomeFlow> = {}): IncomeFlow {
  return {
    id: nextId('income'),
    kind: 'employment',
    receivedOn: plainDate('2026-09-25'),
    netAmount: new Decimal('100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: A,
    ...over,
  };
}

function expense(over: Partial<ExpenseFlow> = {}): ExpenseFlow {
  return {
    id: nextId('expense'),
    categoryKind: 'food',
    incurredOn: plainDate('2026-09-12'),
    amount: new Decimal('100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: A,
    ...over,
  };
}

function completedInput(over: Partial<CompletedMonthInput> = {}): CompletedMonthInput {
  return {
    month: SEPTEMBER,
    today: AFTER_SEPTEMBER,
    cashAccounts: [],
    income: [],
    expenses: [],
    transfers: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
    ...over,
  };
}

/**
 * One completed bucket's savings, composed the way the application composes it.
 *
 * The scope comes from the bucket's own account list, so the set classified
 * here is provably the set the identity summed — the same `scopeAccountIds`
 * over the same accounts, through the same `factsInScope` predicate.
 */
function savingsOf(
  input: CompletedMonthInput,
  currency: CurrencyCode = EUR,
  countAdditionalSpending = true,
  interval: { from: PlainDate; to: PlainDate } = { from: SEP_START, to: SEP_END },
): SavingsResult {
  const bucket = reconcileCompletedMonth(input).buckets.find((b) => b.currency === currency);
  if (bucket === undefined) throw new Error(`no ${currency} bucket`);
  const classified = classifyBucketInterval(
    input,
    input.expenses,
    currency,
    bucket.accounts,
    interval.from,
    interval.to,
  );
  return reconcileSavings({
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
  });
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

describe('classification of a category kind', () => {
  it('sends every consumption kind, and tax, to the remainder', () => {
    for (const kind of [
      'general', 'housing', 'transport', 'food', 'travel', 'health',
      'insurance', 'tax', 'subscriptions', 'maintenance', 'major_purchase', 'custom',
    ] as const) {
      expect(costBucket(kind)).toBe('consumption');
    }
  });

  it('sends property_operating to the remainder in Phase 3', () => {
    // 12.3 splits it on whether the property is rented, and Phase 3 has no
    // property positions at all, so every one of these is the non-rental case.
    expect(costBucket('property_operating')).toBe('consumption');
  });

  it('is total over the whole enum, so a new kind cannot slip through as consumption', () => {
    // The contract 30.15 item 10 rests on: the classifier answers for every
    // kind rather than defaulting, so adding one to the enum is a build error
    // and not a silent reclassification.
    const buckets = new Set([
      'consumption', 'property_operating', 'interest_and_fees',
      'transaction_costs', 'external_outflows',
    ]);
    for (const kind of CATEGORY_KINDS) {
      expect(buckets.has(costBucket(kind))).toBe(true);
    }
  });

  it('never sees a capital improvement at all, because 7.4 makes it Nout', () => {
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '900')]),
      ],
      expenses: [expense({ categoryKind: 'capital_improvement', amount: new Decimal('100') })],
    });
    const result = savingsOf(input);
    // Capital expenditure, not spending: outside ΣK and outside all five buckets.
    expect(result.source.knownConsumption.toString()).toBe('0');
    expect(result.source.transactionCosts.toString()).toBe('0');
    expect(result.source.interestAndFees.toString()).toBe('0');
    const bucket = reconcileCompletedMonth(input).buckets[0];
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('100');
  });

  it('sends fees, transaction costs and external outflows to their own buckets', () => {
    expect(costBucket('investment_fee')).toBe('interest_and_fees');
    expect(costBucket('transfer_fee')).toBe('interest_and_fees');
    expect(costBucket('acquisition_cost')).toBe('transaction_costs');
    expect(costBucket('disposal_cost')).toBe('transaction_costs');
    expect(costBucket('external_outflow')).toBe('external_outflows');
  });
});

describe('classification of an income kind', () => {
  it('counts the seven 12.5 kinds and refuses the two that are not income', () => {
    for (const kind of ['employment', 'freelance', 'bonus', 'rental', 'other', 'dividend', 'interest'] as const) {
      expect(isExternalIncomeKind(kind)).toBe(true);
    }
    expect(isExternalIncomeKind('external_inflow')).toBe(false);
    expect(isExternalIncomeKind('adjustment')).toBe(false);
  });

  it('keeps external_inflow and adjustment out of ExternalIncome while they still explain the cash', () => {
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1500')]),
      ],
      income: [
        income({ netAmount: new Decimal('200') }),
        income({ kind: 'external_inflow', netAmount: new Decimal('180') }),
        income({ kind: 'adjustment', netAmount: new Decimal('120') }),
      ],
    });
    const result = savingsOf(input);
    // All three are `I` and all three explain the cash (7.4); only the salary
    // is income (12.5). The two classifications are deliberately different.
    expect(result.source.externalIncome.toString()).toBe('200');
    const bucket = reconcileCompletedMonth(input).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('500');
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('0');
  });

  it('turns both away from ExternalIncome while the bucket counts all of them', () => {
    // 100 + 200 + 300 of cash arrives and the month reconciles exactly; the
    // savings rate sees 100.
    const input = completedInput({
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
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
    expect(bucket?.status).toBe('reliable');

    const result = savingsOf(input);
    expect(result.source.externalIncome.toString()).toBe('100');
    if (result.derived.kind !== 'available') throw new Error('expected available');
    // Consumption is nothing, so the whole 100 of income was saved.
    expect(result.derived.consumption.toString()).toBe('0');
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('100');
  });

  it('leaves ordinary income settled external out of ExternalIncome and out of the cash roles', () => {
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1000')]),
      ],
      income: [income({ settlement: 'external', cashPositionId: null, netAmount: new Decimal('900') })],
    });
    expect(savingsOf(input).source.externalIncome.toString()).toBe('0');
    expect(reconcileCompletedMonth(input).buckets[0]?.totals.externalInflows.toString()).toBe('0');
  });
});

/* -------------------------------------------------------------------------- */
/* A — reliable completed                                                     */
/* -------------------------------------------------------------------------- */

describe('A — a reliable completed month', () => {
  const input = (): CompletedMonthInput =>
    completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1200')]),
      ],
      income: [income({ netAmount: new Decimal('900') })],
      expenses: [
        expense({ categoryKind: 'food', amount: new Decimal('200') }),
        expense({ categoryKind: 'transfer_fee', amount: new Decimal('10') }),
        expense({ categoryKind: 'external_outflow', amount: new Decimal('40') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('30') }),
        expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('70') }),
      ],
    });

  it('computes every 12.5 figure', () => {
    const result = savingsOf(input());
    // ΣI 900, ΣK 250, Δ 200 → tracked 700, unclassified 450.
    expect(result.reconciliationStatus).toBe('reliable');
    expect(result.source.externalIncome.toString()).toBe('900');
    expect(result.source.knownConsumption.toString()).toBe('200');
    expect(result.source.interestAndFees.toString()).toBe('10');
    expect(result.source.externalOutflows.toString()).toBe('40');
    expect(result.source.transactionCosts.toString()).toBe('0');
    expect(result.source.propertyOperatingCosts.toString()).toBe('0');
    expect(result.source.additionalSpending.toString()).toBe('30');
    expect(result.source.thirdPartyPaid.toString()).toBe('70');

    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.derived.quality).toBe('reliable');
    expect(result.derived.consumption.toString()).toBe('650');
    // 900 − 650 − 0 − 10 − 0. `ExternalOutflows` is deliberately not subtracted.
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('240');
    expect(result.derived.personalSavings.toString()).toBe('210');
    expect(result.derived.totalSpending.toString()).toBe('730');
    const rate = result.derived.savingsRate;
    if (isUnavailable(rate)) throw new Error('expected a rate');
    expect(rate.toString()).toBe(new Decimal('210').dividedBy(900).toString());
  });

  it('partitions ΣK and TrackedTotalSpending exactly', () => {
    const result = savingsOf(input());
    if (result.derived.kind !== 'available') throw new Error('expected available');
    const { source, derived } = result;
    const nonConsumption = source.propertyOperatingCosts
      .plus(source.interestAndFees)
      .plus(source.transactionCosts)
      .plus(source.externalOutflows);
    expect(source.knownConsumption.plus(nonConsumption).toString()).toBe('250');
    expect(derived.consumption.plus(nonConsumption).toString()).toBe('700');
  });
});

/* -------------------------------------------------------------------------- */
/* B — estimated / first_balance                                              */
/* -------------------------------------------------------------------------- */

describe('B — an estimated month excludes the first_balance account and its flows', () => {
  it('never lets the excluded account’s income or cost back in', () => {
    const input = completedInput({
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
    });

    const result = savingsOf(input);
    expect(result.reconciliationStatus).toBe('estimated');
    // The excluded account contributed neither income nor cost.
    expect(result.source.externalIncome.toString()).toBe('400');
    expect(result.source.interestAndFees.toString()).toBe('0');
    expect(result.source.knownConsumption.toString()).toBe('0');
    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.derived.quality).toBe('estimated');
    // ΣI 400, ΣK 0, Δ 300 → tracked 100, unclassified 100, consumption 100.
    expect(result.derived.consumption.toString()).toBe('100');
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('300');
  });
});

/* -------------------------------------------------------------------------- */
/* C and D — unresolved completed                                             */
/* -------------------------------------------------------------------------- */

describe('C and D — an unresolved month keeps its records and reports no spending figure', () => {
  it('C — the forgotten-salary shape produces no −1,241 total', () => {
    // Balances grew by 1,291 with nothing recorded to explain it, and 411 of
    // known expenses on top: tracked −1,291, unclassified −1,702.
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '2291')]),
      ],
      expenses: [
        expense({ categoryKind: 'insurance', amount: new Decimal('300') }),
        expense({ categoryKind: 'transfer_fee', amount: new Decimal('111') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
      ],
    });

    const result = savingsOf(input);
    expect(result.reconciliationStatus).toBe('unresolved');
    expect(result.source.knownConsumption.toString()).toBe('300');
    expect(result.source.interestAndFees.toString()).toBe('111');
    expect(result.source.additionalSpending.toString()).toBe('50');
    expect(result.derived).toEqual({ kind: 'unavailable', because: 'unresolved' });
    expect(JSON.stringify(result)).not.toContain('-1241');
  });

  it('D — a positive tracked total below its own known expenses produces no 150 total', () => {
    // ΣI 600, ΣK 500, Δ 500 → tracked 100, unclassified −400.
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1500')]),
      ],
      income: [income({ netAmount: new Decimal('600') })],
      expenses: [
        expense({ categoryKind: 'food', amount: new Decimal('500') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
      ],
    });

    const result = savingsOf(input);
    expect(result.reconciliationStatus).toBe('unresolved');
    expect(result.source.externalIncome.toString()).toBe('600');
    expect(result.source.knownConsumption.toString()).toBe('500');
    expect(result.source.additionalSpending.toString()).toBe('50');
    expect(result.derived).toEqual({ kind: 'unavailable', because: 'unresolved' });
    expect(JSON.stringify(result)).not.toContain('"150"');
  });
});

/* -------------------------------------------------------------------------- */
/* E — unavailable completed                                                  */
/* -------------------------------------------------------------------------- */

describe('E — an unavailable month still knows what its records said', () => {
  it('keeps every source classification and computes no derived figure', () => {
    const input = completedInput({
      cashAccounts: [
        // No September month-end balance: the month cannot be reconciled.
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000')]),
      ],
      income: [income({ netAmount: new Decimal('2100') })],
      expenses: [
        expense({ categoryKind: 'insurance', amount: new Decimal('300') }),
        expense({ categoryKind: 'acquisition_cost', amount: new Decimal('25') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
        expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('80') }),
      ],
    });

    const result = savingsOf(input);
    expect(result.reconciliationStatus).toBe('unavailable');
    expect(result.source.externalIncome.toString()).toBe('2100');
    expect(result.source.knownConsumption.toString()).toBe('300');
    expect(result.source.transactionCosts.toString()).toBe('25');
    expect(result.source.additionalSpending.toString()).toBe('50');
    expect(result.source.thirdPartyPaid.toString()).toBe('80');
    expect(result.derived).toEqual({
      kind: 'unavailable',
      because: 'reconciliation_unavailable',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* I and J — the rate, and the setting                                        */
/* -------------------------------------------------------------------------- */

describe('I — zero external income takes the rate and nothing else', () => {
  it('leaves every other derived figure valid', () => {
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '900')]),
      ],
      expenses: [expense({ categoryKind: 'food', amount: new Decimal('60') })],
    });

    const result = savingsOf(input);
    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.source.externalIncome.toString()).toBe('0');
    expect(result.derived.consumption.toString()).toBe('100');
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('-100');
    expect(result.derived.personalSavings.toString()).toBe('-100');
    expect(result.derived.totalSpending.toString()).toBe('100');
    expect(isUnavailable(result.derived.savingsRate)).toBe(true);
    expect(result.derived.savingsRate).toEqual({
      kind: 'unavailable',
      reason: 'divide_by_zero',
      detail: 'External income is zero.',
    });
  });
});

describe('J — count_additional_spending changes the rate, not the spending', () => {
  const input = (): CompletedMonthInput =>
    completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '2291')]),
      ],
      income: [income({ netAmount: new Decimal('2131') })],
      expenses: [
        expense({ categoryKind: 'insurance', amount: new Decimal('300') }),
        expense({ categoryKind: 'transfer_fee', amount: new Decimal('111') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
      ],
    });

  it('subtracts additional spending by default and not when the setting is off', () => {
    const counted = savingsOf(input(), EUR, true);
    const trackedOnly = savingsOf(input(), EUR, false);
    if (counted.derived.kind !== 'available') throw new Error('expected available');
    if (trackedOnly.derived.kind !== 'available') throw new Error('expected available');

    expect(counted.derived.trackedSavingsFromIncome.toString()).toBe(
      trackedOnly.derived.trackedSavingsFromIncome.toString(),
    );
    expect(
      trackedOnly.derived.personalSavings.minus(counted.derived.personalSavings).toString(),
    ).toBe('50');
    // Neither the spending nor the record itself moves.
    expect(counted.derived.totalSpending.toString()).toBe(
      trackedOnly.derived.totalSpending.toString(),
    );
    expect(counted.source.additionalSpending.toString()).toBe('50');
    expect(trackedOnly.source.additionalSpending.toString()).toBe('50');
    expect(counted.derived.countsAdditionalSpending).toBe(true);
    expect(trackedOnly.derived.countsAdditionalSpending).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The 12.7 savings golden                                                    */
/* -------------------------------------------------------------------------- */

describe('the §12.7 savings golden', () => {
  /**
   * `savings/september-basic`. The interest of 111 is a **classification of
   * part of the month's own ΣK**, not a second cost: Phase 3 has no
   * liability-payment source model, and inventing one would be claiming a
   * phase that does not exist. Supplying it through the one normalized
   * breakdown is exactly how Phase 5 will supply it.
   */
  const golden = (countAdditionalSpending: boolean): SavingsResult =>
    reconcileSavings({
      currency: EUR,
      reconciliation: {
        status: 'reliable',
        knownTrackedExpenses: new Decimal('411'),
        trackedTotalSpending: new Decimal('840'),
        unclassified: new Decimal('429'),
      },
      externalIncome: new Decimal('2131'),
      nonConsumptionCosts: {
        ...NO_NON_CONSUMPTION_COSTS,
        interestAndFees: new Decimal('111'),
      },
      additionalSpending: new Decimal('50'),
      thirdPartyPaid: new Decimal('80'),
      countAdditionalSpending,
    });

  it('reproduces every figure of 12.7 with the setting on', () => {
    const result = golden(true);
    expect(result.source.externalIncome.toString()).toBe('2131');
    expect(result.source.knownConsumption.toString()).toBe('300');
    expect(result.source.interestAndFees.toString()).toBe('111');
    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.derived.consumption.toString()).toBe('729');
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('1291');
    expect(result.derived.personalSavings.toString()).toBe('1241');
    expect(result.derived.totalSpending.toString()).toBe('890');

    const rate = result.derived.savingsRate;
    if (isUnavailable(rate)) throw new Error('expected a rate');
    // Exact and unrounded in finance; 7.3 rounds only at the display boundary.
    expect(rate.toString()).toBe(new Decimal('1241').dividedBy(2131).toString());
    expect(rate.times(100).toDecimalPlaces(2).toString()).toBe('58.24');
  });

  it('reproduces the tracked-only figures with the setting off', () => {
    const result = golden(false);
    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.derived.personalSavings.toString()).toBe('1291');
    const rate = result.derived.savingsRate;
    if (isUnavailable(rate)) throw new Error('expected a rate');
    expect(rate.toString()).toBe(new Decimal('1291').dividedBy(2131).toString());
    expect(rate.times(100).toDecimalPlaces(2).toString()).toBe('60.58');
    // Total spending is not a preference.
    expect(result.derived.totalSpending.toString()).toBe('890');
  });

  it('is unmoved by what someone else paid', () => {
    const withMemo = golden(true);
    const withoutMemo = reconcileSavings({
      currency: EUR,
      reconciliation: {
        status: 'reliable',
        knownTrackedExpenses: new Decimal('411'),
        trackedTotalSpending: new Decimal('840'),
        unclassified: new Decimal('429'),
      },
      externalIncome: new Decimal('2131'),
      nonConsumptionCosts: { ...NO_NON_CONSUMPTION_COSTS, interestAndFees: new Decimal('111') },
      additionalSpending: new Decimal('50'),
      thirdPartyPaid: new Decimal('0'),
      countAdditionalSpending: true,
    });
    expect({ ...withMemo, source: { ...withMemo.source, thirdPartyPaid: new Decimal('0') } }).toEqual(
      withoutMemo,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Conservation                                                               */
/* -------------------------------------------------------------------------- */

describe('the cost partition is a classification of ΣK, never an addition', () => {
  it('refuses a classification larger than the known tracked expenses', () => {
    expect(() =>
      reconcileSavings({
        currency: EUR,
        reconciliation: {
          status: 'reliable',
          knownTrackedExpenses: new Decimal('100'),
          trackedTotalSpending: new Decimal('100'),
          unclassified: new Decimal('0'),
        },
        externalIncome: new Decimal('0'),
        nonConsumptionCosts: {
          ...NO_NON_CONSUMPTION_COSTS,
          interestAndFees: new Decimal('100.00000001'),
        },
        additionalSpending: new Decimal('0'),
        thirdPartyPaid: new Decimal('0'),
        countAdditionalSpending: true,
      }),
    ).toThrow(CostClassificationExceedsKnownError);
  });

  it('accepts a classification that exactly exhausts them', () => {
    const result = reconcileSavings({
      currency: EUR,
      reconciliation: {
        status: 'reliable',
        knownTrackedExpenses: new Decimal('100'),
        trackedTotalSpending: new Decimal('100'),
        unclassified: new Decimal('0'),
      },
      externalIncome: new Decimal('0'),
      nonConsumptionCosts: { ...NO_NON_CONSUMPTION_COSTS, interestAndFees: new Decimal('100') },
      additionalSpending: new Decimal('0'),
      thirdPartyPaid: new Decimal('0'),
      countAdditionalSpending: true,
    });
    expect(result.source.knownConsumption.toString()).toBe('0');
  });
});

/* -------------------------------------------------------------------------- */
/* F, G, K, L — the current month                                             */
/* -------------------------------------------------------------------------- */

function mtdInput(over: Partial<MonthToDateInput> = {}): MonthToDateInput {
  return {
    today: plainDate('2026-09-10'),
    cashAccounts: [],
    income: [],
    expenses: [],
    transfers: [],
    ...over,
  };
}

/** The current-month equivalent of `savingsOf`, cut at `D`. */
function mtdSavingsOf(
  input: MonthToDateInput,
  currency: CurrencyCode = EUR,
  countAdditionalSpending = true,
): { asOf: PlainDate; result: SavingsResult } {
  const mtd = reconcileMonthToDate(input);
  if (mtd.asOf === null) throw new Error('expected a common date');
  const bucket = mtd.buckets.find((b) => b.currency === currency);
  if (bucket === undefined) throw new Error(`no ${currency} bucket`);
  const classified = classifyBucketInterval(
    input,
    input.expenses,
    currency,
    bucket.accounts,
    SEP_START,
    mtd.asOf,
  );
  return {
    asOf: mtd.asOf,
    result: reconcileSavings({
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
  };
}

describe('F and G — the current month stops where the evidence stops', () => {
  const accounts = (): CashAccountInput[] => [
    account(A, 'BBVA', [
      monthEnd(A, '2026-08-31', '1000'),
      valuation(A, '2026-09-06', '1400'),
    ]),
  ];

  it('F — computes every figure through D', () => {
    const { asOf, result } = mtdSavingsOf(
      mtdInput({
        cashAccounts: accounts(),
        income: [income({ receivedOn: plainDate('2026-09-03'), netAmount: new Decimal('600') })],
        expenses: [
          expense({ incurredOn: plainDate('2026-09-04'), amount: new Decimal('150') }),
          expense({
            incurredOn: plainDate('2026-09-05'),
            settlement: 'untracked_self',
            cashPositionId: null,
            amount: new Decimal('50'),
          }),
        ],
      }),
    );

    expect(asOf).toBe(plainDate('2026-09-06'));
    expect(result.reconciliationStatus).toBe('provisional');
    expect(result.source.externalIncome.toString()).toBe('600');
    expect(result.source.knownConsumption.toString()).toBe('150');
    expect(result.source.additionalSpending.toString()).toBe('50');
    if (result.derived.kind !== 'available') throw new Error('expected available');
    expect(result.derived.quality).toBe('provisional');
    // ΣI 600, ΣK 150, Δ 400 → tracked 200, unclassified 50, consumption 200.
    expect(result.derived.consumption.toString()).toBe('200');
    expect(result.derived.trackedSavingsFromIncome.toString()).toBe('400');
    expect(result.derived.personalSavings.toString()).toBe('350');
    expect(result.derived.totalSpending.toString()).toBe('250');
  });

  it('G — leaves an untracked expense dated after D out of every through-D figure', () => {
    const base = {
      cashAccounts: accounts(),
      income: [income({ receivedOn: plainDate('2026-09-03'), netAmount: new Decimal('600') })],
    };
    const before = mtdSavingsOf(
      mtdInput({
        ...base,
        expenses: [
          expense({ incurredOn: plainDate('2026-09-04'), amount: new Decimal('150') }),
          expense({
            incurredOn: plainDate('2026-09-05'),
            settlement: 'untracked_self',
            cashPositionId: null,
            amount: new Decimal('50'),
          }),
        ],
      }),
    );
    const after = mtdSavingsOf(
      mtdInput({
        ...base,
        expenses: [
          expense({ incurredOn: plainDate('2026-09-04'), amount: new Decimal('150') }),
          // The same expense, two days after D.
          expense({
            incurredOn: plainDate('2026-09-08'),
            settlement: 'untracked_self',
            cashPositionId: null,
            amount: new Decimal('50'),
          }),
        ],
      }),
    );

    expect(after.asOf).toBe(plainDate('2026-09-06'));
    expect(after.result.source.additionalSpending.toString()).toBe('0');
    if (before.result.derived.kind !== 'available') throw new Error('expected available');
    if (after.result.derived.kind !== 'available') throw new Error('expected available');
    expect(after.result.derived.personalSavings.toString()).toBe('400');
    expect(before.result.derived.personalSavings.toString()).toBe('350');
    expect(after.result.derived.totalSpending.toString()).toBe('200');
    expect(before.result.derived.totalSpending.toString()).toBe('250');
  });
});

describe('K and L — a valid D does not make every bucket provisional', () => {
  it('K — an unresolved bucket keeps its records and reports no spending figure', () => {
    const { result } = mtdSavingsOf(
      mtdInput({
        cashAccounts: [
          account(A, 'BBVA', [
            monthEnd(A, '2026-08-31', '1000'),
            valuation(A, '2026-09-06', '2000'),
          ]),
        ],
        expenses: [expense({ incurredOn: plainDate('2026-09-02'), amount: new Decimal('80') })],
      }),
    );

    // Cash grew 1,000 with nothing recorded: unclassified −1,080.
    expect(result.reconciliationStatus).toBe('unresolved');
    expect(result.source.knownConsumption.toString()).toBe('80');
    expect(result.derived).toEqual({ kind: 'unavailable', because: 'unresolved' });
  });

  it('L — one bucket’s missing opening leaves the other bucket’s savings standing', () => {
    const input = mtdInput({
      cashAccounts: [
        // EUR has a snapshot before September but no August month-end balance,
        // so its opening is `carried`: unusable, and not a `first_balance`
        // exclusion — the bucket fails with `missing_opening` and keeps its
        // account, and therefore keeps that account's flows.
        account(A, 'BBVA', [
          valuation(A, '2026-08-20', '1000'),
          valuation(A, '2026-09-06', '900'),
        ]),
        account(B, 'Dollars', [
          monthEnd(B, '2026-08-31', '500'),
          valuation(B, '2026-09-06', '400'),
        ], { currency: 'USD' }),
      ],
      expenses: [
        expense({ incurredOn: plainDate('2026-09-02'), amount: new Decimal('60') }),
        expense({
          incurredOn: plainDate('2026-09-03'),
          currency: USD,
          cashPositionId: B,
          amount: new Decimal('100'),
        }),
      ],
    });

    const mtd = reconcileMonthToDate(input);
    expect(mtd.asOf).toBe(plainDate('2026-09-06'));
    expect(mtd.status).toBe('unavailable');

    const eur = mtdSavingsOf(input, EUR).result;
    expect(eur.reconciliationStatus).toBe('unavailable');
    // Its records still say what they say.
    expect(eur.source.knownConsumption.toString()).toBe('60');
    expect(eur.derived).toEqual({
      kind: 'unavailable',
      because: 'reconciliation_unavailable',
    });

    const usd = mtdSavingsOf(input, USD).result;
    expect(usd.reconciliationStatus).toBe('provisional');
    if (usd.derived.kind !== 'available') throw new Error('expected available');
    expect(usd.derived.quality).toBe('provisional');
    // ΣK 100, Δ −100 → tracked 100, unclassified 0, consumption 100.
    expect(usd.derived.consumption.toString()).toBe('100');
    expect(usd.derived.totalSpending.toString()).toBe('100');
  });
});

/* -------------------------------------------------------------------------- */
/* M — a currency with no reconciliation bucket                               */
/* -------------------------------------------------------------------------- */

describe('M — untracked spending exists in a currency that reconciles nothing', () => {
  it('classifies the source rows without a bucket to hang them on', () => {
    const input = completedInput({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1000')]),
      ],
      expenses: [
        expense({
          currency: GBP,
          cashPositionId: null,
          settlement: 'untracked_self',
          amount: new Decimal('50'),
        }),
        expense({
          currency: GBP,
          cashPositionId: null,
          settlement: 'third_party',
          amount: new Decimal('80'),
        }),
      ],
    });

    // No GBP cash account and no GBP tracked flow, so no GBP bucket exists.
    expect(reconcileCompletedMonth(input).buckets.map((b) => b.currency)).toEqual(['EUR']);

    // The records are still there, and classification finds them.
    const gbp = classifyBucketInterval(input, input.expenses, GBP, [], SEP_START, SEP_END);
    expect(gbp.additionalSpending.toString()).toBe('50');
    expect(gbp.thirdPartyPaid.toString()).toBe('80');
    expect(gbp.externalIncome.toString()).toBe('0');
  });
});

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

describe('the result makes an illegal combination unrepresentable', () => {
  it('carries the five derived figures together or not at all', () => {
    const unavailableInput = completedInput({
      cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000')])],
    });
    const result = savingsOf(unavailableInput);
    expect(result.derived.kind).toBe('unavailable');
    const serialised = JSON.stringify(result);
    for (const field of [
      'consumption',
      'trackedSavingsFromIncome',
      'personalSavings',
      'totalSpending',
      'savingsRate',
    ]) {
      expect(serialised).not.toContain(field);
    }
  });

  it('distinguishes a contradiction from missing evidence', () => {
    const unresolved = savingsOf(
      completedInput({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1500')]),
        ],
      }),
    );
    const unavailable = savingsOf(
      completedInput({ cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000')])] }),
    );
    expect(unresolved.derived).toEqual({ kind: 'unavailable', because: 'unresolved' });
    expect(unavailable.derived).toEqual({
      kind: 'unavailable',
      because: 'reconciliation_unavailable',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* -------------------------------------------------------------------------- */

describe('a transfer is neither income nor cost', () => {
  it('moves cash without touching a single 12.5 classification', () => {
    const transfer: TransferFlow = {
      id: 'transfer-1',
      kind: 'cash_transfer',
      occurredOn: plainDate('2026-09-05'),
      fromPositionId: A,
      fromCurrency: EUR,
      fromAmount: new Decimal('300'),
      toPositionId: B,
      toCurrency: EUR,
      toAmount: new Decimal('300'),
    };
    const base = {
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '700')]),
        account(B, 'Savings', [monthEnd(B, '2026-08-31', '0'), monthEnd(B, '2026-09-30', '300')]),
      ],
      income: [income({ netAmount: new Decimal('500') })],
    };

    const without = savingsOf(completedInput(base));
    const with_ = savingsOf(completedInput({ ...base, transfers: [transfer] }));
    expect(with_.source).toEqual(without.source);
    expect(with_.derived).toEqual(without.derived);
  });
});
