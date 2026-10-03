import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withUserWrite, withoutUser } from '@vaultide/db';
import { monthKeyOf } from '@vaultide/finance';
import { saveOrCorrect } from '../helpers/corrections';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  closePosition,
  createCashAccount,
  createOtherAsset,
  updateCashAccount,
} from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import {
  archiveTemplate,
  createTemplate,
  listUserTemplates,
  setTemplateTerm,
} from '../../src/recurring/templates';
import { acceptSuggestion, listSuggestions, skipSuggestion } from '../../src/recurring/suggestions';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type BulkHistoryDraft,
  type BulkHistoryOperation,
  type CorrectionPreview,
} from '../../src/corrections/index';
import {
  applyBulkHistoryPlanIn,
  getBulkHistoryPage,
  resolveBulkHistoryIn,
  type BulkHistoryPageDto,
  type BulkIncomeCell,
  type BulkPositionCell,
} from '../../src/bulk-history/index';

/**
 * Bulk History against a real database (blueprint 15.3 "Bulk history", 18.1,
 * 20.3, 30.22 item 2; ADR 0011).
 *
 * The grid's save is a Historical Correction like any other — Preview, then
 * Confirm against the fingerprint the user saw — with three promises of its
 * own: it is reviewed whatever it carries, it is one transaction that writes
 * nothing unless every cell is valid, and every cell goes through the decision
 * its ordinary single-row path uses.
 *
 * "Today" is 5 October 2026: September and everything before it are completed
 * months, so every row this grid can edit is one.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;
let bbva: string;
let savings: string;
let car: string;
let salary: string;

let requests = 0;

/** A context with a request id of its own, so a save's audit rows can be told apart. */
const on = (today: string, userId = USER_A): RequestContext => {
  requests += 1;
  return testContext({ today, userId, reportingCurrency: 'EUR', requestId: `bulk-${String(requests)}` });
};

const OCT_5 = on('2026-10-05');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;
const corrections = () => harness.services.corrections;

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

const statement = (positionId: string, valuedOn: string, amount: string, note?: string) =>
  recordValuation(positions(), OCT_5, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
    ...(note === undefined ? {} : { note }),
  });

const snapshot = (positionId: string, valuedOn: string, amount: string) =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'exact' });

async function salaryTemplate(overrides: { dayOfMonth?: number; cash?: string | null } = {}) {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'income',
    name: 'Salary',
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: overrides.dayOfMonth ?? 25,
    startDate: '2026-01-01',
    ...(overrides.cash === null ? {} : { cashPositionId: overrides.cash ?? bbva }),
    amount: '2100.00',
    grossAmount: '3000.00',
  });
  return template;
}

/** Mark an account dormant the way the interface does: reviewed, its anchor being historical. */
async function markDormant(positionId: string): Promise<void> {
  const account = await withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT version FROM positions WHERE id = ${positionId}`);
    return result.rows[0] as { version: number };
  });
  await saveOrCorrect(
    corrections(),
    OCT_5,
    { kind: 'cash_account_update', positionId, expectedVersion: account.version, isDormant: true },
    () =>
      updateCashAccount(positions(), OCT_5, {
        positionId,
        expectedVersion: account.version,
        isDormant: true,
      }),
  );
}

async function valuationAt(positionId: string, valuedOn: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version, amount::text AS amount, source::text AS source,
                 date_precision::text AS precision, note
            FROM position_valuations
           WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows[0] as
      | { id: string; version: number; amount: string; source: string; precision: string; note: string | null }
      | undefined;
  });
}

async function incomeAt(templateId: string, occurrenceDate: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version, kind::text AS kind, received_on::text AS received_on,
                 net_amount::text AS net, gross_amount::text AS gross, currency,
                 settlement::text AS settlement, cash_position_id, description, tags,
                 is_one_off, template_id, occurrence_date::text AS occurrence_date
            FROM income_entries
           WHERE template_id = ${templateId} AND occurrence_date = ${occurrenceDate}`,
    );
    return result.rows[0] as
      | {
          id: string;
          version: number;
          kind: string;
          received_on: string;
          net: string;
          gross: string | null;
          currency: string;
          settlement: string;
          cash_position_id: string | null;
          description: string | null;
          tags: string[];
          is_one_off: boolean;
          template_id: string;
          occurrence_date: string;
        }
      | undefined;
  });
}

async function countRows(table: string): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`);
    return Number((result.rows[0] as { n: string }).n);
  });
}

async function auditFor(requestId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT entity_table, entity_id, action::text AS action, before, after, reason
            FROM audit_entries WHERE request_id = ${requestId}
           ORDER BY entity_table, entity_id`,
    );
    return result.rows as {
      entity_table: string;
      entity_id: string;
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      reason: string | null;
    }[];
  });
}

async function dormancyOf(positionId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT is_dormant, dormant_from::text AS "from" FROM cash_accounts WHERE position_id = ${positionId}`,
    );
    return result.rows[0] as { is_dormant: boolean; from: string | null };
  });
}

/** Everything a refused or unconfirmed save must leave exactly as it found it. */
async function worldState() {
  return {
    valuations: await countRows('position_valuations'),
    income: await countRows('income_entries'),
    audit: await countRows('audit_entries'),
    skips: await countRows('recurring_template_skips'),
    rows: await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id, version, amount::text AS amount FROM position_valuations ORDER BY id`,
      );
      return result.rows;
    }),
    dormancy: await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT position_id, is_dormant, dormant_from::text AS "from" FROM cash_accounts ORDER BY position_id`,
      );
      return result.rows;
    }),
  };
}

const draftOf = (operations: BulkHistoryOperation[], startMonth = '2026-01'): BulkHistoryDraft => ({
  kind: 'bulk_history',
  startMonth,
  operations,
});

async function preview(draft: BulkHistoryDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections(), ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error(`expected review to be required, got ${prepared.status}`);
  }
  return prepared.preview;
}

const confirm = (draft: BulkHistoryDraft, fingerprint: string, ctx = OCT_5, reason?: string) =>
  confirmHistoricalCorrection(corrections(), ctx, {
    draft,
    fingerprint,
    ...(reason === undefined ? {} : { reason }),
  });

/** Preview, then confirm against the preview's own fingerprint; asserts the commit. */
async function save(draft: BulkHistoryDraft, ctx = OCT_5): Promise<CorrectionPreview> {
  const shown = await preview(draft, ctx);
  const result = await confirm(draft, shown.fingerprint, ctx);
  expect(result.status).toBe('committed');
  return shown;
}

const page = (start: string, ctx = OCT_5): Promise<BulkHistoryPageDto> => {
  const [year, month] = start.split('-');
  return getBulkHistoryPage({ db: harness.db }, ctx, monthKeyOf(Number(year), Number(month)));
};

/** The cell a column states for one month. */
function cellOf(grid: BulkHistoryPageDto, owner: string, month: string): BulkPositionCell | BulkIncomeCell {
  const column = grid.columns.find((item) =>
    item.kind === 'position' ? item.positionId === owner : item.templateId === owner,
  );
  if (column === undefined) throw new Error(`no column for ${owner}`);
  const segment = column.segments.find((item) => item.from <= month && item.through >= month);
  if (segment === undefined) throw new Error(`no cell for ${owner} in ${month}`);
  return segment.cell;
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
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
    'other_assets',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }
  await harness.asOwner('DELETE FROM fx_rates');

  bbva = (
    await createCashAccount(positions(), OCT_5, {
      name: 'BBVA',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    })
  ).id;
  savings = (
    await createCashAccount(positions(), OCT_5, {
      name: 'Savings',
      currency: 'EUR',
      accountType: 'savings',
      openedOn: null,
    })
  ).id;
  car = (
    await createOtherAsset(positions(), OCT_5, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    })
  ).id;
  salary = (await salaryTemplate()).id;
});

/* -------------------------------------------------------------------------- */
/* The read model                                                              */
/* -------------------------------------------------------------------------- */

describe('the grid states every cell (ADR 0011 D3, D5)', () => {
  it('orders cash accounts, then other assets, then income sources, by order, name and id', async () => {
    const grid = await page('2026-01');
    expect(
      grid.columns.map((column) => (column.kind === 'position' ? column.name : `income:${column.name}`)),
    ).toEqual(['BBVA', 'Savings', 'Car', 'income:Salary']);
    expect(grid.startMonth).toBe('2026-01');
    expect(grid.lastCompletedMonth).toBe('2026-09');
    expect(grid.currentMonth).toBe('2026-10');
  });

  it('says stored, carried, snapshot and empty, and never infers one from a number', async () => {
    await statement(bbva, '2026-03-31', '1000');
    await snapshot(bbva, '2026-05-31', '1100');

    const grid = await page('2026-01');
    expect(cellOf(grid, bbva, '2026-02')).toEqual({ kind: 'empty' });
    expect(cellOf(grid, bbva, '2026-03')).toMatchObject({ kind: 'stored', amount: '1000', source: 'entered' });
    expect(cellOf(grid, bbva, '2026-04')).toEqual({ kind: 'carried', amount: '1000', since: '2026-03-31' });
    expect(cellOf(grid, bbva, '2026-05')).toMatchObject({ kind: 'snapshot', amount: '1100' });
    expect(cellOf(grid, bbva, '2026-06')).toEqual({ kind: 'carried', amount: '1100', since: '2026-05-31' });
  });

  it('says derived zero for a dormant episode and a closure, and unavailable outside the window', async () => {
    await statement(savings, '2026-03-31', '0');
    await markDormant(savings);

    const opened = await createCashAccount(positions(), OCT_5, {
      name: 'New',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: '2026-06-10',
    });
    await statement(opened.id, '2026-07-31', '0');
    await closePosition(positions(), OCT_5, {
      positionId: opened.id,
      expectedVersion: opened.version,
      closedOn: '2026-08-15',
    });

    const grid = await page('2026-01');
    expect(cellOf(grid, savings, '2026-04')).toEqual({ kind: 'derived_zero', reason: 'dormant', editable: true });
    expect(cellOf(grid, opened.id, '2026-05')).toEqual({ kind: 'unavailable', reason: 'not_open' });
    expect(cellOf(grid, opened.id, '2026-06')).toEqual({ kind: 'empty' });
    expect(cellOf(grid, opened.id, '2026-08')).toEqual({
      kind: 'derived_zero',
      reason: 'closed',
      editable: false,
    });
    expect(cellOf(grid, opened.id, '2026-09')).toEqual({ kind: 'unavailable', reason: 'closed' });
  });

  it('places income by occurrence, with skipped, archived and no-occurrence cells', async () => {
    const quarterly = await createTemplate(flows(), OCT_5, {
      kind: 'income',
      name: 'Bonus',
      incomeKind: 'bonus',
      currency: 'EUR',
      frequency: 'quarterly',
      dayOfMonth: 15,
      startDate: '2026-01-01',
      amount: '500',
    });
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-03-25' });
    await skipSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-04-25', reason: 'skipped' });
    await archiveTemplate(flows(), OCT_5, {
      templateId: quarterly.template.id,
      expectedVersion: quarterly.template.version,
    });

    const grid = await page('2026-01');
    expect(cellOf(grid, salary, '2026-03')).toMatchObject({
      kind: 'materialized',
      occurrenceDate: '2026-03-25',
      netAmount: '2100',
      receivedOn: '2026-03-25',
    });
    expect(cellOf(grid, salary, '2026-04')).toEqual({ kind: 'skipped', occurrenceDate: '2026-04-25' });
    expect(cellOf(grid, salary, '2026-05')).toEqual({ kind: 'open', occurrenceDate: '2026-05-25' });
    expect(cellOf(grid, quarterly.template.id, '2026-01')).toEqual({
      kind: 'archived',
      occurrenceDate: '2026-01-15',
    });
    expect(cellOf(grid, quarterly.template.id, '2026-02')).toEqual({ kind: 'none' });
  });

  it('refuses a first row that is the current month or later', async () => {
    await expect(page('2026-10')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(page('2026-11')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

/* -------------------------------------------------------------------------- */
/* Balances                                                                    */
/* -------------------------------------------------------------------------- */

describe('balance cells', () => {
  it('creates a typed carried value as a bulk-entered statement', async () => {
    await statement(bbva, '2026-05-31', '1000');
    await save(draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-06', amount: '1000' }]));

    expect(await valuationAt(bbva, '2026-06-30')).toMatchObject({
      amount: '1000.00000000',
      source: 'bulk_entered',
      precision: 'month_end',
      note: null,
    });
  });

  it('creates into an empty cell, and on another asset', async () => {
    await save(
      draftOf([
        { kind: 'valuation_create', positionId: savings, month: '2026-02', amount: '-5.5' },
        { kind: 'valuation_create', positionId: car, month: '2026-02', amount: '9000' },
      ]),
    );
    expect(await valuationAt(savings, '2026-02-28')).toMatchObject({ amount: '-5.50000000', source: 'bulk_entered' });
    expect(await valuationAt(car, '2026-02-28')).toMatchObject({ amount: '9000.00000000', source: 'bulk_entered' });
  });

  it('updates only the amount, keeping the date, precision, note and source', async () => {
    await statement(bbva, '2026-04-30', '500', 'from paper');
    const before = await valuationAt(bbva, '2026-04-30');
    await save(
      draftOf([
        {
          kind: 'valuation_update',
          positionId: bbva,
          month: '2026-04',
          valuationId: before?.id as string,
          expectedVersion: before?.version as number,
          amount: '600',
        },
      ]),
    );

    expect(await valuationAt(bbva, '2026-04-30')).toEqual({
      id: before?.id,
      version: (before?.version as number) + 1,
      amount: '600.00000000',
      source: 'entered',
      precision: 'month_end',
      note: 'from paper',
    });
  });

  it('clears a statement with its audit image, and the month carries again', async () => {
    await statement(bbva, '2026-03-31', '1000');
    await statement(bbva, '2026-04-30', '1200');
    const april = await valuationAt(bbva, '2026-04-30');
    const ctx = on('2026-10-05');

    const shown = await preview(
      draftOf([
        {
          kind: 'valuation_clear',
          positionId: bbva,
          month: '2026-04',
          valuationId: april?.id as string,
          expectedVersion: april?.version as number,
        },
      ]),
      ctx,
    );
    expect(shown.structuralChanges.some((change) => change.kind === 'valuation_carry')).toBe(true);
    expect(
      (
        await confirm(
          draftOf([
            {
              kind: 'valuation_clear',
              positionId: bbva,
              month: '2026-04',
              valuationId: april?.id as string,
              expectedVersion: april?.version as number,
            },
          ]),
          shown.fingerprint,
          ctx,
        )
      ).status,
    ).toBe('committed');

    expect(await valuationAt(bbva, '2026-04-30')).toBeUndefined();
    const audit = await auditFor(ctx.requestId);
    expect(audit).toEqual([
      expect.objectContaining({
        entity_table: 'position_valuations',
        entity_id: april?.id,
        action: 'delete',
        after: null,
      }),
    ]);
    expect(audit[0]?.before).toMatchObject({ amount: '1200.00000000' });
    expect(cellOf(await page('2026-01'), bbva, '2026-04')).toEqual({
      kind: 'carried',
      amount: '1000',
      since: '2026-03-31',
    });
  });

  it('wakes a dormant account once, however many of its cells the batch touches', async () => {
    await statement(savings, '2026-03-31', '0');
    await markDormant(savings);

    const ctx = on('2026-10-05');
    const shown = await save(
      draftOf([
        { kind: 'valuation_create', positionId: savings, month: '2026-05', amount: '10' },
        { kind: 'valuation_create', positionId: savings, month: '2026-06', amount: '20' },
      ]),
      ctx,
    );

    expect(shown.structuralChanges.filter((change) => change.kind === 'dormancy_episode')).toEqual([
      { kind: 'dormancy_episode', positionId: savings, before: '2026-03-31', after: null },
    ]);
    expect(await dormancyOf(savings)).toEqual({ is_dormant: false, from: null });
    const wakes = (await auditFor(ctx.requestId)).filter((row) => row.entity_table === 'cash_accounts');
    expect(wakes).toHaveLength(1);
  });

  it('ends the episode when the anchoring zero balance is cleared', async () => {
    await statement(savings, '2026-03-31', '0');
    await markDormant(savings);
    const anchor = await valuationAt(savings, '2026-03-31');

    await save(
      draftOf([
        {
          kind: 'valuation_clear',
          positionId: savings,
          month: '2026-03',
          valuationId: anchor?.id as string,
          expectedVersion: anchor?.version as number,
        },
      ]),
    );
    expect(await dormancyOf(savings)).toEqual({ is_dormant: false, from: null });
  });

  it('refuses a create or an update aimed at a last-day snapshot', async () => {
    await snapshot(bbva, '2026-07-31', '700');
    const row = await valuationAt(bbva, '2026-07-31');
    const before = await worldState();

    await expect(
      preview(draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-07', amount: '700' }])),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    await expect(
      preview(
        draftOf([
          {
            kind: 'valuation_update',
            positionId: bbva,
            month: '2026-07',
            valuationId: row?.id as string,
            expectedVersion: row?.version as number,
            amount: '710',
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    expect(await worldState()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Income                                                                      */
/* -------------------------------------------------------------------------- */

describe('income cells', () => {
  it('materializes an occurrence as an ordinary recurring entry', async () => {
    await save(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-02-25', netAmount: '2050' }]));

    expect(await incomeAt(salary, '2026-02-25')).toMatchObject({
      kind: 'employment',
      received_on: '2026-02-25',
      net: '2050.00000000',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cash_position_id: bbva,
      description: null,
      tags: [],
      is_one_off: false,
      template_id: salary,
      occurrence_date: '2026-02-25',
    });
  });

  it('inherits the term’s gross only for the term’s exact net', async () => {
    await save(
      draftOf([
        { kind: 'income_create', templateId: salary, occurrenceDate: '2026-02-25', netAmount: '2100' },
        { kind: 'income_create', templateId: salary, occurrenceDate: '2026-03-25', netAmount: '2100.01' },
      ]),
    );
    expect((await incomeAt(salary, '2026-02-25'))?.gross).toBe('3000.00000000');
    expect((await incomeAt(salary, '2026-03-25'))?.gross).toBeNull();
  });

  it('takes the term in force at the scheduled date', async () => {
    await setTemplateTerm(flows(), OCT_5, {
      templateId: salary,
      effectiveFrom: '2026-05-25',
      amount: '2200',
      grossAmount: '3100',
      expected: { state: 'absent' },
    });
    await save(
      draftOf([
        { kind: 'income_create', templateId: salary, occurrenceDate: '2026-04-25', netAmount: '2100' },
        { kind: 'income_create', templateId: salary, occurrenceDate: '2026-05-25', netAmount: '2200' },
      ]),
    );
    expect((await incomeAt(salary, '2026-04-25'))?.gross).toBe('3000.00000000');
    expect((await incomeAt(salary, '2026-05-25'))?.gross).toBe('3100.00000000');
  });

  it('leaves a source with no account as a tracked leg awaiting attribution', async () => {
    const unattributed = await salaryTemplate({ cash: null });
    await save(
      draftOf([{ kind: 'income_create', templateId: unattributed.id, occurrenceDate: '2026-06-25', netAmount: '100' }]),
    );
    expect(await incomeAt(unattributed.id, '2026-06-25')).toMatchObject({
      settlement: 'tracked_cash',
      cash_position_id: null,
    });
  });

  it('updates only the net, keeping everything else the entry holds', async () => {
    await acceptSuggestion(flows(), OCT_5, {
      templateId: salary,
      occurrenceDate: '2026-08-25',
      financialDate: '2026-08-27',
      grossAmount: '2999',
      description: 'August pay',
    });
    const before = await incomeAt(salary, '2026-08-25');

    await save(
      draftOf([
        {
          kind: 'income_update',
          templateId: salary,
          occurrenceDate: '2026-08-25',
          entryId: before?.id as string,
          expectedVersion: before?.version as number,
          netAmount: '2111',
        },
      ]),
    );
    expect(await incomeAt(salary, '2026-08-25')).toEqual({
      ...before,
      version: (before?.version as number) + 1,
      net: '2111.00000000',
    });
  });

  it('clears an occurrence without writing a skip, so it is due again', async () => {
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-07-25' });
    const entry = await incomeAt(salary, '2026-07-25');
    const ctx = on('2026-10-05');

    await save(
      draftOf([
        {
          kind: 'income_clear',
          templateId: salary,
          occurrenceDate: '2026-07-25',
          entryId: entry?.id as string,
          expectedVersion: entry?.version as number,
        },
      ]),
      ctx,
    );

    expect(await incomeAt(salary, '2026-07-25')).toBeUndefined();
    expect(await countRows('recurring_template_skips')).toBe(0);
    const audit = await auditFor(ctx.requestId);
    expect(audit).toEqual([
      expect.objectContaining({ entity_table: 'income_entries', entity_id: entry?.id, action: 'delete' }),
    ]);
    const due = await listSuggestions(flows(), OCT_5, {
      from: '2026-07-01',
      to: '2026-07-31',
      templates: await listUserTemplates(flows(), OCT_5),
    });
    expect(due.find((item) => item.occurrenceDate === '2026-07-25')?.state).toBe('due');
  });

  it('refuses a skipped occurrence, a date with no occurrence and an archived source', async () => {
    await skipSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-04-25', reason: 'skipped' });
    await expect(
      preview(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-04-25', netAmount: '1' }])),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });

    await expect(
      preview(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-04-24', netAmount: '1' }])),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const template = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(sql`SELECT version FROM recurring_templates WHERE id = ${salary}`);
      return result.rows[0] as { version: number };
    });
    await archiveTemplate(flows(), OCT_5, { templateId: salary, expectedVersion: template.version });
    await expect(
      preview(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-05-25', netAmount: '1' }])),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('still edits and clears an archived source’s recorded occurrences', async () => {
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-05-25' });
    const template = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(sql`SELECT version FROM recurring_templates WHERE id = ${salary}`);
      return result.rows[0] as { version: number };
    });
    await archiveTemplate(flows(), OCT_5, { templateId: salary, expectedVersion: template.version });
    const entry = await incomeAt(salary, '2026-05-25');

    await save(
      draftOf([
        {
          kind: 'income_update',
          templateId: salary,
          occurrenceDate: '2026-05-25',
          entryId: entry?.id as string,
          expectedVersion: entry?.version as number,
          netAmount: '2000',
        },
      ]),
    );
    expect((await incomeAt(salary, '2026-05-25'))?.net).toBe('2000.00000000');
  });

  it('edits a cross-month received date under its occurrence’s row', async () => {
    const first = await salaryTemplate({ dayOfMonth: 1 });
    await acceptSuggestion(flows(), OCT_5, {
      templateId: first.id,
      occurrenceDate: '2026-08-01',
      financialDate: '2026-07-31',
    });

    const grid = await page('2026-01');
    expect(cellOf(grid, first.id, '2026-08')).toMatchObject({ kind: 'materialized', receivedOn: '2026-07-31' });
    expect(cellOf(grid, first.id, '2026-07')).toEqual({ kind: 'open', occurrenceDate: '2026-07-01' });

    const entry = await incomeAt(first.id, '2026-08-01');
    await save(
      draftOf([
        {
          kind: 'income_update',
          templateId: first.id,
          occurrenceDate: '2026-08-01',
          entryId: entry?.id as string,
          expectedVersion: entry?.version as number,
          netAmount: '2001',
        },
      ]),
    );
    expect(await incomeAt(first.id, '2026-08-01')).toMatchObject({ received_on: '2026-07-31', net: '2001.00000000' });
  });

  it('keys "already recorded" per occurrence: another occurrence’s row never answers for this one', async () => {
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-07-25' });
    await save(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-08-25', netAmount: '2100' }]));
    expect(await incomeAt(salary, '2026-08-25')).toBeDefined();

    await expect(
      preview(draftOf([{ kind: 'income_create', templateId: salary, occurrenceDate: '2026-07-25', netAmount: '1' }])),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });
});

/* -------------------------------------------------------------------------- */
/* The batch                                                                   */
/* -------------------------------------------------------------------------- */

describe('one save is one reviewed, atomic act', () => {
  it('asks for review even when every cell is a first assertion', async () => {
    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, {
      draft: draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-02', amount: '1' }]),
    });
    expect(prepared.status).toBe('review_required');
  });

  it('previews and confirms a mixed batch once, with one audit entry per row under one request id', async () => {
    await statement(bbva, '2026-03-31', '1000');
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-04-25' });
    const march = await valuationAt(bbva, '2026-03-31');
    const april = await incomeAt(salary, '2026-04-25');
    const ctx = on('2026-10-05');

    const draft = draftOf([
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-05-25', netAmount: '2100' },
      {
        kind: 'valuation_update',
        positionId: bbva,
        month: '2026-03',
        valuationId: march?.id as string,
        expectedVersion: march?.version as number,
        amount: '1001',
      },
      {
        kind: 'income_clear',
        templateId: salary,
        occurrenceDate: '2026-04-25',
        entryId: april?.id as string,
        expectedVersion: april?.version as number,
      },
      { kind: 'valuation_create', positionId: savings, month: '2026-03', amount: '50' },
    ]);
    const shown = await preview(draft, ctx);
    expect(shown.sourceScope.map((item) => item.operation).sort()).toEqual(['create', 'create', 'delete', 'update']);

    const result = await confirm(draft, shown.fingerprint, ctx, 'old statements');
    expect(result.status).toBe('committed');

    const audit = await auditFor(ctx.requestId);
    expect(audit.map((row) => `${row.entity_table}:${row.action}`).sort()).toEqual([
      'income_entries:delete',
      'income_entries:insert',
      'position_valuations:insert',
      'position_valuations:update',
    ]);
    expect(new Set(audit.map((row) => row.reason))).toEqual(new Set(['old statements']));
  });

  it('resolves the same batch to the same fingerprint whatever order the cells arrive in', async () => {
    const operations: BulkHistoryOperation[] = [
      { kind: 'valuation_create', positionId: bbva, month: '2026-02', amount: '1' },
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-02-25', netAmount: '2100' },
      { kind: 'valuation_create', positionId: savings, month: '2026-01', amount: '2' },
    ];
    const forward = await preview(draftOf(operations));
    const backward = await preview(draftOf([...operations].reverse()));
    expect(backward.fingerprint).toBe(forward.fingerprint);
  });

  it('writes nothing when the last cell in canonical order is refused', async () => {
    const before = await worldState();
    const draft = draftOf([
      { kind: 'valuation_create', positionId: bbva, month: '2026-01', amount: '1' },
      { kind: 'valuation_create', positionId: savings, month: '2026-01', amount: '2' },
      // Income sorts after every balance, and this date has no occurrence.
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-09-24', netAmount: '1' },
    ]);
    await expect(preview(draft)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(confirm(draft, `hc-v1:${'0'.repeat(64)}`)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await worldState()).toEqual(before);
  });

  it('answers a stale version with CONFLICT_VERSION and writes nothing', async () => {
    await statement(bbva, '2026-03-31', '1000');
    const march = await valuationAt(bbva, '2026-03-31');
    const draft = draftOf([
      { kind: 'valuation_create', positionId: savings, month: '2026-03', amount: '1' },
      {
        kind: 'valuation_update',
        positionId: bbva,
        month: '2026-03',
        valuationId: march?.id as string,
        expectedVersion: march?.version as number,
        amount: '1001',
      },
    ]);
    const shown = await preview(draft);

    // Another tab corrects the same statement first.
    await save(
      draftOf([
        {
          kind: 'valuation_update',
          positionId: bbva,
          month: '2026-03',
          valuationId: march?.id as string,
          expectedVersion: march?.version as number,
          amount: '999',
        },
      ]),
    );
    const before = await worldState();
    await expect(confirm(draft, shown.fingerprint)).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect(await worldState()).toEqual(before);
  });

  it('answers a cell filled elsewhere with CONFLICT_DUPLICATE and writes nothing', async () => {
    const draft = draftOf([
      { kind: 'valuation_create', positionId: bbva, month: '2026-03', amount: '1' },
      { kind: 'valuation_create', positionId: savings, month: '2026-03', amount: '2' },
    ]);
    const shown = await preview(draft);
    await statement(savings, '2026-03-31', '3');
    const before = await worldState();

    await expect(confirm(draft, shown.fingerprint)).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await worldState()).toEqual(before);
  });

  it('translates the unique race at the write into CONFLICT_DUPLICATE', async () => {
    const draft = draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-03', amount: '1' }]);
    const ctx = on('2026-10-05');
    await expect(
      withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        const plan = await resolveBulkHistoryIn(tx, ctx, draft, { lock: true });
        // A writer outside the mutex fills the cell between the decision and
        // the insert — the one interleaving only the constraint can catch.
        await tx.execute(
          sql`INSERT INTO position_valuations (user_id, position_id, valued_on, amount, source, date_precision)
              VALUES (${USER_A}, ${bbva}, '2026-03-31', 5, 'entered', 'month_end')`,
        );
        await applyBulkHistoryPlanIn(tx, ctx, plan);
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await valuationAt(bbva, '2026-03-31')).toBeUndefined();
  });

  it('answers an occurrence recorded or skipped elsewhere with its own conflict', async () => {
    const draft = draftOf([
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-05-25', netAmount: '2100' },
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-06-25', netAmount: '2100' },
    ]);
    const shown = await preview(draft);

    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-05-25' });
    let before = await worldState();
    await expect(confirm(draft, shown.fingerprint)).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await worldState()).toEqual(before);

    const later = draftOf([
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-06-25', netAmount: '2100' },
    ]);
    const again = await preview(later);
    await skipSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-06-25', reason: 'skipped' });
    before = await worldState();
    await expect(confirm(later, again.fingerprint)).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await worldState()).toEqual(before);
  });

  it('returns impact_changed for a still-valid batch whose impact moved, and writes nothing', async () => {
    await statement(bbva, '2026-02-28', '1000');
    await statement(savings, '2026-02-28', '500');
    const draft = draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-03', amount: '900' }]);
    const shown = await preview(draft);

    // Another tab closes March for the other account: the batch is still
    // perfectly valid, and March's reconciliation now reads differently.
    await statement(savings, '2026-03-31', '500');
    const before = await worldState();

    const result = await confirm(draft, shown.fingerprint);
    expect(result.status).toBe('impact_changed');
    expect(await worldState()).toEqual(before);
  });

  it('warms rate history once per currency, and only after a commit', async () => {
    const dollars = await createCashAccount(positions(), OCT_5, {
      name: 'Dollars',
      currency: 'USD',
      accountType: 'checking',
      openedOn: null,
    });
    const draft = draftOf([
      { kind: 'valuation_create', positionId: dollars.id, month: '2026-03', amount: '1' },
      { kind: 'valuation_create', positionId: dollars.id, month: '2026-02', amount: '1' },
    ]);
    const calls = harness.fxProvider.calls.length;
    const shown = await preview(draft);
    expect(harness.fxProvider.calls.length).toBe(calls);

    expect((await confirm(draft, shown.fingerprint)).status).toBe('committed');
    expect(harness.fxProvider.calls.length).toBeGreaterThan(calls);
  });

  it('refuses a batch past the per-save limit, even one that skipped the input schema', async () => {
    const operations: BulkHistoryOperation[] = Array.from({ length: 501 }, (_, index) => ({
      kind: 'valuation_create',
      positionId: bbva,
      month: `${String(1980 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`,
      amount: '1',
    }));
    await expect(preview(draftOf(operations, '1980-01'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a cell named twice rather than choosing one', async () => {
    await expect(
      preview(
        draftOf([
          { kind: 'valuation_create', positionId: bbva, month: '2026-03', amount: '1' },
          { kind: 'valuation_create', positionId: bbva, month: '2026-03', amount: '2' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses an id that names another cell', async () => {
    await statement(bbva, '2026-03-31', '1000');
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: '2026-03-25' });
    const march = await valuationAt(bbva, '2026-03-31');
    const entry = await incomeAt(salary, '2026-03-25');

    await expect(
      preview(
        draftOf([
          {
            kind: 'valuation_update',
            positionId: bbva,
            month: '2026-04',
            valuationId: march?.id as string,
            expectedVersion: march?.version as number,
            amount: '1',
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      preview(
        draftOf([
          {
            kind: 'valuation_clear',
            positionId: savings,
            month: '2026-03',
            valuationId: march?.id as string,
            expectedVersion: march?.version as number,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      preview(
        draftOf([
          {
            kind: 'income_clear',
            templateId: salary,
            occurrenceDate: '2026-04-25',
            entryId: entry?.id as string,
            expectedVersion: entry?.version as number,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('cannot reach another user’s rows', async () => {
    const theirs = await createCashAccount(positions(), on('2026-10-05', USER_B), {
      name: 'Theirs',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    });
    await expect(
      preview(draftOf([{ kind: 'valuation_create', positionId: theirs.id, month: '2026-03', amount: '1' }])),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/* -------------------------------------------------------------------------- */
/* The null leg                                                                */
/* -------------------------------------------------------------------------- */

describe('the null leg is judged by one participation rule (ADR 0011 D12)', () => {
  it('agrees with the single-flow query at every edge of the window', async () => {
    const { hasParticipatingCashAccount } = await import('../../src/flows/shared');
    const { hasParticipatingCashAccountIn, listPositionsIn } = await import('@vaultide/db');

    await harness.asOwner('DELETE FROM recurring_template_terms');
    await harness.asOwner('DELETE FROM recurring_templates');
    await harness.asOwner('DELETE FROM position_valuations');
    await harness.asOwner('DELETE FROM other_assets');
    await harness.asOwner('DELETE FROM cash_accounts');
    await harness.asOwner('DELETE FROM positions');

    // One account at a time, so every answer is about exactly one window.
    const windows: { opened: string | null; closed: string | null; currency?: string; kind?: 'other' }[] = [
      { opened: null, closed: null },
      { opened: '2026-03-01', closed: null },
      { opened: '2026-03-31', closed: null },
      { opened: null, closed: '2026-03-01' },
      { opened: null, closed: '2026-03-31' },
      { opened: '2026-02-01', closed: '2026-02-28' },
      { opened: '2026-04-01', closed: null },
      { opened: null, closed: null, currency: 'USD' },
      { opened: null, closed: null, kind: 'other' },
    ];
    const days = ['2026-02-28', '2026-03-01', '2026-03-15', '2026-03-31', '2026-04-01'];

    for (const window of windows) {
      await harness.asOwner('DELETE FROM position_valuations');
      await harness.asOwner('DELETE FROM other_assets');
      await harness.asOwner('DELETE FROM cash_accounts');
      await harness.asOwner('DELETE FROM positions');

      if (window.kind === 'other') {
        await createOtherAsset(positions(), OCT_5, {
          name: 'Thing',
          currency: 'EUR',
          assetType: 'vehicle',
          includeInFinancialNetWorth: false,
        });
      } else {
        const account = await createCashAccount(positions(), OCT_5, {
          name: 'Window',
          currency: window.currency ?? 'EUR',
          accountType: 'checking',
          openedOn: window.opened,
        });
        if (window.closed !== null) {
          await harness.asOwner(
            `UPDATE positions SET status = 'closed', closed_on = $1 WHERE id = $2`,
            [window.closed, account.id],
          );
        }
      }

      for (const day of days) {
        const [query, rule] = await withUser(harness.db, { userId: USER_A }, async (tx) => [
          await hasParticipatingCashAccountIn(tx, 'EUR', day),
          hasParticipatingCashAccount(await listPositionsIn(tx, { includeArchived: true }), 'EUR', day),
        ]);
        expect(rule, `${JSON.stringify(window)} on ${day}`).toBe(query);
      }
    }
  });
});
