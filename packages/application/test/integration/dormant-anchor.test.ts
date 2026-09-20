import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { monthKeyOf } from '@vaultide/finance';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, updateCashAccount } from '../../src/positions/service';
import {
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  quickUpdate,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createCashTransfer } from '../../src/flows/transfers';
import { getMonthReconciliation } from '../../src/reconciliation/service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import { saveOrCorrect } from '../helpers/corrections';

/**
 * The dormant anchor on its write paths, against a real database (blueprint
 * 6.2, 8.8, v2.1.17 30.20; ADR 0007).
 *
 * `is_dormant` says an account is dormant now; `dormant_from` says from when,
 * and it is the date of the zero balance the episode rests on. These are the
 * rules that keep that date true: what may start an episode, that every wake
 * ends it in both columns at once, that a correction cannot leave it resting on
 * a record that is gone — and, read back through the engines, that a month
 * before it is an ordinary month.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });
const SEPT_15 = on('2026-09-15');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;
const corrections = () => harness.services.corrections;
const reads = () => ({ db: harness.db, fx: harness.services.fx });

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/** The two columns and the position's version, straight from the database. */
async function state(positionId = savings, userId = USER_A) {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT c.is_dormant AS dormant, c.dormant_from::text AS "from", p.version
            FROM cash_accounts c JOIN positions p ON p.id = c.position_id
           WHERE c.position_id = ${positionId}`,
    );
    return result.rows[0] as { dormant: boolean; from: string | null; version: number };
  });
}

const AWAKE = { dormant: false, from: null };

/**
 * Every fixture below goes through `saveOrCorrect`, which is what the interface
 * does: it asks whether the operation rewrites a closed month or a dormant
 * episode anchored in one, and takes the ordinary path or the ceremony
 * accordingly (30.22 item 1; ADR 0010 §1).
 *
 * That matters here more than anywhere else, because this suite's whole subject
 * is an episode whose anchor is months in the past. Waking one is now a
 * reviewed correction, and these tests still assert exactly what they always
 * asserted — what the episode is anchored to, what ends it, and what leaves it
 * alone — rather than being rewritten around the ceremony.
 */

/** One valuation of an account on a date, by id and version. */
async function valuationOn(positionId: string, valuedOn: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version FROM position_valuations
           WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows[0] as { id: string; version: number };
  });
}

async function balance(
  positionId: string,
  valuedOn: string,
  amount: string,
  datePrecision: 'exact' | 'month_end' = 'exact',
) {
  await saveOrCorrect(
    corrections(),
    SEPT_15,
    { kind: 'valuation_create', positionId, valuedOn, amount, datePrecision },
    () => recordValuation(positions(), SEPT_15, { positionId, valuedOn, amount, datePrecision }),
  );
  return valuationOn(positionId, valuedOn);
}

/** Mark Savings dormant as the account form does: the current version, the flag. */
async function markDormant(ctx = SEPT_15) {
  const expectedVersion = (await state()).version;
  await saveOrCorrect(
    corrections(),
    ctx,
    { kind: 'cash_account_update', positionId: savings, expectedVersion, isDormant: true },
    () => updateCashAccount(positions(), ctx, { positionId: savings, expectedVersion, isDormant: true }),
  );
  const after = await state();
  return { isDormant: after.dormant, dormantFrom: after.from };
}

/** Clear the flag the way the account form does. */
async function wakeByFlag(ctx = SEPT_15) {
  const expectedVersion = (await state()).version;
  await saveOrCorrect(
    corrections(),
    ctx,
    { kind: 'cash_account_update', positionId: savings, expectedVersion, isDormant: false },
    () => updateCashAccount(positions(), ctx, { positionId: savings, expectedVersion, isDormant: false }),
  );
}

const income = (cashPositionId: string | null, receivedOn: string) =>
  saveOrCorrect(
    corrections(),
    SEPT_15,
    {
      kind: 'income_create',
      incomeKind: 'interest',
      receivedOn,
      netAmount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId,
    },
    () =>
      createIncomeEntry(flows(), SEPT_15, {
        kind: 'interest',
        receivedOn,
        netAmount: '5.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId,
      }),
  );

const expense = (cashPositionId: string, incurredOn: string) =>
  saveOrCorrect(
    corrections(),
    SEPT_15,
    {
      kind: 'expense_create',
      categoryId: groceries,
      incurredOn,
      amount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId,
    },
    () =>
      createExpenseEntry(flows(), SEPT_15, {
        categoryId: groceries,
        incurredOn,
        amount: '5.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId,
      }),
  );

const transfer = (fromPositionId: string, toPositionId: string, occurredOn: string) =>
  saveOrCorrect(
    corrections(),
    SEPT_15,
    {
      kind: 'transfer_create',
      occurredOn,
      fromPositionId,
      toPositionId,
      fromAmount: '40.00',
      toAmount: '40.00',
    },
    () =>
      createCashTransfer(flows(), SEPT_15, {
        occurredOn,
        fromPositionId,
        toPositionId,
        fromAmount: '40.00',
        toAmount: '40.00',
      }),
  );

/** A balance corrected, through whichever path the dates make right. */
async function correctBalance(
  anchor: { id: string; version: number },
  patch: { valuedOn: string; amount: string; datePrecision: 'exact' | 'month_end'; note?: string },
) {
  await saveOrCorrect(
    corrections(),
    SEPT_15,
    { kind: 'valuation_update', valuationId: anchor.id, expectedVersion: anchor.version, ...patch },
    () =>
      correctValuation(positions(), SEPT_15, {
        valuationId: anchor.id,
        expectedVersion: anchor.version,
        ...patch,
      }),
  );
}

async function deleteBalance(anchor: { id: string; version: number }) {
  await saveOrCorrect(
    corrections(),
    SEPT_15,
    { kind: 'valuation_delete', valuationId: anchor.id, expectedVersion: anchor.version },
    () =>
      removeValuation(positions(), SEPT_15, {
        valuationId: anchor.id,
        expectedVersion: anchor.version,
      }),
  );
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');

  const make = (name: string, accountType: 'checking' | 'savings') =>
    createCashAccount(positions(), SEPT_15, { name, currency: 'EUR', accountType, openedOn: null });
  bbva = (await make('BBVA', 'checking')).id;
  savings = (await make('Savings', 'savings')).id;
  groceries = (await listCategories(harness.db, USER_A)).find((row) => row.name === 'Groceries')
    ?.id as string;
});

describe('starting an episode', () => {
  it('dates it from the zero balance, not from the day the flag was set', async () => {
    // At zero since 31 January; marked on 15 September. February to August must
    // not each need a confirmation because of when somebody clicked.
    await balance(savings, '2026-01-31', '0', 'month_end');
    const marked = await markDormant();
    expect(marked).toMatchObject({ isDormant: true, dormantFrom: '2026-01-31' });
    expect(await state()).toMatchObject({ dormant: true, from: '2026-01-31' });
  });

  it('uses the latest balance, so a later zero is the one an episode rests on', async () => {
    await balance(savings, '2026-01-31', '0', 'month_end');
    await balance(savings, '2026-04-30', '800', 'month_end');
    await balance(savings, '2026-06-30', '0', 'month_end');
    await markDormant();
    expect(await state()).toMatchObject({ dormant: true, from: '2026-06-30' });
  });

  it('refuses an account with no balance, and one whose latest balance is not zero', async () => {
    await expect(markDormant()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await balance(savings, '2026-01-31', '0', 'month_end');
    await balance(savings, '2026-04-30', '800', 'month_end');
    await expect(markDormant()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    expect(await state()).toMatchObject(AWAKE);
  });

  describe('a stale zero', () => {
    const activity: [string, () => Promise<unknown>][] = [
      ['an attributed income', () => income(savings, '2026-02-20')],
      ['an attributed expense', () => expense(savings, '2026-02-20')],
      ['a transfer out of the account', () => transfer(savings, bbva, '2026-02-20')],
      ['a transfer into the account', () => transfer(bbva, savings, '2026-02-20')],
    ];

    it.each(activity)('is refused once %s is dated after it', async (_label, record) => {
      // The old rule looked at the balance alone, so January's zero still
      // authorized dormancy in September after money had moved in February.
      await balance(savings, '2026-01-31', '0', 'month_end');
      await record();
      await expect(markDormant()).rejects.toMatchObject({
        code: 'IMPOSSIBLE_OPERATION',
        message: expect.stringContaining('2026-02-20') as string,
      });
      expect(await state()).toMatchObject(AWAKE);
    });

    it('is cured by a newer zero balance, and the episode starts there', async () => {
      await balance(savings, '2026-01-31', '0', 'month_end');
      await transfer(bbva, savings, '2026-02-20');
      await transfer(savings, bbva, '2026-03-05');
      await expect(markDormant()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });

      await balance(savings, '2026-03-31', '0', 'month_end');
      await markDormant();
      expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
    });

    it('does not count a flow dated the same day: the balance already reflects it', async () => {
      // 8.1: a valuation dated d reflects every flow dated on or before d.
      await balance(savings, '2026-03-31', '0', 'month_end');
      await transfer(savings, bbva, '2026-03-31');
      await markDormant();
      expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
    });

    it('is not made stale by a flow that names no account, or by another account’s flows', async () => {
      await balance(savings, '2026-01-31', '0', 'month_end');
      await income(null, '2026-05-10');
      await income(bbva, '2026-05-11');
      await markDormant();
      expect(await state()).toMatchObject({ dormant: true, from: '2026-01-31' });
    });
  });

  it('does not move when a dormant account is merely edited', async () => {
    // The account form sends its checkbox with every save. A rename of a
    // dormant account must not re-anchor it on a balance recorded since.
    await balance(savings, '2026-01-31', '0', 'month_end');
    await markDormant();
    await balance(savings, '2026-06-30', '0', 'month_end');

    const renamed = await updateCashAccount(positions(), SEPT_15, {
      positionId: savings,
      expectedVersion: (await state()).version,
      name: 'Old savings',
      institution: 'Somewhere',
      notes: 'kept open',
      isDormant: true,
    });
    expect(renamed).toMatchObject({ name: 'Old savings', isDormant: true, dormantFrom: '2026-01-31' });
  });

  it('keeps the edit’s optimistic concurrency, and marks nothing on a stale version', async () => {
    await balance(savings, '2026-01-31', '0', 'month_end');
    const { version } = await state();
    await updateCashAccount(positions(), SEPT_15, { positionId: savings, expectedVersion: version, name: 'Renamed' });

    await expect(
      updateCashAccount(positions(), SEPT_15, { positionId: savings, expectedVersion: version, isDormant: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await state()).toMatchObject(AWAKE);
  });

  it('cannot reach another user’s account', async () => {
    await balance(savings, '2026-01-31', '0', 'month_end');
    await expect(
      updateCashAccount(positions(), on('2026-09-15', USER_B), {
        positionId: savings,
        expectedVersion: (await state()).version,
        isDormant: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await state()).toMatchObject(AWAKE);
  });

  it('audits the transition with both columns', async () => {
    await balance(savings, '2026-01-31', '0', 'month_end');
    await markDormant();
    const rows = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT before, after FROM audit_entries
             WHERE entity_table = 'positions' AND entity_id = ${savings} AND action = 'update'`,
      );
      return result.rows as { before: Record<string, unknown>; after: Record<string, unknown> }[];
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toMatchObject({ isDormant: false, dormantFrom: null });
    expect(rows[0]?.after).toMatchObject({ isDormant: true, dormantFrom: '2026-01-31' });
  });
});

describe('waking ends the episode in both columns', () => {
  beforeEach(async () => {
    await balance(savings, '2026-03-31', '0', 'month_end');
    await markDormant();
    expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
  });

  // A linked transfer fee is an expense whose payer is one of the transfer's two
  // accounts, both of which the transfer already wakes, so it has no case of
  // its own here.
  const wakes: [string, () => Promise<unknown>][] = [
    ['an attributed income', () => income(savings, '2026-09-10')],
    ['an attributed expense', () => expense(savings, '2026-09-10')],
    ['a transfer into it', () => transfer(bbva, savings, '2026-09-10')],
    ['a transfer out of it', () => transfer(savings, bbva, '2026-09-10')],
    ['a non-zero balance', () => balance(savings, '2026-09-10', '50.00')],
    [
      'a non-zero balance from quick update',
      () =>
        saveOrCorrect(
          corrections(),
          SEPT_15,
          { kind: 'quick_update', entries: [{ positionId: savings, amount: '50.00' }] },
          () => quickUpdate(positions(), SEPT_15, { entries: [{ positionId: savings, amount: '50.00' }] }),
        ),
    ],
    ['the user clearing the flag', () => wakeByFlag()],
  ];

  it.each(wakes)('%s', async (_label, act) => {
    await act();
    expect(await state()).toMatchObject(AWAKE);
  });

  it('back-dated activity wakes it too, even dated before the episode: the conservative direction', async () => {
    await income(savings, '2026-02-02');
    expect(await state()).toMatchObject(AWAKE);
  });

  it('a back-dated non-zero balance wakes it too', async () => {
    await balance(savings, '2026-02-28', '120.00', 'month_end');
    expect(await state()).toMatchObject(AWAKE);
  });

  it('a zero balance does not, and a flow naming no account does not', async () => {
    await balance(savings, '2026-06-30', '0', 'month_end');
    await income(null, '2026-09-10');
    expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
  });

  it('is not undone by marking again: a new episode is anchored on the evidence of that moment', async () => {
    await transfer(bbva, savings, '2026-05-10');
    await transfer(savings, bbva, '2026-06-10');
    expect(await state()).toMatchObject(AWAKE);
    // March's zero is stale now; June's is what a new episode can rest on.
    await expect(markDormant()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await balance(savings, '2026-06-30', '0', 'month_end');
    await markDormant();
    expect(await state()).toMatchObject({ dormant: true, from: '2026-06-30' });
  });
});

describe('a correction cannot leave the episode resting on a record that is gone', () => {
  let anchor: { id: string; version: number };

  beforeEach(async () => {
    await balance(savings, '2026-01-31', '700', 'month_end');
    anchor = await balance(savings, '2026-03-31', '0', 'month_end');
    await markDormant();
  });

  it('deleting the anchor balance wakes the account, and nothing is re-anchored', async () => {
    await deleteBalance(anchor);
    expect(await state()).toMatchObject(AWAKE);
  });

  it('re-dating the anchor balance wakes the account, even though it is still zero', async () => {
    await correctBalance(anchor, {
      valuedOn: '2026-04-30',
      amount: '0',
      datePrecision: 'month_end',
    });
    expect(await state()).toMatchObject(AWAKE);
  });

  it('correcting the anchor balance to a non-zero amount wakes the account', async () => {
    await correctBalance(anchor, {
      valuedOn: '2026-03-31',
      amount: '12.00',
      datePrecision: 'month_end',
    });
    expect(await state()).toMatchObject(AWAKE);
  });

  it('leaves the episode alone when the anchor keeps its date and its zero', async () => {
    await correctBalance(anchor, {
      valuedOn: '2026-03-31',
      amount: '0',
      datePrecision: 'month_end',
      note: 'checked against the statement',
    });
    expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
  });

  it('leaves the episode alone when some other zero balance is deleted', async () => {
    const later = await balance(savings, '2026-06-30', '0', 'month_end');
    await deleteBalance(later);
    expect(await state()).toMatchObject({ dormant: true, from: '2026-03-31' });
  });

  it('lets the user mark it dormant again afterwards, on whatever evidence is left', async () => {
    await deleteBalance(anchor);
    // What is left is January's 700: not an account that can be dormant.
    await expect(markDormant()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });
});

describe('confirm unchanged follows the date, not the flag', () => {
  // 500 at the end of April, emptied by the end of June, dormant from there.
  // May has no statement and is before the episode; July is inside it.
  beforeEach(async () => {
    await balance(savings, '2026-04-30', '500', 'month_end');
    await balance(savings, '2026-06-30', '0', 'month_end');
    await markDormant();
  });

  it('treats a month before the episode as the ordinary month it is', async () => {
    const written = await confirmUnchanged(positions(), SEPT_15, { positionId: savings, month: '2026-05' });
    expect(written).toMatchObject({ valuedOn: '2026-05-31', amount: '500.00000000', source: 'confirmed_unchanged' });
    // Dated before the episode, so it contradicts nothing about it.
    expect(await state()).toMatchObject({ dormant: true, from: '2026-06-30' });
  });

  it('does the same through the batch action', async () => {
    const summary = await confirmUnchangedBatch(positions(), SEPT_15, { month: '2026-05', positionIds: [savings] });
    expect(summary).toMatchObject({ valuedOn: '2026-05-31', confirmed: 1 });
    expect(await state()).toMatchObject({ dormant: true, from: '2026-06-30' });
  });

  it('refuses a month the episode covers, which needs no confirmation', async () => {
    await expect(
      confirmUnchanged(positions(), SEPT_15, { positionId: savings, month: '2026-07' }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await expect(
      confirmUnchangedBatch(positions(), SEPT_15, { month: '2026-07', positionIds: [savings] }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('still requires the previous statement before the episode (R22, C7 unchanged)', async () => {
    // March has no February statement to carry forward, dormant today or not.
    await expect(
      confirmUnchanged(positions(), SEPT_15, { positionId: savings, month: '2026-03' }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });
  });
});

describe('read back through the engines', () => {
  const FEBRUARY = monthKeyOf(2026, 2);
  const APRIL = monthKeyOf(2026, 4);

  beforeEach(async () => {
    // BBVA has every statement. Savings held 5,000 through January, has no
    // February statement, sent it to BBVA on 10 March and reads zero on 31 March.
    for (const [valuedOn, amount] of [
      ['2026-01-31', '1000'], ['2026-02-28', '1000'], ['2026-03-31', '6000'], ['2026-04-30', '6000'],
    ] as const) {
      await balance(bbva, valuedOn, amount, 'month_end');
    }
    await balance(savings, '2026-01-31', '5000', 'month_end');
    await createCashTransfer(flows(), SEPT_15, {
      occurredOn: '2026-03-10',
      fromPositionId: savings,
      toPositionId: bbva,
      fromAmount: '5000.00',
      toAmount: '5000.00',
    });
    await balance(savings, '2026-03-31', '0', 'month_end');
    await markDormant();
  });

  it('keeps February unavailable rather than reporting the old balance as spending', async () => {
    const february = await getMonthReconciliation(reads(), SEPT_15, FEBRUARY);
    expect(february.status).toBe('unavailable');
    const bucket = february.buckets[0];
    expect(bucket?.totals.trackedTotalSpending).toBeNull();
    expect(bucket?.accounts.find((a) => a.positionId === savings)).toMatchObject({
      openState: 'month_end',
      closeState: 'carried',
      closing: null,
      dormant: false,
    });
    expect((await getMonthCompleteness(reads(), SEPT_15, FEBRUARY)).required).toBe(2);
  });

  it('carries April at zero, which is what the episode is for', async () => {
    const april = await getMonthReconciliation(reads(), SEPT_15, APRIL);
    expect(april.status).toBe('reliable');
    expect(april.buckets[0]?.accounts.find((a) => a.positionId === savings)).toMatchObject({
      closeState: 'dormant_zero',
      closing: { amount: '0', currency: 'EUR' },
      dormant: true,
    });
    expect((await getMonthCompleteness(reads(), SEPT_15, APRIL)).required).toBe(1);
  });
});
