import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { monthKeyOf } from '@vaultide/finance';
import { createHarness, type Harness } from '../helpers/harness';
import {
  READ_OPEN,
  WRITE_OPEN,
  isLock,
  isWrite,
  perConnection,
  record,
  shapes,
} from '../helpers/statement-shapes';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, createOtherAsset } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { createTemplate, setTemplateTerm } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type BulkHistoryDraft,
  type BulkHistoryOperation,
} from '../../src/corrections/index';
import { getBulkHistoryPage } from '../../src/bulk-history/index';

/**
 * What a Bulk History save and the grid read send, statement by statement
 * (23.1, 23.2; ADR 0010 §8, §16; ADR 0011).
 *
 * Three promises, each asserted at the driver because that is the only place
 * the real statement exists:
 *
 *  - **statements grow by family, never by cell.** A batch of many cells sends
 *    exactly the reads a batch of one cell per family sends, and the grid's read
 *    sends the same statements over a sparse history and a dense one;
 *  - **Preview is one read-only transaction** — no mutex, no row lock, no write,
 *    no audit;
 *  - **Confirm takes the mutex before it reads anything**, locks the rows it
 *    revises and the templates it claims in one fixed order, reads exactly what
 *    the preview read, and writes nothing until every read is done.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let savings: string;
let car: string;
let salary: string;
let rent: string;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER_A, reportingCurrency: 'EUR' });

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

const statement = (positionId: string, valuedOn: string, amount: string) =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'month_end' });

async function row(table: 'position_valuations' | 'income_entries', where: string, value: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      table === 'position_valuations'
        ? sql`SELECT id, version FROM position_valuations WHERE valued_on = ${value} AND position_id = ${where}`
        : sql`SELECT id, version FROM income_entries WHERE occurrence_date = ${value} AND template_id = ${where}`,
    );
    return result.rows[0] as { id: string; version: number };
  });
}

const ODD_MONTH_ENDS = ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-09-30'];

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });
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
    'other_assets',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  const cash = (name: string) =>
    createCashAccount(positions(), OCT_5, { name, currency: 'EUR', accountType: 'checking', openedOn: null });
  bbva = (await cash('BBVA')).id;
  savings = (await cash('Savings')).id;
  car = (
    await createOtherAsset(positions(), OCT_5, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    })
  ).id;

  // Statements in the odd months, so the even months are free for new ones.
  for (const end of ODD_MONTH_ENDS) {
    await statement(bbva, end, '1000');
    await statement(savings, end, '500');
  }

  const income = async (name: string, incomeKind: 'employment' | 'rental', dayOfMonth: number) =>
    (
      await createTemplate(flows(), OCT_5, {
        kind: 'income',
        name,
        incomeKind,
        currency: 'EUR',
        frequency: 'monthly',
        dayOfMonth,
        startDate: '2026-01-01',
        cashPositionId: bbva,
        amount: '2100',
        grossAmount: '3000',
      })
    ).template.id;
  salary = await income('Salary', 'employment', 25);
  rent = await income('Rent', 'rental', 1);
  await setTemplateTerm(flows(), OCT_5, {
    templateId: salary,
    effectiveFrom: '2026-06-25',
    amount: '2200',
    expected: { state: 'absent' },
  });
  for (const date of ['2026-01-25', '2026-09-25', '2026-03-25']) {
    await acceptSuggestion(flows(), OCT_5, { templateId: salary, occurrenceDate: date });
  }
  await skipSuggestion(flows(), OCT_5, { templateId: rent, occurrenceDate: '2026-04-01', reason: 'vacant' });
});

/** One cell of every operation, touching January and September like the larger batch. */
async function smallBatch(): Promise<BulkHistoryOperation[]> {
  const january = await row('position_valuations', bbva, '2026-01-31');
  const september = await row('position_valuations', bbva, '2026-09-30');
  const firstPay = await row('income_entries', salary, '2026-01-25');
  const lastPay = await row('income_entries', salary, '2026-09-25');
  return [
    { kind: 'valuation_create', positionId: bbva, month: '2026-02', amount: '1' },
    {
      kind: 'valuation_update',
      positionId: bbva,
      month: '2026-01',
      valuationId: january.id,
      expectedVersion: january.version,
      amount: '2',
    },
    {
      kind: 'valuation_clear',
      positionId: bbva,
      month: '2026-09',
      valuationId: september.id,
      expectedVersion: september.version,
    },
    { kind: 'income_create', templateId: salary, occurrenceDate: '2026-02-25', netAmount: '2100' },
    {
      kind: 'income_update',
      templateId: salary,
      occurrenceDate: '2026-01-25',
      entryId: firstPay.id,
      expectedVersion: firstPay.version,
      netAmount: '2000',
    },
    {
      kind: 'income_clear',
      templateId: salary,
      occurrenceDate: '2026-09-25',
      entryId: lastPay.id,
      expectedVersion: lastPay.version,
    },
  ];
}

/** The same families, many cells of each, over the same first and last month. */
async function largeBatch(): Promise<BulkHistoryOperation[]> {
  const small = await smallBatch();
  const extra: BulkHistoryOperation[] = [];
  for (const month of ['2026-04', '2026-06', '2026-08']) {
    extra.push({ kind: 'valuation_create', positionId: bbva, month, amount: '3' });
  }
  for (const month of ['2026-02', '2026-04', '2026-06', '2026-08']) {
    extra.push({ kind: 'valuation_create', positionId: savings, month, amount: '4' });
    extra.push({ kind: 'valuation_create', positionId: car, month, amount: '9000' });
  }
  for (const end of ['2026-03-31', '2026-05-31', '2026-07-31']) {
    const existing = await row('position_valuations', savings, end);
    extra.push({
      kind: 'valuation_update',
      positionId: savings,
      month: end.slice(0, 7),
      valuationId: existing.id,
      expectedVersion: existing.version,
      amount: '501',
    });
  }
  for (const date of ['2026-04-25', '2026-05-25', '2026-06-25', '2026-07-25', '2026-08-25']) {
    extra.push({ kind: 'income_create', templateId: salary, occurrenceDate: date, netAmount: '2100' });
  }
  for (const date of ['2026-02-01', '2026-03-01', '2026-05-01', '2026-06-01']) {
    extra.push({ kind: 'income_create', templateId: rent, occurrenceDate: date, netAmount: '700' });
  }
  const march = await row('income_entries', salary, '2026-03-25');
  extra.push({
    kind: 'income_update',
    templateId: salary,
    occurrenceDate: '2026-03-25',
    entryId: march.id,
    expectedVersion: march.version,
    netAmount: '1999',
  });
  return [...small, ...extra];
}

const draftOf = (operations: BulkHistoryOperation[]): BulkHistoryDraft => ({
  kind: 'bulk_history',
  startMonth: '2026-01',
  operations,
});

const previewShapes = (draft: BulkHistoryDraft) =>
  shapes(() => previewHistoricalCorrection(corrections(), OCT_5, { draft }));

describe('Preview', () => {
  it('is one read-only transaction with no mutex, no row lock, no write and no audit', async () => {
    const sent = await previewShapes(draftOf(await largeBatch()));

    expect(sent.slice(0, READ_OPEN.length)).toEqual(READ_OPEN);
    expect(sent.at(-1)).toBe('commit');
    expect(sent.filter((shape) => shape === 'advisory lock')).toEqual([]);
    expect(sent.filter(isLock)).toEqual([]);
    expect(sent.filter(isWrite)).toEqual([]);
  });

  it('sends the same statements for many cells as for one cell per family', async () => {
    const one = await previewShapes(draftOf(await smallBatch()));
    const many = await previewShapes(draftOf(await largeBatch()));
    expect(many).toEqual(one);
  });

  it('reads one statement per family it needs, and none for a family it does not', async () => {
    const sent = await previewShapes(
      draftOf([{ kind: 'valuation_create', positionId: bbva, month: '2026-02', amount: '1' }]),
    );
    // No stored row is revised and no occurrence claimed, so none of those
    // families is read at all.
    expect(sent.slice(READ_OPEN.length, READ_OPEN.length + 4)).toEqual([
      'select positions',
      'select position_valuations',
      // The minor units every amount in the batch is judged by, once the
      // cells are decided: one read for the whole batch (7.2).
      'select currencies',
      // …and then the correction evidence, which starts again from the
      // positions and the whole balance history.
      'select positions',
    ]);
  });
});

describe('Confirm', () => {
  it('takes the mutex first, locks in a fixed order, reads what the preview read, then writes', async () => {
    const operations = await largeBatch();
    const draft = draftOf(operations);
    const previewed = await previewShapes(draft);
    const prepared = await previewHistoricalCorrection(corrections(), OCT_5, { draft });
    if (prepared.status !== 'review_required') throw new Error('expected a review');

    const sent = await shapes(() =>
      confirmHistoricalCorrection(corrections(), OCT_5, {
        draft,
        fingerprint: prepared.preview.fingerprint,
      }),
    );

    expect(sent.slice(0, WRITE_OPEN.length)).toEqual(WRITE_OPEN);
    expect(sent.slice(WRITE_OPEN.length, WRITE_OPEN.length + 3)).toEqual([
      'select position_valuations for update',
      'select income_entries for update',
      'select recurring_templates for update',
    ]);

    // Then exactly the preview's reads, with the three locks added, before any
    // write: everything is resolved before the first row moves.
    const previewReads = previewed.slice(READ_OPEN.length, -1);
    const resolved = sent.slice(WRITE_OPEN.length, WRITE_OPEN.length + previewReads.length);
    expect(resolved.map((shape) => shape.replace(/ for update$/u, ''))).toEqual(previewReads);
    expect(resolved.filter(isWrite)).toEqual([]);

    // After it: only the rows — each writer's own before-image lock, the row
    // and its audit entry — then the commit.
    const rest = sent.slice(WRITE_OPEN.length + previewReads.length);
    expect(rest.at(-1)).toBe('commit');
    expect(rest.slice(0, -1).filter((shape) => !isWrite(shape) && !isLock(shape))).toEqual([]);
    expect(rest.filter((shape) => shape === 'insert audit_entries')).toHaveLength(operations.length);
  });
});

describe('the grid read', () => {
  // The snapshot and the currency catalogue run at once, on two pooled
  // connections, so their statements interleave however they are scheduled:
  // each connection is compared in its own order.
  const read = () =>
    record(() => getBulkHistoryPage({ db: harness.db }, OCT_5, monthKeyOf(2020, 1)));

  it('is one coherent read-only snapshot of a fixed number of statements', async () => {
    const sent = await read();
    // In `perConnection`'s fixed order, which puts the currency read first.
    expect(perConnection(sent)).toEqual([
      ['begin', 'select currencies', 'commit'],
      [
        ...READ_OPEN,
        'select positions',
        'select position_valuations',
        'select position_valuations',
        'select recurring_templates',
        'select recurring_template_skips',
        'select income_entries',
        'commit',
      ],
    ]);
    const every = sent.map(({ shape }) => shape);
    expect(every.filter(isLock)).toEqual([]);
    expect(every.filter(isWrite)).toEqual([]);
  });

  it('sends the same statements over a dense history as over a sparse one', async () => {
    const sparse = perConnection(await read());
    for (const end of ['2026-02-28', '2026-04-30', '2026-06-30', '2026-08-31']) {
      await statement(bbva, end, '7');
    }
    for (const date of ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']) {
      await acceptSuggestion(flows(), OCT_5, { templateId: rent, occurrenceDate: date });
    }
    expect(perConnection(await read())).toEqual(sparse);
  });
});
