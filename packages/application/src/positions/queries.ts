import {
  countValuations,
  findPosition,
  listValuations,
  loadFinancialWindow,
  type Database,
  type PositionRecord as PositionRow,
  type ValuationRow,
} from '@vaultide/db';
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfMonthKey,
  isMonthClosable,
  monthKey,
  netWorthAt,
  netWorthChange,
  netWorthSeries,
  plainDate,
  serialize,
  startOfMonth,
  type FxTable,
  type MonthKey,
  type PlainDate,
  type PositionContribution,
  type PositionWithValuations,
} from '@vaultide/finance';
import { minorUnitsByCurrency } from '../currencies/service';
import type { FxService } from '../fx/service';
import { NotFoundError } from '../errors';
import type { RequestContext } from '../context';
import { cashMonthStateDto } from './cash-month';
import {
  aggregateDto,
  positionDto,
  toPositionRecord,
  toPositionsWithValuations,
  valuationDto,
} from './mapping';
import type {
  CashMonthStateDto,
  NetWorthDto,
  NetWorthPointDto,
  PositionDetailDto,
  PositionDto,
} from './types';

/**
 * Phase 2 read services (blueprint 4.2, 23.2).
 *
 * One request loads its whole window in a couple of bulk queries, builds the
 * pure `FxTable` once, and then runs the engines in memory. Nothing is computed
 * in SQL: net worth is not a `SUM()` scattered across repositories, it is the
 * finance engine's answer, so the interface and the tests see the same
 * arithmetic (4.1).
 */

/** How many months of history the dashboard chart shows (Phase 2: 12 + today). */
export const SERIES_MONTHS = 12;

/** Rates are read from a month before the earliest financial date (10.4). */
const FX_LEAD_DAYS = 31;

export interface QueryDependencies {
  readonly db: Database;
  readonly fx: FxService;
}

/**
 * Build the rate table this request needs — and, if a currency's history has
 * never been fetched, ask for exactly the range the data requires.
 *
 * This is the demand-driven backfill of 10.4 and ADR 0002 decision 17: the
 * earliest date passed here is the user's earliest **financial** date, so
 * `ensureHistory` fetches from a month before it rather than from 1999. Merely
 * owning a USD account does not download twenty-seven years of rates; owning
 * one with a balance dated last March fetches from last February.
 *
 * A provider failure is not the user's problem: `ensureHistory` swallows it,
 * conversions come back `Unavailable`, aggregates say `partial`, and no stored
 * balance is touched (10.5).
 */
async function loadFxTable(
  deps: QueryDependencies,
  currencies: readonly string[],
  earliestFinancialDate: string | undefined,
  today: PlainDate,
): Promise<FxTable> {
  const quotes = [...new Set(currencies.map((code) => code.trim().toUpperCase()))];
  const from =
    earliestFinancialDate === undefined
      ? addDays(today, -FX_LEAD_DAYS)
      : addDays(plainDate(earliestFinancialDate), -FX_LEAD_DAYS);

  for (const quote of quotes) {
    if (quote === 'EUR') continue;
    await deps.fx.ensureHistory(quote, earliestFinancialDate ?? today);
  }

  return deps.fx.loadTable(quotes, from, today, today);
}

interface Window {
  readonly rows: PositionRow[];
  readonly valuations: ValuationRow[];
  readonly entries: PositionWithValuations[];
  readonly fx: FxTable;
  readonly minorUnits: Record<string, number>;
}

async function loadWindow(deps: QueryDependencies, ctx: RequestContext): Promise<Window> {
  const window = await loadFinancialWindow(deps.db, ctx.userId, ctx.today);
  const minorUnits = await minorUnitsByCurrency(deps.db);

  const currencies = [
    ...window.positions.map((row) => row.currency),
    ctx.reportingCurrency,
  ];
  const fx = await loadFxTable(deps, currencies, window.earliestValuedOn, ctx.today);

  return {
    rows: window.positions,
    valuations: window.valuations,
    entries: toPositionsWithValuations(window.positions, window.valuations),
    fx,
    minorUnits,
  };
}

/** The last month that is over, which is the newest month a statement can close. */
export function lastCompletedMonth(today: PlainDate): MonthKey {
  return monthKey(addMonths(startOfMonth(today), -1));
}

function buildPositionDtos(
  window: Window,
  contributions: readonly PositionContribution[],
  today: PlainDate,
): PositionDto[] {
  const byId = new Map(contributions.map((item) => [item.value.position.id, item]));
  const counts = new Map<string, number>();
  for (const row of window.valuations) {
    counts.set(row.positionId, (counts.get(row.positionId) ?? 0) + 1);
  }
  const entriesById = new Map(window.entries.map((entry) => [entry.position.id, entry]));
  const month = lastCompletedMonth(today);

  return window.rows.map((row) => {
    const contribution = byId.get(row.id);
    /* v8 ignore next -- every row in the window produced a contribution. */
    if (contribution === undefined) throw new NotFoundError();
    const entry = entriesById.get(row.id);

    return positionDto({
      row,
      contribution,
      minorUnits: window.minorUnits[row.currency] ?? 2,
      valuationCount: counts.get(row.id) ?? 0,
      lastCompletedMonth:
        row.kind === 'cash' && entry !== undefined
          ? cashMonthStateDto(entry, month, row.currency, window.valuations)
          : null,
    });
  });
}

/**
 * The dashboard and the accounts pages read this: both net-worth metrics, their
 * components, every position with its freshness, the twelve-month series and
 * the current month's progress.
 */
export async function getNetWorth(
  deps: QueryDependencies,
  ctx: RequestContext,
): Promise<NetWorthDto> {
  const window = await loadWindow(deps, ctx);

  const result = netWorthAt({
    positions: window.entries,
    asOf: ctx.today,
    reportingCurrency: ctx.reportingCurrency,
    fx: window.fx,
  });

  const series = netWorthSeries({
    positions: window.entries,
    reportingCurrency: ctx.reportingCurrency,
    fx: window.fx,
    today: ctx.today,
    months: SERIES_MONTHS,
  });

  const previousMonthEnd = endOfMonthKey(lastCompletedMonth(ctx.today));
  const previous = netWorthAt({
    positions: window.entries,
    asOf: previousMonthEnd,
    reportingCurrency: ctx.reportingCurrency,
    fx: window.fx,
  });

  const totalChange = netWorthChange(previous.totalNetWorth, result.totalNetWorth);
  const financialChange = netWorthChange(previous.financialNetWorth, result.financialNetWorth);

  const currentMonthStart = startOfMonth(ctx.today);
  const cashRows = window.rows.filter((row) => row.kind === 'cash' && row.status === 'active');
  const updatedAccounts = cashRows.filter((row) =>
    window.valuations.some(
      (valuation) =>
        valuation.positionId === row.id && valuation.valuedOn >= (currentMonthStart as string),
    ),
  ).length;

  const points: NetWorthPointDto[] = series.map((point) => ({
    asOf: point.asOf,
    provisional: point.provisional,
    totalNetWorth: aggregateDto(point.totalNetWorth),
    financialNetWorth: aggregateDto(point.financialNetWorth),
  }));

  return {
    asOf: ctx.today,
    reportingCurrency: ctx.reportingCurrency,
    minorUnits: window.minorUnits[ctx.reportingCurrency] ?? 2,
    minorUnitsByCurrency: window.minorUnits,
    totalNetWorth: aggregateDto(result.totalNetWorth),
    financialNetWorth: aggregateDto(result.financialNetWorth),
    metricsDiffer: result.metricsDiffer,
    components: {
      cash: aggregateDto(result.components.cash),
      otherAssetsIncluded: aggregateDto(result.components.otherAssetsIncluded),
      otherAssetsExcluded: aggregateDto(result.components.otherAssetsExcluded),
    },
    positions: buildPositionDtos(window, result.positions, ctx.today),
    series: points,
    changeSinceLastMonthEnd: {
      from: previousMonthEnd,
      total: totalChange === undefined ? null : serialize(totalChange),
      financial: financialChange === undefined ? null : serialize(financialChange),
    },
    currentMonth: {
      month: (monthKey(ctx.today) as string).slice(0, 7),
      updatedAccounts,
      totalAccounts: cashRows.length,
      endsOn: endOfMonth(ctx.today),
    },
  };
}

/** One position with its full valuation history (15.2 "Account detail"). */
export async function getPositionDetail(
  deps: QueryDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<PositionDetailDto> {
  const row = await findPosition(deps.db, ctx.userId, positionId);
  // A position belonging to somebody else is simply not found: existence is
  // never leaked (17.2, 20.2).
  if (row === undefined) throw new NotFoundError('That account no longer exists.');

  const valuationRows = await listValuations(deps.db, ctx.userId, positionId);
  const valuationCount = valuationRows.length;
  const minorUnits = await minorUnitsByCurrency(deps.db);

  const earliest = valuationRows.at(-1)?.valuedOn;
  const fx = await loadFxTable(
    deps,
    [row.currency, ctx.reportingCurrency],
    earliest,
    ctx.today,
  );

  const entry: PositionWithValuations = {
    position: toPositionRecord(row),
    valuations: toPositionsWithValuations([row], valuationRows)[0]?.valuations ?? [],
  };

  const result = netWorthAt({
    positions: [entry],
    asOf: ctx.today,
    reportingCurrency: ctx.reportingCurrency,
    fx,
  });
  const contribution = result.positions[0];
  /* v8 ignore next -- one position in, one contribution out. */
  if (contribution === undefined) throw new NotFoundError();

  const month = lastCompletedMonth(ctx.today);

  // Which recent completed months are still without a statement balance. Only
  // months that have actually ended appear: September cannot be closed on
  // 30 September (R15, M5).
  const monthsAwaitingStatement: CashMonthStateDto[] =
    row.kind === 'cash'
      ? Array.from({ length: 6 }, (_unused, index) =>
          monthKey(addMonths(startOfMonth(ctx.today), -(index + 1))),
        )
          .filter((candidate) => isMonthClosable(candidate, ctx.today))
          .map((candidate) => cashMonthStateDto(entry, candidate, row.currency, valuationRows))
          .filter((state) => state.monthEnd === null)
      : [];

  return {
    position: positionDto({
      row,
      contribution,
      minorUnits: minorUnits[row.currency] ?? 2,
      valuationCount,
      lastCompletedMonth:
        row.kind === 'cash'
          ? cashMonthStateDto(entry, month, row.currency, valuationRows)
          : null,
    }),
    valuations: valuationRows.map((valuation) =>
      valuationDto(valuation, row.currency, ctx.reportingCurrency, fx),
    ),
    reportingCurrency: ctx.reportingCurrency,
    reportingMinorUnits: minorUnits[ctx.reportingCurrency] ?? 2,
    minorUnitsByCurrency: minorUnits,
    monthsAwaitingStatement,
  };
}

/** Whether a position may still be deleted outright (6.3). */
export async function positionValuationCount(
  deps: QueryDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<number> {
  return countValuations(deps.db, ctx.userId, positionId);
}
