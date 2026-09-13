import {
  listActiveTemplatesIn,
  listExpenseEntriesByOccurrenceIn,
  listResolvedOccurrencesAfterIn,
  listSkipsInRangeIn,
  listTemplatesByIdsIn,
  loadTermsForRangeIn,
  withUser,
  type Database,
  type ExpenseEntryRow,
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
 * The recurring evidence Monthly's Known-expenses section needs and no other
 * read has (blueprint 15.3 section 3, 23.2, v2.1.7 §30.10).
 *
 * The financial half of the section is already in hand: the reconciliation and
 * month-to-date loaders read the month's expense entries by their **financial**
 * date, with the categories that classify them, and hand those rows on. What
 * neither can answer is the schedule side of an occurrence whose two dates
 * disagree:
 *
 *  - an expense whose `occurrence_date` falls in the month while its
 *    `incurred_on` does not is invisible to a read keyed on `incurred_on`, yet it
 *    is exactly what makes the month's occurrence *recorded* rather than due;
 *  - a skip has no financial date at all;
 *  - a source a row names need not overlap the month: "Paid today" on 30
 *    September for a source starting 1 November writes a September expense whose
 *    template no schedule window on the page would load.
 *
 * This is deliberately its own scope rather than a generalization of the Income
 * section's, which reads some of the same generic rows. A constant duplicated
 * read is cheaper than coupling two sections' evidence to one loader.
 *
 * ## One scope, a fixed number of statements
 *
 * Each function opens **one** user-scoped transaction and runs a constant
 * number of statements inside it. Nothing is read per template, per occurrence,
 * per entry or per skip, so the page's transaction count rises by exactly one
 * and then stays there however much data the month holds.
 *
 * ## Why the candidate is derived inside the scope
 *
 * "Paid today" reaches the earliest occurrence after today that nothing has
 * resolved, with no horizon (§30.10). Its term is the one in force at *that*
 * date, which may be months past the end of the month on screen, so the term read
 * cannot be bounded until the candidate is known. The pure derivation runs
 * between the reads, and the terms are then loaded once through the furthest
 * candidate rather than over an open-ended future.
 */

export interface MonthlyExpenseDependencies {
  readonly db: Database;
}

export interface MonthlyExpenseRows {
  /** Expense entries materializing an occurrence scheduled **in the month**. */
  readonly occurrenceEntries: readonly ExpenseEntryRow[];
  /** Skips of occurrences scheduled in the month, of every kind of source. */
  readonly skips: readonly RecurringTemplateSkipRow[];
  /**
   * Expense sources a row on the page names that the caller's schedule window
   * may not hold. Merged with that window by the mapping; never a query per row.
   */
  readonly referencedTemplates: readonly RecurringTemplateRow[];
}

export interface CurrentMonthExpenseRows extends MonthlyExpenseRows {
  /** The operational feed's own expense sources: `archived_at IS NULL` (§30.10). */
  readonly activeTemplates: readonly RecurringTemplateRow[];
  /** Terms covering the month and every "Paid today" candidate beyond it. */
  readonly operationalTerms: readonly RecurringTemplateTermRow[];
  /**
   * The one occurrence per active expense source that "Paid today" may reach,
   * by template id. Absent from the map when the source has none left.
   */
  readonly paidTodayCandidates: ReadonlyMap<string, PlainDate>;
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
 * Resolved occurrence dates, per template.
 *
 * `nextUnresolvedOccurrence` takes dates rather than occurrence keys, so its set
 * must be one template's own: two sources sharing a scheduled date would
 * otherwise resolve each other's occurrence.
 */
function resolvedByTemplate(
  rows: readonly { readonly templateId: string; readonly occurrenceDate: string }[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byTemplate = new Map<string, Set<string>>();
  for (const row of rows) {
    const dates = byTemplate.get(row.templateId);
    if (dates === undefined) byTemplate.set(row.templateId, new Set([row.occurrenceDate]));
    else dates.add(row.occurrenceDate);
  }
  return byTemplate;
}

const EMPTY_DATES: ReadonlySet<string> = new Set();

const isExpenseSource = (template: RecurringTemplateRow): boolean => template.kind === 'expense';

/** A completed month: its occurrences' rows, and the sources they name. */
export async function loadCompletedMonthExpenses(
  deps: MonthlyExpenseDependencies,
  userId: string,
  month: MonthKey,
  /** Templates named by the expenses the reconciliation read already returned. */
  financiallyReferencedTemplateIds: readonly string[],
): Promise<MonthlyExpenseRows> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);

  return withUser(deps.db, { userId }, async (tx) => {
    const [occurrenceEntries, skips] = await Promise.all([
      listExpenseEntriesByOccurrenceIn(tx, from, to),
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

    return {
      occurrenceEntries,
      skips,
      referencedTemplates: referencedTemplates.filter(isExpenseSource),
    };
  });
}

/** The current month: the same rows, plus the operational surface a live month has. */
export async function loadCurrentMonthExpenses(
  deps: MonthlyExpenseDependencies,
  userId: string,
  month: MonthKey,
  today: PlainDate,
  financiallyReferencedTemplateIds: readonly string[],
): Promise<CurrentMonthExpenseRows> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);

  return withUser(deps.db, { userId }, async (tx) => {
    const [occurrenceEntries, skips, active, futureResolved] = await Promise.all([
      listExpenseEntriesByOccurrenceIn(tx, from, to),
      listSkipsInRangeIn(tx, from, to),
      listActiveTemplatesIn(tx),
      // No upper bound, because §30.10's rule has none: the next unresolved
      // occurrence of an annual source may be eleven months out.
      listResolvedOccurrencesAfterIn(tx, today),
    ]);

    const referenced = await listTemplatesByIdsIn(
      tx,
      templateIdsOf(
        occurrenceEntries,
        skips,
        financiallyReferencedTemplateIds.map((templateId) => ({ templateId })),
      ),
    );
    const activeTemplates = active.filter(isExpenseSource);
    const referencedTemplates = referenced.filter(isExpenseSource);

    // Derived before the terms are read, because the term of a candidate is the
    // one in force at *its* date and that decides how far the read must reach.
    const resolved = resolvedByTemplate(futureResolved);
    const paidTodayCandidates = new Map<string, PlainDate>();
    for (const template of activeTemplates) {
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
      if (candidate !== undefined) paidTodayCandidates.set(template.id, candidate);
    }

    // Through the furthest candidate and no further: enough to price every
    // occurrence this page can act on, and not an open-ended future history.
    const termsEnd = [...paidTodayCandidates.values()].reduce<string>(
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
      paidTodayCandidates,
    };
  });
}
