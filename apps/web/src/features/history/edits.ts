import type { BulkHistoryDraft, BulkHistoryOperation } from '@vaultide/application';
import { sameDecimal } from '@/features/monthly/autosave';
import {
  baseOf,
  cellAt,
  cellKey,
  initialText,
  sameBase,
  serverValueOf,
  type CellBase,
  type GridColumn,
  type GridModel,
} from './model';
import { editableText, parseLocaleNumber, scaleOf } from './numbers';
import { parseTsv } from './tsv';

/**
 * The grid's unsaved edits, and what they ask the server to do (ADR 0011 D2,
 * D4, D9).
 *
 * An edit is what the user typed into one cell and the base it was typed
 * against. Nothing more: the operation it stands for is derived from the two,
 * every time, by one function — so the count the grid holds to the per-save
 * limit, the draft Review is asked about and the cells marked invalid can never
 * disagree.
 *
 * ## What a cell's text means (D4)
 *
 * | the cell was | the text is | the operation |
 * |---|---|---|
 * | a stored statement or entry | the same amount, compared exactly | none |
 * | a stored statement or entry | another amount | update |
 * | a stored statement or entry | cleared by hand | clear |
 * | carried, empty, a derived zero, an open occurrence | an amount — even the carried one | create |
 * | carried, empty, a derived zero, an open occurrence | blank | none |
 *
 * A blank **pasted** field never clears anything: it leaves its cell exactly as
 * it was. Only clearing a cell by hand clears it.
 */

export interface CellEdit {
  readonly columnKey: string;
  readonly month: string;
  readonly text: string;
  readonly base: CellBase;
}

export type Edits = ReadonlyMap<string, CellEdit>;

export const NO_EDITS: Edits = new Map();

export type CellOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'operation'; readonly operation: BulkHistoryOperation };

const NONE: CellOutcome = { kind: 'none' };

/** An amount as this cell accepts it: the locale's form, the currency's decimals, the right sign. */
function amountFor(
  column: GridColumn,
  text: string,
  locale: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = parseLocaleNumber(text, locale);
  if (!parsed.ok) return parsed;
  if (scaleOf(parsed.value) > column.minorUnits) {
    return {
      ok: false,
      message:
        column.minorUnits === 0
          ? `${column.currency} has no decimals.`
          : `${column.currency} has at most ${String(column.minorUnits)} decimals.`,
    };
  }
  const negativeAllowed = column.kind === 'position' && column.positionKind === 'cash';
  if (!negativeAllowed && parsed.value.startsWith('-')) {
    return {
      ok: false,
      message: column.kind === 'income' ? 'Income cannot be negative.' : 'This value cannot be negative.',
    };
  }
  return parsed;
}

/** The one place a cell's edit becomes an operation, a refusal, or nothing. */
export function outcomeOf(model: GridModel, column: GridColumn, edit: CellEdit): CellOutcome {
  const cell = cellAt(model, column, edit.month);
  const blank = edit.text.trim() === '';

  if (column.kind === 'position') {
    if (cell?.kind === 'stored') {
      if (blank) {
        if (!cell.clearable) {
          return {
            kind: 'invalid',
            message: 'This is the closing balance of a closed account. It can be corrected, not removed.',
          };
        }
        return {
          kind: 'operation',
          operation: {
            kind: 'valuation_clear',
            positionId: column.id,
            month: edit.month,
            valuationId: cell.valuationId,
            expectedVersion: cell.version,
          },
        };
      }
      const amount = amountFor(column, edit.text, model.locale);
      if (!amount.ok) return { kind: 'invalid', message: amount.message };
      if (sameDecimal(amount.value, cell.amount)) return NONE;
      return {
        kind: 'operation',
        operation: {
          kind: 'valuation_update',
          positionId: column.id,
          month: edit.month,
          valuationId: cell.valuationId,
          expectedVersion: cell.version,
          amount: amount.value,
        },
      };
    }
    if (blank) return NONE;
    const amount = amountFor(column, edit.text, model.locale);
    if (!amount.ok) return { kind: 'invalid', message: amount.message };
    return {
      kind: 'operation',
      operation: { kind: 'valuation_create', positionId: column.id, month: edit.month, amount: amount.value },
    };
  }

  if (cell?.kind === 'materialized') {
    const named = {
      templateId: column.id,
      occurrenceDate: cell.occurrenceDate,
      entryId: cell.entryId,
      expectedVersion: cell.version,
    };
    if (blank) return { kind: 'operation', operation: { kind: 'income_clear', ...named } };
    const amount = amountFor(column, edit.text, model.locale);
    if (!amount.ok) return { kind: 'invalid', message: amount.message };
    if (sameDecimal(amount.value, cell.netAmount)) return NONE;
    return { kind: 'operation', operation: { kind: 'income_update', ...named, netAmount: amount.value } };
  }
  if (cell?.kind !== 'open' || blank) return NONE;
  const amount = amountFor(column, edit.text, model.locale);
  if (!amount.ok) return { kind: 'invalid', message: amount.message };
  return {
    kind: 'operation',
    operation: {
      kind: 'income_create',
      templateId: column.id,
      occurrenceDate: cell.occurrenceDate,
      netAmount: amount.value,
    },
  };
}

const columnOf = (model: GridModel, key: string): GridColumn | undefined =>
  model.columns.find((column) => column.key === key);

/** Every edit's outcome, in grid order: by row, then by column. */
export function outcomesOf(
  model: GridModel,
  edits: Edits,
): readonly { readonly edit: CellEdit; readonly column: GridColumn; readonly outcome: CellOutcome }[] {
  const order = new Map(model.columns.map((column, index) => [column.key, index]));
  return [...edits.values()]
    .flatMap((edit) => {
      const column = columnOf(model, edit.columnKey);
      return column === undefined ? [] : [{ edit, column, outcome: outcomeOf(model, column, edit) }];
    })
    .sort((a, b) =>
      a.edit.month === b.edit.month
        ? (order.get(a.column.key) ?? 0) - (order.get(b.column.key) ?? 0)
        : a.edit.month < b.edit.month
          ? -1
          : 1,
    );
}

export function operationCount(model: GridModel, edits: Edits): number {
  return outcomesOf(model, edits).filter((item) => item.outcome.kind === 'operation').length;
}

export const limitMessage = (limit: number): string =>
  `One save can carry at most ${String(limit)} changed cells. Review and save these, then continue.`;

/**
 * The draft one Save sends to Review: every operation, or every reason it
 * cannot be sent yet. Never split: one Save is one draft, one review, one
 * transaction (ADR 0011 D2).
 */
export function draftOf(
  model: GridModel,
  edits: Edits,
):
  | { readonly ok: true; readonly draft: BulkHistoryDraft }
  | { readonly ok: false; readonly invalid: number } {
  const outcomes = outcomesOf(model, edits);
  const invalid = outcomes.filter((item) => item.outcome.kind === 'invalid').length;
  if (invalid > 0) return { ok: false, invalid };
  const operations = outcomes.flatMap((item) =>
    item.outcome.kind === 'operation' ? [item.outcome.operation] : [],
  );
  return {
    ok: true,
    draft: { kind: 'bulk_history', startMonth: model.months[0] ?? model.currentMonth, operations },
  };
}

/* -------------------------------------------------------------------------- */
/* Typing and pasting                                                          */
/* -------------------------------------------------------------------------- */

export type EditResult =
  | { readonly ok: true; readonly edits: Edits }
  | { readonly ok: false; readonly message: string };

/** Set one cell's text, or forget its edit when the text is what the cell started with. */
function withText(
  model: GridModel,
  edits: Edits,
  column: GridColumn,
  month: string,
  text: string,
): Map<string, CellEdit> | null {
  const cell = cellAt(model, column, month);
  const base = baseOf(cell);
  if (base === null) return null;

  const next = new Map(edits);
  const key = cellKey(column.key, month);
  const existing = edits.get(key);
  if (text === initialText(cell, column, model.locale)) next.delete(key);
  else next.set(key, { columnKey: column.key, month, text, base: existing?.base ?? base });
  return next;
}

/**
 * The user typed into one cell (or cleared it by hand).
 *
 * Refused as one action — the text is not taken — when it would take the save
 * past the per-save limit (ADR 0011 D2). The user saves, then continues.
 */
export function typeInto(
  model: GridModel,
  edits: Edits,
  column: GridColumn,
  month: string,
  text: string,
): EditResult {
  const next = withText(model, edits, column, month, text);
  if (next === null) return { ok: false, message: 'This cell cannot be edited here.' };
  if (operationCount(model, next) > model.maxOperations && operationCount(model, next) > operationCount(model, edits)) {
    return { ok: false, message: limitMessage(model.maxOperations) };
  }
  return { ok: true, edits: next };
}

/** Forget one cell's edit: what Escape does. */
export function revertCell(edits: Edits, columnKey: string, month: string): Edits {
  const next = new Map(edits);
  next.delete(cellKey(columnKey, month));
  return next;
}

const monthName = (month: string, locale: string): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, index - 1, 1)),
  );
};

/**
 * Paste a spreadsheet rectangle with its top-left field at `anchor` (ADR 0011
 * D4).
 *
 * The rectangle is mapped through the column model — never through the cells
 * that happen to be mounted — so a paste reaches rows the window has not
 * rendered. It is judged whole before anything changes: a non-blank field that
 * lands outside the grid, on the current month, on a cell nobody may edit, or
 * that is not an amount the cell accepts, refuses the **whole** paste with a
 * message naming that cell; so does a paste that would take the save past the
 * per-save limit. A blank field leaves its cell as it was.
 */
export function pasteInto(
  model: GridModel,
  edits: Edits,
  anchor: { readonly row: number; readonly column: number },
  text: string,
): EditResult & { readonly changed?: number } {
  const parsed = parseTsv(text);
  if (!parsed.ok) return parsed;

  let next = new Map(edits);
  let changed = 0;
  for (const [rowOffset, fields] of parsed.rows.entries()) {
    for (const [columnOffset, field] of fields.entries()) {
      if (field.trim() === '') continue;

      const month = model.rows[anchor.row + rowOffset];
      const column = model.columns[anchor.column + columnOffset];
      if (month === undefined || column === undefined) {
        return { ok: false, message: 'The pasted block reaches past the edge of the grid, so nothing was pasted.' };
      }
      const where = `${column.name}, ${monthName(month, model.locale)}`;
      if (month === model.currentMonth) {
        return {
          ok: false,
          message: `${where} is the current month, which is updated in Monthly. Nothing was pasted.`,
        };
      }
      const cell = cellAt(model, column, month);
      if (baseOf(cell) === null) {
        return { ok: false, message: `${where} cannot be edited here, so nothing was pasted.` };
      }
      const amount = amountFor(column, field, model.locale);
      if (!amount.ok) return { ok: false, message: `${where}: ${amount.message} Nothing was pasted.` };

      const updated = withText(
        model,
        next,
        column,
        month,
        editableText(amount.value, model.locale, column.minorUnits),
      );
      /* v8 ignore next -- an editable cell always takes text. */
      if (updated === null) return { ok: false, message: `${where} cannot be edited here.` };
      next = updated;
      changed += 1;
    }
  }

  if (operationCount(model, next) > model.maxOperations && operationCount(model, next) > operationCount(model, edits)) {
    return { ok: false, message: limitMessage(model.maxOperations) };
  }
  return { ok: true, edits: next, changed };
}

/* -------------------------------------------------------------------------- */
/* A refresh                                                                   */
/* -------------------------------------------------------------------------- */

/** An edit a refresh could not keep, and what the server holds in its cell now. */
export interface DroppedEdit {
  readonly columnKey: string;
  readonly columnName: string;
  readonly month: string;
  readonly typed: string;
  readonly server: string;
}

/**
 * Whether the server already holds what an edit asked for — an amount stored,
 * or a clear done — so the edit has nothing left to do. That is what a commit
 * leaves behind, and what another tab saving the same figure leaves behind.
 */
function satisfied(model: GridModel, column: GridColumn, edit: CellEdit): boolean {
  const cell = cellAt(model, column, edit.month);
  const stored =
    cell?.kind === 'stored' ? cell.amount : cell?.kind === 'materialized' ? cell.netAmount : null;
  if (edit.text.trim() === '') {
    return (edit.base.kind === 'stored' || edit.base.kind === 'materialized') && stored === null;
  }
  const amount = amountFor(column, edit.text, model.locale);
  return amount.ok && stored !== null && sameDecimal(amount.value, stored);
}

/**
 * Take in a newer read of the grid without losing or re-aiming anything typed
 * (ADR 0011 D9).
 *
 * An edit whose base is still exactly what its cell holds is kept. An edit
 * whose cell now already holds what it asked for has nothing left to do and is
 * let go quietly. Every other edit — its base moved, and not to its own value —
 * is **dropped**, never re-targeted at the newer version, and listed with what
 * the server holds now, so the user decides again with the truth in front of
 * them.
 */
export function rebase(
  model: GridModel,
  edits: Edits,
): { readonly kept: Edits; readonly dropped: readonly DroppedEdit[] } {
  const kept = new Map<string, CellEdit>();
  const dropped: DroppedEdit[] = [];
  for (const [key, edit] of edits) {
    const column = columnOf(model, edit.columnKey);
    const cell = column === undefined ? null : cellAt(model, column, edit.month);
    if (column !== undefined && sameBase(edit.base, baseOf(cell))) {
      kept.set(key, edit);
      continue;
    }
    if (column !== undefined && satisfied(model, column, edit)) continue;
    dropped.push({
      columnKey: edit.columnKey,
      columnName: column?.name ?? 'A column that is no longer shown',
      month: edit.month,
      typed: edit.text,
      server: column === undefined ? 'not shown' : serverValueOf(cell, column, model.locale),
    });
  }
  return { kept, dropped };
}
