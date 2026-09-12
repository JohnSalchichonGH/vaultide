import type { IncomeOccurrenceDto, MonthlyIncomeEntryDto } from '@vaultide/application';
import { allowedIncomeSettlements, rentalOnlySkipReasons, skipReasons } from '@vaultide/validation';

/**
 * How Monthly's Income section says what the read returned (blueprint 6.2, 7.4,
 * 15.3 section 2, v2.1.7 §30.10).
 *
 * Words, options and boundaries — never a financial decision. Every rule
 * expressed here is also enforced by the server; what it buys is a control that
 * does not offer something the services will refuse, which is a courtesy rather
 * than an authority (20.1).
 */

export const INCOME_KIND_LABEL: Readonly<Record<string, string>> = {
  employment: 'Salary',
  freelance: 'Freelance',
  bonus: 'Bonus',
  rental: 'Rent',
  interest: 'Interest',
  dividend: 'Dividend',
  other: 'Other income',
  external_inflow: 'Money in from outside',
  adjustment: 'Reconciliation adjustment',
};

export const SETTLEMENT_LABEL: Readonly<Record<string, string>> = {
  tracked_cash: 'Into a tracked account',
  external: 'Outside my tracked accounts',
  reinvested: 'Reinvested',
};

export const SKIP_REASON_LABEL: Readonly<Record<string, string>> = {
  skipped: 'Did not happen',
  vacant: 'Property was empty',
  non_payment: 'Tenant did not pay',
  other: 'Another reason',
};

export const incomeKindLabel = (kind: string): string => INCOME_KIND_LABEL[kind] ?? kind;

/**
 * The settlements a kind may carry in Phase 3 (7.4, §30.9 item 5).
 *
 * Straight from the validation catalogue, so the control and the service read
 * the same list: a dividend offers tracked cash alone, and `reinvested` is
 * offered nowhere until investments exist.
 */
export function settlementOptions(kind: string): readonly { value: string; label: string }[] {
  return allowedIncomeSettlements(kind as Parameters<typeof allowedIncomeSettlements>[0]).map(
    (value) => ({ value, label: SETTLEMENT_LABEL[value] ?? value }),
  );
}

/**
 * The reasons a source may be skipped for (6.2, F18).
 *
 * `vacant` and `non_payment` are occupancy facts and belong to a rental alone —
 * the only occupancy facts the product records. Offering them elsewhere would
 * invite a refusal the user cannot act on.
 */
export function skipReasonOptions(incomeKind: string): readonly { value: string; label: string }[] {
  const rentalOnly = rentalOnlySkipReasons as readonly string[];
  return skipReasons
    .filter((reason) => incomeKind === 'rental' || !rentalOnly.includes(reason))
    .map((value) => ({ value, label: SKIP_REASON_LABEL[value] ?? value }));
}

/**
 * The anchor an occurrence row carries, built from its own identity.
 *
 * `suggested_income_missing` names a `(template_id, occurrence_date)` pair (8.5),
 * so a jump from the issue lands on exactly that row — never on a name match and
 * never on a schedule recomputed in the browser.
 */
export const occurrenceAnchorId = (templateId: string, occurrenceDate: string): string =>
  `occurrence-${templateId}-${occurrenceDate}`;

export type OccurrenceTone = 'due' | 'upcoming' | 'accepted' | 'skipped';

/** What an occurrence's row says it is, in the month it is being read in. */
export function occurrenceStateLabel(occurrence: IncomeOccurrenceDto): string {
  switch (occurrence.state.kind) {
    case 'accepted':
      return 'Recorded';
    case 'skipped':
      return 'Skipped';
    case 'upcoming':
      return 'Upcoming';
    case 'due':
      // The same occurrence `suggested_income_missing` reports: its date has
      // passed and neither a flow nor a skip accounts for it.
      return 'Not recorded';
  }
}

export function occurrenceTone(occurrence: IncomeOccurrenceDto): OccurrenceTone {
  return occurrence.state.kind;
}

/**
 * Whether this page may edit a financial row.
 *
 * The month holding the money owns it. An occurrence scheduled in September and
 * received on 2 October is October's row to correct: editing it from September
 * would change October's reconciliation from a page that is not showing it.
 */
export const ownsEntry = (entry: MonthlyIncomeEntryDto, month: string): boolean =>
  entry.receivedMonth === month;

/**
 * What to say before an acceptance lands the money in another month.
 *
 * `null` when the financial date belongs to the month on screen, which is the
 * ordinary case and needs no warning.
 */
export function crossMonthNotice(
  receivedOn: string,
  displayedMonth: string,
  monthNameOf: (month: string) => string,
): string | null {
  const target = receivedOn.slice(0, 7);
  if (target === displayedMonth) return null;
  return `This belongs to ${monthNameOf(displayedMonth)}’s schedule, but the money will be recorded in ${monthNameOf(target)} and will affect ${monthNameOf(target)}’s reconciliation.`;
}

/**
 * The dates a direct income row of this page may carry.
 *
 * The month on screen, never past today. Moving an existing row to another
 * month is a historical correction and belongs to the phase that shows what it
 * affects (15.3); creating one here is ordinary maintenance of this month.
 */
export function directDateBounds(page: {
  readonly month: string;
  readonly monthEndsOn: string;
  readonly today: string;
}): { readonly min: string; readonly max: string } {
  return {
    min: `${page.month}-01`,
    max: page.monthEndsOn < page.today ? page.monthEndsOn : page.today,
  };
}

/**
 * Whether a source's start date reaches into the past.
 *
 * Creating one that does is legitimate and unchanged — `start_date` is the
 * historical schedule (§30.10) — but it makes every month since expect an
 * occurrence, so the form says so before the save rather than after.
 */
export const startsInThePast = (startDate: string, today: string): boolean => startDate < today;

export const HISTORICAL_START_WARNING =
  'Starting this source in the past creates expected occurrences from that date. Past months with no recorded or skipped occurrence may become incomplete.';
