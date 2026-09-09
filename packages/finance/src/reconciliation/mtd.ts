import { Decimal } from '../decimal';
import {
  addDays,
  endOfMonthKey,
  monthKey,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import { currencyCode, type CurrencyCode } from '../money/types';
import { cashCloseState, type CashOpenState } from '../positions/cash-state';
import { valuationOn } from '../positions/valuation';
import type { RoleLeg } from '../flows/roles';
import { legsInRange, legsInScope, roleSums, scopeAccountIds, sumAmounts } from './scope';
import {
  ISSUE_CLASS,
  worstStatus,
  type BucketTotals,
  type CashAccountInput,
  type Issue,
  type IssueKey,
  type ReconciliationStatus,
} from './types';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../flows/types';

/**
 * Month-to-date reconciliation for the current month (blueprint 8.6, v2.1.10 30.13).
 *
 * The completed-month engine reconciles a finished month between two statement
 * balances. This one reconciles an unfinished month between its opening and a
 * **common as-of date `D`** — the latest day everyone's evidence reaches — and
 * says `provisional` about the answer, because the month is not over.
 *
 * Three things make it a different engine rather than the same one with a
 * different upper bound:
 *
 *  - **`D` has to be found**, and it is one date for the whole result. 30.13
 *    item 3: an account with weaker evidence moves `D` back for every currency,
 *    so "month-to-date through 6 Sep" is true of the whole view rather than of
 *    one bucket.
 *  - **Without `D` there is no interval at all**, so there are no totals — not
 *    zeros, and not sums over some other cut-off (30.13 item 5). That is why the
 *    result is two shapes rather than one with optional fields.
 *  - **The closing evidence is an ordinary snapshot**, not a statement balance.
 *    A month-end balance cannot exist inside the current month (M5), and a
 *    carried value is not evidence of anything at `D`.
 *
 * What it shares with the completed engine is the membership rule of 8.1 —
 * `./scope` — because 8.1 states it about an interval, not about a kind of
 * month. Endpoint evidence, status and issues are this engine's own.
 */

/** 8.6's opening for the current month. Not a `CashCloseState`: `D` is not a month end. */
export type MtdValueState =
  /** An exact snapshot dated `D`. */
  | 'snapshot'
  /** `closed_on ≤ D`: worth zero by definition. */
  | 'closed_zero'
  /** Dormant and carried at zero (R22). */
  | 'dormant_zero'
  /** No evidence at `D`. Never part of the arithmetic. */
  | 'absent';

export interface MtdAccountState {
  readonly positionId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly opening: {
    readonly state: CashOpenState;
    readonly amount?: Decimal;
    readonly valuedOn?: PlainDate;
  };
  /** The account's value at `D`, and how it is known. */
  readonly atAsOf: { readonly state: MtdValueState; readonly amount?: Decimal };
  /** In the bucket's arithmetic: participating, not excluded, opening usable. */
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
  /** 8.6: it needed an exact snapshot at `D` to be believed. */
  readonly snapshotRequired: boolean;
  /** 30.13 item 11: exact evidence after `D` that could not move it. */
  readonly newerBalanceOn?: PlainDate;
}

export interface MtdBucketResult {
  readonly currency: CurrencyCode;
  /** 8.6: only `provisional`, `unresolved` or `unavailable`. */
  readonly status: ReconciliationStatus;
  readonly accounts: readonly MtdAccountState[];
  /**
   * Role sums exact over `[start(M), D]` and 8.1's scope; the balance-derived
   * three present together or absent together (30.12). No residuals: 8.6
   * specifies none for the current month (30.13 item 10).
   */
  readonly totals: BucketTotals;
  readonly additionalSpending: Decimal;
  readonly thirdPartyPaid: Decimal;
  readonly issues: readonly Issue[];
  /** Why this bucket could not be reconciled through `D`. */
  readonly reason?: 'missing_opening';
  readonly explanation: readonly string[];
}

/**
 * The current month's answer, in the only two shapes it has (8.9, 30.13 item 5).
 *
 * Without `D` there is nothing to report but the reason, and the type says so
 * rather than offering fields a caller would have to fill with zeros.
 */
export type MonthToDateResult =
  | {
      readonly month: MonthKey;
      readonly asOf: null;
      readonly status: 'unavailable';
      readonly reason: 'mtd_no_common_date';
      readonly issues: readonly Issue[];
    }
  | {
      readonly month: MonthKey;
      readonly asOf: PlainDate;
      readonly status: ReconciliationStatus;
      readonly buckets: readonly MtdBucketResult[];
      /** 30.13 item 11, and 8.9's field of the same name. */
      readonly accountsWithNewerBalances: readonly string[];
      readonly issues: readonly Issue[];
    };

export interface MonthToDateInput {
  /** Injected; no engine reads a clock (7.7). The month is the one containing it. */
  readonly today: PlainDate;
  readonly cashAccounts: readonly CashAccountInput[];
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
  /** As on the completed engine: legs from records a later phase owns (7.4). */
  readonly preClassifiedLegs?: readonly RoleLeg[] | undefined;
}

function issue(key: IssueKey, rest: Omit<Issue, 'key' | 'class'> = {}): Issue {
  return { key, class: ISSUE_CLASS[key], ...rest };
}

/** 8.1's bucket predicate, over the interval `[start(M), d]` (30.13 item 8). */
function participatesThrough(account: CashAccountInput, monthStart: PlainDate, d: PlainDate): boolean {
  const { openedOn, closedOn } = account.position;
  return (openedOn === null || openedOn <= d) && (closedOn === null || closedOn >= monthStart);
}

/**
 * 8.6's opening, and 30.13 item 8's rule that `first_balance` is decided once.
 *
 * Phase 2's `cashOpenState` cannot answer this for the current month: its
 * `first_balance` test looks for a month-end balance at `end(M)`, which M5
 * forbids writing before the month is over. 8.6 states the current-month rule
 * directly — "a pre-existing account whose first valuation falls in M" — so
 * that case is decided here, from the evidence available through today, and
 * every other case defers to Phase 2's `close(a, M−1)` unchanged.
 */
function openingOf(
  account: CashAccountInput,
  month: MonthKey,
  today: PlainDate,
): { state: CashOpenState; amount?: Decimal; valuedOn?: PlainDate } {
  const start = startOfMonthKey(month);
  const { openedOn } = account.position;
  if (openedOn !== null && openedOn >= start && openedOn <= endOfMonthKey(month)) {
    return { state: 'opened_zero', amount: new Decimal(0) };
  }

  const hasEarlier = account.valuations.some((v) => v.valuedOn < start);
  const hasInMonth = account.valuations.some((v) => v.valuedOn >= start && v.valuedOn <= today);
  if (!hasEarlier && hasInMonth) return { state: 'first_balance' };

  // Everything else is the previous month's close, read with Phase 2's own
  // state machine so dormancy, closure and month-end evidence mean here exactly
  // what they mean everywhere else.
  const previous = monthKey(addDays(start, -1));
  const state = cashCloseState(account.position, account.valuations, previous);
  if (state === 'month_end') {
    const balance = account.valuations.find((v) => v.valuedOn === endOfMonthKey(previous));
    /* v8 ignore next -- `month_end` is precisely the state in which that row exists. */
    if (balance === undefined) return { state };
    return { state, amount: balance.amount, valuedOn: balance.valuedOn };
  }
  if (state === 'closed_zero' || state === 'dormant_zero') {
    return { state, amount: new Decimal(0) };
  }
  return { state };
}

const SETTLED_OPENINGS: readonly string[] = [
  'month_end',
  'opened_zero',
  'closed_zero',
  'dormant_zero',
];

/** What an account is worth at `d`, when that is known without a snapshot (8.6). */
function structuralValueAt(
  account: CashAccountInput,
  d: PlainDate,
): 'closed_zero' | 'dormant_zero' | undefined {
  const { closedOn, isDormant } = account.position;
  if (closedOn !== null && closedOn <= d) return 'closed_zero';
  if (isDormant === true) return 'dormant_zero';
  return undefined;
}

interface Candidate {
  readonly included: readonly CashAccountInput[];
  readonly snapshotRequired: readonly CashAccountInput[];
}

/**
 * The accounts of a candidate date, and which of them owe a snapshot.
 *
 * `included` here is 8.6's sense: participating through `d` and not excluded as
 * `first_balance`. Whether the opening is usable is a separate question, asked
 * per bucket once `D` is fixed — `D` is about evidence at the *end* of the
 * interval, and letting a missing opening move it would make one currency's gap
 * change every other currency's date.
 */
function candidateAt(
  accounts: readonly CashAccountInput[],
  month: MonthKey,
  d: PlainDate,
  excluded: ReadonlySet<string>,
): Candidate {
  const start = startOfMonthKey(month);
  const included = accounts.filter(
    (a) => participatesThrough(a, start, d) && !excluded.has(a.position.id),
  );
  return {
    included,
    snapshotRequired: included.filter((a) => structuralValueAt(a, d) === undefined),
  };
}

/**
 * 8.6's common as-of date, searched backwards from today (30.13 items 3, 6, 7).
 *
 * Deliberately a scan over at most 31 days rather than an intersection of
 * valuation dates: the account set itself changes with the candidate, because
 * accounts open and close inside the month, so there is no single fixed set to
 * intersect. Boring and bounded beats clever and wrong.
 *
 * A candidate qualifies when its included set is **non-empty** and every
 * snapshot-required account in it has a valuation dated exactly that day. The
 * non-empty test is item 6: a date with no included account satisfies the
 * snapshot predicate vacuously, and would otherwise produce a month-to-date of
 * zero out of nothing.
 */
function findAsOf(
  accounts: readonly CashAccountInput[],
  month: MonthKey,
  today: PlainDate,
  excluded: ReadonlySet<string>,
): PlainDate | undefined {
  const start = startOfMonthKey(month);
  for (let d = today; d >= start; d = addDays(d, -1)) {
    const { included, snapshotRequired } = candidateAt(accounts, month, d, excluded);
    if (included.length === 0) continue;
    const everyone = snapshotRequired.every(
      (a) => valuationOn(a.valuations, d) !== undefined,
    );
    if (everyone) return d;
  }
  return undefined;
}

function bucketOf(
  input: MonthToDateInput,
  month: MonthKey,
  asOf: PlainDate,
  currency: CurrencyCode,
  accounts: readonly CashAccountInput[],
  excluded: ReadonlySet<string>,
  legs: readonly RoleLeg[],
): MtdBucketResult {
  const start = startOfMonthKey(month);
  const inMonth = (on: PlainDate): boolean => on >= start && on <= asOf;

  // 7.4: neither ever enters the identity, and neither needs a balance.
  const settlementTotal = (settlement: ExpenseFlow['settlement']): Decimal =>
    sumAmounts(
      input.expenses
        .filter((e) => e.currency === currency && e.settlement === settlement && inMonth(e.incurredOn))
        .map((e) => e.amount),
    );
  const additionalSpending = settlementTotal('untracked_self');
  const thirdPartyPaid = settlementTotal('third_party');

  const states: MtdAccountState[] = [...accounts]
    .sort((a, b) => a.position.id.localeCompare(b.position.id))
    .map((account) => {
      const id = account.position.id;
      const opening = openingOf(account, month, input.today);
      const isExcluded = excluded.has(id);
      const structural = structuralValueAt(account, asOf);
      const snapshot = valuationOn(account.valuations, asOf);
      // Every account here participates through `D` — one opened later is not
      // in the interval at all (30.13 item 8) and never reaches this bucket.
      const snapshotRequired = !isExcluded && structural === undefined;

      const atAsOf: MtdAccountState['atAsOf'] =
        structural !== undefined
          ? { state: structural, amount: new Decimal(0) }
          : snapshot === undefined
            ? { state: 'absent' }
            : { state: 'snapshot', amount: snapshot.amount };

      const included =
        !isExcluded && SETTLED_OPENINGS.includes(opening.state) && atAsOf.amount !== undefined;

      const newer = account.valuations
        .filter((v) => v.valuedOn > asOf && v.valuedOn <= input.today)
        .sort((a, b) => (a.valuedOn < b.valuedOn ? 1 : -1))[0];

      return {
        positionId: id,
        name: account.position.name,
        currency,
        opening: {
          state: opening.state,
          ...(opening.amount === undefined ? {} : { amount: opening.amount }),
          ...(opening.valuedOn === undefined ? {} : { valuedOn: opening.valuedOn }),
        },
        atAsOf,
        included,
        excludedFirstBalance: isExcluded,
        dormant: account.position.isDormant === true,
        snapshotRequired,
        // 30.13 item 11: only an account that owed a snapshot at `D` can have
        // had newer evidence that failed to move it.
        ...(snapshotRequired && newer !== undefined ? { newerBalanceOn: newer.valuedOn } : {}),
      };
    });

  const scopeLegs = legsInScope(legs, currency, scopeAccountIds(states));
  const sums = roleSums(scopeLegs);

  const issues: Issue[] = states
    .filter((state) => state.excludedFirstBalance)
    .map((state) => issue('first_balance', { currency, positionId: state.positionId }));

  // 8.3, applied to the MTD interval: a currency present only through a
  // null-leg flow has nothing to reconcile against.
  if (accounts.length === 0) {
    for (const leg of scopeLegs.filter((l) => l.cashPositionId === null)) {
      issues.push(issue('flow_without_cash_account', { currency, amount: leg.amount }));
    }
    return {
      currency,
      status: 'unavailable',
      accounts: states,
      totals: sums,
      additionalSpending,
      thirdPartyPaid,
      issues,
      explanation: [
        `No ${currency} cash account took part in ${month} through ${asOf}, so the ${currency} flows dated in it have nothing to reconcile against.`,
      ],
    };
  }

  // 8.6: a participating, non-excluded account whose opening is `carried` or
  // `missing` makes **this** bucket unavailable — and only this one (30.13
  // item 4).
  const unusableOpening = states.filter(
    (state) =>
      !state.excludedFirstBalance && !SETTLED_OPENINGS.includes(state.opening.state),
  );
  const included = states.filter((state) => state.included);

  if (unusableOpening.length > 0 || included.length === 0) {
    return {
      currency,
      status: 'unavailable',
      accounts: states,
      totals: sums,
      additionalSpending,
      thirdPartyPaid,
      issues,
      ...(unusableOpening.length > 0 ? { reason: 'missing_opening' as const } : {}),
      explanation:
        unusableOpening.length > 0
          ? unusableOpening.map(
              (state) =>
                `${state.name} has no usable opening balance for ${month} (${state.opening.state}), so ${currency} month-to-date spending cannot be inferred.`,
            )
          : [`No ${currency} account is reconcilable through ${asOf}.`],
    };
  }

  const cashDelta = sumAmounts(
    included.map((state) =>
      (state.atAsOf.amount as Decimal).minus(state.opening.amount as Decimal),
    ),
  );
  const trackedTotalSpending = sums.externalInflows
    .plus(sums.nonIncomeInflows)
    .minus(sums.nonExpenseOutflows)
    .minus(cashDelta);
  const unclassified = trackedTotalSpending.minus(sums.knownTrackedExpenses);

  // 8.4/30.11, unchanged for the current month: the variant is the sign of the
  // tracked total, and the amount is the magnitude of the unclassified figure.
  if (unclassified.lessThan(0)) {
    issues.push(
      issue('unexplained_inflow', {
        currency,
        amount: unclassified.abs(),
        variant: trackedTotalSpending.lessThan(0) ? 'a' : 'b',
      }),
    );
  }

  // 30.13 item 2: `provisional` describes when the evidence stops, not whether
  // it adds up, so a blocking issue outranks it.
  const status: ReconciliationStatus = issues.some((i) => i.class === 'blocking')
    ? 'unresolved'
    : 'provisional';

  return {
    currency,
    status,
    accounts: states,
    totals: { ...sums, cashDelta, trackedTotalSpending, unclassified },
    additionalSpending,
    thirdPartyPaid,
    issues,
    explanation: [
      `Month-to-date through ${asOf}.`,
      `Cash change = ${cashDelta.toString()} ${currency} across ${String(included.length)} account(s).`,
      `Tracked spending so far = ${sums.externalInflows.toString()} in + ${sums.nonIncomeInflows.toString()} moved in − ${sums.nonExpenseOutflows.toString()} moved out − ${cashDelta.toString()} change = ${trackedTotalSpending.toString()}.`,
      `Unclassified = ${trackedTotalSpending.toString()} − ${sums.knownTrackedExpenses.toString()} known = ${unclassified.toString()}.`,
    ],
  };
}

/**
 * Reconcile the current month to date.
 *
 * The month is the one containing `today` — not a parameter, because a
 * month-to-date figure for any other month is not a thing this engine can mean.
 */
export function reconcileMonthToDate(input: MonthToDateInput): MonthToDateResult {
  // The month is derived, never passed: `monthKey(today)` is by construction
  // the month containing today, so there is no guard to write and no way for a
  // caller to ask this engine about a finished or future month.
  const month = monthKey(input.today);

  const start = startOfMonthKey(month);
  const cash = input.cashAccounts.filter((a) => a.position.kind === 'cash');

  // 30.13 item 8: decided once for M, from the evidence through today, and not
  // re-decided per candidate date.
  const excluded = new Set(
    cash
      .filter((a) => openingOf(a, month, input.today).state === 'first_balance')
      .map((a) => a.position.id),
  );

  const asOf = findAsOf(cash, month, input.today, excluded);
  if (asOf === undefined) {
    return {
      month,
      asOf: null,
      status: 'unavailable',
      reason: 'mtd_no_common_date',
      issues: [issue('mtd_no_common_date')],
    };
  }

  const legs = legsInRange(input, start, asOf);

  // 8.1's enumeration over the MTD interval: currencies with a participating
  // cash position through `D`, plus those a null leg names. An explicit leg on
  // a non-participating account conjures no bucket.
  const participating = cash.filter((a) => participatesThrough(a, start, asOf));
  const currencies = new Set<string>(participating.map((a) => a.position.currency));
  for (const leg of legs) {
    if (leg.cashPositionId === null) currencies.add(leg.currency);
  }

  const buckets = [...currencies].sort().map((code) => {
    const currency = currencyCode(code);
    return bucketOf(
      input,
      month,
      asOf,
      currency,
      participating.filter((a) => a.position.currency === currency),
      excluded,
      legs,
    );
  });

  const withNewer = buckets
    .flatMap((bucket) => bucket.accounts)
    .filter((state) => state.newerBalanceOn !== undefined)
    .map((state) => state.positionId);

  const issues: Issue[] =
    withNewer.length > 0 ? [issue('mtd_newer_balances', { positionIds: withNewer })] : [];

  return {
    month,
    asOf,
    status: worstStatus(buckets.map((bucket) => bucket.status)),
    buckets,
    accountsWithNewerBalances: withNewer,
    issues,
  };
}
