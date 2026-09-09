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
   * The bucket's cash change when `status` says it reconciled. When `status` is
   * `unavailable` this is a **partial diagnostic** covering only the accounts
   * that had usable endpoints, and the interface must not show it as the
   * bucket's cash change.
   */
  readonly cashDelta: MoneyDto;
  /** `null` when the bucket is `unavailable` — unknown is never zero. */
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
