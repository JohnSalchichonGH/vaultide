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
  readonly currency: string;
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

export interface ReconciliationTotalsDto {
  readonly externalInflows: MoneyDto;
  readonly nonIncomeInflows: MoneyDto;
  readonly nonExpenseOutflows: MoneyDto;
  readonly knownTrackedExpenses: MoneyDto;
  readonly cashDelta: MoneyDto;
  /** `null` when the bucket is `unavailable` — unknown is never zero. */
  readonly trackedTotalSpending: MoneyDto | null;
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
