import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { monthKeyOf, type MonthKey } from '@vaultide/finance';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { listCategories } from '../../src/users/categories';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { createTemplate, updateTemplateDetails } from '../../src/recurring/templates';
import { acceptSuggestion } from '../../src/recurring/suggestions';
import { getMonthReconciliation } from '../../src/reconciliation/service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';

/**
 * Moving a recurring source's end date (ADR 0013 §2).
 *
 * An end date is historical schedule truth (30.10): it decides which
 * occurrences a finished month expected. So a change that adds or removes an
 * expected occurrence in a finished month is a Historical Correction. The
 * ordinary service refuses it having written nothing, and Preview → Confirm
 * commits it, with both images and the reason on the audit row. A change that
 * reaches only this month or later ones stays an ordinary save, and so does a
 * change to the name or the payer, whatever it is sent with.
 *
 * Which months a change reaches is read from the occurrences the two schedules
 * generate, never from the two dates. No figure moves; the month's completeness
 * does, and for an income source so does 8.5's `suggested_income_missing`. The
 * preview is checked against what the completeness and reconciliation services
 * say once it is committed, so it is proved to describe the months the user
 * will then see.
 *
 * "Today" is 5 October 2026: August and September are finished, October is
 * current.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let groceries: string;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER_A, reportingCurrency: 'EUR' });

const OCT_5 = on('2026-10-05');
const AUGUST = monthKeyOf(2026, 8);
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

interface Template {
  readonly id: string;
  readonly version: number;
}

/** A salary paid on the 25th, from `startDate`, ending where it is told to. */
async function salary(options: { startDate?: string; endDate?: string } = {}): Promise<Template> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'income',
    name: 'Salary',
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: options.startDate ?? '2026-07-01',
    ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
    cashPositionId: bbva,
    amount: '2000.00',
  });
  return template;
}

/** A known expense charged on the 15th from July. */
async function gym(): Promise<Template> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'expense',
    name: 'Gym',
    categoryId: groceries,
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 15,
    startDate: '2026-07-01',
    cashPositionId: bbva,
    amount: '40.00',
  });
  return template;
}

const endDraft = (template: Template, endDate: string | null): CorrectionDraft => ({
  kind: 'template_end_date',
  templateId: template.id,
  expectedVersion: template.version,
  endDate,
});

async function preview(draft: CorrectionDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections(), ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error(`expected review to be required, got ${prepared.status}`);
  }
  return prepared.preview;
}

async function stored(templateId: string): Promise<{ name: string; endDate: string | null; version: number }> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT name, end_date::text AS "endDate", version FROM recurring_templates WHERE id = ${templateId}`,
    );
    return result.rows[0] as { name: string; endDate: string | null; version: number };
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

const completenessOf = async (month: MonthKey) => {
  const completeness = await getMonthCompleteness(reads(), OCT_5, month);
  return { state: completeness.state, satisfied: completeness.satisfied, required: completeness.required };
};

const missingIncomeIn = async (month: MonthKey) =>
  (await getMonthReconciliation(reads(), OCT_5, month)).buckets
    .flatMap((bucket) => bucket.issues)
    .filter((issue) => issue.key === 'suggested_income_missing')
    .map((issue) => [issue.templateId, issue.occurrenceDate]);

const missingIncomeIssue = (month: string, templateId: string, occurrenceDate: string, change: 'appeared' | 'cleared') => ({
  kind: 'issue',
  change,
  month,
  issue: {
    key: 'suggested_income_missing',
    currency: 'EUR',
    positionId: null,
    templateId,
    occurrenceDate,
    source: null,
  },
});

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
  for (const valuedOn of ['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']) {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn,
      amount: '1000.00',
      datePrecision: 'month_end',
    });
  }
});

/* -------------------------------------------------------------------------- */

describe('an end-date change that reaches a finished month', () => {
  it('is refused directly with HISTORICAL_REVIEW_REQUIRED, saving and auditing nothing', async () => {
    // Shortening: September's occurrence on the 25th stops being expected.
    const shortened = await salary();
    // Clearing: August's and September's come back.
    const ended = await salary({ startDate: '2026-06-01', endDate: '2026-07-30' });

    for (const [template, endDate, completedPeriods] of [
      [shortened, '2026-08-31', ['2026-09']],
      [ended, null, ['2026-08', '2026-09']],
    ] as const) {
      const audited = await auditOf(template.id);
      await expect(
        updateTemplateDetails(flows(), OCT_5, {
          templateId: template.id,
          expectedVersion: template.version,
          endDate,
        }),
      ).rejects.toMatchObject({
        code: 'HISTORICAL_REVIEW_REQUIRED',
        reasons: ['completed_source_revision'],
        completedPeriods,
      });
      expect(await stored(template.id)).toMatchObject({ version: template.version });
      expect(await auditOf(template.id)).toEqual(audited);
    }
    expect((await stored(shortened.id)).endDate).toBeNull();
    expect((await stored(ended.id)).endDate).toBe('2026-07-30');
  });

  it('commits through Preview → Confirm, audited with both images and the reason', async () => {
    const template = await salary();
    const draft = endDraft(template, '2026-08-31');

    const reviewed = await preview(draft);
    const result = await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft,
      fingerprint: reviewed.fingerprint,
      reason: 'The job ended in August',
    });
    expect(result).toEqual({
      status: 'committed',
      summary: {
        sourceScope: [
          { identity: { scope: 'existing', kind: 'template_schedule', id: template.id }, operation: 'update' },
        ],
        sourcePeriods: ['2026-09'],
        affectedPeriods: ['2026-09'],
        dormancyChanged: false,
      },
    });

    expect(await stored(template.id)).toEqual({ name: 'Salary', endDate: '2026-08-31', version: template.version + 1 });
    expect(await auditOf(template.id)).toEqual([
      expect.objectContaining({ action: 'insert', before: null }),
      {
        action: 'update',
        before: expect.objectContaining({ id: template.id, endDate: null, version: template.version }),
        after: expect.objectContaining({ id: template.id, endDate: '2026-08-31', version: template.version + 1 }),
        reason: 'The job ended in August',
      },
    ]);
  });

  it('previews the schedule before and after, and an income source’s completeness and missing income', async () => {
    const template = await salary();
    const completenessBefore = await completenessOf(SEPTEMBER);
    expect(await missingIncomeIn(SEPTEMBER)).toEqual([[template.id, '2026-09-25']]);

    const reviewed = await preview(endDraft(template, '2026-08-31'));

    const schedule = (endDate: string | null) => ({
      kind: 'template_schedule',
      templateId: template.id,
      templateKind: 'income',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 25,
      startDate: '2026-07-01',
      endDate,
    });
    expect(reviewed.sourceChanges).toEqual([
      {
        identity: { scope: 'existing', kind: 'template_schedule', id: template.id },
        operation: 'update',
        before: schedule(null),
        after: schedule('2026-08-31'),
      },
    ]);
    // September alone: July and August keep their occurrences, and October,
    // which loses one too, has not finished.
    expect(reviewed.sourcePeriods).toEqual(['2026-09']);
    expect(reviewed.periods.map((period) => [period.kind, period.month, period.tags])).toEqual([
      ['completed', '2026-09', ['reconciliation']],
    ]);
    expect(reviewed.structuralChanges).toEqual([
      {
        kind: 'completeness',
        month: '2026-09',
        before: completenessBefore,
        after: expect.objectContaining({
          satisfied: completenessBefore.satisfied,
          required: completenessBefore.required - 1,
        }) as unknown,
      },
      missingIncomeIssue('2026-09', template.id, '2026-09-25', 'cleared'),
    ]);

    // And that is what September says once it is committed.
    await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: endDraft(template, '2026-08-31'),
      fingerprint: reviewed.fingerprint,
    });
    expect(reviewed.structuralChanges[0]).toMatchObject({ after: await completenessOf(SEPTEMBER) });
    expect(await missingIncomeIn(SEPTEMBER)).toEqual([]);
  });

  it('reaches months the evidence holds no template for, when a source that ended is extended', async () => {
    // It ended on 30 July, so a read of August and September does not find it:
    // the overlay has to add it there with its new schedule.
    const template = await salary({ startDate: '2026-06-01', endDate: '2026-07-30' });
    const before = { august: await completenessOf(AUGUST), september: await completenessOf(SEPTEMBER) };
    expect(await missingIncomeIn(AUGUST)).toEqual([]);
    expect(await missingIncomeIn(SEPTEMBER)).toEqual([]);

    const reviewed = await preview(endDraft(template, null));

    expect(reviewed.sourcePeriods).toEqual(['2026-08', '2026-09']);
    expect(reviewed.periods.map((period) => [period.kind, period.month, period.tags])).toEqual([
      ['completed', '2026-08', ['reconciliation']],
      ['completed', '2026-09', ['reconciliation']],
    ]);
    expect(reviewed.structuralChanges).toEqual([
      {
        kind: 'completeness',
        month: '2026-08',
        before: before.august,
        after: expect.objectContaining({
          satisfied: before.august.satisfied,
          required: before.august.required + 1,
        }) as unknown,
      },
      {
        kind: 'completeness',
        month: '2026-09',
        before: before.september,
        after: expect.objectContaining({
          satisfied: before.september.satisfied,
          required: before.september.required + 1,
        }) as unknown,
      },
      missingIncomeIssue('2026-08', template.id, '2026-08-25', 'appeared'),
      missingIncomeIssue('2026-09', template.id, '2026-09-25', 'appeared'),
    ]);

    await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: endDraft(template, null),
      fingerprint: reviewed.fingerprint,
    });
    expect(reviewed.structuralChanges[0]).toMatchObject({ after: await completenessOf(AUGUST) });
    expect(reviewed.structuralChanges[1]).toMatchObject({ after: await completenessOf(SEPTEMBER) });
    expect(await missingIncomeIn(AUGUST)).toEqual([[template.id, '2026-08-25']]);
    expect(await missingIncomeIn(SEPTEMBER)).toEqual([[template.id, '2026-09-25']]);
  });

  it('previews a known expense’s completeness only, because missing income is about income', async () => {
    const template = await gym();
    const completenessBefore = await completenessOf(SEPTEMBER);

    const reviewed = await preview(endDraft(template, '2026-09-10'));

    expect(reviewed.periods.map((period) => [period.kind, period.month, period.tags])).toEqual([
      ['completed', '2026-09', ['reconciliation']],
    ]);
    expect(reviewed.structuralChanges).toEqual([
      {
        kind: 'completeness',
        month: '2026-09',
        before: completenessBefore,
        after: expect.objectContaining({
          satisfied: completenessBefore.satisfied,
          required: completenessBefore.required - 1,
        }) as unknown,
      },
    ]);

    await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: endDraft(template, '2026-09-10'),
      fingerprint: reviewed.fingerprint,
    });
    expect(reviewed.structuralChanges[0]).toMatchObject({ after: await completenessOf(SEPTEMBER) });
  });
});

describe('an end-date change that reaches no finished month', () => {
  it('commits at once when it reaches only this month or later ones', async () => {
    const template = await salary();
    // October's occurrence on the 25th, and every one after it.
    const draft = endDraft(template, '2026-10-20');

    expect(await previewHistoricalCorrection(corrections(), OCT_5, { draft })).toEqual({
      status: 'not_required',
    });
    const saved = await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: template.version,
      endDate: '2026-10-20',
    });
    expect(saved.endDate).toBe('2026-10-20');
  });

  it('commits at once when it moves the end without removing an occurrence', async () => {
    // Both ends fall before August's occurrence on the 25th.
    const template = await salary({ endDate: '2026-08-20' });
    expect(
      await previewHistoricalCorrection(corrections(), OCT_5, { draft: endDraft(template, '2026-08-22') }),
    ).toEqual({ status: 'not_required' });
    const saved = await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: template.version,
      endDate: '2026-08-22',
    });
    expect(saved.endDate).toBe('2026-08-22');
  });
});

describe('a change to the name or the payer', () => {
  it('commits at once, alone or sent with an end date that reaches nothing', async () => {
    const template = await salary({ endDate: '2026-08-20' });

    const renamed = await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: template.version,
      name: 'Salary (Acme)',
    });
    const paid = await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: renamed.version,
      counterparty: 'Acme',
    });
    const both = await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: paid.version,
      name: 'Acme',
      counterparty: null,
      endDate: '2026-08-22',
    });

    expect(both).toMatchObject({ name: 'Acme', counterparty: null, endDate: '2026-08-22' });
    expect((await auditOf(template.id)).map((row) => row.action)).toEqual(['insert', 'update', 'update', 'update']);
  });
});

describe('the refusals that answer before any review', () => {
  it('still refuses an end before an occurrence already recorded, directly and through Preview', async () => {
    const template = await salary();
    await acceptSuggestion(flows(), OCT_5, { templateId: template.id, occurrenceDate: '2026-09-25' });
    const draft = endDraft(template, '2026-08-31');

    await expect(
      updateTemplateDetails(flows(), OCT_5, {
        templateId: template.id,
        expectedVersion: template.version,
        endDate: '2026-08-31',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/already recorded or skipped/u) as unknown });
    await expect(previewHistoricalCorrection(corrections(), OCT_5, { draft })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/already recorded or skipped/u) as unknown,
    });
    expect((await stored(template.id)).endDate).toBeNull();
  });

  it('still refuses an end before the start, directly and through Preview', async () => {
    const template = await salary();
    await expect(
      updateTemplateDetails(flows(), OCT_5, {
        templateId: template.id,
        expectedVersion: template.version,
        endDate: '2026-06-30',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'The end date cannot be before the start date.' });
    await expect(
      previewHistoricalCorrection(corrections(), OCT_5, { draft: endDraft(template, '2026-06-30') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'The end date cannot be before the start date.' });
  });

  it('refuses a stale version as CONFLICT_VERSION directly, through Preview and through Confirm', async () => {
    const template = await salary();
    const stale = { ...template, version: template.version + 1 };

    // Judged as the template is resolved, before anything asks whether a
    // finished month changes: the same answer for a change that reaches one
    // and for a change that does not.
    for (const endDate of ['2026-08-31', '2026-12-31']) {
      await expect(
        updateTemplateDetails(flows(), OCT_5, {
          templateId: template.id,
          expectedVersion: stale.version,
          endDate,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT_VERSION', message: 'This source changed while you were editing it.' });
    }
    await expect(
      previewHistoricalCorrection(corrections(), OCT_5, { draft: endDraft(stale, '2026-08-31') }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    // Reviewed at its version, then renamed elsewhere before Confirm.
    const draft = endDraft(template, '2026-08-31');
    const reviewed = await preview(draft);
    await updateTemplateDetails(flows(), OCT_5, {
      templateId: template.id,
      expectedVersion: template.version,
      name: 'Salary (Acme)',
    });
    await expect(
      confirmHistoricalCorrection(corrections(), OCT_5, { draft, fingerprint: reviewed.fingerprint }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect(await stored(template.id)).toEqual({
      name: 'Salary (Acme)',
      endDate: null,
      version: template.version + 1,
    });
    expect((await auditOf(template.id)).map((row) => row.action)).toEqual(['insert', 'update']);
  });
});
