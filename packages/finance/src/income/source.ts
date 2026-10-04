import { endOfMonthKey, monthKeyOf, startOfMonthKey, type PlainDate } from '../dates/plain-date';
import type { Money } from '../money/types';
import { occurrenceKey } from '../reconciliation/completeness';
import type { CompletenessTemplate } from '../reconciliation/types';
import { occurrencesInRange } from '../recurring/occurrences';
import { missingIncomeInYear } from './recorded';

/**
 * One income source's occurrences, a year at a time (blueprint 15.2 "Income
 * source", v2.1.20 30.23 items 2 and 8; ADR 0012 D2, D4).
 *
 * Each occurrence the schedule places in the year is received, skipped,
 * missing, or not yet due. "Missing" is exactly what `missingIncomeInYear`
 * reports for this source — the computation `suggested_income_missing` uses
 * (30.23 item 8) — over completed months only; an unresolved occurrence of the
 * current month or later may still arrive and is never flagged. A payment
 * stays with the occurrence it records, whatever day it arrived (item 2).
 *
 * Archive state plays no part: archiving is present-tense visibility and the
 * schedule decides what a past month expected (30.10 item 2). Everything is in
 * the source's own currency, so nothing converts.
 *
 * Pure and deterministic: today and the records are passed in.
 */

/** A payment that records one of the source's occurrences. */
export interface SourcePayment {
  readonly id: string;
  /** The occurrence it records: its place in the schedule. */
  readonly occurrenceDate: PlainDate;
  /** When the money arrived, which may be another day or another month (30.23 item 2). */
  readonly receivedOn: PlainDate;
  readonly net: Money;
  /** `null` when no gross was recorded, which is never a zero (30.23 item 4). */
  readonly gross: Money | null;
}

/** A stated absence of one of the source's occurrences. */
export interface SourceSkip {
  readonly id: string;
  readonly occurrenceDate: PlainDate;
  readonly reason: string;
  readonly note: string | null;
}

export type SourceOccurrenceState =
  | { readonly kind: 'received'; readonly payment: SourcePayment }
  | { readonly kind: 'skipped'; readonly skip: SourceSkip }
  /** In a completed month, recorded and skipped by nothing: `missingIncomeInYear`'s. */
  | { readonly kind: 'missing' }
  /** Unresolved, in the current month or later. */
  | { readonly kind: 'not_yet_due' };

export interface SourceOccurrence {
  readonly occurrenceDate: PlainDate;
  readonly state: SourceOccurrenceState;
}

export interface IncomeSourceYear {
  readonly year: number;
  /** Every occurrence the schedule places in the year, in date order. */
  readonly occurrences: readonly SourceOccurrence[];
  /** The year's missing occurrences, as `missingIncomeInYear` reports them for this source. */
  readonly missing: readonly PlainDate[];
}

export interface IncomeSourceYearInput {
  /** An income template, archived or not. */
  readonly template: CompletenessTemplate;
  /** Every payment that records one of its occurrences. */
  readonly payments: readonly SourcePayment[];
  /** Every skip of one of its occurrences. */
  readonly skips: readonly SourceSkip[];
  /** The calendar year, in the user's timezone. */
  readonly year: number;
  /** Injected; no engine reads a clock (7.7). */
  readonly today: PlainDate;
}

/**
 * What became of each occurrence the source's schedule places in `year`.
 *
 * The payments and skips are the whole of what resolves an income source's
 * occurrence: an acceptance — from Monthly or from Bulk History — materializes
 * an income template's occurrence as an income entry and as nothing else, and
 * a Phase 3 transfer carries no occurrence. So they are the resolved set
 * `missingIncomeInYear` is given, and its answer decides which unresolved
 * occurrence is missing; every other unresolved one is not yet due. The
 * accept and skip services lock the template before either writes, so one
 * occurrence never has both; were it to, the payment is what arrived.
 */
export function incomeSourceYear(input: IncomeSourceYearInput): IncomeSourceYear {
  const { template, year, today } = input;
  const paid = new Map(input.payments.map((payment) => [payment.occurrenceDate, payment]));
  const skipped = new Map(input.skips.map((skip) => [skip.occurrenceDate, skip]));
  const resolved = new Set(
    [...paid.keys(), ...skipped.keys()].map((date) => occurrenceKey(template.templateId, date)),
  );

  const [flag] = missingIncomeInYear([template], resolved, year, today);
  const missing = flag === undefined ? [] : [...flag.occurrences];
  const isMissing = new Set<string>(missing);

  const scheduled = occurrencesInRange(
    template.schedule,
    startOfMonthKey(monthKeyOf(year, 1)),
    endOfMonthKey(monthKeyOf(year, 12)),
  );
  const occurrences = scheduled.map((occurrenceDate): SourceOccurrence => {
    const payment = paid.get(occurrenceDate);
    if (payment !== undefined) return { occurrenceDate, state: { kind: 'received', payment } };
    const skip = skipped.get(occurrenceDate);
    if (skip !== undefined) return { occurrenceDate, state: { kind: 'skipped', skip } };
    return { occurrenceDate, state: { kind: isMissing.has(occurrenceDate) ? 'missing' : 'not_yet_due' } };
  });

  return { year, occurrences, missing };
}
