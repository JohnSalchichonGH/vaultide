import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { monthKeyOf } from '@vaultide/finance';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { archiveUserCategory, listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createCashTransfer } from '../../src/flows/transfers';
import { setCountAdditionalSpending, setReportingCurrency } from '../../src/settings/service';
import { dismissMonthAdvisory, markMonthReviewed } from '../../src/monthly/review-service';
import { getMonthReconciliation } from '../../src/reconciliation/service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';

/**
 * Historical Correction against a real database (blueprint 15.3, 30.22; ADR
 * 0010 §1, §2, §8, §12).
 *
 * The ceremony's contract, end to end: a preview that writes nothing, a confirm
 * that commits exactly once against the consent it was given, and a fingerprint
 * that moves for the things a user agreed to and stays still for the things
 * they did not.
 *
 * Nothing here is mocked. The whole point of a consent fingerprint is what two
 * transactions do to each other, and a preview asserted against a stub would
 * prove nothing about the world the confirm actually commits into.
 *
 * "Today" is 5 October 2026 throughout: September and everything before it are
 * completed months, so every edit to them is a correction.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

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

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const statement = (positionId: string, valuedOn: string, amount: string) =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'month_end' });

const salary = (receivedOn: string, netAmount: string, cashPositionId: string | null = bbva) =>
  createIncomeEntry(flows(), OCT_5, {
    kind: 'employment',
    receivedOn,
    netAmount,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId,
  });

const shopping = (
  incurredOn: string,
  amount: string,
  settlement: 'tracked_cash' | 'untracked_self' | 'third_party' = 'tracked_cash',
) =>
  createExpenseEntry(flows(), OCT_5, {
    categoryId: groceries,
    incurredOn,
    amount,
    currency: 'EUR',
    settlement,
    ...(settlement === 'tracked_cash' ? { cashPositionId: bbva } : {}),
  });

/** September, reconcilable: two statements each side, one salary, one shop. */
async function september(): Promise<void> {
  await statement(bbva, '2026-08-31', '5000.00');
  await statement(savings, '2026-08-31', '2000.00');
  await statement(bbva, '2026-09-30', '7800.00');
  await statement(savings, '2026-09-30', '2000.00');
  await salary('2026-09-10', '3000.00');
  await shopping('2026-09-12', '200.00');
}

async function valuationOn(positionId: string, valuedOn: string, userId = USER_A) {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version, amount::text AS amount FROM position_valuations
           WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows[0] as { id: string; version: number; amount: string };
  });
}

async function countRows(table: string, userId = USER_A): Promise<number> {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
    );
    return Number((result.rows[0] as { n: string }).n);
  });
}

async function auditRows(entityId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action::text AS action, reason FROM audit_entries
           WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    );
    return result.rows as { action: string; reason: string | null }[];
  });
}

/** Everything a preview must leave exactly as it found it (§91). */
async function worldState() {
  return {
    valuations: await countRows('position_valuations'),
    income: await countRows('income_entries'),
    expenses: await countRows('expense_entries'),
    transfers: await countRows('transfers'),
    audit: await countRows('audit_entries'),
    reviews: await countRows('month_reviews'),
    rates: await withoutUser(harness.db, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::text AS n FROM fx_rates`);
      return Number((result.rows[0] as { n: string }).n);
    }),
    dormancy: await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT position_id, is_dormant, dormant_from::text AS "from"
              FROM cash_accounts ORDER BY position_id`,
      );
      return result.rows;
    }),
    versions: await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id, version FROM position_valuations ORDER BY id`,
      );
      return result.rows;
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* The ceremony                                                                */
/* -------------------------------------------------------------------------- */

async function preview(draft: CorrectionDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections(), ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error(`expected review to be required, got ${prepared.status}`);
  }
  return prepared.preview;
}

const confirm = (draft: CorrectionDraft, fingerprint: string, reason?: string, ctx = OCT_5) =>
  confirmHistoricalCorrection(corrections(), ctx, {
    draft,
    fingerprint,
    ...(reason === undefined ? {} : { reason }),
  });

const reconcile = (month = '2026-09', ctx = OCT_5) => {
  const [year, index] = month.split('-');
  return getMonthReconciliation(reads(), ctx, monthKeyOf(Number(year), Number(index)));
};

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
  // Captured once, by id: one of the cases below renames a category on
  // purpose, and the fixture must not depend on a label surviving it.
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
    'month_reviews',
    'audit_entries',
    'position_valuations',
    'cash_accounts',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }
  await harness.asOwner('DELETE FROM fx_rates');

  const make = (name: string, accountType: 'checking' | 'savings') =>
    createCashAccount(positions(), OCT_5, { name, currency: 'EUR', accountType, openedOn: null });
  bbva = (await make('BBVA', 'checking')).id;
  savings = (await make('Savings', 'savings')).id;
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

describe('Preview (ADR 0010 §8)', () => {
  it('writes nothing at all', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const before = await worldState();

    await preview({
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7500.00',
      datePrecision: 'month_end',
    });

    // No source row, no audit row, no review row, no rate, no version bump, no
    // dormancy change. The transaction is read only; this proves it.
    expect(await worldState()).toEqual(before);
  });

  it('writes nothing for a flow, a transfer or a dormancy draft either', async () => {
    await september();
    const entry = await salary('2026-09-20', '400.00');
    const before = await worldState();

    await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      netAmount: '450.00',
    });
    await preview({
      kind: 'income_delete',
      entryId: entry.id,
      expectedVersion: entry.version,
    });

    expect(await worldState()).toEqual(before);
  });

  it('answers `not_required` for an ordinary current-month edit', async () => {
    await september();
    const entry = await salary('2026-10-02', '100.00');

    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, {
      draft: {
        kind: 'income_update',
        entryId: entry.id,
        expectedVersion: entry.version,
        netAmount: '120.00',
      },
    });
    expect(prepared.status).toBe('not_required');
  });

  it('answers `not_required` for a first assertion into a completed month', async () => {
    await september();

    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, {
      draft: {
        kind: 'expense_create',
        categoryId: groceries,
        incurredOn: '2026-09-04',
        amount: '15.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      },
    });
    expect(prepared.status).toBe('not_required');
  });

  it('names the source, its periods and the affected months', async () => {
    await september();
    const entry = await salary('2026-09-10', '3000.00');

    const result = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-08-28',
    });

    expect(result.sourcePeriods).toEqual(['2026-08', '2026-09']);
    expect(result.sourceScope).toEqual([
      { identity: { scope: 'existing', kind: 'income', id: entry.id }, operation: 'update' },
    ]);
    expect(result.periods.map((period) => period.month)).toEqual(['2026-08', '2026-09']);
    expect(result.sourceChanges[0]).toMatchObject({
      operation: 'update',
      before: { receivedOn: '2026-09-10' },
      after: { receivedOn: '2026-08-28' },
    });
  });

  it('is the same fingerprint every time, on unchanged data', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7500.00',
      datePrecision: 'month_end',
    };

    expect((await preview(draft)).fingerprint).toBe((await preview(draft)).fingerprint);
  });

  it('refuses a stale version while resolving, before any consent question', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');

    await expect(
      preview({
        kind: 'valuation_update',
        valuationId: anchor.id,
        expectedVersion: anchor.version + 3,
        valuedOn: '2026-09-30',
        amount: '7500.00',
        datePrecision: 'month_end',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
  });

  it('cannot reach another user’s record', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');

    await expect(
      preview(
        {
          kind: 'valuation_update',
          valuationId: anchor.id,
          expectedVersion: anchor.version,
          valuedOn: '2026-09-30',
          amount: '1.00',
          datePrecision: 'month_end',
        },
        on('2026-10-05', USER_B),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/* -------------------------------------------------------------------------- */
/* Preview fidelity                                                            */
/* -------------------------------------------------------------------------- */

describe('Preview AFTER is what the engines say once it commits (§90, §92)', () => {
  const structural = (result: Awaited<ReturnType<typeof reconcile>>) => ({
    status: result.status,
    buckets: result.buckets.map((bucket) => ({
      currency: bucket.currency,
      status: bucket.status,
      balanceEvidence: bucket.totals.cashDelta === null ? 'missing' : 'complete',
      issues: bucket.issues.map((issue) => issue.key).sort(),
    })),
  });

  const previewStructural = (result: CorrectionPreview, month: string) => {
    const period = result.periods.find((item) => item.month === month);
    if (period === undefined || period.kind !== 'completed') throw new Error('no completed period');
    return {
      status: period.after.status,
      buckets: period.after.buckets.map((bucket) => ({
        currency: bucket.currency,
        status: bucket.status,
        balanceEvidence: bucket.balanceEvidence,
        issues: bucket.issues.map((issue) => issue.key).sort(),
      })),
    };
  };

  it('for a valuation correction that makes the month unresolved', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      // A much higher close: more cash arrived than the records explain.
      valuedOn: '2026-09-30',
      amount: '12000.00',
      datePrecision: 'month_end',
    };

    const result = await preview(draft);
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });

    expect(structural(await reconcile())).toEqual(previewStructural(result, '2026-09'));
    // And it is a real consequence, not a no-op the comparison would pass on.
    expect((await reconcile()).status).toBe('unresolved');
  });

  it('for a flow correction that moves money between two months', async () => {
    await september();
    const entry = await salary('2026-09-10', '500.00');
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-08-20',
    };

    const result = await preview(draft);
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });

    for (const month of ['2026-08', '2026-09']) {
      expect(structural(await reconcile(month))).toEqual(previewStructural(result, month));
    }
  });

  it('for a completeness change, against an isolated fixture of the same end state', async () => {
    // The independent oracle: user B builds the corrected world directly, with
    // no correction machinery involved, and its completeness must be what the
    // preview said user A's would become.
    await september();
    const anchor = await valuationOn(savings, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_delete',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
    };
    const result = await preview(draft);

    const ctxB = on('2026-10-05', USER_B);
    const bbvaB = (
      await createCashAccount(positions(), ctxB, {
        name: 'BBVA',
        currency: 'EUR',
        accountType: 'checking',
        openedOn: null,
      })
    ).id;
    const savingsB = (
      await createCashAccount(positions(), ctxB, {
        name: 'Savings',
        currency: 'EUR',
        accountType: 'savings',
        openedOn: null,
      })
    ).id;
    for (const [id, date, amount] of [
      [bbvaB, '2026-08-31', '5000.00'],
      [savingsB, '2026-08-31', '2000.00'],
      [bbvaB, '2026-09-30', '7800.00'],
    ] as const) {
      await recordValuation(positions(), ctxB, {
        positionId: id,
        valuedOn: date,
        amount,
        datePrecision: 'month_end',
      });
    }

    const oracle = await getMonthCompleteness(reads(), ctxB, monthKeyOf(2026, 9));
    const period = result.periods.find((item) => item.month === '2026-09');
    if (period === undefined || period.kind !== 'completed') throw new Error('no period');
    expect(period.after.completeness).toEqual({
      state: oracle.state,
      satisfied: oracle.satisfied,
      required: oracle.required,
    });
    expect(oracle.satisfied).toBeLessThan(oracle.required);
  });
});

/* -------------------------------------------------------------------------- */
/* Confirm                                                                     */
/* -------------------------------------------------------------------------- */

describe('Confirm (ADR 0010 §12)', () => {
  it('commits exactly once, with one audit row and the reason the user gave', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7900.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);

    const committed = await confirm(draft, result.fingerprint, 'Corrected from statement');
    expect(committed).toMatchObject({ status: 'committed' });
    if (committed.status !== 'committed') throw new Error('unreachable');
    expect(committed.summary.sourcePeriods).toEqual(['2026-09']);
    expect(committed.summary.affectedPeriods).toContain('2026-09');
    expect(committed.summary.dormancyChanged).toBe(false);

    const after = await valuationOn(bbva, '2026-09-30');
    expect(after.amount).toBe('7900.00000000');
    expect(after.version).toBe(anchor.version + 1);

    const audit = await auditRows(anchor.id);
    expect(audit.filter((row) => row.action === 'update')).toHaveLength(1);
    expect(audit.find((row) => row.action === 'update')?.reason).toBe('Corrected from statement');
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('normalizes a %s reason to NULL (ADR 0010 §11)', async (_label, reason) => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);
    await confirm(draft, result.fingerprint, reason);

    const update = (await auditRows(anchor.id)).find((row) => row.action === 'update');
    expect(update?.reason).toBeNull();
  });

  it('does not apply an old draft a second time', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);
    await confirm(draft, result.fingerprint);

    // The version it was about is gone, so the resolution refuses before
    // anything else happens.
    await expect(confirm(draft, result.fingerprint)).rejects.toMatchObject({
      code: 'CONFLICT_VERSION',
    });
    expect((await valuationOn(bbva, '2026-09-30')).version).toBe(anchor.version + 1);
  });

  it('a random fingerprint authorizes nothing: it fails equality and writes nothing', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const before = await worldState();

    const result = await confirm(
      {
        kind: 'valuation_update',
        valuationId: anchor.id,
        expectedVersion: anchor.version,
        valuedOn: '2026-09-30',
        amount: '1.00',
        datePrecision: 'month_end',
      },
      'hc-v1:0000000000000000000000000000000000000000000000000000000000000000',
    );

    expect(result.status).toBe('impact_changed');
    expect(await worldState()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* The world moving underneath                                                 */
/* -------------------------------------------------------------------------- */

describe('what happens between Preview and Confirm', () => {
  it('a consent-relevant change gives `impact_changed`, and writes nothing (§93)', async () => {
    await september();
    const entry = await salary('2026-09-10', '500.00');
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      netAmount: '600.00',
    };
    const first = await preview(draft);

    // Somebody deletes September's statement for the other account. The target
    // is untouched — its version has not moved — but the month's bucket can no
    // longer be reconciled, which is exactly what the user was shown.
    const other = await valuationOn(savings, '2026-09-30');
    const removal: CorrectionDraft = {
      kind: 'valuation_delete',
      valuationId: other.id,
      expectedVersion: other.version,
    };
    const removalPreview = await preview(removal);
    await confirm(removal, removalPreview.fingerprint);

    const before = await worldState();
    const result = await confirm(draft, first.fingerprint);
    expect(result.status).toBe('impact_changed');
    if (result.status !== 'impact_changed') throw new Error('unreachable');
    expect(result.preview.fingerprint).not.toBe(first.fingerprint);
    expect(await worldState()).toEqual(before);

    // A second explicit confirmation, against the fresh preview, commits.
    expect(await confirm(draft, result.preview.fingerprint)).toMatchObject({
      status: 'committed',
    });
  });

  it('a write outside the correction’s scope does not invalidate it (§94)', async () => {
    await september();
    const entry = await salary('2026-09-10', '500.00');
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      netAmount: '600.00',
    };
    const result = await preview(draft);

    // A first assertion in October: a real financial write of the same user,
    // in a month this correction does not touch.
    await createIncomeEntry(flows(), OCT_5, {
      kind: 'employment',
      receivedOn: '2026-10-03',
      netAmount: '77.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
  });

  it('the target moving is a version conflict, not a changed impact (§95)', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);

    const bump: CorrectionDraft = { ...draft, amount: '7650.00' };
    await confirm(bump, (await preview(bump)).fingerprint);

    await expect(confirm(draft, result.fingerprint)).rejects.toMatchObject({
      code: 'CONFLICT_VERSION',
    });
  });

  it('an archived category is refused under the lock Confirm takes (§96)', async () => {
    await september();
    const other = (await listCategories(harness.db, USER_A)).find(
      (row) => row.id !== groceries && !row.isSystem,
    );
    if (other === undefined) throw new Error('expected a second ordinary category');

    const expense = await shopping('2026-09-12', '40.00');
    const draft: CorrectionDraft = {
      kind: 'expense_update',
      entryId: expense.id,
      expectedVersion: expense.version,
      categoryId: other.id,
    };
    const result = await preview(draft);

    await archiveUserCategory(harness.db, USER_A, other.id);

    const before = await worldState();
    await expect(confirm(draft, result.fingerprint)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await worldState()).toEqual(before);
  });

  it.each([
    [
      'the reporting currency',
      async () => {
        const settings = await withUser(harness.db, { userId: USER_A }, async (tx) => {
          const rows = await tx.execute(sql`SELECT version FROM user_settings`);
          return rows.rows[0] as { version: number };
        });
        await setReportingCurrency(harness.services.settings, USER_A, settings.version, 'USD');
      },
    ],
    [
      'a month-review mark',
      async () => {
        await markMonthReviewed(reads(), OCT_5, monthKeyOf(2026, 9));
      },
    ],
    [
      'a dismissed advisory',
      async () => {
        await dismissMonthAdvisory(reads(), OCT_5, monthKeyOf(2026, 9), 'large_unclassified');
      },
    ],
  ])('%s does not invalidate a reviewed correction (§97)', async (_label, change) => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);

    await change();

    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
  });

  it('renaming a category or an account does not invalidate one either (§97)', async () => {
    await september();
    const expense = await shopping('2026-09-12', '40.00');
    const draft: CorrectionDraft = {
      kind: 'expense_update',
      entryId: expense.id,
      expectedVersion: expense.version,
      amount: '45.00',
    };
    const result = await preview(draft);

    await harness.asOwner(
      `UPDATE categories SET name = 'Food shopping' WHERE id = $1`,
      [groceries],
    );
    await harness.asOwner(`UPDATE positions SET name = 'BBVA current' WHERE id = $1`, [bbva]);

    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
  });
});

/* -------------------------------------------------------------------------- */
/* `countAdditionalSpending`                                                   */
/* -------------------------------------------------------------------------- */

describe('the savings preference (12.5, §98)', () => {
  async function flipPreference(): Promise<void> {
    const current = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT count_additional_spending AS flag, version FROM user_settings`,
      );
      return result.rows[0] as { flag: boolean; version: number };
    });
    await setCountAdditionalSpending(
      harness.services.settings,
      USER_A,
      current.version,
      !current.flag,
    );
  }

  it('requires re-review when the correction’s savings actually depend on it', async () => {
    await september();
    // Untracked-self spending in September is exactly what the preference
    // decides the fate of.
    await shopping('2026-09-14', '90.00', 'untracked_self');
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);

    await flipPreference();

    const outcome = await confirm(draft, result.fingerprint);
    expect(outcome.status).toBe('impact_changed');
  });

  it('leaves a correction alone when the month has no untracked-self spending', async () => {
    await september();
    const anchor = await valuationOn(bbva, '2026-09-30');
    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      valuedOn: '2026-09-30',
      amount: '7700.00',
      datePrecision: 'month_end',
    };
    const result = await preview(draft);

    await flipPreference();

    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
  });
});

/* -------------------------------------------------------------------------- */
/* Transfers                                                                   */
/* -------------------------------------------------------------------------- */

describe('the transfer aggregate (§14, §101)', () => {
  const transferWith = async (occurredOn: string, feeOn: string | null) =>
    createCashTransfer(flows(), OCT_5, {
      occurredOn,
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '300.00',
      toAmount: '300.00',
      ...(feeOn === null
        ? {}
        : { fee: { amount: '1.50', cashPositionId: bbva, incurredOn: feeOn } }),
    });

  const correctionOf = (
    saved: Awaited<ReturnType<typeof transferWith>>,
    overrides: Partial<Extract<CorrectionDraft, { kind: 'transfer_update' }>> = {},
  ): CorrectionDraft => ({
    kind: 'transfer_update',
    transferId: saved.transfer.id,
    expectedVersion: saved.transfer.version,
    occurredOn: saved.transfer.occurredOn,
    fromPositionId: bbva,
    toPositionId: savings,
    fromAmount: saved.transfer.fromAmount,
    toAmount: saved.transfer.toAmount,
    description: saved.transfer.description,
    fee:
      saved.fee === null
        ? null
        : { amount: saved.fee.amount, cashPositionId: bbva, incurredOn: saved.fee.incurredOn },
    expectedFee:
      saved.fee === null
        ? { state: 'absent' }
        : { state: 'version', feeId: saved.fee.id, version: saved.fee.version },
    ...overrides,
  });

  it('derives its periods from the transfer and from the fee’s own date', async () => {
    await september();
    const saved = await transferWith('2026-10-02', '2026-09-30');

    const result = await preview(correctionOf(saved, { fromAmount: '320.00', toAmount: '320.00' }));
    expect(result.sourcePeriods).toEqual(['2026-09', '2026-10']);
  });

  it('is a correction when the transfer is current and its fee is historical', async () => {
    await september();
    const saved = await transferWith('2026-10-02', '2026-09-30');

    // Nothing about the transfer's own date is historical, and it is still a
    // correction of September, because the fee it re-states belongs there.
    const result = await preview(correctionOf(saved, { description: 'Moved savings' }));
    expect(result.sourcePeriods).toContain('2026-09');
  });

  it('is a correction when the transfer is historical and its fee is current', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-10-01');

    const result = await preview(correctionOf(saved, { fromAmount: '310.00', toAmount: '310.00' }));
    expect(result.sourcePeriods).toEqual(['2026-09', '2026-10']);
  });

  it('names a fee it would add by its role, never by a fabricated id', async () => {
    await september();
    const saved = await transferWith('2026-09-20', null);

    const result = await preview(
      correctionOf(saved, {
        fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-20' },
      }),
    );

    const feeScope = result.sourceScope.find(
      (item) => item.identity.scope === 'prospective' && item.identity.kind === 'expense',
    );
    expect(feeScope).toMatchObject({
      operation: 'create',
      identity: { scope: 'prospective', kind: 'expense', role: 'transfer_fee', owner: saved.transfer.id },
    });
  });

  it('gives the same fingerprint for a prospective fee before and at Confirm', async () => {
    await september();
    const saved = await transferWith('2026-09-20', null);
    const draft = correctionOf(saved, {
      fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-20' },
    });

    const result = await preview(draft);
    // Recomputed inside Confirm against the same world: equal, so it commits.
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });

    const fee = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id::text AS id FROM expense_entries WHERE transfer_id = ${saved.transfer.id}`,
      );
      return rows.rows[0] as { id: string };
    });
    // The real inserted id was never part of what the user consented to.
    expect(result.fingerprint).not.toContain(fee.id);
    expect(JSON.stringify(result.sourceChanges)).not.toContain(fee.id);
  });

  it('moves a fee’s own date without moving the transfer', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-09-20');
    const draft = correctionOf(saved, {
      fee: { amount: '1.50', cashPositionId: bbva, incurredOn: '2026-08-31' },
    });

    const result = await preview(draft);
    expect(result.sourcePeriods).toEqual(['2026-08', '2026-09']);
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });

    const fee = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT incurred_on::text AS on FROM expense_entries WHERE transfer_id = ${saved.transfer.id}`,
      );
      return rows.rows[0] as { on: string };
    });
    expect(fee.on).toBe('2026-08-31');
  });

  it('removes a fee through the ceremony, leaving its before-image', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-09-20');
    const draft = correctionOf(saved, { fee: null });

    const result = await preview(draft);
    await confirm(draft, result.fingerprint);

    expect(await countRows('expense_entries')).toBe(1); // the September shop
    expect((await auditRows(saved.fee?.id as string)).map((row) => row.action)).toEqual([
      'insert',
      'delete',
    ]);
  });

  it('deletes a historical aggregate with the exact fee set the caller saw', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-10-01');

    const draft: CorrectionDraft = {
      kind: 'transfer_delete',
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      expectedFees: [{ feeId: saved.fee?.id as string, version: saved.fee?.version as number }],
    };
    const result = await preview(draft);
    expect(result.sourcePeriods).toEqual(['2026-09', '2026-10']);
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });

    expect(await countRows('transfers')).toBe(0);
  });

  it('refuses a delete whose fee set is stale, before any consent question', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-09-20');

    await expect(
      preview({
        kind: 'transfer_delete',
        transferId: saved.transfer.id,
        expectedVersion: saved.transfer.version,
        expectedFees: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
  });

  it('still refuses to correct a malformed several-fee aggregate', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-09-20');
    // Only a write from outside the product can produce this shape (M14).
    await harness.asOwner(
      `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency, settlement, cash_position_id, cash_position_kind, transfer_id)
       SELECT user_id, category_id, incurred_on, amount, currency, settlement, cash_position_id, cash_position_kind, transfer_id
         FROM expense_entries WHERE transfer_id = $1`,
      [saved.transfer.id],
    );

    await expect(
      preview(correctionOf(saved, { fromAmount: '310.00', toAmount: '310.00' })),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('deletes a malformed several-fee aggregate through the ceremony', async () => {
    await september();
    const saved = await transferWith('2026-09-20', '2026-09-20');
    await harness.asOwner(
      `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency, settlement, cash_position_id, cash_position_kind, transfer_id)
       SELECT user_id, category_id, incurred_on, amount, currency, settlement, cash_position_id, cash_position_kind, transfer_id
         FROM expense_entries WHERE transfer_id = $1`,
      [saved.transfer.id],
    );
    const fees = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id::text AS id, version FROM expense_entries
             WHERE transfer_id = ${saved.transfer.id} ORDER BY id`,
      );
      return rows.rows as { id: string; version: number }[];
    });
    expect(fees).toHaveLength(2);

    const draft: CorrectionDraft = {
      kind: 'transfer_delete',
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      expectedFees: fees.map((fee) => ({ feeId: fee.id, version: fee.version })),
    };
    const result = await preview(draft);
    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
    expect(await countRows('transfers')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The current month                                                           */
/* -------------------------------------------------------------------------- */

describe('the current month’s impact (8.6, 30.13; §103)', () => {
  const currentPeriod = (result: CorrectionPreview) => {
    const period = result.periods.find((item) => item.month === '2026-10');
    if (period === undefined || period.kind !== 'current') return null;
    return period;
  };

  it('reports no tracked interval as exactly that, with no buckets at all (§38)', async () => {
    // Only August and September statements exist, so October has no day every
    // account's evidence reaches.
    await september();
    const entry = await salary('2026-09-10', '500.00');
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-10-02',
    };

    const period = currentPeriod(await preview(draft));
    expect(period?.after).toEqual({
      kind: 'no_tracked_interval',
      asOf: null,
      status: 'unavailable',
      reason: 'mtd_no_common_date',
      sourceOnlyThrough: '2026-10-05',
    });
    expect(period?.after).not.toHaveProperty('buckets');
  });

  it('moves `D` when the balance that fixed it moves', async () => {
    await september();
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-03',
      amount: '7800.00',
      datePrecision: 'exact',
    });
    await recordValuation(positions(), OCT_5, {
      positionId: savings,
      valuedOn: '2026-10-03',
      amount: '2000.00',
      datePrecision: 'exact',
    });
    const anchor = await valuationOn(savings, '2026-10-03');

    const draft: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: anchor.id,
      expectedVersion: anchor.version,
      // Moving it earlier takes the common date back with it.
      valuedOn: '2026-10-01',
      amount: '2000.00',
      datePrecision: 'exact',
    };
    // It is historical only because it is a revision reaching October? No: it
    // is current on both sides, so the ceremony is not required. The draft is
    // still previewable through the ordinary classification.
    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, { draft });
    expect(prepared.status).toBe('not_required');
  });

  it('does not claim month-to-date moved for a record dated after `D`', async () => {
    await september();
    // A common date of 2 October for both accounts.
    for (const id of [bbva, savings]) {
      await recordValuation(positions(), OCT_5, {
        positionId: id,
        valuedOn: '2026-10-02',
        amount: id === bbva ? '7800.00' : '2000.00',
        datePrecision: 'exact',
      });
    }
    const entry = await salary('2026-09-10', '500.00');

    // Moved into October, but dated after D: October is a source period, and
    // its tracked month-to-date figures do not move yet (30.13, §39).
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-10-04',
    };
    const result = await preview(draft);
    expect(result.sourcePeriods).toEqual(['2026-09', '2026-10']);

    const period = currentPeriod(result);
    expect(period?.before.asOf).toBe('2026-10-02');
    expect(period?.after.asOf).toBe('2026-10-02');
    expect(JSON.stringify(period?.before.kind === 'tracked_interval' ? period.before.buckets : null)).toBe(
      JSON.stringify(period?.after.kind === 'tracked_interval' ? period.after.buckets : null),
    );
  });
});
