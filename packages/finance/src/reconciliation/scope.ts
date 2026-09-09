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
 * A role leg together with the record it came from (12.5, v2.1.12 30.15 item 3).
 *
 * Reconciliation needs only the leg: a role, a currency, an amount and where it
 * landed. The savings decomposition needs to know *what the money was* — a
 * salary and an `external_inflow` are both `I` and only one of them is income;
 * a food expense and a transfer fee are both `K` and they belong to different
 * 12.3 buckets. Rather than widening `RoleLeg` with an economic classification
 * that reconciliation would never read, the fact carries its own source beside
 * the leg, and whoever wants the classification asks the source.
 *
 * A pre-classified leg has no source record. That is not an omission: those
 * legs stand in for record types a later phase owns, and the phase that owns
 * them will classify them where it builds the breakdown.
 */
export type FlowFact =
  | { readonly kind: 'income'; readonly leg: RoleLeg; readonly income: IncomeFlow }
  | { readonly kind: 'expense'; readonly leg: RoleLeg; readonly expense: ExpenseFlow }
  | { readonly kind: 'transfer'; readonly leg: RoleLeg; readonly transfer: TransferFlow }
  | { readonly kind: 'pre_classified'; readonly leg: RoleLeg };

/**
 * Every flow fact dated within `[from, to]`, inclusive at both ends — 8.1's
 * same-day rule makes a balance dated `to` reflect a flow dated `to`, so the
 * interval must include it.
 */
export function factsInRange(
  records: FlowRecords,
  from: PlainDate,
  to: PlainDate,
): FlowFact[] {
  const within = (on: string): boolean => on >= from && on <= to;

  const facts: FlowFact[] = [];
  for (const income of records.income) {
    if (!within(income.receivedOn)) continue;
    const leg = incomeLeg(income);
    if (leg !== undefined) facts.push({ kind: 'income', leg, income });
  }
  for (const expense of records.expenses) {
    if (!within(expense.incurredOn)) continue;
    const leg = expenseLeg(expense);
    if (leg !== undefined) facts.push({ kind: 'expense', leg, expense });
  }
  for (const transfer of records.transfers) {
    if (!within(transfer.occurredOn)) continue;
    for (const leg of transferLegs(transfer)) facts.push({ kind: 'transfer', leg, transfer });
  }
  for (const leg of records.preClassifiedLegs ?? []) {
    if (within(leg.on)) facts.push({ kind: 'pre_classified', leg });
  }
  return facts;
}

/**
 * Every role leg of every flow dated within `[from, to]`.
 *
 * Derived from `factsInRange` rather than repeating it, so the two views of an
 * interval cannot drift apart in which records they contain or the order they
 * contain them in.
 */
export function legsInRange(
  records: FlowRecords,
  from: PlainDate,
  to: PlainDate,
): RoleLeg[] {
  return factsInRange(records, from, to).map((fact) => fact.leg);
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
 * Does this leg belong to the bucket: is it of the currency, and is it
 * attributed to an account in scope or to none at all?
 *
 * The single inclusion decision. Everything that needs to know what a bucket
 * contains — the two reconciliation engines through `legsInScope`, the savings
 * decomposition through `factsInScope` — asks this one predicate, so a leg
 * cannot be inside the identity and outside its classification, or the reverse.
 *
 * A leg naming an account outside the scope — excluded as `first_balance`, or
 * not participating at all — is in neither part and so is in no sum. It is
 * never re-attributed and never treated as a null leg.
 */
export function legInScope(
  leg: RoleLeg,
  currency: CurrencyCode,
  scopeIds: ReadonlySet<string>,
): boolean {
  return (
    leg.currency === currency &&
    (leg.cashPositionId === null || scopeIds.has(leg.cashPositionId))
  );
}

/** The legs of one currency that the bucket owns. */
export function legsInScope(
  legs: readonly RoleLeg[],
  currency: CurrencyCode,
  scopeIds: ReadonlySet<string>,
): RoleLeg[] {
  return legs.filter((leg) => legInScope(leg, currency, scopeIds));
}

/** The same bucket, as facts that still know where they came from. */
export function factsInScope(
  facts: readonly FlowFact[],
  currency: CurrencyCode,
  scopeIds: ReadonlySet<string>,
): FlowFact[] {
  return facts.filter((fact) => legInScope(fact.leg, currency, scopeIds));
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
