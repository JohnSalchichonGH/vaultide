import type {
  MonthCompletenessDto,
  MonthReconciliationDto,
  MonthReportingCashFlowDto,
  MonthToDateDto,
  MonthToDateReportingCashFlowDto,
} from '../reconciliation/types';

/**
 * The Monthly page's read model (blueprint 15.2, 15.3).
 *
 * One month, in one of two shapes. Every financial part is the authoritative
 * read's own DTO, carried unchanged: this module composes, it never restates a
 * figure, a status or an issue. The review state beside them is the user's own
 * and changes none of them.
 */

/**
 * What the user has recorded about a month (5.1 MonthReview, 20.3).
 *
 * Presentation state, never a financial fact: a review mark locks nothing and
 * completes nothing, and a dismissed key hides an advisory from the month's
 * normal presentation without removing it from any result.
 */
export interface MonthReviewDto {
  /** When the month was marked reviewed, as an ISO instant; `null` until then. */
  readonly reviewedAt: string | null;
  /**
   * The stored dismissal keys, sorted and each once. Opaque strings: a key this
   * version does not know is still listed, because it is still the user's.
   */
  readonly dismissedIssueKeys: readonly string[];
}

/** The months either side, as `YYYY-MM`. There is never a path into the future. */
export interface MonthlyNavigationDto {
  readonly previous: string;
  /** `null` on the current month: the month after it has not begun. */
  readonly next: string | null;
  /** The month containing today. */
  readonly current: string;
}

interface MonthlyPageBase {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The last day of the month, `YYYY-MM-DD`. */
  readonly monthEndsOn: string;
  /** The request's today in the user's timezone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly navigation: MonthlyNavigationDto;
  /** Minor units per currency, so every amount formats in its own scale. */
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  readonly review: MonthReviewDto;
}

/** A completed month (`today > end(M)`). */
export interface CompletedMonthlyPageDto extends MonthlyPageBase {
  readonly kind: 'completed';
  /** Exactly `getMonthReconciliation`'s answer, advisories included. */
  readonly reconciliation: MonthReconciliationDto;
  /** Exactly `getMonthReportingCashFlow`'s answer. */
  readonly reporting: MonthReportingCashFlowDto;
  /** Exactly `getMonthCompleteness`'s answer. */
  readonly completeness: MonthCompletenessDto;
}

/**
 * The month containing today. It has no completeness (12.6 is defined for
 * completed months only) and it cannot be marked reviewed.
 */
export interface CurrentMonthlyPageDto extends MonthlyPageBase {
  readonly kind: 'current';
  /** Exactly `getMonthToDate`'s answer. */
  readonly monthToDate: MonthToDateDto;
  /** Exactly `getMonthToDateReportingCashFlow`'s answer. */
  readonly reporting: MonthToDateReportingCashFlowDto;
}

export type MonthlyPageDto = CompletedMonthlyPageDto | CurrentMonthlyPageDto;
