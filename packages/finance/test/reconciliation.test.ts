import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import { monthEnd, position, valuation } from './helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../src/flows/types';
import {
  MonthNotCompletedError,
  occurrenceKey,
  reconcileCompletedMonth,
  worstStatus,
  type CashAccountInput,
  type CompletedMonthInput,
  type CompletenessTemplate,
} from '../src/reconciliation/index';
import * as golden from './golden/basic-eur-september/fixture';

/**
 * Completed-month reconciliation (blueprint 8.1–8.5, 8.10).
 *
 * The golden figures were computed by hand from the source records before these
 * assertions were written; the working is in the fixture's README, not taken
 * from the engine's output. Every other case here is one sentence of 8.1, 8.4,
 * 8.5 or 8.8 turned into a test.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const SEPTEMBER = monthKeyOf(2026, 9);
const FIRST_OF_OCTOBER = plainDate('2026-10-01');

const BBVA = 'bbva';
const SAVINGS = 'savings';

function account(
  id: string,
  name: string,
  valuations: CashAccountInput['valuations'],
  options: { currency?: string; openedOn?: string; closedOn?: string; isDormant?: boolean } = {},
  accountType = 'checking',
): CashAccountInput {
  return {
    position: position(name, {
      id,
      currency: options.currency ?? 'EUR',
      ...(options.openedOn === undefined ? {} : { openedOn: options.openedOn }),
      ...(options.closedOn === undefined ? {} : { closedOn: options.closedOn, status: 'closed' }),
      ...(options.isDormant === undefined ? {} : { isDormant: options.isDormant }),
    }),
    valuations,
    accountType,
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
    cashPositionId: BBVA,
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
    cashPositionId: BBVA,
    ...over,
  };
}

function transfer(over: Partial<TransferFlow> = {}): TransferFlow {
  return {
    id: nextId('transfer'),
    kind: 'cash_transfer',
    occurredOn: plainDate('2026-09-05'),
    fromPositionId: BBVA,
    fromCurrency: EUR,
    fromAmount: new Decimal('200'),
    toPositionId: SAVINGS,
    toCurrency: EUR,
    toAmount: new Decimal('200'),
    ...over,
  };
}

function input(over: Partial<CompletedMonthInput> = {}): CompletedMonthInput {
  return {
    month: SEPTEMBER,
    today: FIRST_OF_OCTOBER,
    cashAccounts: [],
    income: [],
    expenses: [],
    transfers: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
    ...over,
  };
}

/** One EUR account that ends the month `change` lower than it started. */
function oneAccount(change: string): CashAccountInput {
  return account(BBVA, 'BBVA', [
    monthEnd(BBVA, '2026-08-31', '1000'),
    monthEnd(BBVA, '2026-09-30', new Decimal('1000').plus(change).toString()),
  ]);
}

describe('the 8.10 golden, as recorded', () => {
  const result = reconcileCompletedMonth(golden.input());
  const bucket = result.buckets[0];

  it('reconciles one EUR bucket', () => {
    expect(result.buckets).toHaveLength(1);
    expect(bucket?.currency).toBe('EUR');
  });

  it('computes the cash change as 56', () => {
    // (7,880 − 8,055) + (8,740 − 8,509) = −175 + 231
    expect(bucket?.totals.cashDelta.toString()).toBe('56');
  });

  it('sums the four roles exactly as 8.10 does', () => {
    expect(bucket?.totals.externalInflows.toString()).toBe('2100');
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('200');
    // 200 transferred out + 1,000 contributed + 235 mortgage principal.
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('1435');
    // 300 insurance + 111 mortgage interest. Neither untracked expense is in K.
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('411');
  });

  it('infers tracked total spending of 809 and unclassified of 398', () => {
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('809');
    expect(bucket?.totals.unclassified?.toString()).toBe('398');
  });

  it('is reliable', () => {
    expect(bucket?.status).toBe('reliable');
    expect(result.monthStatus).toBe('reliable');
  });

  it('keeps the untracked expenses out of the identity and beside it', () => {
    expect(bucket?.additionalSpending.toString()).toBe('50');
    expect(bucket?.thirdPartyPaid.toString()).toBe('80');
    // 8.10 presents total spending as 809 + 50; the 80 is in no total at all.
    expect(
      bucket?.totals.trackedTotalSpending?.plus(bucket.additionalSpending).toString(),
    ).toBe('859');
  });

  it('reports the two per-account residuals', () => {
    const bbva = bucket?.accounts.find((a) => a.positionId === golden.ids.bbva);
    const savings = bucket?.accounts.find((a) => a.positionId === golden.ids.savings);
    // −175 − (2,100 − 200 − 1,000 − 346 − 300) = −175 − 254
    expect(bbva?.residual?.toString()).toBe('-429');
    expect(savings?.residual?.toString()).toBe('31');
    // 8.10's own cross-check: 398 = 429 − 31.
    expect(new Decimal('429').minus('31').toString()).toBe(
      bucket?.totals.unclassified?.toString(),
    );
  });

  it('raises possible_missing_interest on the savings account', () => {
    // +31 on a savings-shaped account, and 31 < 0.5 % of 8,740 (= 43.70).
    const issue = bucket?.issues.find((i) => i.key === 'possible_missing_interest');
    expect(issue?.positionId).toBe(golden.ids.savings);
    expect(issue?.amount?.toString()).toBe('31');
    expect(issue?.class).toBe('advisory');
  });

  it('satisfies open + I + Nin − Nout − K − close = Unclassified', () => {
    const opening = new Decimal('8055').plus('8509');
    const closing = new Decimal('7880').plus('8740');
    const identity = opening.plus('2100').plus('200').minus('1435').minus('411').minus(closing);
    expect(identity.toString()).toBe('398');
  });

  it('explains itself with the real inputs', () => {
    expect(bucket?.explanation.join(' ')).toContain('2100 in + 200 moved in − 1435 moved out');
  });
});

describe('the 8.10 golden with the €31 interest recorded', () => {
  const result = reconcileCompletedMonth(golden.input({ withInterest: true }));
  const bucket = result.buckets[0];

  it('raises ΣI to 2,131 and tracked total spending to 840', () => {
    expect(bucket?.totals.externalInflows.toString()).toBe('2131');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('840');
  });

  it('leaves known tracked expenses at 411 and unclassified at 429', () => {
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('411');
    expect(bucket?.totals.unclassified?.toString()).toBe('429');
  });

  it('is still reliable, and no longer suspects missing interest', () => {
    expect(bucket?.status).toBe('reliable');
    const savings = bucket?.accounts.find((a) => a.positionId === golden.ids.savings);
    expect(savings?.residual?.toString()).toBe('0');
    expect(bucket?.issues.some((i) => i.key === 'possible_missing_interest')).toBe(false);
  });
});

describe('the 8.10 golden with the salary forgotten', () => {
  const result = reconcileCompletedMonth(golden.input({ withoutSalary: true }));
  const bucket = result.buckets[0];

  it('computes a tracked total of −1,291', () => {
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('-1291');
  });

  it('is unresolved, with a blocking unexplained inflow of 1,702', () => {
    expect(bucket?.totals.unclassified?.toString()).toBe('-1702');
    expect(bucket?.status).toBe('unresolved');
    expect(result.monthStatus).toBe('unresolved');

    const issue = bucket?.issues.find((i) => i.key === 'unexplained_inflow');
    expect(issue?.amount?.toString()).toBe('1702');
    expect(issue?.class).toBe('blocking');
    // v2.1.8 30.11: the tracked total is negative, so this is variant A —
    // cash grew more than the records explain, which is exactly the salary
    // nobody entered. Under v2.1.7 it read as B, and that was the defect.
    expect(issue?.variant).toBe('a');
  });

  it('neither clamps the negative figure nor reports it as spending', () => {
    expect(bucket?.totals.unclassified?.lessThan(0)).toBe(true);
    expect(bucket?.totals.trackedTotalSpending?.lessThan(0)).toBe(true);
  });
});

describe('the unexplained-inflow variants of v2.1.8 30.11', () => {
  /** The issue this bucket raised, if it raised one. */
  const inflowOf = (bucket: { issues: readonly { key: string; variant?: 'a' | 'b' }[] } | undefined) =>
    bucket?.issues.find((i) => i.key === 'unexplained_inflow');

  it('reads variant A when the tracked total is negative', () => {
    // Δ = +0.01 with nothing recorded: total −0.01, ΣK 0, unclassified −0.01.
    // Cash grew and no record says why, which is the forgotten-income shape.
    const bucket = reconcileCompletedMonth(
      input({ cashAccounts: [oneAccount('0.01')] }),
    ).buckets[0];
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('-0.01');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.unclassified?.toString()).toBe('-0.01');
    expect(inflowOf(bucket)?.variant).toBe('a');
    expect(bucket?.status).toBe('unresolved');
  });

  it('reads variant B at a tracked total of exactly zero', () => {
    // 30.11 puts zero on B's side: the flows explain the cash exactly, which is
    // not growth, even though a known expense the cash cannot account for
    // remains. Δ = 0, ΣK = 0.01 → total 0, unclassified −0.01.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        expenses: [expense({ amount: new Decimal('0.01') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0.01');
    expect(bucket?.totals.unclassified?.toString()).toBe('-0.01');
    expect(inflowOf(bucket)?.variant).toBe('b');
    expect(bucket?.status).toBe('unresolved');
  });

  it('raises nothing when the tracked total and the known expenses are both zero', () => {
    const bucket = reconcileCompletedMonth(
      input({ cashAccounts: [oneAccount('0')] }),
    ).buckets[0];
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
    expect(inflowOf(bucket)).toBeUndefined();
    expect(bucket?.status).toBe('reliable');
  });

  it('reads variant B for a positive tracked total the known expenses exceed', () => {
    // Δ = −100 with a 120 expense: total 100, ΣK 120, unclassified −20.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-100')],
        expenses: [expense({ amount: new Decimal('120') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('100');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('120');
    expect(bucket?.totals.unclassified?.toString()).toBe('-20');
    expect(inflowOf(bucket)?.variant).toBe('b');
  });

  it('reports the magnitude of the unclassified figure in both variants', () => {
    const a = reconcileCompletedMonth(input({ cashAccounts: [oneAccount('300')] })).buckets[0];
    expect(a?.totals.unclassified?.toString()).toBe('-300');
    expect(inflowOf(a)?.variant).toBe('a');
    expect(a?.issues.find((i) => i.key === 'unexplained_inflow')?.amount?.toString()).toBe('300');

    const b = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-100')],
        expenses: [expense({ amount: new Decimal('120') })],
      }),
    ).buckets[0];
    expect(b?.issues.find((i) => i.key === 'unexplained_inflow')?.amount?.toString()).toBe('20');
  });

  it('raises nothing at all when the arithmetic comes out non-negative', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-100')],
        income: [income({ netAmount: new Decimal('300') })],
        expenses: [expense({ amount: new Decimal('100') })],
      }),
    ).buckets[0];
    // Δ = −100, ΣI = 300, ΣK = 100 → total 400, unclassified 300.
    expect(bucket?.totals.unclassified?.toString()).toBe('300');
    expect(bucket?.issues.some((i) => i.key === 'unexplained_inflow')).toBe(false);
    expect(bucket?.status).toBe('reliable');
  });

  it('treats exactly zero unclassified as reconciled, with no tolerance either way', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-100')],
        expenses: [expense({ amount: new Decimal('100') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
    expect(bucket?.status).toBe('reliable');
  });

  it('is unresolved for a single cent, because the tolerance is exactly zero', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-100')],
        expenses: [expense({ amount: new Decimal('100.01') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.unclassified?.toString()).toBe('-0.01');
    expect(bucket?.status).toBe('unresolved');
  });
});

describe('completed months only', () => {
  it('refuses a month that has not ended', () => {
    expect(() => reconcileCompletedMonth(input({ today: plainDate('2026-09-30') }))).toThrow(
      MonthNotCompletedError,
    );
  });

  it('accepts the month from the first day it is over', () => {
    expect(() =>
      reconcileCompletedMonth(input({ today: plainDate('2026-10-01') })),
    ).not.toThrow();
  });

  it('never returns provisional', () => {
    // 8.4/8.6: `provisional` is the current month's status and belongs to a
    // different engine. The enum carries it; this engine must never emit it.
    const result = reconcileCompletedMonth(golden.input());
    expect(result.monthStatus).not.toBe('provisional');
    for (const bucket of result.buckets) expect(bucket.status).not.toBe('provisional');
  });
});

describe('endpoint evidence', () => {
  it('is unavailable when the month-end balance is missing', () => {
    const result = reconcileCompletedMonth(
      input({
        cashAccounts: [account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '8055')])],
        income: [income()],
      }),
    );
    const bucket = result.buckets[0];
    expect(bucket?.accounts[0]?.closing.state).toBe('carried');
    expect(bucket?.status).toBe('unavailable');
    expect(bucket?.issues.find((i) => i.key === 'missing_month_end')?.class).toBe('blocking');
  });

  it('reports no figure at all rather than a confident zero', () => {
    const bucket = reconcileCompletedMonth(
      input({ cashAccounts: [account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '8055')])] }),
    ).buckets[0];
    expect(bucket?.totals.trackedTotalSpending).toBeUndefined();
    expect(bucket?.totals.unclassified).toBeUndefined();
  });

  it('does not accept an ordinary last-day snapshot as the statement balance', () => {
    // 8.8: until it is confirmed, a snapshot dated the 30th is a snapshot.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '8055'),
            valuation(BBVA, '2026-09-30', '7880'),
          ]),
        ],
      }),
    ).buckets[0];
    expect(bucket?.accounts[0]?.closing.state).toBe('carried');
    expect(bucket?.status).toBe('unavailable');
  });

  it('is unavailable when no valuation exists at all', () => {
    const bucket = reconcileCompletedMonth(
      input({ cashAccounts: [account(BBVA, 'BBVA', [])] }),
    ).buckets[0];
    expect(bucket?.accounts[0]?.closing.state).toBe('missing');
    expect(bucket?.status).toBe('unavailable');
  });

  it('closes at zero for an account closed inside the month', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '100')], {
            closedOn: '2026-09-20',
          }),
        ],
      }),
    ).buckets[0];
    expect(bucket?.accounts[0]?.closing.state).toBe('closed_zero');
    // 8.8: the remaining balance must have been transferred out, or it is
    // spending — and nobody said where it went.
    expect(bucket?.totals.cashDelta.toString()).toBe('-100');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('100');
    expect(bucket?.status).toBe('reliable');
  });

  it('opens at zero for an account opened inside the month', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'New', [monthEnd(BBVA, '2026-09-30', '500')], {
            openedOn: '2026-09-03',
          }),
        ],
        income: [income({ netAmount: new Decimal('500') })],
      }),
    ).buckets[0];
    expect(bucket?.accounts[0]?.opening.state).toBe('opened_zero');
    expect(bucket?.totals.cashDelta.toString()).toBe('500');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.status).toBe('reliable');
  });

  it('carries a dormant account at zero and never lets it affect the status', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '100'),
            monthEnd(BBVA, '2026-09-30', '100'),
          ]),
          account(SAVINGS, 'Old account', [valuation(SAVINGS, '2026-01-01', '0')], {
            isDormant: true,
          }),
        ],
      }),
    ).buckets[0];
    const dormant = bucket?.accounts.find((a) => a.positionId === SAVINGS);
    expect(dormant?.closing.state).toBe('dormant_zero');
    expect(dormant?.dormant).toBe(true);
    expect(bucket?.status).toBe('reliable');
  });
});

describe('an account whose first balance lands in the month', () => {
  const newlyTracked = (): CashAccountInput =>
    account(SAVINGS, 'Savings', [monthEnd(SAVINGS, '2026-09-30', '5000')], {}, 'savings');

  it('is excluded, and the month says estimated', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '8055'),
            monthEnd(BBVA, '2026-09-30', '3055'),
          ]),
          newlyTracked(),
        ],
        transfers: [transfer({ fromAmount: new Decimal('5000'), toAmount: new Decimal('5000') })],
      }),
    ).buckets[0];
    const savings = bucket?.accounts.find((a) => a.positionId === SAVINGS);

    expect(savings?.opening.state).toBe('first_balance');
    expect(savings?.excludedFirstBalance).toBe(true);
    expect(savings?.included).toBe(false);
    expect(bucket?.status).toBe('estimated');
    expect(bucket?.issues.find((i) => i.key === 'first_balance')?.class).toBe('info');
  });

  it('never fabricates an opening balance for it', () => {
    const bucket = reconcileCompletedMonth(input({ cashAccounts: [newlyTracked()] })).buckets[0];
    expect(bucket?.accounts[0]?.opening.amount).toBeUndefined();
    // 12.3: 5,000 newly tracked is not 5,000 of cash change, so with nothing
    // else in the bucket there is nothing to reconcile.
    expect(bucket?.status).toBe('unavailable');
  });

  it('drops the leg attributed to it without discarding the other side', () => {
    // 8.8: BBVA → Savings 5,000 contributes only its BBVA `Nout` against BBVA's
    // Δ of −5,000, so spending is unaffected. The transfer does not cancel, and
    // it is not made to.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '8055'),
            monthEnd(BBVA, '2026-09-30', '3055'),
          ]),
          newlyTracked(),
        ],
        transfers: [transfer({ fromAmount: new Decimal('5000'), toAmount: new Decimal('5000') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('5000');
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('0');
    expect(bucket?.totals.cashDelta.toString()).toBe('-5000');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('transfers', () => {
  const pair = (): CashAccountInput[] => [
    account(BBVA, 'BBVA', [
      monthEnd(BBVA, '2026-08-31', '1000'),
      monthEnd(BBVA, '2026-09-30', '800'),
    ]),
    account(SAVINGS, 'Savings', [
      monthEnd(SAVINGS, '2026-08-31', '0'),
      monthEnd(SAVINGS, '2026-09-30', '200'),
    ]),
  ];

  it('cancels exactly within one currency', () => {
    const bucket = reconcileCompletedMonth(
      input({ cashAccounts: pair(), transfers: [transfer()] }),
    ).buckets[0];
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('200');
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(bucket?.totals.cashDelta.toString()).toBe('0');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('splits a cross-currency transfer into two native buckets with no FX effect', () => {
    const result = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '1000'),
            monthEnd(BBVA, '2026-09-30', '800'),
          ]),
          account(
            SAVINGS,
            'USD account',
            [monthEnd(SAVINGS, '2026-08-31', '0'), monthEnd(SAVINGS, '2026-09-30', '216.45')],
            { currency: 'USD' },
          ),
        ],
        transfers: [transfer({ toCurrency: USD, toAmount: new Decimal('216.45') })],
      }),
    );
    expect(result.buckets.map((b) => b.currency)).toEqual(['EUR', 'USD']);

    const eur = result.buckets.find((b) => b.currency === 'EUR');
    const usd = result.buckets.find((b) => b.currency === 'USD');
    expect(eur?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(eur?.totals.nonIncomeInflows.toString()).toBe('0');
    expect(usd?.totals.nonIncomeInflows.toString()).toBe('216.45');
    // Each bucket reconciles to nothing on its own: no conversion happens here.
    expect(eur?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(usd?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('counts a linked fee once, as an ordinary known expense', () => {
    const moved = transfer();
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '1000'),
            monthEnd(BBVA, '2026-09-30', '798.50'),
          ]),
          account(SAVINGS, 'Savings', [
            monthEnd(SAVINGS, '2026-08-31', '0'),
            monthEnd(SAVINGS, '2026-09-30', '200'),
          ]),
        ],
        transfers: [moved],
        expenses: [
          expense({
            categoryKind: 'transfer_fee',
            amount: new Decimal('1.50'),
            incurredOn: plainDate('2026-09-05'),
            transferId: moved.id,
          }),
        ],
      }),
    ).buckets[0];
    // 8.8: the fee is one expense row linked to the transfer, which is what
    // makes it impossible to count twice.
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('1.5');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('1.5');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
  });

  it('places a contribution with a null source in the stated currency', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('-1000')],
        transfers: [
          transfer({
            kind: 'contribution',
            fromPositionId: null,
            fromAmount: new Decimal('1000'),
            toPositionId: 'some-investment',
            toAmount: new Decimal('1000'),
          }),
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('1000');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('roles, inside the identity', () => {
  const withExpenses = (expenses: ExpenseFlow[]) =>
    reconcileCompletedMonth(input({ cashAccounts: [oneAccount('-100')], expenses })).buckets[0];

  it('keeps external_outflow as a known expense', () => {
    const bucket = withExpenses([
      expense({ categoryKind: 'external_outflow', amount: new Decimal('100') }),
    ]);
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('100');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
  });

  it('treats a capital improvement as Nout, so it is not spending', () => {
    const bucket = withExpenses([
      expense({ categoryKind: 'capital_improvement', amount: new Decimal('100') }),
    ]);
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('100');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('leaves untracked_self and third_party out of every sum', () => {
    const bucket = withExpenses([
      expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
      expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('80') }),
    ]);
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    // The 100 that left is still unexplained: neither untracked expense
    // explains it, which is exactly the point of keeping them out.
    expect(bucket?.totals.unclassified?.toString()).toBe('100');
    expect(bucket?.additionalSpending.toString()).toBe('50');
    expect(bucket?.thirdPartyPaid.toString()).toBe('80');
  });

  it('makes external_inflow and adjustment Nin rather than income', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('300')],
        income: [
          income({ kind: 'external_inflow', netAmount: new Decimal('200') }),
          income({ kind: 'adjustment', netAmount: new Decimal('100') }),
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('0');
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('300');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('ignores income that never reached tracked cash', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        income: [
          income({ settlement: 'external', cashPositionId: null, netAmount: new Decimal('400') }),
          income({ settlement: 'reinvested', cashPositionId: null, netAmount: new Decimal('30') }),
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('0');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('ignores flows dated outside the month', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        income: [
          income({ receivedOn: plainDate('2026-08-31'), netAmount: new Decimal('900') }),
          income({ receivedOn: plainDate('2026-10-01'), netAmount: new Decimal('900') }),
        ],
        expenses: [expense({ incurredOn: plainDate('2026-10-01') })],
        transfers: [transfer({ occurredOn: plainDate('2026-08-31') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('0');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('0');
  });

  it('ignores a pre-classified leg dated outside the month', () => {
    // The seam that carries a record from a phase with no table yet is bounded
    // by the same month as everything else — it is an input, not an exception.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        preClassifiedLegs: [
          {
            role: 'K',
            currency: EUR,
            amount: new Decimal('111'),
            cashPositionId: BBVA,
            on: plainDate('2026-08-01'),
            sourceId: 'outside',
          },
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
  });

  it('counts a flow dated on either boundary day of the month', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('200')],
        income: [
          income({ receivedOn: plainDate('2026-09-01'), netAmount: new Decimal('100') }),
          income({ receivedOn: plainDate('2026-09-30'), netAmount: new Decimal('100') }),
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('200');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('flows with no cash account named', () => {
  it('belongs to the bucket of its currency', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('100')],
        income: [income({ cashPositionId: null })],
      }),
    ).buckets[0];
    expect(bucket?.totals.externalInflows.toString()).toBe('100');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.status).toBe('reliable');
  });

  it('is in no account residual, and none is invented for it', () => {
    // 8.3's residuals are per-account diagnostics. A null-leg flow is attributed
    // to no account, so spreading it over the accounts to make them add up
    // would be inventing an attribution the user never gave.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('100')],
        income: [income({ cashPositionId: null })],
      }),
    ).buckets[0];
    expect(bucket?.accounts[0]?.residual?.toString()).toBe('100');
  });

  it('is unavailable, and reported, when no account of that currency took part', () => {
    const result = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        income: [income({ cashPositionId: null, currency: USD })],
      }),
    );
    const usd = result.buckets.find((b) => b.currency === 'USD');
    expect(usd?.status).toBe('unavailable');
    const issue = usd?.issues.find((i) => i.key === 'flow_without_cash_account');
    expect(issue?.class).toBe('blocking');
    expect(issue?.amount?.toString()).toBe('100');
    // The month takes the worst of its buckets (8.4).
    expect(result.buckets.find((b) => b.currency === 'EUR')?.status).toBe('reliable');
    expect(result.monthStatus).toBe('unavailable');
  });
});

describe('historical recurring completeness', () => {
  const schedule = {
    frequency: 'monthly' as const,
    dayOfMonth: 25,
    startDate: plainDate('2026-01-01'),
    endDate: null,
  };
  const salaryTemplate: CompletenessTemplate = {
    templateId: 'tpl-salary',
    name: 'Salary',
    kind: 'income',
    currency: EUR,
    incomeKind: 'employment',
    schedule,
  };

  function reconcile(resolved: readonly string[], over: Partial<CompletenessTemplate> = {}) {
    return reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        templates: [{ ...salaryTemplate, ...over }],
        resolvedOccurrences: new Set(resolved),
      }),
    ).buckets[0];
  }

  it('reports an occurrence with neither a flow nor a skip', () => {
    const issue = reconcile([])?.issues.find((i) => i.key === 'suggested_income_missing');
    expect(issue?.occurrenceDate).toBe('2026-09-25');
    expect(issue?.templateId).toBe('tpl-salary');
    expect(issue?.templateName).toBe('Salary');
    expect(issue?.class).toBe('advisory');
  });

  it('is silent once the occurrence is resolved', () => {
    // Both a materialized flow and a `recurring_template_skips` row resolve an
    // occurrence, and both reach the engine as the same identity in one set —
    // which is why nothing here can tell them apart, and nothing should. The
    // application tests prove each source populates it.
    const bucket = reconcile([occurrenceKey('tpl-salary', '2026-09-25')]);
    expect(bucket?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(false);
  });

  it('leaves the month reliable, because the issue is advisory', () => {
    expect(reconcile([])?.status).toBe('reliable');
  });

  it('still expects the occurrence from a template archived since', () => {
    // 30.10: `archived_at` is present-tense visibility and must not reach
    // backwards. The engine's input carries no archive state at all, so the
    // only way to get this wrong is for the loader to filter — which the
    // application tests cover.
    expect(Object.keys(salaryTemplate)).not.toContain('archivedAt');
    expect(reconcile([])?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(true);
  });

  it('expects nothing from a schedule that had already ended', () => {
    const bucket = reconcile([], { schedule: { ...schedule, endDate: plainDate('2026-08-31') } });
    expect(bucket?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(false);
  });

  it('expects nothing from a schedule that had not started', () => {
    const bucket = reconcile([], { schedule: { ...schedule, startDate: plainDate('2026-10-01') } });
    expect(bucket?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(false);
  });

  it('reports a missing rent as missing, never as a vacancy', () => {
    // F18: occupancy is only ever an explicit skip reason. An absence is an
    // absence.
    const bucket = reconcile([], { name: 'Flat rent', incomeKind: 'rental' });
    const issue = bucket?.issues.find((i) => i.key === 'suggested_income_missing');
    expect(issue?.templateName).toBe('Flat rent');
    expect(JSON.stringify(bucket?.issues ?? [])).not.toContain('vacan');
  });

  it('orders two occurrences on the same day by template, every time', () => {
    // Determinism is the point: the same month must report the same list in the
    // same order, or a dismissal in the interface lands on a different issue.
    const second: CompletenessTemplate = {
      ...salaryTemplate,
      templateId: 'tpl-aaa',
      name: 'Second job',
    };
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        templates: [salaryTemplate, second],
        resolvedOccurrences: new Set(),
      }),
    ).buckets[0];

    const missing = bucket?.issues.filter((i) => i.key === 'suggested_income_missing') ?? [];
    expect(missing.map((i) => i.templateId)).toEqual(['tpl-aaa', 'tpl-salary']);
  });

  it('orders occurrences by date before template', () => {
    const earlier: CompletenessTemplate = {
      ...salaryTemplate,
      templateId: 'tpl-zzz',
      name: 'Rent',
      schedule: { ...schedule, dayOfMonth: 1 },
    };
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        templates: [salaryTemplate, earlier],
        resolvedOccurrences: new Set(),
      }),
    ).buckets[0];

    const missing = bucket?.issues.filter((i) => i.key === 'suggested_income_missing') ?? [];
    expect(missing.map((i) => i.occurrenceDate)).toEqual(['2026-09-01', '2026-09-25']);

    // And the same order whichever way the templates arrive.
    const reversed = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        templates: [earlier, salaryTemplate],
        resolvedOccurrences: new Set(),
      }),
    ).buckets[0];
    expect(
      reversed?.issues
        .filter((i) => i.key === 'suggested_income_missing')
        .map((i) => i.occurrenceDate),
    ).toEqual(['2026-09-01', '2026-09-25']);
  });

  it('says nothing about an expense template, which is a later phase', () => {
    // 8.5's `suggested_payment_missing` belongs to the phase that has
    // liabilities; inventing it here would put a key in `dismissed_issues`
    // that nothing else knows.
    const bucket = reconcile([], { kind: 'expense' });
    expect(bucket?.issues).toHaveLength(0);
  });
});

describe('possible_missing_interest', () => {
  /** A savings-shaped account whose residual is `closing − opening`. */
  function savingsAccount(opening: string, closing: string, accountType = 'savings') {
    return account(
      SAVINGS,
      'Savings',
      [monthEnd(SAVINGS, '2026-08-31', opening), monthEnd(SAVINGS, '2026-09-30', closing)],
      {},
      accountType,
    );
  }

  const raised = (accountInput: CashAccountInput): boolean =>
    reconcileCompletedMonth(input({ cashAccounts: [accountInput] })).buckets[0]?.issues.some(
      (i) => i.key === 'possible_missing_interest',
    ) === true;

  it('suspects interest for a small positive residual on a savings account', () => {
    // 49.99 against a closing balance of 10,000: under 0.5 % (= 50).
    expect(raised(savingsAccount('9950.01', '10000'))).toBe(true);
  });

  it('suspects it on brokerage cash too', () => {
    expect(raised(savingsAccount('9950.01', '10000', 'brokerage_cash'))).toBe(true);
  });

  it('stops at exactly half a percent, which 8.5 puts outside the trigger', () => {
    expect(raised(savingsAccount('9950', '10000'))).toBe(false);
  });

  it('says nothing when the account reconciles exactly', () => {
    // Zero is not a small positive residual. decimal.js would call it positive,
    // which is why the engine compares against zero rather than reading a sign.
    expect(raised(savingsAccount('10000', '10000'))).toBe(false);
  });

  it('says nothing for a negative residual', () => {
    expect(raised(savingsAccount('10000', '9990'))).toBe(false);
  });

  it('says nothing for an account where interest is not plausible', () => {
    expect(raised(savingsAccount('9950.01', '10000', 'checking'))).toBe(false);
  });
});

describe('what an unavailable bucket still knows', () => {
  /** BBVA with August's statement and none for September, plus the salary. */
  const septemberWithoutClosing = () =>
    input({
      cashAccounts: [account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '8055')])],
      income: [income({ netAmount: new Decimal('2100') })],
      expenses: [expense({ amount: new Decimal('411') })],
    });

  it('reports the flow sums exactly, because they need no balance evidence', () => {
    // 8.9's four role sums are sums of source records. A recorded salary is a
    // fact whatever the statements say, and reporting 0 here would throw a
    // known number away.
    const bucket = reconcileCompletedMonth(septemberWithoutClosing()).buckets[0];
    expect(bucket?.status).toBe('unavailable');
    expect(bucket?.totals.externalInflows.toString()).toBe('2100');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('411');
  });

  it('still reports no spending figure at all', () => {
    const bucket = reconcileCompletedMonth(septemberWithoutClosing()).buckets[0];
    expect(bucket?.totals.trackedTotalSpending).toBeUndefined();
    expect(bucket?.totals.unclassified).toBeUndefined();
  });

  it('distinguishes a measured zero from an unknown', () => {
    // No known tracked expense was recorded, so the sum is zero and means it.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '8055')])],
        income: [income({ netAmount: new Decimal('2100') })],
      }),
    ).buckets[0];
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.trackedTotalSpending).toBeUndefined();
  });

  it('sums the cash change over the accounts that did have endpoints', () => {
    // 8.2's cash change, applied unchanged. BBVA is settled and moves -100;
    // Savings has no evidence at all and contributes nothing, which is why the
    // bucket has no spending figure even though the change is a number.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '1000'),
            monthEnd(BBVA, '2026-09-30', '900'),
          ]),
          account(SAVINGS, 'Savings', []),
        ],
      }),
    ).buckets[0];
    expect(bucket?.status).toBe('unavailable');
    expect(bucket?.totals.cashDelta.toString()).toBe('-100');
    expect(bucket?.totals.trackedTotalSpending).toBeUndefined();
  });

  it('reports the null-leg flow it cannot place', () => {
    const usd = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        income: [income({ cashPositionId: null, currency: USD, netAmount: new Decimal('75') })],
      }),
    ).buckets.find((b) => b.currency === 'USD');
    expect(usd?.status).toBe('unavailable');
    expect(usd?.totals.externalInflows.toString()).toBe('75');
    expect(usd?.totals.trackedTotalSpending).toBeUndefined();
  });
});

describe('completed-month status precedence (8.3, 8.4)', () => {
  it('is unresolved, not estimated, when an excluded account and a negative unclassified meet', () => {
    // 8.4 gives `estimated` the condition "computed, unclassified >= 0, at
    // least one excluded first_balance account". With unclassified below zero
    // the month is `unresolved`, and the exclusion is still reported.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '1000'),
            monthEnd(BBVA, '2026-09-30', '1300'),
          ]),
          account(SAVINGS, 'Savings', [monthEnd(SAVINGS, '2026-09-30', '5000')], {}, 'savings'),
        ],
      }),
    ).buckets[0];
    expect(bucket?.totals.unclassified?.toString()).toBe('-300');
    expect(bucket?.status).toBe('unresolved');
    expect(bucket?.issues.map((i) => i.key).sort()).toEqual([
      'first_balance',
      'unexplained_inflow',
    ]);
  });

  it('is unavailable, not unresolved, when an endpoint is missing as well', () => {
    // 8.3 emits the unavailable bucket and moves on before any arithmetic, so
    // no unexplained inflow can be detected: there is nothing to judge.
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '1000')]),
          account(SAVINGS, 'Savings', [
            monthEnd(SAVINGS, '2026-08-31', '0'),
            monthEnd(SAVINGS, '2026-09-30', '900'),
          ]),
        ],
      }),
    ).buckets[0];
    expect(bucket?.status).toBe('unavailable');
    expect(bucket?.issues.some((i) => i.key === 'unexplained_inflow')).toBe(false);
    expect(bucket?.issues.some((i) => i.key === 'missing_month_end')).toBe(true);
  });

  it('is unavailable, not estimated, when an excluded account and an unusable one meet', () => {
    const bucket = reconcileCompletedMonth(
      input({
        cashAccounts: [
          account(BBVA, 'BBVA', [monthEnd(BBVA, '2026-08-31', '1000')]),
          account(SAVINGS, 'Savings', [monthEnd(SAVINGS, '2026-09-30', '5000')], {}, 'savings'),
        ],
      }),
    ).buckets[0];
    expect(bucket?.status).toBe('unavailable');
    expect(bucket?.issues.some((i) => i.key === 'first_balance')).toBe(true);
  });

  it('gives the month the worst of its buckets', () => {
    // EUR reconciles; USD has a flow no account can take. 8.4: the month is
    // unavailable, and the reliable bucket keeps saying it is reliable.
    const result = reconcileCompletedMonth(
      input({
        cashAccounts: [oneAccount('0')],
        income: [income({ cashPositionId: null, currency: USD })],
      }),
    );
    expect(result.buckets.find((b) => b.currency === 'EUR')?.status).toBe('reliable');
    expect(result.buckets.find((b) => b.currency === 'USD')?.status).toBe('unavailable');
    expect(result.monthStatus).toBe('unavailable');
  });

  it('takes unresolved over estimated across buckets', () => {
    const result = reconcileCompletedMonth(
      input({
        cashAccounts: [
          // EUR: an excluded first-balance account makes the bucket estimated.
          account(BBVA, 'BBVA', [
            monthEnd(BBVA, '2026-08-31', '1000'),
            monthEnd(BBVA, '2026-09-30', '1000'),
          ]),
          account(SAVINGS, 'Savings', [monthEnd(SAVINGS, '2026-09-30', '5000')], {}, 'savings'),
          // USD: cash grew with nothing to explain it.
          account(
            'usd-account',
            'USD',
            [
              monthEnd('usd-account', '2026-08-31', '0'),
              monthEnd('usd-account', '2026-09-30', '300'),
            ],
            { currency: 'USD' },
          ),
        ],
      }),
    );
    expect(result.buckets.find((b) => b.currency === 'EUR')?.status).toBe('estimated');
    expect(result.buckets.find((b) => b.currency === 'USD')?.status).toBe('unresolved');
    expect(result.monthStatus).toBe('unresolved');
  });
});

describe('month-level status', () => {
  it('takes the worst bucket, in the order 8.4 gives', () => {
    expect(worstStatus(['reliable', 'estimated'])).toBe('estimated');
    expect(worstStatus(['estimated', 'unresolved'])).toBe('unresolved');
    expect(worstStatus(['unresolved', 'unavailable'])).toBe('unavailable');
    expect(worstStatus(['reliable', 'reliable'])).toBe('reliable');
    expect(worstStatus([])).toBe('reliable');
  });
});

describe('determinism', () => {
  it('gives the same figures for the same inputs', () => {
    const a = reconcileCompletedMonth(golden.input());
    const b = reconcileCompletedMonth(golden.input());
    expect(a.buckets[0]?.totals.unclassified?.toString()).toBe(
      b.buckets[0]?.totals.unclassified?.toString(),
    );
    expect(a.buckets.map((x) => x.currency)).toEqual(b.buckets.map((x) => x.currency));
  });

  it('does not depend on the order the accounts arrive in', () => {
    const forward = reconcileCompletedMonth(golden.input());
    const reversed = reconcileCompletedMonth({
      ...golden.input(),
      cashAccounts: [...golden.accounts()].reverse(),
    });
    expect(forward.buckets[0]?.totals.unclassified?.toString()).toBe(
      reversed.buckets[0]?.totals.unclassified?.toString(),
    );
    expect(forward.buckets[0]?.accounts.map((a) => a.positionId)).toEqual(
      reversed.buckets[0]?.accounts.map((a) => a.positionId),
    );
  });

  it('stores nothing: the same input object reconciles twice unchanged', () => {
    const args = golden.input();
    const first = reconcileCompletedMonth(args).buckets[0]?.totals.unclassified?.toString();
    const second = reconcileCompletedMonth(args).buckets[0]?.totals.unclassified?.toString();
    expect(first).toBe('398');
    expect(second).toBe('398');
  });
});
