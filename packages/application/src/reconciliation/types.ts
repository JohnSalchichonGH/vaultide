import type { MoneyDto } from '@vaultide/finance';

/**
 * Completed-month reconciliation DTOs (blueprint 8.9).
 *
 * Serializable, native-currency and honest about what is unknown: a figure the
 * engine could not compute is `null` with a status and a reason beside it, never
 * a zero the interface would draw as a bar of no spending (7.6, 16.2).
 *
 * Nothing here is stored. 5.3 makes the source rows the only truth, so a month
 * is recomputed on every read and a balance corrected six months late simply
 * changes what every later month says.
 */

export type ReconciliationStatusDto =
  | 'reliable'
  | 'estimated'
  | 'provisional'
  | 'unavailable'
  | 'unresolved';

export type IssueClassDto = 'blocking' | 'advisory' | 'info';

export interface ReconciliationIssueDto {
  readonly key: string;
  readonly class: IssueClassDto;
  /** `null` only for the two `mtd_*` keys, which are about the month's evidence date. */
  readonly currency: string | null;
  readonly positionId: string | null;
  readonly positionName: string | null;
  readonly amount: MoneyDto | null;
  /** 8.5's two readings of `unexplained_inflow`. */
  readonly variant: 'a' | 'b' | null;
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly occurrenceDate: string | null;
  /**
   * What the schedule's term says this occurrence was for, when a term covers
   * it — the amount an "accept" would prefill (12.6, 30.9). `null` when the
   * template had no term in force on that date; unknown, not zero.
   */
  readonly expectedAmount: MoneyDto | null;
  /** `mtd_newer_balances`: the accounts whose newer evidence could not move `D`. */
  readonly positionIds?: readonly string[] | null;
}

export interface ReconciliationAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly openState: string;
  readonly closeState: string;
  readonly opening: MoneyDto | null;
  readonly closing: MoneyDto | null;
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
  /** `(close − open) − Σ attributed flows`: a diagnostic, not an allocation. */
  readonly residual: MoneyDto | null;
}

/**
 * 8.9's totals. The finance package's `BucketTotals` carries the full
 * definition of each field; this mirrors it.
 *
 * The four role sums are taken over one set in every status: the month's
 * tracked-cash legs of this currency attributed to a participating,
 * non-`first_balance` account, plus every leg with no account named (8.1). They
 * need no balance evidence and are always exact, and a zero among them is a
 * measured zero.
 */
export interface ReconciliationTotalsDto {
  /** `ΣI`. Always exact, over the scope above. */
  readonly externalInflows: MoneyDto;
  /** `ΣNin`. Always exact, over the scope above. */
  readonly nonIncomeInflows: MoneyDto;
  /** `ΣNout`. Always exact, over the scope above. */
  readonly nonExpenseOutflows: MoneyDto;
  /** `ΣK`. Always exact, over the scope above; zero means no known expense. */
  readonly knownTrackedExpenses: MoneyDto;
  /**
   * The exact cash change over the complete included account set, or `null`
   * when that cannot be computed (30.12). Never a partial change over the
   * accounts that happened to have endpoints.
   *
   * `null` and a zero are different answers: a zero means the complete set was
   * measured and moved by nothing.
   */
  readonly cashDelta: MoneyDto | null;
  /** `null` whenever `cashDelta` is — unknown is never zero. */
  readonly trackedTotalSpending: MoneyDto | null;
  /** `null` on the same condition, for the same reason. */
  readonly unclassified: MoneyDto | null;
}

export interface ReconciliationBucketDto {
  readonly currency: string;
  readonly status: ReconciliationStatusDto;
  readonly accounts: readonly ReconciliationAccountDto[];
  readonly totals: ReconciliationTotalsDto;
  /** `untracked_self` spending: real, and in none of the totals above (7.4). */
  readonly additionalSpending: MoneyDto;
  /** `third_party` spending: not the user's, and in no total at all. */
  readonly thirdPartyPaid: MoneyDto;
  readonly issues: readonly ReconciliationIssueDto[];
  readonly explanation: readonly string[];
}

export interface MonthReconciliationDto {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly status: ReconciliationStatusDto;
  readonly buckets: readonly ReconciliationBucketDto[];
}

/* -------------------------------------------------------------------------- */
/* Month to date (8.6, 8.9, v2.1.10 30.13)                                    */
/* -------------------------------------------------------------------------- */

/** How an account's value at the as-of date is known. */
export type MtdValueStateDto = 'snapshot' | 'closed_zero' | 'dormant_zero' | 'absent';

export interface MtdAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly openState: string;
  readonly opening: MoneyDto | null;
  readonly asOfState: MtdValueStateDto;
  readonly asOfAmount: MoneyDto | null;
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
  /** It owed an exact snapshot at the as-of date for the month to reach it. */
  readonly snapshotRequired: boolean;
  /** Exact evidence after the as-of date that could not move it (30.13 item 11). */
  readonly newerBalanceOn: string | null;
}

export interface MtdBucketDto {
  readonly currency: string;
  /** 8.6: only `provisional`, `unresolved` or `unavailable`. */
  readonly status: ReconciliationStatusDto;
  /** Why this one bucket could not be reconciled through the shared date. */
  readonly reason: 'missing_opening' | null;
  readonly accounts: readonly MtdAccountDto[];
  readonly totals: ReconciliationTotalsDto;
  readonly additionalSpending: MoneyDto;
  readonly thirdPartyPaid: MoneyDto;
  readonly issues: readonly ReconciliationIssueDto[];
  readonly explanation: readonly string[];
}

/**
 * The current month's month-to-date result.
 *
 * `asOf` is `null` exactly when no common evidence date exists, and then
 * `buckets` is `null` too — there is no interval, so there is no total of any
 * kind to report, and 30.13 item 5 forbids inventing one over some other
 * cut-off. The interface shows the reason instead.
 */
export interface MonthToDateDto {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly asOf: string | null;
  readonly status: ReconciliationStatusDto;
  readonly reason: 'mtd_no_common_date' | null;
  readonly buckets: readonly MtdBucketDto[] | null;
  readonly accountsWithNewerBalances: readonly string[];
  readonly issues: readonly ReconciliationIssueDto[];
}

/* -------------------------------------------------------------------------- */
/* Multi-month spans (8.7, v2.1.11 30.14)                                     */
/* -------------------------------------------------------------------------- */

/** 8.7: a span is `reliable` or `unresolved`, and nothing else can be one. */
export type SpanStatusDto = 'reliable' | 'unresolved';

export interface SpanAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly openingState: 'month_end' | 'opened_zero' | 'closed_zero' | 'dormant_zero';
  readonly opening: MoneyDto;
  readonly closingState: 'month_end' | 'closed_zero' | 'dormant_zero';
  readonly closing: MoneyDto;
}

/** Every figure a span reports. All five are exact; none is ever absent. */
export interface SpanTotalsDto {
  readonly externalInflows: MoneyDto;
  readonly nonIncomeInflows: MoneyDto;
  readonly nonExpenseOutflows: MoneyDto;
  readonly knownTrackedExpenses: MoneyDto;
  readonly cashDelta: MoneyDto;
}

/**
 * One native-currency reconciliation over a multi-month interval.
 *
 * Deliberately smaller than a month's result. There is no `issues` array, no
 * per-account residual, no `unavailable` branch and no `estimated` status —
 * each absence is a rule of 8.7 rather than an omission (30.14).
 *
 * There is also **no per-month figure**, and none should be derived downstream:
 * R21 states that a span is never averaged or attributed to a single month. The
 * interval total and `months` are what an interface shows.
 */
export interface SpanDto {
  readonly currency: string;
  /** First day of the month after the opening anchor. */
  readonly from: string;
  /** Last day of the closing anchor's month. */
  readonly to: string;
  /** The months covered, as `YYYY-MM`, in order. */
  readonly months: readonly string[];
  readonly status: SpanStatusDto;
  readonly accounts: readonly SpanAccountDto[];
  readonly totals: SpanTotalsDto;
  readonly trackedTotalSpending: MoneyDto;
  readonly unclassified: MoneyDto;
  /** `untracked_self` over the interval. Never in the identity (7.4). */
  readonly additionalSpending: MoneyDto;
  /** `third_party` over the interval. In no total at all. */
  readonly thirdPartyPaid: MoneyDto;
  readonly explanation: readonly string[];
}
