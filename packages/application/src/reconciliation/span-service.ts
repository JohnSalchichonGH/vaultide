import {
  listCategoryRecords,
  listExpenseEntries,
  listIncomeEntries,
  listTransfers,
  loadFinancialWindow,
} from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  findSpans,
  monthKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type Decimal,
  type MonthKey,
  type SpanInput,
  type SpanResult,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { moneyDto, toPositionRecord, toValuationRecord } from '../positions/mapping';
import {
  toExpenseFlow,
  toIncomeFlow,
  toTransferFlow,
  type MonthDataDependencies,
} from './loader';
import type { SpanDto } from './types';

/**
 * Multi-month reconciliation spans, read from the database (blueprint 8.7, 23.2).
 *
 * Five bulk reads, and the count does not grow with the number of accounts,
 * months or flows: positions with their valuations, the income, expenses and
 * transfers of the history being examined, and the categories that give an
 * expense its accounting kind.
 *
 * Two loading rules matter here more than anywhere else:
 *
 *  - **No lower bound on valuations** (ADR 0004 §3). A span's opening anchor can
 *    lie before the window a caller asked about, and a loader that refused to
 *    look earlier would report a gap that is not there. `loadFinancialWindow`
 *    already reads every valuation up to its upper bound.
 *  - **Flows are read from the anchor search's own start**, not from the
 *    caller's window, for the same reason: a span discovered earlier than the
 *    requested first month still needs its own flows.
 *
 * No recurring data is loaded: a span has no completeness report (30.14 item 8).
 * Nothing is stored — 8.7 says spans are recomputed on read.
 */

export type SpanDependencies = MonthDataDependencies;

/**
 * How far back discovery looks when the caller names no earlier bound.
 *
 * Not a cap on a span's length: a span found inside this history may cover any
 * number of months. It bounds only how much history one request reads, and a
 * caller that wants everything passes `from`.
 */
const DEFAULT_HISTORY_MONTHS = 24;

export interface SpanQuery {
  /** Earliest month to look at. Defaults to two years back. */
  readonly from?: MonthKey | undefined;
}

function spanDto(span: SpanResult): SpanDto {
  const amount = (value: Decimal): ReturnType<typeof moneyDto> =>
    moneyDto(value.toString(), span.currency);

  return {
    currency: span.currency,
    from: span.from,
    to: span.to,
    months: span.months.map((month) => (month as string).slice(0, 7)),
    status: span.status,
    accounts: span.accounts.map((account) => ({
      positionId: account.positionId,
      name: account.name,
      openingState: account.openingState,
      opening: amount(account.opening),
      closingState: account.closingState,
      closing: amount(account.closing),
    })),
    totals: {
      externalInflows: amount(span.totals.externalInflows),
      nonIncomeInflows: amount(span.totals.nonIncomeInflows),
      nonExpenseOutflows: amount(span.totals.nonExpenseOutflows),
      knownTrackedExpenses: amount(span.totals.knownTrackedExpenses),
      cashDelta: amount(span.totals.cashDelta),
    },
    trackedTotalSpending: amount(span.trackedTotalSpending),
    unclassified: amount(span.unclassified),
    additionalSpending: amount(span.additionalSpending),
    thirdPartyPaid: amount(span.thirdPartyPaid),
    explanation: span.explanation,
  };
}

/**
 * Every span the user's history supports, per native currency.
 *
 * Absence is absence: a history with no gap returns an empty list, and there is
 * no result object explaining why a span does not exist (30.14).
 */
export async function getSpans(
  deps: SpanDependencies,
  ctx: RequestContext,
  query: SpanQuery = {},
): Promise<readonly SpanDto[]> {
  const currentMonth = monthKey(ctx.today);
  const from =
    query.from ?? monthKey(addMonths(startOfMonthKey(currentMonth), -DEFAULT_HISTORY_MONTHS));
  // 30.14 item 4: a span never reaches into the current month, so nothing after
  // the last completed month end is worth reading for it.
  const lastCompleted = monthKey(addMonths(startOfMonthKey(currentMonth), -1));
  const to = endOfMonthKey(lastCompleted);

  if (to < startOfMonthKey(from)) return [];

  const [window, income, expenses, transfers, categories] = await Promise.all([
    loadFinancialWindow(deps.db, ctx.userId, to),
    listIncomeEntries(deps.db, ctx.userId, startOfMonthKey(from), to),
    listExpenseEntries(deps.db, ctx.userId, startOfMonthKey(from), to),
    listTransfers(deps.db, ctx.userId, startOfMonthKey(from), to),
    listCategoryRecords(deps.db, ctx.userId, { includeArchived: true }),
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

  const input: SpanInput = {
    today: plainDate(ctx.today),
    cashAccounts,
    income: income.map(toIncomeFlow),
    expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
    transfers: transfers.map(toTransferFlow),
    from,
  };

  return findSpans(input).map(spanDto);
}
