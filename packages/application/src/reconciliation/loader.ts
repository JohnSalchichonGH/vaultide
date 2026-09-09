import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listResolvedOccurrencesInRange,
  listTemplatesForRange,
  listTransfers,
  loadFinancialWindow,
  loadTermsForRange,
  type CategoryRecord,
  type Database,
  type ExpenseEntryRow,
  type IncomeEntryRow,
  type PositionRecord as PositionRow,
  type RecurringTemplateRow,
  type RecurringTemplateTermRow,
  type TransferRow,
} from '@vaultide/db';
import {
  Decimal,
  currencyCode,
  endOfMonthKey,
  occurrenceKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type CompletedMonthInput,
  type CompletenessTemplate,
  type ExpenseFlow,
  type IncomeFlow,
  type MonthKey,
  type TransferFlow,
} from '@vaultide/finance';
import { toValuationRecord, toPositionRecord } from '../positions/mapping';

/**
 * Everything one completed month's reconciliation reads, in a fixed number of
 * queries (blueprint 23.2, ADR 0004 §3).
 *
 * Six bulk reads, none of them per position, per flow or per template:
 * positions with their valuations, the month's income, expenses and transfers,
 * the categories, the templates whose schedule overlaps the month with their
 * terms, and the occurrences something already resolved. The count does not
 * grow with the amount of data, which is the whole point — a month with two
 * hundred expenses costs the same round trips as a month with two.
 *
 * Two loading rules are load-bearing rather than incidental:
 *
 *  - **Valuations have no lower bound** (ADR 0004 §3). A month's opening
 *    balance is the previous month's statement, and a balance carried from
 *    further back is still the account's value. Windowing them would turn a
 *    carried balance into `missing` and an ordinary month into `unavailable`.
 *  - **Templates are loaded regardless of `archived_at`** (v2.1.7 §30.10).
 *    Archiving is present-tense visibility; the historical schedule is
 *    `start_date`/`end_date`. A template archived today still expected a salary
 *    last September, and filtering here would let today's tidying erase a
 *    genuinely missing record from the report that exists to find it. This is
 *    deliberately *not* the loader `suggestions.ts` uses, which filters
 *    archived templates because it answers a question about now.
 */

export interface MonthDataDependencies {
  readonly db: Database;
}

/** The rows behind one month, kept alongside the engine input for the DTO. */
export interface CompletedMonthData {
  readonly input: CompletedMonthInput;
  readonly positions: readonly PositionRow[];
  readonly categories: readonly CategoryRecord[];
  readonly templates: readonly RecurringTemplateRow[];
  readonly terms: readonly RecurringTemplateTermRow[];
}

export function toIncomeFlow(row: IncomeEntryRow): IncomeFlow {
  return {
    id: row.id,
    kind: row.kind,
    receivedOn: plainDate(row.receivedOn),
    // NUMERIC arrives as an exact decimal string; no digit is lost (7.1).
    netAmount: new Decimal(row.netAmount),
    currency: currencyCode(row.currency),
    settlement: row.settlement,
    cashPositionId: row.cashPositionId,
    investmentPositionId: row.investmentPositionId,
  };
}

export function toExpenseFlow(row: ExpenseEntryRow, kindOf: ReadonlyMap<string, string>): ExpenseFlow {
  const kind = kindOf.get(row.categoryId);
  /* v8 ignore next 2 -- `category_id` is NOT NULL with a composite FK to the
     user's own categories, so a row without one cannot exist. */
  if (kind === undefined) throw new Error(`expense ${row.id} references an unknown category`);

  return {
    id: row.id,
    // 7.4 classifies on the category's **kind**, never on its name: a user may
    // rename "Capital improvement" to anything and the accounting must not move.
    categoryKind: kind as ExpenseFlow['categoryKind'],
    incurredOn: plainDate(row.incurredOn),
    amount: new Decimal(row.amount),
    currency: currencyCode(row.currency),
    settlement: row.settlement,
    cashPositionId: row.cashPositionId,
    transferId: row.transferId,
  };
}

export function toTransferFlow(row: TransferRow): TransferFlow {
  return {
    id: row.id,
    kind: row.kind,
    occurredOn: plainDate(row.occurredOn),
    fromPositionId: row.fromPositionId,
    fromCurrency: currencyCode(row.fromCurrency),
    fromAmount: new Decimal(row.fromAmount),
    toPositionId: row.toPositionId,
    toCurrency: currencyCode(row.toCurrency),
    toAmount: new Decimal(row.toAmount),
  };
}

export function toCompletenessTemplate(row: RecurringTemplateRow): CompletenessTemplate {
  return {
    templateId: row.id,
    name: row.name,
    kind: row.kind,
    currency: currencyCode(row.currency),
    incomeKind: row.incomeKind,
    schedule: {
      frequency: row.frequency,
      dayOfMonth: row.dayOfMonth,
      startDate: plainDate(row.startDate),
      endDate: row.endDate === null ? null : plainDate(row.endDate),
    },
  };
}

export async function loadCompletedMonth(
  deps: MonthDataDependencies,
  userId: string,
  month: MonthKey,
  today: string,
): Promise<CompletedMonthData> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);

  const [window, income, expenses, transfers, categories, templates, resolved] = await Promise.all([
    // `to` and not `today`: a month is reconciled from the evidence that
    // belongs to it, and a balance dated after it says nothing about its close.
    loadFinancialWindow(deps.db, userId, to),
    listIncomeEntries(deps.db, userId, from, to),
    listExpenseEntries(deps.db, userId, from, to),
    listTransfers(deps.db, userId, from, to),
    // Archived categories included: an expense keeps its category, and the kind
    // of an archived one still decides how that expense is classified (R12).
    listCategoryRecords(deps.db, userId, { includeArchived: true }),
    listTemplatesForRange(deps.db, userId, from, to),
    listResolvedOccurrencesInRange(deps.db, userId, from, to),
  ]);

  const terms = await loadTermsForRange(
    deps.db,
    userId,
    templates.map((template) => template.id),
    from,
    to,
  );

  const valuationsByPosition = new Map<string, ReturnType<typeof toValuationRecord>[]>();
  for (const row of window.valuations) {
    const list = valuationsByPosition.get(row.positionId);
    const record = toValuationRecord(row);
    if (list === undefined) valuationsByPosition.set(row.positionId, [record]);
    else list.push(record);
  }

  const cashAccounts: CashAccountInput[] = window.positions
    .filter((row) => row.kind === 'cash')
    .map((row) => ({
      position: toPositionRecord(row),
      valuations: valuationsByPosition.get(row.id) ?? [],
      // 8.5 asks whether uncredited interest is plausible here, and only the
      // account type can answer that.
      accountType: row.accountType ?? 'checking',
    }));

  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));

  return {
    input: {
      month,
      today: plainDate(today),
      cashAccounts,
      income: income.map(toIncomeFlow),
      expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
      transfers: transfers.map(toTransferFlow),
      templates: templates.map(toCompletenessTemplate),
      resolvedOccurrences: new Set(
        resolved.map((row) => occurrenceKey(row.templateId, row.occurrenceDate)),
      ),
    },
    positions: window.positions,
    categories,
    templates,
    terms,
  };
}
