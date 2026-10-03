/**
 * The Bulk History grid's read model (blueprint 15.2 "Bulk history editor",
 * 15.3 "Bulk history"; ADR 0011).
 *
 * Every cell **states** what it is. The browser never infers a cell's truth
 * from a number — whether a figure is a stored statement, a balance carried
 * from an earlier date, a zero the account's dormancy or closure derives, or
 * nothing at all is said here, by the server, from the finance functions the
 * reconciliation itself uses.
 *
 * ## Sparse by construction
 *
 * A column is a list of **segments**: a run of consecutive months that share
 * one cell. A carried balance, an empty stretch, a dormant episode or a run of
 * months a quarterly source has no occurrence in is one segment however long
 * it lasts; only a stored row is a segment of one month. A thirty-year grid
 * therefore costs what its stored rows cost, not what its cell count does.
 *
 * Plain JSON throughout: amounts are exact decimal strings in their native
 * currency, dates are ISO strings, and nothing here holds a server object.
 */

/** A run of consecutive months, inclusive, `YYYY-MM`, that share one cell. */
export interface BulkSegment<Cell> {
  readonly from: string;
  readonly through: string;
  readonly cell: Cell;
}

/* -------------------------------------------------------------------------- */
/* Balance cells                                                               */
/* -------------------------------------------------------------------------- */

export type BulkPositionCell =
  /**
   * The month's statement balance: a `month_end` row dated `end(M)`. Editable:
   * a new amount updates it against `version`, a clear deletes it.
   */
  | {
      readonly kind: 'stored';
      readonly valuationId: string;
      readonly version: number;
      readonly amount: string;
      readonly source: string;
      /**
       * `false` for the closing balance of a closed account, which is not
       * deletable while the account stays closed (6.3); it can still be
       * corrected.
       */
      readonly clearable: boolean;
    }
  /**
   * An ordinary snapshot dated `end(M)`. Not a statement, and not this grid's
   * to edit: Monthly confirms it as the statement balance or replaces it
   * (ADR 0011 D8).
   */
  | { readonly kind: 'snapshot'; readonly valuationId: string; readonly amount: string }
  /**
   * No statement at `end(M)`; the latest earlier balance, shown muted. Not a
   * source row: typing a figure here — even the same one — creates one.
   */
  | { readonly kind: 'carried'; readonly amount: string; readonly since: string }
  /**
   * A zero the evidence derives without a row: the account's current dormant
   * episode covers `end(M)`, or it closed inside M. `editable` is the same
   * window rule every balance obeys: a closed month end is outside it.
   */
  | {
      readonly kind: 'derived_zero';
      readonly reason: 'dormant' | 'closed';
      readonly editable: boolean;
    }
  /** Nothing on or before `end(M)`: a balance may be entered. */
  | { readonly kind: 'empty' }
  /** Outside the account's window: before it opened, or after the month it closed in. */
  | { readonly kind: 'unavailable'; readonly reason: 'not_open' | 'closed' };

export interface BulkPositionColumnDto {
  readonly kind: 'position';
  readonly positionId: string;
  readonly positionKind: 'cash' | 'other_asset';
  readonly name: string;
  readonly currency: string;
  readonly status: 'active' | 'closed' | 'archived';
  /** Every completed month of the grid, in order, without gaps. */
  readonly segments: readonly BulkSegment<BulkPositionCell>[];
}

/* -------------------------------------------------------------------------- */
/* Income cells                                                                */
/* -------------------------------------------------------------------------- */

export type BulkIncomeCell =
  /**
   * The occurrence is recorded. Its net is editable against `version`; a clear
   * deletes the row, and the occurrence is due again unless a skip exists.
   * `receivedOn` is shown when it differs from the scheduled date — the entry
   * stays in its occurrence's row either way.
   */
  | {
      readonly kind: 'materialized';
      readonly occurrenceDate: string;
      readonly entryId: string;
      readonly version: number;
      readonly netAmount: string;
      readonly receivedOn: string;
    }
  /** Scheduled, unresolved, and the source can still record it. */
  | { readonly kind: 'open'; readonly occurrenceDate: string }
  /** Resolved by an explicit skip; Bulk History never un-skips. */
  | { readonly kind: 'skipped'; readonly occurrenceDate: string }
  /** Scheduled and unresolved, but the source is archived: no new occurrence. */
  | { readonly kind: 'archived'; readonly occurrenceDate: string }
  /** The source has no occurrence in this month. */
  | { readonly kind: 'none' };

export interface BulkIncomeColumnDto {
  readonly kind: 'income';
  readonly templateId: string;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
  readonly segments: readonly BulkSegment<BulkIncomeCell>[];
}

export type BulkColumnDto = BulkPositionColumnDto | BulkIncomeColumnDto;

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

export interface BulkHistoryPageDto {
  /** The grid's first row, `YYYY-MM`. */
  readonly startMonth: string;
  /** The last editable row: the month before the current one. */
  readonly lastCompletedMonth: string;
  /** The current month: a row the grid shows disabled. */
  readonly currentMonth: string;
  readonly today: string;
  /** Balance columns first, then income columns, in display order. */
  readonly columns: readonly BulkColumnDto[];
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /** The per-save limit the grid holds its unsaved operations to (ADR 0011 D2). */
  readonly maxOperations: number;
}
