import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { monthKeyOf } from '@vaultide/finance';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { listCategories } from '../../src/users/categories';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { createTemplate } from '../../src/recurring/templates';
import { skipSuggestion, unskipSuggestion } from '../../src/recurring/suggestions';
import { getMonthReconciliation } from '../../src/reconciliation/service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';

/**
 * Restoring a skipped occurrence (ADR 0013 §1; cold review P3-27).
 *
 * A skip is a source fact (30.10), and its financial period is the month of
 * the occurrence it excuses. So restoring one from a finished month is a
 * Historical Correction: the ordinary service refuses it having written
 * nothing, and Preview → Confirm commits it, with its before-image and the
 * reason on the audit row. In this month, or a later one, it stays one click.
 *
 * No figure moves when a skip goes — a skip is in none — but the month's
 * completeness does, and for an income source so does 8.5's
 * `suggested_income_missing`. The preview is checked against what the
 * completeness and reconciliation services themselves say before and after
 * the commit, so it is proved to describe the month the user will then see.
 *
 * "Today" is 5 October 2026: September is finished, October is current.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let groceries: string;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER_A, reportingCurrency: 'EUR' });

const OCT_5 = on('2026-10-05');
const SEPTEMBER = monthKeyOf(2026, 9);

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

/** A rental income source, paid on the 5th from September. */
async function rent(): Promise<string> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'income',
    name: 'Lodger',
    incomeKind: 'rental',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 5,
    startDate: '2026-09-01',
    cashPositionId: bbva,
    amount: '400.00',
  });
  return template.id;
}

/** A known expense, charged on the 5th from September. */
async function gym(): Promise<string> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'expense',
    name: 'Gym',
    categoryId: groceries,
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 5,
    startDate: '2026-09-01',
    cashPositionId: bbva,
    amount: '40.00',
  });
  return template.id;
}

const skip = (templateId: string, occurrenceDate: string, reason: 'skipped' | 'vacant' = 'skipped') =>
  skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate, reason });

const restoreDraft = (row: { id: string; version: number }): CorrectionDraft => ({
  kind: 'skip_delete',
  skipId: row.id,
  expectedVersion: row.version,
});

async function preview(draft: CorrectionDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections(), ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error(`expected review to be required, got ${prepared.status}`);
  }
  return prepared.preview;
}

async function skipCount(): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::text AS n FROM recurring_template_skips`);
    return Number((result.rows[0] as { n: string }).n);
  });
}

async function auditOf(entityId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action::text AS action, before, after, reason FROM audit_entries
           WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    );
    return result.rows as { action: string; before: unknown; after: unknown; reason: string | null }[];
  });
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
    'audit_entries',
    'position_valuations',
    'cash_accounts',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  bbva = (
    await createCashAccount(positions(), OCT_5, {
      name: 'BBVA',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    })
  ).id;
  for (const valuedOn of ['2026-08-31', '2026-09-30']) {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn,
      amount: '1000.00',
      datePrecision: 'month_end',
    });
  }
});

/* -------------------------------------------------------------------------- */

describe('restoring a finished month’s skip', () => {
  it('is refused directly with HISTORICAL_REVIEW_REQUIRED, deleting and auditing nothing', async () => {
    const templateId = await rent();
    // Creating it stays ordinary in any month: a first assertion (30.22 item 2).
    const skipped = await skip(templateId, '2026-09-05', 'vacant');
    const audited = await auditOf(skipped.id);
    expect(audited.map((row) => row.action)).toEqual(['insert']);

    await expect(
      unskipSuggestion(flows(), OCT_5, { skipId: skipped.id, expectedVersion: skipped.version }),
    ).rejects.toMatchObject({
      code: 'HISTORICAL_REVIEW_REQUIRED',
      reasons: ['completed_source_revision'],
      completedPeriods: ['2026-09'],
    });

    expect(await skipCount()).toBe(1);
    expect(await auditOf(skipped.id)).toEqual(audited);
  });

  it('commits through Preview → Confirm, auditing the delete with its before-image and the reason', async () => {
    const templateId = await rent();
    const skipped = await skip(templateId, '2026-09-05', 'vacant');
    const draft = restoreDraft(skipped);

    const reviewed = await preview(draft);
    const result = await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft,
      fingerprint: reviewed.fingerprint,
      reason: 'The lodger paid after all',
    });
    expect(result).toEqual({
      status: 'committed',
      summary: {
        sourceScope: [{ identity: { scope: 'existing', kind: 'skip', id: skipped.id }, operation: 'delete' }],
        sourcePeriods: ['2026-09'],
        affectedPeriods: ['2026-09'],
        dormancyChanged: false,
      },
    });

    expect(await skipCount()).toBe(0);
    const image = expect.objectContaining({
      id: skipped.id,
      templateId,
      occurrenceDate: '2026-09-05',
      reason: 'vacant',
      version: skipped.version,
    });
    expect(await auditOf(skipped.id)).toEqual([
      { action: 'insert', before: null, after: image, reason: null },
      { action: 'delete', before: image, after: null, reason: 'The lodger paid after all' },
    ]);
  });

  it('previews an income source’s completeness and the missing income it raises, and nothing else', async () => {
    const templateId = await rent();
    const skipped = await skip(templateId, '2026-09-05', 'vacant');

    const completenessBefore = await getMonthCompleteness(reads(), OCT_5, SEPTEMBER);
    const reconciliationBefore = await getMonthReconciliation(reads(), OCT_5, SEPTEMBER);
    const missingIncome = (buckets: typeof reconciliationBefore.buckets) =>
      buckets.flatMap((bucket) => bucket.issues).filter((issue) => issue.key === 'suggested_income_missing');
    expect(missingIncome(reconciliationBefore.buckets)).toEqual([]);

    const reviewed = await preview(restoreDraft(skipped));

    // The skip itself, as the before-image of a delete.
    expect(reviewed.sourceChanges).toEqual([
      {
        identity: { scope: 'existing', kind: 'skip', id: skipped.id },
        operation: 'delete',
        before: { kind: 'skip', templateId, occurrenceDate: '2026-09-05', reason: 'vacant', note: null },
        after: null,
      },
    ]);
    expect(reviewed.sourcePeriods).toEqual(['2026-09']);

    // September alone, and no figure in it: only the reconciliation card's
    // completeness and issues move.
    expect(reviewed.periods.map((period) => [period.kind, period.month, period.tags])).toEqual([
      ['completed', '2026-09', ['reconciliation']],
    ]);
    expect(reviewed.structuralChanges).toEqual([
      {
        kind: 'completeness',
        month: '2026-09',
        before: {
          state: completenessBefore.state,
          satisfied: completenessBefore.satisfied,
          required: completenessBefore.required,
        },
        after: expect.objectContaining({
          satisfied: completenessBefore.satisfied - 1,
          required: completenessBefore.required,
        }) as unknown,
      },
      {
        kind: 'issue',
        change: 'appeared',
        month: '2026-09',
        issue: {
          key: 'suggested_income_missing',
          currency: 'EUR',
          positionId: null,
          templateId,
          occurrenceDate: '2026-09-05',
          source: null,
        },
      },
    ]);

    // And that is what September says once it is committed.
    await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: restoreDraft(skipped),
      fingerprint: reviewed.fingerprint,
    });
    const completenessAfter = await getMonthCompleteness(reads(), OCT_5, SEPTEMBER);
    expect(reviewed.structuralChanges[0]).toMatchObject({
      after: {
        state: completenessAfter.state,
        satisfied: completenessAfter.satisfied,
        required: completenessAfter.required,
      },
    });
    const raised = missingIncome((await getMonthReconciliation(reads(), OCT_5, SEPTEMBER)).buckets);
    expect(raised.map((issue) => [issue.templateId, issue.occurrenceDate])).toEqual([
      [templateId, '2026-09-05'],
    ]);
  });

  it('previews a known expense’s completeness only, because missing income is about income', async () => {
    const templateId = await gym();
    const skipped = await skip(templateId, '2026-09-05');
    const completenessBefore = await getMonthCompleteness(reads(), OCT_5, SEPTEMBER);

    const reviewed = await preview(restoreDraft(skipped));

    expect(reviewed.periods.map((period) => [period.kind, period.month, period.tags])).toEqual([
      ['completed', '2026-09', ['reconciliation']],
    ]);
    // 12.6 counts every kind; 8.5's issue reads income alone
    // (`missingIncomeOccurrences`), so nothing is raised here.
    expect(reviewed.structuralChanges).toEqual([
      {
        kind: 'completeness',
        month: '2026-09',
        before: {
          state: completenessBefore.state,
          satisfied: completenessBefore.satisfied,
          required: completenessBefore.required,
        },
        after: expect.objectContaining({
          satisfied: completenessBefore.satisfied - 1,
          required: completenessBefore.required,
        }) as unknown,
      },
    ]);

    await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: restoreDraft(skipped),
      fingerprint: reviewed.fingerprint,
    });
    const completenessAfter = await getMonthCompleteness(reads(), OCT_5, SEPTEMBER);
    expect(reviewed.structuralChanges[0]).toMatchObject({
      after: {
        state: completenessAfter.state,
        satisfied: completenessAfter.satisfied,
        required: completenessAfter.required,
      },
    });
  });
});

describe('restoring a skip in this month or a later one', () => {
  it('commits at once, and needs no review', async () => {
    const templateId = await rent();
    // Due today, and one still ahead.
    for (const occurrenceDate of ['2026-10-05', '2026-11-05']) {
      const skipped = await skip(templateId, occurrenceDate);
      const draft = restoreDraft(skipped);

      expect(await previewHistoricalCorrection(corrections(), OCT_5, { draft })).toEqual({
        status: 'not_required',
      });
      const removed = await unskipSuggestion(flows(), OCT_5, {
        skipId: skipped.id,
        expectedVersion: skipped.version,
      });
      expect(removed.id).toBe(skipped.id);
      expect((await auditOf(skipped.id)).map((row) => row.action)).toEqual(['insert', 'delete']);
    }
    expect(await skipCount()).toBe(0);
  });
});

describe('a stale version', () => {
  it('is CONFLICT_VERSION, deleting and auditing nothing, in any month and through the review', async () => {
    const templateId = await rent();
    const finished = await skip(templateId, '2026-09-05');
    const current = await skip(templateId, '2026-10-05');
    const stale = (row: { id: string; version: number }) => ({ skipId: row.id, expectedVersion: row.version + 1 });

    // The version is judged as the skip is resolved, before anything asks
    // whether the month has closed, so a stale view is the answer either way.
    for (const row of [current, finished]) {
      await expect(unskipSuggestion(flows(), OCT_5, stale(row))).rejects.toMatchObject({
        code: 'CONFLICT_VERSION',
      });
    }
    const draft: CorrectionDraft = { kind: 'skip_delete', ...stale(finished) };
    await expect(previewHistoricalCorrection(corrections(), OCT_5, { draft })).rejects.toMatchObject({
      code: 'CONFLICT_VERSION',
    });
    const fresh = await preview(restoreDraft(finished));
    await expect(
      confirmHistoricalCorrection(corrections(), OCT_5, { draft, fingerprint: fresh.fingerprint }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect(await skipCount()).toBe(2);
    for (const row of [current, finished]) {
      expect((await auditOf(row.id)).map((entry) => entry.action)).toEqual(['insert']);
    }
  });
});
