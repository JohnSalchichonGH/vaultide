import {
  listActiveTemplatesIn,
  listIncomeEntriesByOccurrenceIn,
  listResolvedOccurrencesAfterIn,
  listSkipsInRangeIn,
  listTemplatesByIdsIn,
  loadTermsForRangeIn,
  withUser,
  type Database,
  type IncomeEntryRow,
  type RecurringTemplateRow,
  type RecurringTemplateSkipRow,
  type RecurringTemplateTermRow,
} from '@vaultide/db';
import {
  endOfMonthKey,
  nextUnresolvedOccurrence,
  plainDate,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '@vaultide/finance';

/**
 * The recurring evidence Monthly's Income section needs and no other read has
 * (blueprint 15.3 section 2, 23.2, v2.1.7 §30.10).
 *
 * Everything else the section shows is already in hand. The reconciliation and
 * month-to-date loaders read the month's income entries by their **financial**
 * date and its templates and terms by the schedule window, and both now hand
 * those rows on. What neither can answer is the schedule side of an occurrence
 * whose two dates disagree:
 *
 *  - an entry whose `occurrence_date` falls in the month while its `received_on`
 *    does not is invisible to a read keyed on `received_on`, yet it is exactly
 *    what makes the month's occurrence *accepted* rather than missing;
 *  - `listResolvedOccurrencesInRange` already answers *whether* something
 *    resolved an occurrence, which is all completeness needs, but it returns the
 *    identity alone — no entry id, version, amount, skip reason or note, so it
 *    can neither be displayed nor edited;
 *  - a template referenced by such a row need not overlap the month at all:
 *    "received today" on 30 September for a source starting 1 November writes a
 *    September entry whose template no schedule window on the page would load.
 *
 * ## One scope, a fixed number of statements
 *
 * Each function here opens **one** user-scoped transaction and runs a constant
 * number of statements inside it — the shape `loadFinancialWindow` already uses.
 * Nothing is read per template, per occurrence, per entry or per skip, so the
 * page's transaction count rises by exactly one and then stays there however
 * much data the month holds.
 *
 * ## Why the candidate is derived here
 *
 * "Received today" reaches the earliest occurrence after today that nothing has
 * resolved, with no horizon in days or months (§30.10). Its term is the one in
 * force at *that* date, which may be months past the end of the month on
 * screen — so the term read cannot be bounded until the candidate is known. The
 * pure derivation therefore runs inside the scope, between the two reads, and
 * the terms are then loaded once through to the furthest candidate rather than
 * by fetching an open-ended future.
 */

export interface MonthlyIncomeDependencies {
  readonly db: Database;
}

/** The occurrence identity, per template, of everything already resolved. */
type ResolvedByTemplate = ReadonlyMap<string, ReadonlySet<string>>;

export interface MonthlyIncomeRows {
  /** Income entries materializing an occurrence scheduled **in the month**. */
  readonly occurrenceEntries: readonly IncomeEntryRow[];
  /** Skips of occurrences scheduled in the month, whole. */
  readonly skips: readonly RecurringTemplateSkipRow[];
  /**
   * Templates a row on the page names that the caller's schedule window may not
   * hold. Merged with that window by the mapping; never a query per row.
   */
  readonly referencedTemplates: readonly RecurringTemplateRow[];
}

export interface CurrentMonthIncomeRows extends MonthlyIncomeRows {
  /** The operational feed's own set: `archived_at IS NULL` (§30.10). */
  readonly activeTemplates: readonly RecurringTemplateRow[];
  /** Terms covering the month and every early-receipt candidate beyond it. */
  readonly operationalTerms: readonly RecurringTemplateTermRow[];
  /**
   * The one occurrence per active source that "received today" may reach, by
   * template id. Absent from the map when the source has none left.
   */
  readonly earlyReceiptCandidates: ReadonlyMap<string, PlainDate>;
}

/** The template ids a set of rows names, each once. */
function templateIdsOf(
  ...groups: readonly (readonly { readonly templateId: string | null }[])[]
): string[] {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const row of group) if (row.templateId !== null) ids.add(row.templateId);
  }
  return [...ids];
}

/**
 * Group resolved occurrences by template.
 *
 * `nextUnresolvedOccurrence` takes dates, not occurrence keys, so its set must
 * be one template's own: two sources sharing a scheduled date would otherwise
 * resolve each other's occurrence, and one user's early claim would silently
 * skip the other source's next payment.
 */
function resolvedByTemplate(
  rows: readonly { readonly templateId: string; readonly occurrenceDate: string }[],
): ResolvedByTemplate {
  const byTemplate = new Map<string, Set<string>>();
  for (const row of rows) {
    const dates = byTemplate.get(row.templateId);
    if (dates === undefined) byTemplate.set(row.templateId, new Set([row.occurrenceDate]));
    else dates.add(row.occurrenceDate);
  }
  return byTemplate;
}

const EMPTY_DATES: ReadonlySet<string> = new Set();

/** A completed month: its occurrences' rows, and the sources they name. */
export async function loadCompletedMonthIncome(
  deps: MonthlyIncomeDependencies,
  userId: string,
  month: MonthKey,
  /** Templates named by the entries the reconciliation read already returned. */
  financiallyReferencedTemplateIds: readonly string[],
): Promise<MonthlyIncomeRows> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);

  return withUser(deps.db, { userId }, async (tx) => {
    const [occurrenceEntries, skips] = await Promise.all([
      listIncomeEntriesByOccurrenceIn(tx, from, to),
      listSkipsInRangeIn(tx, from, to),
    ]);

    const referencedTemplates = await listTemplatesByIdsIn(
      tx,
      templateIdsOf(
        occurrenceEntries,
        skips,
        financiallyReferencedTemplateIds.map((templateId) => ({ templateId })),
      ),
    );

    return { occurrenceEntries, skips, referencedTemplates };
  });
}

/** The current month: the same rows, plus the operational surface a live month has. */
export async function loadCurrentMonthIncome(
  deps: MonthlyIncomeDependencies,
  userId: string,
  month: MonthKey,
  today: PlainDate,
  financiallyReferencedTemplateIds: readonly string[],
): Promise<CurrentMonthIncomeRows> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);

  return withUser(deps.db, { userId }, async (tx) => {
    const [occurrenceEntries, skips, activeTemplates, futureResolved] = await Promise.all([
      listIncomeEntriesByOccurrenceIn(tx, from, to),
      listSkipsInRangeIn(tx, from, to),
      listActiveTemplatesIn(tx),
      // No upper bound, because §30.10's rule has none: the next unresolved
      // occurrence of an annual source may be eight months out.
      listResolvedOccurrencesAfterIn(tx, today),
    ]);

    const referencedTemplates = await listTemplatesByIdsIn(
      tx,
      templateIdsOf(
        occurrenceEntries,
        skips,
        financiallyReferencedTemplateIds.map((templateId) => ({ templateId })),
      ),
    );

    // Derived before the terms are read, because the term of a candidate is the
    // one in force at *its* date and that decides how far the read must reach.
    const resolved = resolvedByTemplate(futureResolved);
    const earlyReceiptCandidates = new Map<string, PlainDate>();
    for (const template of activeTemplates) {
      if (template.kind !== 'income') continue;
      const candidate = nextUnresolvedOccurrence(
        {
          frequency: template.frequency,
          dayOfMonth: template.dayOfMonth,
          startDate: plainDate(template.startDate),
          endDate: template.endDate === null ? null : plainDate(template.endDate),
        },
        today,
        resolved.get(template.id) ?? EMPTY_DATES,
      );
      if (candidate !== undefined) earlyReceiptCandidates.set(template.id, candidate);
    }

    // Through the furthest candidate and no further: enough to price every
    // occurrence this page can act on, and not an open-ended future history.
    const termsEnd = [...earlyReceiptCandidates.values()].reduce<string>(
      (furthest, candidate) => (candidate > furthest ? candidate : furthest),
      to,
    );
    const operationalTerms = await loadTermsForRangeIn(
      tx,
      templateIdsOf(
        activeTemplates.map((template) => ({ templateId: template.id })),
        referencedTemplates.map((template) => ({ templateId: template.id })),
      ),
      from,
      termsEnd,
    );

    return {
      occurrenceEntries,
      skips,
      referencedTemplates,
      activeTemplates,
      operationalTerms,
      earlyReceiptCandidates,
    };
  });
}
