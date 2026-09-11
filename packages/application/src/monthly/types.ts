import type { MoneyDto } from '@vaultide/finance';
import type { CashMonthStateDto, PositionStatusDto, ValueStateDto } from '../positions/types';
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

/* -------------------------------------------------------------------------- */
/* Accounts (15.3 section 4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An account's opening for the month — its Previous cell (8.1, 8.6).
 *
 * One shape for both kinds of month, each decided by its own authority: Phase
 * 2's `cashMonthState` for a completed month, the month-to-date engine's
 * opening for the current one. Every variant is one of those states; none is a
 * state of its own, and unknown evidence has no amount at all.
 */
export type AccountOpeningDto =
  /** The statement balance at the end of the previous month. */
  | { readonly kind: 'statement'; readonly amount: MoneyDto; readonly valuedOn: string }
  /**
   * Zero by definition rather than by evidence: the account opened in the
   * month, is dormant, or closed (R22, 8.1).
   */
  | { readonly kind: 'opened_zero' }
  | { readonly kind: 'dormant_zero' }
  | { readonly kind: 'closed_zero' }
  /**
   * A pre-existing account first tracked in the month. Excluded from the
   * month's arithmetic — never an opening of zero (8.1, 8.6).
   */
  | { readonly kind: 'first_balance' }
  /** No statement at the end of the previous month: unknown, never zero. */
  | { readonly kind: 'no_statement'; readonly state: 'carried' | 'missing' };

/**
 * A completed month's Current cell: the balance at `end(M)` (15.3 section 4).
 *
 * The variant follows the month's closing state (8.1) and carries what an edit
 * of it needs. It says what to offer; every action checks again on the server.
 */
export type CompletedClosingDto =
  /** A statement balance exists: corrected in place, against its version. */
  | {
      readonly kind: 'statement';
      readonly valuationId: string;
      readonly version: number;
      readonly amount: MoneyDto;
      /** Written by "Unchanged this month" rather than typed. */
      readonly confirmedUnchanged: boolean;
    }
  /**
   * An ordinary snapshot dated the month's last day (8.8). Not a statement
   * until it is confirmed as one; typing the statement figure instead corrects
   * this row, because a second valuation on the same date cannot exist (M1).
   */
  | {
      readonly kind: 'last_day_snapshot';
      readonly valuationId: string;
      readonly version: number;
      readonly amount: MoneyDto;
    }
  /** No statement and nothing on the last day: one can be entered. */
  | {
      readonly kind: 'no_statement';
      readonly state: 'carried' | 'missing';
      /** The latest ordinary snapshot inside the month: a hint, never a statement. */
      readonly latestSnapshot: { readonly amount: MoneyDto; readonly valuedOn: string } | null;
      /** The previous month's statement exists to carry forward (8.1, R22). */
      readonly canConfirmUnchanged: boolean;
    }
  /** Zero by definition: closed inside the month, or dormant (R22). */
  | { readonly kind: 'closed_zero' }
  | { readonly kind: 'dormant_zero' };

/** One cash account taking part in a completed month (8.1). */
export interface CompletedAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly currency: string;
  readonly dormant: boolean;
  /** Exactly the month state the Accounts pages read, from the same helper (8.1). */
  readonly state: CashMonthStateDto;
  readonly opening: AccountOpeningDto;
  readonly closing: CompletedClosingDto;
}

export interface CompletedAccountsDto {
  /** `YYYY-MM` of the month whose statements are the openings. */
  readonly previousMonth: string;
  /** Every cash account taking part in the month, in the user's order. */
  readonly accounts: readonly CompletedAccountDto[];
}

/** An account's latest balance on record, valued at today as Phase 2 values it (12.1). */
export interface LatestBalanceDto {
  readonly state: ValueStateDto;
  /** `null` exactly when nothing is recorded: unknown, never zero. */
  readonly amount: MoneyDto | null;
  /** The balance's own date — never implied to be today's. */
  readonly valuedOn: string | null;
  /** It is a statement month-end balance rather than a snapshot. */
  readonly statement: boolean;
}

/** One cash account taking part in the current month (8.1). */
export interface CurrentAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly currency: string;
  readonly status: PositionStatusDto;
  readonly dormant: boolean;
  /** 8.6's opening, by the month-to-date engine's own rule. */
  readonly opening: AccountOpeningDto;
  readonly latest: LatestBalanceDto;
  /** Today's snapshot, which "Update today" corrects rather than duplicates (M1). */
  readonly todaySnapshot: {
    readonly valuationId: string;
    readonly version: number;
    readonly amount: MoneyDto;
  } | null;
  /** Active and not dormant: what "Update today" may write (15.3, R22). */
  readonly canUpdateToday: boolean;
}

export interface CurrentAccountsDto {
  /** `YYYY-MM` of the month whose statements are the openings. */
  readonly previousMonth: string;
  /**
   * The first day this month's statement balances can be entered: the day
   * after it ends. Never earlier, not even on its last day (M5, R15).
   */
  readonly closableFrom: string;
  /** Every cash account taking part in the month, in the user's order. */
  readonly accounts: readonly CurrentAccountDto[];
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
  /** The month's cash accounts, from the rows the reconciliation read. */
  readonly accounts: CompletedAccountsDto;
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
  /** The month's cash accounts, from the rows the month-to-date read loaded. */
  readonly accounts: CurrentAccountsDto;
}

export type MonthlyPageDto = CompletedMonthlyPageDto | CurrentMonthlyPageDto;
