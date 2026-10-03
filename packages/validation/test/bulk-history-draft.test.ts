import { describe, expect, it } from 'vitest';
import { bulkHistoryInput, correctionInput } from '../src/index';

/**
 * The Bulk History draft (blueprint 15.3, 20.1; ADR 0011 D2, D4).
 *
 * Intent only: the cells the grid changed, the values typed, and the version
 * of every stored row changed or cleared. Everything the server owns is
 * refused rather than stripped, because a grid never sends it.
 */

const TODAY = '2026-10-05';
const BBVA = '62626262-6262-4262-8262-626262626262';
const ROW = '63636363-6363-4363-8363-636363636363';
const SALARY = '64646464-6464-4464-8464-646464646464';
const ENTRY = '65656565-6565-4565-8565-656565656565';

const parse = (draft: unknown) => correctionInput.previewCorrectionInput(TODAY).safeParse({ draft });
const bulk = (operations: unknown[], startMonth = '2026-01') =>
  parse({ kind: 'bulk_history', startMonth, operations });

const create = (month: string, amount = '1') => ({
  kind: 'valuation_create',
  positionId: BBVA,
  month,
  amount,
});

describe('a Bulk History draft', () => {
  it('carries every operation the grid can produce', () => {
    const parsed = bulk([
      create('2026-02', '-12.5'),
      { kind: 'valuation_update', positionId: BBVA, month: '2026-03', valuationId: ROW, expectedVersion: 2, amount: '0' },
      { kind: 'valuation_clear', positionId: BBVA, month: '2026-04', valuationId: ROW, expectedVersion: 2 },
      { kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-02-25', netAmount: '2100' },
      {
        kind: 'income_update',
        templateId: SALARY,
        occurrenceDate: '2026-03-25',
        entryId: ENTRY,
        expectedVersion: 1,
        netAmount: '2100.5',
      },
      { kind: 'income_clear', templateId: SALARY, occurrenceDate: '2026-04-25', entryId: ENTRY, expectedVersion: 1 },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('refuses a server-owned fact or a version on a create, rather than stripping it', () => {
    expect(bulk([{ ...create('2026-02'), source: 'entered' }]).success).toBe(false);
    expect(bulk([{ ...create('2026-02'), expectedVersion: 1 }]).success).toBe(false);
    expect(
      bulk([
        {
          kind: 'income_create',
          templateId: SALARY,
          occurrenceDate: '2026-02-25',
          netAmount: '1',
          grossAmount: '2',
        },
      ]).success,
    ).toBe(false);
    expect(bulk([{ kind: 'valuation_clear', positionId: BBVA, month: '2026-04', valuationId: ROW }]).success).toBe(
      false,
    );
  });

  it('holds every cell to a completed month at or after the first row', () => {
    expect(bulk([create('2026-10')]).success).toBe(false);
    expect(bulk([create('2025-12')]).success).toBe(false);
    expect(bulk([create('2026-02')], '2026-10').success).toBe(false);
    expect(
      bulk([{ kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-10-01', netAmount: '1' }]).success,
    ).toBe(false);
  });

  it('takes canonical amounts only', () => {
    for (const amount of ['1.50', '01', '-0', '1.', '1,5', '+1']) {
      expect(bulk([create('2026-02', amount)]).success, amount).toBe(false);
    }
    for (const amount of ['0', '-1', '1234.56', '0.00000001']) {
      expect(bulk([create('2026-02', amount)]).success, amount).toBe(true);
    }
    expect(
      bulk([{ kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-02-25', netAmount: '-1' }]).success,
    ).toBe(false);
  });

  it('refuses a cell named twice instead of choosing one', () => {
    expect(bulk([create('2026-02'), create('2026-02', '2')]).success).toBe(false);
    expect(
      bulk([
        { kind: 'income_create', templateId: SALARY, occurrenceDate: '2026-02-25', netAmount: '1' },
        { kind: 'income_clear', templateId: SALARY, occurrenceDate: '2026-02-25', entryId: ENTRY, expectedVersion: 1 },
      ]).success,
    ).toBe(false);
  });

  it('holds a save to the per-save limit exactly', () => {
    const months = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        create(`${String(1960 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`),
      );
    expect(bulk(months(bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS), '1960-01').success).toBe(true);
    expect(bulk(months(bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS + 1), '1960-01').success).toBe(false);
    expect(bulk([]).success).toBe(false);
  });

  it('names one cell by its account and month end, or its source and occurrence', () => {
    expect(bulkHistoryInput.bulkCellKey({ kind: 'valuation_create', positionId: BBVA, month: '2026-02', amount: '1' })).toBe(
      `${BBVA}#2026-02-28`,
    );
    expect(
      bulkHistoryInput.bulkCellKey({
        kind: 'income_clear',
        templateId: SALARY,
        occurrenceDate: '2026-02-25',
        entryId: ENTRY,
        expectedVersion: 1,
      }),
    ).toBe(`${SALARY}#2026-02-25`);
  });
});
