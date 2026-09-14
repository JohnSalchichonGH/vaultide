import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { listCategories } from '../../src/users/categories';
import { createCashTransfer, updateCashTransfer } from '../../src/flows/transfers';

/**
 * The cash-transfer aggregate against a real database (blueprint 6.2, 7.4, 7.5,
 * 8.1, M5, M14; ADR 0006).
 *
 * A transfer's fee is its own source fact with its own financial date (ADR 0006
 * §5). Every service call here goes straight to the application service, never
 * through the action's schema, so each rule is shown to hold where the write
 * happens rather than only where a browser's request is parsed (20.1).
 */

const USER_A = '51515151-5151-4151-8151-515151515151';
const USER_B = '62626262-6262-4262-8262-626262626262';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;
let transferFeeCategory: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const SEPT_15 = on('2026-09-15');

const deps = () => harness.services.flows;

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function account(
  name: string,
  options: { currency?: string; openedOn?: string | null } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, SEPT_15, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: options.openedOn ?? null,
  });
  return created.id;
}

interface StoredRow {
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly version: number;
}

async function storedFee(feeId: string): Promise<StoredRow | undefined> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT incurred_on::text AS date, amount::text AS amount, currency, version
            FROM expense_entries WHERE id = ${feeId}`,
    );
    return result.rows[0] as StoredRow | undefined;
  });
}

async function storedTransfer(transferId: string): Promise<StoredRow | undefined> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT occurred_on::text AS date, from_amount::text AS amount, from_currency AS currency, version
            FROM transfers WHERE id = ${transferId}`,
    );
    return result.rows[0] as StoredRow | undefined;
  });
}

/**
 * A row linked to a transfer, written below the services.
 *
 * No application path produces one: `createExpenseEntry` has no `transfer_id`,
 * and only the transfer service ever sets one. The database accepts it anyway
 * (M14 assigns the fee's shape to service design, not to a constraint), so this
 * is how a legacy or out-of-band row is represented here.
 */
async function linkedRowOutOfBand(
  transferId: string,
  values: {
    readonly categoryId: string;
    readonly settlement: 'tracked_cash' | 'untracked_self' | 'third_party';
    readonly cashPositionId: string | null;
    readonly currency: string;
  },
): Promise<string> {
  const id = randomUUID();
  await harness.asOwner(
    `INSERT INTO expense_entries
       (id, user_id, category_id, incurred_on, amount, currency, settlement, transfer_id,
        cash_position_id, cash_position_kind)
     VALUES ($1, $2, $3, DATE '2026-09-05', 1.50, $4, $5, $6, $7, $8)`,
    [
      id,
      USER_A,
      values.categoryId,
      values.currency,
      values.settlement,
      transferId,
      values.cashPositionId,
      values.cashPositionId === null ? null : 'cash',
    ],
  );
  return id;
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'transfers-a@example.test'],
    [USER_B, 'transfers-b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.name === 'Groceries')?.id as string;
  transferFeeCategory = categories.find((row) => row.kind === 'transfer_fee')?.id as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');

  bbva = await account('BBVA');
  savings = await account('Savings');
});

/* -------------------------------------------------------------------------- */
/* The fee's own date                                                          */
/* -------------------------------------------------------------------------- */

describe('an edited fee is judged on its own date', () => {
  async function transferWithFee(payer = bbva) {
    return createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: payer,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: payer,
        currency: 'EUR',
      },
    });
  }

  it('refuses a fee moved after today, and writes neither row', async () => {
    const { transfer, fee } = await transferWithFee();

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: fee?.version as number, incurredOn: '2026-09-16' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // M5 holds for the fee's own date, not only for the transfer's.
    expect(await storedFee(fee?.id as string)).toMatchObject({ date: '2026-09-05', version: 1 });
    expect(await storedTransfer(transfer.id)).toMatchObject({ date: '2026-09-05', version: 1 });
  });

  it('refuses a fee dated before its paying account opened', async () => {
    const opened = await account('Opened on the 3rd', { openedOn: '2026-09-03' });
    const { transfer, fee } = await transferWithFee(opened);

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: fee?.version as number, incurredOn: '2026-09-02' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // 8.1: a flow dated outside its account's window has no bucket to belong to.
    expect(await storedFee(fee?.id as string)).toMatchObject({ date: '2026-09-05', version: 1 });
    expect(await storedTransfer(transfer.id)).toMatchObject({ version: 1 });
  });

  it('keeps a valid fee date that differs from the transfer’s', async () => {
    const { transfer, fee } = await transferWithFee();

    const edited = await updateCashTransfer(deps(), SEPT_15, {
      transferId: transfer.id,
      expectedVersion: transfer.version,
      fee: { expectedVersion: fee?.version as number, incurredOn: '2026-09-04' },
    });

    expect(edited.transfer.occurredOn).toBe('2026-09-05');
    expect(edited.fee?.incurredOn).toBe('2026-09-04');
  });

  it('keeps a fee posted the day after a moved transfer', async () => {
    const { transfer, fee } = await transferWithFee();

    const edited = await updateCashTransfer(deps(), SEPT_15, {
      transferId: transfer.id,
      expectedVersion: transfer.version,
      occurredOn: '2026-09-06',
      fee: { expectedVersion: fee?.version as number, incurredOn: '2026-09-07' },
    });

    expect(edited.transfer.occurredOn).toBe('2026-09-06');
    expect(edited.fee?.incurredOn).toBe('2026-09-07');
  });
});

describe('an edit does not accept a linked row that breaks the fee’s rules', () => {
  async function transferWithLinkedRow(values: Parameters<typeof linkedRowOutOfBand>[1]) {
    const { transfer } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
    });
    const rowId = await linkedRowOutOfBand(transfer.id, values);
    return { transfer, rowId };
  }

  async function expectUntouched(transferId: string, rowId: string): Promise<void> {
    expect(await storedFee(rowId)).toMatchObject({ amount: '1.50000000', version: 1 });
    expect(await storedTransfer(transferId)).toMatchObject({ amount: '200.00000000', version: 1 });
  }

  it('fails closed on a linked row filed under a spending category', async () => {
    // 7.4: a category's kind is the fee's accounting meaning. Editing this row as
    // though it were a fee would keep a grocery bill inside "Interest & fees".
    const { transfer, rowId } = await transferWithLinkedRow({
      categoryId: groceries,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'EUR',
    });

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: 1, amount: '2.00' },
      }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await expectUntouched(transfer.id, rowId);
  });

  it('fails closed on a linked row somebody else paid', async () => {
    // A transfer fee is tracked cash leaving one of the transfer's own accounts
    // (ADR 0006 §6); a third-party row is no such fee.
    const { transfer, rowId } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'third_party',
      cashPositionId: null,
      currency: 'EUR',
    });

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: 1, amount: '2.00' },
      }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await expectUntouched(transfer.id, rowId);
  });

  it('refuses to keep a fee paid from an account the transfer does not touch', async () => {
    const third = await account('Third');
    const { transfer, rowId } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: third,
      currency: 'EUR',
    });

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: 1, incurredOn: '2026-09-06' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expectUntouched(transfer.id, rowId);
  });

  it('refuses to keep a fee in a currency its paying account does not hold', async () => {
    const { transfer, rowId } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'USD',
    });

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        fee: { expectedVersion: 1, incurredOn: '2026-09-06' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expectUntouched(transfer.id, rowId);
  });
});
