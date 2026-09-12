import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { monthKeyOf, plainDate } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import { monthEnd, position, valuation } from '../helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../src/flows/types';
import {
  reconcileCompletedMonth,
  type CashAccountInput,
  type CompletedMonthInput,
} from '../../src/reconciliation/index';
import { classifyScopedFacts } from '../../src/savings/index';
import { factsInRange, factsInScope, scopeAccountIds } from '../../src/reconciliation/scope';

/**
 * Invariants of completed-month reconciliation (blueprint 8.2, 8.8).
 *
 * These are the statements that must hold for *any* records at all, which is
 * what makes them worth generating rather than enumerating: the identity is
 * exact, a same-currency transfer is neutral, an untracked expense changes
 * nothing, and an excluded account takes its own legs with it.
 *
 * Amounts are generated as exact decimal strings with up to eight fractional
 * digits — the storage scale — and never as floats, so a property that passes
 * here passes on the real numbers rather than on values that happened to round.
 */

const EUR = currencyCode('EUR');
const SEPTEMBER = monthKeyOf(2026, 9);
const TODAY = plainDate('2026-10-01');
const DAYS = ['2026-09-01', '2026-09-05', '2026-09-12', '2026-09-25', '2026-09-30'] as const;

/** A non-negative amount as an exact decimal string, up to 8 fractional digits. */
const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => `${String(whole)}.${String(fraction).padStart(8, '0')}`);

const dayArb = fc.constantFrom(...DAYS);

const ids = ['acct-a', 'acct-b', 'acct-c'] as const;

interface Generated {
  readonly accounts: CashAccountInput[];
  readonly income: IncomeFlow[];
  readonly expenses: ExpenseFlow[];
  readonly transfers: TransferFlow[];
}

const accountArb = (id: string, index: number) =>
  fc.tuple(amountArb, amountArb).map(
    ([opening, closing]): CashAccountInput => ({
      position: position(`Account ${id}`, { id, currency: 'EUR' }),
      valuations: [
        monthEnd(id, '2026-08-31', opening),
        monthEnd(id, '2026-09-30', closing),
      ],
      accountType: index === 0 ? 'checking' : 'savings',
    }),
  );

const incomeArb = fc
  .tuple(
    fc.constantFrom('employment' as const, 'rental' as const, 'external_inflow' as const),
    fc.constantFrom('tracked_cash' as const, 'external' as const),
    fc.constantFrom(...ids),
    amountArb,
    dayArb,
  )
  .map(
    ([kind, settlement, cashPositionId, amount, on]): IncomeFlow => ({
      id: `income-${kind}-${cashPositionId}-${amount}-${on}`,
      kind,
      receivedOn: plainDate(on),
      netAmount: new Decimal(amount),
      currency: EUR,
      settlement,
      cashPositionId: settlement === 'tracked_cash' ? cashPositionId : null,
    }),
  );

const expenseArb = fc
  .tuple(
    fc.constantFrom('food' as const, 'insurance' as const, 'capital_improvement' as const),
    fc.constantFrom('tracked_cash' as const, 'untracked_self' as const, 'third_party' as const),
    fc.constantFrom(...ids),
    amountArb,
    dayArb,
  )
  .map(
    ([categoryKind, settlement, cashPositionId, amount, on]): ExpenseFlow => ({
      id: `expense-${categoryKind}-${cashPositionId}-${amount}-${on}`,
      categoryKind,
      incurredOn: plainDate(on),
      amount: new Decimal(amount),
      currency: EUR,
      settlement,
      cashPositionId: settlement === 'tracked_cash' ? cashPositionId : null,
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

const monthArb: fc.Arbitrary<Generated> = fc
  .tuple(
    fc.integer({ min: 1, max: ids.length }),
    fc.array(incomeArb, { maxLength: 5 }),
    fc.array(expenseArb, { maxLength: 5 }),
    fc.array(transferArb, { maxLength: 3 }),
  )
  .chain(([count, income, expenses, transfers]) =>
    fc
      .tuple(...ids.slice(0, count).map((id, index) => accountArb(id, index)))
      .map((accounts) => ({ accounts: [...accounts], income, expenses, transfers })),
  );

function inputOf(generated: Generated, over: Partial<CompletedMonthInput> = {}): CompletedMonthInput {
  return {
    month: SEPTEMBER,
    today: TODAY,
    cashAccounts: generated.accounts,
    income: generated.income,
    expenses: generated.expenses,
    transfers: generated.transfers,
    templates: [],
    resolvedOccurrences: new Set<string>(),
    ...over,
  };
}

/** The one EUR bucket these generators produce. */
function bucketOf(input: CompletedMonthInput) {
  const bucket = reconcileCompletedMonth(input).buckets[0];
  if (bucket === undefined) throw new Error('expected one EUR bucket');
  return bucket;
}

describe('property 6: a known tracked expense moves what is known, not the total', () => {
  /**
   * 21.2 property 6, the tracked half. The untracked half — that an
   * `untracked_self` or `third_party` expense changes none of the three — is
   * proved separately below.
   *
   * A `K` expense touches no balance and no other role, so the identity's
   * inputs `ΣI`, `ΣNin`, `ΣNout` and `Δ` are all unchanged and the tracked
   * total cannot move; only the split between what is known and what is not.
   * The generator adds the expense **inside** the starting unclassified amount,
   * so the month has an answer to give and stays `reliable`.
   */
  it('leaves the tracked total, adds to the known, and reduces the unclassified', () => {
    fc.assert(
      fc.property(monthArb, dayArb, fc.integer({ min: 0, max: 100 }), (generated, on, share) => {
        const before = bucketOf(inputOf(generated));
        // Only a bucket that reconciled has an unclassified amount to spend.
        fc.pre(before.status === 'reliable');
        const room = before.totals.unclassified;
        expect(room).toBeDefined();
        if (room === undefined) return;

        // `0 ≤ E ≤ unclassified`, so the month cannot tip into `unresolved`.
        const amount = room.times(share).dividedBy(100);
        const added: ExpenseFlow = {
          id: 'property-6-expense',
          categoryKind: 'food',
          incurredOn: plainDate(on),
          amount,
          currency: EUR,
          settlement: 'tracked_cash',
          cashPositionId: generated.accounts[0]?.position.id ?? null,
        };

        const input = inputOf(generated, { expenses: [...generated.expenses, added] });
        const after = bucketOf(input);

        expect(after.totals.trackedTotalSpending?.toString()).toBe(
          before.totals.trackedTotalSpending?.toString(),
        );
        expect(
          after.totals.knownTrackedExpenses
            .minus(before.totals.knownTrackedExpenses)
            .equals(amount),
        ).toBe(true);
        expect(room.minus(after.totals.unclassified ?? new Decimal(0)).equals(amount)).toBe(true);
        expect(after.status).toBe('reliable');

        // And 12.5 routes it exactly once, into the bucket its kind names.
        const scoped = factsInScope(
          factsInRange(input, plainDate('2026-09-01'), plainDate('2026-09-30')),
          EUR,
          scopeAccountIds(after.accounts),
        );
        const classified = classifyScopedFacts(scoped);
        const beforeScoped = classifyScopedFacts(
          factsInScope(
            factsInRange(inputOf(generated), plainDate('2026-09-01'), plainDate('2026-09-30')),
            EUR,
            scopeAccountIds(before.accounts),
          ),
        );
        // `food` is consumption, so no non-consumption bucket may move at all.
        const nonConsumption = (c: ReturnType<typeof classifyScopedFacts>): string =>
          c.nonConsumptionCosts.propertyOperatingCosts
            .plus(c.nonConsumptionCosts.interestAndFees)
            .plus(c.nonConsumptionCosts.transactionCosts)
            .plus(c.nonConsumptionCosts.externalOutflows)
            .toString();
        expect(nonConsumption(classified)).toBe(nonConsumption(beforeScoped));
      }),
    );
  });
});

describe('property: the reconciliation identity is exact', () => {
  it('holds for any records, with no rounding and no tolerance', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const bucket = bucketOf(inputOf(generated));
        const { totals } = bucket;

        const total = totals.trackedTotalSpending;
        const unclassified = totals.unclassified;
        const cashDelta = totals.cashDelta;
        expect(total).toBeDefined();
        expect(unclassified).toBeDefined();
        // 30.12: the three balance-derived figures travel together. A bucket
        // that has one has all three.
        expect(cashDelta).toBeDefined();
        if (total === undefined || unclassified === undefined || cashDelta === undefined) return;

        // TrackedTotalSpending = ΣI + ΣNin − ΣNout − Δ
        expect(
          totals.externalInflows
            .plus(totals.nonIncomeInflows)
            .minus(totals.nonExpenseOutflows)
            .minus(cashDelta)
            .equals(total),
        ).toBe(true);

        // Unclassified = TrackedTotalSpending − ΣK
        expect(total.minus(totals.knownTrackedExpenses).equals(unclassified)).toBe(true);

        // 8.2's equivalent form, assembled from the account endpoints instead.
        const opening = bucket.accounts
          .filter((a) => a.included)
          .reduce((sum, a) => sum.plus(a.opening.amount ?? new Decimal(0)), new Decimal(0));
        const closing = bucket.accounts
          .filter((a) => a.included)
          .reduce((sum, a) => sum.plus(a.closing.amount ?? new Decimal(0)), new Decimal(0));
        expect(
          opening
            .plus(totals.externalInflows)
            .plus(totals.nonIncomeInflows)
            .minus(totals.nonExpenseOutflows)
            .minus(totals.knownTrackedExpenses)
            .minus(closing)
            .equals(unclassified),
        ).toBe(true);
      }),
    );
  });

  it('decomposes tracked spending into what is known and what is not', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        const { totals } = bucketOf(inputOf(generated));
        const total = totals.trackedTotalSpending;
        if (total === undefined || totals.unclassified === undefined) return;
        // 8.2: known expenses plus unclassified are the whole of it, always.
        expect(totals.knownTrackedExpenses.plus(totals.unclassified).equals(total)).toBe(true);
      }),
    );
  });

  it('never returns a figure for a bucket it could not compute', () => {
    fc.assert(
      fc.property(monthArb, (generated) => {
        // Strip one account's closing balance: the bucket becomes unavailable
        // and must report no number rather than a confident zero.
        const [first, ...rest] = generated.accounts;
        if (first === undefined) return;
        const crippled: CashAccountInput = {
          ...first,
          valuations: first.valuations.filter((v) => v.valuedOn !== '2026-09-30'),
        };
        const bucket = bucketOf(
          inputOf(generated, { cashAccounts: [crippled, ...rest] }),
        );
        expect(bucket.status).toBe('unavailable');
        expect(bucket.totals.cashDelta).toBeUndefined();
        expect(bucket.totals.trackedTotalSpending).toBeUndefined();
        expect(bucket.totals.unclassified).toBeUndefined();
      }),
    );
  });
});

describe('property: a same-currency transfer is neutral', () => {
  it('changes no total when both accounts are included', () => {
    fc.assert(
      fc.property(monthArb, amountArb, dayArb, (generated, amount, on) => {
        fc.pre(generated.accounts.length >= 2);
        const [from, to] = generated.accounts;
        if (from === undefined || to === undefined) return;

        const before = bucketOf(inputOf(generated));
        const after = bucketOf(
          inputOf(generated, {
            transfers: [
              ...generated.transfers,
              {
                id: `neutral-${amount}`,
                kind: 'cash_transfer',
                occurredOn: plainDate(on),
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

        // +x on Nin and −x on Nout cancel exactly inside the bucket.
        expect(after.totals.trackedTotalSpending?.toString()).toBe(
          before.totals.trackedTotalSpending?.toString(),
        );
        expect(after.totals.unclassified?.toString()).toBe(
          before.totals.unclassified?.toString(),
        );
        expect(after.status).toBe(before.status);
      }),
    );
  });
});

describe('property: untracked spending never enters the identity', () => {
  it('leaves every total alone however much of it there is', () => {
    fc.assert(
      fc.property(
        monthArb,
        fc.array(fc.tuple(amountArb, dayArb), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (generated, extras, thirdParty) => {
          const before = bucketOf(inputOf(generated));

          const added: ExpenseFlow[] = extras.map(([amount, on], index): ExpenseFlow => ({
            id: `untracked-${String(index)}-${amount}`,
            categoryKind: 'food',
            incurredOn: plainDate(on),
            amount: new Decimal(amount),
            currency: EUR,
            settlement: thirdParty ? 'third_party' : 'untracked_self',
            cashPositionId: null,
          }));

          const after = bucketOf(
            inputOf(generated, { expenses: [...generated.expenses, ...added] }),
          );

          expect(after.totals.knownTrackedExpenses.toString()).toBe(
            before.totals.knownTrackedExpenses.toString(),
          );
          expect(after.totals.trackedTotalSpending?.toString()).toBe(
            before.totals.trackedTotalSpending?.toString(),
          );
          expect(after.totals.unclassified?.toString()).toBe(
            before.totals.unclassified?.toString(),
          );

          // It is reported beside the identity, exactly and in full (7.4).
          const sum = added.reduce((total, e) => total.plus(e.amount), new Decimal(0));
          const bucketField = thirdParty ? after.thirdPartyPaid : after.additionalSpending;
          const beforeField = thirdParty ? before.thirdPartyPaid : before.additionalSpending;
          expect(bucketField.minus(beforeField).equals(sum)).toBe(true);
        },
      ),
    );
  });
});

describe('property: an excluded account takes its own legs with it', () => {
  it('leaves tracked spending unchanged when money is moved into a newly tracked account', () => {
    fc.assert(
      fc.property(monthArb, amountArb, dayArb, (generated, amount, on) => {
        const [source] = generated.accounts;
        if (source === undefined) return;

        const before = bucketOf(inputOf(generated));
        fc.pre(before.totals.trackedTotalSpending !== undefined);

        // 8.8: a pre-existing account first tracked in M, receiving `amount`
        // from an included account whose closing balance falls by the same.
        const newlyTracked: CashAccountInput = {
          position: position('Newly tracked', { id: 'acct-new', currency: 'EUR' }),
          valuations: [monthEnd('acct-new', '2026-09-30', amount)],
          accountType: 'savings',
        };
        const closing = source.valuations.find((v) => v.valuedOn === '2026-09-30');
        if (closing === undefined) return;
        const reducedSource: CashAccountInput = {
          ...source,
          valuations: [
            ...source.valuations.filter((v) => v.valuedOn !== '2026-09-30'),
            monthEnd(source.position.id, '2026-09-30', closing.amount.minus(amount).toString()),
          ],
        };

        const after = bucketOf(
          inputOf(generated, {
            cashAccounts: [reducedSource, ...generated.accounts.slice(1), newlyTracked],
            transfers: [
              ...generated.transfers,
              {
                id: `into-new-${amount}`,
                kind: 'cash_transfer',
                occurredOn: plainDate(on),
                fromPositionId: source.position.id,
                fromCurrency: EUR,
                fromAmount: new Decimal(amount),
                toPositionId: 'acct-new',
                toCurrency: EUR,
                toAmount: new Decimal(amount),
              },
            ],
          }),
        );

        // Only the source's Nout leg counts, against the source's own Δ of
        // −amount, so spending is unaffected — and the month says so.
        expect(after.totals.trackedTotalSpending?.toString()).toBe(
          before.totals.trackedTotalSpending?.toString(),
        );
        expect(after.accounts.find((a) => a.positionId === 'acct-new')?.included).toBe(false);
        expect(after.issues.some((i) => i.key === 'first_balance')).toBe(true);
      }),
    );
  });
});

/** Any September day the two statement balances do not already occupy. */
const insideMonthArb = fc
  .integer({ min: 1, max: 29 })
  .map((day) => `2026-09-${String(day).padStart(2, '0')}`);

/** Everything a completed month says, as exact strings rather than Decimals. */
function observableOf(bucket: ReturnType<typeof bucketOf>) {
  return {
    status: bucket.status,
    cashDelta: bucket.totals.cashDelta?.toString(),
    trackedTotalSpending: bucket.totals.trackedTotalSpending?.toString(),
    unclassified: bucket.totals.unclassified?.toString(),
    externalInflows: bucket.totals.externalInflows.toString(),
    nonIncomeInflows: bucket.totals.nonIncomeInflows.toString(),
    nonExpenseOutflows: bucket.totals.nonExpenseOutflows.toString(),
    knownTrackedExpenses: bucket.totals.knownTrackedExpenses.toString(),
    additionalSpending: bucket.additionalSpending.toString(),
    thirdPartyPaid: bucket.thirdPartyPaid.toString(),
    // Keys only, and sorted: which issues the month raises is the contract,
    // the order they were detected in is not.
    issues: bucket.issues.map((issue) => issue.key).sort(),
    // 8.3 orders the accounts by id, so this array is the contract's own.
    accounts: bucket.accounts.map((state) => ({
      positionId: state.positionId,
      openState: state.opening.state,
      opening: state.opening.amount?.toString(),
      openingValuedOn: state.opening.valuedOn,
      closeState: state.closing.state,
      closing: state.closing.amount?.toString(),
      closingValuedOn: state.closing.valuedOn,
      included: state.included,
      excludedFirstBalance: state.excludedFirstBalance,
      residual: state.residual?.toString(),
    })),
  };
}

describe('property: an ordinary snapshot inside the month is not an endpoint', () => {
  /**
   * 8.1 and 8.8, as an invariant rather than one date.
   *
   * A completed month is reconciled between two statement balances —
   * `close(a, M−1)` and `close(a, M)` — so an ordinary snapshot dated strictly
   * between them is evidence this engine reads nothing from. Adding one must
   * leave every figure the month reports exactly where it was.
   *
   * The generated day deliberately includes the 1st, which is where reading the
   * opening as "the latest valuation on or before start(M)" fell over: the
   * snapshot stood in for M−1's statement, the account opened at zero while its
   * state went on saying `month_end`, and the whole balance was reported as one
   * month of spending. Quick Update writes such a row on the 1st routinely.
   */
  it('leaves every completed-month figure exactly where it was', () => {
    fc.assert(
      fc.property(monthArb, amountArb, insideMonthArb, (generated, amount, on) => {
        const [first, ...rest] = generated.accounts;
        if (first === undefined) return;

        const before = observableOf(bucketOf(inputOf(generated)));
        const snapshotted: CashAccountInput = {
          ...first,
          valuations: [...first.valuations, valuation(first.position.id, on, amount)],
        };
        const after = observableOf(
          bucketOf(inputOf(generated, { cashAccounts: [snapshotted, ...rest] })),
        );

        expect(after).toEqual(before);
      }),
    );
  });
});
