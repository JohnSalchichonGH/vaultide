import type { Decimal } from '../decimal';
import type { CurrencyCode } from '../money/types';
import type { PlainDate } from '../dates/plain-date';
import type {
  CategoryKind,
  ExpenseFlow,
  IncomeFlow,
  IncomeKind,
  IncomeSettlement,
  TransferFlow,
} from './types';

/**
 * The reconciliation role of every flow (blueprint 7.4, 8.1, 8.2).
 *
 * The identity of 8.2 is
 *
 * ```
 * TrackedTotalSpending = ΣI + ΣNin − ΣNout − ΔCash
 * Unclassified         = TrackedTotalSpending − ΣK
 * ```
 *
 * so what a record *means* is decided entirely by which of those four sums it
 * lands in. That decision is here, in one table, computed from the record's own
 * fields — never from a name, never from a sign, and never from whether a cash
 * position happens to be NULL.
 *
 * This module classifies. It does no arithmetic: summing the legs is the
 * reconciliation engine's job, and keeping the two apart is what lets the role
 * matrix be tested exhaustively on its own.
 *
 * `none` means "no role in tracked-cash reconciliation" and is not the same as
 * zero. An `untracked_self` expense is real spending that simply never touched
 * a tracked account; a `third_party` expense is not the user's spending at all.
 * Both are `none` here and are told apart by the analytics that read the flow's
 * settlement directly (12.5).
 */

/** `I` external inflow · `Nin`/`Nout` non-income/non-expense · `K` known expense. */
export type FlowRole = 'I' | 'Nin' | 'Nout' | 'K' | 'none';

export interface RoleLeg {
  readonly role: FlowRole;
  readonly currency: CurrencyCode;
  readonly amount: Decimal;
  /** The bucket's account, or `null` for a flow awaiting attribution (8.1). */
  readonly cashPositionId: string | null;
  /** The date the leg falls on, for the month and the MTD cut-off. */
  readonly on: PlainDate;
  readonly sourceId: string;
}

/**
 * Income (7.4).
 *
 * Every income record settled in tracked cash is the external inflow `I`, and
 * 7.4's matrix says so for all nine kinds — `external_inflow` and `adjustment`
 * included, on their own rows. Anything not settled in tracked cash has no cash
 * role at all.
 *
 * The tempting mistake, which this function made until it was corrected, is to
 * give `external_inflow` and `adjustment` the `Nin` role because neither is
 * income. That confuses two different classifications. `I` is a **cash** fact:
 * money arrived from outside the tracked system, and the identity needs it to
 * explain the balance — which is the whole reason `adjustment` exists. Whether
 * that arrival counts as *income* is a **12.5** question, answered separately by
 * `isExternalIncomeKind`, which excludes exactly those two so they cannot
 * inflate the savings rate. `Nin` means something else again: cash that moved in
 * without arriving from outside at all — a transfer's destination leg, a
 * withdrawal, loan proceeds, a sale.
 *
 * Both roles enter 8.2 with the same sign, so the split is invisible in the
 * identity and visible in the two role sums 8.9 reports, and in what 12.5 is
 * then allowed to call income.
 *
 * `kind` stays in the signature because Phase 4 needs it: an external
 * distribution linked to an investment is a `dividend` or `interest` that never
 * reaches tracked cash and carries the +d/−d pair instead (7.4).
 */
export function incomeRole(kind: IncomeKind, settlement: IncomeSettlement): FlowRole {
  if (settlement !== 'tracked_cash') return 'none';
  return 'I';
}

/**
 * Expenses (7.4).
 *
 * Every tracked-cash expense is a known outflow `K` whatever its category —
 * consumption, a transfer fee, an investment fee, an acquisition cost, an
 * external outflow — because `K` is "cash that left and which we can name". The
 * category kind decides which *bucket* it lands in for the decomposition and
 * the savings formula, not whether it is known.
 *
 * The one exception is `capital_improvement`, which 7.4 assigns to `Nout`: it
 * is capital expenditure, not spending, so it must not be counted as
 * consumption even though the cash left a tracked account.
 */
export function expenseRole(
  categoryKind: CategoryKind,
  settlement: ExpenseFlow['settlement'],
): FlowRole {
  if (settlement !== 'tracked_cash') return 'none';
  return categoryKind === 'capital_improvement' ? 'Nout' : 'K';
}

/**
 * A cash transfer's two legs (7.4, 8.8).
 *
 * `Nout` on the source and `Nin` on the destination. In one currency they
 * cancel exactly inside the bucket, so a transfer is never income and never
 * spending; across currencies each native bucket sees its own leg and
 * reconciles independently, with no FX effect in either.
 *
 * A fee is not here. It is one `expense_entries` row linked by `transfer_id`
 * (M14), classified as `K` like any other tracked expense — which is what makes
 * it impossible to count twice.
 */
export function transferLegs(transfer: TransferFlow): RoleLeg[] {
  const legs: RoleLeg[] = [];

  if (transfer.fromPositionId !== null || transfer.toPositionId !== null) {
    legs.push({
      role: 'Nout',
      currency: transfer.fromCurrency,
      amount: transfer.fromAmount,
      cashPositionId: transfer.fromPositionId,
      on: transfer.occurredOn,
      sourceId: transfer.id,
    });
    legs.push({
      role: 'Nin',
      currency: transfer.toCurrency,
      amount: transfer.toAmount,
      cashPositionId: transfer.toPositionId,
      on: transfer.occurredOn,
      sourceId: transfer.id,
    });
  }

  return legs;
}

/** The single leg an income record contributes, or none. */
export function incomeLeg(income: IncomeFlow): RoleLeg | undefined {
  const role = incomeRole(income.kind, income.settlement);
  if (role === 'none') return undefined;
  return {
    role,
    currency: income.currency,
    amount: income.netAmount,
    cashPositionId: income.cashPositionId,
    on: income.receivedOn,
    sourceId: income.id,
  };
}

/** The single leg an expense record contributes, or none. */
export function expenseLeg(expense: ExpenseFlow): RoleLeg | undefined {
  const role = expenseRole(expense.categoryKind, expense.settlement);
  if (role === 'none') return undefined;
  return {
    role,
    currency: expense.currency,
    amount: expense.amount,
    cashPositionId: expense.cashPositionId,
    on: expense.incurredOn,
    sourceId: expense.id,
  };
}
