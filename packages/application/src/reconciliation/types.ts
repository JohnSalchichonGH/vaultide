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

/**
 * One qualifying source of a `possible_missing_conversion` advisory (8.5,
 * 30.15 item 9).
 *
 * `sourceAmount` (`U2`, in the source currency) and `destinationAmount` (`X`,
 * in the destination currency) are the two native residuals a prefilled
 * transfer uses. `comparisonAmount` (`X2`, in the source currency) and the
 * rate are the evidence the suggestion rests on — the month's average, never
 * a claim about the bank's rate — and are not prefilled. A completed month's
 * average is never approximate, so no such flag exists here (30.17 item 7).
 */
export interface ConversionCandidateDto {
  readonly sourceCurrency: string;
  readonly destinationCurrency: string;
  readonly sourceAmount: MoneyDto;
  readonly destinationAmount: MoneyDto;
  readonly comparisonAmount: MoneyDto;
  readonly rate: string;
  readonly rateDate: string;
  readonly rateSource: string;
}

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
  /**
   * `possible_missing_conversion`: every qualifying source once, ordered by
   * source currency code ascending. Present on that key alone, never empty.
   */
  readonly candidates?: readonly ConversionCandidateDto[];
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
 *
 * And no `additionalSpending`, `thirdPartyPaid`, `accounts` or `explanation`.
 * A month's bucket reports the first two, because a month is where 7.4 places
 * them; 8.7 lists none of the four for a span. The spending figures are not in
 * the identity, so beside `trackedTotalSpending` they invite a sum that means
 * nothing; the account states are the calculation graph behind
 * `totals.cashDelta`; and the explanation is prose a read model can write from
 * the exact figures when it needs to, rather than English frozen into the API
 * before anything asks for it.
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
  readonly totals: SpanTotalsDto;
  readonly trackedTotalSpending: MoneyDto;
  readonly unclassified: MoneyDto;
}

/* -------------------------------------------------------------------------- */
/* Savings and the spending decomposition (12.3, 12.5, v2.1.12 30.15)         */
/* -------------------------------------------------------------------------- */

/**
 * The eight classifications that hold whatever the balances did.
 *
 * Each is a sum or a partition of source records, so 30.12's rule reaches them
 * exactly as it reaches the role sums: they need no balance evidence, they are
 * exact in every status, and a zero among them is a measured zero. A month
 * whose statement is missing still knows what its own records said.
 */
export interface SavingsSourceDto {
  /** The part of the bucket's `ΣI` that 12.5 counts as income. */
  readonly externalIncome: MoneyDto;
  /** `ΣK` less the four buckets below — the remainder, never an input. */
  readonly knownConsumption: MoneyDto;
  readonly propertyOperatingCosts: MoneyDto;
  readonly interestAndFees: MoneyDto;
  readonly transactionCosts: MoneyDto;
  readonly externalOutflows: MoneyDto;
  /** `untracked_self` over the same interval the figures above used. */
  readonly additionalSpending: MoneyDto;
  /** `third_party` over the same interval. In no total at all. */
  readonly thirdPartyPaid: MoneyDto;
}

/**
 * `PersonalSavings / ExternalIncome` — an exact unrounded ratio as a decimal
 * string, never a JS number and never a percentage. 7.3 puts rounding at the
 * display boundary, so "58.24 %" is made where it is shown.
 */
export type SavingsRateDto =
  | { readonly kind: 'ratio'; readonly value: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * 12.5's five derived figures, present together or absent together.
 *
 * A discriminated union rather than five nullable fields, so there is no shape
 * in which a personal-savings figure is readable without the consumption it was
 * derived from, and none in which an `unresolved` bucket carries a total
 * spending figure at all (30.15 item 1).
 */
export type SavingsDerivedDto =
  | {
      readonly kind: 'available';
      /** The reconciliation quality these inherit; never a second status order. */
      readonly quality: 'reliable' | 'estimated' | 'provisional';
      readonly consumption: MoneyDto;
      readonly trackedSavingsFromIncome: MoneyDto;
      readonly personalSavings: MoneyDto;
      readonly totalSpending: MoneyDto;
      readonly savingsRate: SavingsRateDto;
      /** Whether the rate counts additional spending, so a reader can label it. */
      readonly countsAdditionalSpending: boolean;
    }
  | {
      readonly kind: 'unavailable';
      /**
       * Two reasons and not one: `unresolved` computed an identity that
       * contradicts itself, `reconciliation_unavailable` never reached the
       * identity. Telling a user the same thing about both would be wrong.
       */
      readonly because: 'unresolved' | 'reconciliation_unavailable';
    };

/** One native-currency savings result, beside its reconciliation bucket. */
export interface NativeSavingsDto {
  readonly currency: string;
  readonly reconciliationStatus: ReconciliationStatusDto;
  readonly source: SavingsSourceDto;
  readonly derived: SavingsDerivedDto;
}

/**
 * A currency in which the user recorded spending but reconciles nothing.
 *
 * `untracked_self` and `third_party` carry no cash role (7.4), so neither needs
 * a cash account of that currency to exist — and a currency with no account has
 * no bucket. The amounts are real and are reported as themselves; no
 * reconciliation bucket is fabricated to carry them, and no `Consumption`,
 * `TotalSpending`, `PersonalSavings` or `SavingsRate` is invented for a
 * currency that never reconciled.
 */
export interface SourceOnlySpendingDto {
  readonly currency: string;
  readonly additionalSpending: MoneyDto;
  readonly thirdPartyPaid: MoneyDto;
}

/** A completed month's savings, per native currency. */
export interface MonthSavingsDto {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly buckets: readonly NativeSavingsDto[];
  readonly sourceOnlyByCurrency: readonly SourceOnlySpendingDto[];
}

/**
 * The current month's savings, through the one date the evidence reaches.
 *
 * `buckets` is `null` exactly when no common date exists: 8.6 leaves no
 * month-to-date interval then, so there is nothing to derive savings from. The
 * two source-only settlements survive that, because neither depends on
 * reconciliation — they are reported over `[start(M), today]` instead, and
 * `sourceOnlyThrough` says so rather than letting a reader assume a date the
 * result does not have (30.15 item 3).
 */
export interface MonthToDateSavingsDto {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly asOf: string | null;
  readonly buckets: readonly NativeSavingsDto[] | null;
  readonly sourceOnlyByCurrency: readonly SourceOnlySpendingDto[];
  /** The last day the source-only figures include: `asOf` when it exists, else today. */
  readonly sourceOnlyThrough: string;
}

/* -------------------------------------------------------------------------- */
/* Reporting-currency cash flow (12.3, 12.5, 8.11, v2.1.13 30.16)             */
/* -------------------------------------------------------------------------- */

/** A contribution that is not inside a figure, and the currency it came from. */
export interface MissingReportingContributionDto {
  readonly currency: string;
  readonly reason: string;
  readonly detail?: string;
}

/** How the rates behind a figure were found. Never a status, never an availability. */
export interface FxProvenanceDto {
  /** A residual converted at an average rate (8.11). */
  readonly estimatedConversion: boolean;
  /** Some lookup fell back rather than averaging, or fell off its own date. */
  readonly approximate: boolean;
  /** Every lookup landed exactly on the date asked for. */
  readonly exact: boolean;
}

/**
 * One reporting-currency figure.
 *
 * Availability is this figure's own, over the contributions its formula
 * consumes: a missing rate for a memo nobody totals leaves the savings rate
 * alone, and a missing rate for additional spending leaves personal savings
 * alone when the setting is off (30.16 item 7). `value` is the exact sum of what
 * could be stated and is never the whole figure when `availability` says
 * otherwise.
 */
export interface ReportingAmountDto {
  readonly value: MoneyDto;
  readonly availability: 'available' | 'partial' | 'unavailable';
  readonly missing: readonly MissingReportingContributionDto[];
  /** The reconciliation quality of the native derived figures feeding this one. */
  readonly quality?: 'reliable' | 'estimated' | 'provisional';
  readonly provenance: FxProvenanceDto;
}

/**
 * `PersonalSavings / ExternalIncome` as an exact unrounded decimal string, or
 * unavailable — never partial, and never a percentage: 7.3 rounds at the display
 * boundary, so "58.24 %" is made where it is shown.
 */
export type ReportingSavingsRateDto =
  | { readonly kind: 'ratio'; readonly value: string }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly detail?: string };

/**
 * The two figures that need no tracked interval (7.4, 30.15 item 3).
 *
 * `untracked_self` and `third_party` carry no cash role, so neither was ever
 * scoped and neither is summed over a reconciled interval. They are their own
 * type because they are exactly what survives when there is no interval at all,
 * and because a reader can then reach them without asking whether one exists.
 */
export interface SourceOnlyReportingFiguresDto {
  readonly reportingCurrency: string;
  /** `untracked_self` over the interval the figures beside it used. */
  readonly additionalSpending: ReportingAmountDto;
  /** `third_party` over the same interval. In no total at all. */
  readonly thirdPartyPaid: ReportingAmountDto;
}

/** The fifteen figures 12.5 states, in the reporting currency. */
export interface ReportingCashFlowFiguresDto extends SourceOnlyReportingFiguresDto {
  readonly externalIncome: ReportingAmountDto;
  readonly knownConsumption: ReportingAmountDto;
  readonly propertyOperatingCosts: ReportingAmountDto;
  readonly interestAndFees: ReportingAmountDto;
  readonly transactionCosts: ReportingAmountDto;
  readonly externalOutflows: ReportingAmountDto;
  readonly unclassified: ReportingAmountDto;
  readonly consumption: ReportingAmountDto;
  readonly trackedTotalSpending: ReportingAmountDto;
  readonly trackedSavingsFromIncome: ReportingAmountDto;
  readonly personalSavings: ReportingAmountDto;
  readonly totalSpending: ReportingAmountDto;
  readonly savingsRate: ReportingSavingsRateDto;
  /** Whether the rate counts additional spending, so a reader can label it. */
  readonly countsAdditionalSpending: boolean;
}

/** A completed month, reported once. The unit a later rolling slice consumes. */
export interface MonthReportingCashFlowDto extends ReportingCashFlowFiguresDto {
  /** `YYYY-MM`. */
  readonly month: string;
  /** 8.4's worst-across-buckets status for the month, in native terms. */
  readonly monthStatus: ReconciliationStatusDto;
}

/** The current month with a `D`, so every figure 12.5 states exists. */
export interface MonthToDateTrackedReportingDto extends ReportingCashFlowFiguresDto {
  readonly kind: 'tracked_interval';
  /** `YYYY-MM`. */
  readonly month: string;
  /** `D`, the common date the tracked figures are stated through (8.6). */
  readonly asOf: string;
  readonly monthStatus: ReconciliationStatusDto;
  /** `D` as well: the two settlements used the same cut-off their neighbours did. */
  readonly sourceOnlyThrough: string;
}

/**
 * The current month with **no** `D`, and therefore no tracked interval (8.6).
 *
 * There is no cash-flow object here at all. Not one whose fields are
 * unavailable, and certainly not one whose fields are zero: a zero is an answer,
 * and a month with no interval has answered nothing about income, consumption,
 * spending or savings. `TotalSpending` is not `AdditionalSpending`, because the
 * formula that says so needs the interval that does not exist.
 *
 * The two settlements are still real — they were never scoped and never needed
 * one — so they are reported over `[start(M), today]`, which is what
 * `sourceOnlyThrough` names (30.15 item 3, 30.16 item 6).
 */
export interface MonthToDateSourceOnlyReportingDto extends SourceOnlyReportingFiguresDto {
  readonly kind: 'no_tracked_interval';
  /** `YYYY-MM`. */
  readonly month: string;
  readonly asOf: null;
  /** 8.6's own reason, carried from the reconciliation engine unchanged. */
  readonly reason: 'mtd_no_common_date';
  readonly monthStatus: 'unavailable';
  /** `today`: the two settlements run to the end of the month so far. */
  readonly sourceOnlyThrough: string;
}

/**
 * The current month, reported through `D` when there is one.
 *
 * A discriminated union and not a flag beside a full result, for the same reason
 * `SavingsDerivedDto` is one: there must be no shape in which a tracked figure
 * can be read without first establishing that a tracked interval exists. The two
 * source-only figures sit in both variants at the same path, because those are
 * the two that never depended on it.
 */
export type MonthToDateReportingCashFlowDto =
  | MonthToDateTrackedReportingDto
  | MonthToDateSourceOnlyReportingDto;

/* -------------------------------------------------------------------------- */
/* Rolling tracked spending (15.2, 15.5, v2.1.12 30.15 item 5)                 */
/* -------------------------------------------------------------------------- */

/**
 * One rolling average and the number of qualifying months it is over.
 *
 * The count is the coverage signal 30.15 specifies: a three-month window that
 * holds one observation says `count: 1` rather than pretending to three. There
 * is no status on an average — a month either qualified or it did not, and the
 * ones that did are complete by definition.
 */
export interface RollingAverageDto {
  readonly value: MoneyDto;
  /** `1 … N`. */
  readonly count: number;
}

/**
 * One completed display month's 3-, 6- and 12-month rolling tracked spending
 * in the reporting currency.
 *
 * `null` means no month in that calendar window qualified; an average of zero
 * over months that did is `{ value: 0, count: n }`. The two are never the same
 * answer.
 */
export interface RollingTrackedSpendingPointDto {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly reportingCurrency: string;
  readonly rolling3: RollingAverageDto | null;
  readonly rolling6: RollingAverageDto | null;
  readonly rolling12: RollingAverageDto | null;
}
