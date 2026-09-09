import { Decimal } from '../decimal';
import type { PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import { expenseLeg, incomeLeg, transferLegs, type RoleLeg } from '../flows/roles';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../flows/types';
import type { BucketTotals } from './types';

/**
 * Which flows belong to a reconciliation bucket, and what they sum to
 * (blueprint 8.1, 8.2, v2.1.9 30.12).
 *
 * Shared by the completed-month engine and the month-to-date one because 8.1
 * states the membership rule once and states it about an interval, not about a
 * kind of month: the month's tracked-cash legs of currency C, attributed to a
 * participating account that is not excluded as `first_balance`, plus every leg
 * with no account named. Only the interval's end moves — `end(M)` for a
 * completed month, the common as-of date `D` for the current one.
 *
 * What is deliberately *not* here is anything that decides whether the
 * arithmetic can run. Endpoint evidence, statuses and issues differ between the
 * two engines and belong to them; membership does not, and a second subtly
 * different attribution rule is how two engines start disagreeing about what a
 * user's month contained.
 */

/** Money sums accumulate in a fixed order so the same inputs give the same string (ADR 0004 §1). */
export function sumAmounts(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

/** The signed effect of a leg on the cash it touches: inflows add, outflows take away. */
export function signedEffect(leg: RoleLeg): Decimal {
  return leg.role === 'I' || leg.role === 'Nin' ? leg.amount : leg.amount.negated();
}

/** The flow records an interval is built from, in the shape both engines hold them. */
export interface FlowRecords {
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
  /** Legs from records a later phase owns, already classified by 7.4. */
  readonly preClassifiedLegs?: readonly RoleLeg[] | undefined;
}

/**
 * Every role leg of every flow dated within `[from, to]`, inclusive at both
 * ends — 8.1's same-day rule makes a balance dated `to` reflect a flow dated
 * `to`, so the interval must include it.
 */
export function legsInRange(
  records: FlowRecords,
  from: PlainDate,
  to: PlainDate,
): RoleLeg[] {
  const within = (on: string): boolean => on >= from && on <= to;

  const legs: RoleLeg[] = [];
  for (const income of records.income) {
    if (!within(income.receivedOn)) continue;
    const leg = incomeLeg(income);
    if (leg !== undefined) legs.push(leg);
  }
  for (const expense of records.expenses) {
    if (!within(expense.incurredOn)) continue;
    const leg = expenseLeg(expense);
    if (leg !== undefined) legs.push(leg);
  }
  for (const transfer of records.transfers) {
    if (!within(transfer.occurredOn)) continue;
    legs.push(...transferLegs(transfer));
  }
  for (const leg of records.preClassifiedLegs ?? []) {
    if (within(leg.on)) legs.push(leg);
  }
  return legs;
}

/** An account as the scope rule sees it: an id, and whether 8.1 excluded it. */
export interface ScopeAccount {
  readonly positionId: string;
  readonly excludedFirstBalance: boolean;
}

/**
 * The accounts whose attributed legs belong to the bucket: participating, less
 * those excluded because their first balance lands in the interval (8.1).
 *
 * Decided from membership alone, before anything asks whether endpoint evidence
 * exists. An account losing its statement does not change which flows the
 * bucket contains.
 */
export function scopeAccountIds(accounts: readonly ScopeAccount[]): Set<string> {
  return new Set(
    accounts.filter((a) => !a.excludedFirstBalance).map((a) => a.positionId),
  );
}

/**
 * The legs of one currency that the bucket owns: those attributed to an account
 * in scope, plus those attributed to none.
 *
 * A leg naming an account outside the scope — excluded, or not participating at
 * all — is in neither part and so is in no sum. It is never re-attributed and
 * never treated as a null leg.
 */
export function legsInScope(
  legs: readonly RoleLeg[],
  currency: CurrencyCode,
  scopeIds: ReadonlySet<string>,
): RoleLeg[] {
  return legs.filter(
    (leg) =>
      leg.currency === currency &&
      (leg.cashPositionId === null || scopeIds.has(leg.cashPositionId)),
  );
}

/**
 * The four role sums over a set of scoped legs.
 *
 * Sums of **source records**: they need no balance evidence, so they are exact
 * in every status, and a zero among them means no such record exists rather
 * than "unknown" (30.12). The balance-derived figures are added by the caller
 * that has them.
 */
export function roleSums(legs: readonly RoleLeg[]): BucketTotals {
  const total = (role: RoleLeg['role']): Decimal =>
    sumAmounts(legs.filter((leg) => leg.role === role).map((leg) => leg.amount));

  return {
    externalInflows: total('I'),
    nonIncomeInflows: total('Nin'),
    nonExpenseOutflows: total('Nout'),
    knownTrackedExpenses: total('K'),
  };
}
