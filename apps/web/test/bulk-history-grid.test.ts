import { describe, expect, it, vi } from 'vitest';
import type {
  BulkHistoryPageDto,
  CorrectionDraft,
  CorrectionPreview,
} from '@vaultide/application';

vi.mock('@/server/actions/corrections', () => ({
  confirmHistoricalCorrectionAction: vi.fn(),
  previewHistoricalCorrectionAction: vi.fn(),
}));

const { gridModelOf, cellAt, nextEditable } = await import('@/features/history/model');
const {
  NO_EDITS,
  draftOf,
  operationCount,
  outcomesOf,
  pasteInto,
  rebase,
  refusedCellsOf,
  revertCell,
  typeInto,
} = await import('@/features/history/edits');
const {
  defaultHistoryStart,
  firstBalanceHistoryStart,
  historyHref,
  isHistoryStart,
  leavesThisPage,
  monthlyHref,
  shiftMonth,
} = await import('@/features/history/routes');
const { prepareReviewWith } = await import('@/features/corrections/use-correction');
const { carrySpan, summarizeBulk } = await import('@/features/corrections/presentation');

/**
 * The history grid's model and its unsaved edits (blueprint 15.3; ADR 0011 D2,
 * D3, D4, D9, D10).
 *
 * Pure: the server's DTO in, operations, refusals and rebased edits out. The
 * grid component renders this model and nothing else, so what is proved here
 * is what the user's typing and pasting turn into.
 */

const BBVA = 'pos-bbva';
const CAR = 'pos-car';
const SALARY = 'tpl-salary';

/** Five completed months, January to May, and June in progress. */
function page(overrides: Partial<BulkHistoryPageDto> = {}): BulkHistoryPageDto {
  return {
    startMonth: '2026-01',
    lastCompletedMonth: '2026-05',
    currentMonth: '2026-06',
    today: '2026-06-10',
    minorUnitsByCurrency: { EUR: 2, JPY: 0 },
    maxOperations: 500,
    columns: [
      {
        kind: 'position',
        positionId: BBVA,
        positionKind: 'cash',
        name: 'BBVA',
        currency: 'EUR',
        status: 'active',
        segments: [
          { from: '2026-01', through: '2026-01', cell: { kind: 'empty' } },
          {
            from: '2026-02',
            through: '2026-02',
            cell: { kind: 'stored', valuationId: 'val-feb', version: 2, amount: '1000', source: 'entered', clearable: true },
          },
          { from: '2026-03', through: '2026-04', cell: { kind: 'carried', amount: '1000', since: '2026-02-28' } },
          { from: '2026-05', through: '2026-05', cell: { kind: 'snapshot', valuationId: 'val-may', amount: '900' } },
        ],
      },
      {
        kind: 'position',
        positionId: CAR,
        positionKind: 'other_asset',
        name: 'Car',
        currency: 'JPY',
        status: 'active',
        segments: [
          { from: '2026-01', through: '2026-02', cell: { kind: 'unavailable', reason: 'not_open' } },
          { from: '2026-03', through: '2026-05', cell: { kind: 'empty' } },
        ],
      },
      {
        kind: 'income',
        templateId: SALARY,
        name: 'Salary',
        currency: 'EUR',
        archived: false,
        segments: [
          { from: '2026-01', through: '2026-01', cell: { kind: 'open', occurrenceDate: '2026-01-25' } },
          {
            from: '2026-02',
            through: '2026-02',
            cell: {
              kind: 'materialized',
              occurrenceDate: '2026-02-25',
              entryId: 'inc-feb',
              version: 3,
              netAmount: '2100',
              receivedOn: '2026-02-27',
            },
          },
          { from: '2026-03', through: '2026-03', cell: { kind: 'skipped', occurrenceDate: '2026-03-25' } },
          { from: '2026-04', through: '2026-05', cell: { kind: 'open', occurrenceDate: '2026-04-25' } },
        ],
      },
    ],
    ...overrides,
  };
}

const model = (overrides: Partial<BulkHistoryPageDto> = {}, locale = 'en-GB') => gridModelOf(page(overrides), locale);

function column(grid: ReturnType<typeof model>, key: string) {
  const found = grid.columns.find((item) => item.key === key);
  if (found === undefined) throw new Error(key);
  return found;
}

function typed(grid: ReturnType<typeof model>, cells: [string, string, string][]) {
  let edits = NO_EDITS;
  for (const [key, month, text] of cells) {
    const result = typeInto(grid, edits, column(grid, key), month, text);
    if (!result.ok) throw new Error(result.message);
    edits = result.edits;
  }
  return edits;
}

const operations = (grid: ReturnType<typeof model>, edits: ReturnType<typeof typed>) => {
  const drafted = draftOf(grid, edits);
  return drafted.ok ? drafted.draft.operations : drafted;
};

/* -------------------------------------------------------------------------- */

describe('the column model', () => {
  it('keeps the server’s column order and expands every segment to its months', () => {
    const grid = model();
    expect(grid.columns.map((item) => item.key)).toEqual([
      `position:${BBVA}`,
      `position:${CAR}`,
      `income:${SALARY}`,
    ]);
    expect(grid.rows).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(cellAt(grid, column(grid, `position:${BBVA}`), '2026-04')).toEqual({
      kind: 'carried',
      amount: '1000',
      since: '2026-02-28',
    });
    // The current month's row is disabled, whatever its column says.
    expect(cellAt(grid, column(grid, `position:${BBVA}`), '2026-06')).toBeNull();
  });

  it('moves between editable cells only, on the model rather than the screen', () => {
    const grid = model();
    expect(nextEditable(grid, { row: 0, column: 1 }, 'down')).toEqual({ row: 2, column: 1 });
    expect(nextEditable(grid, { row: 3, column: 0 }, 'down')).toBeNull();
    expect(nextEditable(grid, { row: 1, column: 2 }, 'down')).toEqual({ row: 3, column: 2 });
    expect(nextEditable(grid, { row: 0, column: 0 }, 'next')).toEqual({ row: 0, column: 2 });
  });
});

describe('what a cell’s text asks for (ADR 0011 D4)', () => {
  const grid = model();
  const bbva = `position:${BBVA}`;
  const salary = `income:${SALARY}`;

  it('asks nothing for a stored figure left alone or retyped exactly', () => {
    expect(operations(grid, NO_EDITS)).toEqual([]);
    expect(operations(grid, typed(grid, [[bbva, '2026-02', '1000.00']]))).toEqual([]);
    expect(operations(grid, typed(grid, [[bbva, '2026-02', '1000']]))).toEqual([]);
    expect(operations(grid, typed(grid, [[salary, '2026-02', '2100.0']]))).toEqual([]);
  });

  it('updates a changed stored figure and clears one emptied by hand', () => {
    expect(operations(grid, typed(grid, [[bbva, '2026-02', '1001']]))).toEqual([
      {
        kind: 'valuation_update',
        positionId: BBVA,
        month: '2026-02',
        valuationId: 'val-feb',
        expectedVersion: 2,
        amount: '1001',
      },
    ]);
    expect(operations(grid, typed(grid, [[bbva, '2026-02', '']]))).toEqual([
      { kind: 'valuation_clear', positionId: BBVA, month: '2026-02', valuationId: 'val-feb', expectedVersion: 2 },
    ]);
    expect(operations(grid, typed(grid, [[salary, '2026-02', '']]))).toEqual([
      { kind: 'income_clear', templateId: SALARY, occurrenceDate: '2026-02-25', entryId: 'inc-feb', expectedVersion: 3 },
    ]);
  });

  it('creates from a carried cell even when the figure typed is the carried one', () => {
    expect(operations(grid, typed(grid, [[bbva, '2026-03', '1000.00']]))).toEqual([
      { kind: 'valuation_create', positionId: BBVA, month: '2026-03', amount: '1000' },
    ]);
  });

  it('asks nothing of a carried cell left alone', () => {
    expect(operations(grid, typed(grid, [[bbva, '2026-03', '5'], [bbva, '2026-03', '']]))).toEqual([]);
  });

  it('materializes an open occurrence by its own scheduled date', () => {
    expect(operations(grid, typed(grid, [[salary, '2026-04', '2050.5']]))).toEqual([
      { kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-04-25', netAmount: '2050.5' },
    ]);
  });

  it('marks a figure the cell cannot take, and will not draft until it is fixed', () => {
    const edits = typed(grid, [
      [bbva, '2026-01', '1.234'],
      [`position:${CAR}`, '2026-03', '-5'],
      [salary, '2026-01', '1.5'],
    ]);
    // In grid order: January's two cells, then March's.
    expect(outcomesOf(grid, edits).map((item) => item.outcome.kind)).toEqual(['invalid', 'operation', 'invalid']);
    expect(draftOf(grid, edits)).toEqual({ ok: false, invalid: 2 });
  });

  it('refuses typing into a cell nobody may edit', () => {
    expect(typeInto(grid, NO_EDITS, column(grid, bbva), '2026-05', '1').ok).toBe(false);
    expect(typeInto(grid, NO_EDITS, column(grid, salary), '2026-03', '1').ok).toBe(false);
    expect(typeInto(grid, NO_EDITS, column(grid, bbva), '2026-06', '1').ok).toBe(false);
  });

  it('names the first row as the draft’s start', () => {
    const drafted = draftOf(grid, typed(grid, [[bbva, '2026-01', '5']]));
    expect(drafted.ok && drafted.draft.startMonth).toBe('2026-01');
  });
});

describe('the per-save limit (ADR 0011 D2)', () => {
  it('takes the edit that reaches the limit and refuses the one past it, as one action', () => {
    const grid = model({ maxOperations: 2 });
    const bbva = column(grid, `position:${BBVA}`);
    let edits = typed(grid, [[`position:${BBVA}`, '2026-01', '1'], [`position:${BBVA}`, '2026-03', '2']]);
    expect(operationCount(grid, edits)).toBe(2);

    const past = typeInto(grid, edits, bbva, '2026-04', '3');
    expect(past).toEqual({ ok: false, message: expect.stringMatching(/at most 2 changed cells/u) });

    // Changing a cell that already counts is still allowed.
    const again = typeInto(grid, edits, bbva, '2026-03', '4');
    expect(again.ok).toBe(true);
    edits = again.ok ? again.edits : edits;
    expect(operationCount(grid, edits)).toBe(2);
  });

  it('refuses a paste that would go past it, leaving everything as it was', () => {
    const grid = model({ maxOperations: 2 });
    const result = pasteInto(grid, NO_EDITS, { row: 0, column: 0 }, '1\n\n2\n3');
    expect(result.ok).toBe(false);
  });
});

describe('pasting a block (ADR 0011 D4)', () => {
  const grid = model();

  it('fills from the focused cell down and to the right, through the column model', () => {
    const result = pasteInto(grid, NO_EDITS, { row: 2, column: 0 }, '1.000,00\t5\t\r\n2000\t6\t2100\r\n');
    // en-GB reads "1.000,00" as nothing sensible: the whole paste is refused.
    expect(result.ok).toBe(false);

    const pasted = pasteInto(grid, NO_EDITS, { row: 2, column: 0 }, '1,000.00\t5\t\r\n2000\t6\t2100\r\n');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.changed).toBe(5);
    expect(operations(grid, pasted.edits)).toEqual([
      { kind: 'valuation_create', positionId: BBVA, month: '2026-03', amount: '1000' },
      { kind: 'valuation_create', positionId: CAR, month: '2026-03', amount: '5' },
      { kind: 'valuation_create', positionId: BBVA, month: '2026-04', amount: '2000' },
      { kind: 'valuation_create', positionId: CAR, month: '2026-04', amount: '6' },
      { kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-04-25', netAmount: '2100' },
    ]);
  });

  it('reads the locale the grid was opened in', () => {
    const german = model({}, 'de-DE');
    const pasted = pasteInto(german, NO_EDITS, { row: 2, column: 0 }, '1.000,50');
    expect(pasted.ok && operations(german, pasted.edits)).toEqual([
      { kind: 'valuation_create', positionId: BBVA, month: '2026-03', amount: '1000.5' },
    ]);
  });

  it('leaves a cell under a blank field exactly as it was', () => {
    const pasted = pasteInto(grid, NO_EDITS, { row: 1, column: 0 }, '\t\t');
    expect(pasted.ok && pasted.edits.size).toBe(0);
  });

  it('refuses the whole paste when one field lands where it may not, naming the cell', () => {
    const before = typed(grid, [[`position:${BBVA}`, '2026-01', '7']]);
    for (const [anchor, text, pattern] of [
      [{ row: 4, column: 0 }, '1', /BBVA, May 2026 cannot be edited/u],
      [{ row: 5, column: 0 }, '1', /current month/u],
      [{ row: 2, column: 2 }, '1', /Salary, March 2026 cannot be edited/u],
      [{ row: 0, column: 1 }, '1', /Car, January 2026 cannot be edited/u],
      [{ row: 0, column: 2 }, '1\t2', /edge of the grid/u],
      [{ row: 2, column: 1 }, '1\n2\n3\n4', /current month/u],
      [{ row: 2, column: 1 }, '1.5', /This currency has no decimals/u],
      [{ row: 0, column: 0 }, '"5', /never closes/u],
    ] as const) {
      const result = pasteInto(grid, before, anchor, text);
      expect(result.ok, String(pattern)).toBe(false);
      if (!result.ok) expect(result.message).toMatch(pattern);
    }
  });

  it('reaches rows that are not on screen, because it never asks the screen', () => {
    const long = model({
      startMonth: '1990-01',
      columns: [
        {
          kind: 'position',
          positionId: BBVA,
          positionKind: 'cash',
          name: 'BBVA',
          currency: 'EUR',
          status: 'active',
          segments: [{ from: '1990-01', through: '2026-05', cell: { kind: 'empty' } }],
        },
      ],
    });
    const text = Array.from({ length: 400 }, (_, index) => String(index + 1)).join('\n');
    const pasted = pasteInto(long, NO_EDITS, { row: 0, column: 0 }, text);
    expect(pasted.ok && operationCount(long, pasted.edits)).toBe(400);
  });
});

describe('taking in a newer read (ADR 0011 D9)', () => {
  const bbva = `position:${BBVA}`;
  const salary = `income:${SALARY}`;
  const grid = model();
  const edits = typed(grid, [
    [bbva, '2026-01', '10'],
    [bbva, '2026-02', '1001'],
    [salary, '2026-04', '2000'],
  ]);

  const newer = (cells: Partial<Record<'jan' | 'feb' | 'apr', unknown>>) => {
    const dto = page();
    const [bank, car, pay] = dto.columns as [any, any, any]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return gridModelOf(
      {
        ...dto,
        columns: [
          {
            ...bank,
            segments: [
              { from: '2026-01', through: '2026-01', cell: cells.jan ?? { kind: 'empty' } },
              {
                from: '2026-02',
                through: '2026-02',
                cell: cells.feb ?? bank.segments[1].cell,
              },
              ...bank.segments.slice(2),
            ],
          },
          car,
          {
            ...pay,
            segments: [
              ...pay.segments.slice(0, 3),
              { from: '2026-04', through: '2026-04', cell: cells.apr ?? { kind: 'open', occurrenceDate: '2026-04-25' } },
              { from: '2026-05', through: '2026-05', cell: { kind: 'open', occurrenceDate: '2026-05-25' } },
            ],
          },
        ],
      },
      'en-GB',
    );
  };

  it('keeps every edit whose base still stands', () => {
    const result = rebase(newer({}), edits);
    expect(result.kept.size).toBe(3);
    expect(result.dropped).toEqual([]);
  });

  it('drops, never re-aims, an edit whose stored row moved, and says what is there now', () => {
    const result = rebase(
      newer({
        feb: { kind: 'stored', valuationId: 'val-feb', version: 3, amount: '1200', source: 'entered', clearable: true },
      }),
      edits,
    );
    expect([...result.kept.keys()]).toEqual([`${bbva}|2026-01`, `${salary}|2026-04`]);
    expect(result.dropped).toEqual([
      { columnKey: bbva, columnName: 'BBVA', month: '2026-02', typed: '1001', server: '1200.00 EUR' },
    ]);
  });

  it('drops an edit whose empty cell was filled elsewhere', () => {
    const result = rebase(
      newer({
        jan: { kind: 'stored', valuationId: 'val-jan', version: 1, amount: '5', source: 'entered', clearable: true },
      }),
      edits,
    );
    expect(result.dropped.map((item) => item.month)).toEqual(['2026-01']);
  });

  it('lets go quietly of an edit the server now already holds — what a commit leaves', () => {
    const result = rebase(
      newer({
        jan: { kind: 'stored', valuationId: 'val-jan', version: 1, amount: '10', source: 'bulk_entered', clearable: true },
        feb: { kind: 'stored', valuationId: 'val-feb', version: 3, amount: '1001', source: 'entered', clearable: true },
        apr: {
          kind: 'materialized',
          occurrenceDate: '2026-04-25',
          entryId: 'inc-apr',
          version: 1,
          netAmount: '2000',
          receivedOn: '2026-04-25',
        },
      }),
      edits,
    );
    expect(result.kept.size).toBe(0);
    expect(result.dropped).toEqual([]);
  });
});

describe('where Bulk History lives (ADR 0011 D1, D11)', () => {
  it('builds every link from the first row', () => {
    expect(historyHref('2025-10')).toBe('/monthly/2025-10/history');
    expect(monthlyHref('2025-10')).toBe('/monthly/2025-10');
    expect(monthlyHref('2025-10', 'account-x')).toBe('/monthly/2025-10#account-x');
    expect(defaultHistoryStart('2026-10')).toBe('2025-10');
    expect(firstBalanceHistoryStart('2026-01')).toBe('2025-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
  });

  it('starts only from a completed month', () => {
    expect(isHistoryStart('2026-09', '2026-10')).toBe(true);
    expect(isHistoryStart('2026-10', '2026-10')).toBe(false);
    expect(isHistoryStart('2026-13', '2027-10')).toBe(false);
    expect(isHistoryStart('26-09', '2026-10')).toBe(false);
  });
});

describe('a review-only save', () => {
  const draft: CorrectionDraft = {
    kind: 'bulk_history',
    startMonth: '2026-01',
    operations: [{ kind: 'valuation_create', positionId: BBVA, month: '2026-01', amount: '1' }],
  };
  const preview = { fingerprint: `hc-v1:${'0'.repeat(64)}` } as CorrectionPreview;

  const ports = (answer: unknown) => {
    const opened: unknown[] = [];
    let forgotten = 0;
    return {
      opened,
      forgotten: () => forgotten,
      ports: {
        ask: () => Promise.resolve(answer as never),
        open: (asked: CorrectionDraft, shown: CorrectionPreview) => {
          opened.push([asked, shown]);
        },
        forget: () => {
          forgotten += 1;
        },
      },
    };
  };

  it('opens the review on the answer, with nothing saved', async () => {
    const world = ports({ ok: true, data: { status: 'review_required', preview } });
    expect(await prepareReviewWith(world.ports, draft)).toEqual({ kind: 'review' });
    expect(world.opened).toEqual([[draft, preview]]);
  });

  it('passes a refusal on to be shown', async () => {
    const error = { code: 'CONFLICT_VERSION', message: 'moved' };
    const world = ports({ ok: false, error });
    expect(await prepareReviewWith(world.ports, draft)).toEqual({ kind: 'refused', error });
    expect(world.opened).toEqual([]);
  });

  it('passes on the cells a refusal names, with its message', async () => {
    const error = {
      code: 'VALIDATION_ERROR',
      message: 'BBVA, January 2026: the account is closed, so its final balance has to stay zero. Nothing was saved.',
      fieldErrors: { [`${BBVA}#2026-01-31`]: ['This account is closed, so its final balance has to stay zero.'] },
    };
    const world = ports({ ok: false, error });
    expect(await prepareReviewWith(world.ports, draft)).toEqual({ kind: 'refused', error });
  });

  it('treats "no review needed" as a broken contract, never as leave to save', async () => {
    const world = ports({ ok: true, data: { status: 'not_required' } });
    expect(await prepareReviewWith(world.ports, draft)).toEqual({ kind: 'broken' });
    expect(world.opened).toEqual([]);
    expect(world.forgotten()).toBe(1);
  });
});

describe('the cells a refused save names', () => {
  const grid = model();

  it('are the grid’s own cells: a balance by its month end, income by its occurrence', () => {
    expect(
      refusedCellsOf(grid, {
        [`${BBVA}#2026-03-31`]: ['This account is closed, so its final balance has to stay zero.'],
        [`${SALARY}#2026-04-25`]: ['Use at most 2 decimals for this currency.', 'and more'],
      }),
    ).toEqual(
      new Map([
        [`position:${BBVA}|2026-03`, 'This account is closed, so its final balance has to stay zero.'],
        [`income:${SALARY}|2026-04`, 'Use at most 2 decimals for this currency.'],
      ]),
    );
  });

  it('are none for a refusal that names no cell of this grid', () => {
    expect(refusedCellsOf(grid, undefined).size).toBe(0);
    expect(
      refusedCellsOf(grid, {
        operations: ['Each cell may appear only once in a save.'],
        'pos-elsewhere#2026-03-31': ['Not a column here.'],
        [`${BBVA}#2025-12-31`]: ['Above the first row.'],
        [`${BBVA}#2026-03-31#extra`]: ['Not a cell key.'],
        [`${CAR}#2026-04-30`]: [],
      }).size,
    ).toBe(0);
  });
});

describe('a Bulk History review at scale (ADR 0011 D10)', () => {
  const labels = {
    accounts: { [BBVA]: { name: 'BBVA', currency: 'EUR' } },
    categories: {},
    templates: { [SALARY]: 'Salary' },
    locale: 'en-GB',
  };
  const names = new Map([[BBVA, 'BBVA']]);
  const balance = (month: number, amount: string) => ({
    identity: { scope: 'prospective' as const, kind: 'valuation' as const, role: 'valuation' as const, owner: `${BBVA}#${String(month)}` },
    operation: 'create' as const,
    before: null,
    after: {
      kind: 'valuation' as const,
      positionId: BBVA,
      valuedOn: `2025-${String(month).padStart(2, '0')}-28`,
      amount,
      currency: 'EUR',
      datePrecision: 'month_end' as const,
      note: null,
    },
  });

  const preview = {
    fingerprint: `hc-v1:${'0'.repeat(64)}`,
    sourceScope: [],
    sourcePeriods: ['2025-01', '2025-12'],
    periods: [],
    sourceChanges: [
      ...Array.from({ length: 120 }, (_, index) => balance((index % 12) + 1, String(index))),
      {
        identity: { scope: 'existing' as const, kind: 'income' as const, id: 'inc-1' },
        operation: 'delete' as const,
        before: {
          kind: 'income' as const,
          incomeKind: 'employment',
          receivedOn: '2025-03-27',
          netAmount: '2100',
          grossAmount: null,
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: BBVA,
          description: null,
          templateId: SALARY,
          occurrenceDate: '2025-03-25',
        },
        after: null,
      },
    ],
    structuralChanges: [
      ...Array.from({ length: 100 }, (_, index) => ({
        kind: 'valuation_carry' as const,
        positionId: BBVA,
        before: null,
        after: { from: `2025-01-${String((index % 28) + 1).padStart(2, '0')}`, to: '2025-12-30' },
      })),
      { kind: 'month_status' as const, month: '2025-03', before: 'unavailable' as const, after: 'reliable' as const },
    ],
  } as unknown as CorrectionPreview;

  it('says what the save does in one line, and groups a hundred balances into one per account', () => {
    const summary = summarizeBulk(preview, labels, names);
    expect(summary.headline).toBe('Balances: 120 added · Income: 1 removed · January 2025 – December 2025');
    expect(summary.groups.map((group) => [group.title, group.line])).toEqual([
      ['BBVA', '120 added · balances carry differently from January 2025 to December 2025'],
      ['Salary', '1 removed'],
    ]);
  });

  it('truncates nothing: every record and every carry change is behind its group', () => {
    const summary = summarizeBulk(preview, labels, names);
    expect(summary.groups[0]?.entries).toHaveLength(220);
    expect(summary.groups[1]?.entries).toEqual(['25 Mar 2025 (received 27 Mar 2025) · removed · net 2100 EUR']);
    expect(summary.otherChanges).toEqual([
      { kind: 'month_status', month: '2025-03', before: 'unavailable', after: 'reliable' },
    ]);
  });

  it('spans the carry changes from the earliest start to the latest end, open when one runs on', () => {
    expect(
      carrySpan([
        { kind: 'valuation_carry', positionId: BBVA, before: { from: '2025-03-31', to: '2025-04-29' }, after: null },
        { kind: 'valuation_carry', positionId: BBVA, before: null, after: { from: '2025-02-28', to: null } },
      ]),
    ).toEqual({ from: '2025-02-28', to: null });
  });
});

describe('a derived zero (ADR 0011 D4)', () => {
  const grid = gridModelOf(
    page({
      columns: [
        {
          kind: 'position',
          positionId: BBVA,
          positionKind: 'cash',
          name: 'BBVA',
          currency: 'EUR',
          status: 'closed',
          segments: [
            { from: '2026-01', through: '2026-03', cell: { kind: 'derived_zero', reason: 'dormant' } },
            { from: '2026-04', through: '2026-04', cell: { kind: 'derived_zero', reason: 'closed' } },
            { from: '2026-05', through: '2026-05', cell: { kind: 'unavailable', reason: 'closed' } },
          ],
        },
      ],
    }),
    'en-GB',
  );
  const bbva = grid.columns[0];
  if (bbva === undefined) throw new Error('column');

  it('takes a figure over a dormant zero, as a new balance', () => {
    const typed = typeInto(grid, NO_EDITS, bbva, '2026-02', '10');
    expect(typed.ok && operations(grid, typed.edits)).toEqual([
      { kind: 'valuation_create', positionId: BBVA, month: '2026-02', amount: '10' },
    ]);
  });

  it('never takes one over a closed zero, typed or pasted, even on the closing month itself', () => {
    expect(typeInto(grid, NO_EDITS, bbva, '2026-04', '10').ok).toBe(false);
    const pasted = pasteInto(grid, NO_EDITS, { row: 3, column: 0 }, '10');
    expect(pasted.ok).toBe(false);
    if (!pasted.ok) expect(pasted.message).toMatch(/BBVA, April 2026 cannot be edited/u);
    expect(nextEditable(grid, { row: 2, column: 0 }, 'down')).toBeNull();
  });
});

describe('a closed account’s closing balance (ADR 0011 D4)', () => {
  // The server never removes the balance dated on the closing day while the
  // account is closed (M6); the grid says so before asking it.
  const grid = gridModelOf(
    page({
      columns: [
        {
          kind: 'position',
          positionId: BBVA,
          positionKind: 'cash',
          name: 'BBVA',
          currency: 'EUR',
          status: 'closed',
          segments: [
            {
              from: '2026-01',
              through: '2026-01',
              cell: { kind: 'stored', valuationId: 'val-jan', version: 1, amount: '0', source: 'entered', clearable: false },
            },
            { from: '2026-02', through: '2026-05', cell: { kind: 'unavailable', reason: 'closed' } },
          ],
        },
      ],
    }),
    'en-GB',
  );
  const bbva = grid.columns[0];
  if (bbva === undefined) throw new Error('column');

  it('is refused when emptied by hand, in these words, and nothing is drafted', () => {
    const typed = typeInto(grid, NO_EDITS, bbva, '2026-01', '');
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    expect(outcomesOf(grid, typed.edits).map((item) => item.outcome)).toEqual([
      { kind: 'invalid', message: 'This is the closing balance of a closed account, so it cannot be removed.' },
    ]);
    expect(draftOf(grid, typed.edits)).toEqual({ ok: false, invalid: 1 });
  });
});

describe('a dormant account woken by income cells alone', () => {
  const SAVINGS = 'pos-savings';
  const preview = {
    fingerprint: `hc-v1:${'0'.repeat(64)}`,
    sourceScope: [],
    sourcePeriods: ['2025-03'],
    periods: [],
    sourceChanges: [
      {
        identity: { scope: 'prospective', kind: 'income', role: 'occurrence', owner: `${SALARY}#2025-03-25` },
        operation: 'create',
        before: null,
        after: {
          kind: 'income',
          incomeKind: 'employment',
          receivedOn: '2025-03-25',
          netAmount: '2100',
          grossAmount: null,
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: SAVINGS,
          description: null,
          templateId: SALARY,
          occurrenceDate: '2025-03-25',
        },
      },
    ],
    structuralChanges: [{ kind: 'dormancy_episode', positionId: SAVINGS, before: '2025-01-31', after: null }],
  } as unknown as CorrectionPreview;
  const labels = {
    accounts: { [SAVINGS]: { name: 'Savings', currency: 'EUR' } },
    categories: {},
    templates: { [SALARY]: 'Salary' },
    locale: 'en-GB',
  };

  it('shows the wake on the account’s own line, before anything is expanded', () => {
    const summary = summarizeBulk(preview, labels, new Map([[SAVINGS, 'Savings']]));
    expect(summary.groups.map((group) => [group.title, group.line])).toEqual([
      ['Savings', 'no longer dormant'],
      ['Salary', '1 added'],
    ]);
    expect(summary.groups[0]?.entries).toEqual([
      'Savings is no longer dormant from 31 Jan 2025, so those months stop carrying it at zero.',
    ]);
    expect(summary.otherChanges).toEqual([]);
  });

  it('keeps a wake on an account that also has balances in the save on that account’s line', () => {
    const mixed = {
      ...preview,
      sourceChanges: [
        ...preview.sourceChanges,
        {
          identity: { scope: 'prospective', kind: 'valuation', role: 'valuation', owner: `${SAVINGS}#2025-03-31` },
          operation: 'create',
          before: null,
          after: {
            kind: 'valuation',
            positionId: SAVINGS,
            valuedOn: '2025-03-31',
            amount: '5',
            currency: 'EUR',
            datePrecision: 'month_end',
            note: null,
          },
        },
      ],
    } as unknown as CorrectionPreview;
    const summary = summarizeBulk(mixed, labels, new Map([[SAVINGS, 'Savings']]));
    expect(summary.groups[0]?.line).toBe('1 added · no longer dormant');
    expect(summary.groups.filter((group) => group.title === 'Savings')).toHaveLength(1);
  });
});

describe('when nothing is left unsaved', () => {
  const grid = model();
  const bbva = `position:${BBVA}`;

  it('forgets an edit retyped back to the stored figure, leaving nothing unsaved', () => {
    const changedThenBack = typed(grid, [[bbva, '2026-02', '1001'], [bbva, '2026-02', '1000.00']]);
    expect(changedThenBack.size).toBe(0);
  });

  it('forgets the last edit undone with Escape', () => {
    const one = typed(grid, [[bbva, '2026-01', '5']]);
    expect(one.size).toBe(1);
    expect(revertCell(one, bbva, '2026-01').size).toBe(0);
  });
});

describe('which links leave the grid', () => {
  const here = 'https://vaultide.app/monthly/2026-06/history';

  it('asks about any same-origin page opened in this tab', () => {
    expect(leavesThisPage('/monthly/2026-06', '', here)).toBe(true);
    expect(leavesThisPage('https://vaultide.app/accounts', '_self', here)).toBe(true);
    expect(leavesThisPage('/monthly/2026-06#account-x', '', here)).toBe(true);
    expect(leavesThisPage('/monthly/2025-06/history', '', here)).toBe(true);
  });

  it('leaves alone an anchor on this page, another site, and a new tab', () => {
    expect(leavesThisPage('#accounts', '', here)).toBe(false);
    expect(leavesThisPage('https://example.com/', '', here)).toBe(false);
    expect(leavesThisPage('/accounts', '_blank', here)).toBe(false);
  });
});
