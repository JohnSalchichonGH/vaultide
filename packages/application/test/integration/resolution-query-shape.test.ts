import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { withUserRead } from '../../src/coordination';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, updateCashAccount } from '../../src/positions/service';
import {
  correctValuation,
  recordValuation,
  removeValuation,
  resolveCorrectValuationIn,
  resolveRemoveValuationIn,
} from '../../src/positions/valuations';
import {
  createIncomeEntry,
  deleteIncomeEntry,
  resolveIncomeDeleteIn,
  resolveIncomeUpdateIn,
  updateIncomeEntry,
} from '../../src/flows/income';
import { createTemplate } from '../../src/recurring/templates';
import {
  acceptSuggestion,
  resolveAcceptSuggestionIn,
  skipSuggestion,
} from '../../src/recurring/suggestions';

/**
 * What each ordinary resolution reads, statement by statement (23.2; ADR 0010
 * §8, §16).
 *
 * The rules behind recording, correcting and removing a balance, creating,
 * correcting and deleting an income entry, and accepting a recurring occurrence
 * are stated once, as pure decisions, and the resolvers load what those
 * decisions need and nothing more. This pins the load side: the exact sequence
 * of statements each path sends — which table, and under which row lock — on
 * the success paths and on the refusals that stop early.
 *
 * Two things it guards. A decision that quietly fell back to a repository would
 * add a statement here. And a resolver that loaded its state and then called an
 * older resolver that loaded it again would send the read twice. Either shows up
 * as a different sequence rather than as a slower test.
 *
 * Asserted at the driver, because that is the only place the real statement
 * exists. Values are ignored: this is about the shape of the reads, and the
 * other suites prove what they return.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let dormant: string;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER_A, reportingCurrency: 'EUR' });

const OCT_5 = on('2026-10-05');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/**
 * One statement as a comparable word: the verb, the first table it names, and
 * the row lock it takes. The transaction's own set-up keeps its full text,
 * because the isolation level and the mutex are part of what is being pinned.
 */
function shapeOf(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (/^(begin|commit|rollback)\b/u.test(normalized)) return normalized;
  if (normalized.includes('set_config(')) {
    return normalized.includes('lock_timeout') ? 'set lock_timeout' : 'set user';
  }
  if (normalized.includes('pg_advisory_xact_lock')) return 'advisory lock';

  const verb = normalized.split(' ')[0] ?? '';
  // Every table the statement reads or writes, quoted by Drizzle or written
  // bare in hand-written SQL; a UNION names each of its arms.
  const tables = [...normalized.matchAll(/\b(?:from|into|update)\s+"?([a-z_]+)"?/gu)]
    .map((match) => match[1] ?? '?')
    .join('+');
  const table = tables === '' ? '?' : tables;
  const lock = /\bfor (update|share|no key update|key share)\b/u.exec(normalized)?.[0];
  return lock === undefined ? `${verb} ${table}` : `${verb} ${table} ${lock}`;
}

/** Run one call and return the shape of every statement it sent, refused or not. */
async function shapes(run: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;
  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    sent.push(typeof first === 'string' ? first : (first?.text ?? ''));
    return Reflect.apply(original, this, args) as unknown;
  };

  try {
    await run().catch(() => undefined);
  } finally {
    driver.query = original;
  }
  return sent.map(shapeOf);
}

const WRITE_OPEN = ['begin isolation level read committed', 'set user', 'set lock_timeout', 'advisory lock'];
const READ_OPEN = ['begin isolation level repeatable read read only', 'set user'];

async function balanceOn(positionId: string, valuedOn: string): Promise<{ id: string; version: number }> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, version FROM position_valuations
           WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows[0] as { id: string; version: number };
  });
}

async function interestTemplate(cashPositionId: string): Promise<string> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'income',
    name: 'Interest',
    incomeKind: 'interest',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 2,
    startDate: '2026-01-01',
    cashPositionId,
    amount: '3.00',
    grossAmount: '4.00',
  });
  return template.id;
}

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
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  const make = (name: string) =>
    createCashAccount(positions(), OCT_5, {
      name,
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    });
  bbva = (await make('BBVA')).id;
  dormant = (await make('Old savings')).id;

  // An episode anchored in the current month, so waking it stays ordinary.
  await recordValuation(positions(), OCT_5, {
    positionId: dormant,
    valuedOn: '2026-10-01',
    amount: '0',
    datePrecision: 'exact',
  });
  const account = await withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT version FROM positions WHERE id = ${dormant}`);
    return result.rows[0] as { version: number };
  });
  await updateCashAccount(positions(), OCT_5, {
    positionId: dormant,
    expectedVersion: account.version,
    isDormant: true,
  });
});

describe('recording, correcting and removing a balance', () => {
  it('records one: the account, the date it would occupy, then the write', async () => {
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: bbva,
        valuedOn: '2026-10-02',
        amount: '100.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses a future date having read only the account', async () => {
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: bbva,
        valuedOn: '2026-10-06',
        amount: '100.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([...WRITE_OPEN, 'select positions', 'rollback']);
  });

  it('refuses a second balance on the same date having read the one already there', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-02',
      amount: '100.00',
      datePrecision: 'exact',
    });
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: bbva,
        valuedOn: '2026-10-02',
        amount: '120.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select position_valuations',
      'rollback',
    ]);
  });

  it('wakes a dormant account inside the same transaction', async () => {
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: dormant,
        valuedOn: '2026-10-03',
        amount: '50.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'select cash_accounts for update',
      'update cash_accounts',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('corrects one in place without looking for a clash', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-02',
      amount: '100.00',
      datePrecision: 'exact',
    });
    const row = await balanceOn(bbva, '2026-10-02');
    const sent = await shapes(() =>
      correctValuation(positions(), OCT_5, {
        valuationId: row.id,
        expectedVersion: row.version,
        valuedOn: '2026-10-02',
        amount: '110.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select position_valuations for update',
      'select positions',
      'select position_valuations for update',
      'update position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('re-dates one, reading the date it would move onto', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-02',
      amount: '100.00',
      datePrecision: 'exact',
    });
    const row = await balanceOn(bbva, '2026-10-02');
    const sent = await shapes(() =>
      correctValuation(positions(), OCT_5, {
        valuationId: row.id,
        expectedVersion: row.version,
        valuedOn: '2026-10-03',
        amount: '100.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select position_valuations for update',
      'select positions',
      'select position_valuations',
      'select position_valuations for update',
      'update position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('removes one', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-02',
      amount: '100.00',
      datePrecision: 'exact',
    });
    const row = await balanceOn(bbva, '2026-10-02');
    const sent = await shapes(() =>
      removeValuation(positions(), OCT_5, { valuationId: row.id, expectedVersion: row.version }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select position_valuations for update',
      'select positions',
      'select position_valuations for update',
      'delete position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('reads the same rows for a preview, and locks none of them', async () => {
    await recordValuation(positions(), OCT_5, {
      positionId: bbva,
      valuedOn: '2026-10-02',
      amount: '100.00',
      datePrecision: 'exact',
    });
    const row = await balanceOn(bbva, '2026-10-02');

    const correct = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveCorrectValuationIn(
          tx,
          OCT_5,
          {
            valuationId: row.id,
            expectedVersion: row.version,
            valuedOn: '2026-10-03',
            amount: '100.00',
            datePrecision: 'exact',
          },
          { lock: false },
        ),
      ),
    );
    expect(correct).toEqual([
      ...READ_OPEN,
      'select position_valuations',
      'select positions',
      'select position_valuations',
      'commit',
    ]);

    const remove = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveRemoveValuationIn(tx, { valuationId: row.id, expectedVersion: row.version }, { lock: false }),
      ),
    );
    expect(remove).toEqual([
      ...READ_OPEN,
      'select position_valuations',
      'select positions',
      'commit',
    ]);
  });
});

describe('creating, correcting and deleting an income entry', () => {
  const create = (overrides: Record<string, unknown> = {}) =>
    createIncomeEntry(flows(), OCT_5, {
      kind: 'employment',
      receivedOn: '2026-10-02',
      netAmount: '1000.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      ...overrides,
    });

  it('creates one on a named account: the account, then the write', async () => {
    const sent = await shapes(() => create());
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('creates one with no account: whether any account of the currency takes part', async () => {
    const sent = await shapes(() => create({ cashPositionId: null }));
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('creates one received outside tracked cash without reading any account', async () => {
    const sent = await shapes(() => create({ settlement: 'external', cashPositionId: null }));
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'insert income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses a future one before reading anything', async () => {
    const sent = await shapes(() => create({ receivedOn: '2026-10-06' }));
    expect(sent).toEqual([...WRITE_OPEN, 'rollback']);
  });

  it('wakes a dormant account it lands on, inside the same transaction', async () => {
    const sent = await shapes(() => create({ cashPositionId: dormant }));
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'select cash_accounts for update',
      'update cash_accounts',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('corrects one: the entry under its lock, its account, then the write', async () => {
    const entry = await create();
    const sent = await shapes(() =>
      updateIncomeEntry(flows(), OCT_5, {
        entryId: entry.id,
        expectedVersion: entry.version,
        netAmount: '1100.00',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select income_entries for update',
      'select positions',
      'select income_entries for update',
      'update income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('deletes one: the entry under its lock, then the write', async () => {
    const entry = await create();
    const sent = await shapes(() =>
      deleteIncomeEntry(flows(), OCT_5, { entryId: entry.id, expectedVersion: entry.version }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select income_entries for update',
      'select income_entries for update',
      'delete income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('reads the same rows for a preview, and locks none of them', async () => {
    const entry = await create();

    const update = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveIncomeUpdateIn(
          tx,
          OCT_5,
          { entryId: entry.id, expectedVersion: entry.version, netAmount: '1100.00' },
          { lock: false },
        ),
      ),
    );
    expect(update).toEqual([...READ_OPEN, 'select income_entries', 'select positions', 'commit']);

    const remove = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveIncomeDeleteIn(tx, { entryId: entry.id, expectedVersion: entry.version }, { lock: false }),
      ),
    );
    expect(remove).toEqual([...READ_OPEN, 'select income_entries', 'commit']);
  });
});

describe('accepting and skipping a recurring occurrence', () => {
  it('accepts a due one: the source, its terms, the claim, the account, then the write', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      acceptSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-10-02' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates',
      'select recurring_template_terms',
      'select recurring_templates for update',
      'select recurring_template_skips',
      'select income_entries+expense_entries+transfers',
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('accepts the next one early, reading what is already resolved', async () => {
    const templateId = await interestTemplate(bbva);
    await acceptSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-10-02' });
    const sent = await shapes(() =>
      acceptSuggestion(flows(), OCT_5, {
        templateId,
        occurrenceDate: '2026-11-02',
        receivedToday: true,
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates',
      'select recurring_template_terms',
      'select recurring_templates for update',
      'select income_entries',
      'select expense_entries',
      'select transfers',
      'select recurring_template_skips',
      'select recurring_template_skips',
      'select income_entries+expense_entries+transfers',
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses a skipped one having read the skip and nothing after it', async () => {
    const templateId = await interestTemplate(bbva);
    await skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-09-02', reason: 'skipped' });
    const sent = await shapes(() =>
      acceptSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-09-02' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates',
      'select recurring_template_terms',
      'select recurring_templates for update',
      'select recurring_template_skips',
      'rollback',
    ]);
  });

  it('skips one through the same claim', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-09-02', reason: 'skipped' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates for update',
      'select recurring_template_skips',
      'select income_entries+expense_entries+transfers',
      'insert recurring_template_skips',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('reads the same rows for a preview, and locks none of them', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveAcceptSuggestionIn(tx, OCT_5, { templateId, occurrenceDate: '2026-10-02' }, { lock: false }),
      ),
    );
    expect(sent).toEqual([
      ...READ_OPEN,
      'select recurring_templates',
      'select recurring_template_terms',
      'select recurring_templates',
      'select recurring_template_skips',
      'select income_entries+expense_entries+transfers',
      'select positions',
      'commit',
    ]);
  });
});
