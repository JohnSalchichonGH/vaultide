import { describe, expect, it } from 'vitest';
import { plainDate } from '@vaultide/finance';
import type { PositionRecord as PositionRow, ValuationRow } from '@vaultide/db';
import {
  DomainError,
  DuplicateConflictError,
  ImpossibleOperationError,
  ValidationError,
  VersionConflictError,
} from '../../src/errors';
import {
  assertValuationAllowed,
  decideCorrectValuation,
  decideRecordValuation,
  decideRemoveValuation,
} from '../../src/positions/valuations';
import { identityKey, prospectiveValuation } from '../../src/write-plan';

/**
 * The balance rules, as the pure decisions they now are (blueprint 6.2, 8.1,
 * 8.8, 30.20, 30.22; M1, M4, M5, R15).
 *
 * Every resolver that records, corrects or removes a balance reads its rows and
 * hands them to these functions; the correction preview and Historical Confirm
 * reach them through the same resolvers. So a case proved here is the rule the
 * ordinary write, the preview and the confirm all apply to the same rows. The
 * resolvers' reads are pinned statement by statement in
 * `resolution-query-shape.test.ts`, and the services themselves in the
 * integration suites.
 *
 * `today` is 5 October 2026: September has ended, October has not.
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

const asset = (overrides: Partial<PositionRow> = {}): PositionRow => ({
  id: 'pos-car',
  userId: 'user-1',
  kind: 'other_asset',
  name: 'Car',
  currency: 'EUR',
  status: 'active',
  openedOn: null,
  closedOn: null,
  notes: null,
  sortOrder: 1,
  version: 1,
  createdAt: CREATED,
  ...overrides,
});

const dormantSince = (from: string) => cash({ isDormant: true, dormantFrom: from });

const row = (overrides: Partial<ValuationRow> = {}): ValuationRow => ({
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

const balance = (valuedOn: string, amount: string, datePrecision: 'exact' | 'month_end' = 'exact') => ({
  positionId: 'pos-cash',
  valuedOn,
  amount,
  datePrecision,
});

describe('a balance on its own terms', () => {
  it('accepts a balance dated today or before', () => {
    expect(() => assertValuationAllowed(TODAY, cash(), balance('2026-10-05', '10'))).not.toThrow();
    expect(() => assertValuationAllowed(TODAY, cash(), balance('2026-01-01', '10'))).not.toThrow();
  });

  it('refuses a future date', () => {
    expect(() => assertValuationAllowed(TODAY, cash(), balance('2026-10-06', '10'))).toThrow(
      ValidationError,
    );
  });

  it('refuses a month-end balance not dated the last day of its month', () => {
    expect(() =>
      assertValuationAllowed(TODAY, cash(), balance('2026-08-30', '10', 'month_end')),
    ).toThrow(/last day of its month/u);
  });

  it('refuses a month-end balance before its month has ended, even on the last day', () => {
    const lastDay = plainDate('2026-09-30');
    expect(() =>
      assertValuationAllowed(lastDay, cash(), balance('2026-09-30', '10', 'month_end')),
    ).toThrow(/has not ended yet/u);
    expect(() =>
      assertValuationAllowed(TODAY, cash(), balance('2026-09-30', '10', 'month_end')),
    ).not.toThrow();
  });

  it('lets only cash go negative, and treats -0 as zero', () => {
    expect(() => assertValuationAllowed(TODAY, cash(), balance('2026-10-01', '-50'))).not.toThrow();
    expect(() => assertValuationAllowed(TODAY, asset(), balance('2026-10-01', '-50'))).toThrow(
      /cannot be negative/u,
    );
    expect(() => assertValuationAllowed(TODAY, asset(), balance('2026-10-01', '-0.00'))).not.toThrow();
  });

  it('refuses a date before the account opened or after it closed', () => {
    const window = cash({ openedOn: '2026-03-10', closedOn: '2026-07-20', status: 'closed' });
    expect(() => assertValuationAllowed(TODAY, window, balance('2026-03-09', '10'))).toThrow(
      /before the account opened/u,
    );
    expect(() => assertValuationAllowed(TODAY, window, balance('2026-07-21', '10'))).toThrow(
      /after the account closed/u,
    );
    expect(() => assertValuationAllowed(TODAY, window, balance('2026-03-10', '10'))).not.toThrow();
    expect(() => assertValuationAllowed(TODAY, window, balance('2026-07-20', '0'))).not.toThrow();
  });
});

describe('recording a balance', () => {
  it('plans a first assertion on a free date', () => {
    const plan = decideRecordValuation(TODAY, cash(), balance('2026-08-31', '120.50', 'month_end'), undefined);

    expect(plan).toMatchObject({
      operation: 'record',
      existing: null,
      expectedVersion: null,
      columns: { amount: '120.50', valuedOn: '2026-08-31', datePrecision: 'month_end', note: null },
      revision: false,
      dormancy: [],
      support: [{ currency: 'EUR', from: '2026-08-31' }],
    });
    expect(plan.changes).toEqual([
      {
        identity: prospectiveValuation('pos-cash', '2026-08-31'),
        operation: 'create',
        before: null,
        after: {
          kind: 'valuation',
          positionId: 'pos-cash',
          valuedOn: '2026-08-31',
          amount: '120.5',
          currency: 'EUR',
          datePrecision: 'month_end',
          note: null,
        },
      },
    ]);
  });

  it('refuses a date that already holds a balance, whatever its precision', () => {
    const occupant = row({ valuedOn: '2026-08-31', datePrecision: 'exact' });
    expect(() =>
      decideRecordValuation(TODAY, cash(), balance('2026-08-31', '120', 'month_end'), occupant),
    ).toThrow(DuplicateConflictError);
  });

  it('keeps a dormant account dormant for a zero, and wakes it for anything else', () => {
    const asleep = dormantSince('2026-06-30');

    expect(decideRecordValuation(TODAY, asleep, balance('2026-08-31', '0'), undefined).dormancy).toEqual([]);

    const woken = decideRecordValuation(TODAY, asleep, balance('2026-08-31', '5'), undefined);
    expect(woken.dormancy).toEqual([
      {
        positionId: 'pos-cash',
        before: { isDormant: true, dormantFrom: '2026-06-30' },
        after: { isDormant: false, dormantFrom: null },
        via: 'clear',
      },
    ]);
    expect(woken.changes.map((change) => identityKey(change.identity))).toEqual([
      'prospective:valuation:valuation:pos-cash#2026-08-31',
      'existing:cash_dormancy:pos-cash',
    ]);
  });

  it('wakes on a balance dated before the episode began, because waking is not date-sensitive', () => {
    const woken = decideRecordValuation(TODAY, dormantSince('2026-06-30'), balance('2025-12-31', '5'), undefined);
    expect(woken.dormancy).toHaveLength(1);
  });

  it('never wakes anything but cash', () => {
    const plan = decideRecordValuation(
      TODAY,
      asset(),
      { ...balance('2026-08-31', '9000'), positionId: 'pos-car' },
      undefined,
    );
    expect(plan.dormancy).toEqual([]);
  });

  it('refuses to judge against the balance of another date or account', () => {
    expect(() =>
      decideRecordValuation(TODAY, cash(), balance('2026-08-31', '1'), row({ valuedOn: '2026-07-31' })),
    ).toThrow(/another date/u);
    expect(() =>
      decideRecordValuation(TODAY, cash(), balance('2026-08-31', '1'), row({ positionId: 'pos-other' })),
    ).toThrow(/another date/u);
  });
});

describe('correcting a balance', () => {
  const correction = (overrides: Record<string, unknown> = {}) => ({
    valuationId: 'val-1',
    expectedVersion: 3,
    valuedOn: '2026-08-31',
    amount: '150',
    datePrecision: 'month_end' as const,
    ...overrides,
  });

  it('plans a revision in place, taking the row being corrected as no clash', () => {
    const existing = row();
    const plan = decideCorrectValuation(TODAY, cash(), existing, correction(), existing);

    expect(plan).toMatchObject({
      operation: 'correct',
      existing,
      expectedVersion: 3,
      revision: true,
      dormancy: [],
      support: [{ currency: 'EUR', from: '2026-08-31' }],
    });
    expect(plan.changes).toEqual([
      {
        identity: { scope: 'existing', kind: 'valuation', id: 'val-1' },
        operation: 'update',
        before: expect.objectContaining({ amount: '100', valuedOn: '2026-08-31' }) as unknown,
        after: expect.objectContaining({ amount: '150', valuedOn: '2026-08-31' }) as unknown,
      },
    ]);
  });

  it('refuses a stale version', () => {
    expect(() =>
      decideCorrectValuation(TODAY, cash(), row(), correction({ expectedVersion: 2 }), undefined),
    ).toThrow(VersionConflictError);
  });

  it('re-dates onto a free date, warming both dates', () => {
    const plan = decideCorrectValuation(TODAY, cash(), row(), correction({ valuedOn: '2026-07-31' }), undefined);
    expect(plan.support).toEqual([{ currency: 'EUR', from: '2026-07-31' }]);
    expect(plan.changes[0]?.after).toMatchObject({ valuedOn: '2026-07-31' });
  });

  it('refuses a re-date onto a date already holding a balance, before judging the version', () => {
    const occupant = row({ id: 'val-2', valuedOn: '2026-07-31' });
    expect(() =>
      decideCorrectValuation(
        TODAY,
        cash(),
        row(),
        correction({ valuedOn: '2026-07-31', expectedVersion: 2 }),
        occupant,
      ),
    ).toThrow(DuplicateConflictError);
  });

  it('wakes a dormant account for a non-zero amount', () => {
    const asleep = dormantSince('2026-06-30');
    const plan = decideCorrectValuation(TODAY, asleep, row({ amount: '0' }), correction({ amount: '1' }), undefined);
    expect(plan.dormancy).toHaveLength(1);
  });

  it('wakes it when the balance its episode rests on moves, even at zero', () => {
    const asleep = dormantSince('2026-06-30');
    const anchor = row({ valuedOn: '2026-06-30', amount: '0' });
    const moved = decideCorrectValuation(
      TODAY,
      asleep,
      anchor,
      correction({ valuedOn: '2026-07-31', amount: '0' }),
      undefined,
    );
    expect(moved.dormancy).toHaveLength(1);

    // Correcting the anchor in place, still zero, leaves the episode alone.
    const kept = decideCorrectValuation(
      TODAY,
      asleep,
      anchor,
      correction({ valuedOn: '2026-06-30', amount: '0' }),
      anchor,
    );
    expect(kept.dormancy).toEqual([]);

    // Moving some other zero leaves it alone too.
    const other = decideCorrectValuation(
      TODAY,
      asleep,
      row({ valuedOn: '2026-08-31', amount: '0' }),
      correction({ valuedOn: '2026-09-30', amount: '0' }),
      undefined,
    );
    expect(other.dormancy).toEqual([]);
  });

  it('refuses to judge a balance against another account', () => {
    expect(() => decideCorrectValuation(TODAY, asset(), row(), correction(), undefined)).toThrow(
      /another account/u,
    );
  });
});

describe('removing a balance', () => {
  it('plans a delete at the version the caller saw', () => {
    const existing = row();
    const plan = decideRemoveValuation(cash(), existing, { valuationId: 'val-1', expectedVersion: 3 });
    expect(plan).toMatchObject({
      operation: 'remove',
      existing,
      columns: null,
      revision: true,
      dormancy: [],
      support: [],
    });
    expect(plan.changes).toEqual([
      {
        identity: { scope: 'existing', kind: 'valuation', id: 'val-1' },
        operation: 'delete',
        before: expect.objectContaining({ valuedOn: '2026-08-31' }) as unknown,
        after: null,
      },
    ]);
  });

  it('refuses a stale version', () => {
    expect(() =>
      decideRemoveValuation(cash(), row(), { valuationId: 'val-1', expectedVersion: 2 }),
    ).toThrow(VersionConflictError);
  });

  it('refuses the closing balance of a closed account, whatever version was seen', () => {
    const closed = cash({ status: 'closed', closedOn: '2026-08-31' });
    expect(() =>
      decideRemoveValuation(closed, row(), { valuationId: 'val-1', expectedVersion: 2 }),
    ).toThrow(ImpossibleOperationError);
  });

  it('wakes a dormant account when the balance its episode rests on goes, and only then', () => {
    const asleep = dormantSince('2026-06-30');
    const anchor = row({ valuedOn: '2026-06-30', amount: '0' });
    expect(
      decideRemoveValuation(asleep, anchor, { valuationId: 'val-1', expectedVersion: 3 }).dormancy,
    ).toHaveLength(1);
    expect(
      decideRemoveValuation(asleep, row({ valuedOn: '2026-08-31', amount: '0' }), {
        valuationId: 'val-1',
        expectedVersion: 3,
      }).dormancy,
    ).toEqual([]);
  });
});

/**
 * A refusal that is a caller's mistake: a plain `Error`, never a domain code a
 * person would be shown. Missing and foreign ids stay `NOT_FOUND` at the
 * resolvers, which read under RLS; these are the rows a caller mis-associated.
 */
function expectInternal(run: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(DomainError);
  expect((caught as Error).message).toMatch(message);
}

describe('a decision is only ever about the rows its operation names', () => {
  const correction = (overrides: Record<string, unknown> = {}) => ({
    valuationId: 'val-1',
    expectedVersion: 3,
    valuedOn: '2026-08-31',
    amount: '150',
    datePrecision: 'month_end' as const,
    ...overrides,
  });

  it('refuses to record a balance of account A against account B', () => {
    const forA = { ...balance('2026-08-31', '1', 'month_end'), positionId: 'pos-a' };
    expectInternal(
      () => decideRecordValuation(TODAY, cash({ id: 'pos-b' }), forA, undefined),
      /another account/u,
    );
    // The same operation, handed its own account, is planned for that account.
    const plan = decideRecordValuation(TODAY, cash({ id: 'pos-a' }), forA, undefined);
    expect(identityKey(plan.changes[0]?.identity ?? prospectiveValuation('', ''))).toBe(
      'prospective:valuation:valuation:pos-a#2026-08-31',
    );
  });

  it('asks the balance’s own rules of the account it plans for, not of one asked before', () => {
    // Account A closed in July. A caller that asked the rules of some other,
    // open account and then planned for A still has A's window applied.
    const closedA = cash({ id: 'pos-a', status: 'closed', closedOn: '2026-07-20' });
    const forA = { ...balance('2026-08-31', '1', 'month_end'), positionId: 'pos-a' };
    expect(() => assertValuationAllowed(TODAY, cash({ id: 'pos-b' }), forA)).not.toThrow();
    expect(() => decideRecordValuation(TODAY, closedA, forA, undefined)).toThrow(
      /after the account closed/u,
    );
    expect(() =>
      decideCorrectValuation(TODAY, closedA, row({ positionId: 'pos-a' }), correction(), undefined),
    ).toThrow(/after the account closed/u);
  });

  it('refuses to correct balance A with the row of balance B, even on the same account and version', () => {
    expectInternal(
      () => decideCorrectValuation(TODAY, cash(), row({ id: 'val-2' }), correction(), undefined),
      /another balance/u,
    );
  });

  it('refuses a correction whose own date is said to hold another balance', () => {
    // Not moving, the row on the balance's own date is that balance (M1).
    expectInternal(
      () => decideCorrectValuation(TODAY, cash(), row(), correction(), row({ id: 'val-2' })),
      /another balance on the same date/u,
    );
  });

  it('refuses a clash that is about another date or account', () => {
    expectInternal(
      () =>
        decideCorrectValuation(
          TODAY,
          cash(),
          row(),
          correction({ valuedOn: '2026-07-31' }),
          row({ id: 'val-2', valuedOn: '2026-06-30' }),
        ),
      /another date/u,
    );
  });

  it('refuses to remove balance A by removing balance B', () => {
    expectInternal(
      () => decideRemoveValuation(cash(), row({ id: 'val-2' }), { valuationId: 'val-1', expectedVersion: 3 }),
      /another balance/u,
    );
    expectInternal(
      () => decideRemoveValuation(asset(), row(), { valuationId: 'val-1', expectedVersion: 3 }),
      /another account/u,
    );
  });
});

describe('the identity of a balance that does not exist yet', () => {
  it('is its account and its date', () => {
    const key = (positionId: string, valuedOn: string) =>
      identityKey(prospectiveValuation(positionId, valuedOn));

    expect(key('pos-a', '2025-01-31')).toBe(key('pos-a', '2025-01-31'));
    expect(key('pos-a', '2025-01-31')).not.toBe(key('pos-a', '2025-02-28'));
    expect(key('pos-a', '2025-01-31')).not.toBe(key('pos-b', '2025-01-31'));
    expect(key('pos-a', '2025-01-31')).toBe('prospective:valuation:valuation:pos-a#2025-01-31');
  });

  it('tells two new balances of one account apart in the same plan', () => {
    const plans = ['2025-01-31', '2025-02-28', '2025-03-31'].map((valuedOn) =>
      decideRecordValuation(TODAY, cash(), balance(valuedOn, '10', 'month_end'), undefined),
    );
    const keys = plans.flatMap((plan) => plan.changes.map((change) => identityKey(change.identity)));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });
});
