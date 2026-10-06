import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { saveOrCorrect } from '../helpers/corrections';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { closePosition, createCashAccount } from '../../src/positions/service';
import {
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type BulkHistoryDraft,
  type BulkHistoryOperation,
  type CorrectionDraft,
} from '../../src/corrections/index';

/**
 * A closed account's final balance stays zero (blueprint 2.5 M4 and M6, 5.2,
 * 8.1, 8.8).
 *
 * Closing requires a final balance of zero (M6), and 5.2 makes that an
 * invariant of every write to the account's balances, not only a precondition
 * of the close: for a position whose status is `closed`, after any write, its
 * latest balance on or before `closed_on` exists and is exactly zero. A closed
 * account left holding money drops that money out of every figure, with no
 * record of where it went (8.8: "The remaining balance must have been
 * transferred out or it becomes spending").
 *
 * The world is the one the hardening item describes. Old savings had a July
 * statement of 300, was emptied on 20 August and closed on 15 September.
 * "Today" is 5 October 2026, so every one of those dates is in a completed
 * month.
 *
 * Each refusal is asked the way the interface asks — the ordinary save, or
 * Review → Confirm when the change is historical — and then of the ordinary
 * call on its own, and it must leave the world exactly as it found it.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let savings: string;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER_A, reportingCurrency: 'EUR' });

const OCT_5 = on('2026-10-05');

const positions = () => harness.services.positions;
const corrections = () => harness.services.corrections;

const FINAL_ZERO = 'This account is closed, so its final balance has to stay zero.';

const REFUSED = { code: 'VALIDATION_ERROR', message: FINAL_ZERO };

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

const account = async (name: string, ctx = OCT_5) =>
  (await createCashAccount(positions(), ctx, { name, currency: 'EUR', accountType: 'savings', openedOn: null }))
    .id;

const statement = (positionId: string, valuedOn: string, amount: string) =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'month_end' });

const snapshot = (positionId: string, valuedOn: string, amount: string, ctx = OCT_5) =>
  recordValuation(positions(), ctx, { positionId, valuedOn, amount, datePrecision: 'exact' });

async function versionOf(positionId: string): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT version FROM positions WHERE id = ${positionId}`);
    return (result.rows[0] as { version: number }).version;
  });
}

async function close(positionId: string, closedOn: string, ctx = OCT_5): Promise<void> {
  await closePosition(positions(), ctx, { positionId, expectedVersion: await versionOf(positionId), closedOn });
}

interface Balance {
  readonly id: string;
  readonly version: number;
  readonly valuedOn: string;
  readonly amount: string;
  readonly precision: 'exact' | 'month_end';
}

async function balances(positionId: string): Promise<Balance[]> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version, valued_on::text AS "valuedOn", amount::text AS amount,
                 date_precision::text AS precision
            FROM position_valuations
           WHERE position_id = ${positionId}
           ORDER BY valued_on`,
    );
    return result.rows as unknown as Balance[];
  });
}

async function balanceOn(positionId: string, valuedOn: string): Promise<Balance> {
  const found = (await balances(positionId)).find((row) => row.valuedOn === valuedOn);
  if (found === undefined) throw new Error(`no balance on ${valuedOn}`);
  return found;
}

/** The latest balance on or before the closing day: what M6 is about. */
async function finalBalance(positionId: string, closedOn: string): Promise<string | undefined> {
  const rows = (await balances(positionId)).filter((row) => row.valuedOn <= closedOn);
  return rows.at(-1)?.amount;
}

/** Everything a refused write must leave exactly as it found it. */
async function worldState() {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const valuations = await tx.execute(
      sql`SELECT id, version, position_id, valued_on::text AS valued_on, amount::text AS amount,
                 date_precision::text AS precision, note
            FROM position_valuations ORDER BY id`,
    );
    const accounts = await tx.execute(
      sql`SELECT p.id, p.version, p.status::text AS status, p.closed_on::text AS closed_on,
                 c.is_dormant, c.dormant_from::text AS dormant_from
            FROM positions p JOIN cash_accounts c ON c.position_id = p.id ORDER BY p.id`,
    );
    const audit = await tx.execute(sql`SELECT count(*)::text AS n FROM audit_entries`);
    return { valuations: valuations.rows, accounts: accounts.rows, audit: audit.rows };
  });
}

/**
 * Ask for a write the way the interface does, and expect it refused: through
 * the server's question first (Preview), saving ordinarily when no review is
 * needed and through Confirm when one is — then the ordinary call on its own,
 * which must give the same answer rather than asking for a review of a change
 * that can never be made.
 */
async function expectRefused(
  draft: CorrectionDraft,
  ordinary: () => Promise<unknown>,
  refusal: Record<string, unknown> = REFUSED,
): Promise<void> {
  const before = await worldState();
  await expect(saveOrCorrect(corrections(), OCT_5, draft, ordinary)).rejects.toMatchObject(refusal);
  await expect(ordinary()).rejects.toMatchObject(refusal);
  expect(await worldState()).toEqual(before);
}

/** Ask for a write the way the interface does, and expect it to land. */
const expectSaved = (draft: CorrectionDraft, ordinary: () => Promise<unknown>) =>
  saveOrCorrect(corrections(), OCT_5, draft, ordinary);

const bulkDraft = (operations: BulkHistoryOperation[]): BulkHistoryDraft => ({
  kind: 'bulk_history',
  startMonth: '2026-01',
  operations,
});

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const table of ['audit_entries', 'position_valuations', 'cash_accounts', 'positions']) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  savings = await account('Old savings');
  await statement(savings, '2026-07-31', '300');
  await snapshot(savings, '2026-08-20', '0');
  await close(savings, '2026-09-15');
});

describe('the writes that would leave a closed account holding money are refused', () => {
  it('1. a non-zero balance on the closing day, when the zero sits on an earlier day', async () => {
    const args = { positionId: savings, valuedOn: '2026-09-15', amount: '500', datePrecision: 'exact' as const };
    await expectRefused({ kind: 'valuation_create', ...args }, () => recordValuation(positions(), OCT_5, args), {
      ...REFUSED,
      fieldErrors: { amount: [FINAL_ZERO] },
    });
  });

  it('2. a non-zero balance between the last zero and the closing day', async () => {
    for (const datePrecision of ['exact', 'month_end'] as const) {
      const args = { positionId: savings, valuedOn: '2026-08-31', amount: '500', datePrecision };
      await expectRefused({ kind: 'valuation_create', ...args }, () => recordValuation(positions(), OCT_5, args));
    }
  });

  it('3. the final zero corrected to a non-zero amount', async () => {
    const zero = await balanceOn(savings, '2026-08-20');
    const args = {
      valuationId: zero.id,
      expectedVersion: zero.version,
      valuedOn: zero.valuedOn,
      amount: '500',
      datePrecision: zero.precision,
    };
    await expectRefused({ kind: 'valuation_update', ...args }, () => correctValuation(positions(), OCT_5, args), {
      ...REFUSED,
      fieldErrors: { amount: [FINAL_ZERO] },
    });
  });

  it('3. the final zero re-dated, so an earlier non-zero balance becomes the final one', async () => {
    const zero = await balanceOn(savings, '2026-08-20');
    const args = {
      valuationId: zero.id,
      expectedVersion: zero.version,
      valuedOn: '2026-07-20',
      amount: '0',
      datePrecision: zero.precision,
    };
    await expectRefused({ kind: 'valuation_update', ...args }, () => correctValuation(positions(), OCT_5, args), {
      ...REFUSED,
      fieldErrors: { valuedOn: [FINAL_ZERO] },
    });
  });

  it('4. the final zero removed when it is dated before the closing day', async () => {
    const zero = await balanceOn(savings, '2026-08-20');
    const args = { valuationId: zero.id, expectedVersion: zero.version };
    await expectRefused({ kind: 'valuation_delete', ...args }, () => removeValuation(positions(), OCT_5, args), {
      code: 'IMPOSSIBLE_OPERATION',
      message: FINAL_ZERO,
    });
  });

  it('4. the last balance of all removed, leaving none on or before the closing day', async () => {
    const lone = await account('Lone');
    await snapshot(lone, '2026-08-20', '0');
    await close(lone, '2026-09-15');

    const zero = await balanceOn(lone, '2026-08-20');
    const args = { valuationId: zero.id, expectedVersion: zero.version };
    await expectRefused({ kind: 'valuation_delete', ...args }, () => removeValuation(positions(), OCT_5, args), {
      code: 'IMPOSSIBLE_OPERATION',
      message: FINAL_ZERO,
    });
  });

  it('6. confirming a month unchanged, which would carry July’s statement past the zero', async () => {
    const args = { positionId: savings, month: '2026-08' };
    await expectRefused({ kind: 'confirm_unchanged', ...args }, () => confirmUnchanged(positions(), OCT_5, args), {
      code: 'VALIDATION_ERROR',
      message: 'Old savings is closed, so its final balance has to stay zero. Nothing was confirmed.',
      fieldErrors: { month: [FINAL_ZERO] },
    });
  });

  it('6. confirming a month unchanged for several accounts, refused whole, naming the account', async () => {
    const pocket = await account('Pocket');
    await statement(pocket, '2026-07-31', '0');
    await close(pocket, '2026-09-15');

    const args = { month: '2026-08', positionIds: [pocket, savings] };
    await expectRefused(
      { kind: 'confirm_unchanged_batch', ...args },
      () => confirmUnchangedBatch(positions(), OCT_5, args),
      {
        code: 'VALIDATION_ERROR',
        message: 'Old savings is closed, so its final balance has to stay zero. Nothing was confirmed.',
        fieldErrors: { positionIds: [FINAL_ZERO] },
      },
    );
  });
});

describe('in the current month, the ordinary correction and removal are held to it too', () => {
  // October is the current month, so these corrections are ordinary saves
  // rather than reviews: the refusal is the ordinary write's own.
  const OCT_20 = on('2026-10-20');
  let wallet: string;

  beforeEach(async () => {
    wallet = await account('Wallet', OCT_20);
    await snapshot(wallet, '2026-10-02', '300', OCT_20);
    await snapshot(wallet, '2026-10-05', '0', OCT_20);
    await close(wallet, '2026-10-15', OCT_20);
  });

  async function refusedNow(run: () => Promise<unknown>, refusal: Record<string, unknown> = REFUSED) {
    const before = await worldState();
    await expect(run()).rejects.toMatchObject(refusal);
    expect(await worldState()).toEqual(before);
  }

  it('refuses the final zero corrected to a non-zero amount', async () => {
    const zero = await balanceOn(wallet, '2026-10-05');
    await refusedNow(() =>
      correctValuation(positions(), OCT_20, {
        valuationId: zero.id,
        expectedVersion: zero.version,
        valuedOn: zero.valuedOn,
        amount: '500',
        datePrecision: 'exact',
      }),
    );
  });

  it('refuses the final zero re-dated before the earlier balance', async () => {
    const zero = await balanceOn(wallet, '2026-10-05');
    await refusedNow(() =>
      correctValuation(positions(), OCT_20, {
        valuationId: zero.id,
        expectedVersion: zero.version,
        valuedOn: '2026-10-01',
        amount: '0',
        datePrecision: 'exact',
      }),
    );
  });

  it('refuses the final zero removed', async () => {
    const zero = await balanceOn(wallet, '2026-10-05');
    await refusedNow(
      () => removeValuation(positions(), OCT_20, { valuationId: zero.id, expectedVersion: zero.version }),
      { code: 'IMPOSSIBLE_OPERATION', message: FINAL_ZERO },
    );
  });
});

describe('Bulk History is held to it for the batch as a whole', () => {
  const where = (cell: string) =>
    `${cell}: the account is closed, so its final balance has to stay zero. Nothing was saved.`;

  async function previewRefused(draft: BulkHistoryDraft, message: string, field: string) {
    const before = await worldState();
    const refusal = { code: 'VALIDATION_ERROR', message, fieldErrors: { [field]: [FINAL_ZERO] } };
    await expect(previewHistoricalCorrection(corrections(), OCT_5, { draft })).rejects.toMatchObject(refusal);
    // Confirm resolves before it compares anything, so whatever fingerprint it
    // is handed, the refusal is the same and nothing is written.
    await expect(
      confirmHistoricalCorrection(corrections(), OCT_5, { draft, fingerprint: 'unchanged' }),
    ).rejects.toMatchObject(refusal);
    expect(await worldState()).toEqual(before);
  }

  it('5. refuses a figure in a month-end cell after the last zero, naming the cell', async () => {
    await previewRefused(
      bulkDraft([{ kind: 'valuation_create', positionId: savings, month: '2026-08', amount: '500' }]),
      where('Old savings, August 2026'),
      `${savings}#2026-08-31`,
    );
  });

  it('5. refuses two cells that each keep the zero alone but not together', async () => {
    const pair = await account('Pair');
    await statement(pair, '2026-07-31', '0');
    await statement(pair, '2026-08-31', '0');
    await close(pair, '2026-09-15');
    const july = await balanceOn(pair, '2026-07-31');
    const august = await balanceOn(pair, '2026-08-31');

    const clearAugust: BulkHistoryOperation = {
      kind: 'valuation_clear',
      positionId: pair,
      month: '2026-08',
      valuationId: august.id,
      expectedVersion: august.version,
    };
    const raiseJuly: BulkHistoryOperation = {
      kind: 'valuation_update',
      positionId: pair,
      month: '2026-07',
      valuationId: july.id,
      expectedVersion: july.version,
      amount: '300',
    };

    // Alone, each leaves a zero standing as the final balance.
    for (const operation of [clearAugust, raiseJuly]) {
      const prepared = await previewHistoricalCorrection(corrections(), OCT_5, { draft: bulkDraft([operation]) });
      expect(prepared.status).toBe('review_required');
    }
    // Together they leave July's 300 as the final balance.
    await previewRefused(bulkDraft([clearAugust, raiseJuly]), where('Pair, July 2026'), `${pair}#2026-07-31`);
  });
});

describe('Preview and Confirm refuse what the ordinary write refuses', () => {
  it('Preview refuses each kind of write the ordinary save refuses, writing nothing', async () => {
    const zero = await balanceOn(savings, '2026-08-20');
    const drafts: CorrectionDraft[] = [
      { kind: 'valuation_create', positionId: savings, valuedOn: '2026-09-15', amount: '1', datePrecision: 'exact' },
      {
        kind: 'valuation_update',
        valuationId: zero.id,
        expectedVersion: zero.version,
        valuedOn: zero.valuedOn,
        amount: '1',
        datePrecision: 'exact',
      },
      { kind: 'valuation_delete', valuationId: zero.id, expectedVersion: zero.version },
      { kind: 'confirm_unchanged', positionId: savings, month: '2026-08' },
      { kind: 'confirm_unchanged_batch', month: '2026-08', positionIds: [savings] },
    ];
    const before = await worldState();
    for (const draft of drafts) {
      await expect(previewHistoricalCorrection(corrections(), OCT_5, { draft })).rejects.toMatchObject({
        message: expect.stringContaining('so its final balance has to stay zero') as unknown,
      });
    }
    expect(await worldState()).toEqual(before);
  });

  it('Confirm refuses a reviewed correction once the account has closed under it', async () => {
    const later = await account('Later');
    await statement(later, '2026-07-31', '300');
    await snapshot(later, '2026-08-20', '0');
    const zero = await balanceOn(later, '2026-08-20');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: zero.id,
      expectedVersion: zero.version,
      valuedOn: zero.valuedOn,
      amount: '500',
      datePrecision: 'exact',
    };

    // Reviewed while the account was open, which allowed it…
    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, { draft });
    if (prepared.status !== 'review_required') throw new Error('expected a review');
    // …then closed on its zero before the review was confirmed.
    await close(later, '2026-09-15');

    const before = await worldState();
    await expect(
      confirmHistoricalCorrection(corrections(), OCT_5, { draft, fingerprint: prepared.preview.fingerprint }),
    ).rejects.toMatchObject({ ...REFUSED, fieldErrors: { amount: [FINAL_ZERO] } });
    expect(await worldState()).toEqual(before);
    expect(await finalBalance(later, '2026-09-15')).toBe('0.00000000');
  });
});

describe('everything that keeps the final zero is still allowed', () => {
  it('edits earlier history: a balance recorded, corrected and removed before the zero', async () => {
    const july = await balanceOn(savings, '2026-07-31');
    const record = { positionId: savings, valuedOn: '2026-07-15', amount: '100', datePrecision: 'exact' as const };
    await expectSaved({ kind: 'valuation_create', ...record }, () => recordValuation(positions(), OCT_5, record));

    const correct = {
      valuationId: july.id,
      expectedVersion: july.version,
      valuedOn: july.valuedOn,
      amount: '250',
      datePrecision: july.precision,
    };
    await expectSaved({ kind: 'valuation_update', ...correct }, () => correctValuation(positions(), OCT_5, correct));

    const mid = await balanceOn(savings, '2026-07-15');
    const remove = { valuationId: mid.id, expectedVersion: mid.version };
    await expectSaved({ kind: 'valuation_delete', ...remove }, () => removeValuation(positions(), OCT_5, remove));

    expect((await balances(savings)).map((row) => [row.valuedOn, row.amount])).toEqual([
      ['2026-07-31', '250.00000000'],
      ['2026-08-20', '0.00000000'],
    ]);
  });

  it('records a zero, between the last zero and the closing day and on the closing day itself', async () => {
    const august = { positionId: savings, valuedOn: '2026-08-31', amount: '0', datePrecision: 'month_end' as const };
    await expectSaved({ kind: 'valuation_create', ...august }, () => recordValuation(positions(), OCT_5, august));
    const closing = { positionId: savings, valuedOn: '2026-09-15', amount: '0.00', datePrecision: 'exact' as const };
    await expectSaved({ kind: 'valuation_create', ...closing }, () => recordValuation(positions(), OCT_5, closing));

    expect(await finalBalance(savings, '2026-09-15')).toBe('0.00000000');
  });

  it('corrects the final zero to zero, in place or re-dated later', async () => {
    const zero = await balanceOn(savings, '2026-08-20');
    const noted = {
      valuationId: zero.id,
      expectedVersion: zero.version,
      valuedOn: zero.valuedOn,
      amount: '0.00',
      datePrecision: zero.precision,
      note: 'Emptied into the new account',
    };
    await expectSaved({ kind: 'valuation_update', ...noted }, () => correctValuation(positions(), OCT_5, noted));

    const noteless = await balanceOn(savings, '2026-08-20');
    const later = {
      valuationId: noteless.id,
      expectedVersion: noteless.version,
      valuedOn: '2026-09-10',
      amount: '0',
      datePrecision: noteless.precision,
    };
    await expectSaved({ kind: 'valuation_update', ...later }, () => correctValuation(positions(), OCT_5, later));

    expect((await balances(savings)).map((row) => [row.valuedOn, row.amount])).toEqual([
      ['2026-07-31', '300.00000000'],
      ['2026-09-10', '0.00000000'],
    ]);
  });

  it('confirms a month unchanged before the zero, and a zero carried forward after it', async () => {
    const pocket = await account('Pocket');
    await statement(pocket, '2026-05-31', '200');
    await statement(pocket, '2026-07-31', '0');
    await close(pocket, '2026-09-15');

    const june = { positionId: pocket, month: '2026-06' };
    await expectSaved({ kind: 'confirm_unchanged', ...june }, () => confirmUnchanged(positions(), OCT_5, june));
    const august = { month: '2026-08', positionIds: [pocket] };
    await expectSaved({ kind: 'confirm_unchanged_batch', ...august }, () =>
      confirmUnchangedBatch(positions(), OCT_5, august),
    );

    expect((await balances(pocket)).map((row) => [row.valuedOn, row.amount])).toEqual([
      ['2026-05-31', '200.00000000'],
      ['2026-06-30', '200.00000000'],
      ['2026-07-31', '0.00000000'],
      ['2026-08-31', '0.00000000'],
    ]);
  });

  it('saves a Bulk History batch that keeps the zero', async () => {
    const july = await balanceOn(savings, '2026-07-31');
    const draft = bulkDraft([
      {
        kind: 'valuation_update',
        positionId: savings,
        month: '2026-07',
        valuationId: july.id,
        expectedVersion: july.version,
        amount: '250',
      },
      { kind: 'valuation_create', positionId: savings, month: '2026-08', amount: '0' },
    ]);
    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, { draft });
    if (prepared.status !== 'review_required') throw new Error('expected a review');
    expect(
      await confirmHistoricalCorrection(corrections(), OCT_5, { draft, fingerprint: prepared.preview.fingerprint }),
    ).toMatchObject({ status: 'committed' });

    expect((await balances(savings)).map((row) => [row.valuedOn, row.amount])).toEqual([
      ['2026-07-31', '250.00000000'],
      ['2026-08-20', '0.00000000'],
      ['2026-08-31', '0.00000000'],
    ]);
  });

  it('still refuses to remove the balance dated on the closing day, saying why', async () => {
    const closing = { positionId: savings, valuedOn: '2026-09-15', amount: '0', datePrecision: 'exact' as const };
    await recordValuation(positions(), OCT_5, closing);
    const row = await balanceOn(savings, '2026-09-15');

    const args = { valuationId: row.id, expectedVersion: row.version };
    await expectRefused({ kind: 'valuation_delete', ...args }, () => removeValuation(positions(), OCT_5, args), {
      code: 'IMPOSSIBLE_OPERATION',
      message: 'This is the closing balance of a closed account, so it cannot be removed.',
    });
  });
});

describe('an account already holding money after its close', () => {
  // Only a write from before this rule could have left one: the balance is
  // put in place directly, as such a write would have left it.
  beforeEach(async () => {
    await harness.asOwner(
      `INSERT INTO position_valuations (user_id, position_id, valued_on, amount, source, date_precision)
       VALUES ($1, $2, DATE '2026-08-31', 500, 'entered', 'month_end')`,
      [USER_A, savings],
    );
  });

  it('refuses any write that leaves it so, even to earlier history', async () => {
    const july = await balanceOn(savings, '2026-07-31');
    const args = {
      valuationId: july.id,
      expectedVersion: july.version,
      valuedOn: july.valuedOn,
      amount: '250',
      datePrecision: july.precision,
    };
    // Keyed to the date: the balance written is not the final one, a later
    // stored one is.
    await expectRefused({ kind: 'valuation_update', ...args }, () => correctValuation(positions(), OCT_5, args), {
      ...REFUSED,
      fieldErrors: { valuedOn: [FINAL_ZERO] },
    });
  });

  it('takes a correction of the stray balance to zero, and then earlier edits again', async () => {
    const stray = await balanceOn(savings, '2026-08-31');
    const fix = {
      valuationId: stray.id,
      expectedVersion: stray.version,
      valuedOn: stray.valuedOn,
      amount: '0',
      datePrecision: stray.precision,
    };
    await expectSaved({ kind: 'valuation_update', ...fix }, () => correctValuation(positions(), OCT_5, fix));
    expect(await finalBalance(savings, '2026-09-15')).toBe('0.00000000');

    const july = await balanceOn(savings, '2026-07-31');
    const edit = { ...fix, valuationId: july.id, expectedVersion: july.version, valuedOn: july.valuedOn, amount: '250' };
    await expectSaved({ kind: 'valuation_update', ...edit }, () => correctValuation(positions(), OCT_5, edit));
  });

  it('takes the removal of the stray balance', async () => {
    const stray = await balanceOn(savings, '2026-08-31');
    const remove = { valuationId: stray.id, expectedVersion: stray.version };
    await expectSaved({ kind: 'valuation_delete', ...remove }, () => removeValuation(positions(), OCT_5, remove));
    expect(await finalBalance(savings, '2026-09-15')).toBe('0.00000000');
  });

  it('takes a zero recorded on the closing day', async () => {
    const closing = { positionId: savings, valuedOn: '2026-09-15', amount: '0', datePrecision: 'exact' as const };
    await expectSaved({ kind: 'valuation_create', ...closing }, () => recordValuation(positions(), OCT_5, closing));
    expect(await finalBalance(savings, '2026-09-15')).toBe('0.00000000');
  });
});
