import { endOfMonthKey, startOfMonthKey, type MonthKey, type PlainDate } from '../dates/plain-date';
import { occurrencesInRange } from '../recurring/occurrences';
import type { CompletenessTemplate } from './types';

/**
 * Which occurrences a completed month was expecting and did not get
 * (blueprint 12.6, v2.1.7 30.10).
 *
 * The rule that makes this correct is 30.10's: `start_date` and `end_date` are
 * the historical schedule, and `archived_at` is present-tense visibility that
 * must not reach backwards. A template archived today still expected a salary
 * last September, and filtering it out here would let an action taken now erase
 * a genuinely missing record from the report that exists to find it. So no
 * archive state appears in this module at all — the caller loads templates
 * whose schedule overlaps the month, archived or not, and the schedule decides.
 *
 * An occurrence is resolved by a materialized flow carrying its
 * `(template_id, occurrence_date)` or by a `recurring_template_skips` row. Both
 * are facts; absence is not. In particular a rental occurrence with no rent and
 * no skip is *missing*, never *vacant* — occupancy is only ever an explicit
 * skip reason (F18).
 */

export interface MissingOccurrence {
  readonly templateId: string;
  readonly templateName: string;
  readonly currency: string;
  readonly occurrenceDate: PlainDate;
}

export function occurrenceKey(templateId: string, occurrenceDate: string): string {
  return `${templateId}#${occurrenceDate}`;
}

/**
 * The income occurrences scheduled in M that nothing accounts for.
 *
 * Income only: 8.5's `suggested_income_missing` names an income template, and
 * the equivalent for liabilities (`suggested_payment_missing`) belongs to the
 * phase that has liabilities.
 */
export function missingIncomeOccurrences(
  templates: readonly CompletenessTemplate[],
  resolved: ReadonlySet<string>,
  month: MonthKey,
): MissingOccurrence[] {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  const missing: MissingOccurrence[] = [];

  for (const template of templates) {
    if (template.kind !== 'income') continue;

    for (const occurrenceDate of occurrencesInRange(template.schedule, from, to)) {
      if (resolved.has(occurrenceKey(template.templateId, occurrenceDate))) continue;
      missing.push({
        templateId: template.templateId,
        templateName: template.name,
        currency: template.currency,
        occurrenceDate,
      });
    }
  }

  // Deterministic: by date, then by template, so the same month always reports
  // the same list in the same order.
  return missing.sort((a, b) =>
    a.occurrenceDate === b.occurrenceDate
      ? a.templateId.localeCompare(b.templateId)
      : a.occurrenceDate < b.occurrenceDate
        ? -1
        : 1,
  );
}
