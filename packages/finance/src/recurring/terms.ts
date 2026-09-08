import type { Decimal } from '../decimal';
import type { PlainDate } from '../dates/plain-date';

/**
 * Which term an occurrence is worth (blueprint 6.2, v2.1.6 §30.9 item 4).
 *
 * The term of an occurrence is the row with the **greatest `effective_from ≤
 * occurrence_date`** — keyed to the occurrence's scheduled identity, never to
 * the flow's financial date.
 *
 * That distinction decides money. "Received today" lets a salary scheduled for
 * 1 October be recorded as received on 30 September; if the term were selected
 * by the financial date, an October raise would be missed and the entry would
 * be suggested at September's amount. Selecting by `occurrence_date` gives the
 * October term, which is what the user agreed to.
 *
 * The same shape as the liability rule of 11.3, and deliberately so: "the terms
 * effective on date d are the row with the greatest `effective_from ≤ d`" is one
 * idea, and it should not have two implementations.
 */

export interface TemplateTerm {
  readonly id: string;
  readonly templateId: string;
  readonly effectiveFrom: PlainDate;
  readonly amount: Decimal;
  readonly grossAmount: Decimal | null;
}

/**
 * The term in force for one occurrence, or `undefined` when the template has no
 * term at or before it.
 *
 * `undefined` is a real answer, not an error: a template can exist before
 * anybody has said what it is worth, and the suggestion then has a date and no
 * amount. Returning zero here would quietly invent a €0 salary.
 */
export function termForOccurrence(
  terms: readonly TemplateTerm[],
  occurrenceDate: PlainDate,
): TemplateTerm | undefined {
  let best: TemplateTerm | undefined;
  for (const term of terms) {
    if (term.effectiveFrom > occurrenceDate) continue;
    if (best === undefined || term.effectiveFrom > best.effectiveFrom) best = term;
  }
  return best;
}

/** The same question for many occurrences of one template, in one pass. */
export function termsForOccurrences(
  terms: readonly TemplateTerm[],
  occurrenceDates: readonly PlainDate[],
): Map<PlainDate, TemplateTerm | undefined> {
  const sorted = [...terms].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  const result = new Map<PlainDate, TemplateTerm | undefined>();

  for (const occurrenceDate of occurrenceDates) {
    let best: TemplateTerm | undefined;
    for (const term of sorted) {
      if (term.effectiveFrom > occurrenceDate) break;
      best = term;
    }
    result.set(occurrenceDate, best);
  }

  return result;
}
