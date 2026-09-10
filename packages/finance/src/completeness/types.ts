import type { Decimal } from '../decimal';
import type { MonthKey, PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import type { PositionWithValuations } from '../positions/types';
import type { CompletenessTemplate } from '../reconciliation/types';

/**
 * The shapes completed-month completeness takes and returns (blueprint 12.6,
 * v2.1.15 30.18).
 *
 * Completeness is its own axis. It is not reconciliation quality, not
 * reporting-currency availability and not FX provenance, and its `partial` is
 * not the reporting `Partial` of 7.6. Nothing here reads a reconciliation
 * status or feeds one, and nothing here is stored (5.3): the answer is derived
 * from the source rows on every read.
 */

/**
 * 12.6's four states, in the order v2.1.15 30.18 ranks them:
 * `stale` > `incomplete` > `partial` > `sufficient`.
 */
export type CompletenessState = 'stale' | 'incomplete' | 'partial' | 'sufficient';

/**
 * One required cash item: an account that participates in M under 8.1 and is
 * not dormant (12.6, 30.18 item 6).
 *
 * The evidence and the verdict travel together, and only in the combinations
 * 12.6 allows: an account is satisfied by a statement balance or by closing
 * inside M, and by nothing else. `dormant_zero` cannot appear — a dormant
 * account is outside the count altogether, not a satisfied item.
 */
export type CashAccountRequirement = {
  readonly positionId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
} & (
  | { readonly satisfied: true; readonly closeState: 'month_end' | 'closed_zero' }
  | { readonly satisfied: false; readonly closeState: 'carried' | 'missing' }
);

/**
 * One required recurring item: an occurrence the template's schedule placed in
 * M (12.6, 30.10).
 *
 * Satisfied exactly when a flow carrying its `(template_id, occurrence_date)` or
 * a skip row exists. Which of the two it was is not recorded, because 12.6 does
 * not distinguish them; the amount a term sets for it takes no part.
 */
export interface RecurringOccurrenceRequirement {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateKind: CompletenessTemplate['kind'];
  readonly currency: CurrencyCode;
  readonly occurrenceDate: PlainDate;
  readonly satisfied: boolean;
}

export interface CompletedMonthCompletenessInput {
  readonly month: MonthKey;
  /** Injected; no engine reads a clock (7.7). */
  readonly today: PlainDate;
  /**
   * Every position the user has, of every kind, with its valuations.
   *
   * Two rules read it. The cash rule reads the cash accounts, through 8.1's own
   * participation and closing states. The `stale` rule reads a valuation of any
   * position at all (30.18 item 3), which is why a car revalued inside M
   * prevents `stale` exactly as a bank statement does.
   *
   * Valuations need no lower bound (ADR 0004 §3): a closing state that is
   * `carried` is found by looking before the month.
   */
  readonly positions: readonly PositionWithValuations[];
  /** Templates whose schedule overlaps M, archived or not (30.10). */
  readonly templates: readonly CompletenessTemplate[];
  /** `${templateId}#${occurrenceDate}` for every materialized or skipped one. */
  readonly resolvedOccurrences: ReadonlySet<string>;
}

/**
 * One completed month's completeness.
 *
 * `satisfied` and `required` are the result (30.18 item 4). `ratio` is derived
 * from them — their exact unrounded quotient at the engine's working precision
 * (7.1), or `null` when nothing is required — and a percentage is a display
 * derivation of the counts, made where it is shown.
 *
 * The items are listed satisfied and unsatisfied alike, so the counts can be
 * explained item by item.
 */
export interface CompletedMonthCompleteness {
  readonly month: MonthKey;
  readonly state: CompletenessState;
  readonly satisfied: number;
  readonly required: number;
  /** `satisfied / required`, or `null` when `required = 0` — never 0 and never 1 then. */
  readonly ratio: Decimal | null;
  /** Ordered by position id, for determinism only. */
  readonly cashAccounts: readonly CashAccountRequirement[];
  /** Ordered by occurrence date, then template id. */
  readonly recurringOccurrences: readonly RecurringOccurrenceRequirement[];
}
