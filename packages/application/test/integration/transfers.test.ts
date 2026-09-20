import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { providerOutage } from '../helpers/stub-fx-provider';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  createCashAccount,
  createOtherAsset,
  updateCashAccount,
} from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import {
  createCashTransfer,
  deleteCashTransfer,
  updateCashTransfer,
  type TransferWithFee,
  type DeleteTransferArgs,
  type UpdateTransferArgs,
} from '../../src/flows/transfers';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import { getMonthSavings } from '../../src/reconciliation/savings-service';
import { getMonthReportingCashFlow } from '../../src/reconciliation/reporting-service';

/**
 * The cash-transfer aggregate against a real database (blueprint 6.2, 7.4, 7.5,
 * 8.1, 8.8, 10.4, M5, M13, M14, 20.3; ADR 0006).
 *
 * A transfer and its fee are saved as one aggregate, and the fee is its own
 * source fact with its own financial date. Every call here goes straight to the
 * application service, never through the action's schema, so each rule is shown
 * to hold where the write happens rather than only where a browser's request is
 * parsed (20.1).
 *
 * "Nothing changed" is asserted by reading the rows back and comparing them
 * whole, so a refusal that half-wrote something cannot pass for one that wrote
 * nothing.
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
const NOV_5 = on('2026-11-05');
const SEPTEMBER = parseMonth('2026-09');
const OCTOBER = parseMonth('2026-10');

const deps = () => harness.services.flows;
const readDeps = () => ({ db: harness.db, fx: harness.services.fx });

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
  options: { currency?: string; openedOn?: string | null; userId?: string } = {},
): Promise<string> {
  const created = await createCashAccount(
    harness.services.positions,
    on('2026-09-15', options.userId ?? USER_A),
    {
      name,
      currency: options.currency ?? 'EUR',
      accountType: 'checking',
      openedOn: options.openedOn ?? null,
    },
  );
  return created.id;
}

interface StoredTransfer {
  readonly occurred_on: string;
  readonly from_position_id: string | null;
  readonly to_position_id: string | null;
  readonly from_currency: string;
  readonly to_currency: string;
  readonly from_amount: string;
  readonly to_amount: string;
  readonly description: string | null;
  readonly tags: string[];
  readonly version: number;
}

async function storedTransfer(transferId: string): Promise<StoredTransfer | undefined> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT occurred_on::text AS occurred_on, from_position_id, to_position_id,
                 from_currency, to_currency, from_amount::text AS from_amount,
                 to_amount::text AS to_amount, description, tags, version
            FROM transfers WHERE id = ${transferId}`,
    );
    return result.rows[0] as StoredTransfer | undefined;
  });
}

interface StoredFee {
  readonly id: string;
  readonly category_id: string;
  readonly incurred_on: string;
  readonly amount: string;
  readonly currency: string;
  readonly settlement: string;
  readonly cash_position_id: string | null;
  readonly description: string | null;
  readonly version: number;
}

async function feesOf(transferId: string): Promise<StoredFee[]> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, category_id, incurred_on::text AS incurred_on, amount::text AS amount,
                 currency, settlement::text AS settlement, cash_position_id, description, version
            FROM expense_entries WHERE transfer_id = ${transferId} ORDER BY id`,
    );
    return result.rows as unknown as StoredFee[];
  });
}

async function countRows(table: 'transfers' | 'expense_entries' | 'audit_entries'): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    return (result.rows[0] as { n: number }).n;
  });
}

async function auditActions(entityId: string): Promise<string[]> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action FROM audit_entries WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    );
    return (result.rows as { action: string }[]).map((row) => row.action);
  });
}

async function auditBefore(entityId: string, action: 'update' | 'delete'): Promise<unknown> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT before FROM audit_entries WHERE entity_id = ${entityId} AND action = ${action}`,
    );
    return (result.rows[0] as { before: unknown } | undefined)?.before;
  });
}

/**
 * A dormant episode rests on a zero balance that no attributed flow post-dates
 * (8.8, v2.1.17 30.20), so an account that has already taken part in a transfer
 * needs its zero dated on or after that transfer.
 */
async function makeDormant(positionId: string, zeroOn = '2026-09-01'): Promise<void> {
  await recordValuation(harness.services.positions, SEPT_15, {
    positionId,
    valuedOn: zeroOn,
    amount: '0',
    datePrecision: 'exact',
  });
  const version = await withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT version FROM positions WHERE id = ${positionId}`);
    return (result.rows[0] as { version: number }).version;
  });
  await updateCashAccount(harness.services.positions, SEPT_15, {
    positionId,
    expectedVersion: version,
    isDormant: true,
  });
}

async function isDormant(positionId: string): Promise<boolean> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT is_dormant FROM cash_accounts WHERE position_id = ${positionId}`,
    );
    return (result.rows[0] as { is_dormant: boolean }).is_dormant;
  });
}

/**
 * A database barrier rather than a sleep: any matching write on `table` raises,
 * so whatever the service wrote before it in the same transaction must roll
 * back with it.
 */
async function withBlockedWrite<T>(
  table: 'cash_accounts' | 'expense_entries',
  event: 'INSERT' | 'UPDATE',
  body: () => Promise<T>,
): Promise<T> {
  await harness.asOwner(
    `CREATE OR REPLACE FUNCTION test_block_write() RETURNS trigger
       LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'write blocked'; END $fn$`,
  );
  await harness.asOwner(
    `CREATE TRIGGER test_block_write BEFORE ${event} ON ${table}
       FOR EACH ROW EXECUTE FUNCTION test_block_write()`,
  );
  try {
    return await body();
  } finally {
    await harness.asOwner(`DROP TRIGGER IF EXISTS test_block_write ON ${table}`);
    await harness.asOwner('DROP FUNCTION IF EXISTS test_block_write()');
  }
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
    readonly incurredOn?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await harness.asOwner(
    `INSERT INTO expense_entries
       (id, user_id, category_id, incurred_on, amount, currency, settlement, transfer_id,
        cash_position_id, cash_position_kind)
     VALUES ($1, $2, $3, $4, 1.50, $5, $6, $7, $8, $9)`,
    [
      id,
      USER_A,
      values.categoryId,
      values.incurredOn ?? '2026-09-05',
      values.currency,
      values.settlement,
      transferId,
      values.cashPositionId,
      values.cashPositionId === null ? null : 'cash',
    ],
  );
  return id;
}

/**
 * The correction a client holding `saved` would send if it changed nothing:
 * the whole aggregate as stored, and exactly what it saw of the fee.
 */
function correction(saved: TransferWithFee, over: Partial<UpdateTransferArgs> = {}): UpdateTransferArgs {
  const { transfer, fee } = saved;
  return {
    transferId: transfer.id,
    expectedVersion: transfer.version,
    occurredOn: transfer.occurredOn,
    fromPositionId: transfer.fromPositionId as string,
    toPositionId: transfer.toPositionId as string,
    fromAmount: transfer.fromAmount,
    toAmount: transfer.toAmount,
    description: transfer.description,
    fee:
      fee === null
        ? null
        : { amount: fee.amount, cashPositionId: fee.cashPositionId as string, incurredOn: fee.incurredOn },
    expectedFee: fee === null ? { state: 'absent' } : { state: 'version', feeId: fee.id, version: fee.version },
    ...over,
  };
}

/**
 * A delete's input: the aggregate as the caller was shown it (30.22 item 10).
 *
 * The same shape the dialog builds — the transfer's version, and what it saw of
 * the fee — so a test deletes what it created rather than whatever is there.
 */
function removal(saved: TransferWithFee, over: Partial<DeleteTransferArgs> = {}): DeleteTransferArgs {
  const { transfer, fee } = saved;
  return {
    transferId: transfer.id,
    expectedVersion: transfer.version,
    expectedFees: fee === null ? [] : [{ feeId: fee.id, version: fee.version }],
    ...over,
  };
}

/** A euro transfer BBVA → Savings on 5 September, with a 1.50 fee from BBVA unless told otherwise. */
async function eurTransfer(
  options: { fee?: { amount?: string; incurredOn?: string; payer?: string } | null; ctx?: RequestContext; occurredOn?: string } = {},
): Promise<TransferWithFee> {
  const fee = options.fee === undefined ? {} : options.fee;
  return createCashTransfer(deps(), options.ctx ?? SEPT_15, {
    occurredOn: options.occurredOn ?? '2026-09-05',
    fromPositionId: bbva,
    toPositionId: savings,
    fromAmount: '200.00',
    toAmount: '200.00',
    ...(fee === null
      ? {}
      : {
          fee: {
            amount: fee.amount ?? '1.50',
            cashPositionId: fee.payer ?? bbva,
            incurredOn: fee.incurredOn ?? options.occurredOn ?? '2026-09-05',
          },
        }),
  });
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
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');
  harness.fxProvider.reset();

  bbva = await account('BBVA');
  savings = await account('Savings');
});

/* -------------------------------------------------------------------------- */
/* Recording                                                                   */
/* -------------------------------------------------------------------------- */

describe('recording a cash transfer', () => {
  it('records a same-currency transfer in its accounts’ currency, with no fee and no expense', async () => {
    const { transfer, fee } = await eurTransfer({ fee: null });

    expect(transfer).toMatchObject({
      kind: 'cash_transfer',
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      fromCurrency: 'EUR',
      fromAmount: '200.00000000',
      toPositionId: savings,
      toCurrency: 'EUR',
      toAmount: '200.00000000',
      templateId: null,
      occurrenceDate: null,
    });
    expect(fee).toBeNull();
    // A transfer is neither income nor spending: no expense row stands for it.
    expect(await countRows('expense_entries')).toBe(0);
    expect(await auditActions(transfer.id)).toEqual(['insert']);
  });

  it('keeps both native amounts across currencies, deriving neither from a rate', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    await harness.asOwner('DELETE FROM fx_rates');

    const { transfer } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
    });

    expect(transfer).toMatchObject({
      fromCurrency: 'EUR',
      fromAmount: '200.00000000',
      toCurrency: 'USD',
      toAmount: '216.45000000',
    });
  });

  it('refuses the same account on both sides', async () => {
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: bbva,
        fromAmount: '200.00',
        toAmount: '200.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await countRows('transfers')).toBe(0);
  });

  it('refuses two different amounts within one currency', async () => {
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '190.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a transfer dated after today', async () => {
    await expect(eurTransfer({ fee: null, occurredOn: '2026-09-16' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await countRows('transfers')).toBe(0);
  });

  it('refuses an endpoint that is not open on the transfer’s date', async () => {
    const later = await account('Opened on the 10th', { openedOn: '2026-09-10' });
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: later,
        fromAmount: '50.00',
        toAmount: '50.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses another user’s account without saying it exists', async () => {
    const theirs = await account('Theirs', { userId: USER_B });
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: theirs,
        fromAmount: '50.00',
        toAmount: '50.00',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an endpoint that is not a cash account', async () => {
    const car = await createOtherAsset(harness.services.positions, SEPT_15, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
      currentValue: '9000.00',
      currentValueOn: '2026-09-10',
    });
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-12',
        fromPositionId: bbva,
        toPositionId: car.id,
        fromAmount: '50.00',
        toAmount: '50.00',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('recording a transfer’s fee', () => {
  it('files it under the protected category, as tracked cash in its payer’s currency, on its own date', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });

    const { transfer, fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
      // Charged the day before the transfer, by the receiving side.
      fee: { amount: '1.62', cashPositionId: dollars, incurredOn: '2026-09-04' },
    });

    expect(fee).toMatchObject({
      transferId: transfer.id,
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: dollars,
      currency: 'USD',
      amount: '1.62000000',
      incurredOn: '2026-09-04',
      description: null,
    });
    expect(transfer.occurredOn).toBe('2026-09-05');
    expect(await feesOf(transfer.id)).toHaveLength(1);
    expect(await auditActions(fee?.id as string)).toEqual(['insert']);
  });

  it('refuses a fee dated after today, writing neither row', async () => {
    await expect(eurTransfer({ fee: { incurredOn: '2026-09-16' } })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await countRows('transfers')).toBe(0);
    expect(await countRows('expense_entries')).toBe(0);
  });

  it('refuses a fee dated before its payer opened, even when the transfer’s own date is fine', async () => {
    const opened = await account('Opened on the 5th', { openedOn: '2026-09-05' });
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: opened,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '200.00',
        fee: { amount: '1.50', cashPositionId: opened, incurredOn: '2026-09-04' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await countRows('transfers')).toBe(0);
  });

  it('fails closed, writing nothing, unless there is exactly one live transfer-fee category', async () => {
    const attempt = () => eurTransfer({ fee: {} });

    // Archived: system categories are never archivable (6.2).
    await harness.asOwner('UPDATE categories SET archived_at = now() WHERE id = $1', [transferFeeCategory]);
    try {
      await expect(attempt()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    } finally {
      await harness.asOwner('UPDATE categories SET archived_at = NULL WHERE id = $1', [transferFeeCategory]);
    }

    // Two of them: never created a second time (6.2), so nothing may choose one.
    await harness.asOwner(
      `INSERT INTO categories (user_id, kind, name) VALUES ($1, 'transfer_fee', 'Wire fees')`,
      [USER_A],
    );
    try {
      await expect(attempt()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
      // A transfer with no fee needs no category, and is recorded as usual.
      await expect(eurTransfer({ fee: null })).resolves.toMatchObject({ fee: null });
    } finally {
      await harness.asOwner(`DELETE FROM categories WHERE user_id = $1 AND name = 'Wire fees'`, [USER_A]);
    }

    // None at all.
    await harness.asOwner(`UPDATE categories SET kind = 'general' WHERE id = $1`, [transferFeeCategory]);
    try {
      await expect(attempt()).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    } finally {
      await harness.asOwner(`UPDATE categories SET kind = 'transfer_fee' WHERE id = $1`, [transferFeeCategory]);
    }

    expect(await countRows('transfers')).toBe(1);
    expect(await countRows('expense_entries')).toBe(0);
  });

  it('writes no transfer when its fee cannot be written', async () => {
    await withBlockedWrite('expense_entries', 'INSERT', async () => {
      await expect(eurTransfer({ fee: {} })).rejects.toThrow();
    });
    expect(await countRows('transfers')).toBe(0);
  });
});

describe('dormancy on a recorded transfer', () => {
  it('is cleared on both endpoints, audited, in the transfer’s own transaction', async () => {
    await makeDormant(bbva);
    await makeDormant(savings);

    await eurTransfer({ fee: null });

    expect(await isDormant(bbva)).toBe(false);
    expect(await isDormant(savings)).toBe(false);
    expect(await auditActions(bbva)).toContain('update');
    expect(await auditActions(savings)).toContain('update');
  });

  it('leaves no transfer behind when the clear cannot be written', async () => {
    await makeDormant(savings);
    await withBlockedWrite('cash_accounts', 'UPDATE', async () => {
      await expect(eurTransfer({ fee: {} })).rejects.toThrow();
    });
    expect(await countRows('transfers')).toBe(0);
    expect(await countRows('expense_entries')).toBe(0);
    expect(await isDormant(savings)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Correcting                                                                  */
/* -------------------------------------------------------------------------- */

describe('correcting a cash transfer as one aggregate', () => {
  it('moves the transfer inside its month and leaves the fee on its own date', async () => {
    const saved = await eurTransfer({ fee: { incurredOn: '2026-09-04' } });

    const moved = await updateCashTransfer(deps(), SEPT_15, correction(saved, { occurredOn: '2026-09-12' }));

    expect(moved.transfer.occurredOn).toBe('2026-09-12');
    expect(moved.transfer.version).toBe(saved.transfer.version + 1);
    // ADR 0006 §5: the fee is its own source fact, and nothing moved it.
    expect(moved.fee).toMatchObject({ incurredOn: '2026-09-04', version: saved.fee?.version });
  });

  it('corrects each endpoint to another account holding the same currency', async () => {
    const caixa = await account('Caixa');
    const revolut = await account('Revolut', { currency: 'USD' });
    const wise = await account('Wise', { currency: 'USD' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: revolut,
      fromAmount: '200.00',
      toAmount: '216.45',
    });

    await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fromPositionId: caixa, toPositionId: wise }),
    );

    expect(await storedTransfer(saved.transfer.id)).toMatchObject({
      from_position_id: caixa,
      from_currency: 'EUR',
      from_amount: '200.00000000',
      to_position_id: wise,
      to_currency: 'USD',
      to_amount: '216.45000000',
    });
  });

  it('refuses an endpoint holding another currency, and writes nothing', async () => {
    const revolut = await account('Revolut', { currency: 'USD' });
    const wise = await account('Wise', { currency: 'USD' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: revolut,
      fromAmount: '200.00',
      toAmount: '216.45',
    });
    const before = await storedTransfer(saved.transfer.id);

    // The euro leg pointed at a dollar account would turn 200 EUR into 200 USD.
    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { fromPositionId: wise })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', fieldErrors: { fromPositionId: expect.any(Array) } });
    expect(await storedTransfer(saved.transfer.id)).toEqual(before);
  });

  it('refuses the same account on both sides', async () => {
    const saved = await eurTransfer({ fee: null });
    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { toPositionId: bbva })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses two different amounts within one currency', async () => {
    const saved = await eurTransfer({ fee: null });
    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { fromAmount: '210.00' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('corrects both native amounts of a cross-currency transfer independently', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
    });

    const corrected = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fromAmount: '250.00', toAmount: '270.10' }),
    );

    expect(corrected.transfer).toMatchObject({ fromAmount: '250.00000000', toAmount: '270.10000000' });
  });

  it('sets and clears the description, and keeps the tags it does not edit', async () => {
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      description: 'Rent share',
      tags: ['rent', 'shared'],
    });

    const described = await updateCashTransfer(deps(), SEPT_15, correction(saved, { description: 'Deposit' }));
    expect(described.transfer).toMatchObject({ description: 'Deposit', tags: ['rent', 'shared'] });

    const cleared = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction({ ...saved, transfer: described.transfer }, { description: null }),
    );
    expect(cleared.transfer).toMatchObject({ description: null, tags: ['rent', 'shared'] });
  });

  it('clears dormancy on the final endpoints, and restores none on the account it left', async () => {
    await makeDormant(savings);
    const saved = await eurTransfer({ fee: null });
    expect(await isDormant(savings)).toBe(false);

    const spare = await account('Spare');
    await makeDormant(spare);

    await updateCashTransfer(deps(), SEPT_15, correction(saved, { toPositionId: spare }));

    expect(await isDormant(spare)).toBe(false);
    // 8.8: moving the flow away from Savings does not re-make its assertion.
    expect(await isDormant(savings)).toBe(false);
  });

  it('rolls the whole save back when the transfer changed elsewhere', async () => {
    const saved = await eurTransfer();
    await updateCashTransfer(deps(), SEPT_15, correction(saved, { fromAmount: '300.00', toAmount: '300.00' }));
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    // Refused before any fee is written: an attempted fee update would raise
    // here instead of the conflict.
    await withBlockedWrite('expense_entries', 'UPDATE', async () => {
      await expect(
        updateCashTransfer(
          deps(),
          SEPT_15,
          correction(saved, {
            occurredOn: '2026-09-07',
            fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    });

    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('writes only the rows whose facts changed', async () => {
    const saved = await eurTransfer();

    const described = await updateCashTransfer(deps(), SEPT_15, correction(saved, { description: 'Moved' }));
    expect(described.transfer.version).toBe(saved.transfer.version + 1);
    // Correcting the transfer alone does not touch its fee.
    expect(described.fee?.version).toBe(saved.fee?.version);
    expect(await auditActions(saved.fee?.id as string)).toEqual(['insert']);

    const feeOnly = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(
        { transfer: described.transfer, fee: described.fee },
        { fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' } },
      ),
    );
    expect(feeOnly.transfer.version).toBe(described.transfer.version);
    expect(feeOnly.fee?.version).toBe((saved.fee?.version as number) + 1);
    expect(await auditActions(saved.transfer.id)).toEqual(['insert', 'update']);

    // A save that changes nothing writes nothing, and says it wrote nothing.
    const unchanged = await updateCashTransfer(deps(), SEPT_15, correction(feeOnly));
    expect(unchanged.transfer.version).toBe(feeOnly.transfer.version);
    expect(unchanged.fee?.version).toBe(feeOnly.fee?.version);
  });
});

describe('the fee’s lifecycle inside a correction', () => {
  it('adds a forgotten fee, filed and dated as its own row', async () => {
    const saved = await eurTransfer({ fee: null });

    const added = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '2.00', cashPositionId: savings, incurredOn: '2026-09-06' } }),
    );

    expect(added.fee).toMatchObject({
      transferId: saved.transfer.id,
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: savings,
      currency: 'EUR',
      amount: '2.00000000',
      incurredOn: '2026-09-06',
    });
    expect(added.transfer.version).toBe(saved.transfer.version);
    expect(await auditActions(added.fee?.id as string)).toEqual(['insert']);
  });

  it('corrects the fee’s amount against its version', async () => {
    const saved = await eurTransfer();
    const corrected = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '2.50', cashPositionId: bbva, incurredOn: '2026-09-05' } }),
    );
    expect(corrected.fee).toMatchObject({ amount: '2.50000000', version: (saved.fee?.version as number) + 1 });
    expect(await auditActions(saved.fee?.id as string)).toEqual(['insert', 'update']);
  });

  it('moves the fee to the other endpoint', async () => {
    const saved = await eurTransfer();
    const moved = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '1.50', cashPositionId: savings, incurredOn: '2026-09-05' } }),
    );
    expect(moved.fee).toMatchObject({ cashPositionId: savings, currency: 'EUR' });
  });

  it('takes its new payer’s currency when the fee moves to the other side of a cross-currency transfer', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' },
    });

    const moved = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '1.62', cashPositionId: dollars, incurredOn: '2026-09-05' } }),
    );

    expect(moved.fee).toMatchObject({ cashPositionId: dollars, currency: 'USD', amount: '1.62000000' });
  });

  it('moves the fee to its own date in the next month, leaving the transfer where it was', async () => {
    const saved = await eurTransfer({ ctx: NOV_5, occurredOn: '2026-09-30' });

    const moved = await updateCashTransfer(
      deps(),
      NOV_5,
      correction(saved, { fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-10-01' } }),
    );

    expect(moved.fee?.incurredOn).toBe('2026-10-01');
    expect(moved.transfer).toMatchObject({ occurredOn: '2026-09-30', version: saved.transfer.version });
  });

  it('removes the fee and keeps the transfer, leaving the fee’s before-image', async () => {
    const saved = await eurTransfer();

    const removed = await updateCashTransfer(deps(), SEPT_15, correction(saved, { fee: null }));

    expect(removed.fee).toBeNull();
    expect(await storedTransfer(saved.transfer.id)).toBeDefined();
    expect(await feesOf(saved.transfer.id)).toEqual([]);
    expect(await auditActions(saved.fee?.id as string)).toEqual(['insert', 'delete']);
    expect(await auditBefore(saved.fee?.id as string, 'delete')).toMatchObject({ amount: '1.50000000' });
  });

  it('rolls the whole save back when the fee changed elsewhere', async () => {
    const saved = await eurTransfer();
    await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '3.00', cashPositionId: bbva, incurredOn: '2026-09-05' } }),
    );
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    // The other view still holds the fee at its first version.
    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { occurredOn: '2026-09-09' })),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('rolls the whole save back when a fee appeared after the caller saw none', async () => {
    const saved = await eurTransfer({ fee: null });
    await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' } }),
    );
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { description: 'Stale view' })),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    // Neither a second fee nor the stale description: nothing from that save.
    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('rolls the whole save back when the fee it saw has been removed', async () => {
    const saved = await eurTransfer();
    await updateCashTransfer(deps(), SEPT_15, correction(saved, { fee: null }));
    const transferBefore = await storedTransfer(saved.transfer.id);

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, { fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' } }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await feesOf(saved.transfer.id)).toEqual([]);
    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
  });

  it('rolls the whole save back when the fee it saw was removed and another added in its place', async () => {
    // 20.3's ABA case. Removing a fee and adding another are fee-only saves, so
    // the transfer keeps its version, and the new row starts at the version the
    // removed one had. Only the fee's id tells the two apart.
    const saved = await eurTransfer();
    const first = { id: saved.fee?.id as string, version: saved.fee?.version as number };
    expect(first.version).toBe(1);

    // What the stale view could send: a correction of the fee it saw, or its removal.
    const staleSaves = [
      correction(saved, {
        description: 'Stale view',
        fee: { amount: '9.00', cashPositionId: savings, incurredOn: '2026-09-04' },
      }),
      correction(saved, { description: 'Stale view', fee: null }),
    ];
    for (const stale of staleSaves) {
      expect(stale).toMatchObject({
        expectedVersion: saved.transfer.version,
        expectedFee: { state: 'version', feeId: first.id, version: first.version },
      });
    }

    const removed = await updateCashTransfer(deps(), SEPT_15, correction(saved, { fee: null }));
    const replaced = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(removed, { fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' } }),
    );
    const second = { id: replaced.fee?.id as string, version: replaced.fee?.version as number };
    expect(second.id).not.toBe(first.id);
    expect(second.version).toBe(first.version);

    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];
    expect(transferBefore?.version).toBe(saved.transfer.version);
    expect(feesBefore).toEqual([expect.objectContaining({ id: second.id, amount: '2.00000000', version: second.version })]);
    const auditRowsBefore = await countRows('audit_entries');

    for (const stale of staleSaves) {
      await expect(updateCashTransfer(deps(), SEPT_15, stale)).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    }

    // Nothing from either save: the transfer as it was, the new fee neither
    // corrected nor removed, no fee beside it, and nothing audited.
    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
    expect(await countRows('expense_entries')).toBe(1);
    expect(await countRows('audit_entries')).toBe(auditRowsBefore);
    expect(await auditActions(saved.transfer.id)).toEqual(['insert']);
    expect(await auditActions(first.id)).toEqual(['insert', 'delete']);
    expect(await auditActions(second.id)).toEqual(['insert']);
  });

  it('refuses a fee moved after today, and writes neither row', async () => {
    const saved = await eurTransfer();
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, {
          occurredOn: '2026-09-06',
          fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-16' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // M5 holds for the fee's own date, not only for the transfer's.
    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('refuses a fee dated before its paying account opened', async () => {
    const opened = await account('Opened on the 3rd', { openedOn: '2026-09-03' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: opened,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: { amount: '1.50', cashPositionId: opened, incurredOn: '2026-09-05' },
    });
    const feesBefore = await feesOf(saved.transfer.id);

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, { fee: { amount: '1.50', cashPositionId: opened, incurredOn: '2026-09-02' } }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // 8.1: a flow dated outside its account's window has no bucket to belong to.
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('keeps a valid fee date that differs from the transfer’s', async () => {
    const saved = await eurTransfer();
    const edited = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-04' } }),
    );
    expect(edited.transfer.occurredOn).toBe('2026-09-05');
    expect(edited.fee?.incurredOn).toBe('2026-09-04');
  });

  it('rolls the transfer and fee writes back when the dormancy clear cannot be written', async () => {
    const saved = await eurTransfer();
    // The transfer is dated the 5th; a zero from the 1st would be stale.
    await makeDormant(savings, '2026-09-06');
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    await withBlockedWrite('cash_accounts', 'UPDATE', async () => {
      await expect(
        updateCashTransfer(
          deps(),
          SEPT_15,
          correction(saved, {
            fromAmount: '250.00',
            toAmount: '250.00',
            fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' },
          }),
        ),
      ).rejects.toThrow();
    });

    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
    expect(await isDormant(savings)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Existing data                                                               */
/* -------------------------------------------------------------------------- */

describe('existing data a correction must not normalize', () => {
  async function transferWithLinkedRow(values: Parameters<typeof linkedRowOutOfBand>[1]) {
    const saved = await eurTransfer({ fee: null });
    const rowId = await linkedRowOutOfBand(saved.transfer.id, values);
    const [row] = await feesOf(saved.transfer.id);
    return { saved, rowId, row: row as StoredFee };
  }

  it('fails closed on a linked row filed under a spending category', async () => {
    // 7.4: a category's kind is the fee's accounting meaning. Editing this row as
    // though it were a fee would keep a grocery bill inside "Interest & fees".
    const { saved, rowId } = await transferWithLinkedRow({
      categoryId: groceries,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'EUR',
    });
    const [transferBefore, feesBefore] = [await storedTransfer(saved.transfer.id), await feesOf(saved.transfer.id)];

    for (const fee of [null, { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-05' }]) {
      await expect(
        updateCashTransfer(
          deps(),
          SEPT_15,
          correction(saved, { fee, expectedFee: { state: 'version', feeId: rowId, version: 1 } }),
        ),
      ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    }
    expect(await storedTransfer(saved.transfer.id)).toEqual(transferBefore);
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
    expect(rowId).toBe(feesBefore[0]?.id);
  });

  it('fails closed on a linked row somebody else paid', async () => {
    // A transfer fee is tracked cash leaving one of the transfer's own accounts
    // (ADR 0006 §6); a third-party row is no such fee.
    const { saved, rowId } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'third_party',
      cashPositionId: null,
      currency: 'EUR',
    });
    const feesBefore = await feesOf(saved.transfer.id);

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, {
          fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' },
          expectedFee: { state: 'version', feeId: rowId, version: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    expect(await feesOf(saved.transfer.id)).toEqual(feesBefore);
  });

  it('lets a fee paid by an account the transfer does not touch be corrected, never kept', async () => {
    const third = await account('Third');
    const { saved, row } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: third,
      currency: 'EUR',
    });
    const expectedFee = { state: 'version', feeId: row.id, version: row.version } as const;

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, { fee: { amount: '1.50', cashPositionId: third, incurredOn: '2026-09-05' }, expectedFee }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const corrected = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' }, expectedFee }),
    );
    expect(corrected.fee).toMatchObject({ id: row.id, cashPositionId: bbva });
  });

  it('lets a fee dated outside its payer’s window be corrected, never kept', async () => {
    const opened = await account('Opened on the 3rd', { openedOn: '2026-09-03' });
    const saved = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: opened,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
    });
    const rowId = await linkedRowOutOfBand(saved.transfer.id, {
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: opened,
      currency: 'EUR',
      incurredOn: '2026-09-01',
    });
    const expectedFee = { state: 'version', feeId: rowId, version: 1 } as const;

    await expect(
      updateCashTransfer(
        deps(),
        SEPT_15,
        correction(saved, { fee: { amount: '1.50', cashPositionId: opened, incurredOn: '2026-09-01' }, expectedFee }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const corrected = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, { fee: { amount: '1.50', cashPositionId: opened, incurredOn: '2026-09-03' }, expectedFee }),
    );
    expect(corrected.fee?.incurredOn).toBe('2026-09-03');
  });

  it('files a restated fee in its payer’s currency, whatever currency the stored row claimed', async () => {
    const { saved, rowId } = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'USD',
    });

    const corrected = await updateCashTransfer(
      deps(),
      SEPT_15,
      correction(saved, {
        fee: { amount: '1.40', cashPositionId: bbva, incurredOn: '2026-09-05' },
        expectedFee: { state: 'version', feeId: rowId, version: 1 },
      }),
    );

    expect(corrected.fee).toMatchObject({ currency: 'EUR', amount: '1.40000000' });
  });

  it('lets an endpoint that is not open on the transfer’s date be corrected, never kept', async () => {
    const saved = await eurTransfer({ fee: null });
    // Savings' window was later changed so that it no longer covers the 5th.
    await harness.asOwner(`UPDATE positions SET opened_on = DATE '2026-09-10' WHERE id = $1`, [savings]);

    await expect(updateCashTransfer(deps(), SEPT_15, correction(saved))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const corrected = await updateCashTransfer(deps(), SEPT_15, correction(saved, { occurredOn: '2026-09-10' }));
    expect(corrected.transfer.occurredOn).toBe('2026-09-10');
  });
});

/* -------------------------------------------------------------------------- */
/* Deleting                                                                    */
/* -------------------------------------------------------------------------- */

describe('deleting a cash transfer', () => {
  async function transferOfAnotherKind(): Promise<string> {
    const id = randomUUID();
    await harness.asOwner(
      `INSERT INTO transfers
         (id, user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
          to_position_id, to_currency, to_amount)
       VALUES ($1, $2, 'contribution', DATE '2026-09-05', $3, 'EUR', 100, NULL, 'EUR', 100)`,
      [id, USER_A, bbva],
    );
    return id;
  }

  it('refuses a transfer of another kind, and removes nothing', async () => {
    const id = await transferOfAnotherKind();

    await expect(
      deleteCashTransfer(deps(), SEPT_15, {
        transferId: id,
        expectedVersion: 1,
        expectedFees: [],
      }),
    ).rejects.toMatchObject({
      code: 'IMPOSSIBLE_OPERATION',
    });
    expect(await storedTransfer(id)).toBeDefined();
  });

  it('refuses to correct a transfer of another kind', async () => {
    const id = await transferOfAnotherKind();
    const saved = await eurTransfer({ fee: null });

    await expect(
      updateCashTransfer(deps(), SEPT_15, correction(saved, { transferId: id })),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('removes a fee dated in another month with its transfer, each with a before-image', async () => {
    const saved = await eurTransfer({ ctx: NOV_5, occurredOn: '2026-09-30', fee: { incurredOn: '2026-10-01' } });

    const removed = await deleteCashTransfer(deps(), NOV_5, removal(saved));

    expect(removed.fees.map((fee) => fee.id)).toEqual([saved.fee?.id]);
    expect(await countRows('expense_entries')).toBe(0);
    expect(await auditActions(saved.fee?.id as string)).toEqual(['insert', 'delete']);
    expect(await auditActions(saved.transfer.id)).toEqual(['insert', 'delete']);
  });

  it('answers NOT_FOUND for a transfer that is already gone', async () => {
    const saved = await eurTransfer();
    await deleteCashTransfer(deps(), SEPT_15, removal(saved));

    await expect(deleteCashTransfer(deps(), SEPT_15, removal(saved))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('restores no dormancy', async () => {
    await makeDormant(savings);
    const saved = await eurTransfer();
    await deleteCashTransfer(deps(), SEPT_15, removal(saved));

    // Dormancy is a user assertion, re-made only through its own action (8.8).
    expect(await isDormant(savings)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Exchange-rate history                                                       */
/* -------------------------------------------------------------------------- */

describe('exchange-rate history after a transfer', () => {
  it('warms each currency from the earliest date the saved aggregate gives it', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    await harness.asOwner('DELETE FROM fx_rates');

    await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
      // The dollar fee was charged three days before the transfer.
      fee: { amount: '1.62', cashPositionId: dollars, incurredOn: '2026-09-02' },
    });

    // 10.4: a month before the earliest dated need, which here is the fee's.
    const usd = harness.fxProvider.calls.filter(
      (call) => call.method === 'fetchTimeSeries' && call.quotes.includes('USD'),
    );
    expect(usd.map((call) => call.from)).toEqual(['2026-08-02']);
  });

  it('keeps the transfer when the rate publisher is down', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    await harness.asOwner('DELETE FROM fx_rates');
    harness.fxProvider.failWith(providerOutage());

    await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
    });

    expect(await countRows('transfers')).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What the facts mean to a month                                              */
/* -------------------------------------------------------------------------- */

describe('a fee dated in another month than its transfer', () => {
  async function statements(
    positionId: string,
    balances: readonly (readonly [string, string])[],
  ): Promise<void> {
    for (const [valuedOn, amount] of balances) {
      await recordValuation(harness.services.positions, NOV_5, {
        positionId,
        valuedOn,
        amount,
        datePrecision: 'month_end',
      });
    }
  }

  it('belongs to its own month: known tracked cost and interest and fees there, and nothing in the transfer’s', async () => {
    // 300 moves on the last day of September; the bank's 5 posts on 1 October.
    await statements(bbva, [['2026-08-31', '1000.00'], ['2026-09-30', '700.00'], ['2026-10-31', '695.00']]);
    await statements(savings, [['2026-08-31', '0.00'], ['2026-09-30', '300.00'], ['2026-10-31', '300.00']]);
    await createCashTransfer(deps(), NOV_5, {
      occurredOn: '2026-09-30',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '300.00',
      toAmount: '300.00',
      fee: { amount: '5.00', cashPositionId: bbva, incurredOn: '2026-10-01' },
    });

    const septemberBucket = (await getMonthReconciliation(readDeps(), NOV_5, SEPTEMBER)).buckets[0];
    const octoberBucket = (await getMonthReconciliation(readDeps(), NOV_5, OCTOBER)).buckets[0];

    // September: the transfer's two legs cancel, and no fee is known there.
    expect(septemberBucket?.status).toBe('reliable');
    expect(septemberBucket?.totals.nonIncomeInflows.amount).toBe('300');
    expect(septemberBucket?.totals.nonExpenseOutflows.amount).toBe('300');
    expect(septemberBucket?.totals.knownTrackedExpenses.amount).toBe('0');
    expect(septemberBucket?.totals.trackedTotalSpending?.amount).toBe('0');

    // October: the fee is the whole known tracked cost, counted once.
    expect(octoberBucket?.status).toBe('reliable');
    expect(octoberBucket?.totals.nonIncomeInflows.amount).toBe('0');
    expect(octoberBucket?.totals.nonExpenseOutflows.amount).toBe('0');
    expect(octoberBucket?.totals.knownTrackedExpenses.amount).toBe('5');
    expect(octoberBucket?.totals.unclassified?.amount).toBe('0');

    const septemberSavings = (await getMonthSavings(readDeps(), NOV_5, SEPTEMBER)).buckets[0];
    const octoberSavings = (await getMonthSavings(readDeps(), NOV_5, OCTOBER)).buckets[0];
    expect(septemberSavings?.source.interestAndFees.amount).toBe('0');
    expect(octoberSavings?.source.interestAndFees.amount).toBe('5');
    // Never consumption (7.4).
    expect(octoberSavings?.source.knownConsumption.amount).toBe('0');
  });

  it('converts to the reporting currency at the fee’s own date', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    const wise = await account('Wise', { currency: 'USD' });
    await statements(dollars, [['2026-08-31', '1000.00'], ['2026-09-30', '700.00'], ['2026-10-31', '690.00']]);
    await statements(wise, [['2026-08-31', '0.00'], ['2026-09-30', '300.00'], ['2026-10-31', '300.00']]);
    await createCashTransfer(deps(), NOV_5, {
      occurredOn: '2026-09-30',
      fromPositionId: dollars,
      toPositionId: wise,
      fromAmount: '300.00',
      toAmount: '300.00',
      fee: { amount: '10.00', cashPositionId: dollars, incurredOn: '2026-10-01' },
    });

    // EUR -> USD, chosen so the transfer's date and the fee's cannot agree.
    await harness.asOwner('DELETE FROM fx_rates');
    for (const [day, value] of [['2026-09-30', '2.0'], ['2026-10-01', '4.0']] as const) {
      await withoutUser(harness.db, async (tx) => {
        await tx.execute(
          sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at)
              VALUES ('EUR', 'USD', ${day}, ${value}, 'ECB', now())`,
        );
      });
    }

    const september = await getMonthReportingCashFlow(readDeps(), NOV_5, SEPTEMBER);
    const october = await getMonthReportingCashFlow(readDeps(), NOV_5, OCTOBER);

    expect(september.interestAndFees.value.amount).toBe('0');
    // 10 / 4.0 on 1 October; at the transfer's rate it would have been 5.
    expect(october.interestAndFees.value.amount).toBe('2.5');
  });
});
