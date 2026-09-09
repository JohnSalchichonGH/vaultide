import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { addDays, plainDate, startOfMonthKey, monthKey } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import { monthEnd, position, valuation } from '../helpers/records';
import { valuationOn } from '../../src/positions/valuation';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../src/flows/types';
import {
  reconcileMonthToDate,
  type CashAccountInput,
  type MonthToDateInput,
} from '../../src/reconciliation/index';

/**
 * Invariants of month-to-date reconciliation (blueprint 8.6, v2.1.10 30.13).
 *
 * The statements that must hold for any set of records at all: the as-of date
 * is the latest one the evidence supports, it is the same for every bucket,
 * nothing after it can move a figure, and the identity is exact.
 *
 * Amounts are generated as exact decimal strings, never floats.
 */

const EUR = currencyCode('EUR');
const TODAY = plainDate('2026-09-10');
const SEPTEMBER = monthKey(TODAY);
const START = startOfMonthKey(SEPTEMBER);
const DAYS = ['2026-09-02', '2026-09-04', '2026-09-06', '2026-09-08'] as const;

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => `${String(whole)}.${String(fraction).padStart(8, '0')}`);

const ids = ['acct-a', 'acct-b', 'acct-c'] as const;

const accountArb = (id: string) =>
  fc
    .tuple(
      amountArb,
      fc.uniqueArray(fc.constantFrom(...DAYS), { minLength: 1, maxLength: DAYS.length }),
      fc.array(amountArb, { minLength: DAYS.length, maxLength: DAYS.length }),
    )
    .map(([opening, days, balances]): CashAccountInput => {
      const sorted = [...days].sort();
      return {
        position: position(`Account ${id}`, { id, currency: 'EUR' }),
        valuations: [
          monthEnd(id, '2026-08-31', opening),
          ...sorted.map((day, index) =>
            valuation(id, day, balances[index] ?? '0'),
          ),
        ],
        accountType: 'checking',
      };
    });

const dayArb = fc.constantFrom(...DAYS, '2026-09-09', '2026-09-10');

const incomeArb = fc
  .tuple(fc.constantFrom(...ids), amountArb, dayArb)
  .map(
    ([cashPositionId, amount, on]): IncomeFlow => ({
      id: `income-${cashPositionId}-${amount}-${on}`,
      kind: 'employment',
      receivedOn: plainDate(on),
      netAmount: new Decimal(amount),
      currency: EUR,
      settlement: 'tracked_cash',
      cashPositionId,
    }),
  );

const expenseArb = fc
  .tuple(fc.constantFrom(...ids), amountArb, dayArb)
  .map(
    ([cashPositionId, amount, on]): ExpenseFlow => ({
      id: `expense-${cashPositionId}-${amount}-${on}`,
      categoryKind: 'food',
      incurredOn: plainDate(on),
      amount: new Decimal(amount),
      currency: EUR,
      settlement: 'tracked_cash',
      cashPositionId,
    }),
  );

const transferArb = fc
  .tuple(fc.constantFrom(...ids), fc.constantFrom(...ids), amountArb, dayArb)
  .map(
    ([from, to, amount, on]): TransferFlow => ({
      id: `transfer-${from}-${to}-${amount}-${on}`,
      kind: 'cash_transfer',
      occurredOn: plainDate(on),
      fromPositionId: from,
      fromCurrency: EUR,
      fromAmount: new Decimal(amount),
      toPositionId: to,
      toCurrency: EUR,
      toAmount: new Decimal(amount),
    }),
  );

interface Generated {
  readonly accounts: CashAccountInput[];
  readonly income: IncomeFlow[];
  readonly expenses: ExpenseFlow[];
  readonly transfers: TransferFlow[];
}

const monthArb: fc.Arbitrary<Generated> = fc
  .tuple(
    fc.integer({ min: 1, max: ids.length }),
    fc.array(incomeArb, { maxLength: 4 }),
    fc.array(expenseArb, { maxLength: 4 }),
    fc.array(transferArb, { maxLength: 2 }),
  )
  .chain(([count, income, expenses, transfers]) =>
    fc
      .tuple(...ids.slice(0, count).map((id) => accountArb(id)))
      .map((accounts) => ({ accounts: [...accounts], income, expenses, transfers })),
  );

function inputOf(generated: Generated, over: Partial<MonthToDateInput> = {}): MonthToDateInput {
  return {
    today: TODAY,
    cashAccounts: generated.accounts,
    income: generated.income,
    expenses: generated.expenses,
    transfers: generated.transfers,
    ...over,
  };
}

describe('property: the as-of date is the latest one the evidence supports', () => {
  it('lies in the month, has a non-empty included set, and nothing later qualifies', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const result = reconcileMonthToDate(inputOf(generated));
        if (result.asOf === null) return;
        const asOf = result.asOf;

        expect(asOf >= START).toBe(true);
        expect(asOf <= TODAY).toBe(true);

        const states = result.buckets.flatMap((bucket) => bucket.accounts);
        // 30.13 item 6: a date with nothing included is not evidence.
        expect(states.length).toBeGreaterThan(0);

        // Every account that owed a snapshot has one dated exactly D.
        for (const state of states.filter((s) => s.snapshotRequired)) {
          expect(state.atAsOf.state).toBe('snapshot');
          const account = generated.accounts.find((a) => a.position.id === state.positionId);
          expect(valuationOn(account?.valuations ?? [], asOf)).toBeDefined();
        }

        // And no later day in the month would have done: re-running with an
        // earlier `today` can only move the date back, never forward, so the
        // days between D and today are exactly the ones that failed.
        for (let d = addDays(asOf, 1); d <= TODAY; d = addDays(d, 1)) {
          const earlier = reconcileMonthToDate(inputOf(generated, { today: d }));
          expect(earlier.asOf === d).toBe(false);
        }
      }),
    );
  });

  it('gives every bucket the same date', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const result = reconcileMonthToDate(inputOf(generated));
        if (result.asOf === null) return;
        // One date, and every account state was measured against it.
        for (const bucket of result.buckets) {
          for (const state of bucket.accounts.filter((s) => s.atAsOf.state === 'snapshot')) {
            const account = generated.accounts.find((a) => a.position.id === state.positionId);
            const at = valuationOn(account?.valuations ?? [], result.asOf as string as never);
            expect(state.atAsOf.amount?.toString()).toBe(at?.amount.toString());
          }
        }
      }),
    );
  });
});

describe('property: nothing after the as-of date reaches a figure', () => {
  it('ignores a flow dated after it, and counts one dated on it', () => {
    fc.assert(
      fc.property(monthArb, amountArb, (generated, amount) => {
        const base = reconcileMonthToDate(inputOf(generated));
        if (base.asOf === null) return;
        const asOf = base.asOf;
        const before = base.buckets[0];
        if (before === undefined || before.totals.trackedTotalSpending === undefined) return;

        const later = addDays(asOf, 1);
        if (later > TODAY) return;

        const after = reconcileMonthToDate(
          inputOf(generated, {
            expenses: [
              ...generated.expenses,
              {
                id: `after-${amount}`,
                categoryKind: 'food',
                incurredOn: later,
                amount: new Decimal(amount),
                currency: EUR,
                settlement: 'tracked_cash',
                cashPositionId: ids[0],
              },
            ],
          }),
        );
        if (after.asOf === null) return;
        expect(after.asOf).toBe(asOf);
        expect(after.buckets[0]?.totals.knownTrackedExpenses.toString()).toBe(
          before.totals.knownTrackedExpenses.toString(),
        );

        const onTheDay = reconcileMonthToDate(
          inputOf(generated, {
            expenses: [
              ...generated.expenses,
              {
                id: `on-${amount}`,
                categoryKind: 'food',
                incurredOn: asOf,
                amount: new Decimal(amount),
                currency: EUR,
                settlement: 'tracked_cash',
                cashPositionId: ids[0],
              },
            ],
          }),
        );
        if (onTheDay.asOf === null) return;
        expect(onTheDay.buckets[0]?.totals.knownTrackedExpenses.toString()).toBe(
          before.totals.knownTrackedExpenses.plus(amount).toString(),
        );
      }),
    );
  });

  it('is unmoved by a balance recorded only after the date', () => {
    fc.assert(
      fc.property(monthArb, amountArb, (generated, amount) => {
        const base = reconcileMonthToDate(inputOf(generated));
        if (base.asOf === null) return;
        const asOf = base.asOf;
        const later = addDays(asOf, 1);
        if (later > TODAY) return;

        const [first, ...rest] = generated.accounts;
        if (first === undefined) return;
        // A newer balance on one account cannot move D unless everybody shares
        // the newer date, and here nobody else does.
        const withNewer: CashAccountInput = {
          ...first,
          valuations: [
            ...first.valuations.filter((v) => v.valuedOn !== later),
            valuation(first.position.id, later, amount),
          ],
        };

        const after = reconcileMonthToDate(
          inputOf(generated, { cashAccounts: [withNewer, ...rest] }),
        );
        if (after.asOf === null) return;

        // A later balance can only move the date forward — never back, and
        // never past the day it was recorded on.
        expect(after.asOf >= asOf).toBe(true);
        expect(after.asOf <= later).toBe(true);

        // And while the date holds, the figures do: evidence after D is not
        // mixed into an answer through D.
        if (after.asOf === asOf) {
          expect(after.buckets[0]?.totals.cashDelta?.toString()).toBe(
            base.buckets[0]?.totals.cashDelta?.toString(),
          );
          expect(after.buckets[0]?.totals.unclassified?.toString()).toBe(
            base.buckets[0]?.totals.unclassified?.toString(),
          );
        }
      }),
    );
  });
});

describe('property: the month-to-date identity is exact', () => {
  it('holds for any records, with no rounding and no tolerance', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const result = reconcileMonthToDate(inputOf(generated));
        if (result.asOf === null) return;

        for (const bucket of result.buckets) {
          const { totals } = bucket;
          const total = totals.trackedTotalSpending;
          const unclassified = totals.unclassified;
          const cashDelta = totals.cashDelta;
          if (total === undefined || unclassified === undefined || cashDelta === undefined) {
            // 30.12: the three travel together.
            expect(total).toBeUndefined();
            expect(unclassified).toBeUndefined();
            expect(cashDelta).toBeUndefined();
            continue;
          }

          expect(
            totals.externalInflows
              .plus(totals.nonIncomeInflows)
              .minus(totals.nonExpenseOutflows)
              .minus(cashDelta)
              .equals(total),
          ).toBe(true);
          expect(total.minus(totals.knownTrackedExpenses).equals(unclassified)).toBe(true);

          // 8.2's equivalent form, from the endpoints themselves.
          const included = bucket.accounts.filter((a) => a.included);
          const opening = included.reduce(
            (sum, a) => sum.plus(a.opening.amount ?? new Decimal(0)),
            new Decimal(0),
          );
          const closing = included.reduce(
            (sum, a) => sum.plus(a.atAsOf.amount ?? new Decimal(0)),
            new Decimal(0),
          );
          expect(
            opening
              .plus(totals.externalInflows)
              .plus(totals.nonIncomeInflows)
              .minus(totals.nonExpenseOutflows)
              .minus(totals.knownTrackedExpenses)
              .minus(closing)
              .equals(unclassified),
          ).toBe(true);
        }
      }),
    );
  });

  it('decomposes tracked spending into what is known and what is not', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const result = reconcileMonthToDate(inputOf(generated));
        if (result.asOf === null) return;
        for (const bucket of result.buckets) {
          const total = bucket.totals.trackedTotalSpending;
          const unclassified = bucket.totals.unclassified;
          if (total === undefined || unclassified === undefined) continue;
          expect(bucket.totals.knownTrackedExpenses.plus(unclassified).equals(total)).toBe(true);
        }
      }),
    );
  });
});

describe('property: a same-currency transfer through the date is neutral', () => {
  it('adds the same amount to both sides and changes no total', () => {
    fc.assert(
      fc.property(monthArb, amountArb, (generated, amount) => {
        fc.pre(generated.accounts.length >= 2);
        const base = reconcileMonthToDate(inputOf(generated));
        if (base.asOf === null) return;
        const asOf = base.asOf;
        const [from, to] = generated.accounts;
        if (from === undefined || to === undefined) return;

        const after = reconcileMonthToDate(
          inputOf(generated, {
            transfers: [
              ...generated.transfers,
              {
                id: `neutral-${amount}`,
                kind: 'cash_transfer',
                occurredOn: asOf,
                fromPositionId: from.position.id,
                fromCurrency: EUR,
                fromAmount: new Decimal(amount),
                toPositionId: to.position.id,
                toCurrency: EUR,
                toAmount: new Decimal(amount),
              },
            ],
          }),
        );
        if (after.asOf === null) return;

        const before = base.buckets[0];
        const now = after.buckets[0];
        expect(now?.totals.trackedTotalSpending?.toString()).toBe(
          before?.totals.trackedTotalSpending?.toString(),
        );
        expect(now?.totals.unclassified?.toString()).toBe(
          before?.totals.unclassified?.toString(),
        );
      }),
    );
  });
});
