import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listTransferFeesByTransferDate,
  sql,
  withUser,
  withoutUser,
  type Database,
} from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { closePosition, createCashAccount, updateCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createCashTransfer } from '../../src/flows/transfers';
import { createTemplate } from '../../src/recurring/templates';
import { createFxService } from '../../src/fx/service';
import { parseMonth } from '../../src/reconciliation/service';
import { getMonthlyPage, type MonthlyDependencies } from '../../src/monthly/service';
import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  MonthlyPageDto,
  MonthlyTransferDto,
} from '../../src/monthly/types';
import { reviewAndConfirm } from '../helpers/corrections';

/**
 * Monthly's transfer maintenance read against a real database (blueprint 7.5,
 * 8.1, 15.3 section 4, 23.2, M14; ADR 0006 §1, §5, §7).
 *
 * September 2026 is the completed month, read on 1 October unless a case needs
 * October over as well; the current-month cases sit on 10 September. What is
 * pinned:
 *
 *  - **ownership by the transfer's own date**, each transfer once, in order;
 *  - **the complete aggregate**: every linked row beside the transfer it belongs
 *    to, whatever that row's date — while the month the fee is dated in counts it;
 *  - **what an editor is told**: account windows, read-only reasons and the
 *    inconsistencies a correction must repair, none of them rewritten on read;
 *  - **the read's cost**: one scope more than the page had, whatever the number
 *    of transfers or fees.
 */

const USER_A = '13131313-1313-4131-8131-131313131313';
const USER_B = '24242424-2424-4242-8242-242424242424';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;
let transferFeeCategory: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
const NOV_1 = on('2026-11-01');
const SEPT_10 = on('2026-09-10');
const AUGUST = parseMonth('2026-08');
const SEPTEMBER = parseMonth('2026-09');
const OCTOBER = parseMonth('2026-10');

const flowDeps = () => harness.services.flows;
const readDeps = (): MonthlyDependencies => ({ db: harness.db, fx: harness.services.fx });
const eur = (amount: string) => ({ amount, currency: 'EUR' });

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
  options: { currency?: string; openedOn?: string | null; ctx?: RequestContext; userId?: string } = {},
): Promise<string> {
  const created = await createCashAccount(
    harness.services.positions,
    options.ctx ?? on('2026-09-10', options.userId ?? USER_A),
    {
      name,
      currency: options.currency ?? 'EUR',
      accountType: 'checking',
      openedOn: options.openedOn ?? null,
    },
  );
  return created.id;
}

const statement = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, NOV_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });

const snapshot = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, on(valuedOn), {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });

async function positionVersion(positionId: string): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT version FROM positions WHERE id = ${positionId}`);
    return (result.rows[0] as { version: number }).version;
  });
}

async function makeDormant(positionId: string): Promise<void> {
  await snapshot(positionId, '2026-09-01', '0');
  await updateCashAccount(harness.services.positions, SEPT_10, {
    positionId,
    expectedVersion: await positionVersion(positionId),
    isDormant: true,
  });
}

async function zeroAndClose(positionId: string, closedOn: string): Promise<void> {
  await snapshot(positionId, closedOn, '0');
  await closePosition(harness.services.positions, NOV_1, {
    positionId,
    closedOn,
    expectedVersion: await positionVersion(positionId),
  });
}

async function completed(ctx: RequestContext = OCT_1, month = SEPTEMBER): Promise<CompletedMonthlyPageDto> {
  const page = await getMonthlyPage(readDeps(), ctx, month);
  if (page.kind !== 'completed') throw new Error('expected a completed month');
  return page;
}

async function current(ctx: RequestContext = SEPT_10, month = SEPTEMBER): Promise<CurrentMonthlyPageDto> {
  const page = await getMonthlyPage(readDeps(), ctx, month);
  if (page.kind !== 'current') throw new Error('expected the current month');
  return page;
}

const ids = (page: MonthlyPageDto): string[] =>
  page.transfers.transfers.map((row) => row.transferId);

function transferOn(page: MonthlyPageDto, transferId: string): MonthlyTransferDto {
  const found = page.transfers.transfers.find((row) => row.transferId === transferId);
  if (found === undefined) throw new Error(`transfer ${transferId} is not on the page`);
  return found;
}

function eurBucket(page: CompletedMonthlyPageDto) {
  const bucket = page.reconciliation.buckets.find((row) => row.currency === 'EUR');
  if (bucket === undefined) throw new Error('no EUR bucket');
  return bucket;
}

const euroTransfer = (occurredOn: string, ctx: RequestContext = OCT_1) =>
  createCashTransfer(flowDeps(), ctx, {
    occurredOn,
    fromPositionId: bbva,
    toPositionId: savings,
    fromAmount: '10.00',
    toAmount: '10.00',
  });

/**
 * A row linked to a transfer, written below the services — the only way a
 * linked row that breaks a fee's rules can exist (M14 leaves its shape to the
 * services, not to a constraint).
 */
async function linkedRowOutOfBand(
  transferId: string,
  values: {
    readonly categoryId: string;
    readonly settlement: 'tracked_cash' | 'third_party';
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

async function transferWithLinkedRow(values: Parameters<typeof linkedRowOutOfBand>[1]): Promise<string> {
  const { transfer } = await euroTransfer('2026-09-05');
  await linkedRowOutOfBand(transfer.id, values);
  return transfer.id;
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'monthly-transfers-a@example.test'],
    [USER_B, 'monthly-transfers-b@example.test'],
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
  await harness.asOwner('DELETE FROM month_reviews');
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_skips');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');

  bbva = await account('BBVA');
  savings = await account('Savings');
});

/* -------------------------------------------------------------------------- */
/* Ownership                                                                   */
/* -------------------------------------------------------------------------- */

describe('the transfers a month owns', () => {
  it('lists a completed month’s transfer once, with its accounts, amounts, version and fee', async () => {
    const saved = await createCashTransfer(flowDeps(), OCT_1, {
      occurredOn: '2026-09-12',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      description: 'Rent share',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-12' },
    });
    // September is closed on 1 October, so correcting the aggregate is a
    // reviewed Historical Correction — and the section still lists one row.
    await reviewAndConfirm(harness.services.corrections, OCT_1, {
      kind: 'transfer_update',
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      occurredOn: '2026-09-12',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '250.00',
      toAmount: '250.00',
      description: 'Rent share',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-12' },
      expectedFee: { state: 'version', feeId: saved.fee?.id as string, version: saved.fee?.version as number },
    });

    expect((await completed()).transfers.transfers).toEqual([
      {
        transferId: saved.transfer.id,
        version: 2,
        occurredOn: '2026-09-12',
        from: { positionId: bbva, accountName: 'BBVA', currency: 'EUR', amount: eur('250') },
        to: { positionId: savings, accountName: 'Savings', currency: 'EUR', amount: eur('250') },
        description: 'Rent share',
        achievedRate: null,
        fee: {
          kind: 'one',
          fee: {
            feeId: saved.fee?.id,
            version: 1,
            amount: eur('1.5'),
            currency: 'EUR',
            incurredOn: '2026-09-12',
            incurredMonth: '2026-09',
            cashPositionId: bbva,
            cashAccountName: 'BBVA',
            paidBy: 'from',
          },
        },
        readOnly: null,
        problems: [],
      },
    ]);
  });

  it('keeps each transfer on the page of the month holding its own date', async () => {
    const august = await euroTransfer('2026-08-31');
    const first = await euroTransfer('2026-09-01');
    const last = await euroTransfer('2026-09-30');
    const october = await euroTransfer('2026-10-01');

    expect(ids(await completed())).toEqual([first.transfer.id, last.transfer.id]);
    expect(ids(await completed(OCT_1, AUGUST))).toEqual([august.transfer.id]);
    expect(ids(await current(OCT_1, OCTOBER))).toEqual([october.transfer.id]);
  });

  it('lists the current month’s transfers through today, past its month-to-date date', async () => {
    // August's statements make both accounts part of September's arithmetic, so
    // the 6th is a common date every included account shares (8.6).
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(savings, '2026-08-31', '0.00');
    await snapshot(bbva, '2026-09-06', '900.00');
    await snapshot(savings, '2026-09-06', '100.00');
    const later = await euroTransfer('2026-09-08', SEPT_10);

    const page = await current();
    expect(page.monthToDate.asOf).toBe('2026-09-06');
    expect(ids(page)).toEqual([later.transfer.id]);
  });

  it('orders transfers by date and then by id, each once', async () => {
    for (const day of ['2026-09-05', '2026-09-03', '2026-09-05', '2026-09-05']) await euroTransfer(day);

    // The database's own ordering is the oracle.
    const expected = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id FROM transfers WHERE occurred_on BETWEEN '2026-09-01' AND '2026-09-30'
             ORDER BY occurred_on, id`,
      );
      return (result.rows as { id: string }[]).map((row) => row.id);
    });
    expect(ids(await completed())).toEqual(expected);
    expect(expected).toHaveLength(4);
  });

  it('gives a cross-currency transfer both native amounts and the rate they imply', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    await createCashTransfer(flowDeps(), OCT_1, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: dollars,
      fromAmount: '200.00',
      toAmount: '216.45',
    });

    const [transfer] = (await completed()).transfers.transfers;
    expect(transfer).toMatchObject({
      from: { accountName: 'BBVA', currency: 'EUR', amount: eur('200') },
      to: { accountName: 'Dollars', currency: 'USD', amount: { amount: '216.45', currency: 'USD' } },
      // 216.45 / 200, exactly: what this transfer achieved, not a quoted rate.
      achievedRate: { rate: '1.08225', from: 'EUR', to: 'USD' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The complete aggregate                                                      */
/* -------------------------------------------------------------------------- */

describe('a transfer is read with every row linked to it', () => {
  it('attaches an October fee to its September transfer, while October counts it', async () => {
    const saved = await createCashTransfer(flowDeps(), NOV_1, {
      occurredOn: '2026-09-30',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '300.00',
      toAmount: '300.00',
      fee: { amount: '5.00', cashPositionId: bbva, incurredOn: '2026-10-01' },
    });

    const september = await completed(NOV_1, SEPTEMBER);
    const october = await completed(NOV_1, OCTOBER);

    expect(transferOn(september, saved.transfer.id).fee).toEqual({
      kind: 'one',
      fee: expect.objectContaining({
        feeId: saved.fee?.id,
        incurredOn: '2026-10-01',
        incurredMonth: '2026-10',
        paidBy: 'from',
      }),
    });
    expect(october.transfers.transfers).toEqual([]);

    // Two views of one source fact: October's figures and Known expenses count
    // the fee, once; September's hold only the transfer.
    expect(september.expenses.direct).toEqual([]);
    expect(october.expenses.direct.map((row) => [row.entryId, row.readOnly])).toEqual([
      [saved.fee?.id, 'transfer_fee'],
    ]);
    expect(eurBucket(september).totals.knownTrackedExpenses.amount).toBe('0');
    expect(eurBucket(october).totals.knownTrackedExpenses.amount).toBe('5');
  });

  it('shows more than one linked row as it is, and offers no correction', async () => {
    const saved = await createCashTransfer(flowDeps(), OCT_1, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-09-05' },
    });
    const second = await linkedRowOutOfBand(saved.transfer.id, {
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'EUR',
      incurredOn: '2026-09-06',
    });

    const transfer = transferOn(await completed(), saved.transfer.id);
    expect(transfer.readOnly).toBe('multiple_fees');
    if (transfer.fee.kind !== 'multiple') throw new Error(`expected several fees, got ${transfer.fee.kind}`);
    expect(transfer.fee.fees.map((fee) => fee.feeId).sort()).toEqual([saved.fee?.id, second].sort());
    expect(transfer.problems).toEqual([]);
  });

  it('marks a linked row that is not a tracked-cash transfer fee read-only', async () => {
    const spending = await transferWithLinkedRow({
      categoryId: groceries,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'EUR',
    });
    const paidByOthers = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'third_party',
      cashPositionId: null,
      currency: 'EUR',
    });

    const page = await completed();
    expect(transferOn(page, spending).readOnly).toBe('fee_not_transfer_fee');
    expect(transferOn(page, paidByOthers).readOnly).toBe('fee_not_tracked_cash');
    expect(transferOn(page, paidByOthers).fee).toMatchObject({
      kind: 'one',
      fee: { cashPositionId: null, cashAccountName: null, paidBy: null },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* What a correction must repair                                               */
/* -------------------------------------------------------------------------- */

describe('what a correction of a stored transfer would have to repair', () => {
  it('names a fee paid by an account the transfer does not touch', async () => {
    const third = await account('Third');
    const id = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: third,
      currency: 'EUR',
    });

    const transfer = transferOn(await completed(), id);
    expect(transfer.fee).toMatchObject({
      kind: 'one',
      fee: { cashPositionId: third, cashAccountName: 'Third', paidBy: null },
    });
    expect(transfer.problems).toEqual([{ kind: 'fee_payer_not_endpoint' }]);
    // Repairable in the editor, so not read-only.
    expect(transfer.readOnly).toBeNull();
  });

  it('names a fee dated outside its payer’s window', async () => {
    const opened = await account('Opened on the 3rd', { openedOn: '2026-09-03' });
    const saved = await createCashTransfer(flowDeps(), OCT_1, {
      occurredOn: '2026-09-05',
      fromPositionId: opened,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
    });
    await linkedRowOutOfBand(saved.transfer.id, {
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: opened,
      currency: 'EUR',
      incurredOn: '2026-09-01',
    });

    expect(transferOn(await completed(), saved.transfer.id).problems).toEqual([
      { kind: 'fee_payer_not_open' },
    ]);
  });

  it('names a fee recorded in a currency its payer does not hold', async () => {
    const id = await transferWithLinkedRow({
      categoryId: transferFeeCategory,
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      currency: 'USD',
    });

    const transfer = transferOn(await completed(), id);
    expect(transfer.problems).toEqual([{ kind: 'fee_currency' }]);
    // Shown as recorded, never relabelled on read.
    expect(transfer.fee).toMatchObject({ kind: 'one', fee: { currency: 'USD' } });
  });

  it('names an endpoint that is not open on the transfer’s date, and moves nothing', async () => {
    const { transfer } = await euroTransfer('2026-09-05');
    await harness.asOwner(`UPDATE positions SET opened_on = DATE '2026-09-10' WHERE id = $1`, [savings]);

    const read = transferOn(await completed(), transfer.id);
    expect(read.problems).toEqual([{ kind: 'endpoint_not_open', side: 'to' }]);
    expect(read.occurredOn).toBe('2026-09-05');
  });
});

/* -------------------------------------------------------------------------- */
/* Accounts                                                                    */
/* -------------------------------------------------------------------------- */

describe('the accounts a transfer may name', () => {
  it('offers every cash account taking part in the month, dormant ones included, with their windows', async () => {
    await makeDormant(savings);
    await account('Dollars', { currency: 'USD' });
    await account('Opened mid-month', { openedOn: '2026-09-10' });
    await zeroAndClose(await account('Closed mid-month'), '2026-09-20');
    await zeroAndClose(await account('Closed in August'), '2026-08-15');
    await account('Opened in October', { openedOn: '2026-10-05', ctx: NOV_1 });
    await account('Theirs', { userId: USER_B });

    const accounts = (await completed(NOV_1, SEPTEMBER)).transfers.cashAccounts;
    const byName = new Map(accounts.map((row) => [row.name, row]));

    expect([...byName.keys()].sort()).toEqual([
      'BBVA',
      'Closed mid-month',
      'Dollars',
      'Opened mid-month',
      'Savings',
    ]);
    expect(byName.get('Savings')).toMatchObject({ dormant: true, openedOn: null, closedOn: null });
    expect(byName.get('Opened mid-month')).toMatchObject({ openedOn: '2026-09-10', closedOn: null, dormant: false });
    expect(byName.get('Closed mid-month')).toMatchObject({ openedOn: null, closedOn: '2026-09-20' });
    expect(byName.get('Dollars')).toMatchObject({ currency: 'USD' });
  });
});

describe('another user’s transfers', () => {
  it('are never read, with or without their fees', async () => {
    const theirs = await account('Theirs', { userId: USER_B });
    const theirSavings = await account('Their savings', { userId: USER_B });
    await createCashTransfer(flowDeps(), on('2026-10-01', USER_B), {
      occurredOn: '2026-09-05',
      fromPositionId: theirs,
      toPositionId: theirSavings,
      fromAmount: '10.00',
      toAmount: '10.00',
      fee: { amount: '1.00', cashPositionId: theirs, incurredOn: '2026-09-05' },
    });

    expect((await completed()).transfers.transfers).toEqual([]);
    expect(await listTransferFeesByTransferDate(harness.db, USER_A, '2026-09-01', '2026-09-30')).toEqual([]);
    expect(await listTransferFeesByTransferDate(harness.db, USER_B, '2026-09-01', '2026-09-30')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The read's cost                                                             */
/* -------------------------------------------------------------------------- */

/** A handle that counts `db.transaction` invocations, as the Monthly suite's does. */
function countingDatabase(): { db: Database; transactions: () => number } {
  let transactions = 0;
  const db = new Proxy(harness.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'transaction' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        transactions += 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db, transactions: () => transactions };
}

async function countTransactions(ctx: RequestContext, month = SEPTEMBER): Promise<number> {
  const counting = countingDatabase();
  const fx = createFxService({ db: counting.db, provider: harness.fxProvider });
  await getMonthlyPage({ db: counting.db, fx }, ctx, month);
  return counting.transactions();
}

const incomeSource = (name: string) =>
  createTemplate(flowDeps(), OCT_1, {
    kind: 'income',
    name,
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: '2026-01-01',
    amount: '10.00',
  });

describe('the section’s read', () => {
  it('reads every row linked to a window’s transfers in one scope', async () => {
    const counting = countingDatabase();
    await listTransferFeesByTransferDate(counting.db, USER_A, '2026-09-01', '2026-09-30');
    expect(counting.transactions()).toBe(1);
  });

  it('opens the same scopes for no transfer, one, and a hundred with their fees', async () => {
    for (const id of [bbva, savings]) {
      await statement(id, '2026-08-31', '5000.00');
      await statement(id, '2026-09-30', '4000.00');
      await snapshot(id, '2026-09-06', '4500.00');
    }
    const noneCompleted = await countTransactions(OCT_1);
    const noneCurrent = await countTransactions(SEPT_10);

    await createCashTransfer(flowDeps(), SEPT_10, {
      occurredOn: '2026-09-02',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '1.00',
      toAmount: '1.00',
      fee: { amount: '0.10', cashPositionId: bbva, incurredOn: '2026-09-02' },
    });
    expect(await countTransactions(OCT_1)).toBe(noneCompleted);
    expect(await countTransactions(SEPT_10)).toBe(noneCurrent);

    for (let index = 1; index < 100; index += 1) {
      const forward = index % 2 === 0;
      await createCashTransfer(flowDeps(), SEPT_10, {
        occurredOn: `2026-09-0${String(2 + (index % 8))}`,
        fromPositionId: forward ? bbva : savings,
        toPositionId: forward ? savings : bbva,
        fromAmount: '1.00',
        toAmount: '1.00',
        // Most with a fee, some charged on a later day than their transfer.
        ...(index % 3 === 0
          ? {}
          : { fee: { amount: '0.10', cashPositionId: savings, incurredOn: '2026-09-10' } }),
      });
    }
    // And August transfers whose fees are dated in September.
    for (let index = 0; index < 5; index += 1) {
      await createCashTransfer(flowDeps(), SEPT_10, {
        occurredOn: '2026-08-31',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '1.00',
        toAmount: '1.00',
        fee: { amount: '0.10', cashPositionId: bbva, incurredOn: '2026-09-01' },
      });
    }

    expect((await completed()).transfers.transfers).toHaveLength(100);
    expect((await current()).transfers.transfers).toHaveLength(100);
    expect(await countTransactions(OCT_1)).toBe(noneCompleted);
    expect(await countTransactions(SEPT_10)).toBe(noneCurrent);
  });

  it('pins the scopes a euro month opens, with and without a recurring source', async () => {
    for (const id of [bbva, savings]) {
      await statement(id, '2026-08-31', '1000.00');
      await statement(id, '2026-09-30', '900.00');
      await snapshot(id, '2026-09-06', '950.00');
    }
    // The range loader's seven, the Income, Known-expenses and transfer scopes,
    // settings, the currency catalogue and the review. No stored rate is needed.
    expect(await countTransactions(OCT_1)).toBe(13);
    // The month-to-date loader's five, and the same six beside it.
    expect(await countTransactions(SEPT_10)).toBe(11);

    await incomeSource('Salary');
    // One more on the completed month: the range's terms, read in one batch.
    expect(await countTransactions(OCT_1)).toBe(14);
  });

  it('pins the scopes a month with a foreign currency opens, with and without a recurring source', async () => {
    const dollars = await account('Dollars', { currency: 'USD' });
    for (const id of [bbva, savings, dollars]) {
      await statement(id, '2026-08-31', '1000.00');
      await statement(id, '2026-09-30', '900.00');
      await snapshot(id, '2026-09-06', '950.00');
    }
    // Every bucket spent, so there is no missing-conversion signature and the
    // diagnostic reads nothing; reporting reads the rates once for the month.
    expect(await countTransactions(OCT_1)).toBe(14);
    expect(await countTransactions(SEPT_10)).toBe(12);

    await incomeSource('Salary');
    expect(await countTransactions(OCT_1)).toBe(15);
  });
});
