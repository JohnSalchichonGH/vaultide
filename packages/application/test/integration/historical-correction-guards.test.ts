import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  closePosition,
  createCashAccount,
  updateCashAccount,
} from '../../src/positions/service';
import {
  confirmMonthEnd,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  quickUpdate,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry, updateExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry, deleteIncomeEntry, updateIncomeEntry } from '../../src/flows/income';
import {
  createCashTransfer,
  deleteCashTransfer,
  updateCashTransfer,
} from '../../src/flows/transfers';
import { createTemplate } from '../../src/recurring/templates';
import { acceptSuggestion } from '../../src/recurring/suggestions';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';

/**
 * Nothing rewrites completed history without consent (blueprint 30.22 items 1
 * and 2; ADR 0010 §1; §99, §100, §105, §106 of the slice prompt).
 *
 * Three things are proved here, and they are the reason the feature is safe
 * rather than merely available:
 *
 *  - **no ordinary service call can bypass the ceremony.** Every mutation is
 *    invoked directly — not through a server action, not through the
 *    interface — and a qualifying historical write is refused before a single
 *    row moves. The same operation then succeeds through Preview → Confirm.
 *  - **dormancy is covered wherever it can move.** A dormant episode is dated
 *    evidence, and the paths that can end one include several that are
 *    otherwise ordinary creations. Each of them is checked, and each of them
 *    stays ordinary when its consequence does not reach a closed month.
 *  - **the month-closing lifecycle is untouched.** `closePosition`,
 *    `confirmMonthEnd`, `confirmUnchanged` and `confirmUnchangedBatch` write
 *    dates into completed months by design and are not corrections. They keep
 *    their contracts exactly.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_5 = on('2026-10-05');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;
const corrections = () => harness.services.corrections;

const REVIEW_REQUIRED = { code: 'HISTORICAL_REVIEW_REQUIRED' };

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const statement = (positionId: string, valuedOn: string, amount: string) =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'month_end' });

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

async function valuationOn(positionId: string, valuedOn: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version FROM position_valuations
           WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows[0] as { id: string; version: number };
  });
}

async function auditActions(entityId: string): Promise<string[]> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action::text AS action FROM audit_entries
           WHERE entity_id = ${entityId} ORDER BY occurred_at`,
    );
    return (result.rows as { action: string }[]).map((row) => row.action);
  });
}

async function countRows(table: string): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`);
    return Number((result.rows[0] as { n: string }).n);
  });
}

const AWAKE = { dormant: false, from: null };

async function preview(draft: CorrectionDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections(), ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error(`expected review to be required, got ${prepared.status}`);
  }
  return prepared.preview;
}

async function reviewAndConfirm(draft: CorrectionDraft, reason?: string, ctx = OCT_5) {
  const result = await preview(draft, ctx);
  const outcome = await confirmHistoricalCorrection(corrections(), ctx, {
    draft,
    fingerprint: result.fingerprint,
    ...(reason === undefined ? {} : { reason }),
  });
  expect(outcome.status).toBe('committed');
  return result;
}

/** Start a dormant episode anchored in a closed month, through the ceremony. */
async function dormantSince(positionId: string, zeroOn: string): Promise<void> {
  await recordValuation(positions(), OCT_5, {
    positionId,
    valuedOn: zeroOn,
    amount: '0',
    datePrecision: 'month_end',
  });
  await reviewAndConfirm({
    kind: 'cash_account_update',
    positionId,
    expectedVersion: (await state(positionId)).version,
    isDormant: true,
  });
  expect(await state(positionId)).toMatchObject({ dormant: true, from: zeroOn });
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });
  groceries = (await listCategories(harness.db, USER_A)).find((row) => row.name === 'Groceries')
    ?.id as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const table of [
    'expense_entries',
    'transfers',
    'income_entries',
    'recurring_template_skips',
    'recurring_template_terms',
    'recurring_templates',
    'month_reviews',
    'audit_entries',
    'position_valuations',
    'cash_accounts',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  const make = (name: string, accountType: 'checking' | 'savings') =>
    createCashAccount(positions(), OCT_5, { name, currency: 'EUR', accountType, openedOn: null });
  bbva = (await make('BBVA', 'checking')).id;
  savings = (await make('Savings', 'savings')).id;
});

/* -------------------------------------------------------------------------- */
/* The bypass matrix                                                           */
/* -------------------------------------------------------------------------- */

describe('no ordinary service call bypasses the ceremony (§105)', () => {
  async function septemberIncome() {
    return createIncomeEntry(flows(), OCT_5, {
      kind: 'employment',
      receivedOn: '2026-09-10',
      netAmount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
  }

  async function septemberExpense() {
    return createExpenseEntry(flows(), OCT_5, {
      categoryId: groceries,
      incurredOn: '2026-09-12',
      amount: '40.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
  }

  async function septemberTransfer() {
    return createCashTransfer(flows(), OCT_5, {
      occurredOn: '2026-09-15',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '100.00',
      toAmount: '100.00',
    });
  }

  it('refuses a valuation correction, then commits the same one through Review → Confirm', async () => {
    await statement(bbva, '2026-09-30', '5000.00');
    const anchor = await valuationOn(bbva, '2026-09-30');
    const args = {
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '5100.00',
      datePrecision: 'month_end' as const,
    };

    await expect(correctValuation(positions(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    // Nothing was written, so the balance's audit trail is still just its insert.
    expect(await auditActions(anchor.id)).toEqual(['insert']);

    await reviewAndConfirm({ kind: 'valuation_update', ...args });
    expect((await valuationOn(bbva, '2026-09-30')).version).toBe(anchor.version + 1);
  });

  it('refuses a valuation delete, then commits it through the ceremony', async () => {
    await statement(bbva, '2026-09-30', '5000.00');
    const anchor = await valuationOn(bbva, '2026-09-30');
    const args = { valuationId: anchor.id, expectedVersion: anchor.version };

    await expect(removeValuation(positions(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await countRows('position_valuations')).toBe(1);

    await reviewAndConfirm({ kind: 'valuation_delete', ...args });
    expect(await countRows('position_valuations')).toBe(0);
  });

  it('refuses an income correction and an income delete, then commits each', async () => {
    const entry = await septemberIncome();

    await expect(
      updateIncomeEntry(flows(), OCT_5, {
        entryId: entry.id,
        expectedVersion: entry.version,
        netAmount: '550.00',
      }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      netAmount: '550.00',
    });

    await expect(
      deleteIncomeEntry(flows(), OCT_5, { entryId: entry.id, expectedVersion: entry.version + 1 }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({
      kind: 'income_delete',
      entryId: entry.id,
      expectedVersion: entry.version + 1,
    });
    expect(await countRows('income_entries')).toBe(0);
  });

  it('refuses an expense correction and an expense delete, then commits each', async () => {
    const entry = await septemberExpense();

    await expect(
      updateExpenseEntry(flows(), OCT_5, {
        entryId: entry.id,
        expectedVersion: entry.version,
        amount: '45.00',
      }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({
      kind: 'expense_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      amount: '45.00',
    });
    await reviewAndConfirm({
      kind: 'expense_delete',
      entryId: entry.id,
      expectedVersion: entry.version + 1,
    });
    expect(await countRows('expense_entries')).toBe(0);
  });

  it('refuses a transfer correction and a transfer delete, then commits each', async () => {
    const saved = await septemberTransfer();
    const base = {
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      occurredOn: '2026-09-15',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '120.00',
      toAmount: '120.00',
      description: null,
      fee: null,
      expectedFee: { state: 'absent' as const },
    };

    await expect(updateCashTransfer(flows(), OCT_5, base)).rejects.toMatchObject(REVIEW_REQUIRED);
    await reviewAndConfirm({ kind: 'transfer_update', ...base });

    const removal = {
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version + 1,
      expectedFees: [],
    };
    await expect(deleteCashTransfer(flows(), OCT_5, removal)).rejects.toMatchObject(REVIEW_REQUIRED);
    await reviewAndConfirm({ kind: 'transfer_delete', ...removal });
    expect(await countRows('transfers')).toBe(0);
  });

  it('leaves an ordinary current-month edit working directly', async () => {
    const entry = await createIncomeEntry(flows(), OCT_5, {
      kind: 'employment',
      receivedOn: '2026-10-02',
      netAmount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    const updated = await updateIncomeEntry(flows(), OCT_5, {
      entryId: entry.id,
      expectedVersion: entry.version,
      netAmount: '525.00',
    });
    expect(updated.netAmount).toBe('525.00000000');

    await deleteIncomeEntry(flows(), OCT_5, {
      entryId: entry.id,
      expectedVersion: updated.version,
    });
    expect(await countRows('income_entries')).toBe(0);
  });

  it('leaves a historical first assertion working directly (30.22 item 2)', async () => {
    // Recording a September expense in October is not a revision of anything.
    const created = await septemberExpense();
    expect(created.incurredOn).toBe('2026-09-12');

    await statement(bbva, '2026-08-31', '4000.00');
    expect((await valuationOn(bbva, '2026-08-31')).id).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Dormancy                                                                    */
/* -------------------------------------------------------------------------- */

describe('every path that can end a historical dormant episode (§99)', () => {
  const dormancyChangeOf = (result: CorrectionPreview) =>
    result.structuralChanges.find((change) => change.kind === 'dormancy_episode');

  it('updateCashAccount starting an episode anchored in a closed month', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: savings,
      valuedOn: '2026-08-31',
      amount: '0',
      datePrecision: 'month_end',
    });
    const version = (await state(savings)).version;

    await expect(
      updateCashAccount(positions(), OCT_5, {
        positionId: savings,
        expectedVersion: version,
        isDormant: true,
      }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await state(savings)).toMatchObject(AWAKE);

    const result = await reviewAndConfirm({
      kind: 'cash_account_update',
      positionId: savings,
      expectedVersion: version,
      isDormant: true,
    });
    expect(dormancyChangeOf(result)).toMatchObject({
      kind: 'dormancy_episode',
      positionId: savings,
      before: null,
      after: '2026-08-31',
    });
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-08-31' });
  });

  it('updateCashAccount clearing an episode anchored in a closed month', async () => {
    await dormantSince(savings, '2026-08-31');
    const version = (await state(savings)).version;

    await expect(
      updateCashAccount(positions(), OCT_5, {
        positionId: savings,
        expectedVersion: version,
        isDormant: false,
      }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    const result = await reviewAndConfirm({
      kind: 'cash_account_update',
      positionId: savings,
      expectedVersion: version,
      isDormant: false,
    });
    expect(dormancyChangeOf(result)).toMatchObject({ before: '2026-08-31', after: null });
    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('a rename of a dormant account stays an ordinary edit', async () => {
    await dormantSince(savings, '2026-08-31');
    const version = (await state(savings)).version;

    // The account form resends the checkbox with every save; that is not a
    // transition, so nothing about it is a correction (§10).
    const renamed = await updateCashAccount(positions(), OCT_5, {
      positionId: savings,
      expectedVersion: version,
      name: 'Old savings',
      isDormant: true,
    });
    expect(renamed.name).toBe('Old savings');
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-08-31' });
  });

  it('recordValuation putting money back into a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const args = {
      positionId: savings,
      valuedOn: '2026-10-02',
      amount: '400.00',
      datePrecision: 'exact' as const,
    };

    await expect(recordValuation(positions(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-08-31' });

    const result = await reviewAndConfirm({ kind: 'valuation_create', ...args });
    expect(dormancyChangeOf(result)).toMatchObject({ before: '2026-08-31', after: null });
    // The balance and the wake are one outcome.
    expect(await state(savings)).toMatchObject(AWAKE);
    expect((await valuationOn(savings, '2026-10-02')).id).toBeDefined();
  });

  it('quickUpdate putting money back into a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const entries = [{ positionId: savings, amount: '400.00' }];

    await expect(quickUpdate(positions(), OCT_5, { entries })).rejects.toMatchObject(
      REVIEW_REQUIRED,
    );
    expect(await countRows('position_valuations')).toBe(1);

    await reviewAndConfirm({ kind: 'quick_update', entries });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect((await valuationOn(savings, '2026-10-05')).id).toBeDefined();
  });

  it('quickUpdate writing a zero into it stays ordinary: a zero is not money', async () => {
    await dormantSince(savings, '2026-08-31');

    await quickUpdate(positions(), OCT_5, { entries: [{ positionId: savings, amount: '0.00' }] });
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-08-31' });
  });

  it('createIncomeEntry attributed to a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const args = {
      kind: 'employment' as const,
      receivedOn: '2026-10-02',
      netAmount: '80.00',
      currency: 'EUR',
      settlement: 'tracked_cash' as const,
      cashPositionId: savings,
    };

    await expect(createIncomeEntry(flows(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await countRows('income_entries')).toBe(0);

    await reviewAndConfirm({
      kind: 'income_create',
      incomeKind: 'employment',
      receivedOn: args.receivedOn,
      netAmount: args.netAmount,
      currency: args.currency,
      settlement: args.settlement,
      cashPositionId: savings,
    });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await countRows('income_entries')).toBe(1);
  });

  it('createExpenseEntry attributed to a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const args = {
      categoryId: groceries,
      incurredOn: '2026-10-02',
      amount: '12.00',
      currency: 'EUR',
      settlement: 'tracked_cash' as const,
      cashPositionId: savings,
    };

    await expect(createExpenseEntry(flows(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({ kind: 'expense_create', ...args });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await countRows('expense_entries')).toBe(1);
  });

  it('createCashTransfer touching a historically dormant endpoint', async () => {
    await dormantSince(savings, '2026-08-31');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-01',
      amount: '900.00',
      datePrecision: 'exact',
    });
    const args = {
      occurredOn: '2026-10-02',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '50.00',
      toAmount: '50.00',
    };

    await expect(createCashTransfer(flows(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await countRows('transfers')).toBe(0);

    await reviewAndConfirm({ kind: 'transfer_create', ...args });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await countRows('transfers')).toBe(1);
  });

  it('acceptSuggestion materializing an occurrence onto a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const { template } = await createTemplate(flows(), OCT_5, {
      kind: 'income',
      name: 'Interest',
      incomeKind: 'interest',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 2,
      startDate: '2026-01-01',
      cashPositionId: savings,
      amount: '3.00',
    });
    const args = { templateId: template.id, occurrenceDate: '2026-10-02' };

    await expect(acceptSuggestion(flows(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await countRows('income_entries')).toBe(0);
    // The preview claims nothing: no flow and no skip carries the occurrence,
    // so it is still offered (§12).
    expect(await countRows('recurring_template_skips')).toBe(0);

    const result = await reviewAndConfirm({ kind: 'accept_suggestion', ...args });
    expect(dormancyChangeOf(result)).toMatchObject({ before: '2026-08-31', after: null });
    expect(await state(savings)).toMatchObject(AWAKE);

    const entry = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT template_id::text AS "templateId", occurrence_date::text AS "occurrenceDate"
              FROM income_entries`,
      );
      return rows.rows[0] as { templateId: string; occurrenceDate: string };
    });
    expect(entry).toEqual({ templateId: template.id, occurrenceDate: '2026-10-02' });

    // And it is not suggested again.
    await expect(acceptSuggestion(flows(), OCT_5, args)).rejects.toMatchObject({
      code: 'CONFLICT_DUPLICATE',
    });
  });

  it('acceptSuggestion onto an awake account stays ordinary, historical date and all', async () => {
    const { template } = await createTemplate(flows(), OCT_5, {
      kind: 'income',
      name: 'Interest',
      incomeKind: 'interest',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 2,
      startDate: '2026-01-01',
      cashPositionId: bbva,
      amount: '3.00',
    });

    const accepted = await acceptSuggestion(flows(), OCT_5, {
      templateId: template.id,
      occurrenceDate: '2026-09-02',
    });
    expect(accepted.kind).toBe('income');
    if (accepted.kind !== 'income') throw new Error('unreachable');
    expect(accepted.entry.receivedOn).toBe('2026-09-02');
  });

  it('correctValuation that wakes a historically dormant account', async () => {
    await dormantSince(savings, '2026-08-31');
    const anchor = await valuationOn(savings, '2026-08-31');
    const args = {
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-08-31',
      amount: '25.00',
      datePrecision: 'month_end' as const,
    };

    await expect(correctValuation(positions(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({ kind: 'valuation_update', ...args }, 'Statement showed 25');
    expect(await state(savings)).toMatchObject(AWAKE);

    const audits = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT entity_table, action::text AS action, reason FROM audit_entries
             WHERE action = 'update' ORDER BY entity_table`,
      );
      return rows.rows as { entity_table: string; action: string; reason: string | null }[];
    });
    // The balance and the dormancy consequence are audited together, and the
    // reason reaches the source row the user was correcting (§64, §104).
    expect(audits.map((row) => row.entity_table)).toContain('position_valuations');
    expect(audits.map((row) => row.entity_table)).toContain('cash_accounts');
    expect(
      audits.find((row) => row.entity_table === 'position_valuations')?.reason,
    ).toBe('Statement showed 25');
  });

  it('removeValuation that removes a historical anchor', async () => {
    await dormantSince(savings, '2026-08-31');
    const anchor = await valuationOn(savings, '2026-08-31');
    const args = { valuationId: anchor.id, expectedVersion: anchor.version };

    await expect(removeValuation(positions(), OCT_5, args)).rejects.toMatchObject(REVIEW_REQUIRED);

    await reviewAndConfirm({ kind: 'valuation_delete', ...args });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await countRows('position_valuations')).toBe(0);
  });

  it('a current-month dormant episode is ordinary in both directions', async () => {
    // The zero is dated in October, so nothing closed is reinterpreted.
    await recordValuation(positions(), OCT_5, {
      positionId: savings,
      valuedOn: '2026-10-01',
      amount: '0',
      datePrecision: 'exact',
    });
    const marked = await updateCashAccount(positions(), OCT_5, {
      positionId: savings,
      expectedVersion: (await state(savings)).version,
      isDormant: true,
    });
    expect(marked).toMatchObject({ isDormant: true, dormantFrom: '2026-10-01' });

    // And waking it again is ordinary too.
    await recordValuation(positions(), OCT_5, {
      positionId: savings,
      valuedOn: '2026-10-03',
      amount: '10.00',
      datePrecision: 'exact',
    });
    expect(await state(savings)).toMatchObject(AWAKE);
  });
});

/* -------------------------------------------------------------------------- */
/* The month-closing lifecycle                                                 */
/* -------------------------------------------------------------------------- */

describe('the month-closing lifecycle is not a correction (§4, §106)', () => {
  it('confirmUnchanged still carries the previous statement into a closed month', async () => {
    await statement(bbva, '2026-08-31', '5000.00');

    const written = await confirmUnchanged(positions(), OCT_5, {
      positionId: bbva,
      month: '2026-09',
    });
    expect(written).toMatchObject({
      valuedOn: '2026-09-30',
      amount: '5000.00000000',
      source: 'confirmed_unchanged',
      datePrecision: 'month_end',
    });
  });

  it('confirmUnchangedBatch still closes several accounts at once', async () => {
    await statement(bbva, '2026-08-31', '5000.00');
    await statement(savings, '2026-08-31', '2000.00');

    const summary = await confirmUnchangedBatch(positions(), OCT_5, {
      month: '2026-09',
      positionIds: [bbva, savings],
    });
    expect(summary).toMatchObject({ month: '2026-09', valuedOn: '2026-09-30', confirmed: 2 });
  });

  it('confirmMonthEnd still promotes a last-day snapshot in a closed month', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-09-30',
      amount: '5000.00',
      datePrecision: 'exact',
    });
    const snapshot = await valuationOn(bbva, '2026-09-30');

    const promoted = await confirmMonthEnd(positions(), OCT_5, {
      valuationId: snapshot.id,
      expectedVersion: snapshot.version,
    });
    expect(promoted.datePrecision).toBe('month_end');
  });

  it('closePosition still closes an account on a date in a closed month', async () => {
    await statement(bbva, '2026-08-31', '0');

    const closed = await closePosition(positions(), OCT_5, {
      positionId: bbva,
      expectedVersion: (await state(bbva)).version,
      closedOn: '2026-08-31',
    });
    expect(closed).toMatchObject({ status: 'closed', closedOn: '2026-08-31' });
  });
});
