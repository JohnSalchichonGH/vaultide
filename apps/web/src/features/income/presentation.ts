import type { Route } from 'next';
import type {
  IncomeGrossDto,
  IncomeMissingFlagDto,
  IncomeTotalDto,
  ReportingAmountDto,
} from '@vaultide/application';
import { historyHref } from '@/features/history/routes';
import { EARLIEST_CORRECTABLE_DATE, occurrenceAnchorId } from '@/features/monthly/income-presentation';
import { incomeEntryAnchorId, missingSummary } from '@/features/monthly/presentation';
import type { FigureDisplay } from '@/features/spending/presentation';

/**
 * How the Income year view says what its read returned (blueprint 15.2
 * "Income", v2.1.20 30.23; ADR 0012 D1–D3).
 *
 * Words, links and display decisions — never a financial figure. Every amount
 * arrives decided, with its own availability.
 */

/* -------------------------------------------------------------------------- */
/* The labels (30.23 item 3)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What this page's figure is called. Monthly's figure answers a different
 * question — what one month's reconciliation saw arrive in tracked accounts —
 * and is called "Tracked income" there, so the two are never both "Income".
 * Not "reconciled": 12.5 keeps that figure available in unresolved and
 * unavailable months, beside a status that says the month is not reconciled.
 */
export const INCOME_RECORDED = 'Income recorded';
export const TRACKED_LABEL = 'Into tracked accounts';
export const OUTSIDE_LABEL = 'Outside tracked accounts';
export const SO_FAR = 'so far';

/** Why this page's figures and Monthly's may differ — the four places 30.23 item 3 names. */
export const DIFFERS_FROM_MONTHLY =
  'Every income payment you recorded, in the month it arrived. Monthly’s “Tracked income” counts only what a month’s reconciliation saw arrive in tracked accounts, so the two can differ: income outside tracked accounts, an account’s first tracked month, a month or currency with no tracked account, and the current month, which Monthly counts only up to its month-to-date date.';

export const GROUP_LABEL = { salary: 'Salary', bonus: 'Bonus', other: 'Other' } as const;

/* -------------------------------------------------------------------------- */
/* Figures                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An income figure: exact, a lower bound, or nothing.
 *
 * A partial one is a lower bound for the reason a partial spending figure is
 * (ADR 0008 §5): every amount missing from it is a net amount, which is never
 * negative. When nothing above zero could be stated, `≥ €0` would say nothing,
 * so it reads `—` with the reason instead.
 */
export function incomeFigureDisplay(amount: ReportingAmountDto): FigureDisplay {
  const { value } = amount;
  const reason = `Not included: ${missingSummary(amount.missing)}.`;
  switch (amount.availability) {
    case 'available':
      return { kind: 'value', amount: value.amount, currency: value.currency };
    case 'partial':
      return /^0(\.0+)?$/u.test(value.amount)
        ? { kind: 'none', reason }
        : { kind: 'at_least', amount: value.amount, currency: value.currency, reason };
    case 'unavailable':
      return { kind: 'none', reason };
  }
}

/** Whether a gross column belongs in a table: only when a payment in view recorded one (ADR 0012 D3). */
export const showsGross = (totals: readonly IncomeTotalDto[]): boolean =>
  totals.some((total) => total.gross.recorded !== null);

/** What a gross cell says beside its amount, when it does not cover every payment. */
export function withoutGrossNote(gross: IncomeGrossDto): string | null {
  return gross.withoutGross === 0 ? null : `${String(gross.withoutGross)} without gross`;
}

/** How many payments a figure holds, in words. */
export const paymentCount = (count: number): string =>
  `${String(count)} ${count === 1 ? 'payment' : 'payments'}`;

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/** `/income?year=YYYY`. */
export const incomeYearHref = (year: number): Route =>
  `/income?year=${String(year).padStart(4, '0')}` as Route;

/** A payment's own row in Monthly: the month of its financial date, which stays its editor (ADR 0012 D5). */
export const paymentHref = (entryId: string, receivedOn: string): Route =>
  `/monthly/${receivedOn.slice(0, 7)}#${incomeEntryAnchorId(entryId)}` as Route;

/** The dates Add a payment offers: any day up to today (ADR 0012 D5). */
export function paymentDateBounds(today: string): { readonly min: string; readonly max: string } {
  return { min: EARLIEST_CORRECTABLE_DATE, max: today };
}

/* -------------------------------------------------------------------------- */
/* Missing payments (ADR 0012 D2)                                              */
/* -------------------------------------------------------------------------- */

export type MissingFlagLink =
  | { readonly kind: 'monthly'; readonly href: Route; readonly label: string }
  | { readonly kind: 'history'; readonly href: Route; readonly label: string };

/**
 * Where a missing-payment line sends the user, or nowhere.
 *
 * Only to a place that can resolve it. One missing payment opens its own row in
 * Monthly; several open Bulk History on the first missing month. An archived
 * source's occurrences can be recorded or skipped in neither — archiving blocks
 * both, and Bulk History disables its cells — so its line has no link at all.
 */
export function missingFlagLink(flag: IncomeMissingFlagDto, monthName: (month: string) => string): MissingFlagLink | null {
  if (flag.archived) return null;
  const [first] = flag.occurrences;
  /* v8 ignore next -- a flag exists only for a source with a missing occurrence. */
  if (first === undefined) return null;
  const month = first.slice(0, 7);
  if (flag.occurrences.length === 1) {
    return {
      kind: 'monthly',
      href: `/monthly/${month}#${occurrenceAnchorId(flag.templateId, first)}` as Route,
      label: `Open ${monthName(month)} in Monthly`,
    };
  }
  return {
    kind: 'history',
    href: historyHref(month),
    label: `Fill them in Bulk History, from ${monthName(month)}`,
  };
}

/** The line itself: "Salary: 2 payments missing in 2026 (August, September)." */
export function missingFlagText(flag: IncomeMissingFlagDto, year: number, monthOnly: (date: string) => string): string {
  const count = flag.occurrences.length;
  const when = flag.occurrences.map(monthOnly).join(', ');
  return `${flag.name}: ${String(count)} ${count === 1 ? 'payment' : 'payments'} missing in ${String(year)} (${when}).`;
}

/** What resolves an archived source's missing payments, since neither Monthly nor Bulk History can. */
export const ARCHIVED_MISSING_HELP =
  'This source is archived, so its payments cannot be recorded or skipped. Unarchive the source, or, if it really ended, give it an end date before the missing payment.';

/* -------------------------------------------------------------------------- */
/* Order                                                                       */
/* -------------------------------------------------------------------------- */

/** Why the sources are in the order they are, when it is not by amount (ADR 0012 D1). */
export function sourceOrderNote(order: 'amount' | 'name', reportingCurrency: string): string | null {
  return order === 'amount'
    ? null
    : `Ordered by name: some amounts could not be converted to ${reportingCurrency}, so the sources cannot be ranked by size.`;
}
