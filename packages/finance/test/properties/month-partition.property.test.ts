import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import {
  addDays,
  addMonths,
  endOfMonthKey,
  monthKey,
  monthKeyOf,
  plainDate,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import { monthEnd, position } from '../helpers/records';
import type { RoleLeg } from '../../src/flows/roles';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../src/flows/types';
import {
  reconcileCompletedMonth,
  type BucketResult,
  type CashAccountInput,
  type CompletedMonthInput,
} from '../../src/reconciliation/index';
import {
  legsInRange,
  legsInScope,
  roleSums,
  sumAmounts,
  type FlowRecords,
} from '../../src/reconciliation/scope';

/**
 * Property 14, first half — the month partition (blueprint 21.2 property 14):
 *
 * > "over any sequence of completed months with month-end balances, monthly
 * > totals sum to the whole-range span total"
 *
 * This is a statement about **time**, not about evidence topology: reconciling
 * a stretch month by month and adding up must give what reconciling the same
 * stretch once, end to end, gives. The second half — that a span never overlaps
 * a reliable month — is evidence topology and lives in
 * `span-reliable-month.property.test.ts`.
 *
 * Deliberately **no span discovery here**. A gapless run of months with every
 * month end present has no missing endpoint to bridge, so 8.7 correctly finds
 * no span in it; "the whole-range span total" means 8.2's identity evaluated
 * once over `[start(M_first), end(M_last)]`, and that is what the oracle below
 * builds — from the raw endpoints and the scoped legs, never by adding up the
 * monthly results it exists to check. Nothing in this file imports a span
 * function.
 *
 * Native currency, exact Decimal, no FX and no reporting layer: Property 14
 * predates all of that.
 */

const CURRENCY = currencyCode('EUR');
/** The account the whole month's cash change happens in. */
const MOVING = 'acct-moving';
/** A second included account that never moves, so `Δ` is a sum and not a copy. */
const STEADY = 'acct-steady';

/**
 * A non-negative amount at minor-unit scale.
 *
 * Two fractional digits and bounded by ten thousand, so twelve months of them
 * cannot approach forty significant digits: this property is about temporal
 * partition, and working precision must never become its subject.
 */
const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => new Decimal(`${String(whole)}.${String(cents).padStart(2, '0')}`));

/** Which day of its own month a leg falls on: the first, the middle, or the last. */
const dayIndexArb = fc.integer({ min: 0, max: 2 });

interface MonthPart {
  readonly i: Decimal;
  readonly nin: Decimal;
  readonly nout: Decimal;
  readonly k: Decimal;
  /** The residual this month is built to produce. Non-negative, so it reconciles. */
  readonly u: Decimal;
  readonly days: readonly [number, number, number, number];
}

const monthPartArb: fc.Arbitrary<MonthPart> = fc.record({
  i: amountArb,
  nin: amountArb,
  nout: amountArb,
  k: amountArb,
  u: amountArb,
  days: fc.tuple(dayIndexArb, dayIndexArb, dayIndexArb, dayIndexArb),
});

interface History {
  readonly months: readonly MonthKey[];
  readonly parts: readonly MonthPart[];
  /** `M_first − 1`, whose month end is the whole range's opening evidence. */
  readonly openingAnchor: MonthKey;
  readonly accounts: readonly CashAccountInput[];
  readonly records: FlowRecords;
  readonly today: PlainDate;
}

/** The first day of M, its fifteenth, or its last — every month has all three. */
function dayOf(month: MonthKey, index: number): PlainDate {
  if (index === 0) return startOfMonthKey(month);
  if (index === 1) return addDays(startOfMonthKey(month), 14);
  return endOfMonthKey(month);
}

/**
 * A gapless run of completed months whose arithmetic is consistent by
 * construction (8.2).
 *
 * Each month gets its four role sums and a chosen residual `U ≥ 0`, and then
 * the closing balance is *derived* so that
 *
 *     Δ = ΣI + ΣNin − ΣNout − ΣK − U
 *
 * which makes `TrackedTotalSpending = ΣK + U` and `Unclassified = U`. Nothing
 * is generated and then filtered away for having come out negative, so every
 * generated case is a real test rather than a discarded one — and every month is
 * eligible to be `reliable` rather than accidentally `unresolved`.
 *
 * The closing balance of each month is carried forward as the next month's
 * opening month-end balance, which is what makes the range gapless.
 */
function build(
  year: number,
  month: number,
  parts: readonly MonthPart[],
  opening: Decimal,
  steady: Decimal,
): History {
  const first = monthKeyOf(year, month);
  const openingAnchor = monthKey(addMonths(startOfMonthKey(first), -1));

  const months: MonthKey[] = [];
  const legs: RoleLeg[] = [];
  const movingEnds: { readonly on: PlainDate; readonly amount: Decimal }[] = [
    { on: endOfMonthKey(openingAnchor), amount: opening },
  ];

  let balance = opening;
  let current = first;
  for (const part of parts) {
    months.push(current);
    const push = (role: RoleLeg['role'], amount: Decimal, index: number, account: string | null): void => {
      legs.push({
        role,
        currency: CURRENCY,
        amount,
        cashPositionId: account,
        on: dayOf(current, index),
        sourceId: `${current}-${role}`,
      });
    };
    // Two attributed and two null, so the scope predicate is exercised on both
    // kinds of leg without turning attribution into the subject of the property.
    push('I', part.i, part.days[0], MOVING);
    push('Nin', part.nin, part.days[1], null);
    push('Nout', part.nout, part.days[2], MOVING);
    push('K', part.k, part.days[3], null);

    balance = balance.plus(part.i).plus(part.nin).minus(part.nout).minus(part.k).minus(part.u);
    movingEnds.push({ on: endOfMonthKey(current), amount: balance });
    current = monthKey(addMonths(startOfMonthKey(current), 1));
  }

  const steadyEnds = movingEnds.map((end) => end.on);
  const accounts: CashAccountInput[] = [
    {
      position: position('Moving', { id: MOVING, currency: 'EUR' }),
      valuations: movingEnds.map((end) => monthEnd(MOVING, end.on, end.amount.toFixed())),
      accountType: 'checking',
    },
    {
      position: position('Steady', { id: STEADY, currency: 'EUR' }),
      valuations: steadyEnds.map((on) => monthEnd(STEADY, on, steady.toFixed())),
      accountType: 'checking',
    },
  ];

  const last = months[months.length - 1] ?? first;
  return {
    months,
    parts,
    openingAnchor,
    accounts,
    records: { income: [], expenses: [], transfers: [], preClassifiedLegs: legs },
    today: addDays(endOfMonthKey(last), 1),
  };
}

const historyArb: fc.Arbitrary<History> = fc
  .tuple(
    // Enough calendar spread to reach 28-, 29-, 30- and 31-day months and to
    // cross year boundaries without being told to.
    fc.integer({ min: 2020, max: 2026 }),
    fc.integer({ min: 1, max: 12 }),
    fc.array(monthPartArb, { minLength: 2, maxLength: 12 }),
    amountArb,
    amountArb,
  )
  .map(([year, month, parts, opening, steady]) => build(year, month, parts, opening, steady));

function inputFor(history: History, month: MonthKey): CompletedMonthInput {
  return {
    month,
    today: history.today,
    cashAccounts: history.accounts,
    income: [],
    expenses: [],
    transfers: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
    preClassifiedLegs: history.records.preClassifiedLegs ?? [],
  };
}

/** The one native bucket these histories produce. */
function bucketFor(history: History, month: MonthKey): BucketResult {
  const bucket = reconcileCompletedMonth(inputFor(history, month)).buckets[0];
  if (bucket === undefined) throw new Error(`no ${CURRENCY} bucket for ${month}`);
  return bucket;
}

/**
 * A balance-derived figure the result must have.
 *
 * Thrown rather than defaulted: 30.12 says the three travel together, so an
 * absent one is a fact to look at, not a zero to substitute.
 */
function need(value: Decimal | undefined, what: string, month: string): Decimal {
  if (value === undefined) throw new Error(`${month} has no ${what}`);
  return value;
}

/**
 * The total month-end balance at one date, read from the generated valuations.
 *
 * The raw endpoints, deliberately: an oracle that asked the engine for them
 * would be checking that the engine can add up its own working.
 */
function balanceAt(accounts: readonly CashAccountInput[], on: PlainDate): Decimal {
  return sumAmounts(
    accounts.map((account) => {
      const at = account.valuations.find((valuation) => valuation.valuedOn === on);
      if (at === undefined) throw new Error(`no month-end balance for ${account.position.id} at ${on}`);
      return at.amount;
    }),
  );
}

interface WholeRange {
  readonly cashDelta: Decimal;
  readonly externalInflows: Decimal;
  readonly nonIncomeInflows: Decimal;
  readonly nonExpenseOutflows: Decimal;
  readonly knownTrackedExpenses: Decimal;
  readonly trackedTotalSpending: Decimal;
  readonly unclassified: Decimal;
}

/**
 * 8.2's identity evaluated **once** over the whole range.
 *
 * It reuses the accepted low-level primitives — `legsInRange`, `legsInScope`,
 * `roleSums` — because duplicating role semantics in a test would prove only
 * that the duplicate agrees with itself. What it must not do, and does not, is
 * call `reconcileCompletedMonth`, `findSpans` or `findSpanIntervals`: the side
 * being checked cannot be built out of the side doing the checking.
 */
function wholeRangeOf(history: History): WholeRange {
  const first = history.months[0];
  const last = history.months[history.months.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty history');

  const from = startOfMonthKey(first);
  const to = endOfMonthKey(last);

  const opening = balanceAt(history.accounts, endOfMonthKey(history.openingAnchor));
  const closing = balanceAt(history.accounts, to);
  const cashDelta = closing.minus(opening);

  // Every generated account participates and none is excluded, which the
  // per-month assertions below check rather than assume.
  const scopeIds = new Set(history.accounts.map((account) => account.position.id));
  const sums = roleSums(legsInScope(legsInRange(history.records, from, to), CURRENCY, scopeIds));

  const trackedTotalSpending = sums.externalInflows
    .plus(sums.nonIncomeInflows)
    .minus(sums.nonExpenseOutflows)
    .minus(cashDelta);

  return {
    cashDelta,
    externalInflows: sums.externalInflows,
    nonIncomeInflows: sums.nonIncomeInflows,
    nonExpenseOutflows: sums.nonExpenseOutflows,
    knownTrackedExpenses: sums.knownTrackedExpenses,
    trackedTotalSpending,
    unclassified: trackedTotalSpending.minus(sums.knownTrackedExpenses),
  };
}

describe('property 14a: monthly totals partition the whole range', () => {
  it('sums each figure to the same one the whole range gives, exactly', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const buckets = history.months.map((month) => bucketFor(history, month));

        // Reliability is a claim of the generator, so it is asserted and never
        // assumed: a month that is not reliable here is either a generator bug
        // or a counterexample, and both need looking at.
        buckets.forEach((bucket, index) => {
          const month = history.months[index] ?? '(unknown)';
          expect(bucket.status).toBe('reliable');
          expect(bucket.accounts).toHaveLength(2);
          for (const account of bucket.accounts) {
            expect(account.excludedFirstBalance).toBe(false);
            expect(account.included).toBe(true);
          }
          // And it produced all three balance-derived figures (30.12).
          need(bucket.totals.cashDelta, 'cashDelta', month);
          need(bucket.totals.trackedTotalSpending, 'trackedTotalSpending', month);
          need(bucket.totals.unclassified, 'unclassified', month);
        });

        const whole = wholeRangeOf(history);
        const monthOf = (index: number): string => history.months[index] ?? '(unknown)';
        const total = (pick: (bucket: BucketResult, index: number) => Decimal): Decimal =>
          sumAmounts(buckets.map(pick));

        expect(
          total((b) => b.totals.externalInflows).equals(whole.externalInflows),
        ).toBe(true);
        expect(
          total((b) => b.totals.nonIncomeInflows).equals(whole.nonIncomeInflows),
        ).toBe(true);
        expect(
          total((b) => b.totals.nonExpenseOutflows).equals(whole.nonExpenseOutflows),
        ).toBe(true);
        expect(
          total((b) => b.totals.knownTrackedExpenses).equals(whole.knownTrackedExpenses),
        ).toBe(true);
        expect(
          total((b, index) => need(b.totals.cashDelta, 'cashDelta', monthOf(index)))
            .equals(whole.cashDelta),
        ).toBe(true);
        expect(
          total((b, index) =>
            need(b.totals.trackedTotalSpending, 'trackedTotalSpending', monthOf(index)),
          ).equals(whole.trackedTotalSpending),
        ).toBe(true);
        expect(
          total((b, index) => need(b.totals.unclassified, 'unclassified', monthOf(index)))
            .equals(whole.unclassified),
        ).toBe(true);

        // And the residual really is the one the generator asked for, so the
        // agreement above is not two engines agreeing on the wrong number.
        expect(
          whole.unclassified.equals(sumAmounts(history.parts.map((part) => part.u))),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Date partition, on real source records                                     */
/* -------------------------------------------------------------------------- */

/**
 * The boundaries the property above exercises by construction, pinned once with
 * real income, expense and transfer records rather than pre-classified legs.
 *
 * A leg dated `end(M)` belongs to M — 8.1's same-day rule makes the balance at
 * `end(M)` already reflect it — and a leg dated `start(M)` belongs to M and not
 * to the month before. December into January crosses a year, and February 2028
 * is a leap month, so both awkward month lengths are here.
 *
 * Property 7 covers the identity over one month's random records; this covers
 * which month a record on a boundary lands in.
 */
describe('property 14a: a record on a month boundary belongs to exactly one month', () => {
  const DECEMBER = monthKeyOf(2027, 12);
  const JANUARY = monthKeyOf(2028, 1);
  const FEBRUARY = monthKeyOf(2028, 2);
  const TODAY = plainDate('2028-03-01');
  const A = 'acct-a';
  const B = 'acct-b';

  const income = (id: string, on: string, amount: string): IncomeFlow => ({
    id,
    kind: 'employment',
    receivedOn: plainDate(on),
    netAmount: new Decimal(amount),
    currency: CURRENCY,
    settlement: 'tracked_cash',
    cashPositionId: A,
  });

  const expense = (id: string, on: string, amount: string): ExpenseFlow => ({
    id,
    categoryKind: 'food',
    incurredOn: plainDate(on),
    amount: new Decimal(amount),
    currency: CURRENCY,
    settlement: 'tracked_cash',
    cashPositionId: A,
  });

  const transfer: TransferFlow = {
    id: 'transfer-jan-31',
    kind: 'cash_transfer',
    occurredOn: plainDate('2028-01-31'),
    fromPositionId: A,
    fromCurrency: CURRENCY,
    fromAmount: new Decimal('300'),
    toPositionId: B,
    toCurrency: CURRENCY,
    toAmount: new Decimal('300'),
  };

  const accounts: CashAccountInput[] = [
    {
      position: position('A', { id: A, currency: 'EUR' }),
      valuations: [
        monthEnd(A, '2027-11-30', '1000'),
        monthEnd(A, '2027-12-31', '1300'),
        monthEnd(A, '2028-01-31', '1300'),
        monthEnd(A, '2028-02-29', '1250'),
      ],
      accountType: 'checking',
    },
    {
      position: position('B', { id: B, currency: 'EUR' }),
      valuations: [
        monthEnd(B, '2027-11-30', '0'),
        monthEnd(B, '2027-12-31', '0'),
        monthEnd(B, '2028-01-31', '300'),
        monthEnd(B, '2028-02-29', '300'),
      ],
      accountType: 'checking',
    },
  ];

  const records = {
    income: [income('dec-31', '2027-12-31', '500'), income('jan-31', '2028-01-31', '400')],
    expenses: [
      expense('dec-01', '2027-12-01', '200'),
      expense('jan-01', '2028-01-01', '100'),
      expense('feb-29', '2028-02-29', '50'),
    ],
    transfers: [transfer],
  };

  const bucketOf = (month: MonthKey): BucketResult => {
    const bucket = reconcileCompletedMonth({
      month,
      today: TODAY,
      cashAccounts: accounts,
      ...records,
      templates: [],
      resolvedOccurrences: new Set<string>(),
    }).buckets[0];
    if (bucket === undefined) throw new Error(`no bucket for ${month}`);
    return bucket;
  };

  it('keeps the last day in its own month and the first day out of the one before', () => {
    const december = bucketOf(DECEMBER);
    const january = bucketOf(JANUARY);
    const february = bucketOf(FEBRUARY);

    // 31 December is December's income, and 1 January is January's expense.
    expect(december.totals.externalInflows.toString()).toBe('500');
    expect(december.totals.knownTrackedExpenses.toString()).toBe('200');
    expect(january.totals.externalInflows.toString()).toBe('400');
    expect(january.totals.knownTrackedExpenses.toString()).toBe('100');
    // 29 February exists, and is February's alone.
    expect(february.totals.externalInflows.toString()).toBe('0');
    expect(february.totals.knownTrackedExpenses.toString()).toBe('50');

    // The transfer lands wholly in January and cancels inside it.
    expect(january.totals.nonIncomeInflows.toString()).toBe('300');
    expect(january.totals.nonExpenseOutflows.toString()).toBe('300');
    for (const bucket of [december, february]) {
      expect(bucket.totals.nonIncomeInflows.toString()).toBe('0');
      expect(bucket.totals.nonExpenseOutflows.toString()).toBe('0');
    }

    for (const bucket of [december, january, february]) {
      expect(bucket.status).toBe('reliable');
      expect(bucket.totals.unclassified?.toString()).toBe('0');
    }
  });

  it('partitions the three months into the same whole-range figures', () => {
    const months = [DECEMBER, JANUARY, FEBRUARY];
    const buckets = months.map(bucketOf);

    // The whole range, from the raw endpoints and the scoped legs.
    const from = startOfMonthKey(DECEMBER);
    const to = endOfMonthKey(FEBRUARY);
    const opening = balanceAt(accounts, plainDate('2027-11-30'));
    const closing = balanceAt(accounts, to);
    const cashDelta = closing.minus(opening);
    const scopeIds = new Set(accounts.map((account) => account.position.id));
    const sums = roleSums(legsInScope(legsInRange(records, from, to), CURRENCY, scopeIds));
    const trackedTotalSpending = sums.externalInflows
      .plus(sums.nonIncomeInflows)
      .minus(sums.nonExpenseOutflows)
      .minus(cashDelta);

    expect(cashDelta.toString()).toBe('550');
    expect(sums.externalInflows.toString()).toBe('900');
    expect(sums.knownTrackedExpenses.toString()).toBe('350');
    expect(trackedTotalSpending.toString()).toBe('350');

    const total = (
      pick: (bucket: BucketResult) => Decimal | undefined,
      what: string,
    ): string =>
      sumAmounts(
        buckets.map((bucket, index) => need(pick(bucket), what, String(months[index]))),
      ).toString();

    expect(total((b) => b.totals.cashDelta, 'cashDelta')).toBe(cashDelta.toString());
    expect(total((b) => b.totals.externalInflows, 'I')).toBe(sums.externalInflows.toString());
    expect(total((b) => b.totals.nonIncomeInflows, 'Nin')).toBe(sums.nonIncomeInflows.toString());
    expect(total((b) => b.totals.nonExpenseOutflows, 'Nout')).toBe(
      sums.nonExpenseOutflows.toString(),
    );
    expect(total((b) => b.totals.knownTrackedExpenses, 'K')).toBe(
      sums.knownTrackedExpenses.toString(),
    );
    expect(total((b) => b.totals.trackedTotalSpending, 'trackedTotalSpending')).toBe(
      trackedTotalSpending.toString(),
    );
    expect(total((b) => b.totals.unclassified, 'unclassified')).toBe(
      trackedTotalSpending.minus(sums.knownTrackedExpenses).toString(),
    );
  });
});
