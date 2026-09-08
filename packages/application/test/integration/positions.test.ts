import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { providerOutage } from '../helpers/stub-fx-provider';
import { testContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  closePosition,
  createCashAccount,
  createOtherAsset,
  removePosition,
  updateCashAccount,
  updateOtherAsset,
} from '../../src/positions/service';
import {
  confirmMonthEnd,
  confirmUnchanged,
  correctValuation,
  positionHistory,
  quickUpdate,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import { getNetWorth, getPositionDetail } from '../../src/positions/queries';

/**
 * Positions, valuations and net worth against a real database
 * (blueprint 21.3; §26 Phase 2 items 1–9).
 *
 * Two users exist throughout, so every assertion about one is also an assertion
 * that the other cannot see or reach it. The clock is explicit in every
 * context: "today" is an input, never a read of the process clock, which is
 * what makes the month-boundary rules testable at all (7.7, 21).
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;

/** Contexts frozen on specific days, so month boundaries are deliberate. */
const on = (today: string, userId = USER_A, reportingCurrency = 'EUR'): RequestContext =>
  testContext({ today, userId, reportingCurrency });

const SEPT_6 = on('2026-09-06');
const SEPT_30 = on('2026-09-30');
const OCT_1 = on('2026-10-01');

function deps() {
  return harness.services.positions;
}

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function auditRows(userId: string, entityId: string) {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action, before, after, changed_fields
            FROM audit_entries
           WHERE entity_id = ${entityId}
           ORDER BY occurred_at, action`,
    );
    return result.rows as {
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      changed_fields: string[];
    }[];
  });
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await createAuthUser(USER_B, 'b@example.test');
  await provisionUser(harness.db, { userId: USER_A });
  await provisionUser(harness.db, { userId: USER_B });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');
  await harness.asOwner('DELETE FROM fx_rates');
  harness.fxProvider.reset();
});

async function makeCashAccount(
  ctx: RequestContext = SEPT_6,
  overrides: Partial<Parameters<typeof createCashAccount>[2]> = {},
) {
  return createCashAccount(deps(), ctx, {
    name: 'BBVA checking',
    currency: 'EUR',
    accountType: 'checking',
    openedOn: null,
    ...overrides,
  });
}

describe('creating a cash account', () => {
  it('stores the account, its subtype and its first balance in one go', async () => {
    const created = await makeCashAccount(SEPT_6, {
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-06',
    });

    const detail = await getPositionDetail(deps(), SEPT_6, created.id);
    expect(detail.position.name).toBe('BBVA checking');
    expect(detail.position.accountType).toBe('checking');
    expect(detail.position.currency).toBe('EUR');
    expect(detail.valuations).toHaveLength(1);
    expect(detail.valuations[0]?.amount).toEqual({ amount: '8055', currency: 'EUR' });
    expect(detail.valuations[0]?.datePrecision).toBe('exact');
  });

  it('records "existed before I tracked it" as a null opening date (8.1)', async () => {
    const preexisting = await makeCashAccount(SEPT_6, { openedOn: null });
    const brandNew = await makeCashAccount(SEPT_6, {
      name: 'New account',
      openedOn: '2026-09-01',
    });

    expect(preexisting.openedOn).toBeNull();
    expect(brandNew.openedOn).toBe('2026-09-01');
  });

  it('refuses a currency Vaultide holds no rates for, and crypto outright (R28)', async () => {
    await expect(makeCashAccount(SEPT_6, { currency: 'BTC' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses a balance dated tomorrow, even though the database would take it', async () => {
    // §26 Phase 2, item 1. The database has no constraint about the future by
    // design (6.1); this is the layer that knows what "today" means.
    await expect(
      makeCashAccount(SEPT_6, {
        openingBalance: '10.00',
        openingBalanceOn: '2026-09-07',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('writes an audit row for the account and for its first balance (18.1)', async () => {
    const created = await makeCashAccount(SEPT_6, {
      openingBalance: '100.00',
      openingBalanceOn: '2026-09-06',
    });
    const rows = await auditRows(USER_A, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('insert');
    expect(rows[0]?.after).toMatchObject({ name: 'BBVA checking', kind: 'cash' });
  });
});

describe('the two date rules (M5, R15)', () => {
  it('accepts an ordinary snapshot dated the last day of the month', async () => {
    const account = await makeCashAccount(SEPT_30);
    const created = await recordValuation(deps(), SEPT_30, {
      positionId: account.id,
      valuedOn: '2026-09-30',
      amount: '8055.00',
      datePrecision: 'exact',
    });
    expect(created.datePrecision).toBe('exact');
  });

  it('refuses a September month-end balance on 30 September — even server-side', async () => {
    // §26 Phase 2, item 2, and the acceptance bullet "a bypassed request with
    // month_end precision on 30 Sep is rejected by the server". This call is
    // the bypass: no browser, no schema, straight into the service.
    const account = await makeCashAccount(SEPT_30);
    await expect(
      recordValuation(deps(), SEPT_30, {
        positionId: account.id,
        valuedOn: '2026-09-30',
        amount: '8055.00',
        datePrecision: 'month_end',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('accepts it on 1 October, and lets the 30 September snapshot be confirmed', async () => {
    // §26 Phase 2, item 3.
    const account = await makeCashAccount(SEPT_30);
    const snapshot = await recordValuation(deps(), SEPT_30, {
      positionId: account.id,
      valuedOn: '2026-09-30',
      amount: '8055.00',
      datePrecision: 'exact',
    });

    const confirmed = await confirmMonthEnd(deps(), OCT_1, {
      valuationId: snapshot.id,
      expectedVersion: snapshot.version,
    });

    expect(confirmed.datePrecision).toBe('month_end');
    // The amount is the user's own figure and is untouched by the upgrade.
    expect(confirmed.amount).toBe(snapshot.amount);

    const audit = await auditRows(USER_A, snapshot.id);
    expect(audit.at(-1)?.changed_fields).toContain('datePrecision');
  });

  it('refuses a future-dated balance and one dated after the account closed', async () => {
    const account = await makeCashAccount(SEPT_6);
    await expect(
      recordValuation(deps(), SEPT_6, {
        positionId: account.id,
        valuedOn: '2026-09-07',
        amount: '1.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a second balance for the same date (M1)', async () => {
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '10.00',
      openingBalanceOn: '2026-09-06',
    });
    await expect(
      recordValuation(deps(), SEPT_6, {
        positionId: account.id,
        valuedOn: '2026-09-06',
        amount: '20.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });
});

describe('"confirm unchanged for this month" (R22, 8.1)', () => {
  /**
   * The action carries **the previous month's statement balance** forward, and
   * nothing else. It originally reached for the latest valuation on or before
   * the previous month end, which agrees whenever that month is closed and,
   * when it is not, carries a figure across an unobserved month and stamps it
   * as a statement balance — the failure C7, F1 and R5 exist to prevent.
   */

  async function accountWithJulyOnly(ctx: RequestContext = OCT_1) {
    const account = await makeCashAccount(ctx, { name: 'BBVA' });
    await recordValuation(deps(), ctx, {
      positionId: account.id,
      valuedOn: '2026-07-31',
      amount: '8000.00',
      datePrecision: 'month_end',
    });
    return account;
  }

  it('refuses September while August has no month-end balance', async () => {
    const account = await accountWithJulyOnly();

    await expect(
      confirmUnchanged(deps(), OCT_1, { positionId: account.id, month: '2026-09' }),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE_DATA',
      message: expect.stringContaining('August 2026'),
    });

    // Nothing was written: no September row, and July is untouched.
    const history = await positionHistory(deps(), OCT_1, account.id);
    expect(history.map((row) => row.valuedOn)).toEqual(['2026-07-31']);
    expect(history[0]?.amount).toBe('8000.00000000');
    expect(history[0]?.version).toBe(1);
  });

  it('refuses an unclosed month even when an ordinary snapshot sits on its last day', async () => {
    // An exact snapshot dated 31 August is not August's statement balance
    // (8.8), so it is not something to carry either.
    const account = await accountWithJulyOnly();
    await recordValuation(deps(), OCT_1, {
      positionId: account.id,
      valuedOn: '2026-08-31',
      amount: '8123.45',
      datePrecision: 'exact',
    });

    await expect(
      confirmUnchanged(deps(), OCT_1, { positionId: account.id, month: '2026-09' }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });
  });

  it('succeeds once August is closed, carrying August’s exact amount', async () => {
    const account = await accountWithJulyOnly();
    const august = await recordValuation(deps(), OCT_1, {
      positionId: account.id,
      valuedOn: '2026-08-31',
      amount: '8055.55',
      datePrecision: 'month_end',
    });

    const carried = await confirmUnchanged(deps(), OCT_1, {
      positionId: account.id,
      month: '2026-09',
    });

    expect(carried.valuedOn).toBe('2026-09-30');
    // August's exact native amount, not July's and not a rounded copy.
    expect(carried.amount).toBe(august.amount);
    expect(carried.amount).toBe('8055.55000000');
    expect(carried.source).toBe('confirmed_unchanged');
    expect(carried.datePrecision).toBe('month_end');
    expect(carried.version).toBe(1);

    // No earlier valuation was mutated — same amounts, same versions, and no
    // `update` in either row's audit trail.
    const history = await positionHistory(deps(), OCT_1, account.id);
    expect(history.map((row) => [row.valuedOn, row.amount, row.version])).toEqual([
      ['2026-09-30', '8055.55000000', 1],
      ['2026-08-31', '8055.55000000', 1],
      ['2026-07-31', '8000.00000000', 1],
    ]);
    for (const row of history.filter((item) => item.valuedOn !== '2026-09-30')) {
      expect((await auditRows(USER_A, row.id)).map((entry) => entry.action)).toEqual(['insert']);
    }

    // The new row is on the record, as an insert with no before-image (18.1).
    const audit = await auditRows(USER_A, carried.id);
    expect(audit.map((row) => row.action)).toEqual(['insert']);
    expect(audit[0]?.before).toBeNull();
    expect(audit[0]?.after).toMatchObject({
      amount: '8055.55000000',
      source: 'confirmed_unchanged',
      datePrecision: 'month_end',
    });

    // …and September now reports as closed, so October could reconcile against
    // an opening the user actually confirmed.
    const detail = await getPositionDetail(deps(), on('2026-10-01'), account.id);
    expect(detail.position.lastCompletedMonth).toMatchObject({
      month: '2026-09',
      open: 'month_end',
      close: 'month_end',
      included: true,
    });
    expect(
      detail.monthsAwaitingStatement.map((month) => month.month),
    ).not.toContain('2026-09');
  });

  it('tells the interface which months are eligible before it offers the button', async () => {
    const account = await accountWithJulyOnly();
    const detail = await getPositionDetail(deps(), OCT_1, account.id);

    const august = detail.monthsAwaitingStatement.find((month) => month.month === '2026-08');
    const september = detail.monthsAwaitingStatement.find((month) => month.month === '2026-09');

    // August can be confirmed — July is closed. September cannot, yet.
    expect(august?.canConfirmUnchanged).toBe(true);
    expect(september?.canConfirmUnchanged).toBe(false);
  });

  it('refuses to confirm a month that has not ended', async () => {
    const account = await makeCashAccount(SEPT_30);
    await expect(
      confirmUnchanged(deps(), SEPT_30, { positionId: account.id, month: '2026-09' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses when there is nothing earlier to carry', async () => {
    const account = await makeCashAccount(OCT_1);
    await expect(
      confirmUnchanged(deps(), OCT_1, { positionId: account.id, month: '2026-09' }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });
  });

  it('refuses a second confirmation for the same month', async () => {
    const account = await accountWithJulyOnly();
    await recordValuation(deps(), OCT_1, {
      positionId: account.id,
      valuedOn: '2026-08-31',
      amount: '8055.00',
      datePrecision: 'month_end',
    });
    await confirmUnchanged(deps(), OCT_1, { positionId: account.id, month: '2026-09' });

    await expect(
      confirmUnchanged(deps(), OCT_1, { positionId: account.id, month: '2026-09' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });
});

describe('correcting and deleting a balance (2.6, R12, 18.1)', () => {
  it('updates in place, with a before-image and a version check', async () => {
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '8000.00',
      openingBalanceOn: '2026-03-31',
    });
    const [original] = await positionHistory(deps(), SEPT_6, account.id);

    const corrected = await correctValuation(deps(), SEPT_6, {
      valuationId: original!.id,
      expectedVersion: original!.version,
      valuedOn: '2026-03-31',
      amount: '8055.00',
      datePrecision: 'exact',
    });
    expect(corrected.amount).toBe('8055.00000000');

    // §26 Phase 2, item 7: editing a past balance produces an audit row.
    const audit = await auditRows(USER_A, original!.id);
    const update = audit.find((row) => row.action === 'update');
    expect(update?.before).toMatchObject({ amount: '8000.00000000' });
    expect(update?.after).toMatchObject({ amount: '8055.00000000' });
    expect(update?.changed_fields).toContain('amount');

    // A stale version is refused rather than silently overwriting.
    await expect(
      correctValuation(deps(), SEPT_6, {
        valuationId: original!.id,
        expectedVersion: original!.version,
        valuedOn: '2026-03-31',
        amount: '1.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
  });

  it('hard-deletes with the full before-image kept', async () => {
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    const [row] = await positionHistory(deps(), SEPT_6, account.id);

    await removeValuation(deps(), SEPT_6, row!.id);
    expect(await positionHistory(deps(), SEPT_6, account.id)).toHaveLength(0);

    const audit = await auditRows(USER_A, row!.id);
    const deletion = audit.find((entry) => entry.action === 'delete');
    expect(deletion?.before).toMatchObject({ amount: '8055.00000000' });
    expect(deletion?.after).toBeNull();
  });
});

describe('closing and deleting a position (M6, R12, 6.3)', () => {
  it('refuses to close an account that still holds money, and says what to do', async () => {
    // §26 Phase 2, item 8.
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });

    await expect(
      closePosition(deps(), SEPT_6, {
        positionId: account.id,
        expectedVersion: account.version,
        closedOn: '2026-09-06',
      }),
    ).rejects.toMatchObject({
      code: 'IMPOSSIBLE_OPERATION',
      message: expect.stringContaining('zero'),
    });
  });

  it('closes once a final zero balance exists, and then contributes nothing', async () => {
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    await recordValuation(deps(), SEPT_6, {
      positionId: account.id,
      valuedOn: '2026-09-05',
      amount: '0',
      datePrecision: 'exact',
    });

    const closed = await closePosition(deps(), SEPT_6, {
      positionId: account.id,
      expectedVersion: account.version,
      closedOn: '2026-09-05',
    });
    expect(closed.status).toBe('closed');

    const netWorth = await getNetWorth(deps(), SEPT_6);
    expect(netWorth.totalNetWorth.value?.amount).toBe('0');
    expect(netWorth.totalNetWorth.availability).toBe('available');
  });

  it('refuses to delete an account with history, and allows it without', async () => {
    const withHistory = await makeCashAccount(SEPT_6, {
      openingBalance: '1.00',
      openingBalanceOn: '2026-09-01',
    });
    await expect(removePosition(deps(), SEPT_6, withHistory.id)).rejects.toMatchObject({
      code: 'IMPOSSIBLE_OPERATION',
    });

    const empty = await makeCashAccount(SEPT_6, { name: 'Mistake' });
    await removePosition(deps(), SEPT_6, empty.id);
    await expect(getPositionDetail(deps(), SEPT_6, empty.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

});

describe('the dormant flag (R22, 6.2)', () => {
  it('is only settable at zero, and a non-zero balance clears it', async () => {
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '120.00',
      openingBalanceOn: '2026-09-01',
    });

    await expect(
      updateCashAccount(deps(), SEPT_6, {
        positionId: account.id,
        expectedVersion: account.version,
        isDormant: true,
      }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });

    await recordValuation(deps(), SEPT_6, {
      positionId: account.id,
      valuedOn: '2026-09-02',
      amount: '0',
      datePrecision: 'exact',
    });

    const dormant = await updateCashAccount(deps(), SEPT_6, {
      positionId: account.id,
      expectedVersion: account.version,
      isDormant: true,
    });
    expect(dormant.isDormant).toBe(true);

    // Money comes back: the flag would now be asserting something false.
    await recordValuation(deps(), SEPT_6, {
      positionId: account.id,
      valuedOn: '2026-09-03',
      amount: '50.00',
      datePrecision: 'exact',
    });
    const detail = await getPositionDetail(deps(), SEPT_6, account.id);
    expect(detail.position.isDormant).toBe(false);
  });
});

describe('quick update (15.3, 20.3)', () => {
  it('writes canonical valuations dated today for several positions at once', async () => {
    const bbva = await makeCashAccount(SEPT_6, { name: 'BBVA' });
    const savings = await makeCashAccount(SEPT_6, { name: 'Savings' });

    const summary = await quickUpdate(deps(), SEPT_6, {
      entries: [
        { positionId: bbva.id, amount: '8120.00' },
        { positionId: savings.id, amount: '8509.00' },
      ],
    });

    expect(summary).toMatchObject({ valuedOn: '2026-09-06', inserted: 2, corrected: 0 });

    const netWorth = await getNetWorth(deps(), SEPT_6);
    expect(netWorth.totalNetWorth.value?.amount).toBe('16629');
    // Ordinary snapshots, not statement balances (8.8).
    const history = await positionHistory(deps(), SEPT_6, bbva.id);
    expect(history[0]?.datePrecision).toBe('exact');
    expect(history[0]?.source).toBe('entered');
  });

  it('corrects today’s balance rather than duplicating it, and never touches history', async () => {
    const bbva = await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-08-31',
    });

    await quickUpdate(deps(), SEPT_6, { entries: [{ positionId: bbva.id, amount: '8120.00' }] });
    const second = await quickUpdate(deps(), SEPT_6, {
      entries: [{ positionId: bbva.id, amount: '8130.00' }],
    });

    expect(second).toMatchObject({ inserted: 0, corrected: 1 });

    const history = await positionHistory(deps(), SEPT_6, bbva.id);
    expect(history.map((row) => [row.valuedOn, row.amount])).toEqual([
      ['2026-09-06', '8130.00000000'],
      // The August balance is exactly as it was: quick update writes today and
      // only today.
      ['2026-08-31', '8055.00000000'],
    ]);
  });

  it('audits a same-day correction and moves its version, like any other edit', async () => {
    // The correction path writes through the same repository as every other
    // balance edit, so it must leave the same trail. Asserted separately from
    // the test above, which proves the row count and that history is untouched:
    // this one proves the correction is *recorded*, not merely applied.
    const bbva = await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-08-31',
    });

    await quickUpdate(deps(), SEPT_6, { entries: [{ positionId: bbva.id, amount: '8120.00' }] });
    const [today] = await positionHistory(deps(), SEPT_6, bbva.id);
    expect(today?.valuedOn).toBe('2026-09-06');
    expect(today?.version).toBe(1);

    await quickUpdate(deps(), SEPT_6, { entries: [{ positionId: bbva.id, amount: '8130.00' }] });

    const history = await positionHistory(deps(), SEPT_6, bbva.id);
    // Exactly one row for today, and the August row is byte-identical.
    expect(history.filter((row) => row.valuedOn === '2026-09-06')).toHaveLength(1);
    const august = history.find((row) => row.valuedOn === '2026-08-31');
    expect(august?.amount).toBe('8055.00000000');
    expect(august?.version).toBe(1);

    // Optimistic concurrency moved, so a form rendered before the correction is
    // now stale rather than silently overwriting it (20.3).
    const corrected = history.find((row) => row.valuedOn === '2026-09-06');
    expect(corrected?.version).toBe(2);
    expect(corrected?.id).toBe(today?.id);

    // …and the change is on the record, with both images (18.1).
    const audit = await auditRows(USER_A, today!.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'update']);
    const update = audit.find((row) => row.action === 'update');
    expect(update?.before).toMatchObject({ amount: '8120.00000000' });
    expect(update?.after).toMatchObject({ amount: '8130.00000000' });
    expect(update?.changed_fields).toContain('amount');

    // The August row carries only the entry from when it was written; the
    // correction did not touch it.
    expect((await auditRows(USER_A, august!.id)).map((row) => row.action)).toEqual(['insert']);
  });

  it('lands entirely or not at all', async () => {
    const bbva = await makeCashAccount(SEPT_6, { name: 'BBVA' });

    await expect(
      quickUpdate(deps(), SEPT_6, {
        entries: [
          { positionId: bbva.id, amount: '100.00' },
          // A position that is not this user's: the whole submission fails.
          { positionId: '33333333-3333-4333-8333-333333333333', amount: '200.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await positionHistory(deps(), SEPT_6, bbva.id)).toHaveLength(0);
  });

  it('aborts the whole batch on a version conflict rather than writing half of it', async () => {
    const bbva = await makeCashAccount(SEPT_6, { name: 'BBVA' });
    const savings = await makeCashAccount(SEPT_6, { name: 'Savings' });

    await quickUpdate(deps(), SEPT_6, { entries: [{ positionId: bbva.id, amount: '10.00' }] });
    const [existing] = await positionHistory(deps(), SEPT_6, bbva.id);

    await expect(
      quickUpdate(deps(), SEPT_6, {
        entries: [
          { positionId: savings.id, amount: '999.00' },
          { positionId: bbva.id, amount: '20.00', expectedVersion: existing!.version + 5 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    // Savings was first in the list and still has nothing: the transaction
    // rolled back (20.3).
    expect(await positionHistory(deps(), SEPT_6, savings.id)).toHaveLength(0);
    const bbvaHistory = await positionHistory(deps(), SEPT_6, bbva.id);
    expect(bbvaHistory[0]?.amount).toBe('10.00000000');
  });
});

describe('other assets and the two net-worth metrics (R18, M15)', () => {
  async function balanceSheet(includeCar: boolean) {
    await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    const car = await createOtherAsset(deps(), SEPT_6, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: includeCar,
      currentValue: '20000.00',
      currentValueOn: '2026-09-01',
    });
    return car;
  }

  it('puts an excluded asset in total net worth only', async () => {
    // §26 Phase 2, item 6.
    await balanceSheet(false);
    const netWorth = await getNetWorth(deps(), SEPT_6);

    expect(netWorth.totalNetWorth.value?.amount).toBe('28055');
    expect(netWorth.financialNetWorth.value?.amount).toBe('8055');
    expect(netWorth.metricsDiffer).toBe(true);
    expect(netWorth.components.otherAssetsExcluded.value?.amount).toBe('20000');
  });

  it('moves it into the headline when the flag is turned on, and total does not move', async () => {
    const car = await balanceSheet(false);
    const before = await getNetWorth(deps(), SEPT_6);

    await updateOtherAsset(deps(), SEPT_6, {
      positionId: car.id,
      expectedVersion: car.version,
      includeInFinancialNetWorth: true,
    });

    const after = await getNetWorth(deps(), SEPT_6);
    expect(after.totalNetWorth.value?.amount).toBe(before.totalNetWorth.value?.amount);
    expect(after.financialNetWorth.value?.amount).toBe('28055');
    expect(after.metricsDiffer).toBe(false);
  });

  it('is unknown, never zero, when nobody has valued it', async () => {
    await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    await createOtherAsset(deps(), SEPT_6, {
      name: 'Coin collection',
      currency: 'EUR',
      assetType: 'collectible',
      includeInFinancialNetWorth: true,
    });

    const netWorth = await getNetWorth(deps(), SEPT_6);
    expect(netWorth.totalNetWorth.availability).toBe('partial');
    expect(netWorth.totalNetWorth.value?.amount).toBe('8055');
    expect(netWorth.totalNetWorth.missing).toEqual([
      expect.objectContaining({ positionName: 'Coin collection', reason: 'no_valuation' }),
    ]);
  });

  it('refuses a negative value for anything but cash (6.2)', async () => {
    const car = await createOtherAsset(deps(), SEPT_6, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    });
    await expect(
      recordValuation(deps(), SEPT_6, {
        positionId: car.id,
        valuedOn: '2026-09-01',
        amount: '-1.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // …while a cash account may be overdrawn.
    const account = await makeCashAccount(SEPT_6, { name: 'Overdrawn' });
    const overdraft = await recordValuation(deps(), SEPT_6, {
      positionId: account.id,
      valuedOn: '2026-09-01',
      amount: '-120.00',
      datePrecision: 'exact',
    });
    expect(overdraft.amount).toBe('-120.00000000');
  });
});

describe('multi-currency totals and the FX engine (10.3, 10.4, 10.5)', () => {
  async function twoCurrencies() {
    await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      currency: 'EUR',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    return makeCashAccount(SEPT_6, {
      name: 'US checking',
      currency: 'USD',
      openingBalance: '3000.00',
      openingBalanceOn: '2026-09-01',
    });
  }

  it('converts a foreign balance and reports the rate it used', async () => {
    await twoCurrencies();
    const netWorth = await getNetWorth(deps(), SEPT_6);

    expect(netWorth.totalNetWorth.availability).toBe('available');
    const usd = netWorth.positions.find((item) => item.currency === 'USD');
    expect(usd?.value.native).toEqual({ amount: '3000', currency: 'USD' });
    expect(usd?.value.rate?.source).toBe('ecb');

    // Both native totals are kept side by side, unconverted (7.6).
    expect(netWorth.components.cash.native).toEqual([
      { amount: '8055', currency: 'EUR' },
      { amount: '3000', currency: 'USD' },
    ]);
  });

  it('fetches only the history the data needs, never decades of it', async () => {
    // ADR 0002 decision 17 and 10.4: the backfill starts a month before the
    // earliest financial date, not at the start of the reference series.
    await twoCurrencies();
    await getNetWorth(deps(), SEPT_6);

    const series = harness.fxProvider.calls.filter((call) => call.method === 'fetchTimeSeries');
    expect(series.length).toBeGreaterThan(0);
    for (const call of series) {
      // ISO dates order lexicographically, so a string comparison is the date
      // comparison — and the earliest financial date here is 1 September, so a
      // month's lookback lands in August, never in 1999.
      expect((call.from ?? '9999-12-31') >= '2026-07-01', String(call.from)).toBe(true);
      expect(call.from).not.toBe('1999-01-04');
    }
  });

  it('reports a partial total during an outage, and loses no native data', async () => {
    // §26 Phase 2, item 5, and "an FX outage must not destroy native data".
    await twoCurrencies();
    await harness.asOwner('DELETE FROM fx_rates');
    harness.fxProvider.failWith(providerOutage());

    const netWorth = await getNetWorth(deps(), SEPT_6);

    expect(netWorth.totalNetWorth.availability).toBe('partial');
    expect(netWorth.totalNetWorth.value?.amount).toBe('8055');
    expect(netWorth.totalNetWorth.missing).toEqual([
      expect.objectContaining({ positionName: 'US checking', reason: 'fx_missing' }),
    ]);

    // The dollars are still exactly three thousand dollars.
    const usd = netWorth.positions.find((item) => item.currency === 'USD');
    expect(usd?.value.native).toEqual({ amount: '3000', currency: 'USD' });
    expect(usd?.value.reporting).toBeNull();

    // And nothing was rewritten in the database by the failure.
    harness.fxProvider.failWith(null);
    const recovered = await getNetWorth(deps(), SEPT_6);
    expect(recovered.totalNetWorth.availability).toBe('available');
  });

  it('never needs a rate for a single-currency user', async () => {
    await makeCashAccount(SEPT_6, {
      name: 'BBVA',
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    await harness.asOwner('DELETE FROM fx_rates');
    harness.fxProvider.failWith(providerOutage());

    const netWorth = await getNetWorth(deps(), SEPT_6);
    expect(netWorth.totalNetWorth.availability).toBe('available');
    expect(netWorth.totalNetWorth.value?.amount).toBe('8055');
  });
});

describe('one user can never reach another’s records (17.2, 17.3)', () => {
  it('answers NOT_FOUND for every read and every write with the other user’s id', async () => {
    // §26 Phase 2, item 9. Not "forbidden": existence is never leaked (20.2).
    const account = await makeCashAccount(SEPT_6, {
      openingBalance: '8055.00',
      openingBalanceOn: '2026-09-01',
    });
    const [valuation] = await positionHistory(deps(), SEPT_6, account.id);
    const asB = on('2026-09-06', USER_B);

    await expect(getPositionDetail(deps(), asB, account.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(positionHistory(deps(), asB, account.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      recordValuation(deps(), asB, {
        positionId: account.id,
        valuedOn: '2026-09-02',
        amount: '1.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      correctValuation(deps(), asB, {
        valuationId: valuation!.id,
        expectedVersion: valuation!.version,
        valuedOn: '2026-09-01',
        amount: '1.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(removeValuation(deps(), asB, valuation!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(removePosition(deps(), asB, account.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateCashAccount(deps(), asB, {
        positionId: account.id,
        expectedVersion: account.version,
        name: 'Stolen',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // …and A's records are exactly as they were.
    const detail = await getPositionDetail(deps(), SEPT_6, account.id);
    expect(detail.position.name).toBe('BBVA checking');
    expect(detail.valuations).toHaveLength(1);

    // B's own view of the world is empty.
    const netWorthB = await getNetWorth(deps(), asB);
    expect(netWorthB.positions).toEqual([]);
    expect(netWorthB.totalNetWorth.value?.amount).toBe('0');
  });
});

describe('the month state a completed month is judged by (8.1)', () => {
  it('marks a pre-existing account’s first balance, and closes an ordinary month', async () => {
    // §26 Phase 2, item 4.
    const account = await makeCashAccount(OCT_1, { name: 'BBVA', openedOn: null });
    await recordValuation(deps(), OCT_1, {
      positionId: account.id,
      valuedOn: '2026-09-30',
      amount: '8055.00',
      datePrecision: 'month_end',
    });

    const netWorth = await getNetWorth(deps(), OCT_1);
    const position = netWorth.positions[0];
    expect(position?.lastCompletedMonth?.month).toBe('2026-09');
    expect(position?.lastCompletedMonth?.firstBalance).toBe(true);
    expect(position?.lastCompletedMonth?.close).toBe('month_end');

    // The next month, with both ends settled, is an ordinary included month.
    const nov = on('2026-11-01');
    await recordValuation(deps(), nov, {
      positionId: account.id,
      valuedOn: '2026-10-31',
      amount: '8100.00',
      datePrecision: 'month_end',
    });
    const later = await getNetWorth(deps(), nov);
    expect(later.positions[0]?.lastCompletedMonth).toMatchObject({
      month: '2026-10',
      open: 'month_end',
      close: 'month_end',
      included: true,
      firstBalance: false,
    });
  });

  it('offers no month-end surface for a month that has not ended', async () => {
    const account = await makeCashAccount(SEPT_30, { name: 'BBVA' });
    await recordValuation(deps(), SEPT_30, {
      positionId: account.id,
      valuedOn: '2026-09-30',
      amount: '8055.00',
      datePrecision: 'exact',
    });

    const onThe30th = await getPositionDetail(deps(), SEPT_30, account.id);
    expect(onThe30th.monthsAwaitingStatement.map((month) => month.month)).not.toContain('2026-09');

    const onThe1st = await getPositionDetail(deps(), OCT_1, account.id);
    const september = onThe1st.monthsAwaitingStatement.find((month) => month.month === '2026-09');
    expect(september?.confirmable?.amount).toEqual({ amount: '8055', currency: 'EUR' });
  });
});

describe('the twelve-month series (15.4)', () => {
  it('ends in a provisional point and is complete before tracking began', async () => {
    const account = await makeCashAccount(SEPT_6, { name: 'BBVA' });
    await recordValuation(deps(), SEPT_6, {
      positionId: account.id,
      valuedOn: '2026-08-31',
      amount: '8055.00',
      datePrecision: 'month_end',
    });

    const netWorth = await getNetWorth(deps(), SEPT_6);
    expect(netWorth.series).toHaveLength(13);
    expect(netWorth.series.at(-1)).toMatchObject({ asOf: '2026-09-06', provisional: true });

    const august = netWorth.series.find((point) => point.asOf === '2026-08-31');
    expect(august?.totalNetWorth.value?.amount).toBe('8055');

    const july = netWorth.series.find((point) => point.asOf === '2026-07-31');
    expect(july?.totalNetWorth.value?.amount).toBe('0');
    expect(july?.totalNetWorth.availability).toBe('available');
  });
});
