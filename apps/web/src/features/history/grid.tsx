'use client';

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { BulkHistoryPageDto } from '@vaultide/application';
import { CorrectionHost } from '@/features/corrections/host';
import type { CorrectionLabels } from '@/features/corrections/presentation';
import { BROKEN_REVIEW_MESSAGE, useCorrection } from '@/features/corrections/use-correction';
import { accountAnchorId, dayTitle, monthTitle } from '@/features/monthly/presentation';
import { cn } from '@/lib/utils';
import {
  NO_EDITS,
  draftOf,
  outcomesOf,
  pasteInto,
  rebase,
  revertCell,
  typeInto,
  type DroppedEdit,
  type Edits,
} from './edits';
import {
  baseOf,
  cellAt,
  cellKey,
  gridModelOf,
  initialText,
  nextEditable,
  type GridColumn,
  type GridDirection,
  type GridModel,
  type GridPosition,
} from './model';
import { editableText } from './numbers';
import { historyHref, isHistoryStart, monthlyHref, shiftMonth } from './routes';

/**
 * The Bulk History grid (blueprint 15.2 "Bulk history editor", 15.3; ADR 0011).
 *
 * Desktop-first: completed months down the side, a column per account and per
 * income source across the top, both headers sticky, and only the rows on
 * screen mounted — a thirty-year grid scrolls as lightly as a one-year one.
 * Every cell says what it is, as the server stated it; nothing here works out
 * a balance or an income figure.
 *
 * Nothing is written from this component. Save asks the server to review the
 * whole set of changed cells — always, whatever they are (ADR 0011 D7) — and
 * the existing review dialog confirms it as one act. Until then the edits live
 * here, each with the base it was typed against, and every newer read of the
 * grid is checked against those bases before an edit is kept (ADR 0011 D9).
 */

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const HEADER_HEIGHT = 56;

const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';
const BUTTON =
  'min-h-9 rounded-[var(--radius-control)] border px-3 text-[length:var(--text-table)] font-medium disabled:opacity-60';

type Notice = { readonly tone: 'error' | 'info'; readonly text: string };

function labelsOf(model: GridModel): CorrectionLabels {
  return {
    accounts: Object.fromEntries(
      model.columns
        .filter((column) => column.kind === 'position')
        .map((column) => [column.id, { name: column.name, currency: column.currency }]),
    ),
    categories: {},
    templates: Object.fromEntries(
      model.columns.filter((column) => column.kind === 'income').map((column) => [column.id, column.name]),
    ),
    locale: model.locale,
  };
}

const KIND_LABEL = (column: GridColumn): string =>
  column.kind === 'income' ? 'Income, net' : column.positionKind === 'cash' ? 'Month-end balance' : 'Month-end value';

export function BulkHistoryGrid({
  page,
  locale,
}: {
  readonly page: BulkHistoryPageDto;
  readonly locale: string;
}) {
  const router = useRouter();
  const model = useMemo(() => gridModelOf(page, locale), [page, locale]);
  const labels = useMemo(() => labelsOf(model), [model]);
  const correction = useCorrection();
  const statusId = useId();

  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [edited, setEdited] = useState(false);
  const [dropped, setDropped] = useState<readonly DroppedEdit[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focus, setFocus] = useState<GridPosition | null>(null);
  const [preparing, setPreparing] = useState(false);

  // A newer read of the grid arrived — after a commit, a refused save, a
  // changed impact, or any refresh. Keep each edit whose base still stands;
  // drop, never re-aim, the rest, and say which (ADR 0011 D9).
  const [seen, setSeen] = useState(model);
  if (seen !== model) {
    const result = rebase(model, edits);
    setSeen(model);
    setEdits(result.kept);
    if (result.dropped.length > 0) setDropped(result.dropped);
    if (result.kept.size === 0) setEdited(false);
  }

  const outcomes = useMemo(() => outcomesOf(model, edits), [model, edits]);
  const current = useMemo(() => draftOf(model, edits), [model, edits]);

  // A review the user stepped back from is resumable only while it is still
  // the review of these edits. Once a refresh drops a cell, or the user changes
  // one, it is somebody else's draft: it is let go, and Save asks again.
  if (
    correction.paused &&
    correction.pending !== null &&
    (!current.ok || JSON.stringify(current.draft) !== JSON.stringify(correction.pending.draft))
  ) {
    correction.clear();
  }
  const resumable = correction.paused && correction.pending !== null;
  const operations = outcomes.filter((item) => item.outcome.kind === 'operation').length;
  const problems = new Map(
    outcomes.flatMap((item) =>
      item.outcome.kind === 'invalid'
        ? [[cellKey(item.column.key, item.edit.month), item.outcome.message] as const]
        : [],
    ),
  );
  const droppedKeys = new Set(dropped.map((item) => cellKey(item.columnKey, item.month)));
  const focusedKey =
    focus === null
      ? null
      : cellKey(model.columns[focus.column]?.key ?? '', model.rows[focus.row] ?? '');
  const problemAt = (key: string): string | null => {
    const message = problems.get(key);
    if (message === undefined) return null;
    const [columnKey = '', month = ''] = key.split('|');
    const name = model.columns.find((column) => column.key === columnKey)?.name ?? '';
    return `${name}, ${monthTitle(month, locale)}: ${message}`;
  };
  const firstProblem =
    (focusedKey === null ? null : problemAt(focusedKey)) ??
    ([...problems.keys()].map(problemAt).find((line) => line !== null) ?? null);

  // Leaving with unsaved changes asks first; the edited flag, set by every
  // change, is what says there are any.
  useEffect(() => {
    if (!edited) return undefined;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [edited]);

  /* -------------------------------------------------------------------- */
  /* Changing cells                                                        */
  /* -------------------------------------------------------------------- */

  const changed = (next: Edits): void => {
    setEdits(next);
    setEdited(true);
    // Any change makes a review prepared before it stale.
    if (correction.pending !== null) correction.clear();
  };

  const type = (column: GridColumn, month: string, text: string): void => {
    const result = typeInto(model, edits, column, month, text);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.message });
      return;
    }
    setNotice(null);
    setDropped((list) => list.filter((item) => item.columnKey !== column.key || item.month !== month));
    changed(result.edits);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (focus === null) return;
    event.preventDefault();
    const result = pasteInto(model, edits, focus, event.clipboardData.getData('text/plain'));
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.message });
      return;
    }
    setNotice({
      tone: 'info',
      text: `Pasted ${String(result.changed ?? 0)} ${result.changed === 1 ? 'cell' : 'cells'}. Nothing is saved until you review it.`,
    });
    changed(result.edits);
  };

  const discard = (): void => {
    setEdits(NO_EDITS);
    setEdited(false);
    setDropped([]);
    setNotice(null);
    correction.clear();
  };

  const review = async (): Promise<void> => {
    const prepared = current;
    if (!prepared.ok) {
      setNotice({
        tone: 'error',
        text: `${String(prepared.invalid)} ${prepared.invalid === 1 ? 'cell needs' : 'cells need'} attention before this can be reviewed.`,
      });
      return;
    }
    if (prepared.draft.operations.length === 0) {
      setNotice({ tone: 'info', text: 'Nothing has changed, so there is nothing to save.' });
      return;
    }
    setPreparing(true);
    setNotice(null);
    try {
      const outcome = await correction.prepareReview(prepared.draft);
      if (outcome.kind === 'refused') {
        setNotice({ tone: 'error', text: outcome.error.message });
        // The answer may be that something moved: take in the newer state.
        router.refresh();
      } else if (outcome.kind === 'broken') {
        setNotice({ tone: 'error', text: BROKEN_REVIEW_MESSAGE });
      }
    } catch {
      setNotice({
        tone: 'error',
        text: 'The review could not be prepared — the server did not answer. Your changes are still here.',
      });
    } finally {
      setPreparing(false);
    }
  };

  /* -------------------------------------------------------------------- */
  /* Window and focus                                                      */
  /* -------------------------------------------------------------------- */

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return undefined;
    const measure = () => {
      setViewport(element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const firstRow = Math.max(0, Math.floor(Math.max(0, scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(model.rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);

  // Keep the focused cell on screen, then put the caret in it once it is mounted.
  const pendingFocus = useRef<GridPosition | null>(null);
  const moveTo = (position: GridPosition): void => {
    const element = scrollRef.current;
    if (element !== null) {
      const top = HEADER_HEIGHT + position.row * ROW_HEIGHT;
      if (top < element.scrollTop + HEADER_HEIGHT) element.scrollTop = top - HEADER_HEIGHT;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      }
      setScrollTop(element.scrollTop);
    }
    pendingFocus.current = position;
    setFocus(position);
  };
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const input = scrollRef.current?.querySelector<HTMLInputElement>(
      `input[data-row="${String(target.row)}"][data-column="${String(target.column)}"]`,
    );
    if (input !== null && input !== undefined) {
      pendingFocus.current = null;
      input.focus();
      input.select();
    }
  });

  // The cells call back through one stable ref, so a cell re-renders only when
  // its own text, state or mark changes — not on every keystroke elsewhere.
  const actions = useRef<CellActions | null>(null);
  useLayoutEffect(() => {
    actions.current = { type, focus: setFocus, keyDown: onKeyDown };
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, position: GridPosition): void => {
    const direction: GridDirection | null =
      event.key === 'Enter'
        ? event.shiftKey
          ? 'up'
          : 'down'
        : event.key === 'ArrowDown'
          ? 'down'
          : event.key === 'ArrowUp'
            ? 'up'
            : event.key === 'Tab'
              ? event.shiftKey
                ? 'previous'
                : 'next'
              : null;
    if (event.key === 'Escape') {
      const column = model.columns[position.column];
      const month = model.rows[position.row];
      if (column !== undefined && month !== undefined && edits.has(cellKey(column.key, month))) {
        event.preventDefault();
        changed(revertCell(edits, column.key, month));
      }
      return;
    }
    if (direction === null) return;
    const next = nextEditable(model, position, direction);
    if (next === null) return;
    event.preventDefault();
    moveTo(next);
  };

  /* -------------------------------------------------------------------- */
  /* Rendering                                                             */
  /* -------------------------------------------------------------------- */

  if (model.columns.length === 0) {
    return (
      <div className="rounded-[var(--radius-surface)] border p-6" data-testid="bulk-empty">
        <p className="font-medium">There is nothing to fill in yet.</p>
        <p className={cn('mt-1', META)}>
          Bulk history edits the month-end balances of your cash accounts and other assets, and the
          income your recurring sources paid. Add an account or an income source first.
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-[length:var(--text-table)]">
          <Link href="/accounts" className="underline">
            Add an account
          </Link>
          <Link href={monthlyHref(model.currentMonth)} className="underline">
            Open Monthly
          </Link>
        </div>
      </div>
    );
  }

  const rows = model.rows.slice(firstRow, lastRow);

  return (
    <div className="space-y-3">
      <StartControl model={model} edited={edited} />

      <div className="flex flex-wrap items-center gap-3">
        {/* Stepped back from a review that still stands: the host's own button
            reopens it, so this one is not offered beside it. */}
        {resumable ? null : (
          <button
            type="button"
            data-testid="bulk-review"
            className={cn(BUTTON, 'bg-[var(--color-foreground)] text-[var(--color-surface)]')}
            disabled={preparing || operations === 0 || problems.size > 0}
            aria-describedby={statusId}
            onClick={() => {
              void review();
            }}
          >
            {preparing ? 'Preparing review…' : 'Review changes'}
          </button>
        )}
        <button
          type="button"
          data-testid="bulk-discard"
          className={BUTTON}
          disabled={!edited || preparing}
          onClick={discard}
        >
          Discard changes
        </button>
        <span className={META} id={statusId} data-testid="bulk-status">
          {edited
            ? `${String(operations)} changed ${operations === 1 ? 'cell' : 'cells'}${
                problems.size > 0 ? ` · ${String(problems.size)} to fix` : ''
              } · unsaved`
            : 'No unsaved changes'}
          {` · up to ${String(model.maxOperations)} per save`}
        </span>
        <CorrectionHost
          flow={correction}
          labels={labels}
          onCommitted={() => {
            setEdits(NO_EDITS);
            setEdited(false);
            setDropped([]);
            setNotice({ tone: 'info', text: 'Saved. The grid now shows what was recorded.' });
            router.refresh();
          }}
          onSettled={() => {
            router.refresh();
          }}
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        data-testid="bulk-notice"
        className={cn(
          'text-[length:var(--text-meta)]',
          notice === null ? 'sr-only' : notice.tone === 'error' ? 'text-[var(--color-negative)]' : META,
        )}
      >
        {notice?.text ?? ''}
      </p>

      {firstProblem === null ? null : (
        <p className="text-[length:var(--text-meta)] text-[var(--color-negative)]" data-testid="bulk-problem">
          {firstProblem}
        </p>
      )}

      {dropped.length > 0 ? (
        <DroppedList
          dropped={dropped}
          locale={locale}
          onDismiss={() => {
            setDropped([]);
          }}
        />
      ) : null}

      <div
        ref={scrollRef}
        className="relative max-h-[70vh] max-w-full overflow-auto rounded-[var(--radius-surface)] border"
        data-testid="bulk-grid"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
        onPaste={onPaste}
      >
        <table
          aria-label="Month-end balances and income by month"
          className="border-separate border-spacing-0 text-[length:var(--text-table)]"
        >
          <thead>
            <tr style={{ height: HEADER_HEIGHT }}>
              <th
                scope="col"
                className="sticky top-0 left-0 z-30 min-w-28 border-b border-r bg-[var(--color-surface)] px-3 text-left font-medium"
              >
                Month
              </th>
              {model.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  data-testid="bulk-column"
                  data-column-key={column.key}
                  className="sticky top-0 z-20 min-w-40 border-b bg-[var(--color-surface)] px-2 text-left align-bottom font-medium"
                >
                  <span className="block truncate" title={column.name}>
                    {column.name}
                  </span>
                  <span className={cn('block truncate font-normal', META)}>
                    {KIND_LABEL(column)} · {column.currency}
                    {column.kind === 'income' && column.archived ? ' · archived' : ''}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {firstRow > 0 ? <tr aria-hidden="true" style={{ height: firstRow * ROW_HEIGHT }} /> : null}
            {rows.map((month, offset) => {
              const row = firstRow + offset;
              const current = month === model.currentMonth;
              return (
                <tr key={month} style={{ height: ROW_HEIGHT }} data-testid="bulk-row" data-month={month}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-r bg-[var(--color-surface)] px-3 text-left font-normal whitespace-nowrap"
                  >
                    <Link href={monthlyHref(month)} className="underline-offset-2 hover:underline">
                      {monthTitle(month, locale)}
                    </Link>
                    {current ? <span className={cn('block', META)}>In progress</span> : null}
                  </th>
                  {model.columns.map((column, columnIndex) => (
                    <GridCell
                      key={column.key}
                      model={model}
                      column={column}
                      month={month}
                      row={row}
                      columnIndex={columnIndex}
                      text={edits.get(cellKey(column.key, month))?.text}
                      problem={problems.get(cellKey(column.key, month))}
                      droppedHere={droppedKeys.has(cellKey(column.key, month))}
                      actions={actions}
                    />
                  ))}
                </tr>
              );
            })}
            {lastRow < model.rows.length ? (
              <tr aria-hidden="true" style={{ height: (model.rows.length - lastRow) * ROW_HEIGHT }} />
            ) : null}
          </tbody>
        </table>
      </div>
      <p className={META}>
        Paste a block copied from a spreadsheet into any cell: it fills from that cell down and to the
        right. Blank fields leave their cells as they are. Enter moves down, Escape undoes a cell.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One cell                                                                    */
/* -------------------------------------------------------------------------- */

const CELL = 'border-b px-2 align-middle';

/**
 * A derived zero, in words, by the reason the server gave for it. A dormant
 * zero is a carry a figure may replace; a closed one is zero by definition and
 * is never editable here.
 */
const DERIVED_ZERO: Readonly<
  Record<'dormant' | 'closed', { readonly cell: string; readonly line: string; readonly hint: string }>
> = {
  dormant: {
    cell: '0 · dormant',
    line: 'dormant, carried at 0',
    hint: 'Dormant: carried at 0. A figure here records a balance and wakes the account.',
  },
  closed: {
    cell: '0 · closed',
    line: 'closed, 0 by definition',
    hint: 'Closed this month: its balance at the month end is zero by definition.',
  },
};

/** What a cell asks of the grid. Read through a ref, so it never changes a cell's props. */
interface CellActions {
  readonly type: (column: GridColumn, month: string, text: string) => void;
  readonly focus: (position: GridPosition) => void;
  readonly keyDown: (event: KeyboardEvent<HTMLInputElement>, position: GridPosition) => void;
}

function GridCellView({
  model,
  column,
  month,
  row,
  columnIndex,
  text,
  problem,
  droppedHere,
  actions,
}: {
  readonly model: GridModel;
  readonly column: GridColumn;
  readonly month: string;
  readonly row: number;
  readonly columnIndex: number;
  readonly text: string | undefined;
  readonly problem: string | undefined;
  readonly droppedHere: boolean;
  readonly actions: RefObject<CellActions | null>;
}) {
  const position: GridPosition = { row, column: columnIndex };
  const locale = model.locale;
  const cell = cellAt(model, column, month);
  const where = `${column.name}, ${monthTitle(month, locale)}`;
  const muted = (content: string, title?: string) => (
    <td className={cn(CELL, META)} title={title} data-testid="bulk-cell" data-state={cell?.kind ?? 'current'}>
      {content}
    </td>
  );

  if (cell === null) return muted('—', `${monthTitle(month, locale)} is in progress. Update it in Monthly.`);

  if (baseOf(cell) === null) {
    switch (cell.kind) {
      case 'snapshot':
        return (
          <td className={CELL} data-testid="bulk-cell" data-state="snapshot">
            <Link
              href={monthlyHref(month, accountAnchorId(column.id))}
              className="text-[length:var(--text-meta)] underline"
              title={`A snapshot of ${editableText(cell.amount, locale, column.minorUnits)} ${column.currency} on the last day. Monthly confirms it as the statement balance or replaces it.`}
            >
              Snapshot — confirm in Monthly
            </Link>
          </td>
        );
      case 'derived_zero':
        return muted(DERIVED_ZERO[cell.reason].cell, DERIVED_ZERO[cell.reason].hint);
      case 'unavailable':
        return muted('—', cell.reason === 'not_open' ? 'Not open yet.' : 'Closed.');
      case 'skipped':
        return muted('Skipped', 'Skipped in Monthly. Un-skip it there to record it.');
      case 'archived':
        return muted('Archived', 'This source is archived, so its missing occurrences cannot be added.');
      default:
        return muted('');
    }
  }

  const value = text ?? initialText(cell, column, locale);
  const placeholder =
    cell.kind === 'carried'
      ? editableText(cell.amount, locale, column.minorUnits)
      : cell.kind === 'derived_zero'
        ? '0'
        : '';
  const hint =
    cell.kind === 'carried'
      ? `No statement. Carried from ${dayTitle(cell.since, locale)}; type a figure to record one.`
      : cell.kind === 'derived_zero'
        ? DERIVED_ZERO[cell.reason].hint
        : cell.kind === 'stored'
          ? cell.source === 'bulk_entered'
            ? 'Statement balance, entered in bulk.'
            : cell.source === 'confirmed_unchanged'
              ? 'Statement balance, confirmed unchanged.'
              : 'Statement balance.'
          : cell.kind === 'open'
            ? `Scheduled ${dayTitle(cell.occurrenceDate, locale)}; not recorded yet.`
            : cell.kind === 'materialized'
              ? `Recorded for ${dayTitle(cell.occurrenceDate, locale)}.`
              : undefined;
  // One short line under the field, for what the field alone cannot say: that
  // a muted figure is carried and not recorded, why a zero is derived, that a
  // stored row emptied by hand will be removed, or that an occurrence's money
  // arrived on another day.
  const removing =
    text !== undefined && text.trim() === '' && (cell.kind === 'stored' || cell.kind === 'materialized');
  const secondary = removing
    ? 'will be removed'
    : cell.kind === 'carried' && text === undefined
      ? 'carried, not recorded'
      : cell.kind === 'derived_zero' && text === undefined
        ? DERIVED_ZERO[cell.reason].line
        : cell.kind === 'materialized' && cell.receivedOn !== cell.occurrenceDate
          ? `received ${dayTitle(cell.receivedOn, locale)}`
          : null;

  return (
    <td
      className={cn(CELL, droppedHere && 'bg-[var(--color-surface-muted)]')}
      data-testid="bulk-cell"
      data-state={cell.kind}
      data-edited={text === undefined ? 'false' : 'true'}
    >
      <input
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={where}
        aria-invalid={problem === undefined ? undefined : true}
        title={problem ?? hint}
        placeholder={placeholder}
        data-row={position.row}
        data-column={position.column}
        data-testid="bulk-input"
        value={value}
        onChange={(event) => {
          actions.current?.type(column, month, event.target.value);
        }}
        onFocus={() => {
          actions.current?.focus(position);
        }}
        onKeyDown={(event) => {
          actions.current?.keyDown(event, position);
        }}
        className={cn(
          'tabular h-7 w-full min-w-32 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-1.5 text-right placeholder:text-[var(--color-muted-foreground)] placeholder:italic',
          text !== undefined && 'border-[var(--color-foreground)]',
          problem !== undefined && 'border-[var(--color-negative)]',
          droppedHere && 'border-[var(--color-warning)]',
        )}
      />
      {secondary === null ? null : (
        <span className={cn('block text-right leading-tight', META)} data-testid="bulk-secondary">
          {secondary}
        </span>
      )}
    </td>
  );
}

const GridCell = memo(GridCellView);

/* -------------------------------------------------------------------------- */
/* What a refresh could not keep                                               */
/* -------------------------------------------------------------------------- */

function DroppedList({
  dropped,
  locale,
  onDismiss,
}: {
  readonly dropped: readonly DroppedEdit[];
  readonly locale: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="bulk-dropped"
      className="rounded-[var(--radius-surface)] border border-[var(--color-warning)] p-3"
    >
      <p className="font-medium text-[length:var(--text-table)]">
        {dropped.length === 1
          ? '1 cell changed elsewhere and was not kept.'
          : `${String(dropped.length)} cells changed elsewhere and were not kept.`}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 text-[length:var(--text-meta)]">
        {dropped.map((item) => (
          <li key={`${item.columnKey}|${item.month}`} data-testid="bulk-dropped-item">
            {item.columnName}, {monthTitle(item.month, locale)}: you typed “{item.typed === '' ? 'nothing (cleared)' : item.typed}”;
            it now holds {item.server}.
          </li>
        ))}
      </ul>
      <button type="button" className={cn(BUTTON, 'mt-2')} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The first row                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the grid starts (ADR 0011 D1). Changing it navigates — the route's
 * month is the first row — so back and forward work and the address always
 * says what is on screen. Unsaved changes have to be saved or discarded first:
 * a new start is a new grid.
 */
function StartControl({ model, edited }: { readonly model: GridModel; readonly edited: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const start = model.months[0] ?? model.currentMonth;
  const [value, setValue] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const earlier = shiftMonth(start, -12);

  const go = (month: string) => {
    if (!isHistoryStart(month, model.currentMonth)) {
      setError(`Choose a month as YYYY-MM, before ${model.currentMonth}.`);
      return;
    }
    setError(null);
    router.push(historyHref(month));
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        go(value.trim());
      }}
    >
      <label htmlFor={inputId} className="flex flex-col gap-1 text-[length:var(--text-meta)]">
        First month
        <input
          id={inputId}
          data-testid="bulk-start"
          value={value}
          disabled={edited}
          inputMode="numeric"
          placeholder="YYYY-MM"
          onChange={(event) => {
            setValue(event.target.value);
          }}
          className="h-9 w-28 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2"
        />
      </label>
      <button type="submit" className={BUTTON} disabled={edited} data-testid="bulk-start-go">
        Show
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={edited}
        data-testid="bulk-start-earlier"
        onClick={() => {
          go(earlier);
        }}
      >
        12 months earlier
      </button>
      <span className={cn(META, 'pb-2')} role={error === null ? undefined : 'alert'}>
        {error ?? (edited ? 'Save or discard your changes to move the first month.' : '')}
      </span>
    </form>
  );
}
