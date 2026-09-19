import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listResolvedOccurrencesInRange,
  listTemplatesForRange,
  listTransfers,
  loadFinancialWindow,
  loadTermsForRange,
  type ExpenseEntryRow,
  type IncomeEntryRow,
  type PositionRecord as PositionRow,
  type TransferRow,
  type ValuationRow,
} from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  occurrenceKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type CompletedMonthInput,
  type CompletenessTemplate,
  type ExpenseFlow,
  type IncomeFlow,
  type MonthKey,
  type PositionWithValuations,
  type TransferFlow,
} from '@vaultide/finance';
import { toPositionRecord, toValuationRecord } from '../positions/mapping';
import {
  toCompletenessTemplate,
  toExpenseFlow,
  toIncomeFlow,
  toTransferFlow,
  type CompletedMonthData,
  type MonthDataDependencies,
} from './loader';

/**
 * A range of completed months, loaded once (blueprint 23.2).
 *
 * The single-month loader is right for one month and wrong for twelve: calling
 * it per month would multiply every read by the range and turn a series into an
 * N+1 in months. This reads the same eight things over the whole range and
 * slices them in memory, so the query count is what it was for one month and
 * does not move when the range, the accounts, the flows, the currencies or the
 * templates grow.
 *
 * The valuation window keeps its rule: `loadFinancialWindow` has no lower bound
 * (ADR 0004 §3), because the opening balance of the first month in the range
 * lies before it and truncating the evidence would report a gap that is not
 * there.
 */

export interface CompletedRangeData
  extends Pick<CompletedMonthData, 'positions' | 'categories' | 'templates' | 'terms'> {
  readonly months: readonly MonthKey[];
  readonly inputs: ReadonlyMap<MonthKey, CompletedMonthInput>;
  /**
   * Every position of every kind with its valuations up to the range's end —
   * what 12.6's `stale` rule reads for the range's last month (v2.1.15 30.18
   * item 3). From the window already loaded; no query of its own.
   */
  readonly positionsWithValuations: readonly PositionWithValuations[];
  /**
   * The same valuations as the rows the window returned, with the id and
   * version an edit of one needs — what Monthly's Accounts section shows beside
   * each state. From the window already loaded; no query of its own.
   */
  readonly valuations: readonly ValuationRow[];
  /**
   * The range's income entries as the rows they are, keyed on their **financial**
   * date — what Monthly's Income section lists as received in the month, with
   * the occurrence link, gross, description and version the engine input drops.
   * Already read to build that input; no query of its own.
   */
  readonly income: readonly IncomeEntryRow[];
  /**
   * The range's expense entries as the rows they are, keyed on their
   * **financial** date — what Monthly's Known-expenses section lists as incurred
   * in the month, with the occurrence link, description, one-off flag and
   * version the engine input drops. Already read to build that input; no query
   * of its own.
   */
  readonly expenses: readonly ExpenseEntryRow[];
  /**
   * The range's transfers as the rows they are, keyed on their **financial**
   * date — what Monthly's Accounts section lists as the month's transfers, with
   * the description and version the engine input drops. Already read to build
   * that input; no query of its own.
   */
  readonly transfers: readonly TransferRow[];
}

/** The completed months of `[from, to]`, oldest first. */
export function monthsInRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let m = from; m <= to; m = monthKey(addMonths(startOfMonthKey(m), 1))) months.push(m);
  return months;
}

/** What `completedMonthInputsOf` slices: the range's rows, already mapped for the engine. */
export interface CompletedMonthInputRows {
  readonly months: readonly MonthKey[];
  readonly today: string;
  readonly cashAccounts: readonly CashAccountInput[];
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
  readonly templates: readonly CompletenessTemplate[];
  readonly resolvedOccurrences: ReadonlySet<string>;
}

/**
 * One engine input per completed month, sliced from rows read once over the
 * whole range.
 *
 * Every month gets the whole valuation evidence and the flows dated inside it,
 * which is what the single-month loader would have read for it. Shared by the
 * range loader and the Spending page's loader, so a month is sliced one way
 * wherever it is read (ADR 0008 §3).
 */
export function completedMonthInputsOf(rows: CompletedMonthInputRows): Map<MonthKey, CompletedMonthInput> {
  const inputs = new Map<MonthKey, CompletedMonthInput>();
  for (const month of rows.months) {
    const start = startOfMonthKey(month);
    const end = endOfMonthKey(month);
    const within = (on: string): boolean => on >= start && on <= end;

    inputs.set(month, {
      month,
      today: plainDate(rows.today),
      cashAccounts: rows.cashAccounts,
      income: rows.income.filter((flow) => within(flow.receivedOn)),
      expenses: rows.expenses.filter((flow) => within(flow.incurredOn)),
      transfers: rows.transfers.filter((flow) => within(flow.occurredOn)),
      // The engine filters a template against the month by its own schedule, so
      // the range's templates go to every month unchanged and each one sees the
      // same set the single-month path would have loaded for it.
      templates: rows.templates,
      resolvedOccurrences: rows.resolvedOccurrences,
    });
  }
  return inputs;
}

/** Each cash account with its own valuations, from one window's rows. */
export function cashAccountInputsOf(
  positions: readonly PositionRow[],
  valuations: readonly ValuationRow[],
): CashAccountInput[] {
  const valuationsByPosition = new Map<string, ReturnType<typeof toValuationRecord>[]>();
  for (const row of valuations) {
    const list = valuationsByPosition.get(row.positionId);
    const record = toValuationRecord(row);
    if (list === undefined) valuationsByPosition.set(row.positionId, [record]);
    else list.push(record);
  }
  return positions
    .filter((row) => row.kind === 'cash')
    .map((row) => ({
      position: toPositionRecord(row),
      valuations: valuationsByPosition.get(row.id) ?? [],
      accountType: row.accountType ?? 'checking',
    }));
}

export async function loadCompletedRange(
  deps: MonthDataDependencies,
  userId: string,
  fromMonth: MonthKey,
  toMonth: MonthKey,
  today: string,
): Promise<CompletedRangeData> {
  const months = monthsInRange(fromMonth, toMonth);
  const from = startOfMonthKey(fromMonth);
  const to = endOfMonthKey(toMonth);

  const [window, income, expenses, transfers, categories, templates, resolved] = await Promise.all([
    loadFinancialWindow(deps.db, userId, to),
    listIncomeEntries(deps.db, userId, from, to),
    listExpenseEntries(deps.db, userId, from, to),
    listTransfers(deps.db, userId, from, to),
    listCategoryRecords(deps.db, userId, { includeArchived: true }),
    listTemplatesForRange(deps.db, userId, from, to),
    listResolvedOccurrencesInRange(deps.db, userId, from, to),
  ]);

  // The terms of every template in the range, in one batched query — the same
  // conditional read the single-month path makes, and never one per template.
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
      accountType: row.accountType ?? 'checking',
    }));

  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));
  const inputs = completedMonthInputsOf({
    months,
    today,
    cashAccounts,
    income: income.map(toIncomeFlow),
    expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
    transfers: transfers.map(toTransferFlow),
    templates: templates.map(toCompletenessTemplate),
    resolvedOccurrences: new Set(
      resolved.map((row) => occurrenceKey(row.templateId, row.occurrenceDate)),
    ),
  });

  return {
    months,
    inputs,
    positions: window.positions,
    categories,
    templates,
    terms,
    positionsWithValuations: window.positions.map((row) => ({
      position: toPositionRecord(row),
      valuations: valuationsByPosition.get(row.id) ?? [],
    })),
    valuations: window.valuations,
    income,
    expenses,
    transfers,
  };
}
