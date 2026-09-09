import { Decimal } from '../decimal';
import {
  endOfMonthKey,
  isMonthCompleted,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import { currencyCode, type CurrencyCode } from '../money/types';
import {
  cashCloseState,
  cashOpenState,
  monthEndBalance,
  participatesIn,
} from '../positions/cash-state';
import { latestOnOrBefore } from '../positions/valuation';
import { expenseLeg, incomeLeg, transferLegs, type RoleLeg } from '../flows/roles';
import { missingIncomeOccurrences } from './completeness';
import { detectIssues } from './issues';
import {
  MonthNotCompletedError,
  worstStatus,
  type AccountState,
  type BucketResult,
  type BucketTotals,
  type CashAccountInput,
  type CompletedMonthInput,
  type MonthReconciliation,
  type ReconciliationStatus,
} from './types';

/**
 * Completed-month reconciliation, per native currency (blueprint 8.1–8.5).
 *
 * The identity is 8.2's, and it holds for any numbers at all:
 *
 * ```
 * ΔCash                = Σ(close − open) over included accounts
 * TrackedTotalSpending = ΣI + ΣNin − ΣNout − ΔCash
 * Unclassified         = TrackedTotalSpending − ΣK
 * ```
 *
 * The arithmetic is the easy part. What this module is really doing is
 * deciding, for each currency, whether the numbers are worth believing — and
 * refusing to produce one when they are not. Three rules carry that:
 *
 *  - **Only statement evidence closes a month.** An ordinary snapshot dated the
 *    last day is still an ordinary snapshot (8.8); `carried` and `missing` are
 *    not endpoints, and a bucket containing one is `unavailable` rather than
 *    computed against a guess.
 *  - **Unknown is never zero.** An unavailable bucket returns no
 *    `trackedTotalSpending` and no `unclassified` at all, rather than a
 *    confident 0 that a chart would draw.
 *  - **A pre-existing account first seen this month is excluded**, along with
 *    the flow legs attributed to it, and the month says `estimated` (8.1). Its
 *    earlier movements are unknown, and pretending it opened at zero would turn
 *    a whole balance into one month of spending.
 *
 * Nothing here converts anything: reconciliation is per native currency, and a
 * cross-currency transfer hits two buckets that each reconcile on their own.
 * Nothing here is stored (5.3).
 */

/** Money sums accumulate in a fixed order so the same inputs give the same string (ADR 0004 §1). */
function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

const SETTLED_STATES: readonly string[] = ['month_end', 'opened_zero', 'closed_zero', 'dormant_zero'];

/** The balance a settled endpoint carries. `opened_zero`, `closed_zero` and `dormant_zero` are zero by definition (8.1). */
function endpointAmount(
  account: CashAccountInput,
  month: MonthKey,
  end: 'open' | 'close',
): { amount: Decimal; valuedOn?: PlainDate } {
  if (end === 'close') {
    const balance = monthEndBalance(account.valuations, month);
    return balance === undefined
      ? { amount: new Decimal(0) }
      : { amount: balance.amount, valuedOn: balance.valuedOn };
  }

  // The opening is the previous month's close, so it is that month's statement
  // balance — the same row, read from the other side.
  const previousEnd = startOfMonthKey(month);
  const previous = latestOnOrBefore(account.valuations, previousEnd);
  const isPreviousMonthEnd =
    previous !== undefined &&
    previous.datePrecision === 'month_end' &&
    previous.valuedOn < previousEnd;

  return isPreviousMonthEnd
    ? { amount: previous.amount, valuedOn: previous.valuedOn }
    : { amount: new Decimal(0) };
}

/**
 * An account's month, with its endpoints kept beside it.
 *
 * `AccountState.opening.amount` is deliberately optional — an account with no
 * statement evidence has no opening balance, and 8.4 says so rather than
 * showing zero. But the arithmetic only ever runs over *included* accounts,
 * which always have both. Carrying the two amounts separately is what lets the
 * sums use them without a `?? 0` that would quietly turn an unknown endpoint
 * into a month of spending.
 */
interface AccountMonth {
  readonly state: AccountState;
  readonly openingAmount: Decimal;
  readonly closingAmount: Decimal;
}

function accountMonthOf(account: CashAccountInput, month: MonthKey): AccountMonth {
  const open = cashOpenState(account.position, account.valuations, month);
  const close = cashCloseState(account.position, account.valuations, month);
  const included = SETTLED_STATES.includes(open) && SETTLED_STATES.includes(close);

  const opening = endpointAmount(account, month, 'open');
  const closing = endpointAmount(account, month, 'close');

  return {
    state: {
      positionId: account.position.id,
      name: account.position.name,
      opening: {
        state: open,
        ...(included ? { amount: opening.amount } : {}),
        ...(opening.valuedOn === undefined ? {} : { valuedOn: opening.valuedOn }),
      },
      closing: {
        state: close,
        ...(included ? { amount: closing.amount } : {}),
        ...(closing.valuedOn === undefined ? {} : { valuedOn: closing.valuedOn }),
      },
      included,
      excludedFirstBalance: open === 'first_balance',
      dormant: account.position.isDormant === true,
    },
    openingAmount: opening.amount,
    closingAmount: closing.amount,
  };
}

/** Every leg of every flow dated in M, whatever its currency or attribution. */
function legsInMonth(input: CompletedMonthInput): RoleLeg[] {
  const from = startOfMonthKey(input.month);
  const to = endOfMonthKey(input.month);
  const within = (on: string): boolean => on >= from && on <= to;

  const legs: RoleLeg[] = [];
  for (const income of input.income) {
    if (!within(income.receivedOn)) continue;
    const leg = incomeLeg(income);
    if (leg !== undefined) legs.push(leg);
  }
  for (const expense of input.expenses) {
    if (!within(expense.incurredOn)) continue;
    const leg = expenseLeg(expense);
    if (leg !== undefined) legs.push(leg);
  }
  for (const transfer of input.transfers) {
    if (!within(transfer.occurredOn)) continue;
    legs.push(...transferLegs(transfer));
  }
  for (const leg of input.preClassifiedLegs ?? []) {
    if (within(leg.on)) legs.push(leg);
  }
  return legs;
}

/** The signed effect of a leg on the cash it touches: inflows add, outflows take away. */
function signedEffect(leg: RoleLeg): Decimal {
  return leg.role === 'I' || leg.role === 'Nin' ? leg.amount : leg.amount.negated();
}

function reconcileBucket(
  input: CompletedMonthInput,
  currency: CurrencyCode,
  accounts: readonly CashAccountInput[],
  legs: readonly RoleLeg[],
): BucketResult {
  const month = input.month;

  // 7.4: neither ever enters the identity. They are carried because 8.9 asks
  // for them and later analytics needs them, not because they are spending
  // this engine knows how to place.
  const additionalSpending = sum(
    input.expenses
      .filter(
        (expense) =>
          expense.currency === currency &&
          expense.settlement === 'untracked_self' &&
          expense.incurredOn >= startOfMonthKey(month) &&
          expense.incurredOn <= endOfMonthKey(month),
      )
      .map((expense) => expense.amount),
  );
  const thirdPartyPaid = sum(
    input.expenses
      .filter(
        (expense) =>
          expense.currency === currency &&
          expense.settlement === 'third_party' &&
          expense.incurredOn >= startOfMonthKey(month) &&
          expense.incurredOn <= endOfMonthKey(month),
      )
      .map((expense) => expense.amount),
  );

  const missing = missingIncomeOccurrences(
    input.templates.filter((template) => template.currency === currency),
    input.resolvedOccurrences,
    month,
  );

  const months = [...accounts]
    .sort((a, b) => a.position.id.localeCompare(b.position.id))
    .map((account) => accountMonthOf(account, month));
  const states = months.map((entry) => entry.state);

  const accountTypes = new Map(accounts.map((a) => [a.position.id, a.accountType]));
  const excluded = states.filter((state) => state.excludedFirstBalance);
  const unusable = states.filter((state) => !state.included && !state.excludedFirstBalance);
  const included = months.filter((entry) => entry.state.included);

  /**
   * Which flow legs belong to this bucket at all (8.1), decided **before**
   * anybody asks whether the arithmetic can run.
   *
   * 8.1 settles membership in two sentences and neither mentions endpoint
   * evidence. "Flows in (M, C)" are the month's tracked-cash legs of currency C,
   * and "a flow with a null cash position but currency C belongs to the bucket".
   * Then the excluded-accounts sentence takes some of them back out: an account
   * whose opening is `first_balance` is excluded from the bucket for M — "their
   * Δ **and their attributed flow legs**".
   *
   * So the scope is: participating accounts of this currency, less those
   * excluded as `first_balance`, plus every null leg. Nothing here is
   * conditioned on a statement balance, which is what keeps the four role sums
   * meaning one thing in every status.
   *
   * That it agrees with 8.2 is not a coincidence to be checked case by case.
   * 8.2 sums the flows "attributed to included accounts, or null-leg", and 8.3
   * only reaches 8.2 when no participating, non-excluded account has a
   * `carried` or `missing` end — at which point the included accounts *are* the
   * participating accounts less the `first_balance` ones. The two definitions
   * coincide exactly wherever the identity is computed, and this one keeps
   * saying something when the identity is not.
   *
   * A leg naming an account that does not participate in M is in neither part
   * and is therefore in no sum. Phase 3's writes cannot produce one — a flow
   * must fall inside its account's own window (20.1) — so this is the read-side
   * answer for legacy or externally-corrupted rows, and it is 8.3's own
   * `flows ← ... attributed to included accounts, plus null-leg flows` read
   * literally rather than a rule invented here.
   */
  const scopeIds = new Set(
    states.filter((state) => !state.excludedFirstBalance).map((state) => state.positionId),
  );
  const scopeLegs = legs.filter(
    (leg) =>
      leg.currency === currency &&
      (leg.cashPositionId === null || scopeIds.has(leg.cashPositionId)),
  );

  const totalOf = (role: RoleLeg['role']): Decimal =>
    sum(scopeLegs.filter((leg) => leg.role === role).map((leg) => leg.amount));

  /**
   * The four role sums over that scope, with a cash change beside them.
   *
   * The four are sums of **source records**: they need no balance evidence and
   * are exact in every status, and a zero among them is a measured zero — `ΣK =
   * 0` means no known tracked expense was recorded, not "unknown". A month with
   * a recorded salary and a missing statement still has `ΣI = 2,100`; reporting
   * `ΣI = 0` there would throw away a number the user entered.
   *
   * `trackedTotalSpending` and `unclassified` are the ones inferred from
   * balances, and they are absent — never zero — when the balances cannot carry
   * them (8.4).
   */
  const totalsWith = (delta: Decimal): BucketTotals => ({
    externalInflows: totalOf('I'),
    nonIncomeInflows: totalOf('Nin'),
    nonExpenseOutflows: totalOf('Nout'),
    knownTrackedExpenses: totalOf('K'),
    cashDelta: delta,
  });

  // 8.3: a currency whose only presence is a null-leg flow has nothing to
  // reconcile against. No participating account means no cash change to state,
  // and the empty sum is exactly zero rather than a stand-in for one.
  if (accounts.length === 0) {
    return {
      currency,
      status: 'unavailable',
      accounts: [],
      totals: totalsWith(new Decimal(0)),
      additionalSpending,
      thirdPartyPaid,
      issues: detectIssues({
        currency,
        states: [],
        legs,
        noParticipatingAccount: true,
        missingOccurrences: missing,
        accountTypes: new Map(),
      }),
      explanation: [
        `No ${currency} cash account took part in ${month}, so the ${currency} flows dated in it have nothing to reconcile against.`,
      ],
    };
  }

  // 8.3/8.4: a participating, non-excluded account with a `carried` or
  // `missing` end makes the bucket unavailable, and so does having nothing left
  // to reconcile with.
  if (unusable.length > 0 || included.length === 0) {
    return {
      currency,
      status: 'unavailable',
      accounts: states,
      // 8.2's definition of Δ applied to the accounts that have both
      // endpoints. **This is an open question, not a settled semantic**: 8.3
      // never computes Δ for an unavailable bucket, and 8.9 types `cashDelta`
      // as always present, so the blueprint says nothing about what a partial
      // sum over a subset of the bucket means. It is reported here because the
      // shape requires a value; it is not the bucket's cash change and no
      // spending figure follows from it. See the note on `BucketTotals`.
      totals: totalsWith(
        sum(included.map((entry) => entry.closingAmount.minus(entry.openingAmount))),
      ),
      additionalSpending,
      thirdPartyPaid,
      issues: detectIssues({
        currency,
        states,
        legs,
        noParticipatingAccount: false,
        missingOccurrences: missing,
        accountTypes,
      }),
      explanation:
        unusable.length > 0
          ? unusable.map(
              (state) =>
                `${state.name} has no statement balance for ${month} (opening ${state.opening.state}, closing ${state.closing.state}), so ${currency} spending cannot be inferred.`,
            )
          : [
              `Every ${currency} account is excluded from ${month}, so there is nothing to reconcile.`,
            ],
    };
  }

  // Here the scope and the included accounts are the same set: 8.3 only reaches
  // this point when no participating, non-excluded account has a `carried` or
  // `missing` end, which leaves the participating accounts less the
  // `first_balance` ones — exactly what 8.2 calls the included accounts. A leg
  // attributed to an excluded account stays out with that account, including
  // one side of a transfer whose other side is in, which is why a transfer is
  // not forced to cancel.
  const cashDelta = sum(
    included.map((entry) => entry.closingAmount.minus(entry.openingAmount)),
  );

  const roleSums = totalsWith(cashDelta);
  const { externalInflows, nonIncomeInflows, nonExpenseOutflows, knownTrackedExpenses } = roleSums;

  const trackedTotalSpending = externalInflows
    .plus(nonIncomeInflows)
    .minus(nonExpenseOutflows)
    .minus(cashDelta);
  const unclassified = trackedTotalSpending.minus(knownTrackedExpenses);

  // 8.3 diagnostics: what one account's balance change does not explain.
  // Attributed legs only — a null-leg flow belongs to no account, and spreading
  // it across them to make the residuals add up would be inventing an
  // attribution the user never gave.
  const withResiduals: AccountState[] = included.map((entry) => {
    const attributed = sum(
      scopeLegs
        .filter((leg) => leg.cashPositionId === entry.state.positionId)
        .map((leg) => signedEffect(leg)),
    );
    const delta = entry.closingAmount.minus(entry.openingAmount);
    return { ...entry.state, residual: delta.minus(attributed) };
  });
  const accountsOut = states.map(
    (state) => withResiduals.find((withOne) => withOne.positionId === state.positionId) ?? state,
  );

  const totals: BucketTotals = { ...roleSums, trackedTotalSpending, unclassified };

  const issues = detectIssues({
    currency,
    states: accountsOut,
    legs,
    computed: { trackedTotalSpending, unclassified },
    noParticipatingAccount: false,
    missingOccurrences: missing,
    accountTypes,
  });

  // 8.4: negative unclassified is unresolved; so is any other open blocking
  // issue. Otherwise an excluded first-balance account makes it estimated.
  const blocking = issues.filter((issue) => issue.class === 'blocking');
  const status: ReconciliationStatus =
    blocking.length > 0 ? 'unresolved' : excluded.length > 0 ? 'estimated' : 'reliable';

  return {
    currency,
    status,
    accounts: accountsOut,
    totals,
    additionalSpending,
    thirdPartyPaid,
    issues,
    explanation: [
      `Cash change = ${cashDelta.toString()} ${currency} across ${String(included.length)} account(s).`,
      `Tracked total spending = ${externalInflows.toString()} in + ${nonIncomeInflows.toString()} moved in − ${nonExpenseOutflows.toString()} moved out − ${cashDelta.toString()} change = ${trackedTotalSpending.toString()}.`,
      `Unclassified = ${trackedTotalSpending.toString()} − ${knownTrackedExpenses.toString()} known = ${unclassified.toString()}.`,
    ],
  };
}

/**
 * Reconcile every native-currency bucket of one **completed** month.
 *
 * Throws for a month that is not over. 8.1 defines completed as `today >
 * end(M)` — strictly after, so on 30 September the month is still current and
 * its figure is month-to-date, which is a different engine (8.6).
 */
export function reconcileCompletedMonth(input: CompletedMonthInput): MonthReconciliation {
  if (!isMonthCompleted(input.month, input.today)) {
    throw new MonthNotCompletedError(input.month);
  }

  const legs = legsInMonth(input);

  // 8.3: the currencies to reconcile are those with a participating cash
  // position, plus those a null-leg flow names — the second is how a flow with
  // no account still gets a bucket to be reported against.
  const participating = input.cashAccounts.filter(
    (account) =>
      account.position.kind === 'cash' && participatesIn(account.position, input.month),
  );

  const currencies = new Set<string>(participating.map((account) => account.position.currency));
  for (const leg of legs) {
    if (leg.cashPositionId === null) currencies.add(leg.currency);
  }

  const buckets = [...currencies]
    .sort()
    .map((code) => {
      const currency = currencyCode(code);
      return reconcileBucket(
        input,
        currency,
        participating.filter((account) => account.position.currency === currency),
        legs,
      );
    });

  return {
    month: input.month,
    buckets,
    monthStatus: worstStatus(buckets.map((bucket) => bucket.status)),
  };
}
