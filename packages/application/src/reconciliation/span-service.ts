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
  findSpanIntervals,
  findSpans,
  monthKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type Decimal,
  type MonthKey,
  type PlainDate,
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
 * months or flows. They go in two stages, because how far back the flows must
 * be read is not knowable until the intervals are:
 *
 *  1. Positions with their valuations, and the categories that give an expense
 *     its accounting kind. **No lower bound on valuations** (ADR 0004 §3): an
 *     anchor is a property of the whole history, and a loader that refused to
 *     look before the caller's window would report a gap that is not there.
 *  2. The income, expenses and transfers of the intervals stage one found —
 *     from the earliest discovered `from`, which may be years before the month
 *     the caller asked about and is exactly as far back as it needs to be.
 *
 * The alternative, one stage with a fixed lookback, has no safe constant: a
 * depth long enough for one history silently truncates the next, and the symptom
 * is not an error but a span that quietly does not exist.
 *
 * No recurring data is loaded: a span has no completeness report (30.14 item 8).
 * Nothing is stored — 8.7 says spans are recomputed on read.
 */

export type SpanDependencies = MonthDataDependencies;

/**
 * How much history a request reports on when the caller names no bound.
 *
 * A presentation default and nothing more. It does not bound discovery — a
 * returned span may open long before it, and is reported whole when it does —
 * and it is not a cap on a span's length. It decides only which spans are old
 * enough to leave out.
 */
const DEFAULT_HISTORY_MONTHS = 24;

export interface SpanQuery {
  /**
   * Earliest month to report on. Defaults to two years back.
   *
   * The engine's rule applies unchanged: this selects among the spans the
   * evidence supports and never changes what they are. A span overlapping this
   * month comes back in full, opening anchor included, however far back that
   * anchor lies.
   */
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
    totals: {
      externalInflows: amount(span.totals.externalInflows),
      nonIncomeInflows: amount(span.totals.nonIncomeInflows),
      nonExpenseOutflows: amount(span.totals.nonExpenseOutflows),
      knownTrackedExpenses: amount(span.totals.knownTrackedExpenses),
      cashDelta: amount(span.totals.cashDelta),
    },
    trackedTotalSpending: amount(span.trackedTotalSpending),
    unclassified: amount(span.unclassified),
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

  const [window, categories] = await Promise.all([
    loadFinancialWindow(deps.db, ctx.userId, to),
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

  const today = plainDate(ctx.today);
  const intervals = findSpanIntervals({ today, cashAccounts, from });

  // Exactly as far back as the answer needs, and no guess involved. With no
  // interval there is nothing to read flows for, so the bound collapses to the
  // last completed month: still three reads, over one month of rows.
  const flowsFrom = intervals.reduce<PlainDate>(
    (earliest, interval) => (interval.from < earliest ? interval.from : earliest),
    startOfMonthKey(lastCompleted),
  );

  const [income, expenses, transfers] = await Promise.all([
    listIncomeEntries(deps.db, ctx.userId, flowsFrom, to),
    listExpenseEntries(deps.db, ctx.userId, flowsFrom, to),
    listTransfers(deps.db, ctx.userId, flowsFrom, to),
  ]);

  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));

  const input: SpanInput = {
    today,
    cashAccounts,
    income: income.map(toIncomeFlow),
    expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
    transfers: transfers.map(toTransferFlow),
    from,
  };

  return findSpans(input).map(spanDto);
}
