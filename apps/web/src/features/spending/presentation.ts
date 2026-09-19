import type { Route } from 'next';
import type {
  ReportingAmountDto,
  ReportingSavingsRateDto,
  SpendingBucketDto,
  SpendingCategoryGroupDto,
  SpendingFocusDto,
  SpendingHistoryRowDto,
  SpendingLargestRowDto,
  SpendingPageDto,
  SpendingRankingModeDto,
} from '@vaultide/application';
import { STATUS_LABEL, STATUS_TONE, missingSummary, savingsRateReason } from '@/features/monthly/presentation';

/**
 * How the Spending page says what its read returned (blueprint 15.2 "Spending",
 * 16.2; ADR 0008).
 *
 * Words and display decisions only — never a financial figure. Every amount
 * arrives decided, with its own availability; what is chosen here is how an
 * incomplete one reads, and the rule is ADR 0008 §5:
 *
 *  - a **spending** figure that is partial is a lower bound, because every
 *    contribution missing from it is non-negative, so it reads `≥ €X` — unless
 *    nothing above zero could be stated, when `≥ €0` would say nothing and it
 *    reads `—` instead;
 *  - a **savings** figure that is partial is not a bound in either direction —
 *    a missing expense would make it smaller — so it reads `—` with the reason,
 *    whatever value the DTO carries.
 */

export type FigureDisplay =
  | { readonly kind: 'value'; readonly amount: string; readonly currency: string }
  | { readonly kind: 'at_least'; readonly amount: string; readonly currency: string; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string };

const NOTHING_TO_STATE = 'No cash account took part in this month.';

function reasonOf(amount: ReportingAmountDto): string {
  const missing = missingSummary(amount.missing);
  return missing === '' ? NOTHING_TO_STATE : `Not included: ${missing}.`;
}

const isZero = (amount: string): boolean => /^-?0(\.0+)?$/u.test(amount.trim());

/** A spending figure: exact, a lower bound, or nothing (ADR 0008 §5). */
export function spendingFigureDisplay(amount: ReportingAmountDto): FigureDisplay {
  const { value } = amount;
  switch (amount.availability) {
    case 'available':
      return { kind: 'value', amount: value.amount, currency: value.currency };
    case 'partial':
      return isZero(value.amount)
        ? { kind: 'none', reason: reasonOf(amount) }
        : { kind: 'at_least', amount: value.amount, currency: value.currency, reason: reasonOf(amount) };
    case 'unavailable':
      return { kind: 'none', reason: reasonOf(amount) };
  }
}

/**
 * A savings figure: exact or nothing. A partial one is withheld, not printed —
 * the DTO keeps it partial, and Monthly shows it with its badge (ADR 0008 §5).
 */
export function savingsFigureDisplay(amount: ReportingAmountDto): FigureDisplay {
  if (amount.availability === 'available') {
    return { kind: 'value', amount: amount.value.amount, currency: amount.value.currency };
  }
  const why = reasonOf(amount);
  return {
    kind: 'none',
    reason:
      amount.availability === 'partial'
        ? `Not shown: part of this month could not be stated, and a savings figure without it is not a lower bound. ${why}`
        : why,
  };
}

export type RateDisplay =
  | { readonly kind: 'value'; readonly ratio: string }
  | { readonly kind: 'none'; readonly reason: string };

/** The savings rate is a quotient and never partial (12.5): a ratio or a reason. */
export function savingsRateDisplay(rate: ReportingSavingsRateDto | null): RateDisplay {
  if (rate === null) return { kind: 'none', reason: 'There is no interval to measure it over yet.' };
  return rate.kind === 'ratio'
    ? { kind: 'value', ratio: rate.value }
    : { kind: 'none', reason: savingsRateReason(rate.reason, rate.detail) };
}

/* -------------------------------------------------------------------------- */
/* A month's state                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a month is, for the table and the chart: the reconciliation status, plus
 * the two states that are not statuses. `not_observed` is a completed month with
 * no bucket (ADR 0008 §4); `no_common_date` is the current month without a `D`.
 */
export type SpendingMonthState =
  | 'reliable'
  | 'estimated'
  | 'provisional'
  | 'unresolved'
  | 'unavailable'
  | 'not_observed'
  | 'no_common_date';

export function monthStateOf(
  row: Pick<SpendingHistoryRowDto, 'shape' | 'asOf' | 'observed' | 'status'>,
): SpendingMonthState {
  if (row.shape === 'current' && row.asOf === null) return 'no_common_date';
  if (!row.observed) return 'not_observed';
  return row.status;
}

/** Monthly's own words for the five statuses, and two for the states that are not one. */
export const MONTH_STATE_LABEL: Readonly<Record<SpendingMonthState, string>> = {
  ...STATUS_LABEL,
  not_observed: 'Not tracked',
  no_common_date: 'No common date',
};

export const MONTH_STATE_TONE = {
  ...STATUS_TONE,
  not_observed: 'neutral',
  no_common_date: 'unavailable',
} as const satisfies Record<SpendingMonthState, string>;

/** One sentence for each state, as the page's focus says it. */
export function monthStateMeaning(state: SpendingMonthState, monthName: string): string {
  switch (state) {
    case 'reliable':
      return `Every account has its evidence for ${monthName}, and the records explain the cash.`;
    case 'estimated':
      return 'An account started being tracked this month; its earlier movements are not included, so the figures are estimates.';
    case 'provisional':
      return 'Month to date, measured to the latest day every cash account shares. It is not final.';
    case 'unresolved':
      return 'Your records and your balances contradict each other, so spending is only known to be at least what you recorded.';
    case 'unavailable':
      return `Some evidence for ${monthName} is missing, so tracked spending cannot be inferred for it.`;
    case 'not_observed':
      return `No cash account took part in ${monthName}. There is no tracked spending figure for it — not a zero, and nothing to fix.`;
    case 'no_common_date':
      return 'Your cash accounts do not share a balance date this month, so there is no month-to-date spending figure — not even a zero. Update all cash accounts to the same date to calculate it.';
  }
}

/** Why one currency could not be reconciled, as a sentence naming what would fix it. */
export function bucketProblem(bucket: SpendingBucketDto): string | null {
  switch (bucket.cause) {
    case null:
      return null;
    case 'missing_month_end':
      return bucket.accountsMissingEvidence.length === 0
        ? `${bucket.currency}: a month-end balance is missing.`
        : `${bucket.currency}: missing month-end balance for ${bucket.accountsMissingEvidence.join(', ')}.`;
    case 'missing_opening':
      return `${bucket.currency}: an account has no usable opening balance.`;
    case 'flow_without_cash_account':
      return `${bucket.currency}: a flow names no cash account, and none of this currency took part.`;
    case 'first_balance':
      return `${bucket.currency}: every account was first tracked this month (${bucket.firstBalanceAccounts.join(', ')}), so there is nothing to reconcile yet.`;
    case 'unknown':
      return `${bucket.currency}: this currency could not be reconciled.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/** The Spending page for a month. Typed-route safe: the one cast lives here. */
export const spendingHref = (month: string): Route => `/expenses?month=${month}` as Route;

/** Where in Monthly a month is maintained: its Accounts, its Reconciliation, or its top. */
export type MonthlyAnchor = 'accounts' | 'reconciliation' | 'known-expenses' | null;

/**
 * Monthly for a month, at a section when one is named. Each branch casts on its
 * own, like `spendingHref`: a cast around the whole conditional reads as
 * unnecessary to lint on a checkout with no generated route types.
 */
export function monthlyHref(month: string, anchor: MonthlyAnchor = null): Route {
  if (anchor === null) return `/monthly/${month}` as Route;
  return `/monthly/${month}#${anchor}` as Route;
}

/** The section of Monthly that holds what the focus month is missing. */
export function focusAnchorOf(focus: SpendingFocusDto): MonthlyAnchor {
  if (focus.shape === 'current' && focus.asOf === null) return 'accounts';
  if (!('buckets' in focus)) return null;
  if (focus.buckets.some((bucket) => bucket.cause !== null)) return 'accounts';
  if (focus.status === 'unresolved') return 'reconciliation';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Categories and largest known                                                */
/* -------------------------------------------------------------------------- */

export const CATEGORY_GROUP_LABEL: Readonly<Record<SpendingCategoryGroupDto, string>> = {
  consumption: 'Consumption',
  cost: 'Costs and fees',
  money_out: 'Money out of tracked accounts · not consumption',
};

export const CATEGORY_GROUP_ORDER: readonly SpendingCategoryGroupDto[] = ['consumption', 'cost', 'money_out'];

export const LARGEST_KIND_LABEL: Readonly<Record<SpendingLargestRowDto['kind'], string>> = {
  consumption: 'Consumption',
  cost: 'Fee / cost',
  money_out: 'Money out of tracked accounts · not consumption',
  additional: 'Additional spending',
};

/** Why the largest-known rows are ordered the way they are, or `null` when that needs no note. */
export function rankingNote(mode: SpendingRankingModeDto, perNativeCurrency: boolean): string | null {
  if (mode === 'per_native_currency' || (mode === 'source_only' && perNativeCurrency)) {
    return 'A rate to your reporting currency is missing for at least one entry, so amounts in different currencies cannot be compared. Each currency is ranked on its own.';
  }
  if (mode === 'source_only') {
    return 'Tracked spending cannot be calculated yet this month, so only spending you paid from outside your tracked accounts is listed.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The page as a whole                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether the page has any tracked spending to show at all — any month with a
 * stated figure, or a combined period. When it has none, 15.2's empty state
 * leads, and the facts that need no reconciliation still show beneath it.
 */
export function hasTrackedEvidence(page: Pick<SpendingPageDto, 'history' | 'spans'>): boolean {
  if (page.spans.length > 0) return true;
  return page.history.some(
    (row) => row.tracked !== null && spendingFigureDisplay(row.tracked).kind !== 'none',
  );
}

/** "3-month average tracked spending" and whether it is "through August". */
export function rollingTitle(months: number): string {
  return `${String(months)}-month average tracked spending`;
}

export function rollingCount(count: number | null, months: number): string {
  return count === null
    ? `No month in these ${String(months)} qualified`
    : `${String(count)} of ${String(months)} months qualified`;
}
