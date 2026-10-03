import type {
  BulkHistoryPageDto,
  BulkIncomeCell,
  BulkPositionCell,
  BulkSegment,
} from '@vaultide/application';
import { editableText } from './numbers';

/**
 * The grid's one column model (ADR 0011 D3).
 *
 * Rendering, keyboard movement, paste mapping and the draft all read this one
 * model, built once from the server's DTO. None of them computes the columns or
 * their order for itself, so a pasted rectangle lands in exactly the cells the
 * user sees, and the draft names exactly the cells that were edited.
 *
 * Every cell here is the server's statement of what the cell is. Nothing is
 * inferred from a number: whether a figure is a stored statement, a carried
 * balance or a derived zero is the cell's `kind`.
 */

interface ColumnBase {
  /** Stable across refreshes: the kind and the id, never a name or a position on screen. */
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly minorUnits: number;
}

export interface PositionColumn extends ColumnBase {
  readonly kind: 'position';
  readonly positionKind: 'cash' | 'other_asset';
  readonly cells: ReadonlyMap<string, BulkPositionCell>;
}

export interface IncomeColumn extends ColumnBase {
  readonly kind: 'income';
  readonly archived: boolean;
  readonly cells: ReadonlyMap<string, BulkIncomeCell>;
}

export type GridColumn = PositionColumn | IncomeColumn;
export type GridCell = BulkPositionCell | BulkIncomeCell;

export interface GridModel {
  /** The completed months, ascending: the editable rows. */
  readonly months: readonly string[];
  /** The current month: the last row, always disabled. */
  readonly currentMonth: string;
  /** Every row the grid shows, in order: `months` and then the current month. */
  readonly rows: readonly string[];
  readonly columns: readonly GridColumn[];
  readonly maxOperations: number;
  readonly locale: string;
}

/** Every month a segment covers, inclusive. */
function monthsOf(from: string, through: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split('-').map(Number) as [number, number];
  for (;;) {
    const label = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    if (label > through) break;
    months.push(label);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function expand<Cell>(segments: readonly BulkSegment<Cell>[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const segment of segments) {
    for (const month of monthsOf(segment.from, segment.through)) cells.set(month, segment.cell);
  }
  return cells;
}

export function gridModelOf(page: BulkHistoryPageDto, locale: string): GridModel {
  const minorUnits = (currency: string): number => page.minorUnitsByCurrency[currency] ?? 2;
  const months = monthsOf(page.startMonth, page.lastCompletedMonth);
  return {
    months,
    currentMonth: page.currentMonth,
    rows: [...months, page.currentMonth],
    maxOperations: page.maxOperations,
    locale,
    columns: page.columns.map((column): GridColumn =>
      column.kind === 'position'
        ? {
            kind: 'position',
            key: `position:${column.positionId}`,
            id: column.positionId,
            name: column.name,
            currency: column.currency,
            minorUnits: minorUnits(column.currency),
            positionKind: column.positionKind,
            cells: expand(column.segments),
          }
        : {
            kind: 'income',
            key: `income:${column.templateId}`,
            id: column.templateId,
            name: column.name,
            currency: column.currency,
            minorUnits: minorUnits(column.currency),
            archived: column.archived,
            cells: expand(column.segments),
          },
    ),
  };
}

/** One cell's identity in the grid: its column's key and its row. */
export const cellKey = (columnKey: string, month: string): string => `${columnKey}|${month}`;

/** The cell a column states for a row, or `null` for the disabled current-month row. */
export function cellAt(model: GridModel, column: GridColumn, month: string): GridCell | null {
  if (month === model.currentMonth) return null;
  return column.cells.get(month) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Bases                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What an edit was made against (ADR 0011 D9).
 *
 * A stored row is named by its id, version and amount: if any of them moves,
 * the edit was made against a row that no longer exists in that form. An
 * unoccupied cell is named by what it was — carried, empty, a derived zero, an
 * unrecorded occurrence — because that is all the edit assumed about it.
 */
export type CellBase =
  | { readonly kind: 'stored'; readonly id: string; readonly version: number; readonly amount: string }
  | { readonly kind: 'carried' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'derived' }
  | { readonly kind: 'materialized'; readonly id: string; readonly version: number; readonly amount: string }
  | { readonly kind: 'open' };

/** The base of an editable cell, or `null` for one nobody may type into. */
export function baseOf(cell: GridCell | null): CellBase | null {
  if (cell === null) return null;
  switch (cell.kind) {
    case 'stored':
      return { kind: 'stored', id: cell.valuationId, version: cell.version, amount: cell.amount };
    case 'carried':
      return { kind: 'carried' };
    case 'empty':
      return { kind: 'empty' };
    case 'derived_zero':
      // A dormant zero is a carry and takes a figure; a closed one is zero by
      // definition and takes none.
      return cell.reason === 'dormant' ? { kind: 'derived' } : null;
    case 'materialized':
      return { kind: 'materialized', id: cell.entryId, version: cell.version, amount: cell.netAmount };
    case 'open':
      return { kind: 'open' };
    case 'snapshot':
    case 'unavailable':
    case 'skipped':
    case 'archived':
    case 'none':
      return null;
  }
}

export const sameBase = (a: CellBase, b: CellBase | null): boolean =>
  b !== null && JSON.stringify(a) === JSON.stringify(b);

/** The text an editable cell starts with: its stored figure, or nothing. */
export function initialText(cell: GridCell | null, column: GridColumn, locale: string): string {
  if (cell?.kind === 'stored') return editableText(cell.amount, locale, column.minorUnits);
  if (cell?.kind === 'materialized') return editableText(cell.netAmount, locale, column.minorUnits);
  return '';
}

/**
 * What the server holds in a cell, in words — for the list of edits a refresh
 * could not keep, which shows the user what is there now instead.
 */
export function serverValueOf(cell: GridCell | null, column: GridColumn, locale: string): string {
  if (cell === null) return 'not editable';
  const amount = (value: string) => `${editableText(value, locale, column.minorUnits)} ${column.currency}`;
  switch (cell.kind) {
    case 'stored':
      return amount(cell.amount);
    case 'materialized':
      return amount(cell.netAmount);
    case 'carried':
      return `no statement (carries ${amount(cell.amount)})`;
    case 'snapshot':
      return `a snapshot of ${amount(cell.amount)}`;
    case 'derived_zero':
      return cell.reason === 'dormant' ? 'dormant, carried at 0' : 'closed, 0';
    case 'empty':
    case 'open':
      return 'empty';
    case 'skipped':
      return 'skipped';
    case 'archived':
      return 'archived source';
    case 'unavailable':
    case 'none':
      return 'not editable';
  }
}

/* -------------------------------------------------------------------------- */
/* Moving between cells                                                        */
/* -------------------------------------------------------------------------- */

/** A cell's place in the grid: its row in `rows` and its column in `columns`. */
export interface GridPosition {
  readonly row: number;
  readonly column: number;
}

export type GridDirection = 'up' | 'down' | 'left' | 'right' | 'next' | 'previous';

/** Whether a position holds a cell somebody may type into. */
export function isEditableAt(model: GridModel, position: GridPosition): boolean {
  const column = model.columns[position.column];
  const month = model.rows[position.row];
  if (column === undefined || month === undefined) return false;
  return baseOf(cellAt(model, column, month)) !== null;
}

/**
 * The next editable cell from `from` in a direction, skipping every cell
 * nobody may type into, or `null` at the grid's edge. Computed on the model,
 * never on what is mounted, so it reaches rows the window has not rendered.
 */
export function nextEditable(
  model: GridModel,
  from: GridPosition,
  direction: GridDirection,
): GridPosition | null {
  const width = model.columns.length;
  const height = model.rows.length;
  const step = (position: GridPosition): GridPosition | null => {
    switch (direction) {
      case 'up':
        return position.row > 0 ? { ...position, row: position.row - 1 } : null;
      case 'down':
        return position.row < height - 1 ? { ...position, row: position.row + 1 } : null;
      case 'left':
        return position.column > 0 ? { ...position, column: position.column - 1 } : null;
      case 'right':
        return position.column < width - 1 ? { ...position, column: position.column + 1 } : null;
      case 'next':
        return position.column < width - 1
          ? { ...position, column: position.column + 1 }
          : position.row < height - 1
            ? { row: position.row + 1, column: 0 }
            : null;
      case 'previous':
        return position.column > 0
          ? { ...position, column: position.column - 1 }
          : position.row > 0
            ? { row: position.row - 1, column: width - 1 }
            : null;
    }
  };
  for (let position = step(from); position !== null; position = step(position)) {
    if (isEditableAt(model, position)) return position;
  }
  return null;
}
