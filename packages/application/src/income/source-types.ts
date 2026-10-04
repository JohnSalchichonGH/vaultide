import type { MoneyDto } from '@vaultide/finance';
import type { RecurrenceFrequency } from '@vaultide/validation';
import type { OccurrenceTermDto } from '../monthly/types';

/**
 * One income source's page, as read (blueprint 15.2 "Income source", v2.1.20
 * 30.23 items 2, 4, 7, 8; ADR 0012 D2–D4, D7).
 *
 * Everything is in the source's own currency — one source, one currency — so
 * nothing here is converted and no figure carries an availability: every
 * amount is one that was recorded or scheduled. Terms and payments keep their
 * own figures, and nothing is meant to be added up by a reader.
 */

/** The source itself. */
export interface IncomeSourceDto {
  readonly templateId: string;
  /** The template's optimistic version, which every edit claims (20.3). */
  readonly version: number;
  readonly name: string;
  /** The payer. */
  readonly counterparty: string | null;
  readonly incomeKind: string;
  readonly currency: string;
  readonly frequency: RecurrenceFrequency;
  /** The schedule's day, or `null` when it takes the start date's day (6.2). */
  readonly dayOfMonth: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  /** Present-tense visibility (§30.10): it stops suggestions and rewrites no history. */
  readonly archived: boolean;
  /**
   * The account its payments are recorded into, or `null` when it names none:
   * its payments are then tracked cash awaiting attribution (§30.9 item 1),
   * never income outside tracked accounts.
   */
  readonly account: { readonly positionId: string; readonly name: string } | null;
  /**
   * Every date the schedule places in a completed month, generated as though it
   * never ended — what a proposed end date is measured against, as Known
   * expenses' `completedOccurrenceDates` is. The server still decides whether
   * a change is allowed.
   */
  readonly completedOccurrenceDates: readonly string[];
}

/** One amount the source was set to, from its effective date on (6.2). */
export interface IncomeSourceTermDto {
  readonly effectiveFrom: string;
  readonly net: MoneyDto;
  /** `null` when the term records no gross, which is never a zero (30.23 item 4). */
  readonly gross: MoneyDto | null;
  readonly note: string | null;
}

/** A payment that recorded one of the source's occurrences. */
export interface IncomeSourcePaymentDto {
  readonly entryId: string;
  /** The occurrence it records. */
  readonly occurrenceDate: string;
  /** When the money arrived: the Monthly month that holds and edits it (30.23 item 2; ADR 0012 D5). */
  readonly receivedOn: string;
  readonly net: MoneyDto;
  /** `null` when none was recorded (30.23 item 4). */
  readonly gross: MoneyDto | null;
}

/** One payment beside what the schedule said its occurrence was worth (30.23 item 7). */
export interface IncomeSourceArrivalDto {
  readonly payment: IncomeSourcePaymentDto;
  /** The term in force at the occurrence's scheduled date (§30.9 item 4). */
  readonly term: OccurrenceTermDto;
}

export type IncomeSourceOccurrenceStateDto =
  | { readonly kind: 'received'; readonly payment: IncomeSourcePaymentDto }
  | { readonly kind: 'skipped'; readonly reason: string; readonly note: string | null }
  /** A completed month's occurrence nothing records or skips (30.23 item 8). */
  | { readonly kind: 'missing' }
  /** Unresolved, in the current month or later: it may still arrive. */
  | { readonly kind: 'not_yet_due' };

export interface IncomeSourceOccurrenceDto {
  /** Its scheduled date. */
  readonly occurrenceDate: string;
  /**
   * The term in force at that date, and whether one starts exactly there —
   * what "Change the amount from…" opens with, as Monthly's form does.
   */
  readonly term: OccurrenceTermDto;
  readonly state: IncomeSourceOccurrenceStateDto;
}

export interface IncomeSourcePageDto {
  readonly today: string;
  /** The year whose occurrences are listed. */
  readonly year: number;
  readonly currentYear: number;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  readonly navigation: {
    /** `null` at the source's start year, or the current year when it starts later. */
    readonly previous: number | null;
    /** `null` on the current year. */
    readonly next: number | null;
  };
  readonly source: IncomeSourceDto;
  /** Every term, oldest first. */
  readonly terms: readonly IncomeSourceTermDto[];
  /** Every payment the source has recorded, by scheduled date. */
  readonly arrivals: readonly IncomeSourceArrivalDto[];
  /** Every occurrence the schedule places in the year, in date order. */
  readonly occurrences: readonly IncomeSourceOccurrenceDto[];
}
