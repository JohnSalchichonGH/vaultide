import type {
  IncomeEntryRow,
  PositionRecord as PositionRow,
  RecurringTemplateRow,
  RecurringTemplateSkipRow,
  RecurringTemplateTermRow,
} from '@vaultide/db';
import {
  Decimal,
  endOfMonthKey,
  monthKey,
  occurrencesInRange,
  plainDate,
  startOfMonthKey,
  termForOccurrence,
  type MonthKey,
  type PlainDate,
  type RecurrenceSchedule,
  type TemplateTerm,
} from '@vaultide/finance';
import { moneyDto } from '../positions/mapping';
import type { CurrentMonthIncomeRows, MonthlyIncomeRows } from './income-loader';
import type {
  CurrentMonthlyIncomeDto,
  EarlyReceiptCandidateDto,
  IncomeOccurrenceDto,
  MonthlyIncomeDto,
  MonthlyIncomeEntryDto,
  OccurrenceTermDto,
} from './types';

/**
 * Monthly's Income section, from rows already loaded (blueprint 6.2, 8.5, 12.6,
 * 15.3 section 2, v2.1.6 §30.9, v2.1.7 §30.10).
 *
 * Nothing here queries, and nothing here invents a schedule. The occurrences a
 * month contains come from `occurrencesInRange` and the term of each from
 * `termForOccurrence` — the same pure functions the completeness count and the
 * accept service use, so the section cannot disagree with
 * `suggested_income_missing` about which occurrences a month expected or with
 * an acceptance about what one is worth.
 *
 * ## Two questions, one partition
 *
 * A month cares about income for two unrelated reasons, and an entry can answer
 * one without answering the other:
 *
 *  - **schedule membership** — `occurrence_date ∈ M`. It decides completeness,
 *    `suggested_income_missing`, which term applies and what may be accepted.
 *  - **financial membership** — `received_on ∈ M`. It decides reconciliation,
 *    the savings figures, and which page may edit the row.
 *
 * `occurrences` answers the first and embeds whatever resolved each occurrence.
 * `otherRecurring` and `direct` answer the second over the entries left after
 * the embedded ones are removed by id. The subtraction is what makes double
 * rendering impossible: an entry is embedded above or listed below, never both.
 *
 * ## Which sources generate occurrences
 *
 * `archived_at` is present-tense visibility and never a schedule boundary
 * (§30.10). A completed month therefore generates from every source whose
 * `start_date`/`end_date` cover it, archived or not — that is precisely the set
 * 12.6 counts. A current month generates from the active sources, because its
 * surface is operational rather than a completeness report (30.13 item 10); an
 * archived source keeps the occurrences it already resolved, because those are
 * source facts, but produces no new unresolved suggestion.
 */

export interface MonthlyIncomeInput {
  readonly month: MonthKey;
  readonly today: PlainDate;
  /** Income entries whose **financial** date falls in the month. */
  readonly receivedInMonth: readonly IncomeEntryRow[];
  /** The schedule window's templates: every kind, filtered to income here. */
  readonly scheduleTemplates: readonly RecurringTemplateRow[];
  readonly terms: readonly RecurringTemplateTermRow[];
  readonly positions: readonly PositionRow[];
  readonly rows: MonthlyIncomeRows;
  /**
   * `completed` keeps every generated occurrence, archived or not (12.6);
   * `current` drops the unresolved occurrences of archived sources, which is
   * the operational reading of the same rule (§30.10).
   */
  readonly shape: 'completed' | 'current';
}

const label = (month: MonthKey): string => (month as string).slice(0, 7);

const monthOf = (date: string): string => date.slice(0, 7);

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

/** The terms of one template, and whether one starts exactly at a date. */
function termDtoOf(
  terms: readonly RecurringTemplateTermRow[],
  occurrenceDate: PlainDate,
  currency: string,
): OccurrenceTermDto {
  const applicable = termForOccurrence(terms.map(toTemplateTerm), occurrenceDate);
  const exactRow = terms.find((row) => row.effectiveFrom === (occurrenceDate as string));

  return {
    net: applicable === undefined ? null : moneyDto(applicable.amount.toString(), currency),
    gross:
      applicable?.grossAmount == null
        ? null
        : moneyDto(applicable.grossAmount.toString(), currency),
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
  };
}

function entryDto(
  row: IncomeEntryRow,
  templateName: (templateId: string) => string,
  accountName: (positionId: string) => string | null,
): MonthlyIncomeEntryDto {
  return {
    entryId: row.id,
    version: row.version,
    kind: row.kind,
    settlement: row.settlement,
    receivedOn: row.receivedOn,
    receivedMonth: monthOf(row.receivedOn),
    net: moneyDto(row.netAmount, row.currency),
    gross: row.grossAmount === null ? null : moneyDto(row.grossAmount, row.currency),
    currency: row.currency,
    cashPositionId: row.cashPositionId,
    cashAccountName: row.cashPositionId === null ? null : accountName(row.cashPositionId),
    description: row.description,
    tags: row.tags,
    isOneOff: row.isOneOff,
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
}

const occurrenceKeyOf = (templateId: string, occurrenceDate: string): string =>
  `${templateId}#${occurrenceDate}`;

export function monthlyIncomeOf(input: MonthlyIncomeInput): MonthlyIncomeDto {
  const from = startOfMonthKey(input.month);
  const to = endOfMonthKey(input.month);

  const cashAccounts = input.positions
    .filter((row) => row.kind === 'cash')
    .map((row) => ({ positionId: row.id, name: row.name, currency: row.currency }));
  const accountNames = new Map(cashAccounts.map((account) => [account.positionId, account.name]));
  const accountName = (positionId: string): string | null =>
    accountNames.get(positionId) ?? null;

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

  const acceptedByOccurrence = new Map<string, IncomeEntryRow>();
  for (const row of input.rows.occurrenceEntries) {
    if (row.templateId === null || row.occurrenceDate === null) continue;
    acceptedByOccurrence.set(occurrenceKeyOf(row.templateId, row.occurrenceDate), row);
  }

  const skipByOccurrence = new Map<string, RecurringTemplateSkipRow>();
  for (const row of input.rows.skips) {
    skipByOccurrence.set(occurrenceKeyOf(row.templateId, row.occurrenceDate), row);
  }

  const eligible =
    'earlyReceiptCandidates' in input.rows
      ? (input.rows as CurrentMonthIncomeRows).earlyReceiptCandidates
      : undefined;

  const occurrences: IncomeOccurrenceDto[] = [];
  const embeddedEntryIds = new Set<string>();

  for (const template of templatesById.values()) {
    if (template.kind !== 'income' || template.incomeKind === null) continue;
    const archived = template.archivedAt !== null;
    const terms = termsByTemplate.get(template.id) ?? [];

    for (const occurrenceDate of occurrencesInRange(scheduleOf(template), from, to)) {
      const key = occurrenceKeyOf(template.id, occurrenceDate);
      const accepted = acceptedByOccurrence.get(key);
      const skip = skipByOccurrence.get(key);

      // An archived source keeps what it already resolved — those are source
      // facts — but offers the live month no new suggestion (§30.10).
      if (accepted === undefined && skip === undefined && archived && input.shape === 'current') {
        continue;
      }

      let state: IncomeOccurrenceDto['state'];
      if (accepted !== undefined) {
        embeddedEntryIds.add(accepted.id);
        state = { kind: 'accepted', entry: entryDto(accepted, templateName, accountName) };
      } else if (skip !== undefined) {
        state = { kind: 'skipped', skipId: skip.id, reason: skip.reason, note: skip.note };
      } else if (occurrenceDate > input.today) {
        state = {
          kind: 'upcoming',
          receivedTodayEligible: eligible?.get(template.id) === occurrenceDate,
        };
      } else {
        state = { kind: 'due' };
      }

      occurrences.push({
        templateId: template.id,
        templateName: template.name,
        counterparty: template.counterparty,
        incomeKind: template.incomeKind,
        currency: template.currency,
        occurrenceDate,
        term: termDtoOf(terms, occurrenceDate, template.currency),
        defaultCashPositionId: template.cashPositionId,
        defaultCashAccountName:
          template.cashPositionId === null ? null : accountName(template.cashPositionId),
        sourceArchived: archived,
        state,
      });
    }
  }

  // The same order `scheduledOccurrences` produces, so a month always reads the
  // same way whatever order the templates arrived in.
  occurrences.sort((a, b) =>
    a.occurrenceDate === b.occurrenceDate
      ? a.templateId.localeCompare(b.templateId)
      : a.occurrenceDate < b.occurrenceDate
        ? -1
        : 1,
  );

  // What is left after the embedded entries are removed: the subtraction is the
  // duplicate-prevention rule, not a convention about which list to look in.
  const remaining = input.receivedInMonth.filter((row) => !embeddedEntryIds.has(row.id));

  return {
    occurrences,
    otherRecurring: remaining
      .filter((row) => row.templateId !== null)
      .map((row) => entryDto(row, templateName, accountName)),
    direct: remaining
      .filter((row) => row.templateId === null)
      .map((row) => entryDto(row, templateName, accountName)),
    cashAccounts,
  };
}

export function currentMonthlyIncomeOf(
  input: MonthlyIncomeInput & { readonly rows: CurrentMonthIncomeRows },
): CurrentMonthlyIncomeDto {
  const base = monthlyIncomeOf(input);
  const to = endOfMonthKey(input.month);

  const termsByTemplate = new Map<string, RecurringTemplateTermRow[]>();
  for (const row of input.terms) {
    const list = termsByTemplate.get(row.templateId);
    if (list === undefined) termsByTemplate.set(row.templateId, [row]);
    else list.push(row);
  }

  const templatesById = new Map(input.rows.activeTemplates.map((row) => [row.id, row]));
  const accountNames = new Map(
    input.positions.filter((row) => row.kind === 'cash').map((row) => [row.id, row.name]),
  );

  const earlyReceiptCandidates: EarlyReceiptCandidateDto[] = [];
  for (const [templateId, occurrenceDate] of input.rows.earlyReceiptCandidates) {
    // A candidate inside the month is already an `upcoming` occurrence above,
    // flagged eligible there. Listing it again would be the same offer twice.
    if (occurrenceDate <= to) continue;
    const template = templatesById.get(templateId);
    /* v8 ignore next -- candidates are derived from these same templates. */
    if (template === undefined || template.incomeKind === null) continue;

    earlyReceiptCandidates.push({
      templateId,
      templateName: template.name,
      incomeKind: template.incomeKind,
      currency: template.currency,
      occurrenceDate,
      occurrenceMonth: label(monthKey(occurrenceDate)),
      term: termDtoOf(termsByTemplate.get(templateId) ?? [], occurrenceDate, template.currency),
      defaultCashPositionId: template.cashPositionId,
      defaultCashAccountName:
        template.cashPositionId === null
          ? null
          : (accountNames.get(template.cashPositionId) ?? null),
    });
  }

  earlyReceiptCandidates.sort((a, b) =>
    a.occurrenceDate === b.occurrenceDate
      ? a.templateId.localeCompare(b.templateId)
      : a.occurrenceDate < b.occurrenceDate
        ? -1
        : 1,
  );

  return { ...base, earlyReceiptCandidates };
}
