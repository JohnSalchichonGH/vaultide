import { describe, expect, it } from 'vitest';
import { plainDate } from '@vaultide/finance';
import type { IncomeEntryRow, PositionRecord as PositionRow } from '@vaultide/db';
import { NotFoundError, ValidationError, VersionConflictError } from '../../src/errors';
import {
  decideIncomeCreate,
  decideIncomeDelete,
  decideIncomeUpdate,
  planIncomeCreate,
  planIncomeUpdate,
  type IncomeEntryArgs,
} from '../../src/flows/income';
import { decideTrackedCashLeg, type TrackedCashLegRequest } from '../../src/flows/shared';
import { identityKey } from '../../src/write-plan';

/**
 * The income and cash-leg rules, as the pure decisions they now are (blueprint
 * 6.2, 7.4, 8.1, 8.8, 20.3, 30.22; M4, M5; §30.9 items 2 and 5).
 *
 * Creating, correcting and deleting an income entry decide on their own terms,
 * read and judge the cash leg they name, and plan the write. The ordinary
 * services, the correction preview and Historical Confirm all reach these same
 * functions through the same resolvers; their reads are pinned in
 * `resolution-query-shape.test.ts` and the services in the integration suites.
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

const entry = (overrides: Partial<IncomeEntryRow> = {}): IncomeEntryRow => ({
  id: 'inc-1',
  userId: 'user-1',
  templateId: null,
  occurrenceDate: null,
  kind: 'employment',
  receivedOn: '2026-08-25',
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
  description: 'Salary',
  tags: [],
  isOneOff: false,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 4,
  ...overrides,
});

const create = (overrides: Partial<IncomeEntryArgs> = {}): IncomeEntryArgs => ({
  kind: 'employment',
  receivedOn: '2026-08-25',
  netAmount: '2100.00',
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-cash',
  ...overrides,
});

const leg = (overrides: Partial<TrackedCashLegRequest> = {}): TrackedCashLegRequest => ({
  cashPositionId: 'pos-cash',
  currency: 'EUR',
  on: '2026-08-25',
  dateField: 'receivedOn',
  ...overrides,
});

describe('the cash leg of a tracked flow', () => {
  it('attaches to a cash account of the flow’s currency, open on its date', () => {
    const account = cash();
    expect(decideTrackedCashLeg(leg(), { kind: 'account', position: account })).toBe(account);
  });

  it('refuses another currency', () => {
    expect(() =>
      decideTrackedCashLeg(leg({ currency: 'USD' }), { kind: 'account', position: cash() }),
    ).toThrow(ValidationError);
  });

  it('answers not found for a position that is missing or is not cash, alike', () => {
    expect(() => decideTrackedCashLeg(leg(), { kind: 'account', position: undefined })).toThrow(
      NotFoundError,
    );
    expect(() =>
      decideTrackedCashLeg(leg(), { kind: 'account', position: cash({ kind: 'other_asset' }) }),
    ).toThrow(NotFoundError);
  });

  it('refuses a date outside the account’s open window', () => {
    const window = cash({ openedOn: '2026-03-10', closedOn: '2026-07-20', status: 'closed' });
    expect(() =>
      decideTrackedCashLeg(leg({ on: '2026-03-09' }), { kind: 'account', position: window }),
    ).toThrow(/before the account opened/u);
    expect(() =>
      decideTrackedCashLeg(leg({ on: '2026-07-21' }), { kind: 'account', position: window }),
    ).toThrow(/after the account closed/u);
  });

  it('takes no account when one of the currency takes part in the month, and refuses otherwise', () => {
    const unattributed = leg({ cashPositionId: null });
    expect(decideTrackedCashLeg(unattributed, { kind: 'unattributed', participates: true })).toBeNull();
    expect(() =>
      decideTrackedCashLeg(unattributed, { kind: 'unattributed', participates: false }),
    ).toThrow(/no EUR cash account open/u);
  });

  it('refuses evidence that is not about the leg it is asked about', () => {
    expect(() =>
      decideTrackedCashLeg(leg({ cashPositionId: null }), { kind: 'account', position: cash() }),
    ).toThrow(/judged against an account/u);
    expect(() =>
      decideTrackedCashLeg(leg(), { kind: 'unattributed', participates: true }),
    ).toThrow(/without its account/u);
    expect(() =>
      decideTrackedCashLeg(leg(), { kind: 'account', position: cash({ id: 'pos-other' }) }),
    ).toThrow(/another account/u);
  });
});

describe('creating an income entry', () => {
  it('judges it on its own terms and names the account leg to check', () => {
    const decision = decideIncomeCreate(TODAY, create({ grossAmount: '3000.00' }));
    expect(decision.columns).toEqual({
      kind: 'employment',
      receivedOn: '2026-08-25',
      netAmount: '2100.00',
      grossAmount: '3000.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: 'pos-cash',
      description: null,
      tags: undefined,
      isOneOff: undefined,
    });
    expect(decision.leg).toEqual(leg());
  });

  it('records no gross when none is given', () => {
    expect(decideIncomeCreate(TODAY, create()).columns.grossAmount).toBeNull();
  });

  it('names a null leg for a tracked entry with no account', () => {
    expect(decideIncomeCreate(TODAY, create({ cashPositionId: null })).leg).toEqual(
      leg({ cashPositionId: null }),
    );
  });

  it('names no leg, and keeps no account, for income received outside tracked cash', () => {
    const decision = decideIncomeCreate(
      TODAY,
      create({ settlement: 'external', cashPositionId: 'pos-cash' }),
    );
    expect(decision.leg).toBeNull();
    expect(decision.columns.cashPositionId).toBeNull();
  });

  it('refuses a future date and a settlement Phase 3 does not record for the kind', () => {
    expect(() => decideIncomeCreate(TODAY, create({ receivedOn: '2026-10-06' }))).toThrow(
      ValidationError,
    );
    expect(() =>
      decideIncomeCreate(TODAY, create({ kind: 'dividend', settlement: 'external' })),
    ).toThrow(/belongs to the investment/u);
  });

  it('plans a first assertion, waking the dormant account it lands on', () => {
    const { columns } = decideIncomeCreate(TODAY, create());
    const asleep = cash({ isDormant: true, dormantFrom: '2026-06-30' });
    const plan = planIncomeCreate(columns, asleep);

    expect(plan).toMatchObject({
      operation: 'create',
      existing: null,
      expectedVersion: null,
      revision: false,
      occurrence: undefined,
      support: [{ currency: 'EUR', from: '2026-08-25' }],
    });
    expect(plan.dormancy).toHaveLength(1);
    expect(plan.changes.map((change) => identityKey(change.identity))).toEqual([
      'prospective:income:entry:-',
      'existing:cash_dormancy:pos-cash',
    ]);
    expect(planIncomeCreate(columns, cash()).dormancy).toEqual([]);
  });

  it('names the occurrence it materializes by its schedule identity', () => {
    const { columns } = decideIncomeCreate(TODAY, create());
    const plan = planIncomeCreate(columns, cash(), {
      templateId: 'tpl-1',
      occurrenceDate: '2026-09-01',
    });
    expect(identityKey(plan.changes[0]?.identity ?? { scope: 'existing', kind: 'income', id: '' })).toBe(
      'prospective:income:occurrence:tpl-1#2026-09-01',
    );
    expect(plan.changes[0]?.after).toMatchObject({
      receivedOn: '2026-08-25',
      templateId: 'tpl-1',
      occurrenceDate: '2026-09-01',
    });
  });

  it('refuses a leg that is not the one its columns name', () => {
    const { columns } = decideIncomeCreate(TODAY, create());
    expect(() => planIncomeCreate(columns, null)).toThrow(/another account/u);
    expect(() => planIncomeCreate(columns, cash({ id: 'pos-other' }))).toThrow(/another account/u);
  });
});

describe('correcting an income entry', () => {
  it('refuses a stale version before anything else', () => {
    expect(() =>
      decideIncomeUpdate(TODAY, entry(), {
        entryId: 'inc-1',
        expectedVersion: 3,
        receivedOn: '2026-10-06',
      }),
    ).toThrow(VersionConflictError);
  });

  it('keeps what the correction leaves out, the gross included', () => {
    const { columns, leg: named } = decideIncomeUpdate(TODAY, entry(), {
      entryId: 'inc-1',
      expectedVersion: 4,
      netAmount: '2200.00',
    });
    expect(columns).toMatchObject({
      kind: 'employment',
      receivedOn: '2026-08-25',
      netAmount: '2200.00',
      grossAmount: '3000.00000000',
      settlement: 'tracked_cash',
      cashPositionId: 'pos-cash',
      description: 'Salary',
    });
    expect(named).toEqual(leg());
  });

  it('clears the gross for null and sets it for an amount', () => {
    const cleared = decideIncomeUpdate(TODAY, entry(), {
      entryId: 'inc-1',
      expectedVersion: 4,
      grossAmount: null,
    });
    expect(cleared.columns.grossAmount).toBeNull();
    const set = decideIncomeUpdate(TODAY, entry(), {
      entryId: 'inc-1',
      expectedVersion: 4,
      grossAmount: '3100.00',
    });
    expect(set.columns.grossAmount).toBe('3100.00');
  });

  it('judges the corrected date and settlement as a new entry would be judged', () => {
    expect(() =>
      decideIncomeUpdate(TODAY, entry(), { entryId: 'inc-1', expectedVersion: 4, receivedOn: '2026-10-06' }),
    ).toThrow(ValidationError);
    expect(() =>
      decideIncomeUpdate(TODAY, entry({ kind: 'interest' }), {
        entryId: 'inc-1',
        expectedVersion: 4,
        settlement: 'external',
      }),
    ).toThrow(ValidationError);

    const external = decideIncomeUpdate(TODAY, entry(), {
      entryId: 'inc-1',
      expectedVersion: 4,
      settlement: 'external',
    });
    expect(external.leg).toBeNull();
    expect(external.columns.cashPositionId).toBeNull();
  });

  it('keeps the occurrence a recurring row fulfils when its financial date moves', () => {
    const recurring = entry({ templateId: 'tpl-1', occurrenceDate: '2026-09-01', receivedOn: '2026-08-31' });
    const { columns } = decideIncomeUpdate(TODAY, recurring, {
      entryId: 'inc-1',
      expectedVersion: 4,
      receivedOn: '2026-09-02',
    });
    const plan = planIncomeUpdate(recurring, columns, cash());

    expect(plan.occurrence).toEqual({ templateId: 'tpl-1', occurrenceDate: '2026-09-01' });
    expect(plan.changes[0]).toMatchObject({
      identity: { scope: 'existing', kind: 'income', id: 'inc-1' },
      operation: 'update',
      before: { receivedOn: '2026-08-31', templateId: 'tpl-1', occurrenceDate: '2026-09-01' },
      after: { receivedOn: '2026-09-02', templateId: 'tpl-1', occurrenceDate: '2026-09-01' },
    });
    expect(plan).toMatchObject({
      expectedVersion: 4,
      revision: true,
      support: [{ currency: 'EUR', from: '2026-08-31' }],
    });
  });

  it('wakes the dormant account the corrected entry is attributed to', () => {
    const { columns } = decideIncomeUpdate(TODAY, entry(), {
      entryId: 'inc-1',
      expectedVersion: 4,
      netAmount: '2200.00',
    });
    const plan = planIncomeUpdate(entry(), columns, cash({ isDormant: true, dormantFrom: '2026-06-30' }));
    expect(plan.dormancy).toHaveLength(1);
  });
});

describe('deleting an income entry', () => {
  it('plans a delete at the version the caller saw, restoring no dormancy', () => {
    const plan = decideIncomeDelete(entry(), { entryId: 'inc-1', expectedVersion: 4 });
    expect(plan).toMatchObject({
      operation: 'delete',
      expectedVersion: 4,
      columns: null,
      revision: true,
      dormancy: [],
      support: [],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ operation: 'delete', after: null });
  });

  it('refuses a stale version', () => {
    expect(() => decideIncomeDelete(entry(), { entryId: 'inc-1', expectedVersion: 3 })).toThrow(
      VersionConflictError,
    );
  });
});
