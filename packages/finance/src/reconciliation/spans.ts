import { Decimal } from '../decimal';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import { currencyCode, type CurrencyCode } from '../money/types';
import { monthEndBalance } from '../positions/cash-state';
import type { RoleLeg } from '../flows/roles';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../flows/types';
import { legsInRange, legsInScope, roleSums, scopeAccountIds, sumAmounts } from './scope';
import type { BucketTotals, CashAccountInput } from './types';

/**
 * Multi-month reconciliation spans (blueprint 8.7, v2.1.11 30.14).
 *
 * When a month-end balance is missing, that month cannot be reconciled — but
 * the next complete month end still can be reached from the previous one, and
 * the residual over that whole stretch is a real, exact figure. A span reports
 * it once, for the interval, and never splits it across the months inside.
 *
 * Everything rests on one property: **a complete month end is intrinsic**. It
 * depends on the date, the currency and the rows, never on which other endpoint
 * it is being paired with. That is what lets the anchors form a fixed ordered
 * set before any candidate is considered, which in turn is what makes "maximal
 * — the longest gap between consecutive complete month ends" mean something and
 * makes discovery independent of the order anything arrives in.
 *
 * Three consequences worth stating, because each removes a state a reader might
 * expect (30.14):
 *
 *  - **There is no span-level `first_balance`.** A complete opening anchor means
 *    every account that existed then already had a value; an account whose
 *    history begins later opened *inside* the interval and opens at zero. So the
 *    exclusion cannot arise, and neither can the `estimated` status 8.4 defines
 *    from it.
 *  - **A span carries no issues and no per-month figure.** `missing_month_end`
 *    and the rest belong to the constituent months, which keep their own
 *    `unavailable` status; and 8.7 presents an interval total with a month
 *    count, never an average.
 *  - **A flow the engine cannot attribute suppresses the span.** Spans bridge
 *    missing balance evidence; they do not repair a source-model defect.
 */

/** 8.7: a span is `reliable` or `unresolved`, and nothing else can be one. */
export type SpanStatus = 'reliable' | 'unresolved';

export interface SpanAccountState {
  readonly positionId: string;
  readonly name: string;
  /**
   * How the interval's opening value is known.
   *
   * No `closed_zero`: an account that had already closed at `end(M0)` closed on
   * or before the day before `start(M0+1)`, so it does not participate in the
   * interval at all and is not listed here.
   */
  readonly openingState: 'month_end' | 'opened_zero' | 'dormant_zero';
  readonly opening: Decimal;
  /** How the interval's closing value is known. */
  readonly closingState: 'month_end' | 'closed_zero' | 'dormant_zero';
  readonly closing: Decimal;
}

/**
 * One bucket's reconciliation over a multi-month interval.
 *
 * Deliberately smaller than a month's result: no `issues`, no per-account
 * residual, no per-month figure, no `unavailable` branch and no `estimated`
 * status. Each of those absences is a rule, not an omission (30.14).
 *
 * It is also smaller than the engine first made it. 8.7 enumerates what a span
 * reports, and `untracked_self` and `third_party` spending are not in that list.
 * They are real figures — a month's bucket states both — but they belong to a
 * month, and beside a span's identity they are a trap: neither is part of
 * `trackedTotalSpending`, so a reader who adds them to it gets a number that
 * means nothing. `accounts` and `explanation` stay because they introduce no
 * quantity of their own: the first is how `totals.cashDelta` was reached, the
 * second is that derivation in words.
 */
export interface SpanResult {
  readonly currency: CurrencyCode;
  /** First day of the month after the opening anchor. */
  readonly from: PlainDate;
  /** Last day of the closing anchor's month. */
  readonly to: PlainDate;
  /** The months the interval covers, in order. */
  readonly months: readonly MonthKey[];
  readonly accounts: readonly SpanAccountState[];
  /**
   * The four role sums plus `cashDelta`, all exact. Unlike a month's totals
   * these are never absent: a `SpanResult` exists only when the complete
   * included-account change is known.
   */
  readonly totals: Required<Pick<
    BucketTotals,
    'externalInflows' | 'nonIncomeInflows' | 'nonExpenseOutflows' | 'knownTrackedExpenses' | 'cashDelta'
  >>;
  readonly trackedTotalSpending: Decimal;
  readonly unclassified: Decimal;
  readonly status: SpanStatus;
  /**
   * How the figures above were reached, in words. Carries no quantity the
   * fields above do not already state.
   */
  readonly explanation: readonly string[];
}

export interface SpanInput {
  /** Injected; no engine reads a clock (7.7). Bounds discovery to finished months. */
  readonly today: PlainDate;
  readonly cashAccounts: readonly CashAccountInput[];
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
  /** As on the other engines: legs from records a later phase owns (7.4). */
  readonly preClassifiedLegs?: readonly RoleLeg[] | undefined;
  /**
   * The earliest month the caller wants **returned**. It is not permission to
   * forget earlier evidence.
   *
   * Discovery ignores it entirely: the anchor set is intrinsic (8.7), so it is
   * built over the whole history and `from` filters the result afterwards. A
   * span is returned when its interval overlaps `[start(from), end(M_last)]`,
   * and it is returned **whole** — the opening anchor of a span covering the
   * window's first month may lie years earlier, and clipping the interval back
   * to `from` would report endpoints that are not complete month ends and a
   * `cashDelta` measured over a change nobody observed.
   *
   * Absent means every span the evidence supports.
   */
  readonly from?: MonthKey | undefined;
}

/**
 * What discovery alone can decide: which intervals exist, and over what.
 *
 * Separated from `SpanInput` because anchors depend only on positions and their
 * valuations. A caller that reads from a database can settle the intervals
 * first and then load exactly the flows they need (23.2), instead of guessing a
 * history depth and hoping it reached far enough back.
 */
export interface SpanDiscoveryInput {
  readonly today: PlainDate;
  readonly cashAccounts: readonly CashAccountInput[];
  readonly from?: MonthKey | undefined;
}

/** One discovered interval, before any flow has been looked at. */
export interface SpanInterval {
  readonly currency: CurrencyCode;
  /** The complete month end the interval opens from: `end(M0)`. */
  readonly openingAnchor: MonthKey;
  /** The complete month end it closes on: `end(M1)`. */
  readonly closingAnchor: MonthKey;
  /** First day of the month after the opening anchor. */
  readonly from: PlainDate;
  /** Last day of the closing anchor's month. */
  readonly to: PlainDate;
  readonly months: readonly MonthKey[];
}

/** The value an account is known to have at a month end, or nothing (8.7). */
type AnchorValue =
  | { readonly state: 'month_end' | 'closed_zero' | 'dormant_zero'; readonly amount: Decimal }
  | undefined;

/**
 * What `account` was worth at `end(M)`, when that is known (8.7, 30.14 item 1).
 *
 * The states are 8.1's, not a set invented here: a statement month-end balance,
 * zero because the account had closed, or zero because it is dormant. A
 * `carried` or `missing` end is not a value, and an ordinary snapshot dated the
 * last day is not a month-end balance (8.8).
 */
function valueAtMonthEnd(account: CashAccountInput, month: MonthKey): AnchorValue {
  const end = endOfMonthKey(month);
  const { closedOn, isDormant } = account.position;

  const balance = monthEndBalance(account.valuations, month);
  if (balance !== undefined) return { state: 'month_end', amount: balance.amount };
  if (closedOn !== null && closedOn <= end) return { state: 'closed_zero', amount: new Decimal(0) };
  if (isDormant === true) return { state: 'dormant_zero', amount: new Decimal(0) };
  return undefined;
}

/** `true` when the account already existed at `end(M)` and so owes a value there. */
function existedAt(account: CashAccountInput, month: MonthKey): boolean {
  const openedOn = account.position.openedOn;
  return openedOn === null || openedOn <= endOfMonthKey(month);
}

/**
 * Is `end(M)` a complete anchor for this currency (8.7)?
 *
 * A property of the date, the currency and the rows — never of a candidate
 * pair. An account not yet opened owes nothing here, which is why a month end
 * before the user's first account of that currency is complete: vacuously, and
 * deliberately, since that is what lets an account opened later start a span at
 * exactly zero (30.14 item 3).
 */
function isCompleteAnchor(accounts: readonly CashAccountInput[], month: MonthKey): boolean {
  return accounts
    .filter((account) => existedAt(account, month))
    .every((account) => valueAtMonthEnd(account, month) !== undefined);
}

/** 8.1's participation predicate over the interval rather than over one month. */
function participatesInInterval(
  account: CashAccountInput,
  from: PlainDate,
  to: PlainDate,
): boolean {
  const { openedOn, closedOn } = account.position;
  return (openedOn === null || openedOn <= to) && (closedOn === null || closedOn >= from);
}

/** The months of an interval, in order. */
function monthsBetween(first: MonthKey, last: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let m = first; m <= last; m = monthKey(addMonths(startOfMonthKey(m), 1))) {
    months.push(m);
  }
  return months;
}

/**
 * The month end discovery starts scanning from.
 *
 * One month before the earliest evidence of any kind, and deliberately one
 * month rather than none: the month end immediately before the user's first
 * account is **vacuously complete** — nothing existed then to owe a value — and
 * it is the anchor that lets an account opened later open a span at exactly
 * zero (30.14 item 3). Starting at the first evidence month instead would throw
 * that anchor away, and with it every span covering the beginning of a history,
 * however complete the balances after it.
 *
 * Starting earlier still would change nothing, which is what makes this the
 * whole of the rule rather than an arbitrary depth: vacuous month ends run
 * consecutively, and consecutive anchors one month apart never form a span
 * (`M1 ≥ M0 + 2`). Only the last vacuous end before the first account can pair
 * with anything.
 */
function discoveryStart(accounts: readonly CashAccountInput[]): MonthKey | undefined {
  const dates: PlainDate[] = [];
  for (const account of accounts) {
    for (const valuation of account.valuations) dates.push(valuation.valuedOn);
    const openedOn = account.position.openedOn;
    if (openedOn !== null) dates.push(openedOn);
  }
  if (dates.length === 0) return undefined;
  const earliest = monthKey(dates.reduce((first, on) => (on < first ? on : first)));
  return monthKey(addMonths(startOfMonthKey(earliest), -1));
}

/**
 * The opening and closing states of one account over the interval (8.7).
 *
 * `undefined` means the account cannot be included, which for a participating
 * account can only happen through the closing side: a complete opening anchor
 * already guarantees a value for everything that existed then.
 */
/**
 * Why the two `undefined` returns below cannot be reached from `findSpans`.
 *
 * A participating account either opened inside the interval — in which case it
 * opens at zero and owes the opening anchor nothing — or opened on or before
 * `end(M0)`, in which case it existed at a **complete** anchor and therefore has
 * a value there. The same argument runs at the closing end: the account is
 * alive at `end(M1)` unless it closed inside, and the closing anchor is complete
 * too. The guards stay because the function is total on its own terms, and
 * because they are what would catch a later phase changing what "complete"
 * means.
 */
function accountOverInterval(
  account: CashAccountInput,
  openingAnchor: MonthKey,
  closingAnchor: MonthKey,
  from: PlainDate,
  to: PlainDate,
): SpanAccountState | undefined {
  const { openedOn, closedOn } = account.position;

  const opening: AnchorValue | { state: 'opened_zero'; amount: Decimal } =
    openedOn !== null && openedOn >= from
      ? // It did not exist at the opening anchor, so it opened at zero and owed
        // that anchor nothing (30.14 item 3).
        { state: 'opened_zero', amount: new Decimal(0) }
      : valueAtMonthEnd(account, openingAnchor);
  /* v8 ignore start -- unreachable from a complete anchor; see above. */
  if (opening === undefined) return undefined;
  /* v8 ignore stop */
  // A participating account has not closed on or before `end(M0)`: participation
  // requires `closedOn >= start(M0+1)`, which is the day after. So the opening
  // state is never `closed_zero`, and the type says so.
  /* v8 ignore start -- ruled out by participation; see above. */
  if (opening.state === 'closed_zero') return undefined;
  /* v8 ignore stop */

  const closing: { state: SpanAccountState['closingState']; amount: Decimal } | undefined =
    closedOn !== null && closedOn <= to
      ? { state: 'closed_zero', amount: new Decimal(0) }
      : valueAtMonthEnd(account, closingAnchor);
  /* v8 ignore start -- unreachable from a complete anchor; see above. */
  if (closing === undefined) return undefined;
  /* v8 ignore stop */

  return {
    positionId: account.position.id,
    name: account.position.name,
    openingState: opening.state,
    opening: opening.amount,
    closingState: closing.state,
    closing: closing.amount,
  };
}

/**
 * Is every null leg of this currency in the interval supported (8.1, 30.14 item 9)?
 *
 * The support condition is a **month** predicate and stays one: a cash account
 * of that currency must participate in the month the flow is dated in. An
 * account opened two months later does not retroactively support it, and the
 * leg is never assigned to an account to make it supported.
 */
function everyNullLegSupported(
  accounts: readonly CashAccountInput[],
  legs: readonly RoleLeg[],
  currency: CurrencyCode,
): boolean {
  return legs
    .filter((leg) => leg.currency === currency && leg.cashPositionId === null)
    .every((leg) => {
      const month = monthKey(leg.on);
      const start = startOfMonthKey(month);
      const end = endOfMonthKey(month);
      return accounts.some((account) => {
        const { openedOn, closedOn } = account.position;
        return (openedOn === null || openedOn <= end) && (closedOn === null || closedOn >= start);
      });
    });
}

function reconcileCandidate(
  input: SpanInput,
  interval: SpanInterval,
  accounts: readonly CashAccountInput[],
): SpanResult | undefined {
  const { currency, openingAnchor, closingAnchor, from, to, months } = interval;

  const participating = accounts.filter((account) =>
    participatesInInterval(account, from, to),
  );

  const states: SpanAccountState[] = [];
  for (const account of [...participating].sort((a, b) =>
    a.position.id.localeCompare(b.position.id),
  )) {
    const state = accountOverInterval(account, openingAnchor, closingAnchor, from, to);
    /* v8 ignore next -- see `accountOverInterval`: a complete anchor leaves no
       participating account without an endpoint. */
    if (state === undefined) return undefined;
    states.push(state);
  }

  // 30.14 item 3: an empty anchor is fine, an empty interval is not. Also
  // unreachable in practice, and for the same family of reasons: the account
  // whose missing evidence opened the gap participates across it, so a
  // candidate always has someone to reconcile.
  /* v8 ignore start -- unreachable while a candidate exists; see above. */
  if (states.length === 0) return undefined;
  /* v8 ignore stop */

  const legs = legsInRange(input, from, to);
  // 30.14 item 10: a flow the engine cannot attribute is a source defect the
  // span does not exist to repair.
  //
  // The rule is kept because 8.7 states it, but a valid candidate cannot reach
  // it: every interior month end is incomplete — otherwise it would be an
  // anchor and the pair would not be consecutive — and an end is incomplete
  // only because some account existed then without a value there. That account
  // is open across the month, so the month has a participating account and its
  // null legs are supported. An account that closed earlier makes the end
  // `closed_zero`; one that opened later owes it nothing. The guard therefore
  // stands as a statement of the rule, and as the thing that would catch a
  // later phase changing what participation means.
  /* v8 ignore start -- unreachable for a candidate span; see above. */
  if (!everyNullLegSupported(accounts, legs, currency)) return undefined;
  /* v8 ignore stop */

  const scopeLegs = legsInScope(
    legs,
    currency,
    // No span-level exclusion exists, so every included account is in scope.
    scopeAccountIds(states.map((s) => ({ positionId: s.positionId, excludedFirstBalance: false }))),
  );
  const sums = roleSums(scopeLegs);

  const cashDelta = sumAmounts(states.map((state) => state.closing.minus(state.opening)));
  const trackedTotalSpending = sums.externalInflows
    .plus(sums.nonIncomeInflows)
    .minus(sums.nonExpenseOutflows)
    .minus(cashDelta);
  const unclassified = trackedTotalSpending.minus(sums.knownTrackedExpenses);

  return {
    currency,
    from,
    to,
    months,
    accounts: states,
    totals: { ...sums, cashDelta },
    trackedTotalSpending,
    unclassified,
    // Compared against zero explicitly: decimal.js reads the sign bit, so a
    // negative zero would be "negative" and a month that reconciles exactly
    // would be called unresolved.
    status: unclassified.lessThan(0) ? 'unresolved' : 'reliable',
    explanation: [
      `Combined ${currency} reconciliation ${from} – ${to} (${String(months.length)} months).`,
      `Cash change = ${cashDelta.toString()} across ${String(states.length)} account(s).`,
      `Tracked total spending = ${sums.externalInflows.toString()} in + ${sums.nonIncomeInflows.toString()} moved in − ${sums.nonExpenseOutflows.toString()} moved out − ${cashDelta.toString()} change = ${trackedTotalSpending.toString()}.`,
      `Unclassified = ${trackedTotalSpending.toString()} − ${sums.knownTrackedExpenses.toString()} known = ${unclassified.toString()}.`,
    ],
  };
}

/** The cash accounts of one currency, in the order discovery considers them. */
function bucketAccounts(
  cash: readonly CashAccountInput[],
  currency: CurrencyCode,
): CashAccountInput[] {
  return cash.filter((account) => account.position.currency === currency);
}

/**
 * Every interval the balance evidence supports, per native currency (8.7).
 *
 * Discovery is per bucket and shares nothing across currencies: two currencies
 * may have entirely different anchors over the same calendar history, and no
 * rate is consulted for any of it. It reads positions and valuations only — no
 * flow can create, move or destroy an anchor — which is what lets a caller
 * settle the intervals before deciding how far back to read flows.
 *
 * A requested window narrows the **result** and never the search. The anchor
 * set is intrinsic, so it is built over the whole history; a span then survives
 * if it overlaps the window, and survives whole.
 */
export function findSpanIntervals(input: SpanDiscoveryInput): SpanInterval[] {
  const cash = input.cashAccounts.filter((account) => account.position.kind === 'cash');
  const start = discoveryStart(cash);
  if (start === undefined) return [];

  // 30.14 item 4: both anchors are completed month ends. The current month is
  // 8.6's, and a span never reaches into it. No guard is needed for a history
  // that has not reached one yet: `monthsBetween` of an inverted range is
  // empty, so there are no anchors and therefore no pairs.
  const lastCompleted = monthKey(addMonths(startOfMonthKey(monthKey(input.today)), -1));

  const windowStart = input.from === undefined ? undefined : startOfMonthKey(input.from);
  const currencies = [...new Set(cash.map((account) => account.position.currency))].sort();
  const intervals: SpanInterval[] = [];

  for (const code of currencies) {
    const currency = currencyCode(code);
    const accounts = bucketAccounts(cash, currency);

    // The fixed, intrinsic anchor set. Built once, over the whole history and
    // before any pair is considered, so neither a candidate nor a caller's
    // window can change what it contains.
    const anchors = monthsBetween(start, lastCompleted).filter((month) =>
      isCompleteAnchor(accounts, month),
    );

    // Consecutive members only. `E_C` is evidence topology, not a search space
    // to widen when a candidate turns out to be suppressed (30.14 item 10).
    for (let index = 0; index + 1 < anchors.length; index += 1) {
      const openingAnchor = anchors[index] as MonthKey;
      const closingAnchor = anchors[index + 1] as MonthKey;
      if (monthsBetween(openingAnchor, closingAnchor).length < 3) continue;

      const first = monthKey(addMonths(startOfMonthKey(openingAnchor), 1));
      const to = endOfMonthKey(closingAnchor);

      // Overlap, not containment, and never a clip. A span that reaches into
      // the window is the answer to "what happened from `from` onwards", even
      // when most of it happened earlier; one that ended before the window
      // began answers a question nobody asked. The other side needs no test:
      // every interval ends at or before `end(M_last)`, and so does the window.
      if (windowStart !== undefined && to < windowStart) continue;

      intervals.push({
        currency,
        openingAnchor,
        closingAnchor,
        from: startOfMonthKey(first),
        to,
        months: monthsBetween(first, closingAnchor),
      });
    }
  }

  return intervals;
}

/**
 * Every span the evidence supports, per native currency (8.7).
 *
 * Discovery first, then one reconciliation per interval — the same order a
 * database-backed caller follows, so both see the same intervals.
 */
export function findSpans(input: SpanInput): SpanResult[] {
  const cash = input.cashAccounts.filter((account) => account.position.kind === 'cash');
  const spans: SpanResult[] = [];

  for (const interval of findSpanIntervals(input)) {
    const span = reconcileCandidate(input, interval, bucketAccounts(cash, interval.currency));
    /* v8 ignore next -- the suppression paths inside `reconcileCandidate` are
       unreachable while a candidate exists; see the notes there. */
    if (span !== undefined) spans.push(span);
  }

  return spans;
}
