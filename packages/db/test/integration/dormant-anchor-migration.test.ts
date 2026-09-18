import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  repoRoot,
  runCurrencySeed,
  runMigrations,
  type ProvisionedDatabase,
} from '../../src/testing/provision';

/**
 * Migration 0008, the dormant anchor (blueprint 6.2, 8.8, v2.1.17 30.20 item 9;
 * ADR 0007 §5).
 *
 * The migration is judged on the path production takes: a database at exactly
 * the previous schema, holding dormant accounts in every state the old rule
 * allowed, upgraded by the ordinary migrator. Each account that the new rule
 * would let a user mark dormant again is anchored on the balance that justifies
 * it; every other one is woken rather than given a date nobody observed. A
 * database built from zero is `fresh-database.test.ts`'s subject and runs this
 * migration over empty tables; the second block here checks what it leaves.
 */

const CHECK_VIOLATION = '23514';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const CATEGORY = 'cccccccc-0000-4000-8000-000000000001';
const LAST_PREVIOUS_MIGRATION = '0007_phase3_privileges_and_triggers';

const migrationsFolder = path.join(repoRoot, 'packages', 'db', 'migrations');

/** The repository's migrations up to and including `lastTag`, as their own folder. */
function migrationsThrough(lastTag: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultide-migrations-'));
  fs.mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const last = journal.entries.find((entry) => entry.tag === lastTag);
  if (last === undefined) throw new Error(`no migration tagged ${lastTag}`);
  const entries = journal.entries.filter((entry) => entry.idx <= last.idx);
  for (const entry of entries) {
    fs.copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

interface Account {
  readonly id: string;
  readonly dormant: boolean;
  /** `[valued_on, amount]`. */
  readonly valuations: readonly (readonly [string, string])[];
}

const id = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const EVIDENCED = id(1);
const SAME_DAY = id(2);
const STALE_INCOME = id(3);
const STALE_EXPENSE = id(4);
const STALE_SOURCE = id(5);
const STALE_DESTINATION = id(6);
const NO_VALUATION = id(7);
const NON_ZERO = id(8);
const AWAKE = id(9);
const REACTIVATED = id(10);

const ACCOUNTS: readonly Account[] = [
  // Held 5,000, emptied on 31 March, nothing since.
  { id: EVIDENCED, dormant: true, valuations: [['2026-01-31', '5000'], ['2026-03-31', '0']] },
  // A fee paid on the very day of the zero balance: already reflected in it (8.1).
  { id: SAME_DAY, dormant: true, valuations: [['2026-03-31', '0']] },
  // The old rule's hole: a zero that money has since moved past.
  { id: STALE_INCOME, dormant: true, valuations: [['2026-01-31', '0']] },
  { id: STALE_EXPENSE, dormant: true, valuations: [['2026-01-31', '0']] },
  { id: STALE_SOURCE, dormant: true, valuations: [['2026-01-31', '0']] },
  { id: STALE_DESTINATION, dormant: true, valuations: [['2026-01-31', '0']] },
  // The zero balance was deleted after the account was marked.
  { id: NO_VALUATION, dormant: true, valuations: [] },
  { id: NON_ZERO, dormant: true, valuations: [['2026-01-31', '0'], ['2026-04-30', '800']] },
  // Never dormant: not the migration's business, zero balance or not.
  { id: AWAKE, dormant: false, valuations: [['2026-03-31', '0']] },
  // Dormant, woken and dormant again: only the latest zero can be the anchor.
  { id: REACTIVATED, dormant: true, valuations: [['2025-10-31', '0'], ['2026-04-30', '800'], ['2026-06-30', '0']] },
];

async function seedPreviousSchema(owner: pg.Client): Promise<void> {
  for (const [userId, email] of [[USER, 'a@example.test'], [OTHER_USER, 'b@example.test']] as const) {
    await owner.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`, [userId, email]);
  }
  await owner.query(`INSERT INTO categories (id, user_id, kind, name) VALUES ($1, $2, 'food', 'Groceries')`, [CATEGORY, USER]);

  for (const account of ACCOUNTS) {
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency) VALUES ($1, $2, 'cash', $3, 'EUR')`,
      [account.id, USER, `account ${account.id.slice(-2)}`],
    );
    await owner.query(
      `INSERT INTO cash_accounts (position_id, user_id, account_type, is_dormant) VALUES ($1, $2, 'savings', $3)`,
      [account.id, USER, account.dormant],
    );
    for (const [valuedOn, amount] of account.valuations) {
      await owner.query(
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount) VALUES ($1, $2, $3, $4)`,
        [USER, account.id, valuedOn, amount],
      );
    }
  }

  const income = (positionId: string | null, on: string) =>
    owner.query(
      `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency, settlement, cash_position_id, cash_position_kind)
       VALUES ($1, 'interest', $2, 5, 'EUR', 'tracked_cash', $3, $4)`,
      [USER, on, positionId, positionId === null ? null : 'cash'],
    );
  const expense = (positionId: string, on: string) =>
    owner.query(
      `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency, settlement, cash_position_id, cash_position_kind)
       VALUES ($1, $2, $3, 5, 'EUR', 'tracked_cash', $4, 'cash')`,
      [USER, CATEGORY, on, positionId],
    );

  await income(STALE_INCOME, '2026-02-20');
  await expense(STALE_EXPENSE, '2026-02-20');
  await expense(SAME_DAY, '2026-03-31');
  // Earlier activity is what the zero balance already reflects.
  await income(EVIDENCED, '2026-03-10');
  // A flow that names no account is attributed to none of them (8.8).
  await income(null, '2026-08-01');
  await owner.query(
    `INSERT INTO transfers (user_id, kind, occurred_on, from_position_id, from_currency, from_amount, to_position_id, to_currency, to_amount)
     VALUES ($1, 'cash_transfer', DATE '2026-02-20', $2, 'EUR', 40, $3, 'EUR', 40)`,
    [USER, STALE_SOURCE, STALE_DESTINATION],
  );
}

describe('upgrading the previous schema', () => {
  let db: ProvisionedDatabase;
  let owner: pg.Client;
  let previousFolder: string;
  const stateOf = async (positionId: string) => {
    const { rows } = await owner.query<{ is_dormant: boolean; dormant_from: string | null }>(
      `SELECT is_dormant, dormant_from::text AS dormant_from FROM cash_accounts WHERE position_id = $1`,
      [positionId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    db = await provisionDatabase({ migrate: false, seed: false });
    previousFolder = migrationsThrough(LAST_PREVIOUS_MIGRATION);

    const pool = new pg.Pool({ connectionString: db.ownerUrl, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: previousFolder });
    } finally {
      await pool.end();
    }
    runCurrencySeed(db.ownerUrl);

    owner = await connect(db.ownerUrl);
    const before = await owner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_accounts' AND column_name = 'dormant_from'`,
    );
    // The premise of everything below: this really is the schema before 0008.
    expect(before.rows).toHaveLength(0);

    await seedPreviousSchema(owner);
    runMigrations(db.ownerUrl);
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    if (db !== undefined) await dropDatabase(adminUrl(), db.databaseName);
    if (previousFolder !== undefined) fs.rmSync(previousFolder, { recursive: true, force: true });
  });

  it('anchors an evidenced dormant account on its latest zero balance', async () => {
    expect(await stateOf(EVIDENCED)).toEqual({ is_dormant: true, dormant_from: '2026-03-31' });
  });

  it('does not call a zero stale for a flow dated the same day', async () => {
    expect(await stateOf(SAME_DAY)).toEqual({ is_dormant: true, dormant_from: '2026-03-31' });
  });

  it('anchors a reactivated account on its latest zero, never an earlier one', async () => {
    expect(await stateOf(REACTIVATED)).toEqual({ is_dormant: true, dormant_from: '2026-06-30' });
  });

  it.each([
    ['an attributed income dated after the zero', STALE_INCOME],
    ['an attributed expense dated after the zero', STALE_EXPENSE],
    ['a transfer out dated after the zero', STALE_SOURCE],
    ['a transfer in dated after the zero', STALE_DESTINATION],
    ['no valuation at all', NO_VALUATION],
    ['a non-zero latest valuation', NON_ZERO],
  ])('wakes a dormant account with %s', async (_label, positionId) => {
    expect(await stateOf(positionId)).toEqual({ is_dormant: false, dormant_from: null });
  });

  it('leaves an account that was not dormant alone', async () => {
    expect(await stateOf(AWAKE)).toEqual({ is_dormant: false, dormant_from: null });
  });

  it('leaves every row satisfying the constraint it then adds', async () => {
    const { rows } = await owner.query(
      `SELECT position_id FROM cash_accounts WHERE is_dormant <> (dormant_from IS NOT NULL)`,
    );
    expect(rows).toEqual([]);
  });
});

describe('the constraint, on a database built from zero', () => {
  let db: ProvisionedDatabase;
  let owner: pg.Client;
  const POSITION = id(99);

  beforeAll(async () => {
    db = await provisionDatabase();
    owner = await connect(db.ownerUrl);
    await owner.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'a', 'a@example.test', true)`, [USER]);
    await owner.query(`INSERT INTO positions (id, user_id, kind, name, currency) VALUES ($1, $2, 'cash', 'Savings', 'EUR')`, [POSITION, USER]);
    await owner.query(`INSERT INTO cash_accounts (position_id, user_id, account_type) VALUES ($1, $2, 'savings')`, [POSITION, USER]);
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    if (db !== undefined) await dropDatabase(adminUrl(), db.databaseName);
  });

  it('adds exactly one nullable date column and one CHECK', async () => {
    const column = await owner.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'cash_accounts' AND column_name = 'dormant_from'`,
    );
    expect(column.rows).toEqual([{ data_type: 'date', is_nullable: 'YES', column_default: null }]);
    const check = await owner.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'cash_accounts'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(check.rows.map((row: { conname: string }) => row.conname)).toEqual([
      'cash_accounts_dormant_anchor',
      'cash_accounts_kind_is_cash',
    ]);
  });

  it('starts a new account neither dormant nor anchored', async () => {
    const { rows } = await owner.query(`SELECT is_dormant, dormant_from FROM cash_accounts WHERE position_id = $1`, [POSITION]);
    expect(rows).toEqual([{ is_dormant: false, dormant_from: null }]);
  });

  it('refuses the flag without a date, and a date without the flag', async () => {
    expect(
      await errorCodeOf(owner, `UPDATE cash_accounts SET is_dormant = true WHERE position_id = $1`, [POSITION]),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCodeOf(
        owner,
        `UPDATE cash_accounts SET dormant_from = DATE '2026-03-31' WHERE position_id = $1`,
        [POSITION],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('accepts the two written together, and cleared together', async () => {
    await owner.query(
      `UPDATE cash_accounts SET is_dormant = true, dormant_from = DATE '2026-03-31' WHERE position_id = $1`,
      [POSITION],
    );
    expect(
      await errorCodeOf(owner, `UPDATE cash_accounts SET is_dormant = false WHERE position_id = $1`, [POSITION]),
    ).toBe(CHECK_VIOLATION);
    await owner.query(`UPDATE cash_accounts SET is_dormant = false, dormant_from = NULL WHERE position_id = $1`, [POSITION]);
    const { rows } = await owner.query(`SELECT is_dormant, dormant_from FROM cash_accounts WHERE position_id = $1`, [POSITION]);
    expect(rows).toEqual([{ is_dormant: false, dormant_from: null }]);
  });
});
