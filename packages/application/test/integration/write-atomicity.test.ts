import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { withUserWrite } from '../../src/coordination';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, updateCashAccount } from '../../src/positions/service';
import {
  confirmMonthEnd,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  positionHistory,
  quickUpdate,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import {
  createExpenseEntry,
  deleteExpenseEntry,
  updateExpenseEntry,
} from '../../src/flows/expenses';
import { createIncomeEntry, deleteIncomeEntry } from '../../src/flows/income';
import { createCashTransfer, deleteCashTransfer } from '../../src/flows/transfers';

/**
 * A financial write and its consequences are one transaction, and a financial
 * delete is version-aware (blueprint 6.3, 20.3, 30.22 items 5 and 10; ADR 0010
 * §11, §15).
 *
 * Two invariants, both about what is left behind when something goes wrong:
 *
 *  - **atomicity.** The four valuation paths each have a dormancy consequence
 *    that used to commit in a second transaction. A failure between the two
 *    left an account flagged dormant over money it was holding, or awake with
 *    an anchor that no longer existed, and nothing reported it because each
 *    half succeeded. Each path is checked here as **one** outcome, and its
 *    refusal paths are checked to leave the database exactly as it was.
 *  - **stale deletes.** A delete carries the version the client rendered, so a
 *    record corrected elsewhere refuses instead of being removed — and refuses
 *    before anything is written, so the audit trail never records a deletion
 *    that did not happen.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const SEPT_15 = on('2026-09-15');
const OCT_1 = on('2026-10-01');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/** The dormant columns and the position's version, straight from the database. */
async function state(positionId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT c.is_dormant AS dormant, c.dormant_from::text AS "from", p.version
            FROM cash_accounts c JOIN positions p ON p.id = c.position_id
           WHERE c.position_id = ${positionId}`,
    );
    return result.rows[0] as { dormant: boolean; from: string | null; version: number };
  });
}

const AWAKE = { dormant: false, from: null };

async function markDormant(positionId: string, ctx = SEPT_15) {
  return updateCashAccount(positions(), ctx, {
    positionId,
    expectedVersion: (await state(positionId)).version,
    isDormant: true,
  });
}

async function countRows(table: string): Promise<number> {
  const rows = await withUser(harness.db, { userId: USER_A }, async (tx) =>
    tx.execute(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`),
  );
  return Number((rows.rows[0] as { n: string }).n);
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await withUser(harness.db, { userId: USER_A }, async (tx) =>
    tx.execute(
      sql`SELECT action FROM audit_entries WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    ),
  );
  return rows.rows.map((row) => (row as { action: string }).action);
}

const balance = (
  positionId: string,
  valuedOn: string,
  amount: string,
  datePrecision: 'exact' | 'month_end' = 'exact',
  ctx = SEPT_15,
) => recordValuation(positions(), ctx, { positionId, valuedOn, amount, datePrecision });

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });

  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.kind === 'food')?.id as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const table of [
    'expense_entries',
    'income_entries',
    'transfers',
    'position_valuations',
    'audit_entries',
  ]) {
    await harness.asOwner(`DELETE FROM ${table} WHERE user_id = $1`, [USER_A]);
  }
  await harness.asOwner('DELETE FROM cash_accounts WHERE user_id = $1', [USER_A]);
  await harness.asOwner('DELETE FROM positions WHERE user_id = $1', [USER_A]);

  bbva = (
    await createCashAccount(positions(), SEPT_15, {
      name: 'BBVA',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    })
  ).id;
  savings = (
    await createCashAccount(positions(), SEPT_15, {
      name: 'Savings',
      currency: 'EUR',
      accountType: 'savings',
      openedOn: null,
    })
  ).id;
});

/* -------------------------------------------------------------------------- */
/* The four valuation paths                                                    */
/* -------------------------------------------------------------------------- */

describe('a valuation and its dormancy consequence commit together (ADR 0010 §15)', () => {
  it('records a balance and wakes the account as one outcome', async () => {
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-03-31' });

    const written = await balance(savings, '2026-09-10', '250.00');

    expect(written.amount).toBe('250.00000000');
    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('leaves both halves untouched when the balance is refused', async () => {
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);
    await balance(savings, '2026-09-10', '0.00');

    // A second balance on a date that already has one is an ambiguity, not a
    // correction (M1) — and it must not have woken the account on the way.
    await expect(balance(savings, '2026-09-10', '900.00')).rejects.toMatchObject({
      code: 'CONFLICT_DUPLICATE',
    });
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-03-31' });
  });

  it('corrects a balance and wakes the account as one outcome', async () => {
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);
    const zero = await balance(savings, '2026-09-10', '0.00');

    await correctValuation(positions(), SEPT_15, {
      valuationId: zero.id,
      expectedVersion: zero.version,
      valuedOn: '2026-09-10',
      amount: '80.00',
      datePrecision: 'exact',
    });

    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('re-dates the anchor and ends the episode as one outcome', async () => {
    const anchor = await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);

    await correctValuation(positions(), SEPT_15, {
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      // Still zero, but no longer dated where the episode says it starts.
      valuedOn: '2026-04-30',
      amount: '0.00',
      datePrecision: 'exact',
    });

    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('leaves both halves untouched when the correction conflicts', async () => {
    const anchor = await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);

    await expect(
      correctValuation(positions(), SEPT_15, {
        valuationId: anchor.id,
        expectedVersion: anchor.version + 5,
        valuedOn: '2026-04-30',
        amount: '900.00',
        datePrecision: 'exact',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-03-31' });
    const [stored] = await positionHistory(positions(), SEPT_15, savings);
    expect(stored?.valuedOn).toBe('2026-03-31');
    expect(stored?.amount).toBe('0.00000000');
  });

  it('removes the anchor and ends the episode as one outcome', async () => {
    const anchor = await balance(savings, '2026-03-31', '0.00');
    await markDormant(savings);

    await removeValuation(positions(), SEPT_15, {
      valuationId: anchor.id,
      expectedVersion: anchor.version,
    });

    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await positionHistory(positions(), SEPT_15, savings)).toHaveLength(0);
  });

  it('quick-updates every balance and every wake in one transaction', async () => {
    await balance(bbva, '2026-03-31', '0.00');
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(bbva);
    await markDormant(savings);

    const summary = await quickUpdate(positions(), SEPT_15, {
      entries: [
        { positionId: bbva, amount: '120.00' },
        { positionId: savings, amount: '340.00' },
      ],
    });

    expect(summary.inserted).toBe(2);
    expect(await state(bbva)).toMatchObject(AWAKE);
    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('writes no balance and wakes nothing when one quick-update member conflicts', async () => {
    await balance(bbva, '2026-03-31', '0.00');
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(bbva);
    await markDormant(savings);
    // Today's row already exists for BBVA at some version.
    const today = await balance(bbva, '2026-09-15', '10.00');

    await expect(
      quickUpdate(positions(), SEPT_15, {
        entries: [
          { positionId: bbva, amount: '120.00', expectedVersion: today.version + 3 },
          { positionId: savings, amount: '340.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    // The first entry's wake and the second entry's balance are both rolled
    // back: before, the wakes ran after the batch had already committed.
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-03-31' });
    const savingsRows = await positionHistory(positions(), SEPT_15, savings);
    expect(savingsRows.map((row) => row.valuedOn)).toEqual(['2026-03-31']);
  });

  it('wakes BBVA only where the quick update actually put money in it', async () => {
    await balance(bbva, '2026-03-31', '0.00');
    await balance(savings, '2026-03-31', '0.00');
    await markDormant(bbva);
    await markDormant(savings);

    await quickUpdate(positions(), SEPT_15, {
      entries: [
        { positionId: bbva, amount: '0.00' },
        { positionId: savings, amount: '340.00' },
      ],
    });

    // A zero is not money: the episode stands (6.2, R22).
    expect(await state(bbva)).toMatchObject({ dormant: true, from: '2026-03-31' });
    expect(await state(savings)).toMatchObject(AWAKE);
  });
});

describe('the confirm paths have no dormancy consequence to repair', () => {
  it('confirms a last-day snapshot as a statement without touching dormancy', async () => {
    await balance(bbva, '2026-09-30', '500.00', 'exact', OCT_1);
    const [snapshot] = await positionHistory(positions(), OCT_1, bbva);

    const confirmed = await confirmMonthEnd(positions(), OCT_1, {
      valuationId: snapshot!.id,
      expectedVersion: snapshot!.version,
    });

    expect(confirmed.datePrecision).toBe('month_end');
    expect(confirmed.amount).toBe('500.00000000');
    expect(await state(bbva)).toMatchObject(AWAKE);
  });

  it('confirms a month unchanged from the previous statement, and writes nothing else', async () => {
    await balance(bbva, '2026-08-31', '500.00', 'month_end', OCT_1);

    const created = await confirmUnchanged(positions(), OCT_1, {
      positionId: bbva,
      month: '2026-09',
    });

    expect(created.amount).toBe('500.00000000');
    expect(created.source).toBe('confirmed_unchanged');
    expect(await state(bbva)).toMatchObject(AWAKE);
  });

  it('confirms a batch or nothing at all', async () => {
    await balance(bbva, '2026-08-31', '500.00', 'month_end', OCT_1);
    // Savings has no previous statement, so the batch must refuse entirely.
    await expect(
      confirmUnchangedBatch(positions(), OCT_1, {
        month: '2026-09',
        positionIds: [bbva, savings],
      }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });

    expect(
      (await positionHistory(positions(), OCT_1, bbva)).map((row) => row.valuedOn),
    ).toEqual(['2026-08-31']);
    expect(await positionHistory(positions(), OCT_1, savings)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Stale deletes                                                               */
/* -------------------------------------------------------------------------- */

describe('a financial delete carries the version the client saw (30.22 item 10)', () => {
  it('deletes a balance at its rendered version, and refuses a stale one', async () => {
    const written = await balance(bbva, '2026-09-10', '100.00');

    await expect(
      removeValuation(positions(), SEPT_15, {
        valuationId: written.id,
        expectedVersion: written.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await positionHistory(positions(), SEPT_15, bbva)).toHaveLength(1);
    expect(await auditActions(written.id)).toEqual(['insert']);

    await removeValuation(positions(), SEPT_15, {
      valuationId: written.id,
      expectedVersion: written.version,
    });
    expect(await positionHistory(positions(), SEPT_15, bbva)).toHaveLength(0);
  });

  it('refuses a balance delete once the balance has been corrected', async () => {
    const written = await balance(bbva, '2026-09-10', '100.00');
    const corrected = await correctValuation(positions(), SEPT_15, {
      valuationId: written.id,
      expectedVersion: written.version,
      valuedOn: '2026-09-10',
      amount: '110.00',
      datePrecision: 'exact',
    });

    await expect(
      removeValuation(positions(), SEPT_15, {
        valuationId: written.id,
        expectedVersion: written.version,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    const [stored] = await positionHistory(positions(), SEPT_15, bbva);
    expect(stored?.amount).toBe('110.00000000');
    expect(await auditActions(corrected.id)).toEqual(['insert', 'update']);
  });

  it('refuses a stale income delete and keeps the row', async () => {
    const created = await createIncomeEntry(flows(), SEPT_15, {
      kind: 'employment',
      receivedOn: '2026-09-10',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    await expect(
      deleteIncomeEntry(flows(), SEPT_15, {
        entryId: created.id,
        expectedVersion: created.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await countRows('income_entries')).toBe(1);
    expect(await auditActions(created.id)).toEqual(['insert']);

    await deleteIncomeEntry(flows(), SEPT_15, {
      entryId: created.id,
      expectedVersion: created.version,
    });
    expect(await countRows('income_entries')).toBe(0);
  });

  it('refuses a stale expense delete and keeps the row', async () => {
    const created = await createExpenseEntry(flows(), SEPT_15, {
      categoryId: groceries,
      incurredOn: '2026-09-10',
      amount: '40.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    const corrected = await updateExpenseEntry(flows(), SEPT_15, {
      entryId: created.id,
      expectedVersion: created.version,
      amount: '45.00',
    });

    await expect(
      deleteExpenseEntry(flows(), SEPT_15, {
        entryId: created.id,
        expectedVersion: created.version,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await countRows('expense_entries')).toBe(1);
    expect(await auditActions(created.id)).toEqual(['insert', 'update']);

    await deleteExpenseEntry(flows(), SEPT_15, {
      entryId: corrected.id,
      expectedVersion: corrected.version,
    });
    expect(await countRows('expense_entries')).toBe(0);
  });

  it('refuses a whole transfer delete when its fee changed after the render', async () => {
    const saved = await createCashTransfer(flows(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' },
    });

    await expect(
      deleteCashTransfer(flows(), SEPT_15, {
        transferId: saved.transfer.id,
        expectedVersion: saved.transfer.version,
        expectedFee: {
          state: 'version',
          feeId: saved.fee!.id,
          version: saved.fee!.version + 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    // Neither half is taken down, and neither half is audited as gone.
    expect(await countRows('transfers')).toBe(1);
    expect(await countRows('expense_entries')).toBe(1);
    expect(await auditActions(saved.transfer.id)).toEqual(['insert']);
    expect(await auditActions(saved.fee!.id)).toEqual(['insert']);
  });

  it('refuses a transfer delete that expected no fee when there is one', async () => {
    const saved = await createCashTransfer(flows(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' },
    });

    await expect(
      deleteCashTransfer(flows(), SEPT_15, {
        transferId: saved.transfer.id,
        expectedVersion: saved.transfer.version,
        expectedFee: { state: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await countRows('transfers')).toBe(1);
    expect(await countRows('expense_entries')).toBe(1);
  });

  it('refuses a transfer delete at a stale transfer version', async () => {
    const saved = await createCashTransfer(flows(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
    });

    await expect(
      deleteCashTransfer(flows(), SEPT_15, {
        transferId: saved.transfer.id,
        expectedVersion: saved.transfer.version + 1,
        expectedFee: { state: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await countRows('transfers')).toBe(1);

    const removed = await deleteCashTransfer(flows(), SEPT_15, {
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      expectedFee: { state: 'absent' },
    });
    expect(removed.transfer.id).toBe(saved.transfer.id);
    expect(await countRows('transfers')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The precursor a future Historical Confirm depends on                        */
/* -------------------------------------------------------------------------- */

describe('a write transaction holds every other financial writer of the user out', () => {
  it('stops a second mutation reaching its decision section until the first ends', async () => {
    // What a later two-step ceremony needs: a transaction that reads financial
    // evidence, decides from it and writes, with no participating writer able
    // to commit in between (ADR 0010 §3, §12).
    await balance(bbva, '2026-09-10', '100.00');

    const entered = deferred();
    const release = deferred();
    const firstWrite = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
      const before = await tx.execute(
        sql`SELECT amount::text AS amount FROM position_valuations
             WHERE position_id = ${bbva} AND valued_on = DATE '2026-09-10'`,
      );
      entered.resolve();
      await release.promise;
      await tx.execute(
        sql`UPDATE position_valuations SET amount = 500
             WHERE position_id = ${bbva} AND valued_on = DATE '2026-09-10'`,
      );
      return (before.rows[0] as { amount: string }).amount;
    });

    let secondCommitted = false;
    let second: Promise<unknown> | undefined;
    try {
      await entered.promise;

      second = createIncomeEntry(flows(), SEPT_15, {
        kind: 'employment',
        receivedOn: '2026-09-11',
        netAmount: '2100.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }).then((row) => {
        secondCommitted = true;
        return row;
      });

      await delay(250);
      expect(secondCommitted).toBe(false);
      expect(await countRows('income_entries')).toBe(0);
    } finally {
      release.resolve();
    }

    expect(await firstWrite).toBe('100.00000000');
    await second;
    expect(secondCommitted).toBe(true);
    expect(await countRows('income_entries')).toBe(1);
  });
});
