import type { MoneyDto } from '@vaultide/finance';
import type { ExpenseCategoryDto, MonthlyExpensesDto } from '../monthly/types';
import type {
  MissingReportingContributionDto,
  ReconciliationStatusDto,
  ReportingAmountDto,
  ReportingCashFlowFiguresDto,
  ReportingSavingsRateDto,
  RollingAverageDto,
  SourceOnlyReportingFiguresDto,
  SpanDto,
} from '../reconciliation/types';

/**
 * The standalone Spending page's read model (blueprint 15.2 "Spending", 8.x,
 * 12.5, v2.1.17; ADR 0008).
 *
 * One server-authoritative answer per page. Every figure keeps the availability
 * its engine gave it — a `Partial` savings figure stays `Partial` here even
 * though the page chooses not to print it as a number (ADR 0008 §5) — and
 * nothing in it is meant to be added, split or averaged by a reader.
 */

/** A closed interval of financial dates, `YYYY-MM-DD` at both ends. */
export interface SpendingIntervalDto {
  readonly from: string;
  readonly to: string;
}

/** Why one currency of a month could not be reconciled, from its own evidence. */
export type SpendingBucketCauseDto =
  | 'missing_month_end'
  | 'missing_opening'
  | 'flow_without_cash_account'
  | 'first_balance'
  | 'unknown';

/**
 * One native-currency bucket of the focus month, reduced to what Spending says
 * about it: its status, why it could not be reconciled, the accounts whose
 * evidence is missing, and the unexplained inflow an unresolved bucket found.
 * The full identity stays Monthly's Reconciliation section's to show.
 */
export interface SpendingBucketDto {
  readonly currency: string;
  readonly status: ReconciliationStatusDto;
  /** Set exactly when `status` is `unavailable`. */
  readonly cause: SpendingBucketCauseDto | null;
  /** Accounts with a `missing_month_end` issue — the balances that would fix it. */
  readonly accountsMissingEvidence: readonly string[];
  /** Accounts left out as `first_balance` (8.1): first tracked in this month. */
  readonly firstBalanceAccounts: readonly string[];
  /** 8.5's `unexplained_inflow`, in the bucket's own currency. */
  readonly unexplainedInflow: { readonly amount: MoneyDto; readonly variant: 'a' | 'b' } | null;
}

/** A completed focus month. `observed` is whether any bucket exists (ADR 0008 §4). */
export interface SpendingFocusCompletedDto {
  readonly shape: 'completed';
  readonly month: string;
  readonly status: ReconciliationStatusDto;
  readonly observed: boolean;
  readonly interval: SpendingIntervalDto;
  readonly figures: ReportingCashFlowFiguresDto;
  readonly buckets: readonly SpendingBucketDto[];
}

/** The current month with a common date `D`: every figure is through `D`. */
export interface SpendingFocusCurrentTrackedDto {
  readonly shape: 'current';
  readonly month: string;
  /** 8.6: `provisional`, `unresolved` or `unavailable`, worst across buckets. */
  readonly status: ReconciliationStatusDto;
  readonly observed: true;
  readonly asOf: string;
  readonly interval: SpendingIntervalDto;
  readonly figures: ReportingCashFlowFiguresDto;
  readonly buckets: readonly SpendingBucketDto[];
  /** 8.5's `mtd_newer_balances`: some account has evidence after `D`. */
  readonly newerBalances: boolean;
}

/**
 * The current month with no common date: no tracked interval, so no tracked
 * figure of any kind (8.6). The two settlements that need no interval run
 * through today, and are their own facts (30.15 item 3).
 */
export interface SpendingFocusCurrentNoDateDto {
  readonly shape: 'current';
  readonly month: string;
  readonly status: 'unavailable';
  readonly observed: false;
  readonly asOf: null;
  readonly reason: 'mtd_no_common_date';
  readonly sourceOnly: SourceOnlyReportingFiguresDto;
  readonly sourceOnlyThrough: string;
}

export type SpendingFocusDto =
  | SpendingFocusCompletedDto
  | SpendingFocusCurrentTrackedDto
  | SpendingFocusCurrentNoDateDto;

export interface SpendingNavigationDto {
  /** `YYYY-MM`. There is always an earlier month. */
  readonly previous: string;
  /** `null` on the current month: the month after it has not begun. */
  readonly next: string | null;
  readonly currentMonth: string;
  readonly lastCompletedMonth: string;
}

/** One fixed calendar window of the rolling average (30.15 item 5). */
export interface SpendingRollingWindowDto {
  readonly months: 3 | 6 | 12;
  /** `YYYY-MM`, the window's first and last calendar seats. */
  readonly from: string;
  readonly to: string;
  /** `null` when no month in the window qualified — not an average of zero. */
  readonly average: RollingAverageDto | null;
}

export interface SpendingRollingDto {
  /** The completed month the windows end at. */
  readonly displayMonth: string;
  /** The focus is the current month, so the windows end at the last completed one (ADR 0008 §2). */
  readonly endsBeforeFocus: boolean;
  readonly windows: readonly SpendingRollingWindowDto[];
}

/**
 * One month of the history table and chart, oldest first.
 *
 * A figure is `null` only where no interval exists for it at all — the current
 * month with no common date. Everywhere else it is the engine's figure with its
 * own availability, `unavailable` included: never a zero standing in for one.
 */
export interface SpendingHistoryRowDto {
  readonly month: string;
  readonly shape: 'completed' | 'current';
  readonly status: ReconciliationStatusDto;
  readonly observed: boolean;
  /** The current month's `D`; `null` for a completed month and a current one without `D`. */
  readonly asOf: string | null;
  /** 30.15 item 5 and 30.16 item 11, decided by the rolling engine's own rule. */
  readonly rollingEligible: boolean;
  /** Spans covering this month, as `currency:from`, so a gap can point to its combined period. */
  readonly spans: readonly string[];
  readonly tracked: ReportingAmountDto | null;
  readonly known: ReportingAmountDto | null;
  readonly unclassified: ReportingAmountDto | null;
  readonly additional: ReportingAmountDto;
  readonly total: ReportingAmountDto | null;
  readonly thirdPartyPaid: ReportingAmountDto;
  readonly savingsRate: ReportingSavingsRateDto | null;
}

/** A span with a stable key, in its own native currency (ADR 0008 §8). */
export interface SpendingSpanDto extends SpanDto {
  /** `currency:from`. */
  readonly key: string;
}

/** Which of the page's groups a category belongs to (ADR 0008 §6). */
export type SpendingCategoryGroupDto = 'consumption' | 'cost' | 'money_out';

export interface SpendingCategoryRowDto {
  readonly categoryId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly group: SpendingCategoryGroupDto;
  /** Tracked known spending filed here, or `null` when none was. */
  readonly trackedKnown: ReportingAmountDto | null;
  /** Additional spending filed here, or `null` when none was. */
  readonly additional: ReportingAmountDto | null;
  /** Both together: the category's share of the focus month's known spending. */
  readonly total: ReportingAmountDto;
}

export interface SpendingCategoriesDto {
  /** The tracked interval the tracked rows belong to; `null` when there is none. */
  readonly trackedInterval: SpendingIntervalDto | null;
  /** The interval the additional rows were summed over. */
  readonly additionalInterval: SpendingIntervalDto;
  /**
   * `amount` when every category total is complete; otherwise `category`, the
   * user's own order, because an incomplete total is not an amount to sort by
   * (ADR 0008 §7).
   */
  readonly order: 'amount' | 'category';
  readonly rows: readonly SpendingCategoryRowDto[];
  /** The figures the rows explain, as reporting states them. */
  readonly knownTrackedSpending: ReportingAmountDto | null;
  readonly unclassified: ReportingAmountDto | null;
  readonly additionalSpending: ReportingAmountDto;
  /** Every contribution some row total could not state, each currency and reason once. */
  readonly missing: readonly MissingReportingContributionDto[];
}

/** How the largest-known rows were ordered (ADR 0008 §7). */
export type SpendingRankingModeDto =
  | 'reporting_currency'
  | 'per_native_currency'
  | 'source_only'
  | 'none';

export interface SpendingLargestRowDto {
  readonly entryId: string;
  readonly kind: 'consumption' | 'cost' | 'money_out' | 'additional';
  readonly categoryName: string;
  readonly description: string | null;
  readonly incurredOn: string;
  readonly cashAccountName: string | null;
  readonly native: MoneyDto;
  readonly reporting: ReportingAmountDto;
}

export interface SpendingLargestGroupDto {
  /** `null` for one reporting-currency ranking; the native code otherwise. */
  readonly currency: string | null;
  readonly rows: readonly SpendingLargestRowDto[];
}

export interface SpendingLargestKnownDto {
  readonly interval: SpendingIntervalDto;
  readonly mode: SpendingRankingModeDto;
  /**
   * `source_only` ranks additional rows through today only; this says whether
   * they could be ordered in the reporting currency or per native currency.
   */
  readonly perNativeCurrency: boolean;
  readonly groups: readonly SpendingLargestGroupDto[];
  /** Rows that could not be converted, each currency and reason once. */
  readonly missing: readonly MissingReportingContributionDto[];
}

/** What the page's Add known expense form offers — Monthly's own options. */
export interface SpendingExpenseFormDto {
  /** The focus month's days, never past today. */
  readonly bounds: { readonly min: string; readonly max: string };
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly cashAccounts: MonthlyExpensesDto['cashAccounts'];
}

export interface SpendingPageDto {
  /** The focus month, `YYYY-MM`. */
  readonly month: string;
  readonly today: string;
  readonly reportingCurrency: string;
  readonly countsAdditionalSpending: boolean;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /** Active, FX-supported currencies a picker may offer (10.5). */
  readonly selectableCurrencyCodes: readonly string[];
  /** Whether the user has any cash account at all, for the empty state. */
  readonly hasCashAccounts: boolean;
  readonly navigation: SpendingNavigationDto;
  readonly focus: SpendingFocusDto;
  readonly rolling: SpendingRollingDto;
  readonly history: readonly SpendingHistoryRowDto[];
  readonly spans: readonly SpendingSpanDto[];
  readonly categories: SpendingCategoriesDto;
  readonly largestKnown: SpendingLargestKnownDto;
  readonly expenseForm: SpendingExpenseFormDto;
}
