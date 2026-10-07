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

/*
 * The other direction: `asOf` is null only when no date qualifies.
 *
 * Every property above returns early when `asOf` is null, and their generator
 * holds only pre-existing accounts with a month-end opening, so "unavailable
 * only when none exists" (§26 row 3) was never checked over random inputs. This
 * generator holds every kind of account 8.6 names, each valid exactly as the
 * services would store it: nothing dated after a closing day, no balance after
 * a dormant episode starts, and every account with a usable opening — a missing
 * one is a bucket's `missing_opening`, never a reason for `asOf` to be null.
 */

const AUGUST_END = '2026-08-31';
const MONTH_DAYS = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

const nonZeroArb = fc.integer({ min: 1, max: 99_999 }).map((n) => `${String(n)}.25`);

/** Ordinary snapshots on some of these days, of any non-zero amount. */
const snapshotsArb = (id: string, days: readonly string[]) =>
  fc
    .subarray([...days])
    .chain((chosen) =>
      fc
        .array(nonZeroArb, { minLength: chosen.length, maxLength: chosen.length })
        .map((amounts) => chosen.map((day, index) => valuation(id, day, amounts[index] ?? '1'))),
    );

type AccountKind = 'pre_existing' | 'opened_in_month' | 'closed_in_month' | 'dormant' | 'first_balance';

function kindArb(kind: AccountKind, id: string, currency: string): fc.Arbitrary<CashAccountInput> {
  const account = (
    options: Parameters<typeof position>[1],
    valuations: CashAccountInput['valuations'],
  ): CashAccountInput => ({
    position: position(`${kind} ${id}`, { id, currency, ...options }),
    valuations,
    accountType: 'checking',
  });

  switch (kind) {
    case 'pre_existing':
      // A statement at the end of August, and ordinary snapshots this month.
      return fc
        .tuple(nonZeroArb, snapshotsArb(id, MONTH_DAYS))
        .map(([opening, snapshots]) => account({}, [monthEnd(id, AUGUST_END, opening), ...snapshots]));

    case 'opened_in_month':
      // Opens at zero on a day of the month; balances only from that day on.
      return fc
        .constantFrom(...MONTH_DAYS)
        .chain((openedOn) =>
          snapshotsArb(id, MONTH_DAYS.filter((day) => day >= openedOn)).map((snapshots) =>
            account({ openedOn }, snapshots),
          ),
        );

    case 'closed_in_month':
      // Closes on a day of the month over a final zero on or before it —
      // August's statement, or a balance this month — with nothing after the
      // zero, and nothing at all after the closing day.
      return fc.tuple(fc.constantFrom(...MONTH_DAYS), nonZeroArb).chain(([closedOn, opening]) =>
        fc.constantFrom(AUGUST_END, ...MONTH_DAYS.filter((day) => day <= closedOn)).chain((finalZero) =>
          snapshotsArb(id, MONTH_DAYS.filter((day) => day < finalZero)).map((before) =>
            account(
              { status: 'closed', closedOn },
              finalZero === AUGUST_END
                ? [monthEnd(id, AUGUST_END, '0')]
                : [monthEnd(id, AUGUST_END, opening), ...before, valuation(id, finalZero, '0')],
            ),
          ),
        ),
      );

    case 'dormant':
      // Dormant from a zero balance — August's statement or one this month —
      // with no balance after it.
      return fc.tuple(fc.constantFrom(AUGUST_END, ...MONTH_DAYS), nonZeroArb).chain(([from, opening]) =>
        snapshotsArb(id, MONTH_DAYS.filter((day) => day < from)).map((before) =>
          account(
            { dormantFrom: from },
            from === AUGUST_END
              ? [monthEnd(id, AUGUST_END, '0')]
              : [monthEnd(id, AUGUST_END, opening), ...before, valuation(id, from, '0')],
          ),
        ),
      );

    case 'first_balance':
      // Existed before tracking began; its first balance of all is this month.
      return fc.constantFrom(...MONTH_DAYS).chain((first) =>
        fc
          .tuple(nonZeroArb, snapshotsArb(id, MONTH_DAYS.filter((day) => day > first)))
          .map(([amount, later]) => account({}, [valuation(id, first, amount), ...later])),
      );
  }
}

const KINDS: readonly AccountKind[] = [
  'pre_existing',
  'opened_in_month',
  'closed_in_month',
  'dormant',
  'first_balance',
];

const everyKindArb: fc.Arbitrary<CashAccountInput[]> = fc
  .array(fc.tuple(fc.constantFrom(...KINDS), fc.constantFrom('EUR', 'USD')), { minLength: 1, maxLength: 4 })
  .chain((shapes) =>
    fc.tuple(...shapes.map(([kind, currency], index) => kindArb(kind, `acct-${String(index)}`, currency))),
  )
  .map((accounts) => [...accounts]);

/**
 * 8.6's common as-of date, read from its wording ("Common as-of date `D`", "An
 * empty inclusion set is not evidence") rather than from the engine.
 *
 * A date in the month, up to today, qualifies when the accounts taking part
 * through it, less the month's first-balance exclusions, are not empty, and
 * each of them either has an exact snapshot dated that day or is known
 * structurally there: closed on or before it, or dormant from on or before it.
 */
function qualifies(accounts: readonly CashAccountInput[], d: string): boolean {
  // "An account with `opened_on > d` does not participate in the interval
  // `[start(M), d]` at all."
  const takesPart = (a: CashAccountInput): boolean =>
    (a.position.openedOn === null || a.position.openedOn <= d) &&
    (a.position.closedOn === null || a.position.closedOn >= START);
  // "`first_balance` for a pre-existing account whose first valuation falls in
  // M", decided once for M from the evidence through today.
  const firstBalance = (a: CashAccountInput): boolean =>
    (a.position.openedOn === null || a.position.openedOn < START) &&
    !a.valuations.some((v) => v.valuedOn < START) &&
    a.valuations.some((v) => v.valuedOn >= START && v.valuedOn <= TODAY);

  const included = accounts.filter((a) => takesPart(a) && !firstBalance(a));
  if (included.length === 0) return false;

  return included.every(
    (a) =>
      a.valuations.some((v) => v.valuedOn === d && v.datePrecision === 'exact') ||
      (a.position.closedOn !== null && a.position.closedOn <= d) ||
      (a.position.dormantFrom !== undefined && a.position.dormantFrom <= d),
  );
}

function latestQualifyingDate(accounts: readonly CashAccountInput[]): string | null {
  for (let d = TODAY; d >= START; d = addDays(d, -1)) {
    if (qualifies(accounts, d)) return d;
  }
  return null;
}

describe('property: the as-of date is null only when no date qualifies', () => {
  it('is null exactly when no date qualifies, and otherwise the latest that does', () => {
    fc.assert(
      fc.property(everyKindArb, (accounts) => {
        const result = reconcileMonthToDate({
          today: TODAY,
          cashAccounts: accounts,
          income: [],
          expenses: [],
          transfers: [],
        });
        expect(result.asOf).toBe(latestQualifyingDate(accounts));
      }),
      { numRuns: 1000 },
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
