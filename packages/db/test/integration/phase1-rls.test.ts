import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  type ProvisionedDatabase,
} from '../../src/testing/provision';
import { USER_OWNED_TABLES } from '../../src/repositories/users';

/**
 * Raw Row Level Security for the Phase 1 user-owned tables (blueprint 17.4,
 * 21.3, 21.4, Phase 1 acceptance item 9).
 *
 * Deliberately raw SQL as `app_user`, with no ORM and no repository in the way:
 * the point is what the **database** does when the guard rails above it are
 * absent. Every case of 17.4 is exercised on every new table — GUC missing, GUC
 * empty, GUC = A, GUC = B, and an insert forged for another tenant.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const INSUFFICIENT_PRIVILEGE = '42501';

/** Every Phase 1 user-owned table, with a minimal insert for one owner. */
const TABLES = [
  {
    name: 'user_settings',
    insert: (userId: string) =>
      `INSERT INTO user_settings (user_id, base_currency, reporting_currency, timezone, locale)
       VALUES ('${userId}', 'EUR', 'EUR', 'UTC', 'en-GB')`,
  },
  {
    name: 'categories',
    insert: (userId: string) =>
      `INSERT INTO categories (user_id, kind, name) VALUES ('${userId}', 'general', 'Probe ${userId.slice(0, 4)}')`,
  },
  {
    name: 'tags',
    insert: (userId: string) =>
      `INSERT INTO tags (user_id, name) VALUES ('${userId}', 'probe-${userId.slice(0, 4)}')`,
  },
] as const;

let db: ProvisionedDatabase;
let owner: pg.Client;
let user: pg.Client;
let backup: pg.Client;

async function setGuc(client: pg.Client, value: string | null): Promise<void> {
  await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [value]);
}

async function countAs(client: pg.Client, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n ?? '0');
}

beforeAll(async () => {
  db = await provisionDatabase({});
  owner = await connect(db.ownerUrl);
  user = await connect(db.userUrl);
  backup = await connect(db.backupUrl);

  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [id, email],
    );
  }
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), user?.end(), backup?.end()]);
  if (db) await dropDatabase(adminUrl(), db.databaseName);
});

beforeEach(async () => {
  // Seeded as the owner, who is not subject to RLS, so the rows exist
  // independently of anything the policy does.
  for (const table of TABLES) {
    await owner.query(`DELETE FROM ${table.name}`);
  }
  for (const table of TABLES) {
    await owner.query(table.insert(USER_A));
    await owner.query(table.insert(USER_B));
  }
});

describe.each(TABLES)('RLS on $name', ({ name, insert }) => {
  it('returns nothing, without erroring, when the setting was never set', async () => {
    await setGuc(user, null);
    expect(await countAs(user, name)).toBe(0);
  });

  it('returns nothing, without erroring, when the setting is empty', async () => {
    // A connection pooler can reset a GUC to the empty string. `NULLIF` turns
    // that into NULL, so the comparison is NULL and the policy denies — rather
    // than raising a cast error, which would leak that the table exists (D44).
    await setGuc(user, '');
    expect(await countAs(user, name)).toBe(0);
  });

  it('shows exactly one tenant’s rows', async () => {
    await setGuc(user, USER_A);
    expect(await countAs(user, name)).toBe(1);
    const a = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(a.rows.every((row) => row.user_id === USER_A)).toBe(true);

    await setGuc(user, USER_B);
    const b = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(b.rows.every((row) => row.user_id === USER_B)).toBe(true);
  });

  it('refuses an insert forged for another tenant (WITH CHECK)', async () => {
    await setGuc(user, USER_A);
    expect(await errorCodeOf(user, insert(USER_B))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot update or delete a row it cannot see', async () => {
    await setGuc(user, USER_A);
    const updated = await user.query(`UPDATE ${name} SET user_id = user_id WHERE user_id = $1`, [
      USER_B,
    ]);
    expect(updated.rowCount).toBe(0);
    const deleted = await user.query(`DELETE FROM ${name} WHERE user_id = $1`, [USER_B]);
    expect(deleted.rowCount).toBe(0);

    // B's row is still there, seen by a role that bypasses RLS.
    expect(await countAs(backup, name)).toBe(2);
  });

  it('cannot turn its own policy off', async () => {
    expect(await errorCodeOf(user, `ALTER TABLE ${name} DISABLE ROW LEVEL SECURITY`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await errorCodeOf(user, `CREATE POLICY escape_${name} ON ${name} FOR ALL TO app_user USING (true)`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is readable in full by the backup role, so a dump is complete (R27)', async () => {
    expect(await countAs(backup, name)).toBe(2);
    expect(await errorCodeOf(backup, insert(USER_A))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('global tables carry no RLS (17.4)', () => {
  it('lets the runtime read currencies and fx_rates with no user context at all', async () => {
    await setGuc(user, null);
    expect(await countAs(user, 'currencies')).toBeGreaterThan(0);
    // Empty, but readable — the difference between "no rows yet" and "denied".
    await expect(countAs(user, 'fx_rates')).resolves.toBeGreaterThanOrEqual(0);
  });

  it('has a policy on every user-owned table and on no other table', async () => {
    const { rows } = await owner.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY 1`,
    );

    const withRls = rows.filter((row) => row.rowsecurity).map((row) => row.tablename).sort();
    expect(withRls).toEqual([...USER_OWNED_TABLES].sort());

    // Which is also the statement that the Better Auth tables have none: a
    // session must be readable before there is a user id to scope by (17.4).
    const without = rows.filter((row) => !row.rowsecurity).map((row) => row.tablename);
    expect(without).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification', 'two_factor', 'rate_limit', 'currencies', 'fx_rates']),
    );
  });
});

describe('account deletion cascades to every user-owned table (18.3, 6.3)', () => {
  it('leaves nothing behind for the deleted user, and nothing touched for the other', async () => {
    // Seeded above: both users have a row in every user-owned table.
    for (const table of TABLES) expect(await countAs(backup, table.name)).toBe(2);

    // The whole mechanism is the FK cascade from `"user"`. Referential-integrity
    // actions are not subject to RLS, which is why it reaches rows the deleting
    // session could not itself have selected.
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [USER_A]);

    for (const table of TABLES) {
      const { rows } = await backup.query<{ user_id: string }>(
        `SELECT user_id FROM ${table.name}`,
      );
      expect(rows.map((row) => row.user_id), table.name).toEqual([USER_B]);
    }

    // Global rows are not user data and are explicitly out of scope (10.4).
    expect(await countAs(backup, 'currencies')).toBeGreaterThan(0);

    // Put A back for the other suites in this file.
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [USER_A, 'a@example.test'],
    );
  });

  it('accounts for every table keyed by a user, so a new one cannot be forgotten', async () => {
    // `USER_OWNED_TABLES` is what the deletion service verifies against. Every
    // table with a `user_id` must be either an application table on that list
    // or one of the Better Auth tables, which the library owns and which carry
    // no RLS (17.4). A migration that adds a third kind fails here rather than
    // quietly surviving an account deletion.
    const { rows } = await owner.query<{ tablename: string }>(
      `SELECT c.relname AS tablename
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND a.attnum > 0 AND NOT a.attisdropped
          )
        ORDER BY 1`,
    );

    const authTables = ['account', 'session', 'two_factor'];
    expect(rows.map((row) => row.tablename)).toEqual(
      [...USER_OWNED_TABLES, ...authTables].sort(),
    );
  });

  it('cascades the Better Auth tables too, so no credential outlives the account', async () => {
    await owner.query(
      `INSERT INTO session (id, expires_at, token, user_id)
       VALUES (gen_random_uuid(), now() + interval '1 day', 'probe-token', $1)`,
      [USER_A],
    );
    await owner.query(
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password)
       VALUES (gen_random_uuid(), 'credential', $1::text, 'credential', $2::uuid, 'a-scrypt-hash')`,
      [USER_A, USER_A],
    );
    await owner.query(
      `INSERT INTO two_factor (id, secret, backup_codes, user_id)
       VALUES (gen_random_uuid(), 'a-secret', 'encrypted-codes', $1)`,
      [USER_A],
    );

    await owner.query(`DELETE FROM "user" WHERE id = $1`, [USER_A]);

    for (const table of ['session', 'account', 'two_factor']) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE user_id = $1`,
        [USER_A],
      );
      expect(Number(rows[0]?.n), table).toBe(0);
    }

    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [USER_A, 'a@example.test'],
    );
  });
});
