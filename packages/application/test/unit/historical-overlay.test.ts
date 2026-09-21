import { describe, expect, it } from 'vitest';
import { Decimal, currencyCode, plainDate } from '@vaultide/finance';
import {
  candidatePeriods,
  completedInputOf,
  monthToDateInputOf,
  overlayCorrection,
  type CorrectionEvidence,
} from '../../src/corrections/evidence';
import { monthKeyOfPeriod } from '../../src/corrections/classify';
import {
  created,
  deleted,
  dormancyChange,
  identityKey,
  updated,
  type DormancyEffect,
  type IdentifiedSourceChange,
  type ResolvedWrite,
} from '../../src/write-plan';

/**
 * The in-memory overlay, and the window it runs over (§32, §33, §89 of the
 * slice prompt).
 *
 * Two claims, both structural rather than arithmetic:
 *
 *  - **the overlay produces the AFTER world without writing anything.** Every
 *    operation — update, delete, create, a transfer's fee appearing or
 *    vanishing, a dormant episode starting or ending, a balance moving date —
 *    is a rearrangement of the loaded evidence. There is no savepoint, no
 *    temporary row and nothing to roll back, because the preview transaction is
 *    read only;
 *  - **the candidate window is the correction's own reach.** A flow changes its
 *    own month. A balance and a dormant episode reach forward, because one is
 *    opening evidence for the months after it and the other is open-ended.
 */

const TODAY = plainDate('2026-09-15');

const position = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    kind: 'cash' as const,
    name: id,
    currency: currencyCode('EUR'),
    status: 'active' as const,
    openedOn: null,
    closedOn: null,
    ...overrides,
  });

function evidence(overrides: Partial<CorrectionEvidence> = {}): CorrectionEvidence {
  return {
    today: TODAY,
    positions: [position('pos-1')],
    valuations: new Map([
      [
        'pos-1',
        [
          {
            id: 'val-jul',
            positionId: 'pos-1',
            valuedOn: plainDate('2026-07-31'),
            amount: new Decimal('1000'),
            source: 'entered',
            datePrecision: 'month_end',
          },
          {
            id: 'val-aug',
            positionId: 'pos-1',
            valuedOn: plainDate('2026-08-31'),
            amount: new Decimal('900'),
            source: 'entered',
            datePrecision: 'month_end',
          },
        ],
      ],
    ]),
    accountTypes: new Map([['pos-1', 'checking']]),
    income: [
      {
        id: 'inc-1',
        kind: 'employment',
        receivedOn: plainDate('2026-08-25'),
        netAmount: new Decimal('2500'),
        currency: currencyCode('EUR'),
        settlement: 'tracked_cash',
        cashPositionId: 'pos-1',
        investmentPositionId: null,
      },
    ],
    expenses: [],
    categoryIds: new Map(),
    transfers: [],
    templates: [],
    resolvedOccurrences: [{ templateId: 'tpl-1', occurrenceDate: '2026-08-25' }],
    countAdditionalSpending: true,
    ...overrides,
  };
}

const incomeFacts = (receivedOn: string, netAmount: string, occurrence = true) =>
  ({
    kind: 'income' as const,
    incomeKind: 'employment',
    receivedOn,
    netAmount,
    grossAmount: null,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: 'pos-1',
    description: null,
    templateId: occurrence ? 'tpl-1' : null,
    occurrenceDate: occurrence ? '2026-08-25' : null,
  });

const valuationFacts = (valuedOn: string, amount: string) =>
  ({
    kind: 'valuation' as const,
    positionId: 'pos-1',
    valuedOn,
    amount,
    currency: 'EUR',
    datePrecision: 'month_end' as const,
    note: null,
  });

const existingIncome = { scope: 'existing', kind: 'income', id: 'inc-1' } as const;
const existingValuation = { scope: 'existing', kind: 'valuation', id: 'val-aug' } as const;
const prospectiveFee = {
  scope: 'prospective',
  kind: 'expense',
  role: 'transfer_fee',
  owner: 'tr-1',
} as const;

function write(
  changes: readonly IdentifiedSourceChange[],
  dormancy: readonly DormancyEffect[] = [],
): ResolvedWrite {
  return { revision: true, changes, dormancy, support: [] };
}

const augustInput = (state: CorrectionEvidence) =>
  completedInputOf(state, monthKeyOfPeriod('2026-08'));

describe('the overlay', () => {
  it('replaces an existing row by its real database id', () => {
    const before = evidence();
    const after = overlayCorrection(
      before,
      write([updated(existingIncome, incomeFacts('2026-08-25', '2500'), incomeFacts('2026-08-25', '2600'))]),
    );

    expect(after.income).toHaveLength(1);
    expect(after.income[0]?.id).toBe('inc-1');
    expect(after.income[0]?.netAmount.toString()).toBe('2600');
    // The loaded evidence is untouched: BEFORE and AFTER are two views of it.
    expect(before.income[0]?.netAmount.toString()).toBe('2500');
  });

  it('removes a deleted row, and the occurrence it fulfilled becomes due again', () => {
    const after = overlayCorrection(
      evidence(),
      write([deleted(existingIncome, incomeFacts('2026-08-25', '2500'))]),
    );
    expect(after.income).toEqual([]);
    expect(after.resolvedOccurrences).toEqual([]);
  });

  it('adds a created row under its deterministic semantic identity', () => {
    const after = overlayCorrection(
      evidence(),
      write([
        created(prospectiveFee, {
          kind: 'expense',
          categoryId: 'cat-fee',
          categoryKind: 'transfer_fee',
          incurredOn: '2026-08-31',
          amount: '1.50',
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: 'pos-1',
          description: null,
          transferId: 'tr-1',
          templateId: null,
          occurrenceDate: null,
        }),
      ]),
    );

    expect(after.expenses).toHaveLength(1);
    expect(after.expenses[0]?.id).toBe(identityKey(prospectiveFee));
    expect(after.expenses[0]?.id).toBe('prospective:expense:transfer_fee:tr-1');
    // Never a UUID the commit could not reproduce.
    expect(after.expenses[0]?.id).not.toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('marks a created occurrence as resolved, so its month stops expecting it', () => {
    const empty = evidence({ income: [], resolvedOccurrences: [] });
    const after = overlayCorrection(
      empty,
      write([created({ scope: 'prospective', kind: 'income', role: 'occurrence', owner: 'tpl-1#2026-08-25' }, incomeFacts('2026-08-25', '2500'))]),
    );
    expect(after.resolvedOccurrences).toEqual([
      { templateId: 'tpl-1', occurrenceDate: '2026-08-25' },
    ]);
  });

  it('moves a balance out of the date it had and into the date it will have', () => {
    const after = overlayCorrection(
      evidence(),
      write([
        updated(existingValuation, valuationFacts('2026-08-31', '900'), valuationFacts('2026-09-30', '900')),
      ]),
    );
    const dates = (after.valuations.get('pos-1') ?? []).map((row) => row.valuedOn as string);
    expect(dates).toEqual(['2026-07-31', '2026-09-30']);
  });

  it('removes a deleted balance and leaves the others in date order', () => {
    const after = overlayCorrection(
      evidence(),
      write([deleted(existingValuation, valuationFacts('2026-08-31', '900'))]),
    );
    expect((after.valuations.get('pos-1') ?? []).map((row) => row.valuedOn as string)).toEqual([
      '2026-07-31',
    ]);
  });

  it('starts and ends a dormant episode on the position itself', () => {
    const start: DormancyEffect = {
      positionId: 'pos-1',
      before: { isDormant: false, dormantFrom: null },
      after: { isDormant: true, dormantFrom: '2026-07-31' },
      via: 'account_update',
    };
    const started = overlayCorrection(evidence(), write([dormancyChange(start)], [start]));
    expect(started.positions[0]).toMatchObject({ isDormant: true, dormantFrom: '2026-07-31' });

    const end: DormancyEffect = {
      positionId: 'pos-1',
      before: { isDormant: true, dormantFrom: '2026-07-31' },
      after: { isDormant: false, dormantFrom: null },
      via: 'clear',
    };
    const ended = overlayCorrection(started, write([dormancyChange(end)], [end]));
    expect(ended.positions[0]?.isDormant).toBe(false);
    // Absent, not null: the engines read the field's presence (8.8, 30.20).
    expect(ended.positions[0]).not.toHaveProperty('dormantFrom');
  });

  it('moves a flow between months, so one month loses it and the other gains it', () => {
    const after = overlayCorrection(
      evidence(),
      write([
        updated(existingIncome, incomeFacts('2026-08-25', '2500'), incomeFacts('2026-09-05', '2500')),
      ]),
    );
    expect(augustInput(after).income).toEqual([]);
    expect(monthToDateInputOf(after).income).toHaveLength(1);
    expect(augustInput(evidence()).income).toHaveLength(1);
  });
});

describe('the candidate window (§32)', () => {
  it('is the flow’s own month when only flows move', () => {
    expect(
      candidatePeriods(
        write([updated(existingIncome, incomeFacts('2026-08-25', '2500'), incomeFacts('2026-08-26', '2500'))]),
        TODAY,
      ),
    ).toEqual(['2026-08']);
  });

  it('spans both months when a flow moves between them', () => {
    expect(
      candidatePeriods(
        write([updated(existingIncome, incomeFacts('2026-07-25', '2500'), incomeFacts('2026-09-05', '2500'))]),
        TODAY,
      ),
    ).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('includes the scheduled occurrence’s month, which may not be the money’s', () => {
    const facts = {
      ...incomeFacts('2026-09-02', '2500'),
      templateId: 'tpl-1',
      occurrenceDate: '2026-08-25',
    };
    expect(candidatePeriods(write([deleted(existingIncome, facts)]), TODAY)).toEqual([
      '2026-08',
      '2026-09',
    ]);
  });

  it('reaches forward to the current month for a balance, which is later months’ opening', () => {
    expect(
      candidatePeriods(
        write([updated(existingValuation, valuationFacts('2026-06-30', '900'), valuationFacts('2026-06-30', '800'))]),
        TODAY,
      ),
    ).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
  });

  it('reaches forward for a dormant episode, which is open-ended until something wakes it', () => {
    const effect: DormancyEffect = {
      positionId: 'pos-1',
      before: { isDormant: true, dormantFrom: '2026-07-31' },
      after: { isDormant: false, dormantFrom: null },
      via: 'clear',
    };
    expect(candidatePeriods(write([dormancyChange(effect)], [effect]), TODAY)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });

  it('never reaches past the current month, because nothing later exists to change', () => {
    const periods = candidatePeriods(
      write([updated(existingValuation, valuationFacts('2026-09-14', '900'), valuationFacts('2026-09-14', '800'))]),
      TODAY,
    );
    expect(periods).toEqual(['2026-09']);
  });
});
