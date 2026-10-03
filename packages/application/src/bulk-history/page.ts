import {
  listIncomeEntriesByOccurrenceIn,
  listSkipsInRangeIn,
  listTemplatesForRangeIn,
  loadFinancialWindowIn,
  type Database,
  type IncomeEntryRow,
  type PositionRecord as PositionRow,
  type RecurringTemplateRow,
  type RecurringTemplateSkipRow,
  type ValuationRow,
} from '@vaultide/db';
import {
  addMonths,
  cashCloseState,
  endOfMonthKey,
  lastDaySnapshot,
  latestOnOrBefore,
  monthEndBalance,
  monthKey,
  monthLabel,
  occurrencesInRange,
  plainDate,
  startOfMonthKey,
  type MonthKey,
  type PositionRecord,
  type ValuationRecord,
} from '@vaultide/finance';
import { bulkHistoryInput } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserRead } from '../coordination';
import { currencyCatalogue } from '../currencies/service';
import { ValidationError } from '../errors';
import { toPositionRecord, toValuationRecord } from '../positions/mapping';
import { scheduleOf } from '../recurring/suggestions';
import { canonicalAmount } from '../write-plan';
import type {
  BulkColumnDto,
  BulkHistoryPageDto,
  BulkIncomeCell,
  BulkIncomeColumnDto,
  BulkPositionCell,
  BulkPositionColumnDto,
  BulkSegment,
} from './types';

/**
 * The Bulk History grid, read in one coherent snapshot (blueprint 15.3, 23.1,
 * 23.2; ADR 0011).
 *
 * One read for the whole grid — never Monthly's page per row. It is one
 * `REPEATABLE READ READ ONLY` transaction, because the cells it states are the
 * bases the grid's unsaved edits are later checked against (ADR 0011 D9), and
 * bases composed from two worlds could disagree with each other. Inside it, a
 * fixed number of set-wise statements whatever the range:
 *
 * ```text
 * positions + every balance on or before the last completed month end   (3)
 * the templates whose schedule overlaps the range                       (1)
 * the skips whose occurrence falls in the range                         (1)
 * the income entries whose occurrence falls in the range                (1)
 * ```
 *
 * Balances are read with no lower bound (ADR 0004 §3): the first row's value
 * may be a balance carried from years before it, and a window would turn it
 * into "missing". Income is read by **occurrence date**, not by the date the
 * money arrived, because a cell is an occurrence (§30.9 item 2).
 *
 * Every cell is derived by the finance functions the reconciliation uses —
 * `monthEndBalance`, `lastDaySnapshot`, `cashCloseState` (and through it
 * `isDormantZeroAt`), `latestOnOrBefore`, `occurrencesInRange` — so the grid
 * cannot call a month carried that Monthly calls closed.
 */

export interface BulkHistoryDependencies {
  readonly db: Database;
}

const label = (month: MonthKey): string => monthLabel(month);
const nextMonth = (month: MonthKey): MonthKey => monthKey(addMonths(startOfMonthKey(month), 1));

/** Every month from `from` through `through`, inclusive, as month keys. */
function monthsBetween(from: MonthKey, through: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let month = from; month <= through; month = nextMonth(month)) months.push(month);
  return months;
}

/** Consecutive equal cells as one segment. */
function segmentsOf<Cell>(months: readonly MonthKey[], cellOf: (month: MonthKey) => Cell): BulkSegment<Cell>[] {
  const segments: BulkSegment<Cell>[] = [];
  let open: { from: string; through: string; cell: Cell; key: string } | null = null;
  for (const month of months) {
    const cell = cellOf(month);
    const key = JSON.stringify(cell);
    if (open !== null && open.key === key) {
      open.through = label(month);
      continue;
    }
    if (open !== null) segments.push({ from: open.from, through: open.through, cell: open.cell });
    open = { from: label(month), through: label(month), cell, key };
  }
  if (open !== null) segments.push({ from: open.from, through: open.through, cell: open.cell });
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Balance columns                                                             */
/* -------------------------------------------------------------------------- */

export interface BulkPositionHistory {
  readonly row: PositionRow;
  readonly record: PositionRecord;
  readonly valuations: readonly ValuationRecord[];
  /** The stored rows by id, for what a record does not carry: the version. */
  readonly rows: ReadonlyMap<string, ValuationRow>;
}

/** One account's cell for one completed month, in the order 8.1 reads it. */
export function bulkPositionCellOf(history: BulkPositionHistory, month: MonthKey): BulkPositionCell {
  const { record, valuations } = history;
  const start = startOfMonthKey(month);
  const end = endOfMonthKey(month);

  if (record.openedOn !== null && record.openedOn > end) {
    return { kind: 'unavailable', reason: 'not_open' };
  }
  if (record.closedOn !== null && record.closedOn < start) {
    return { kind: 'unavailable', reason: 'closed' };
  }

  const statement = monthEndBalance(valuations, month);
  if (statement !== undefined) {
    const row = history.rows.get(statement.id);
    /* v8 ignore next -- every record was mapped from one of these rows. */
    if (row === undefined) throw new Error('a statement balance has no stored row');
    return {
      kind: 'stored',
      valuationId: row.id,
      version: row.version,
      amount: canonicalAmount(row.amount),
      source: row.source,
      clearable: !(history.row.status === 'closed' && row.valuedOn === history.row.closedOn),
    };
  }

  const snapshot = lastDaySnapshot(valuations, month);
  if (snapshot !== undefined) {
    return { kind: 'snapshot', valuationId: snapshot.id, amount: snapshot.amount.toString() };
  }

  switch (cashCloseState(record, valuations, month)) {
    case 'closed_zero':
      return { kind: 'derived_zero', reason: 'closed' };
    case 'dormant_zero':
      return { kind: 'derived_zero', reason: 'dormant' };
    case 'carried': {
      const latest = latestOnOrBefore(valuations, end);
      /* v8 ignore next -- `carried` means a balance on or before the month end exists. */
      if (latest === undefined) return { kind: 'empty' };
      return { kind: 'carried', amount: latest.amount.toString(), since: latest.valuedOn };
    }
    case 'missing':
      return { kind: 'empty' };
    /* v8 ignore next 2 -- a statement balance was answered above. */
    case 'month_end':
      return { kind: 'empty' };
  }
}

const KIND_RANK: Readonly<Record<string, number>> = { cash: 0, other_asset: 1 };

/**
 * The balance columns, in a fixed order (ADR 0011 D3): cash accounts, then
 * other assets; within each, the user's own order, then name, then id — the
 * last two only break ties, so the order never changes between a render, the
 * review and a refresh.
 *
 * Every account whose window overlaps the months the grid can edit, whatever
 * its status: a closed account keeps its column for the months it existed.
 */
function positionColumns(
  rows: readonly PositionRow[],
  valuations: readonly ValuationRow[],
  months: readonly MonthKey[],
  first: MonthKey,
  last: MonthKey,
): BulkPositionColumnDto[] {
  const byPosition = new Map<string, ValuationRow[]>();
  for (const row of valuations) {
    const list = byPosition.get(row.positionId);
    if (list === undefined) byPosition.set(row.positionId, [row]);
    else list.push(row);
  }

  return rows
    .filter((row) => row.kind === 'cash' || row.kind === 'other_asset')
    .filter(
      (row) =>
        (row.openedOn === null || row.openedOn <= endOfMonthKey(last)) &&
        (row.closedOn === null || row.closedOn >= startOfMonthKey(first)),
    )
    .sort(
      (a, b) =>
        (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
        a.sortOrder - b.sortOrder ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((row) => {
      const stored = byPosition.get(row.id) ?? [];
      const history: BulkPositionHistory = {
        row,
        record: toPositionRecord(row),
        valuations: stored.map(toValuationRecord),
        rows: new Map(stored.map((valuation) => [valuation.id, valuation])),
      };
      return {
        kind: 'position',
        positionId: row.id,
        positionKind: row.kind as 'cash' | 'other_asset',
        name: row.name,
        currency: row.currency,
        status: row.status,
        segments: segmentsOf(months, (month) => bulkPositionCellOf(history, month)),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Income columns                                                              */
/* -------------------------------------------------------------------------- */

const occurrenceKey = (templateId: string, occurrenceDate: string): string =>
  `${templateId}#${occurrenceDate}`;

function materialized(entry: IncomeEntryRow): BulkIncomeCell {
  return {
    kind: 'materialized',
    occurrenceDate: entry.occurrenceDate as string,
    entryId: entry.id,
    version: entry.version,
    netAmount: canonicalAmount(entry.netAmount),
    receivedOn: entry.receivedOn,
  };
}

/**
 * One income source's cells, by the month each occurrence is **scheduled** in
 * (ADR 0011 D5).
 *
 * The schedule is generated by the finance recurrence functions over the
 * template's own dates; archive is not a schedule boundary (§30.10), so an
 * archived source still shows the occurrences it had — the recorded ones
 * editable, the unrecorded ones not creatable. A recorded entry stays in its
 * occurrence's row wherever the money landed.
 */
export function bulkIncomeCellsOf(
  template: RecurringTemplateRow,
  from: string,
  through: string,
  entries: ReadonlyMap<string, IncomeEntryRow>,
  skips: ReadonlyMap<string, RecurringTemplateSkipRow>,
): ReadonlyMap<string, BulkIncomeCell> {
  const cells = new Map<string, BulkIncomeCell>();
  for (const date of occurrencesInRange(scheduleOf(template), plainDate(from), plainDate(through))) {
    const key = occurrenceKey(template.id, date);
    const entry = entries.get(key);
    cells.set(
      date.slice(0, 7),
      entry !== undefined
        ? materialized(entry)
        : skips.has(key)
          ? { kind: 'skipped', occurrenceDate: date }
          : template.archivedAt !== null
            ? { kind: 'archived', occurrenceDate: date }
            : { kind: 'open', occurrenceDate: date },
    );
  }
  return cells;
}

/**
 * The income columns (ADR 0011 D3, D5): every income source whose schedule
 * overlaps the months the grid can edit, archived ones included, by name and
 * then id. No expense or contribution source has a column.
 */
function incomeColumns(
  templates: readonly RecurringTemplateRow[],
  entryRows: readonly IncomeEntryRow[],
  skipRows: readonly RecurringTemplateSkipRow[],
  months: readonly MonthKey[],
  from: string,
  through: string,
): BulkIncomeColumnDto[] {
  const entries = new Map<string, IncomeEntryRow>();
  for (const entry of entryRows) {
    if (entry.templateId !== null && entry.occurrenceDate !== null) {
      entries.set(occurrenceKey(entry.templateId, entry.occurrenceDate), entry);
    }
  }
  const skips = new Map(skipRows.map((row) => [occurrenceKey(row.templateId, row.occurrenceDate), row]));

  return templates
    .filter((template) => template.kind === 'income')
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    .map((template) => {
      const cells = bulkIncomeCellsOf(template, from, through, entries, skips);
      return {
        kind: 'income',
        templateId: template.id,
        name: template.name,
        currency: template.currency,
        archived: template.archivedAt !== null,
        segments: segmentsOf(months, (month) => cells.get(label(month)) ?? { kind: 'none' }),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The grid from `startMonth` through the current month (ADR 0011 D1).
 *
 * The first row must be a completed month: a malformed, current or future one
 * is refused, and the page answers that with "not found" exactly as Monthly
 * does for a month that has not begun. There is no cap on how far back it
 * starts.
 */
export async function getBulkHistoryPage(
  deps: BulkHistoryDependencies,
  ctx: RequestContext,
  startMonth: MonthKey,
): Promise<BulkHistoryPageDto> {
  const current = monthKey(ctx.today);
  if (startMonth >= current) {
    throw new ValidationError('Bulk history starts from a month that has ended.', {
      month: ['Choose a month before the current one.'],
    });
  }

  const last = monthKey(addMonths(startOfMonthKey(current), -1));
  const from = startOfMonthKey(startMonth) as string;
  const through = endOfMonthKey(last) as string;
  const months = monthsBetween(startMonth, last);

  const [rows, catalogue] = await Promise.all([
    withUserRead(deps.db, { userId: ctx.userId }, async (tx) => {
      const financial = await loadFinancialWindowIn(tx, through);
      const templates = await listTemplatesForRangeIn(tx, from, through);
      const skips = await listSkipsInRangeIn(tx, from, through);
      const entries = await listIncomeEntriesByOccurrenceIn(tx, from, through);
      return { financial, templates, skips, entries };
    }),
    currencyCatalogue(deps.db),
  ]);

  const columns: BulkColumnDto[] = [
    ...positionColumns(rows.financial.positions, rows.financial.valuations, months, startMonth, last),
    ...incomeColumns(rows.templates, rows.entries, rows.skips, months, from, through),
  ];

  return {
    startMonth: label(startMonth),
    lastCompletedMonth: label(last),
    currentMonth: label(current),
    today: ctx.today,
    columns,
    minorUnitsByCurrency: catalogue.minorUnitsByCurrency,
    maxOperations: bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS,
  };
}
