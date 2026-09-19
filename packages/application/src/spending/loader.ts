import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listTransfers,
  loadFinancialWindow,
  type CategoryRecord,
  type ExpenseEntryRow,
  type PositionRecord as PositionRow,
} from '@vaultide/db';
import {
  findSpanIntervals,
  type CashAccountInput,
  type ExpenseFlow,
  type IncomeFlow,
  type MonthKey,
  type PlainDate,
  type SpanInterval,
  type TransferFlow,
} from '@vaultide/finance';
import { currencyCatalogue, type CurrencyCatalogue } from '../currencies/service';
import { readSettings } from '../settings/service';
import type { UserSettings } from '../settings/types';
import { toExpenseFlow, toIncomeFlow, toTransferFlow, type MonthDataDependencies } from '../reconciliation/loader';
import { cashAccountInputsOf } from '../reconciliation/range-loader';
import { spanFlowRange } from '../reconciliation/span-service';

/**
 * Everything the Spending page reads, in a bounded number of queries (blueprint
 * 23.2; ADR 0008 §3, §8).
 *
 * **Stage one, seven reads side by side**, none of them per month, account,
 * expense, category or template:
 *
 *  - the valuation window up to **today**, with no lower bound (ADR 0004 §3).
 *    One window serves every part of the page: each completed month reads the
 *    evidence on or before its own end and ignores what came later, which is
 *    already how the range loader hands one window to twelve months; the
 *    month-to-date engine needs everything through today; and span discovery
 *    needs every complete month end up to the last completed month;
 *  - the income, expenses and transfers of the history window — its first month
 *    through its last, or through today when the current month is on the page;
 *  - the categories (archived included, since an expense keeps its kind);
 *  - the user's settings and the currency catalogue.
 *
 * No recurring template, term or resolved occurrence is read. Those feed only
 * `suggested_income_missing`, an advisory that moves no status and no figure
 * (8.4, 8.5), and completeness, which Spending does not show.
 *
 * **Stage two, three reads, only when a span needs them.** Span intervals are
 * discovered from the window alone (8.7), over the whole history, and kept when
 * they overlap the history window. Their flows are the ones already read when
 * those cover every kept span from its own start; when a span opens before the
 * history window — its anchor may be years old — the flows of exactly the kept
 * spans' interval are read once more. A span is never reconciled over flows
 * that begin after it does.
 */

export interface SpendingLoadPlan {
  readonly userId: string;
  readonly today: PlainDate;
  /** The history window's first and last completed months. */
  readonly historyFrom: MonthKey;
  readonly historyTo: MonthKey;
  /** The last day whose flows the page needs: today with the current month on the page, else `end(historyTo)`. */
  readonly flowsTo: PlainDate;
  readonly flowsFrom: PlainDate;
}

export interface SpendingFlows {
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  readonly transfers: readonly TransferFlow[];
}

export interface SpendingData {
  readonly positions: readonly PositionRow[];
  readonly cashAccounts: readonly CashAccountInput[];
  readonly categories: readonly CategoryRecord[];
  readonly settings: UserSettings;
  readonly catalogue: CurrencyCatalogue;
  /** The history window's flows, mapped for the engines. */
  readonly flows: SpendingFlows;
  /** The same expenses as rows, for the description, category and account the engine input drops. */
  readonly expenseRows: readonly ExpenseEntryRow[];
  /** The span intervals overlapping the history window, whole. */
  readonly spanIntervals: readonly SpanInterval[];
  /** The flows those spans are reconciled over: `flows` itself, or a second read reaching back further. */
  readonly spanFlows: SpendingFlows;
}

async function readFlows(
  deps: MonthDataDependencies,
  userId: string,
  from: string,
  to: string,
  kindOf: ReadonlyMap<string, string>,
): Promise<{ readonly flows: SpendingFlows; readonly expenseRows: readonly ExpenseEntryRow[] }> {
  const [income, expenses, transfers] = await Promise.all([
    listIncomeEntries(deps.db, userId, from, to),
    listExpenseEntries(deps.db, userId, from, to),
    listTransfers(deps.db, userId, from, to),
  ]);
  return {
    flows: {
      income: income.map(toIncomeFlow),
      expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
      transfers: transfers.map(toTransferFlow),
    },
    expenseRows: expenses,
  };
}

export async function loadSpendingData(
  deps: MonthDataDependencies,
  plan: SpendingLoadPlan,
): Promise<SpendingData> {
  const { userId } = plan;

  const [window, income, expenses, transfers, categories, settings, catalogue] = await Promise.all([
    loadFinancialWindow(deps.db, userId, plan.today),
    listIncomeEntries(deps.db, userId, plan.flowsFrom, plan.flowsTo),
    listExpenseEntries(deps.db, userId, plan.flowsFrom, plan.flowsTo),
    listTransfers(deps.db, userId, plan.flowsFrom, plan.flowsTo),
    // Archived included: an expense keeps its category, and the kind of an
    // archived one still decides how that expense is classified (R12).
    listCategoryRecords(deps.db, userId, { includeArchived: true }),
    readSettings(deps.db, userId),
    currencyCatalogue(deps.db),
  ]);

  const cashAccounts = cashAccountInputsOf(window.positions, window.valuations);
  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));
  const flows: SpendingFlows = {
    income: income.map(toIncomeFlow),
    expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
    transfers: transfers.map(toTransferFlow),
  };

  const spanIntervals = findSpanIntervals({
    today: plan.today,
    cashAccounts,
    from: plan.historyFrom,
    through: plan.historyTo,
  });
  const needed = spanFlowRange(spanIntervals);
  const covered =
    needed === null || (needed.from >= plan.flowsFrom && needed.to <= plan.flowsTo);
  const spanFlows = covered
    ? flows
    : (await readFlows(deps, userId, needed.from, needed.to, kindOf)).flows;

  return {
    positions: window.positions,
    cashAccounts,
    categories,
    settings,
    catalogue,
    flows,
    expenseRows: expenses,
    spanIntervals,
    spanFlows,
  };
}
