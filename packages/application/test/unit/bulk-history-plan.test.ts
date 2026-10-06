import { describe, expect, it } from 'vitest';
import { plainDate } from '@vaultide/finance';
import type {
  IncomeEntryRow,
  PositionRecord as PositionRow,
  RecurringTemplateRow,
  RecurringTemplateTermRow,
  ValuationRow,
} from '@vaultide/db';
import { bulkHistoryInput } from '@vaultide/validation';
import type { BulkHistoryDraft, BulkHistoryOperation } from '../../src/corrections/draft';
import { DomainError } from '../../src/errors';
import { identityKey } from '../../src/write-plan';
import {
  bulkClosedBoundsOf,
  bulkIncomeGross,
  compareBulkOperations,
  decideBulkHistory,
  mergeBulkDormancy,
  prepareBulkHistory,
  type BulkHistoryEvidence,
} from '../../src/bulk-history/plan';

/**
 * A Bulk History save, decided (blueprint 15.3, 18.1, 20.3, 30.22 item 2;
 * ADR 0011).
 *
 * Every cell goes through the decision its ordinary path uses, so those rules
 * are proved where they live. What is proved here is what a **batch** adds:
 * the draft's own rules, the canonical order, the gross a new occurrence
 * inherits, and the plan's aggregate facts — one dormancy consequence per
 * account, merged support, a truthful `revision` and one identity per change.
 *
 * `today` is 5 October 2026.
 */

const TODAY = plainDate('2026-10-05');
const CREATED = new Date('2026-01-01T00:00:00Z');

const cash = (overrides: Partial<PositionRow> = {}): PositionRow => ({
  id: 'pos-cash',
  userId: 'user-1',
  kind: 'cash',
  name: 'BBVA',
  currency: 'EUR',
  status: 'active',
  openedOn: null,
  closedOn: null,
  notes: null,
  sortOrder: 0,
  version: 1,
  createdAt: CREATED,
  accountType: 'checking',
  institution: null,
  isDormant: false,
  dormantFrom: null,
  ...overrides,
});

const balance = (overrides: Partial<ValuationRow> = {}): ValuationRow => ({
  id: 'val-1',
  userId: 'user-1',
  positionId: 'pos-cash',
  valuedOn: '2026-08-31',
  amount: '100.00000000',
  source: 'entered',
  datePrecision: 'month_end',
  note: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 3,
  ...overrides,
});

const template = (overrides: Partial<RecurringTemplateRow> = {}): RecurringTemplateRow => ({
  id: 'tpl-1',
  userId: 'user-1',
  kind: 'income',
  name: 'Salary',
  counterparty: null,
  incomeKind: 'employment',
  categoryId: null,
  currency: 'EUR',
  frequency: 'monthly',
  dayOfMonth: 25,
  startDate: '2026-01-25',
  endDate: null,
  cashPositionId: 'pos-cash',
  cashPositionKind: 'cash',
  propertyPositionId: null,
  propertyPositionKind: null,
  targetInvestmentPositionId: null,
  targetInvestmentPositionKind: null,
  archivedAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 1,
  ...overrides,
});

const term = (effectiveFrom: string, amount: string, grossAmount: string | null): RecurringTemplateTermRow => ({
  id: `term-${effectiveFrom}`,
  userId: 'user-1',
  templateId: 'tpl-1',
  effectiveFrom,
  amount,
  grossAmount,
  note: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 1,
});

const entry = (overrides: Partial<IncomeEntryRow> = {}): IncomeEntryRow => ({
  id: 'inc-1',
  userId: 'user-1',
  templateId: 'tpl-1',
  occurrenceDate: '2026-07-25',
  kind: 'employment',
  receivedOn: '2026-07-25',
  netAmount: '2100.00000000',
  grossAmount: '3000.00000000',
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-cash',
  cashPositionKind: 'cash',
  propertyPositionId: null,
  propertyPositionKind: null,
  investmentPositionId: null,
  investmentPositionKind: null,
  description: null,
  tags: [],
  isOneOff: false,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 2,
  ...overrides,
});

const draftOf = (operations: BulkHistoryOperation[], startMonth = '2026-01'): BulkHistoryDraft => ({
  kind: 'bulk_history',
  startMonth,
  operations,
});

const evidence = (overrides: Partial<BulkHistoryEvidence> = {}): BulkHistoryEvidence => ({
  positions: [cash()],
  valuations: [],
  occupants: [],
  entries: [],
  templates: [template()],
  terms: [term('2026-01-25', '2100', '3000')],
  skips: [],
  materialized: [],
  finals: [],
  ...overrides,
});

const decide = (operations: BulkHistoryOperation[], loaded = evidence()) =>
  decideBulkHistory(TODAY, prepareBulkHistory(TODAY, draftOf(operations)), loaded);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'none';
}

/* -------------------------------------------------------------------------- */

describe('the draft’s own rules, asked again on the server', () => {
  const create = (month: string, amount = '1'): BulkHistoryOperation => ({
    kind: 'valuation_create',
    positionId: 'pos-cash',
    month,
    amount,
  });

  it('accepts exactly the per-save limit, and refuses one more', () => {
    const at = Array.from({ length: bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS }, (_, index) =>
      create(`${String(1960 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`),
    );
    expect(prepareBulkHistory(TODAY, draftOf(at, '1960-01')).operations).toHaveLength(at.length);
    expect(
      codeOf(() => prepareBulkHistory(TODAY, draftOf([...at, create('2026-09')], '1960-01'))),
    ).toBe('VALIDATION_ERROR');
  });

  it('refuses a cell named twice, never choosing one', () => {
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([create('2026-03'), create('2026-03', '2')])))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('refuses the current month, a row above the first, an empty save and a non-canonical amount', () => {
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([create('2026-10')])))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([create('2025-12')])))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([])))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([create('2026-03', '1.50')])))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => prepareBulkHistory(TODAY, draftOf([create('2026-03')], '2026-10')))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('puts the cells in one canonical order whatever order they arrive in', () => {
    const operations: BulkHistoryOperation[] = [
      { kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '1' },
      create('2026-03'),
      { kind: 'valuation_create', positionId: 'pos-a', month: '2026-03', amount: '1' },
      create('2026-01'),
    ];
    const forward = prepareBulkHistory(TODAY, draftOf(operations)).operations;
    const backward = prepareBulkHistory(TODAY, draftOf([...operations].reverse())).operations;
    expect(backward).toEqual(forward);
    expect(forward.map((operation) => operation.kind)).toEqual([
      'valuation_create',
      'valuation_create',
      'valuation_create',
      'income_create',
    ]);
    expect([...forward].sort(compareBulkOperations)).toEqual(forward);
  });
});

describe('the gross a new occurrence inherits (ADR 0011 D6)', () => {
  const terms = [term('2026-01-25', '2100', '3000'), term('2026-06-25', '2200', null)];

  it('comes with the term’s exact net, compared as a decimal', () => {
    expect(bulkIncomeGross(terms, '2026-03-25', '2100')).toBe('3000');
    expect(bulkIncomeGross(terms, '2026-03-25', '2100.00000000')).toBe('3000');
  });

  it('is absent for any other net, and for a term with no gross', () => {
    expect(bulkIncomeGross(terms, '2026-03-25', '2100.01')).toBeNull();
    expect(bulkIncomeGross(terms, '2026-07-25', '2200')).toBeNull();
    expect(bulkIncomeGross([], '2026-07-25', '2200')).toBeNull();
  });

  it('follows the term of the scheduled date', () => {
    expect(bulkIncomeGross(terms, '2026-06-24', '2100')).toBe('3000');
    expect(bulkIncomeGross(terms, '2026-06-25', '2100')).toBeNull();
  });
});

describe('the plan of a batch', () => {
  it('composes a mixed batch in canonical order, with one identity per change', () => {
    const plan = decide(
      [
        { kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '2100' },
        {
          kind: 'valuation_update',
          positionId: 'pos-cash',
          month: '2026-08',
          valuationId: 'val-1',
          expectedVersion: 3,
          amount: '150',
        },
        { kind: 'valuation_create', positionId: 'pos-cash', month: '2026-03', amount: '50' },
        {
          kind: 'income_clear',
          templateId: 'tpl-1',
          occurrenceDate: '2026-07-25',
          entryId: 'inc-1',
          expectedVersion: 2,
        },
      ],
      evidence({ valuations: [balance()], entries: [entry()] }),
    );

    expect(plan.steps.map((step) => `${step.family}:${step.operation.kind}`)).toEqual([
      'valuation:valuation_create',
      'valuation:valuation_update',
      'income:income_create',
      'income:income_clear',
    ]);
    expect(plan.changes.map((change) => identityKey(change.identity))).toEqual([
      'prospective:valuation:valuation:pos-cash#2026-03-31',
      'existing:valuation:val-1',
      'prospective:income:occurrence:tpl-1#2026-02-25',
      'existing:income:inc-1',
    ]);
    expect(plan.revision).toBe(true);
    expect(plan.support).toEqual([{ currency: 'EUR', from: '2026-02-25' }]);
  });

  it('keeps the update to the amount alone, and the gross to the D6 rule', () => {
    const plan = decide(
      [
        {
          kind: 'valuation_update',
          positionId: 'pos-cash',
          month: '2026-08',
          valuationId: 'val-1',
          expectedVersion: 3,
          amount: '150',
        },
        { kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '2100' },
      ],
      evidence({ valuations: [balance({ note: 'paper', source: 'confirmed_unchanged' })] }),
    );
    expect(plan.changes[0]).toMatchObject({
      operation: 'update',
      after: { valuedOn: '2026-08-31', datePrecision: 'month_end', note: 'paper', amount: '150' },
    });
    expect(plan.changes[1]).toMatchObject({
      operation: 'create',
      after: { grossAmount: '3000', receivedOn: '2026-02-25', settlement: 'tracked_cash', cashPositionId: 'pos-cash' },
    });
  });

  it('says a create-only batch is not a revision, and still has nothing else to hide', () => {
    const plan = decide([{ kind: 'valuation_create', positionId: 'pos-cash', month: '2026-03', amount: '50' }]);
    expect(plan.revision).toBe(false);
    expect(plan.dormancy).toEqual([]);
  });

  it('wakes a dormant account once, however many of its cells change', () => {
    const plan = decide(
      [
        { kind: 'valuation_create', positionId: 'pos-cash', month: '2026-05', amount: '10' },
        { kind: 'valuation_create', positionId: 'pos-cash', month: '2026-06', amount: '20' },
        { kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-06-25', netAmount: '1' },
      ],
      evidence({ positions: [cash({ isDormant: true, dormantFrom: '2026-03-31' })] }),
    );
    expect(plan.dormancy).toEqual([
      {
        positionId: 'pos-cash',
        before: { isDormant: true, dormantFrom: '2026-03-31' },
        after: { isDormant: false, dormantFrom: null },
        via: 'clear',
      },
    ]);
    expect(plan.changes.filter((change) => change.identity.kind === 'cash_dormancy')).toHaveLength(1);
    expect(plan.support).toEqual([{ currency: 'EUR', from: '2026-05-31' }]);
  });

  it('refuses two different dormancy consequences for one account as an internal fault', () => {
    expect(() =>
      mergeBulkDormancy([
        {
          positionId: 'pos-cash',
          before: { isDormant: true, dormantFrom: '2026-03-31' },
          after: { isDormant: false, dormantFrom: null },
          via: 'clear',
        },
        {
          positionId: 'pos-cash',
          before: { isDormant: true, dormantFrom: '2026-04-30' },
          after: { isDormant: false, dormantFrom: null },
          via: 'clear',
        },
      ]),
    ).toThrow(/conflicting dormancy evidence/u);
  });

  it('keys "already recorded" by occurrence: another occurrence’s row never answers', () => {
    const loaded = evidence({ materialized: [{ templateId: 'tpl-1', occurrenceDate: '2026-07-25' }] });
    expect(
      decide(
        [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-08-25', netAmount: '1' }],
        loaded,
      ).steps,
    ).toHaveLength(1);
    expect(
      codeOf(() =>
        decide(
          [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-07-25', netAmount: '1' }],
          loaded,
        ),
      ),
    ).toBe('CONFLICT_DUPLICATE');
  });

  it('answers a moved row as a conflict before asking whether it is the cell', () => {
    const moved = evidence({ valuations: [balance({ version: 4, valuedOn: '2026-07-31' })] });
    expect(
      codeOf(() =>
        decide(
          [
            {
              kind: 'valuation_clear',
              positionId: 'pos-cash',
              month: '2026-08',
              valuationId: 'val-1',
              expectedVersion: 3,
            },
          ],
          moved,
        ),
      ),
    ).toBe('CONFLICT_VERSION');
  });

  it('refuses a position of a kind this grid does not edit', () => {
    expect(
      codeOf(() =>
        decide(
          [{ kind: 'valuation_create', positionId: 'pos-cash', month: '2026-03', amount: '1' }],
          evidence({ positions: [cash({ kind: 'investment' })] }),
        ),
      ),
    ).toBe('VALIDATION_ERROR');
  });

  it('refuses an expense source’s occurrence as an income cell', () => {
    expect(
      codeOf(() =>
        decide(
          [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '1' }],
          evidence({ templates: [template({ kind: 'expense', incomeKind: null, categoryId: 'cat-1' })] }),
        ),
      ),
    ).toBe('VALIDATION_ERROR');
  });

  it('judges a source with no account against the bucket of the occurrence’s month', () => {
    const unattributed = evidence({ templates: [template({ cashPositionId: null })] });
    const plan = decide(
      [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '1' }],
      unattributed,
    );
    expect(plan.changes[0]).toMatchObject({ after: { cashPositionId: null, settlement: 'tracked_cash' } });

    expect(
      codeOf(() =>
        decide(
          [{ kind: 'income_create', templateId: 'tpl-1', occurrenceDate: '2026-02-25', netAmount: '1' }],
          { ...unattributed, positions: [cash({ currency: 'USD' })] },
        ),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});

describe('a closed account’s final balance, judged on the batch (M6, 5.2)', () => {
  // Closed on 15 September with zero statements for July and August.
  const closed = cash({ name: 'Old savings', status: 'closed', closedOn: '2026-09-15' });
  const july = balance({ id: 'val-jul', valuedOn: '2026-07-31', amount: '0.00000000' });
  const august = balance({ id: 'val-aug', valuedOn: '2026-08-31', amount: '0.00000000' });

  const raiseJuly: BulkHistoryOperation = {
    kind: 'valuation_update',
    positionId: 'pos-cash',
    month: '2026-07',
    valuationId: 'val-jul',
    expectedVersion: 3,
    amount: '300',
  };
  const clearAugust: BulkHistoryOperation = {
    kind: 'valuation_clear',
    positionId: 'pos-cash',
    month: '2026-08',
    valuationId: 'val-aug',
    expectedVersion: 3,
  };
  const loaded = (finals: ValuationRow[]) =>
    evidence({ positions: [closed], valuations: [july, august], finals });

  function refusal(run: () => unknown): { message: string; fieldErrors: unknown } {
    try {
      run();
    } catch (error) {
      if (error instanceof DomainError && error.code === 'VALIDATION_ERROR') {
        return { message: error.message, fieldErrors: error.fieldErrors };
      }
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it('reads only for the closed accounts a balance cell names', () => {
    const request = prepareBulkHistory(TODAY, draftOf([raiseJuly]));
    expect(bulkClosedBoundsOf(request, [closed, cash({ id: 'pos-other', status: 'closed', closedOn: '2026-01-31' })])).toEqual([
      { positionId: 'pos-cash', onOrBefore: '2026-09-15' },
    ]);
    expect(bulkClosedBoundsOf(request, [cash()])).toEqual([]);
  });

  it('accepts each of two cells that leave a zero standing on its own', () => {
    expect(decide([raiseJuly], loaded([august])).steps).toHaveLength(1);
    expect(decide([clearAugust], loaded([july])).steps).toHaveLength(1);
  });

  it('refuses the two together, naming the cell whose figure would be final', () => {
    expect(refusal(() => decide([clearAugust, raiseJuly], loaded([])))).toEqual({
      message:
        'Old savings, July 2026: the account is closed, so its final balance has to stay zero. Nothing was saved.',
      fieldErrors: { 'pos-cash#2026-07-31': ['This account is closed, so its final balance has to stay zero.'] },
    });
  });

  it('names the cell that uncovered an earlier figure when no cell of the batch is final', () => {
    const raised = balance({ id: 'val-jul', valuedOn: '2026-07-31', amount: '300.00000000' });
    expect(refusal(() => decide([clearAugust], loaded([raised])))).toMatchObject({
      message: expect.stringMatching(/^Old savings, August 2026: /u) as unknown,
      fieldErrors: { 'pos-cash#2026-08-31': expect.any(Array) as unknown },
    });
  });

  it('asks nothing of an active account', () => {
    expect(
      decide([clearAugust, raiseJuly], evidence({ positions: [cash()], valuations: [july, august] })).steps,
    ).toHaveLength(2);
  });
});
