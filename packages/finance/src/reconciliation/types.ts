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
 * The 8.5 issue keys the Phase 3 reconciliation engines can raise.
 *
 * One catalogue for both months, because `month_reviews.dismissed_issues`
 * stores keys and a key means one thing wherever it is raised. Which of them a
 * given engine may raise is a separate question that 8.5 and 8.6 answer:
 * `missing_month_end` is completed-month only, the two `mtd_*` keys are
 * current-month only, and `possible_missing_interest` and
 * `suggested_income_missing` are completed-month only under v2.1.10 30.13
 * item 10.
 *
 * Still absent, and deliberately: `suggested_payment_missing` and `stale_*`
 * belong to later phases. `large_unclassified` is raised by the completed-month
 * diagnostic in `diagnostics.ts`, over the six reliable months before the
 * target (30.15 item 4); `possible_missing_conversion` by the one in
 * `missing-conversion.ts`, from the month's own buckets and its average rate
 * (30.15 items 6–9, 30.17). A key is never invented or renamed.
 */
export type IssueKey =
  | 'missing_month_end'
  | 'first_balance'
  | 'flow_without_cash_account'
  | 'unexplained_inflow'
  | 'possible_missing_interest'
  | 'suggested_income_missing'
  | 'mtd_no_common_date'
  | 'mtd_newer_balances'
  | 'large_unclassified'
  | 'possible_missing_conversion';

/** 8.5's "Class" column. `info` is neither blocking nor advisory. */
export type IssueClass = 'blocking' | 'advisory' | 'info';

export const ISSUE_CLASS: Readonly<Record<IssueKey, IssueClass>> = {
  missing_month_end: 'blocking',
  first_balance: 'info',
  flow_without_cash_account: 'blocking',
  unexplained_inflow: 'blocking',
  possible_missing_interest: 'advisory',
  suggested_income_missing: 'advisory',
  // 8.5: "blocking for MTD only", and v2.1.10 30.13 item 5 makes it global —
  // the whole month-to-date result is unavailable, with no totals at all.
  mtd_no_common_date: 'blocking',
  mtd_newer_balances: 'advisory',
  large_unclassified: 'advisory',
  possible_missing_conversion: 'advisory',
};

/**
 * One qualifying source bucket of a `possible_missing_conversion` advisory
 * (8.5, 30.15 items 6–9).
 *
 * What a later "link as cross-currency transfer" needs and nothing more: the
 * two native residuals the prefill uses — `U2` leaving the source, `X` arriving
 * at the destination — and the evidence the suggestion rests on, `X2` and the
 * month's average rate that produced it. `X2` is evidence, never a prefill: the
 * monthly average says the two residuals look like one transfer, not what the
 * bank's rate was. There is no `approximate` here because a completed month's
 * average is available or absent and never approximate (30.17 item 7).
 */
export interface ConversionCandidate {
  /** `C2`, the bucket whose positive residual is the spending spike. */
  readonly sourceCurrency: CurrencyCode;
  /** `C1`, the bucket whose negative residual is the unexplained inflow. */
  readonly destinationCurrency: CurrencyCode;
  /** `U2`, in `C2`: the source bucket's own `unclassified`. */
  readonly sourceAmount: Decimal;
  /** `X`, in `C1`: `−unclassified` of the destination bucket. */
  readonly destinationAmount: Decimal;
  /** `X2`, in `C2`: `X` converted at M's monthly-average cross rate. */
  readonly comparisonAmount: Decimal;
  /** The `C1 → C2` rate `X2` was computed with, and its evidence (10.2). */
  readonly rate: Decimal;
  readonly rateDate: PlainDate;
  readonly rateSource: string;
}

export interface Issue {
  readonly key: IssueKey;
  readonly class: IssueClass;
  /**
   * The bucket this is about. Absent only for the two `mtd_*` keys, which are
   * facts about the month's evidence date rather than about one currency
   * (30.13 items 3 and 5).
   */
  readonly currency?: CurrencyCode;
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
  /** `mtd_newer_balances`: the accounts whose newer evidence could not move `D`. */
  readonly positionIds?: readonly string[];
  /**
   * `possible_missing_conversion`: every qualifying source bucket, once each,
   * ordered by source currency code ascending (30.15 item 9). Present on that
   * key alone, and never empty there — no candidate means no advisory.
   */
  readonly candidates?: readonly ConversionCandidate[];
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
 * 8.9's totals, and what each one is a total *of*.
 *
 * ## The reconciliation scope
 *
 * The four role sums are taken over one set, fixed by 8.1 before any statement
 * balance is consulted: the month's tracked-cash legs of this currency that are
 * attributed to a **participating, non-`first_balance`** account, plus every
 * leg with no account named. 8.1 excludes a `first_balance` account "and their
 * attributed flow legs" from M, which is a fact about that account's opening
 * state and does not depend on what the other accounts' statements say.
 *
 * That set is 8.2's "attributed to included accounts, or null-leg" wherever 8.2
 * applies: 8.3 only computes the identity when no participating, non-excluded
 * account has a `carried` or `missing` end, and then the included accounts are
 * exactly the participating ones less the `first_balance` ones. So the scope is
 * one thing in every status, not two things wearing one name.
 *
 * A leg naming an account that does not participate in M is in neither part of
 * that set, and so is in no sum. Phase 3 cannot write one (20.1 keeps a flow
 * inside its account's window); this is the read-side answer for legacy or
 * externally corrupted rows.
 */
export interface BucketTotals {
  /** `ΣI`. **Always exact**, over the scope above, in every status. */
  readonly externalInflows: Decimal;
  /** `ΣNin`. **Always exact**, over the scope above, in every status. */
  readonly nonIncomeInflows: Decimal;
  /** `ΣNout`. **Always exact**, over the scope above, in every status. */
  readonly nonExpenseOutflows: Decimal;
  /**
   * `ΣK`. **Always exact**, over the scope above, in every status.
   *
   * Zero here is a **measured** zero: it means no known tracked expense was
   * recorded in this currency and month, never "unknown". None of these four
   * needs balance evidence, so none of them is ever a stand-in for a figure
   * that could not be computed.
   */
  readonly knownTrackedExpenses: Decimal;
  /**
   * `Δ` — 8.2's `Σ_{a ∈ included} (close_a − open_a)`, over the **complete**
   * included set, or **absent** (v2.1.9 30.12).
   *
   * One meaning, never a partial one. It is present exactly when the bucket
   * reconciled — `reliable`, `estimated` and `unresolved` alike, since
   * `unresolved` is an answer rather than an evidence failure — and absent
   * whenever 8.3 stopped short of computing it: an account with a `carried` or
   * `missing` end, no included account, or no participating account at all.
   *
   * Absent specifically rather than zero. Zero is a real answer here — the
   * complete included set exists and moved by exactly nothing — and it has to
   * stay available to say that. A sum over whichever accounts happened to have
   * endpoints would be a different quantity wearing this one's name, and in the
   * result nothing would distinguish it from the `Δ` of the identity.
   */
  readonly cashDelta?: Decimal;
  /**
   * `ΣI + ΣNin − ΣNout − Δ`. **Absent** — never zero — whenever `cashDelta` is,
   * because it is derived from it and from balance evidence that was not there
   * (8.4).
   */
  readonly trackedTotalSpending?: Decimal;
  /**
   * `trackedTotalSpending − ΣK`. **Absent** on exactly the same condition, and
   * for the same reason.
   */
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
