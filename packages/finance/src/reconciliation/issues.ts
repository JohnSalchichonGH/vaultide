import { Decimal } from '../decimal';
import type { CurrencyCode } from '../money/types';
import type { RoleLeg } from '../flows/roles';
import type { MissingOccurrence } from './completeness';
import { ISSUE_CLASS, type AccountState, type Issue, type IssueKey } from './types';

/**
 * The 8.5 issue catalogue, for completed months (blueprint 8.5).
 *
 * Each issue names something a person can act on, and every key here is the
 * blueprint's own. That matters more than it looks: the keys are what
 * `month_reviews.dismissed_issues` stores, so renaming one to read better would
 * silently un-dismiss every issue somebody had already dealt with.
 *
 * The classes are the blueprint's too — `blocking` keeps a month `unresolved`
 * until the data is fixed, `advisory` can be dismissed, and `info` is neither.
 */

/** Savings-shaped accounts are where uncredited interest is plausible (8.5). */
const INTEREST_BEARING: readonly string[] = ['savings', 'brokerage_cash'];

/** 8.5: the residual must be under half a percent of the account's balance. */
const INTEREST_RESIDUAL_FRACTION = new Decimal('0.005');

/**
 * The figures the arithmetic produces, when it ran.
 *
 * They travel together and neither is optional, so the detector cannot reach
 * for a missing one and substitute zero. That substitution is the exact mistake
 * 8.4 forbids — an unavailable bucket has no spending figure, and a defensive
 * `?? 0` here would turn "we do not know" into "nothing was spent" and then
 * raise or suppress issues on the strength of it.
 *
 * `ΣK` is deliberately **not** here. v2.1.8 30.11 selects the unexplained-inflow
 * variants on the sign of the tracked total, and passing `ΣK` in would only
 * offer the comparison that turned out to be impossible.
 */
export interface ComputedFigures {
  readonly trackedTotalSpending: Decimal;
  readonly unclassified: Decimal;
}

export interface IssueInput {
  readonly currency: CurrencyCode;
  readonly states: readonly AccountState[];
  readonly legs: readonly RoleLeg[];
  /** Absent when the bucket is unavailable and has no arithmetic to judge. */
  readonly computed?: ComputedFigures | undefined;
  /** 8.3: the currency has no participating cash position at all. */
  readonly noParticipatingAccount: boolean;
  readonly missingOccurrences: readonly MissingOccurrence[];
  readonly accountTypes: ReadonlyMap<string, string>;
}

function issue(key: IssueKey, rest: Omit<Issue, 'key' | 'class'>): Issue {
  return { key, class: ISSUE_CLASS[key], ...rest };
}

/**
 * 8.5's two readings of an unexplained inflow, as v2.1.8 30.11 selects them.
 *
 * The split is the **sign of the tracked total**, not a comparison against
 * `ΣK`. 30.11 records why: the issue is raised on `unclassified < 0`, and 8.2
 * makes `unclassified = total − ΣK`, so the trigger already *is* `ΣK > total`.
 * A variant selected by `ΣK ≤ total` was the trigger's own negation and could
 * never occur, which made every unexplained inflow read as "known expenses
 * exceed the cash that left" — including 8.10's forgotten salary, where the
 * truth is the opposite: cash grew and nothing recorded says why.
 *
 * Exactly zero is variant B's. A tracked total of zero means the month's flows
 * explain its cash exactly, which is not growth, even though `ΣK > 0` still
 * leaves known expenses that the cash cannot account for. There is no epsilon
 * on either side: 8.4's tolerance is exactly zero.
 */
function unexplainedInflowVariant(total: Decimal): 'a' | 'b' {
  return total.lessThan(0) ? 'a' : 'b';
}

export function detectIssues(input: IssueInput): Issue[] {
  const issues: Issue[] = [];
  const { currency } = input;

  // A null-leg flow in a currency no account takes part in (8.5). The flow is
  // never dropped and never given an account: it is reported, and the bucket
  // stays unavailable until somebody says where the money went.
  if (input.noParticipatingAccount) {
    const nullLeg = input.legs.filter(
      (leg) => leg.currency === currency && leg.cashPositionId === null,
    );
    for (const leg of nullLeg) {
      issues.push(issue('flow_without_cash_account', { currency, amount: leg.amount }));
    }
  }

  for (const state of input.states) {
    // 8.5: an account whose opening or closing is carried or missing has no
    // statement evidence for this month.
    if (!state.included && !state.excludedFirstBalance) {
      issues.push(issue('missing_month_end', { currency, positionId: state.positionId }));
    }
    // 8.1/8.5: a pre-existing account first tracked in M is excluded, and says
    // so. Info rather than a problem — the month is `estimated`, not broken.
    if (state.excludedFirstBalance) {
      issues.push(issue('first_balance', { currency, positionId: state.positionId }));
    }
  }

  const computed = input.computed;
  if (computed !== undefined) {
    // 8.4: exactly zero tolerance, in native currency. Cash grew by more than
    // the records explain, or the known expenses exceed the cash that left.
    //
    // Compared against zero explicitly rather than with `isNegative()`:
    // decimal.js reads the sign bit, so zero is "positive" and negative zero is
    // "negative". A month that reconciles exactly must be reliable.
    if (computed.unclassified.lessThan(0)) {
      issues.push(
        issue('unexplained_inflow', {
          currency,
          amount: computed.unclassified.abs(),
          variant: unexplainedInflowVariant(computed.trackedTotalSpending),
        }),
      );
    }

    // 8.5: a small positive residual on a savings-shaped account usually means
    // interest nobody recorded. Advisory, and prefilled later.
    for (const state of input.states) {
      const residual = state.residual;
      // `greaterThan(0)`, not `isPositive()`: a residual of exactly zero is an
      // account that reconciles, and telling that user they may have forgotten
      // interest would be advice with nothing behind it.
      if (residual === undefined || !residual.greaterThan(0)) continue;
      if (!INTEREST_BEARING.includes(input.accountTypes.get(state.positionId) ?? '')) continue;

      const balance = state.closing.amount;
      if (balance === undefined || !balance.greaterThan(0)) continue;
      if (residual.greaterThanOrEqualTo(balance.times(INTEREST_RESIDUAL_FRACTION))) continue;

      issues.push(
        issue('possible_missing_interest', {
          currency,
          positionId: state.positionId,
          amount: residual,
        }),
      );
    }
  }

  // 12.6/8.5: an occurrence the schedule expected, with neither a flow nor a
  // skip to account for it. Raised whether or not the arithmetic worked, since
  // a missing salary is worth saying even when the month cannot be reconciled.
  for (const occurrence of input.missingOccurrences) {
    issues.push(
      issue('suggested_income_missing', {
        currency,
        templateId: occurrence.templateId,
        templateName: occurrence.templateName,
        occurrenceDate: occurrence.occurrenceDate,
      }),
    );
  }

  return issues;
}
