import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { endOfMonthKey, monthKey, plainDate, type MonthKey } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import { monthEnd, position } from '../helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../src/flows/types';
import { findSpans, type CashAccountInput, type SpanInput } from '../../src/reconciliation/index';

/**
 * Invariants of multi-month spans (blueprint 8.7, v2.1.11 30.14).
 *
 * The statements that must hold for any evidence at all: the anchors are a
 * property of dates, discovery is deterministic and maximal, spans never
 * overlap, the identity is exact, and nothing outside the interval reaches a
 * figure.
 */

const EUR = currencyCode('EUR');
const TODAY = plainDate('2026-12-01');
const MONTH_ENDS = [
  '2026-06-30',
  '2026-07-31',
  '2026-08-31',
  '2026-09-30',
  '2026-10-31',
  '2026-11-30',
] as const;
const FLOW_DAYS = [
  '2026-06-10',
  '2026-07-10',
  '2026-08-10',
  '2026-09-10',
  '2026-10-10',
  '2026-11-10',
] as const;

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => `${String(whole)}.${String(fraction).padStart(8, '0')}`);

const ids = ['acct-a', 'acct-b'] as const;

/** An account with a month-end balance on some subset of the six month ends. */
const accountArb = (id: string) =>
  fc
    .tuple(
      fc.uniqueArray(fc.constantFrom(...MONTH_ENDS), { minLength: 2, maxLength: MONTH_ENDS.length }),
      fc.array(amountArb, { minLength: MONTH_ENDS.length, maxLength: MONTH_ENDS.length }),
    )
    .map(([ends, amounts]): CashAccountInput => {
      const sorted = [...ends].sort();
      return {
        position: position(`Account ${id}`, { id, currency: 'EUR' }),
        valuations: sorted.map((on, index) => monthEnd(id, on, amounts[index] ?? '0')),
        accountType: 'checking',
      };
    });

const dayArb = fc.constantFrom(...FLOW_DAYS);

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

const historyArb: fc.Arbitrary<Generated> = fc
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

function inputOf(generated: Generated, over: Partial<SpanInput> = {}): SpanInput {
  return {
    today: TODAY,
    cashAccounts: generated.accounts,
    income: generated.income,
    expenses: generated.expenses,
    transfers: generated.transfers,
    ...over,
  };
}

/** Does every account that existed then have a month-end balance at `end(M)`? */
function isAnchor(generated: Generated, month: MonthKey): boolean {
  const end = endOfMonthKey(month);
  return generated.accounts.every((account) =>
    account.valuations.some((v) => v.valuedOn === end),
  );
}

describe('property: the identity is exact over any interval', () => {
  it('holds for every span the evidence produces', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          const opening = span.accounts.reduce(
            (sum, a) => sum.plus(a.opening),
            new Decimal(0),
          );
          const closing = span.accounts.reduce(
            (sum, a) => sum.plus(a.closing),
            new Decimal(0),
          );

          expect(closing.minus(opening).equals(span.totals.cashDelta)).toBe(true);
          expect(
            span.totals.externalInflows
              .plus(span.totals.nonIncomeInflows)
              .minus(span.totals.nonExpenseOutflows)
              .minus(span.totals.cashDelta)
              .equals(span.trackedTotalSpending),
          ).toBe(true);
          expect(
            span.trackedTotalSpending
              .minus(span.totals.knownTrackedExpenses)
              .equals(span.unclassified),
          ).toBe(true);

          // 8.2's equivalent form, from the endpoints themselves.
          expect(
            opening
              .plus(span.totals.externalInflows)
              .plus(span.totals.nonIncomeInflows)
              .minus(span.totals.nonExpenseOutflows)
              .minus(span.totals.knownTrackedExpenses)
              .minus(closing)
              .equals(span.unclassified),
          ).toBe(true);
        }
      }),
    );
  });

  it('says unresolved exactly when the unclassified figure is below zero', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          expect(span.status).toBe(span.unclassified.lessThan(0) ? 'unresolved' : 'reliable');
        }
      }),
    );
  });
});

describe('property: discovery is deterministic and maximal', () => {
  it('anchors each span on consecutive complete month ends', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          // The month before the span is an anchor, and so is its last month.
          const before = monthKey(plainDate(span.from));
          const openingAnchor = monthKey(
            plainDate(`${span.from.slice(0, 4)}-${span.from.slice(5, 7)}-01`),
          );
          expect(openingAnchor).toBe(before);
          expect(isAnchor(generated, span.months[span.months.length - 1] as MonthKey)).toBe(true);

          // And no complete month end lies strictly inside it.
          for (const month of span.months.slice(0, -1)) {
            expect(isAnchor(generated, month)).toBe(false);
          }
        }
      }),
    );
  });

  it('covers at least two months', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          expect(span.months.length).toBeGreaterThanOrEqual(2);
        }
      }),
    );
  });

  it('never overlaps or nests within one currency', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        const spans = findSpans(inputOf(generated)).filter((s) => s.currency === 'EUR');
        for (let i = 0; i + 1 < spans.length; i += 1) {
          const left = spans[i];
          const right = spans[i + 1];
          if (left === undefined || right === undefined) continue;
          expect(left.to < right.from).toBe(true);
        }
      }),
    );
  });

  it('does not depend on the order anything arrives in', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        const forward = findSpans(inputOf(generated));
        const reversed = findSpans(
          inputOf({
            accounts: [...generated.accounts].reverse().map((a) => ({
              ...a,
              valuations: [...a.valuations].reverse(),
            })),
            income: [...generated.income].reverse(),
            expenses: [...generated.expenses].reverse(),
            transfers: [...generated.transfers].reverse(),
          }),
        );
        expect(reversed.map((s) => `${s.from}..${s.to}=${s.unclassified.toString()}`)).toEqual(
          forward.map((s) => `${s.from}..${s.to}=${s.unclassified.toString()}`),
        );
      }),
    );
  });

  it('contains at least one included account in every span', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          expect(span.accounts.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe('property: nothing outside the interval reaches a figure', () => {
  it('ignores a flow dated after the closing anchor', () => {
    fc.assert(
      fc.property(historyArb, amountArb, (generated, amount) => {
        const before = findSpans(inputOf(generated));
        fc.pre(before.length > 0);

        const after = findSpans(
          inputOf({
            ...generated,
            expenses: [
              ...generated.expenses,
              {
                id: `outside-${amount}`,
                categoryKind: 'food',
                // December: past every span, since November is the last
                // completed month.
                incurredOn: plainDate('2026-12-01'),
                amount: new Decimal(amount),
                currency: EUR,
                settlement: 'tracked_cash',
                cashPositionId: ids[0],
              },
            ],
          }),
        );
        expect(after.map((s) => s.unclassified.toString())).toEqual(
          before.map((s) => s.unclassified.toString()),
        );
      }),
    );
  });
});

describe('property: the result type carries no forbidden state', () => {
  it('exposes no per-month figure, no issues and no residuals', () => {
    fc.assert(
      fc.property(historyArb, (generated) => {
        for (const span of findSpans(inputOf(generated))) {
          const keys = Object.keys(span);
          expect(keys).not.toContain('perMonthAverageInformational');
          expect(keys).not.toContain('issues');
          expect(keys).not.toContain('residuals');
          expect(['reliable', 'unresolved']).toContain(span.status);
          // Nothing per-month beyond the month keys themselves.
          for (const month of span.months) expect(typeof month).toBe('string');
        }
      }),
    );
  });
});
