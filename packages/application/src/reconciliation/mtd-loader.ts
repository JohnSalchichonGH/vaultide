import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listTransfers,
  loadFinancialWindow,
  type IncomeEntryRow,
  type PositionRecord as PositionRow,
  type ValuationRow,
} from '@vaultide/db';
import {
  monthKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type MonthToDateInput,
  type PlainDate,
} from '@vaultide/finance';
import { toPositionRecord, toValuationRecord } from '../positions/mapping';
import {
  toExpenseFlow,
  toIncomeFlow,
  toTransferFlow,
  type MonthDataDependencies,
} from './loader';

/**
 * Everything the current month's reconciliation reads (blueprint 8.6, 23.2).
 *
 * Five bulk reads, and the count does not grow with the amount of data:
 * positions with their valuations, the month's income, expenses and transfers
 * so far, and the categories that give an expense its accounting kind.
 *
 * Two differences from the completed-month loader, both from 8.6:
 *
 *  - **The upper bound is `today`, not the end of the month.** The as-of date
 *    `D` is not known until the engine has searched for it, so everything up to
 *    today has to be in hand — including the balances *after* `D`, which is how
 *    `mtd_newer_balances` can be raised at all.
 *  - **No recurring data is loaded.** 30.13 item 10 keeps
 *    `suggested_income_missing` a completed-month report: an occurrence
 *    scheduled later this month has not been missed, and the current month's
 *    recurring surface is the operational one in `recurring/suggestions.ts`.
 *
 * Valuations keep ADR 0004 §3's no-lower-bound rule. The month's opening is the
 * previous month's statement balance, and one carried from further back is
 * still the account's value; windowing them would turn a carried balance into
 * `missing` and a reconcilable month into `unavailable`.
 */

export interface MonthToDateData {
  readonly input: MonthToDateInput;
  readonly positions: readonly PositionRow[];
  /**
   * The window's valuation rows, with the id and version an edit of one needs —
   * what Monthly's Accounts section offers to update. Already loaded; no query
   * of its own.
   */
  readonly valuations: readonly ValuationRow[];
  /**
   * The month's income entries so far as the rows they are, keyed on their
   * **financial** date — what Monthly's Income section lists as received, with
   * the occurrence link, gross, description and version the engine input drops.
   * Already read to build that input; no query of its own.
   */
  readonly income: readonly IncomeEntryRow[];
}

export async function loadMonthToDate(
  deps: MonthDataDependencies,
  userId: string,
  today: PlainDate,
): Promise<MonthToDateData> {
  const from = startOfMonthKey(monthKey(today));

  const [window, income, expenses, transfers, categories] = await Promise.all([
    loadFinancialWindow(deps.db, userId, today),
    listIncomeEntries(deps.db, userId, from, today),
    listExpenseEntries(deps.db, userId, from, today),
    listTransfers(deps.db, userId, from, today),
    // Archived categories included: an expense keeps its category, and the kind
    // of an archived one still decides how that expense is classified (R12).
    listCategoryRecords(deps.db, userId, { includeArchived: true }),
  ]);

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

  return {
    input: {
      today: plainDate(today),
      cashAccounts,
      income: income.map(toIncomeFlow),
      expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
      transfers: transfers.map(toTransferFlow),
    },
    positions: window.positions,
    valuations: window.valuations,
    income,
  };
}
