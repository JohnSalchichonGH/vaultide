import type {
  CategoryRecord,
  ExpenseEntryRow,
  PositionRecord as PositionRow,
  RecurringTemplateRow,
  RecurringTemplateSkipRow,
  RecurringTemplateTermRow,
} from '@vaultide/db';
import {
  Decimal,
  addDays,
  endOfMonthKey,
  monthKey,
  occurrencesInRange,
  plainDate,
  startOfMonth,
  startOfMonthKey,
  termForOccurrence,
  type MonthKey,
  type PlainDate,
  type RecurrenceSchedule,
  type TemplateTerm,
} from '@vaultide/finance';
import { consumptionCategoryKinds } from '@vaultide/validation';
import { moneyDto } from '../positions/mapping';
import type { CurrentMonthExpenseRows, MonthlyExpenseRows } from './expenses-loader';
import type {
  CurrentMonthlyExpensesDto,
  ExpenseCategoryDto,
  ExpenseCategoryUseDto,
  ExpenseOccurrenceDto,
  ExpenseReadOnlyReasonDto,
  ExpenseSourceDto,
  ExpenseSourceProtectionDto,
  ExpenseTermDto,
  MonthlyExpenseEntryDto,
  MonthlyExpensesDto,
  PaidTodayCandidateDto,
} from './types';

/**
 * Monthly's Known-expenses section, from rows already loaded (blueprint 6.2,
 * 7.4, 12.5, 12.6, 15.3 section 3, v2.1.6 §30.9, v2.1.7 §30.10).
 *
 * Nothing here queries, and nothing here invents a schedule. The occurrences a
 * month contains come from `occurrencesInRange` and the term of each from
 * `termForOccurrence` — the same pure functions the completeness count and the
 * accept service use — so the section cannot disagree with completeness about
 * which occurrences a month expected, or with an acceptance about what one is
 * worth.
 *
 * ## Two dates, one partition
 *
 * An expense answers two unrelated questions, exactly as income does:
 *
 *  - **schedule membership** — `occurrence_date ∈ M`. It decides which
 *    occurrence exists, completeness, which term applies and what "Paid today"
 *    may reach.
 *  - **financial membership** — `incurred_on ∈ M`. It decides reconciliation,
 *    spending and savings, and which page may edit or delete the row.
 *
 * `occurrences` answers the first and embeds whatever resolved each occurrence.
 * `otherRecurring` and `direct` answer the second over the entries left after
 * the embedded ones are removed by id, so one expense renders exactly once.
 *
 * ## Which sources generate occurrences
 *
 * `archived_at` is present-tense visibility and never a schedule boundary
 * (§30.10). A completed month generates from every source whose dates cover it,
 * archived or not; the current month generates from the active sources, and an
 * archived source keeps the occurrences it already resolved there.
 *
 * ## What the section lists
 *
 * Every expense the month knows about, whoever paid it — which is why it is not
 * `ΣK` and never totals anything. A capital improvement's expense is the
 * exception: 7.4 makes one capital allocation (`Nout`) rather than a known
 * expense, and 15.3 records it from the asset's page. Only its **presentation**
 * is filtered here; the loaders' rows, and every figure built from them, keep it.
 *
 * ## Sources this section cannot record
 *
 * The expense services refuse to materialize anything filed under a capital
 * improvement or a transfer fee (`assertCategoryUsableInPhase3`). A source under
 * one can only be legacy — older than that guard, or written below it — and its
 * schedule is schedule truth all the same: completeness counts its occurrences.
 * So every occurrence is shown, marked by its source's `protection`, and none is
 * described as recordable or as reachable by "Paid today". What such a source
 * already recorded is shown as recorded and offered for no correction.
 */

export interface MonthlyExpensesInput {
  readonly month: MonthKey;
  readonly today: PlainDate;
  /** Expense entries whose **financial** date falls in the month. */
  readonly incurredInMonth: readonly ExpenseEntryRow[];
  /** The schedule window's templates: every kind, filtered to expense sources here. */
  readonly scheduleTemplates: readonly RecurringTemplateRow[];
  readonly terms: readonly RecurringTemplateTermRow[];
  /** Every category of the user's, archived included, from the read that classified the month. */
  readonly categories: readonly CategoryRecord[];
  readonly positions: readonly PositionRow[];
  readonly rows: MonthlyExpenseRows;
  /**
   * `completed` keeps every generated occurrence, archived or not (12.6);
   * `current` drops the unresolved occurrences of archived sources (§30.10).
   */
  readonly shape: 'completed' | 'current';
}

const label = (month: MonthKey): string => (month as string).slice(0, 7);

const monthOf = (date: string): string => date.slice(0, 7);

/**
 * What Known expenses may do with a category of this kind.
 *
 * A contract of this section, not of the expense service: the service still
 * accepts every kind 7.4 defines for an unlinked expense, and a later phase's
 * workflow will record the others.
 */
export function expenseCategoryUseOf(kind: string): ExpenseCategoryUseDto {
  if ((consumptionCategoryKinds as readonly string[]).includes(kind)) return 'spending';
  if (kind === 'external_outflow') return 'money_out';
  return 'other';
}

/**
 * Whether Known expenses can record anything filed under this kind.
 *
 * The same two kinds `assertCategoryUsableInPhase3` refuses, stated as data so
 * the page never offers an action that guard must refuse. It is not a second
 * rule: an integration test holds the two together, kind by kind.
 */
export function expenseSourceProtectionOf(kind: string): ExpenseSourceProtectionDto | null {
  return kind === 'capital_improvement' || kind === 'transfer_fee' ? kind : null;
}

function categoryDtoOf(row: CategoryRecord): ExpenseCategoryDto {
  const use = expenseCategoryUseOf(row.kind);
  const archived = row.archivedAt !== null;
  return {
    categoryId: row.id,
    name: row.name,
    kind: row.kind,
    use,
    archived,
    selectable: !archived && use !== 'other',
  };
}

/** Capital allocation, never a known expense (7.4). */
const isCapitalImprovement = (category: ExpenseCategoryDto): boolean =>
  category.kind === 'capital_improvement';

function scheduleOf(template: RecurringTemplateRow): RecurrenceSchedule {
  return {
    frequency: template.frequency,
    dayOfMonth: template.dayOfMonth,
    startDate: plainDate(template.startDate),
    endDate: template.endDate === null ? null : plainDate(template.endDate),
  };
}

function toTemplateTerm(row: RecurringTemplateTermRow): TemplateTerm {
  return {
    id: row.id,
    templateId: row.templateId,
    effectiveFrom: plainDate(row.effectiveFrom),
    // NUMERIC arrives as an exact decimal string; no digit is lost (7.1).
    amount: new Decimal(row.amount),
    grossAmount: row.grossAmount === null ? null : new Decimal(row.grossAmount),
  };
}

/** The term an occurrence takes, and whether its amount could become an expense. */
function termOf(
  terms: readonly RecurringTemplateTermRow[],
  occurrenceDate: PlainDate,
  currency: string,
): { readonly term: ExpenseTermDto; readonly positiveAmount: boolean } {
  const applicable = termForOccurrence(terms.map(toTemplateTerm), occurrenceDate);
  const exactRow = terms.find((row) => row.effectiveFrom === (occurrenceDate as string));

  return {
    term: {
      amount: applicable === undefined ? null : moneyDto(applicable.amount.toString(), currency),
      effectiveFrom: applicable?.effectiveFrom ?? null,
      exact:
        exactRow === undefined
          ? { state: 'absent' }
          : {
              state: 'version',
              termId: exactRow.id,
              version: exactRow.version,
              note: exactRow.note,
            },
    },
    // Decided on the exact decimal: an expense must be more than zero (6.2), so
    // a zero term is known in advance to need the amount stated.
    positiveAmount: applicable !== undefined && applicable.amount.greaterThan(0),
  };
}

/**
 * Why the section shows a row without offering to change it, if it does.
 *
 * A row a source scheduled keeps the recurring correction whatever its kind —
 * its classification is its source's and is not offered anyway, so nothing can
 * be reclassified by it — unless its kind is one the services would refuse to
 * record today, whose history this section leaves exactly as it was recorded.
 */
function readOnlyReasonOf(
  row: ExpenseEntryRow,
  category: ExpenseCategoryDto,
): ExpenseReadOnlyReasonDto | null {
  if (row.transferId !== null) return 'transfer_fee';
  // Nothing this section offers pays an expense this way; the row came from
  // the workflow that does, and keeps its meaning.
  if (row.settlement === 'deducted_from_asset') return 'other_workflow';
  if (row.templateId === null && category.use === 'other') return 'other_workflow';
  if (expenseSourceProtectionOf(category.kind) !== null) return 'other_workflow';
  return null;
}

const occurrenceKeyOf = (templateId: string, occurrenceDate: string): string =>
  `${templateId}#${occurrenceDate}`;

const byDateThenTemplate = (
  a: { readonly occurrenceDate: string; readonly templateId: string },
  b: { readonly occurrenceDate: string; readonly templateId: string },
): number =>
  a.occurrenceDate === b.occurrenceDate
    ? a.templateId.localeCompare(b.templateId)
    : a.occurrenceDate < b.occurrenceDate
      ? -1
      : 1;

interface Context {
  readonly category: (categoryId: string) => ExpenseCategoryDto;
  readonly source: (template: RecurringTemplateRow, categoryId: string) => ExpenseSourceDto;
  readonly termsOf: (templateId: string) => readonly RecurringTemplateTermRow[];
}

function build(input: MonthlyExpensesInput): { dto: MonthlyExpensesDto; context: Context } {
  const from = startOfMonthKey(input.month);
  const to = endOfMonthKey(input.month);

  const categoryRows = input.categories.map(categoryDtoOf);
  const categoriesById = new Map(categoryRows.map((row) => [row.categoryId, row]));
  const category = (categoryId: string): ExpenseCategoryDto => {
    const found = categoriesById.get(categoryId);
    /* v8 ignore next 2 -- `category_id` is NOT NULL with a composite FK to the
       user's own categories, and the loader read every one, archived included. */
    if (found === undefined) throw new Error(`category ${categoryId} was not loaded`);
    return found;
  };

  const cashAccounts = input.positions
    .filter((row) => row.kind === 'cash')
    .map((row) => ({
      positionId: row.id,
      name: row.name,
      currency: row.currency,
      openedOn: row.openedOn,
      closedOn: row.closedOn,
    }));
  const accountNames = new Map(cashAccounts.map((account) => [account.positionId, account.name]));
  const accountName = (positionId: string): string | null => accountNames.get(positionId) ?? null;

  // Every source the page can name: the schedule window's, plus the ones a row
  // on the page references and no window would have loaded.
  const templatesById = new Map<string, RecurringTemplateRow>();
  for (const template of [...input.scheduleTemplates, ...input.rows.referencedTemplates]) {
    templatesById.set(template.id, template);
  }
  const templateName = (templateId: string): string =>
    templatesById.get(templateId)?.name ?? 'Unknown source';

  const termsByTemplate = new Map<string, RecurringTemplateTermRow[]>();
  for (const row of input.terms) {
    const list = termsByTemplate.get(row.templateId);
    if (list === undefined) termsByTemplate.set(row.templateId, [row]);
    else list.push(row);
  }
  const termsOf = (templateId: string): readonly RecurringTemplateTermRow[] =>
    termsByTemplate.get(templateId) ?? [];

  // The end of the last completed month (8.1): what an end-date change can
  // alter in a month whose completeness is already being reported.
  const lastCompletedDay = addDays(startOfMonth(input.today), -1);
  const sources = new Map<string, ExpenseSourceDto>();
  const source = (template: RecurringTemplateRow, categoryId: string): ExpenseSourceDto => {
    const cached = sources.get(template.id);
    if (cached !== undefined) return cached;
    const schedule = scheduleOf(template);
    const sourceCategory = category(categoryId);
    const created: ExpenseSourceDto = {
      templateId: template.id,
      version: template.version,
      name: template.name,
      counterparty: template.counterparty,
      currency: template.currency,
      category: sourceCategory,
      startDate: template.startDate,
      endDate: template.endDate,
      archived: template.archivedAt !== null,
      protection: expenseSourceProtectionOf(sourceCategory.kind),
      defaultCashPositionId: template.cashPositionId,
      defaultCashAccountName:
        template.cashPositionId === null ? null : accountName(template.cashPositionId),
      // As though it never ended, so both a shorter and a longer end date can
      // be measured against the same dates.
      completedOccurrenceDates: occurrencesInRange(
        { ...schedule, endDate: null },
        schedule.startDate,
        lastCompletedDay,
      ),
    };
    sources.set(template.id, created);
    return created;
  };

  const entry = (row: ExpenseEntryRow): MonthlyExpenseEntryDto => {
    const rowCategory = category(row.categoryId);
    return {
      entryId: row.id,
      version: row.version,
      category: rowCategory,
      settlement: row.settlement,
      incurredOn: row.incurredOn,
      incurredMonth: monthOf(row.incurredOn),
      amount: moneyDto(row.amount, row.currency),
      currency: row.currency,
      cashPositionId: row.cashPositionId,
      cashAccountName: row.cashPositionId === null ? null : accountName(row.cashPositionId),
      description: row.description,
      isOneOff: row.isOneOff,
      readOnly: readOnlyReasonOf(row, rowCategory),
      occurrence:
        row.templateId === null || row.occurrenceDate === null
          ? null
          : {
              templateId: row.templateId,
              templateName: templateName(row.templateId),
              occurrenceDate: row.occurrenceDate,
              occurrenceMonth: monthOf(row.occurrenceDate),
            },
    };
  };

  const acceptedByOccurrence = new Map<string, ExpenseEntryRow>();
  for (const row of input.rows.occurrenceEntries) {
    if (row.templateId === null || row.occurrenceDate === null) continue;
    acceptedByOccurrence.set(occurrenceKeyOf(row.templateId, row.occurrenceDate), row);
  }

  const skipByOccurrence = new Map<string, RecurringTemplateSkipRow>();
  for (const row of input.rows.skips) {
    skipByOccurrence.set(occurrenceKeyOf(row.templateId, row.occurrenceDate), row);
  }

  const eligible =
    'paidTodayCandidates' in input.rows
      ? (input.rows as CurrentMonthExpenseRows).paidTodayCandidates
      : undefined;

  const occurrences: ExpenseOccurrenceDto[] = [];
  const embeddedEntryIds = new Set<string>();

  for (const template of templatesById.values()) {
    if (template.kind !== 'expense' || template.categoryId === null) continue;
    const categoryId = template.categoryId;
    const archived = template.archivedAt !== null;
    // Every expense source's schedule is shown, a protected one's included:
    // completeness counts its occurrences, so none may vanish from here.
    const recordable = expenseSourceProtectionOf(category(categoryId).kind) === null;

    for (const occurrenceDate of occurrencesInRange(scheduleOf(template), from, to)) {
      const key = occurrenceKeyOf(template.id, occurrenceDate);
      const accepted = acceptedByOccurrence.get(key);
      const skip = skipByOccurrence.get(key);

      // An archived source keeps what it already resolved — those are source
      // facts — but offers the live month no new occurrence (§30.10).
      if (accepted === undefined && skip === undefined && archived && input.shape === 'current') {
        continue;
      }

      let state: ExpenseOccurrenceDto['state'];
      if (accepted !== undefined) {
        embeddedEntryIds.add(accepted.id);
        state = { kind: 'accepted', entry: entry(accepted) };
      } else if (skip !== undefined) {
        state = { kind: 'skipped', skipId: skip.id, reason: skip.reason, note: skip.note };
      } else if (occurrenceDate > input.today) {
        state = {
          kind: 'upcoming',
          paidTodayEligible: recordable && eligible?.get(template.id) === occurrenceDate,
        };
      } else {
        state = { kind: 'due' };
      }

      const { term, positiveAmount } = termOf(
        termsOf(template.id),
        occurrenceDate,
        template.currency,
      );
      occurrences.push({
        templateId: template.id,
        occurrenceDate,
        source: source(template, categoryId),
        term,
        recordableAsExpected: recordable && positiveAmount,
        state,
      });
    }
  }

  // The same order `scheduledOccurrences` produces, whatever order the
  // templates arrived in.
  occurrences.sort(byDateThenTemplate);

  // What is left after the embedded entries are removed — the subtraction is the
  // duplicate-prevention rule — and without the capital improvements this
  // section does not present.
  const remaining = input.incurredInMonth.filter(
    (row) => !embeddedEntryIds.has(row.id) && !isCapitalImprovement(category(row.categoryId)),
  );

  return {
    dto: {
      occurrences,
      otherRecurring: remaining.filter((row) => row.templateId !== null).map(entry),
      direct: remaining.filter((row) => row.templateId === null).map(entry),
      eligibleCategories: categoryRows.filter((row) => row.selectable),
      cashAccounts,
    },
    context: { category, source, termsOf },
  };
}

export function monthlyExpensesOf(input: MonthlyExpensesInput): MonthlyExpensesDto {
  return build(input).dto;
}

export function currentMonthlyExpensesOf(
  input: MonthlyExpensesInput & { readonly rows: CurrentMonthExpenseRows },
): CurrentMonthlyExpensesDto {
  const { dto, context } = build(input);
  const to = endOfMonthKey(input.month);
  const activeById = new Map(input.rows.activeTemplates.map((row) => [row.id, row]));

  const paidTodayCandidates: PaidTodayCandidateDto[] = [];
  for (const [templateId, occurrenceDate] of input.rows.paidTodayCandidates) {
    // A candidate inside the month is already an `upcoming` occurrence above,
    // flagged eligible there. Listing it again would be the same offer twice.
    if (occurrenceDate <= to) continue;
    const template = activeById.get(templateId);
    /* v8 ignore next -- candidates are derived from these same templates, and an
       expense template's category is non-null by a 6.2 CHECK. */
    if (template === undefined || template.categoryId === null) continue;
    // Never an offer the services must refuse: a protected source cannot be
    // recorded here at all, early or otherwise.
    if (expenseSourceProtectionOf(context.category(template.categoryId).kind) !== null) continue;

    const { term, positiveAmount } = termOf(
      context.termsOf(templateId),
      occurrenceDate,
      template.currency,
    );
    paidTodayCandidates.push({
      templateId,
      occurrenceDate,
      occurrenceMonth: label(monthKey(occurrenceDate)),
      source: context.source(template, template.categoryId),
      term,
      recordableAsExpected: positiveAmount,
    });
  }

  paidTodayCandidates.sort(byDateThenTemplate);

  return { ...dto, paidTodayCandidates };
}
