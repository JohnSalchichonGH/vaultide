import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { plainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import { monthEnd, position, valuation } from './helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../src/flows/types';
import {
  reconcileMonthToDate,
  type CashAccountInput,
  type MonthToDateInput,
  type MonthToDateResult,
} from '../src/reconciliation/index';

/**
 * Month-to-date reconciliation (blueprint 8.6, v2.1.10 30.13).
 *
 * Every fixture below was written from 8.6 and 30.13 before the engine ran
 * against it. September 2026 throughout, with today on the 10th unless a case
 * needs otherwise, so "the 6th" and "the 8th" mean what they mean in 8.6's own
 * example.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const TODAY = plainDate('2026-09-10');

const A = 'account-a';
const B = 'account-b';
const C = 'account-c';

function account(
  id: string,
  name: string,
  valuations: CashAccountInput['valuations'],
  options: { currency?: string; openedOn?: string; closedOn?: string; isDormant?: boolean } = {},
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
    accountType: 'checking',
  };
}

/** August's statement balance: the current month's opening (8.6). */
const opening = (id: string, amount: string) => monthEnd(id, '2026-08-31', amount);
/** An ordinary snapshot — the only closing evidence the current month can have. */
const snap = (id: string, on: string, amount: string) => valuation(id, on, amount);

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String((sequence += 1))}`;

function income(over: Partial<IncomeFlow> = {}): IncomeFlow {
  return {
    id: nextId('income'),
    kind: 'employment',
    receivedOn: plainDate('2026-09-04'),
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
    incurredOn: plainDate('2026-09-04'),
    amount: new Decimal('100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: A,
    ...over,
  };
}

function transfer(over: Partial<TransferFlow> = {}): TransferFlow {
  return {
    id: nextId('transfer'),
    kind: 'cash_transfer',
    occurredOn: plainDate('2026-09-04'),
    fromPositionId: A,
    fromCurrency: EUR,
    fromAmount: new Decimal('200'),
    toPositionId: B,
    toCurrency: EUR,
    toAmount: new Decimal('200'),
    ...over,
  };
}

function input(over: Partial<MonthToDateInput> = {}): MonthToDateInput {
  return {
    today: TODAY,
    cashAccounts: [],
    income: [],
    expenses: [],
    transfers: [],
    ...over,
  };
}

/** The `asOf`-defined shape, or a failure that names what came back instead. */
function computed(result: MonthToDateResult) {
  if (result.asOf === null) {
    throw new Error(`expected a month-to-date date, got ${result.reason}`);
  }
  return result;
}

const eur = (result: MonthToDateResult) =>
  computed(result).buckets.find((b) => b.currency === 'EUR');

describe('A — a common date', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
        account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-06', '500')]),
      ],
      expenses: [expense({ amount: new Decimal('100') })],
    }),
  );

  it('reconciles through the latest day both accounts share', () => {
    expect(result.asOf).toBe('2026-09-06');
    expect(result.status).toBe('provisional');
  });

  it('computes the identity through that day', () => {
    const bucket = eur(result);
    expect(bucket?.totals.cashDelta?.toString()).toBe('-100');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('100');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('100');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
    expect(bucket?.status).toBe('provisional');
  });

  it('is never reliable, however exact the evidence is', () => {
    // 8.6: the month is unfinished, and that is what `provisional` says.
    expect(result.status).not.toBe('reliable');
    expect(result.status).not.toBe('estimated');
  });

  it('leaves every account without a residual', () => {
    // 30.13 item 10: 8.6 specifies no per-account residual for the current
    // month, so none is computed and `possible_missing_interest` has nothing to
    // read.
    expect(JSON.stringify(eur(result)?.accounts)).not.toContain('residual');
    expect(eur(result)?.issues.some((i) => i.key === 'possible_missing_interest')).toBe(false);
  });
});

describe('B — one newer balance', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [
          opening(A, '1000'),
          snap(A, '2026-09-06', '900'),
          snap(A, '2026-09-08', '850'),
        ]),
        account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-06', '500')]),
      ],
    }),
  );

  it('keeps the date at the 6th and says why', () => {
    expect(result.asOf).toBe('2026-09-06');
    expect(computed(result).accountsWithNewerBalances).toEqual([A]);
    const advisory = computed(result).issues.find((i) => i.key === 'mtd_newer_balances');
    expect(advisory?.class).toBe('advisory');
    expect(advisory?.positionIds).toEqual([A]);
  });

  it('does not let the 8th balance into the arithmetic', () => {
    // −100 through the 6th, not the −150 the 8th would give.
    expect(eur(result)?.totals.cashDelta?.toString()).toBe('-100');
  });

  it('leaves the status alone, because the advisory is not a problem', () => {
    expect(result.status).toBe('provisional');
  });
});

describe('C — no common date', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
        account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-07', '500')]),
      ],
      income: [income({ netAmount: new Decimal('700') })],
    }),
  );

  it('has no date, and says so with the blocking issue', () => {
    expect(result.asOf).toBeNull();
    expect(result.status).toBe('unavailable');
    expect(result.asOf === null ? result.reason : undefined).toBe('mtd_no_common_date');
    expect(result.issues.map((i) => i.key)).toEqual(['mtd_no_common_date']);
    expect(result.issues[0]?.class).toBe('blocking');
  });

  it('reports no totals of any kind', () => {
    // 30.13 item 5: without D there is no interval, so the 700 of recorded
    // income is not an MTD figure. Reporting it against no balance date is the
    // one thing 8.6 forbids.
    expect(JSON.stringify(result)).not.toContain('externalInflows');
    expect('buckets' in result).toBe(false);
  });
});

describe('D — a first-balance account', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
        // Pre-existing, no history before September: 8.6's `first_balance`.
        account(B, 'Newly tracked', [snap(B, '2026-09-06', '5000')]),
      ],
      income: [income({ cashPositionId: B, netAmount: new Decimal('5000') })],
    }),
  );

  it('excludes it from the date and from the arithmetic', () => {
    expect(result.asOf).toBe('2026-09-06');
    const bucket = eur(result);
    const excluded = bucket?.accounts.find((a) => a.positionId === B);
    expect(excluded?.excludedFirstBalance).toBe(true);
    expect(excluded?.included).toBe(false);
    // Its attributed income goes with it (8.1).
    expect(bucket?.totals.externalInflows.toString()).toBe('0');
    expect(bucket?.totals.cashDelta?.toString()).toBe('-100');
  });

  it('stays provisional rather than becoming estimated', () => {
    // 30.13 item 1: provisional outranks estimated, and 8.6 says the current
    // month keeps it with the info issue attached.
    expect(result.status).toBe('provisional');
    expect(eur(result)?.issues.find((i) => i.key === 'first_balance')?.class).toBe('info');
  });
});

describe('E — a dormant account needs no snapshot', () => {
  it('reaches the date the other account supports', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
          account(B, 'Old account', [valuation(B, '2026-01-01', '0')], { isDormant: true }),
        ],
      }),
    );
    expect(result.asOf).toBe('2026-09-06');
    const dormant = eur(result)?.accounts.find((a) => a.positionId === B);
    expect(dormant?.snapshotRequired).toBe(false);
    expect(dormant?.atAsOf.state).toBe('dormant_zero');
    expect(dormant?.included).toBe(true);
  });
});

describe('F — an account closed before the date', () => {
  it('is worth zero there without a snapshot', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
          account(B, 'Closed', [opening(B, '80')], { closedOn: '2026-09-04' }),
        ],
      }),
    );
    expect(result.asOf).toBe('2026-09-06');
    const closed = eur(result)?.accounts.find((a) => a.positionId === B);
    expect(closed?.snapshotRequired).toBe(false);
    expect(closed?.atAsOf.state).toBe('closed_zero');
    expect(closed?.atAsOf.amount?.toString()).toBe('0');
    // 80 left the closed account and nothing says where.
    expect(eur(result)?.totals.cashDelta?.toString()).toBe('-80');
  });
});

describe('G — an account opened during the month', () => {
  it('opens at zero and still owes a snapshot at the date', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
          account(B, 'New', [snap(B, '2026-09-06', '100')], { openedOn: '2026-09-03' }),
        ],
        transfers: [transfer({ occurredOn: plainDate('2026-09-05'), fromAmount: new Decimal('100'), toAmount: new Decimal('100') })],
      }),
    );
    expect(result.asOf).toBe('2026-09-06');
    const opened = eur(result)?.accounts.find((a) => a.positionId === B);
    expect(opened?.opening.state).toBe('opened_zero');
    expect(opened?.snapshotRequired).toBe(true);
    expect(opened?.atAsOf.state).toBe('snapshot');
    // −100 on BBVA and +100 on the new account: the transfer cancels.
    expect(eur(result)?.totals.cashDelta?.toString()).toBe('0');
    expect(eur(result)?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('H — an account opened after the date', () => {
  it('does not block a date from before it existed', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
          account(B, 'Opened later', [], { openedOn: '2026-09-08' }),
        ],
      }),
    );
    expect(result.asOf).toBe('2026-09-06');
    // 30.13 item 8: it is not in the interval `[start(M), D]` at all, so it is
    // not an account of the bucket either — not one listed as excluded.
    expect(eur(result)?.accounts.map((a) => a.positionId)).toEqual([A]);
    expect(eur(result)?.totals.cashDelta?.toString()).toBe('-100');
  });
});

describe('I — every included account structurally zero', () => {
  it('reaches today, because nothing owes a snapshot', () => {
    // 30.13 item 7. The predicate is satisfied without a snapshot, and there is
    // an included set to satisfy it about.
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'Closed', [opening(A, '0')], { closedOn: '2026-09-02' }),
          account(B, 'Dormant', [valuation(B, '2026-01-01', '0')], { isDormant: true }),
        ],
      }),
    );
    expect(result.asOf).toBe('2026-09-10');
    expect(result.status).toBe('provisional');
    expect(eur(result)?.totals.cashDelta?.toString()).toBe('0');
  });
});

describe('J — every participating account excluded', () => {
  it('has no date at all, rather than a vacuous one', () => {
    // 30.13 item 6: the snapshot predicate is vacuously true for an empty
    // included set, and a month-to-date of zero out of nothing is exactly what
    // that must not produce.
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'Newly tracked', [snap(A, '2026-09-06', '5000')]),
          account(B, 'Also newly tracked', [snap(B, '2026-09-06', '900')]),
        ],
      }),
    );
    expect(result.asOf).toBeNull();
    expect(result.status).toBe('unavailable');
    expect(result.asOf === null ? result.reason : undefined).toBe('mtd_no_common_date');
    // 8.6: "Without `D` no issue whose trigger needs the interval or the
    // arithmetic is evaluated at all; only `mtd_no_common_date` is raised." The
    // two exclusions are real, and they are the account-state read model's to
    // report — this result claims no interval and so reports nothing about one.
    expect(result.issues.map((i) => i.key)).toEqual(['mtd_no_common_date']);
  });
});

describe('J2 — a currency whose accounts are all excluded, while another supplies the date', () => {
  const EXCLUDED_ONE = 'excluded-one';
  const EXCLUDED_TWO = 'excluded-two';

  /**
   * Two pre-existing EUR accounts first tracked this month, and one USD account
   * with a proper opening and a snapshot on the 6th.
   *
   * The EUR pair are the month's `first_balance` exclusions, so they take no
   * part in choosing `D` (8.6) and USD fixes it alone. What is left is an EUR
   * bucket whose included set is empty — 8.4's "no included account" — while
   * `D` exists and USD reconciles truthfully through it.
   */
  const fixture = () =>
    input({
      cashAccounts: [
        account(EXCLUDED_ONE, 'Newly tracked', [snap(EXCLUDED_ONE, '2026-09-06', '5000')]),
        account(EXCLUDED_TWO, 'Also newly tracked', [snap(EXCLUDED_TWO, '2026-09-06', '900')]),
        account(C, 'USD account', [opening(C, '500'), snap(C, '2026-09-06', '480')], {
          currency: 'USD',
        }),
      ],
      // Attributed to an excluded account: 8.1 takes it out with the account.
      income: [income({ cashPositionId: EXCLUDED_ONE, netAmount: new Decimal('5000') })],
      expenses: [expense({ cashPositionId: EXCLUDED_TWO, amount: new Decimal('40') })],
    });

  const result = reconcileMonthToDate(fixture());
  const eurBucket = computed(result).buckets.find((b) => b.currency === 'EUR');
  const usdBucket = computed(result).buckets.find((b) => b.currency === 'USD');

  it('takes the date from the currency that can supply one', () => {
    expect(result.asOf).toBe('2026-09-06');
  });

  it('still produces the EUR bucket, because EUR has participating accounts', () => {
    // Not dropped: 8.1 enumerates a bucket from participating cash positions,
    // and an excluded account is participating — it is excluded from the
    // arithmetic, not from the month.
    expect(computed(result).buckets.map((b) => b.currency)).toEqual(['EUR', 'USD']);
    expect(eurBucket?.accounts.map((a) => a.positionId).sort()).toEqual([
      EXCLUDED_ONE,
      EXCLUDED_TWO,
    ]);
  });

  it('makes it unavailable, with no reason and both info issues kept', () => {
    // 8.4's `unavailable` row: "…or no included account…". No `missing_opening`
    // reason — nothing was unreadable, it was excluded.
    expect(eurBucket?.status).toBe('unavailable');
    expect(eurBucket?.reason).toBeUndefined();
    expect(eurBucket?.issues.map((i) => i.key)).toEqual(['first_balance', 'first_balance']);
    expect(eurBucket?.issues.every((i) => i.class === 'info')).toBe(true);
    expect(eurBucket?.issues.map((i) => i.positionId).sort()).toEqual([
      EXCLUDED_ONE,
      EXCLUDED_TWO,
    ]);
  });

  it('sums the roles over a scope that excludes both accounts, so all four are zero', () => {
    // Measured zeros, not unknowns: the 5,000 of income and the 40 of expense
    // are attributed to excluded accounts, so 8.1 takes them out of the bucket.
    expect(eurBucket?.totals.externalInflows.toString()).toBe('0');
    expect(eurBucket?.totals.nonIncomeInflows.toString()).toBe('0');
    expect(eurBucket?.totals.nonExpenseOutflows.toString()).toBe('0');
    expect(eurBucket?.totals.knownTrackedExpenses.toString()).toBe('0');
  });

  it('reports no balance-derived figure, and never a cash change of zero', () => {
    // 30.12: an empty included set has no complete change to measure, so there
    // is no Δ — not a Δ of nothing.
    expect(eurBucket?.totals.cashDelta).toBeUndefined();
    expect(eurBucket?.totals.trackedTotalSpending).toBeUndefined();
    expect(eurBucket?.totals.unclassified).toBeUndefined();
  });

  it('leaves the USD reconciliation standing, and the month unavailable', () => {
    // 30.13 item 4: the failure is bucket-local, and the month takes the worst.
    expect(usdBucket?.status).toBe('provisional');
    expect(usdBucket?.totals.cashDelta?.toString()).toBe('-20');
    expect(usdBucket?.totals.trackedTotalSpending?.toString()).toBe('20');
    expect(result.status).toBe('unavailable');
  });
});

describe('J3 — a null leg in a currency whose accounts are all excluded', () => {
  const EXCLUDED = 'excluded-only';

  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(EXCLUDED, 'Newly tracked', [snap(EXCLUDED, '2026-09-06', '5000')]),
        account(C, 'USD account', [opening(C, '500'), snap(C, '2026-09-06', '500')], {
          currency: 'USD',
        }),
      ],
      income: [income({ cashPositionId: null, netAmount: new Decimal('700') })],
    }),
  );
  const eurBucket = computed(result).buckets.find((b) => b.currency === 'EUR');

  it('keeps the null leg in the bucket, because EUR has a participating account', () => {
    // 8.1's support condition is **participation**, not inclusion: "a flow with
    // a null cash position but currency C belongs to the bucket; validation
    // requires a participating cash account of that currency". An excluded
    // account still participates, so the leg is supported and counted — and it
    // is not assigned to that account to make it so.
    expect(eurBucket?.totals.externalInflows.toString()).toBe('700');
  });

  it('raises no flow_without_cash_account, because the currency has an account', () => {
    expect(eurBucket?.issues.map((i) => i.key)).toEqual(['first_balance']);
  });

  it('is still unavailable, with no balance-derived figure', () => {
    // The leg is in the bucket; the bucket still has no included account to
    // measure a change over.
    expect(eurBucket?.status).toBe('unavailable');
    expect(eurBucket?.totals.cashDelta).toBeUndefined();
    expect(eurBucket?.totals.trackedTotalSpending).toBeUndefined();
    expect(result.status).toBe('unavailable');
  });
});

describe('J4 — a null leg in a currency with no participating account at all', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
      ],
      income: [income({ cashPositionId: null, currency: USD, netAmount: new Decimal('75') })],
    }),
  );
  const usdBucket = computed(result).buckets.find((b) => b.currency === 'USD');

  it('is unavailable and not unresolved, although the issue is blocking', () => {
    // 8.5 classes `flow_without_cash_account` as blocking, and 8.6 makes its
    // MTD consequence an unavailable bucket rather than the ordinary
    // blocking → unresolved path. The engine reaches this state before any
    // arithmetic exists to judge, so the ladder is never consulted.
    expect(usdBucket?.status).toBe('unavailable');
    expect(usdBucket?.status).not.toBe('unresolved');
    const raised = usdBucket?.issues.find((i) => i.key === 'flow_without_cash_account');
    expect(raised?.class).toBe('blocking');
    expect(raised?.amount?.toString()).toBe('75');
  });

  it('still reports the leg it could not place, and no balance-derived figure', () => {
    expect(usdBucket?.totals.externalInflows.toString()).toBe('75');
    expect(usdBucket?.totals.cashDelta).toBeUndefined();
    expect(usdBucket?.totals.trackedTotalSpending).toBeUndefined();
    expect(usdBucket?.totals.unclassified).toBeUndefined();
    expect(result.status).toBe('unavailable');
  });
});

describe('K — a missing opening in one currency', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        // EUR: only a carried balance from July, so no usable September opening.
        account(A, 'BBVA', [valuation(A, '2026-07-15', '1000'), snap(A, '2026-09-06', '900')]),
        // USD: complete.
        account(B, 'USD account', [opening(B, '500'), snap(B, '2026-09-06', '480')], {
          currency: 'USD',
        }),
      ],
    }),
  );

  it('makes only that bucket unavailable', () => {
    // 30.13 item 4: D is global, the failure is not.
    expect(result.asOf).toBe('2026-09-06');
    const eurBucket = computed(result).buckets.find((b) => b.currency === 'EUR');
    const usdBucket = computed(result).buckets.find((b) => b.currency === 'USD');

    expect(eurBucket?.status).toBe('unavailable');
    expect(eurBucket?.reason).toBe('missing_opening');
    expect(eurBucket?.totals.cashDelta).toBeUndefined();
    expect(eurBucket?.totals.trackedTotalSpending).toBeUndefined();

    expect(usdBucket?.status).toBe('provisional');
    expect(usdBucket?.totals.cashDelta?.toString()).toBe('-20');
  });

  it('still reports the month as unavailable overall', () => {
    expect(result.status).toBe('unavailable');
  });
});

describe('L — a negative unclassified', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1300')]),
      ],
    }),
  );

  it('is unresolved rather than provisional', () => {
    // 30.13 item 2: the month being unfinished is the weaker fact.
    expect(result.asOf).toBe('2026-09-06');
    expect(result.status).toBe('unresolved');
    expect(eur(result)?.totals.unclassified?.toString()).toBe('-300');
  });

  it('keeps the v2.1.8 variant split', () => {
    const raised = eur(result)?.issues.find((i) => i.key === 'unexplained_inflow');
    expect(raised?.class).toBe('blocking');
    expect(raised?.amount?.toString()).toBe('300');
    // Tracked total −300 → variant A, cash grew more than the records explain.
    expect(raised?.variant).toBe('a');
  });
});

describe('M — one date across two currencies', () => {
  const result = reconcileMonthToDate(
    input({
      cashAccounts: [
        // EUR could reach the 8th on its own.
        account(A, 'BBVA', [
          opening(A, '1000'),
          snap(A, '2026-09-06', '900'),
          snap(A, '2026-09-08', '850'),
        ]),
        // USD reaches only the 6th, and that decides it for everybody.
        account(B, 'USD account', [opening(B, '500'), snap(B, '2026-09-06', '500')], {
          currency: 'USD',
        }),
      ],
    }),
  );

  it('takes the date every account shares, across currencies', () => {
    expect(result.asOf).toBe('2026-09-06');
    expect(computed(result).buckets.map((b) => b.currency)).toEqual(['EUR', 'USD']);
  });

  it('reconciles both buckets through that one date', () => {
    const eurBucket = computed(result).buckets.find((b) => b.currency === 'EUR');
    const usdBucket = computed(result).buckets.find((b) => b.currency === 'USD');
    expect(eurBucket?.totals.cashDelta?.toString()).toBe('-100');
    expect(usdBucket?.totals.cashDelta?.toString()).toBe('0');
  });

  it('splits a cross-currency transfer into its two native legs', () => {
    const crossed = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '800')]),
          account(B, 'USD account', [opening(B, '0'), snap(B, '2026-09-06', '216.45')], {
            currency: 'USD',
          }),
        ],
        transfers: [
          transfer({
            occurredOn: plainDate('2026-09-05'),
            toCurrency: USD,
            toAmount: new Decimal('216.45'),
          }),
        ],
      }),
    );
    const eurBucket = computed(crossed).buckets.find((b) => b.currency === 'EUR');
    const usdBucket = computed(crossed).buckets.find((b) => b.currency === 'USD');
    expect(eurBucket?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(usdBucket?.totals.nonIncomeInflows.toString()).toBe('216.45');
    // Neither bucket sees an FX effect: each reconciles on its own.
    expect(eurBucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(usdBucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('N — the flow boundary at the date', () => {
  const accounts = () => [
    account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
  ];

  it('includes a flow dated on the date itself', () => {
    // 8.1's same-day rule: the snapshot at D reflects flows dated D.
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: accounts(),
          expenses: [expense({ incurredOn: plainDate('2026-09-06') })],
        }),
      ),
    );
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('100');
    expect(bucket?.totals.unclassified?.toString()).toBe('0');
  });

  it('excludes a flow dated the day after, even though it is recorded', () => {
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: accounts(),
          expenses: [expense({ incurredOn: plainDate('2026-09-07') })],
        }),
      ),
    );
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(bucket?.totals.unclassified?.toString()).toBe('100');
  });

  it('includes both legs of a transfer dated on the date', () => {
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: [
            account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '800')]),
            account(B, 'Savings', [opening(B, '0'), snap(B, '2026-09-06', '200')]),
          ],
          transfers: [transfer({ occurredOn: plainDate('2026-09-06') })],
        }),
      ),
    );
    expect(bucket?.totals.nonIncomeInflows.toString()).toBe('200');
    expect(bucket?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
  });
});

describe('O and P — a flow with no account named', () => {
  it('belongs to its currency bucket when an account of that currency takes part', () => {
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: [
            account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1100')]),
          ],
          income: [income({ cashPositionId: null })],
        }),
      ),
    );
    expect(bucket?.totals.externalInflows.toString()).toBe('100');
    expect(bucket?.totals.trackedTotalSpending?.toString()).toBe('0');
    expect(bucket?.status).toBe('provisional');
  });

  it('does not let a leg on a non-participating account conjure a bucket', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
          account(C, 'Closed in August', [], { closedOn: '2026-08-15', currency: 'USD' }),
        ],
        income: [income({ cashPositionId: C, currency: USD, netAmount: new Decimal('400') })],
      }),
    );
    expect(computed(result).buckets.map((b) => b.currency)).toEqual(['EUR']);
    expect(eur(result)?.totals.externalInflows.toString()).toBe('0');
  });
});

describe('Q — a first balance dated after the candidate', () => {
  it('stays the exclusion of the month even at an earlier date', () => {
    // 30.13 item 8. The account existed before September and has no history
    // before it; its first valuation is the 8th. At a candidate of the 6th it
    // is still the month's `first_balance` exclusion, not an account whose
    // balance is missing there.
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
          account(B, 'Newly tracked', [snap(B, '2026-09-08', '5000')]),
        ],
      }),
    );
    expect(result.asOf).toBe('2026-09-06');
    const excluded = eur(result)?.accounts.find((a) => a.positionId === B);
    expect(excluded?.excludedFirstBalance).toBe(true);
    expect(excluded?.snapshotRequired).toBe(false);
    expect(result.status).toBe('provisional');
  });

  it('does not make a pre-existing account with no evidence at all a first balance', () => {
    // No history before September and none in it either: there is nothing to
    // exclude, and the account simply has no opening, which is a different
    // problem with a different answer.
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
          account(B, 'No evidence', []),
        ],
      }),
    );
    expect(result.asOf).toBeNull();
    expect(result.asOf === null ? result.reason : undefined).toBe('mtd_no_common_date');
  });
});

describe('R — the no-date result carries nothing else', () => {
  it('has no buckets, no totals and no other issue', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1300')]),
          account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-07', '500')]),
        ],
        // Would be an unexplained inflow if anything computed it, and a null-leg
        // flow with no support if anything looked. 30.13 item 13: neither is
        // evaluated, because both need an interval that does not exist.
        income: [income({ cashPositionId: null, currency: USD, netAmount: new Decimal('9') })],
      }),
    );
    expect(result.issues.map((i) => i.key)).toEqual(['mtd_no_common_date']);
    expect(Object.keys(result).sort()).toEqual(['asOf', 'issues', 'month', 'reason', 'status']);
  });
});

describe('S — which accounts count as having newer balances', () => {
  it('counts only accounts that owed a snapshot at the date', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          // Snapshot-required, with newer evidence: counts.
          account(A, 'BBVA', [
            opening(A, '1000'),
            snap(A, '2026-09-06', '900'),
            snap(A, '2026-09-08', '850'),
          ]),
          account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-06', '500')]),
          // Excluded as first_balance, with newer evidence: could not move D.
          account('excluded', 'Newly tracked', [
            snap('excluded', '2026-09-06', '10'),
            snap('excluded', '2026-09-09', '20'),
          ]),
          // Dormant, so never owed a snapshot at D.
          account('dormant', 'Dormant', [
            valuation('dormant', '2026-01-01', '0'),
            snap('dormant', '2026-09-09', '0'),
          ], { isDormant: true }),
          // Opened after D: was not part of the interval at all.
          account('later', 'Opened later', [snap('later', '2026-09-09', '40')], {
            openedOn: '2026-09-08',
          }),
        ],
      }),
    );

    expect(result.asOf).toBe('2026-09-06');
    expect(computed(result).accountsWithNewerBalances).toEqual([A]);
  });
});

describe('the current month only', () => {
  it('reconciles the month that contains today, and takes no other', () => {
    const result = reconcileMonthToDate(
      input({
        today: plainDate('2026-09-30'),
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-30', '900')]),
        ],
      }),
    );
    // 8.6: the current month stays provisional through its entire last day.
    expect(result.month).toBe('2026-09-01');
    expect(result.asOf).toBe('2026-09-30');
    expect(result.status).toBe('provisional');
  });

  it('ignores a flow dated in a different month', () => {
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: [
            account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
          ],
          income: [
            income({ receivedOn: plainDate('2026-08-31'), netAmount: new Decimal('900') }),
          ],
        }),
      ),
    );
    expect(bucket?.totals.externalInflows.toString()).toBe('0');
  });

  it('never emits a completed-month status or issue', () => {
    const result = reconcileMonthToDate(
      input({
        cashAccounts: [
          account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '900')]),
          account(B, 'Savings', [opening(B, '500'), snap(B, '2026-09-06', '500')]),
        ],
      }),
    );
    expect(['provisional', 'unresolved', 'unavailable']).toContain(result.status);
    const keys = computed(result).buckets.flatMap((b) => b.issues.map((i) => i.key));
    expect(keys).not.toContain('missing_month_end');
    expect(keys).not.toContain('suggested_income_missing');
    expect(keys).not.toContain('possible_missing_interest');
  });

  it('keeps untracked spending beside the identity, as a completed month does', () => {
    const bucket = eur(
      reconcileMonthToDate(
        input({
          cashAccounts: [
            account(A, 'BBVA', [opening(A, '1000'), snap(A, '2026-09-06', '1000')]),
          ],
          expenses: [
            expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
            expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('80') }),
          ],
        }),
      ),
    );
    expect(bucket?.additionalSpending.toString()).toBe('50');
    expect(bucket?.thirdPartyPaid.toString()).toBe('80');
    expect(bucket?.totals.knownTrackedExpenses.toString()).toBe('0');
  });
});
