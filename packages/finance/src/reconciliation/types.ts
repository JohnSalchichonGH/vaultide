import type { Decimal } from '../decimal';
import type { MonthKey, PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import type { CashOpenState, CashCloseState } from '../positions/cash-state';
import type { PositionRecord, ValuationRecord } from '../positions/types';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../flows/types';
import type { RoleLeg } from '../flows/roles';
import type { RecurrenceSchedule } from '../recurring/occurrences';

/**
 * The shapes completed-month reconciliation takes and returns (blueprint 8.9).
 *
 * Everything is native currency and exact. Nothing here is ever stored: 5.3
 * makes source rows the only truth, and a reconciliation is recomputed from
 * them on every read, so a corrected balance from six months ago simply changes
 * what every later figure says.
 */

/**
 * 8.4. `provisional` belongs to the current month (8.6) and is declared here
 * because the enum is one closed set; the completed-month engine never returns
 * it, and a test asserts that.
 */
export type ReconciliationStatus =
  | 'reliable'
  | 'estimated'
  | 'provisional'
  | 'unavailable'
  | 'unresolved';

/**
 * Worst-first, exactly as 8.4 orders them:
 * `unavailable > unresolved > estimated > reliable`.
 */
const STATUS_SEVERITY: Readonly<Record<ReconciliationStatus, number>> = {
  unavailable: 4,
  unresolved: 3,
  provisional: 2,
  estimated: 1,
  reliable: 0,
};

/** The month's status is the worst of its buckets' (8.3, 8.4). */
export function worstStatus(
  statuses: readonly ReconciliationStatus[],
): ReconciliationStatus {
  let worst: ReconciliationStatus = 'reliable';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/**
 * The 8.5 issue keys this engine can raise.
 *
 * Deliberately only the completed-month Phase 3 ones. The `mtd_*` keys belong
 * to 8.6, `suggested_payment_missing` and `stale_*` to later phases, and
 * `possible_missing_conversion` and `large_unclassified` need machinery this
 * slice does not have (a monthly average rate and a trailing median of reliable
 * months). A key is never invented or renamed: the catalogue is the contract
 * the interface and the dismissal state in `month_reviews` are written against.
 */
export type IssueKey =
  | 'missing_month_end'
  | 'first_balance'
  | 'flow_without_cash_account'
  | 'unexplained_inflow'
  | 'possible_missing_interest'
  | 'suggested_income_missing';

/** 8.5's "Class" column. `info` is neither blocking nor advisory. */
export type IssueClass = 'blocking' | 'advisory' | 'info';

export const ISSUE_CLASS: Readonly<Record<IssueKey, IssueClass>> = {
  missing_month_end: 'blocking',
  first_balance: 'info',
  flow_without_cash_account: 'blocking',
  unexplained_inflow: 'blocking',
  possible_missing_interest: 'advisory',
  suggested_income_missing: 'advisory',
};

export interface Issue {
  readonly key: IssueKey;
  readonly class: IssueClass;
  readonly currency: CurrencyCode;
  /** The account the issue is about, when it is about one. */
  readonly positionId?: string;
  /** The amount the issue is about (the unexplained inflow, the residual). */
  readonly amount?: Decimal;
  /**
   * 8.5, as v2.1.8 30.11 selects them: `unexplained_inflow` variant A when the
   * tracked total is negative (cash grew more than the records explain), B when
   * it is zero or above (known expenses exceed the cash that left). The two read
   * differently to a user and the distinction is the blueprint's.
   */
  readonly variant?: 'a' | 'b';
  readonly templateId?: string;
  readonly templateName?: string;
  readonly occurrenceDate?: PlainDate;
}

/** One account's contribution to a bucket (8.9). */
export interface AccountState {
  readonly positionId: string;
  readonly name: string;
  readonly opening: { readonly state: CashOpenState; readonly amount?: Decimal; readonly valuedOn?: PlainDate };
  readonly closing: { readonly state: CashCloseState; readonly amount?: Decimal; readonly valuedOn?: PlainDate };
  /** `true` when both ends are settled and the account is in the arithmetic. */
  readonly included: boolean;
  /** `true` when 8.1 excludes it because its first balance lands in M. */
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
  /**
   * `(close − open) − Σ attributed flows` (8.3), for included accounts only.
   *
   * A diagnostic, never an allocation: null-leg flows are attributed to no
   * account and appear in no residual, so the residuals sum to the bucket's
   * unclassified amount only when the month has none.
   */
  readonly residual?: Decimal;
}

/**
 * 8.9's totals, and the line that runs through them.
 *
 * The four role sums are sums of **source records**. They need no balance
 * evidence, so they are exact and present whatever the statements say, and a
 * zero among them is a measured zero: `ΣK = 0` means no known tracked expense,
 * not "unknown". `cashDelta` is 8.2's `Σ_{included}(close − open)` — always
 * that sum and nothing else, which for an unavailable bucket covers only the
 * accounts that had usable endpoints.
 *
 * `trackedTotalSpending` and `unclassified` are inferred from those balances,
 * so they are **absent** rather than zero when the bucket is `unavailable`
 * (8.4). That absence is the only signal that the month has no spending figure.
 *
 * **The four sums must never be presented as a spending result while the
 * bucket's status is `unavailable`.** They say what was recorded, not what was
 * spent, and in that state they are not even the identity's inputs: with no
 * usable inclusion set there is nothing to restrict them to, so they cover every
 * known flow of the currency. When the bucket does reconcile they are the
 * identity's inputs exactly as 8.2 requires — the legs of included accounts plus
 * the null-leg ones.
 */
export interface BucketTotals {
  readonly externalInflows: Decimal;
  readonly nonIncomeInflows: Decimal;
  readonly nonExpenseOutflows: Decimal;
  readonly knownTrackedExpenses: Decimal;
  readonly cashDelta: Decimal;
  /** Absent when the bucket could not be computed — never zero (8.4). */
  readonly trackedTotalSpending?: Decimal;
  readonly unclassified?: Decimal;
}

export interface BucketResult {
  readonly currency: CurrencyCode;
  readonly status: ReconciliationStatus;
  readonly accounts: readonly AccountState[];
  readonly totals: BucketTotals;
  /** `untracked_self` in this currency and month. Never in the identity (7.4). */
  readonly additionalSpending: Decimal;
  /** `third_party` in this currency and month. In no total at all (7.4). */
  readonly thirdPartyPaid: Decimal;
  readonly issues: readonly Issue[];
  /** Formula lines carrying the real inputs, for "How was this calculated?" */
  readonly explanation: readonly string[];
}

export interface MonthReconciliation {
  readonly month: MonthKey;
  readonly buckets: readonly BucketResult[];
  readonly monthStatus: ReconciliationStatus;
}

/** A cash account and the valuations the Phase 2 state engine needs. */
export interface CashAccountInput {
  readonly position: PositionRecord;
  readonly valuations: readonly ValuationRecord[];
  /** 8.5 `possible_missing_interest` asks whether interest is plausible here. */
  readonly accountType: string;
}

/**
 * A recurring template as historical completeness sees it (12.6, 30.10).
 *
 * `archived_at` is deliberately absent: it is present-tense visibility and must
 * not decide what a past month expected. What bounds the schedule is
 * `start_date`/`end_date`, which live inside `schedule`.
 */
export interface CompletenessTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly kind: 'income' | 'expense' | 'contribution';
  readonly currency: CurrencyCode;
  readonly incomeKind: string | null;
  readonly schedule: RecurrenceSchedule;
}

export interface CompletedMonthInput {
  readonly month: MonthKey;
  /** Injected; no engine reads a clock (7.7). */
  readonly today: PlainDate;
  readonly cashAccounts: readonly CashAccountInput[];
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
  readonly templates: readonly CompletenessTemplate[];
  /** `${templateId}#${occurrenceDate}` for every materialized or skipped one. */
  readonly resolvedOccurrences: ReadonlySet<string>;
  /**
   * Cash legs from records Phase 3 has no table for, already classified by 7.4.
   *
   * The reconciliation identity spans phases even though the storage does not:
   * 8.10's own worked example contains an investment contribution and a
   * mortgage payment, whose principal is `Nout` and whose interest is `K`.
   * Phase 3's loader always passes none, and Phase 4 and 5 replace this with
   * real inputs once `investments` and `liability_payments` exist.
   *
   * It is here rather than hidden in a test helper because the alternative was
   * dressing a mortgage payment up as some Phase 3 record that happens to
   * classify the same way — which would pin the arithmetic while lying about
   * what the fixture is.
   */
  readonly preClassifiedLegs?: readonly RoleLeg[];
}

/** Raised when the completed-month engine is asked about a month that is not over. */
export class MonthNotCompletedError extends Error {
  readonly code = 'MONTH_NOT_COMPLETED';
  constructor(readonly month: MonthKey) {
    super(
      `${month} has not ended yet. A completed month is one where today is past its last day (8.1); the current month is month-to-date instead.`,
    );
    this.name = 'MonthNotCompletedError';
  }
}
