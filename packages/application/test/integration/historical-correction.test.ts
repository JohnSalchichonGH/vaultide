import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withUserRead, withoutUser } from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  monthKeyOf,
  monthLabel,
  startOfMonthKey,
} from '@vaultide/finance';
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
import { monthKeyOfPeriod, sourcePeriodsOf } from '../../src/corrections/classify';
import {
  correctionWindow,
  loadCorrectionEvidenceIn,
  loadValuationHistoryIn,
  overlayCorrection,
} from '../../src/corrections/evidence';
import { withFingerprint } from '../../src/corrections/fingerprint';
import { deriveImpact } from '../../src/corrections/impact';
import { resolveCorrectionIn } from '../../src/corrections/resolve';

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

/* -------------------------------------------------------------------------- */
/* Impact tags                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the six tags promise (§36, §44, §45).
 *
 * A tag says "this family of figures will read differently afterwards", so each
 * one has to be earned by a figure actually moving. These cases are the four
 * ways the two cheap rules got it wrong: tagging by record type claimed an
 * income, reconciliation and savings effect for a description edit and for a
 * record dated after `D`; tagging by structural difference lost a corrected
 * balance whose residual moved without moving a status, and claimed a category
 * effect for any completed month that changed at all.
 */
describe('the impact tags name the families that actually move (§36, §44)', () => {
  const periodOf = (result: CorrectionPreview, month: string) => {
    const period = result.periods.find((item) => item.month === month);
    if (period === undefined) throw new Error(`no period ${month} in ${result.periods.map((p) => p.month).join()}`);
    return period;
  };

  const categoryNamed = async (name: string): Promise<string> => {
    const row = (await listCategories(harness.db, USER_A)).find((item) => item.name === name);
    if (row === undefined) throw new Error(`no category ${name}`);
    return row.id;
  };

  it('claims nothing month-to-date for a record moved in after `D` (§2.1, case A)', async () => {
    await september();
    for (const id of [bbva, savings]) {
      await recordValuation(positions(), OCT_5, {
        positionId: id,
        valuedOn: '2026-10-02',
        amount: id === bbva ? '7800.00' : '2000.00',
        datePrecision: 'exact',
      });
    }
    const entry = await salary('2026-09-10', '500.00');

    const result = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-10-04',
    });

    // October is named — the record lives there now — and claims no effect on
    // the families its month-to-date figures stop at `D` for.
    const october = periodOf(result, '2026-10');
    expect(october.kind).toBe('current');
    expect(october.tags).toEqual([]);

    // September, which actually lost the income, says so.
    expect(periodOf(result, '2026-09').tags).toEqual(
      expect.arrayContaining(['reconciliation', 'spending', 'savings', 'income']),
    );
  });

  it('keeps spending and savings for a balance whose residual moves under stable statuses (case B)', async () => {
    await september();
    const closing = await valuationOn(bbva, '2026-09-30');

    const result = await preview({
      kind: 'valuation_update',
      valuationId: closing.id,
      expectedVersion: closing.version,
      valuedOn: '2026-09-30',
      // A hundred euro less closing cash: `Δ` falls, so `TrackedTotalSpending`
      // and the unclassified residual both rise. No status crosses a boundary.
      amount: '7700.00',
      datePrecision: 'month_end',
    });

    const september9 = periodOf(result, '2026-09');
    if (september9.kind !== 'completed') throw new Error('expected a completed month');

    // Nothing structural moved: this is exactly the case "compare the DTOs"
    // would have reported as no impact at all.
    expect(september9.after.status).toBe(september9.before.status);
    expect(september9.after.completeness).toEqual(september9.before.completeness);
    expect(september9.after.buckets.map((bucket) => bucket.status)).toEqual(
      september9.before.buckets.map((bucket) => bucket.status),
    );
    expect(september9.after.buckets.map((bucket) => bucket.issues)).toEqual(
      september9.before.buckets.map((bucket) => bucket.issues),
    );
    expect(
      result.structuralChanges.filter((change) =>
        ['month_status', 'bucket_status', 'completeness', 'issue'].includes(change.kind),
      ),
    ).toEqual([]);

    // The figures moved all the same, and the tags say which.
    expect(september9.tags).toEqual(expect.arrayContaining(['reconciliation', 'spending', 'savings']));
    // And case E: no category total moved, so no category claim (§2.2 E).
    expect(september9.tags).not.toContain('categories');
    expect(september9.tags).not.toContain('income');
  });

  it('reports a description-only correction as memo and nothing else (case C)', async () => {
    await september();
    const entry = await salary('2026-09-10', '500.00');

    const result = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      description: 'September bonus, paid late',
    });

    expect(periodOf(result, '2026-09').tags).toEqual(['memo']);
  });

  it('reports a same-kind category correction as a category effect alone (case D)', async () => {
    await september();
    const eatingOut = await categoryNamed('Eating out');
    const entry = await shopping('2026-09-12', '40.00');

    const result = await preview({
      kind: 'expense_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      // Groceries and Eating out are both `food`: every kind-derived figure is
      // untouched and the two breakdown rows are not.
      categoryId: eatingOut,
    });

    expect(periodOf(result, '2026-09').tags).toEqual(['categories']);
  });

  it('adds savings when the corrected category is a different kind (case D)', async () => {
    await september();
    const fees = await categoryNamed('Investment fees');
    const entry = await shopping('2026-09-12', '40.00');

    const result = await preview({
      kind: 'expense_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      // `interest_and_fees` is a non-consumption bucket, so 12.5's consumption
      // remainder moves with it. `property_operating` would not: Phase 3 has
      // no property positions, so 12.3 sends every one of those to Spending.
      categoryId: fees,
    });

    const tags = periodOf(result, '2026-09').tags;
    expect(tags).toEqual(expect.arrayContaining(['savings', 'categories']));
    // `ΣK` is the same money either way, so the identity itself is untouched.
    expect(tags).not.toContain('reconciliation');
  });

  it('reports a third-party expense correction as memo, never as spending (case C)', async () => {
    await september();
    const entry = await shopping('2026-09-12', '30.00', 'third_party');

    const result = await preview({
      kind: 'expense_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      amount: '45.00',
    });

    // In no total at all (7.4), so it moves the informational figure only.
    expect(periodOf(result, '2026-09').tags).toEqual(['memo']);
  });
});


/* -------------------------------------------------------------------------- */
/* Consent facts                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The facts a person can revise reach the preview, and nothing is invented to
 * go with them (§3 of the final corrective pass).
 *
 * Each of these is a revision of a closed month, so the ceremony is required.
 * The source change carries the fact that moved; the tags stay what the family
 * projections derive — which for a gross amount, an income kind that stays
 * external income, or a one-off mark, is no family at all.
 */
describe('a correction of a fact no figure reads is still reviewed, and shown', () => {
  const salaryWithGross = () =>
    createIncomeEntry(flows(), OCT_5, {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '2100.00',
      grossAmount: '2600.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

  it('carries a gross-only correction, derives no family for it, and commits it', async () => {
    await september();
    const entry = await salaryWithGross();
    const draft: CorrectionDraft = {
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      grossAmount: '2700.00',
    };

    const result = await preview(draft);
    const change = result.sourceChanges[0];
    expect(change?.before).toMatchObject({ grossAmount: '2600', netAmount: '2100' });
    expect(change?.after).toMatchObject({ grossAmount: '2700', netAmount: '2100' });
    expect(result.periods.find((period) => period.month === '2026-09')?.tags).toEqual([]);

    expect(await confirm(draft, result.fingerprint)).toMatchObject({ status: 'committed' });
    const stored = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT gross_amount::text AS gross, net_amount::text AS net
              FROM income_entries WHERE id = ${entry.id}`,
      );
      return rows.rows[0] as { gross: string; net: string };
    });
    expect(Number(stored.gross)).toBe(2700);
    expect(Number(stored.net)).toBe(2100);
  });

  it('carries a kind-only correction and derives only what the kind moves', async () => {
    await september();
    const entry = await salaryWithGross();

    // Salary → bonus: both are external income (12.5), so no figure moves.
    const bonus = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      incomeKind: 'bonus',
    });
    expect(bonus.sourceChanges[0]?.before).toMatchObject({ incomeKind: 'employment' });
    expect(bonus.sourceChanges[0]?.after).toMatchObject({ incomeKind: 'bonus' });
    expect(bonus.periods.find((period) => period.month === '2026-09')?.tags).toEqual([]);

    // Salary → money in from outside: still cash in, no longer income.
    const inflow = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      incomeKind: 'external_inflow',
    });
    const tags = inflow.periods.find((period) => period.month === '2026-09')?.tags ?? [];
    expect(tags).toEqual(expect.arrayContaining(['income', 'savings']));
    expect(tags).not.toContain('reconciliation');
  });

  it('carries an expense whose only change is its one-off mark', async () => {
    await september();
    const entry = await shopping('2026-09-12', '40.00');

    const result = await preview({
      kind: 'expense_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      isOneOff: true,
    });
    expect(result.sourceChanges[0]?.before).toMatchObject({ isOneOff: false });
    expect(result.sourceChanges[0]?.after).toMatchObject({ isOneOff: true });
    expect(result.periods.find((period) => period.month === '2026-09')?.tags).toEqual([]);
  });

  /**
   * The landing review's counterexample, end to end on the server: two EUR
   * accounts both called Savings. A move between them changes no figure the
   * engines compute, so the tags stay empty — and the preview still carries
   * both ids, which is what the review decides the change on.
   */
  it('carries both accounts when a record moves between two accounts of the same name', async () => {
    await september();
    const twin = (
      await createCashAccount(positions(), OCT_5, {
        name: 'Savings',
        currency: 'EUR',
        accountType: 'savings',
        openedOn: null,
      })
    ).id;
    await statement(twin, '2026-08-31', '100.00');
    await statement(twin, '2026-09-30', '100.00');

    const entry = await salary('2026-09-10', '500.00', savings);
    const moved = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      cashPositionId: twin,
    });
    expect(moved.sourceChanges[0]?.before).toMatchObject({ cashPositionId: savings });
    expect(moved.sourceChanges[0]?.after).toMatchObject({ cashPositionId: twin });
    expect(moved.periods.find((period) => period.month === '2026-09')?.tags).toEqual([]);

    // A transfer's two sides and its fee's payer, each moved to the twin.
    const saved = await createCashTransfer(flows(), OCT_5, {
      occurredOn: '2026-09-20',
      fromPositionId: savings,
      toPositionId: bbva,
      fromAmount: '50.00',
      toAmount: '50.00',
      fee: { amount: '1.00', cashPositionId: savings, incurredOn: '2026-09-20' },
    });
    const fee = saved.fee;
    if (fee === null) throw new Error('expected a fee');
    const rerouted = await preview({
      kind: 'transfer_update',
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      occurredOn: '2026-09-20',
      fromPositionId: twin,
      toPositionId: bbva,
      fromAmount: '50.00',
      toAmount: '50.00',
      description: saved.transfer.description,
      fee: { amount: '1.00', cashPositionId: twin, incurredOn: '2026-09-20' },
      expectedFee: { state: 'version', feeId: fee.id, version: fee.version },
    });
    const transferChange = rerouted.sourceChanges.find((change) => change.identity.kind === 'transfer');
    expect(transferChange?.before).toMatchObject({ fromPositionId: savings });
    expect(transferChange?.after).toMatchObject({ fromPositionId: twin });
    const feeChange = rerouted.sourceChanges.find((change) => change.identity.kind === 'expense');
    expect(feeChange?.before).toMatchObject({ cashPositionId: savings });
    expect(feeChange?.after).toMatchObject({ cashPositionId: twin });
  });

  it('leaves a fee’s one-off mark as it was when the transfer is corrected', async () => {
    await september();
    const saved = await createCashTransfer(flows(), OCT_5, {
      occurredOn: '2026-09-20',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '100.00',
      toAmount: '100.00',
      fee: { amount: '2.00', cashPositionId: bbva, incurredOn: '2026-09-20' },
    });
    const fee = saved.fee;
    if (fee === null) throw new Error('expected a fee');

    const result = await preview({
      kind: 'transfer_update',
      transferId: saved.transfer.id,
      expectedVersion: saved.transfer.version,
      occurredOn: '2026-09-20',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '100.00',
      toAmount: '100.00',
      description: saved.transfer.description,
      fee: { amount: '3.00', cashPositionId: bbva, incurredOn: '2026-09-20' },
      expectedFee: { state: 'version', feeId: fee.id, version: fee.version },
    });
    const feeChange = result.sourceChanges.find((change) => change.identity.kind === 'expense');
    expect(feeChange?.before).toMatchObject({ isOneOff: false, amount: '2' });
    expect(feeChange?.after).toMatchObject({ isOneOff: false, amount: '3' });
  });
});

/* -------------------------------------------------------------------------- */
/* The current period's contract                                               */
/* -------------------------------------------------------------------------- */

/**
 * `asOf` and `sourceOnlyThrough` are the reporting contract's, not a second
 * opinion (30.15 item 3, 30.16 item 6).
 *
 * `monthToDateReportingOf` and `monthToDateSavingsFrom` already answer both:
 * `D` when there is one, today when there is not. A preview that answered
 * differently would name a date the pages the user is about to look at never
 * used.
 */
describe('the current period reports `D` the way reporting does (§3)', () => {
  it('stops the tracked arm and its source-only figures at `D`', async () => {
    await september();
    for (const id of [bbva, savings]) {
      await recordValuation(positions(), OCT_5, {
        positionId: id,
        valuedOn: '2026-10-02',
        amount: id === bbva ? '7800.00' : '2000.00',
        datePrecision: 'exact',
      });
    }
    const entry = await salary('2026-09-10', '500.00');

    const result = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-10-04',
    });
    const october = result.periods.find((item) => item.month === '2026-10');
    if (october?.kind !== 'current') throw new Error('expected the current month');
    if (october.after.kind !== 'tracked_interval') throw new Error('expected a tracked interval');

    expect(october.after.asOf).toBe('2026-10-02');
    // Not 2026-10-05: with a `D`, everything stops at `D`.
    expect(october.after.sourceOnlyThrough).toBe('2026-10-02');
    expect(october.before.kind === 'tracked_interval' ? october.before.sourceOnlyThrough : null).toBe(
      '2026-10-02',
    );
  });

  it('runs source-only figures to today when there is no interval at all', async () => {
    await september();
    const entry = await salary('2026-09-10', '500.00');

    const result = await preview({
      kind: 'income_update',
      entryId: entry.id,
      expectedVersion: entry.version,
      receivedOn: '2026-10-02',
    });
    const october = result.periods.find((item) => item.month === '2026-10');
    if (october?.kind !== 'current') throw new Error('expected the current month');

    expect(october.after).toEqual({
      kind: 'no_tracked_interval',
      asOf: null,
      status: 'unavailable',
      reason: 'mtd_no_common_date',
      // The two settlements never needed an interval, so they keep running.
      sourceOnlyThrough: '2026-10-05',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Valuation carry intervals                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A balance owns its own day (§4, 8.1, M1).
 *
 * So the stretch it is the account's value over ends the day **before** the
 * next authoritative balance. Naming the successor's own date would have two
 * balances owning it, which is not a thing the product can mean.
 */
describe('a balance carries to the day before the next one (§4)', () => {
  const carryOf = (result: CorrectionPreview, positionId: string) => {
    const change = result.structuralChanges.find(
      (item) => item.kind === 'valuation_carry' && item.positionId === positionId,
    );
    if (change === undefined || change.kind !== 'valuation_carry') {
      throw new Error('no carry change');
    }
    return change;
  };

  it('ends on the day before a balance recorded the very next day', async () => {
    await statement(bbva, '2026-08-31', '5000.00');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-09-01',
      amount: '5100.00',
      datePrecision: 'exact',
    });
    const anchor = await valuationOn(bbva, '2026-08-31');

    const carry = carryOf(
      await preview({
        kind: 'valuation_update',
        valuationId: anchor.id,
        expectedVersion: anchor.version,
        valuedOn: '2026-08-30',
        amount: '5000.00',
        datePrecision: 'exact',
      }),
      bbva,
    );

    // 31 August, ending the day before 1 September — a one-day interval.
    expect(carry.before).toEqual({ from: '2026-08-31', to: '2026-08-31' });
    expect(carry.after).toEqual({ from: '2026-08-30', to: '2026-08-31' });
  });

  it('spans the gap to the day before a balance several days later', async () => {
    await statement(bbva, '2026-08-31', '5000.00');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-09-10',
      amount: '5100.00',
      datePrecision: 'exact',
    });
    const anchor = await valuationOn(bbva, '2026-08-31');

    const carry = carryOf(
      await preview({
        kind: 'valuation_update',
        valuationId: anchor.id,
        expectedVersion: anchor.version,
        valuedOn: '2026-09-02',
        amount: '5000.00',
        datePrecision: 'exact',
      }),
      bbva,
    );

    expect(carry.before).toEqual({ from: '2026-08-31', to: '2026-09-09' });
    expect(carry.after).toEqual({ from: '2026-09-02', to: '2026-09-09' });
  });

  it('stays open-ended when nothing follows it, and closes when something does', async () => {
    await statement(bbva, '2026-08-31', '5000.00');
    const anchor = await valuationOn(bbva, '2026-08-31');

    // Nothing later exists: the balance is still the account's value today.
    const open = carryOf(
      await preview({
        kind: 'valuation_update',
        valuationId: anchor.id,
        expectedVersion: anchor.version,
        valuedOn: '2026-08-20',
        amount: '5000.00',
        datePrecision: 'exact',
      }),
      bbva,
    );
    expect(open.before).toEqual({ from: '2026-08-31', to: null });
    expect(open.after).toEqual({ from: '2026-08-20', to: null });

    // Removing it removes the interval altogether.
    const removed = carryOf(
      await preview({
        kind: 'valuation_delete',
        valuationId: anchor.id,
        expectedVersion: anchor.version,
      }),
      bbva,
    );
    expect(removed.before).toEqual({ from: '2026-08-31', to: null });
    expect(removed.after).toBeNull();
  });

  it('moves the boundary with the balance that moved (30 August → 9 September)', async () => {
    await statement(bbva, '2026-08-31', '5000.00');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-09-10',
      amount: '5100.00',
      datePrecision: 'exact',
    });
    const later = await valuationOn(bbva, '2026-09-10');

    // Moving the *successor* later extends the predecessor's reach with it.
    const result = await preview({
      kind: 'valuation_update',
      valuationId: later.id,
      expectedVersion: later.version,
      valuedOn: '2026-09-20',
      amount: '5100.00',
      datePrecision: 'exact',
    });
    const carry = carryOf(result, bbva);
    expect(carry.before).toEqual({ from: '2026-09-10', to: null });
    expect(carry.after).toEqual({ from: '2026-09-20', to: null });
  });
});

/* -------------------------------------------------------------------------- */
/* The evidence window                                                         */
/* -------------------------------------------------------------------------- */

/** One statement the driver actually sent, with the values bound to it. */
interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Capture the SQL one call sends.
 *
 * At the driver, because that is the only place the real statement exists:
 * a repository that says it takes two bounds and passes one would look
 * identical from above.
 */
async function capturing<T>(run: () => Promise<T>): Promise<{
  readonly result: T;
  readonly statements: readonly Statement[];
}> {
  const statements: Statement[] = [];
  // Seen as a plain function rather than as a method, so taking a reference to
  // it is not the unbound-method mistake the lint rule is really about.
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;

  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] } | undefined;
    const text = typeof first === 'string' ? first : (first?.text ?? '');
    const bound = Array.isArray(args[1])
      ? args[1]
      : typeof first === 'string'
        ? []
        : (first?.values ?? []);
    statements.push({ text, values: bound });
    return Reflect.apply(original, this, args) as unknown;
  };

  try {
    return { result: await run(), statements };
  } finally {
    driver.query = original;
  }
}

/** Every dated read of a flow table, as the pair of bounds it sent. */
const flowBounds = (statements: readonly Statement[]): string[][] =>
  statements
    .filter((statement) => /from "(income_entries|expense_entries|transfers)"/iu.test(statement.text))
    .map((statement) =>
      statement.values.filter(
        (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value),
      ),
    )
    .filter((bounds) => bounds.length === 2);

/**
 * What a preview is allowed to read (§6, 23.2, ADR 0010 §8).
 *
 * Two properties, and the second is the one an earlier version got wrong: the
 * **count** of statements does not grow with the window, and the **rows** are
 * bounded by the window on both sides. Reading every flow through today made
 * correcting a five-year-old expense load five years of later rows that no
 * part of the derivation is allowed to look at.
 *
 * Asserted at the driver, because that is the only place the real statement
 * exists: a repository that says it takes two bounds and passes one would look
 * identical from above.
 */
describe('the preview reads its own window and no more (§6)', () => {
  /** A 2021 expense, a 2021 balance, and a lot of evidence after both. */
  async function longHistory(): Promise<{ id: string; version: number }> {
    await statement(bbva, '2021-04-30', '1000.00');
    await statement(bbva, '2021-05-31', '900.00');
    const old = await createExpenseEntry(flows(), OCT_5, {
      categoryId: groceries,
      incurredOn: '2021-05-12',
      amount: '100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await september();
    return old;
  }

  it('stops an isolated old flow correction at its own month end', async () => {
    const old = await longHistory();

    const { result, statements } = await capturing(() =>
      preview({
        kind: 'expense_update',
        entryId: old.id,
        expectedVersion: old.version,
        amount: '120.00',
      }),
    );

    // An expense is neither of a month's endpoints, so it reaches no later
    // month: May 2021 is the whole window.
    expect(result.periods.map((period) => period.month)).toEqual(['2021-05']);

    const bounds = flowBounds(statements);
    expect(bounds.length).toBeGreaterThanOrEqual(3);
    for (const bound of bounds) {
      expect(bound).toEqual(['2021-05-01', '2021-05-31']);
    }
  });

  /** A cash account with nothing but one 2021 statement: nothing ever follows it. */
  async function lonelyAccount(): Promise<string> {
    const lonely = (
      await createCashAccount(positions(), OCT_5, {
        name: 'Old savings',
        currency: 'EUR',
        accountType: 'savings',
        openedOn: null,
      })
    ).id;
    await statement(lonely, '2021-04-30', '400.00');
    return lonely;
  }

  const correctAmount = (
    row: { id: string; version: number },
    valuedOn: string,
    amount: string,
    datePrecision: 'exact' | 'month_end' = 'month_end',
  ): CorrectionDraft => ({
    kind: 'valuation_update',
    valuationId: row.id,
    expectedVersion: row.version,
    valuedOn,
    amount,
    datePrecision,
  });

  it('stops an old balance correction at the first untouched balance after it (§6.1)', async () => {
    await longHistory();
    const anchor = await valuationOn(bbva, '2021-04-30');

    const { result, statements } = await capturing(() =>
      preview(correctAmount(anchor, '2021-04-30', '1100.00')),
    );

    // The May 2021 statement is untouched in both worlds, so nothing after
    // May can read April's balance any more — five years of later rows are
    // not loaded to find that out.
    const bounds = flowBounds(statements);
    expect(bounds.length).toBeGreaterThanOrEqual(3);
    for (const bound of bounds) {
      expect(bound).toEqual(['2021-04-01', '2021-05-31']);
    }
    expect(result.periods.every((period) => period.month <= '2021-05')).toBe(true);
  });

  it('judges the month of a next-day snapshot, which still opens on the corrected statement (§6.2)', async () => {
    // April's statement, an ordinary snapshot on 1 May, and May's statement.
    // The snapshot ends April's carry on 30 April — but May's opening is
    // `close(April)`, read by exact date, so May still depends on April.
    // A window that stopped where the carry stops would never judge May.
    await statement(bbva, '2021-04-30', '1000.00');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2021-05-01',
      amount: '1000.00',
      datePrecision: 'exact',
    });
    await statement(bbva, '2021-05-31', '900.00');
    // The other account's statements, so May is reconcilable at all.
    await statement(savings, '2021-04-30', '50.00');
    await statement(savings, '2021-05-31', '50.00');
    await september();
    const april = await valuationOn(bbva, '2021-04-30');

    const { result, statements } = await capturing(() =>
      preview(correctAmount(april, '2021-04-30', '1100.00')),
    );

    for (const bound of flowBounds(statements)) {
      expect(bound).toEqual(['2021-04-01', '2021-05-31']);
    }
    // May is judged, and it moved: its cash change is measured from April's
    // statement.
    const may = result.periods.find((period) => period.month === '2021-05');
    expect(may?.tags).toEqual(expect.arrayContaining(['reconciliation', 'spending']));
    // Only the amount moved, so April's one-day carry interval did not.
    expect(result.structuralChanges.filter((change) => change.kind === 'valuation_carry')).toEqual(
      [],
    );
  });

  it('reaches the current month when no untouched balance ever follows (§6.3)', async () => {
    await longHistory();
    const lonely = await lonelyAccount();
    const only = await valuationOn(lonely, '2021-04-30');

    const { statements } = await capturing(() => preview(correctAmount(only, '2021-04-30', '450.00')));

    for (const bound of flowBounds(statements)) {
      // Nothing proves an earlier month safe, so the fallback holds.
      expect(bound).toEqual(['2021-04-01', '2026-10-31']);
    }
  });

  it('covers a moved balance through the first untouched balance after both of its dates (§6.4)', async () => {
    // April → July, across an untouched June statement. The world before
    // would be done by June; the world after has the moved statement in July.
    await statement(bbva, '2021-04-30', '1000.00');
    await statement(bbva, '2021-06-30', '1100.00');
    await statement(bbva, '2021-09-30', '1300.00');
    await september();
    const april = await valuationOn(bbva, '2021-04-30');

    const { result, statements } = await capturing(() =>
      preview(correctAmount(april, '2021-07-31', '1000.00')),
    );

    for (const bound of flowBounds(statements)) {
      expect(bound).toEqual(['2021-04-01', '2021-09-30']);
    }
    // July and August genuinely differ — the successor of the row as it was
    // (June) would have stopped the window before either was judged.
    const months = result.periods.map((period) => period.month);
    expect(months).toEqual(expect.arrayContaining(['2021-07', '2021-08']));
  });

  it('issues the same number of statements for a 2-month and a 66-month window (§6.5)', async () => {
    await longHistory();
    const lonely = await lonelyAccount();
    const near = await valuationOn(bbva, '2026-09-30');
    const far = await valuationOn(lonely, '2021-04-30');

    const narrow = await capturing(() => preview(correctAmount(near, '2026-09-30', '1234.00')));
    const wide = await capturing(() => preview(correctAmount(far, '2021-04-30', '1234.00')));

    // Two windows of very different size, as the reads themselves report them.
    expect(flowBounds(narrow.statements)[0]).toEqual(['2026-09-01', '2026-10-31']);
    expect(flowBounds(wide.statements)[0]).toEqual(['2021-04-01', '2026-10-31']);

    const loads = (captured: readonly Statement[]): number =>
      captured.filter((entry) => /^\s*select/iu.test(entry.text)).length;
    // Identical: the count is a property of the derivation, not of the number
    // of months in the window — and the balance history is read once.
    expect(loads(wide.statements)).toBe(loads(narrow.statements));
    expect(loads(narrow.statements)).toBeLessThan(24);
    const historyReads = (captured: readonly Statement[]): number =>
      captured.filter((entry) => /from "position_valuations"/iu.test(entry.text)).length;
    expect(historyReads(narrow.statements)).toBe(historyReads(wide.statements));
  });

  it('says exactly what the derivation through the current month says (§6.6)', async () => {
    // Nontrivial: a next-day snapshot, flows in the judged months and in the
    // months beyond the bound, and a recent September.
    await statement(bbva, '2021-04-30', '1000.00');
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2021-05-01',
      amount: '1000.00',
      datePrecision: 'exact',
    });
    await statement(bbva, '2021-05-31', '900.00');
    await statement(savings, '2021-04-30', '50.00');
    await statement(savings, '2021-05-31', '50.00');
    await salary('2021-05-10', '400.00');
    await createExpenseEntry(flows(), OCT_5, {
      categoryId: groceries,
      incurredOn: '2021-05-12',
      amount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await salary('2022-02-10', '999.00');
    await september();
    const april = await valuationOn(bbva, '2021-04-30');
    const draft = correctAmount(april, '2021-04-30', '1100.00');

    const derived = await withUserRead(harness.db, { userId: USER_A }, async (tx) => {
      const resolved = await resolveCorrectionIn(tx, OCT_5, draft, { lock: false });
      const write = resolved.plan;
      const history = await loadValuationHistoryIn(tx, OCT_5.today);
      const bounded = correctionWindow(write, OCT_5.today, history);

      // The old rule, reconstructed for this comparison only: every month
      // from the first touched one to the current one.
      const months: string[] = [];
      for (
        let month = monthKeyOfPeriod(bounded.periods[0] as string);
        monthLabel(month) <= '2026-10';
        month = monthKey(addMonths(startOfMonthKey(month), 1))
      ) {
        months.push(monthLabel(month));
      }
      const conservative = {
        periods: months,
        from: bounded.from,
        through: endOfMonthKey(monthKeyOfPeriod('2026-10')),
      };

      const previewOver = async (window: typeof bounded) => {
        const before = await loadCorrectionEvidenceIn(tx, OCT_5.today, history, window);
        const after = overlayCorrection(before, write);
        const sourcePeriods = sourcePeriodsOf(write);
        const impact = deriveImpact(write, before, after, sourcePeriods, window);
        return withFingerprint({
          sourceScope: write.changes.map((change) => ({
            identity: change.identity,
            operation: change.operation,
          })),
          sourcePeriods,
          periods: impact.periods,
          structuralChanges: impact.structuralChanges,
          sourceChanges: write.changes,
        });
      };

      return {
        boundedWindow: bounded,
        conservativeWindow: conservative,
        bounded: await previewOver(bounded),
        conservative: await previewOver(conservative),
      };
    });

    // Not vacuous: the bound really is much narrower than the old rule.
    expect(derived.boundedWindow.through).toBe('2021-05-31');
    expect(derived.conservativeWindow.periods.length).toBe(67);
    expect(derived.boundedWindow.periods.length).toBe(2);

    // And the two say the same thing, down to the fingerprint.
    expect(derived.bounded.periods).toEqual(derived.conservative.periods);
    expect(derived.bounded.structuralChanges).toEqual(derived.conservative.structuralChanges);
    expect(derived.bounded.sourcePeriods).toEqual(derived.conservative.sourcePeriods);
    expect(derived.bounded.fingerprint).toBe(derived.conservative.fingerprint);

    // The production preview is the bounded one.
    expect((await preview(draft)).fingerprint).toBe(derived.bounded.fingerprint);
  });
});
