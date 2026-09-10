import { endOfMonthKey, startOfMonthKey, type MonthKey, type PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import { occurrencesInRange } from '../recurring/occurrences';
import type { CompletenessTemplate } from './types';

/**
 * Which occurrences a completed month was expecting, and which of them it got
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

/**
 * One occurrence a template's schedule placed in M, and whether anything
 * accounts for it.
 *
 * `resolved` is the whole of what the month knows about it. A flow and a skip
 * reach this module as the same identity in one set, so nothing here can tell
 * them apart, and nothing should: 12.6 treats a stated absence and a recorded
 * flow alike. No term or amount takes part either — an occurrence is expected
 * because the schedule says so, not because a price was set for it.
 */
export interface ScheduledOccurrence {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateKind: CompletenessTemplate['kind'];
  readonly currency: CurrencyCode;
  readonly occurrenceDate: PlainDate;
  readonly resolved: boolean;
}

export function occurrenceKey(templateId: string, occurrenceDate: string): string {
  return `${templateId}#${occurrenceDate}`;
}

/**
 * Every occurrence scheduled in M, of every template given, whatever its kind.
 *
 * The primitive both readers of the schedule share, so the reconciliation issue
 * and the completeness count cannot disagree about which occurrences a month
 * contained. It filters on nothing but the schedule: which kinds matter is the
 * caller's question.
 *
 * Deterministic: by date, then by template, so the same month always yields
 * the same list in the same order whatever order the templates arrive in.
 */
export function scheduledOccurrences(
  templates: readonly CompletenessTemplate[],
  resolved: ReadonlySet<string>,
  month: MonthKey,
): ScheduledOccurrence[] {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  const scheduled: ScheduledOccurrence[] = [];

  for (const template of templates) {
    for (const occurrenceDate of occurrencesInRange(template.schedule, from, to)) {
      scheduled.push({
        templateId: template.templateId,
        templateName: template.name,
        templateKind: template.kind,
        currency: template.currency,
        occurrenceDate,
        resolved: resolved.has(occurrenceKey(template.templateId, occurrenceDate)),
      });
    }
  }

  return scheduled.sort((a, b) =>
    a.occurrenceDate === b.occurrenceDate
      ? a.templateId.localeCompare(b.templateId)
      : a.occurrenceDate < b.occurrenceDate
        ? -1
        : 1,
  );
}

/**
 * The income occurrences scheduled in M that nothing accounts for.
 *
 * Income only: 8.5's `suggested_income_missing` names an income template, and
 * the equivalent for liabilities (`suggested_payment_missing`) belongs to the
 * phase that has liabilities. 12.6's completeness count reads every kind through
 * `scheduledOccurrences` instead; this issue does not widen with it.
 */
export function missingIncomeOccurrences(
  templates: readonly CompletenessTemplate[],
  resolved: ReadonlySet<string>,
  month: MonthKey,
): MissingOccurrence[] {
  return scheduledOccurrences(
    templates.filter((template) => template.kind === 'income'),
    resolved,
    month,
  )
    .filter((occurrence) => !occurrence.resolved)
    .map((occurrence) => ({
      templateId: occurrence.templateId,
      templateName: occurrence.templateName,
      currency: occurrence.currency,
      occurrenceDate: occurrence.occurrenceDate,
    }));
}
