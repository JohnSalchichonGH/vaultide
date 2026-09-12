import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listResolvedOccurrencesInRange,
  listTemplatesForRange,
  listTransfers,
  loadFinancialWindow,
  loadTermsForRange,
  type IncomeEntryRow,
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
  type MonthKey,
  type PositionWithValuations,
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
}

/** The completed months of `[from, to]`, oldest first. */
export function monthsInRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let m = from; m <= to; m = monthKey(addMonths(startOfMonthKey(m), 1))) months.push(m);
  return months;
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
  const completenessTemplates = templates.map(toCompletenessTemplate);
  const incomeFlows = income.map(toIncomeFlow);
  const expenseFlows = expenses.map((row) => toExpenseFlow(row, kindOf));
  const transferFlows = transfers.map(toTransferFlow);
  const resolvedKeys = new Set(
    resolved.map((row) => occurrenceKey(row.templateId, row.occurrenceDate)),
  );

  const inputs = new Map<MonthKey, CompletedMonthInput>();
  for (const month of months) {
    const start = startOfMonthKey(month);
    const end = endOfMonthKey(month);
    const within = (on: string): boolean => on >= start && on <= end;

    inputs.set(month, {
      month,
      today: plainDate(today),
      cashAccounts,
      income: incomeFlows.filter((flow) => within(flow.receivedOn)),
      expenses: expenseFlows.filter((flow) => within(flow.incurredOn)),
      transfers: transferFlows.filter((flow) => within(flow.occurredOn)),
      // The engine filters a template against the month by its own schedule, so
      // the range's templates go to every month unchanged and each one sees the
      // same set the single-month path would have loaded for it.
      templates: completenessTemplates,
      resolvedOccurrences: resolvedKeys,
    });
  }

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
  };
}
