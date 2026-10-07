import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { withUserRead } from '../../src/coordination';
import { provisionUser } from '../../src/users/provisioning';
import { closePosition, createCashAccount, updateCashAccount } from '../../src/positions/service';
import {
  confirmUnchanged,
  confirmUnchangedBatch,
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
import {
  createTemplate,
  resolveUpdateTemplateDetailsIn,
  updateTemplateDetails,
} from '../../src/recurring/templates';
import {
  acceptSuggestion,
  resolveAcceptSuggestionIn,
  resolveUnskipIn,
  skipSuggestion,
  unskipSuggestion,
} from '../../src/recurring/suggestions';

/**
 * What each ordinary resolution reads, statement by statement (23.2; ADR 0010
 * §8, §16).
 *
 * The rules behind recording, correcting and removing a balance, creating,
 * correcting and deleting an income entry, accepting a recurring occurrence and
 * restoring a skipped one are stated once, as pure decisions, and the resolvers load what those
 * decisions need and nothing more. Moving a template's end date is resolved the
 * same way: the template, its history when an end is set, and nothing else. This pins the load side: the exact sequence
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
  it('records one: the account, its currency, the date it would occupy, then the write', async () => {
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
      'select currencies',
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
      'select currencies',
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
      'select currencies',
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'select cash_accounts for update',
      'update cash_accounts',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('corrects one in place, judging its amount, without looking for a clash', async () => {
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
      'select currencies',
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
      'select currencies',
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
      'select currencies',
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

describe('a closed account’s balance, which also reads the final balance it would leave', () => {
  // M6, 5.2: a closed account's latest balance on or before its closing day
  // stays zero after every write. Judging that takes one more read — the
  // latest balance the write leaves standing — and only for a closed account:
  // every shape above, about an active one, is unchanged.
  let closed: string;

  beforeEach(async () => {
    const created = await createCashAccount(positions(), OCT_5, {
      name: 'Closed',
      currency: 'EUR',
      accountType: 'savings',
      openedOn: null,
    });
    closed = created.id;
    await recordValuation(positions(), OCT_5, {
      positionId: closed,
      valuedOn: '2026-08-31',
      amount: '0',
      datePrecision: 'month_end',
    });
    await recordValuation(positions(), OCT_5, {
      positionId: closed,
      valuedOn: '2026-10-01',
      amount: '300.00',
      datePrecision: 'exact',
    });
    await recordValuation(positions(), OCT_5, {
      positionId: closed,
      valuedOn: '2026-10-02',
      amount: '0',
      datePrecision: 'exact',
    });
    await closePosition(positions(), OCT_5, {
      positionId: closed,
      expectedVersion: created.version,
      closedOn: '2026-10-03',
    });
  });

  it('records one: the account, its currency, the date, the final balance, then the write', async () => {
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: closed,
        valuedOn: '2026-10-03',
        amount: '0',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select currencies',
      'select position_valuations',
      // The final balance: the latest on or before the closing day.
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses one that would leave money, having read the final balance and written nothing', async () => {
    const sent = await shapes(() =>
      recordValuation(positions(), OCT_5, {
        positionId: closed,
        valuedOn: '2026-10-03',
        amount: '500.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select currencies',
      'select position_valuations',
      'select position_valuations',
      'rollback',
    ]);
  });

  it('corrects one: the final balance it leaves standing is read before the write', async () => {
    const row = await balanceOn(closed, '2026-10-01');
    const sent = await shapes(() =>
      correctValuation(positions(), OCT_5, {
        valuationId: row.id,
        expectedVersion: row.version,
        valuedOn: '2026-10-01',
        amount: '250.00',
        datePrecision: 'exact',
      }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select position_valuations for update',
      'select positions',
      'select currencies',
      'select position_valuations',
      'select position_valuations for update',
      'update position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('removes one, and reads the same rows for a preview without locking any', async () => {
    const row = await balanceOn(closed, '2026-10-01');
    const preview = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveRemoveValuationIn(tx, { valuationId: row.id, expectedVersion: row.version }, { lock: false }),
      ),
    );
    expect(preview).toEqual([
      ...READ_OPEN,
      'select position_valuations',
      'select positions',
      'select position_valuations',
      'commit',
    ]);

    const sent = await shapes(() =>
      removeValuation(positions(), OCT_5, { valuationId: row.id, expectedVersion: row.version }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select position_valuations for update',
      'select positions',
      'select position_valuations',
      'select position_valuations for update',
      'delete position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('confirms a month unchanged with one read more', async () => {
    const sent = await shapes(() =>
      confirmUnchanged(positions(), OCT_5, { positionId: closed, month: '2026-09' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select positions',
      'select position_valuations',
      'select position_valuations for share',
      'select position_valuations',
      // The final balance the confirmation would leave.
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('confirms a month unchanged for several closed accounts with one read more in all', async () => {
    const other = await createCashAccount(positions(), OCT_5, {
      name: 'Closed too',
      currency: 'EUR',
      accountType: 'savings',
      openedOn: null,
    });
    await recordValuation(positions(), OCT_5, {
      positionId: other.id,
      valuedOn: '2026-08-31',
      amount: '0',
      datePrecision: 'month_end',
    });
    await closePosition(positions(), OCT_5, {
      positionId: other.id,
      expectedVersion: other.version,
      closedOn: '2026-10-03',
    });

    const sent = await shapes(() =>
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [closed, other.id] }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      // `lockCashPositionsIn`: `FOR UPDATE OF positions, cash_accounts`, whose
      // `OF` this file's shape reads as a table name.
      'select positions+of for update',
      'select position_valuations',
      'select position_valuations',
      'select position_valuations for share',
      'select position_valuations',
      'select position_valuations for share',
      'select position_valuations',
      // Both accounts' final balances, in one statement.
      'select position_valuations',
      'insert position_valuations',
      'insert audit_entries',
      'insert position_valuations',
      'insert audit_entries',
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

  it('creates one on a named account: the currency, the account, then the write', async () => {
    const sent = await shapes(() => create());
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select currencies',
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
      'select currencies',
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
      'select currencies',
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
      'select currencies',
      'select positions',
      'insert income_entries',
      'insert audit_entries',
      'select cash_accounts for update',
      'update cash_accounts',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('corrects one: the entry under its lock, its currency, its account, then the write', async () => {
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
      'select currencies',
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
    expect(update).toEqual([
      ...READ_OPEN,
      'select income_entries',
      'select currencies',
      'select positions',
      'commit',
    ]);

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

  it('accepts one at its own amount, judging that amount in the source’s currency first', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      acceptSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-10-02', amount: '3.50' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates',
      'select currencies',
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

  it('restores one: the skip under its lock, then the delete', async () => {
    const templateId = await interestTemplate(bbva);
    const skip = await skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-10-02', reason: 'skipped' });
    const sent = await shapes(() =>
      unskipSuggestion(flows(), OCT_5, { skipId: skip.id, expectedVersion: skip.version }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_template_skips for update',
      'select recurring_template_skips for update',
      'delete recurring_template_skips',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses to restore a finished month’s one having read the skip and nothing after it', async () => {
    const templateId = await interestTemplate(bbva);
    const skip = await skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-09-02', reason: 'skipped' });
    const sent = await shapes(() =>
      unskipSuggestion(flows(), OCT_5, { skipId: skip.id, expectedVersion: skip.version }),
    );
    expect(sent).toEqual([...WRITE_OPEN, 'select recurring_template_skips for update', 'rollback']);
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

    const skip = await skipSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-09-02', reason: 'skipped' });
    const restore = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveUnskipIn(tx, { skipId: skip.id, expectedVersion: skip.version }, { lock: false }),
      ),
    );
    expect(restore).toEqual([...READ_OPEN, 'select recurring_template_skips', 'commit']);
  });
});

describe('moving a template’s end date', () => {
  const LATEST_REFERENCED =
    'select income_entries+expense_entries+transfers+recurring_template_skips+recurring_templates';

  it('saves one that reaches only this month or later: the template under its lock, its history, then the write', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      updateTemplateDetails(flows(), OCT_5, { templateId, expectedVersion: 1, endDate: '2026-10-01' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates for update',
      LATEST_REFERENCED,
      'select recurring_templates for update',
      'update recurring_templates',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('refuses one that reaches a finished month having read the template and its history and nothing after', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      updateTemplateDetails(flows(), OCT_5, { templateId, expectedVersion: 1, endDate: '2026-08-31' }),
    );
    expect(sent).toEqual([...WRITE_OPEN, 'select recurring_templates for update', LATEST_REFERENCED, 'rollback']);
  });

  it('refuses a stale version having read the template alone', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      updateTemplateDetails(flows(), OCT_5, { templateId, expectedVersion: 2, endDate: '2026-08-31' }),
    );
    expect(sent).toEqual([...WRITE_OPEN, 'select recurring_templates for update', 'rollback']);
  });

  it('reads no history for a change to the name alone', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      updateTemplateDetails(flows(), OCT_5, { templateId, expectedVersion: 1, name: 'Bank interest' }),
    );
    expect(sent).toEqual([
      ...WRITE_OPEN,
      'select recurring_templates for update',
      'select recurring_templates for update',
      'update recurring_templates',
      'insert audit_entries',
      'commit',
    ]);
  });

  it('reads the same rows for a preview, and locks none of them', async () => {
    const templateId = await interestTemplate(bbva);
    const sent = await shapes(() =>
      withUserRead(harness.db, { userId: USER_A }, (tx) =>
        resolveUpdateTemplateDetailsIn(
          tx,
          { templateId, expectedVersion: 1, endDate: '2026-08-31' },
          { lock: false },
        ),
      ),
    );
    expect(sent).toEqual([...READ_OPEN, 'select recurring_templates', LATEST_REFERENCED, 'commit']);
  });
});
