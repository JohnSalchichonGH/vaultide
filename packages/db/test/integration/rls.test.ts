import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  type ProvisionedDatabase,
} from '../../src/testing/provision';
import {
  createDatabase as createDrizzle,
  createPool,
  InvalidUserIdError,
  ping,
  withoutUser,
  withUser,
  type Database,
} from '../../src/client';
import { RLS_USER_PREDICATE } from '../../src/schema/rls';

/**
 * Row Level Security primitives (blueprint 17.4, D44) and the `withUser`
 * transaction wrapper (Phase 0).
 *
 * Phase 0 has no user-owned tables yet, so the suite creates a probe table with
 * the **exact** policy expression every user table will carry, and proves the
 * behaviour that matters: a missing or empty GUC denies without erroring, a set
 * GUC scopes rows to one tenant, `app_user` cannot bypass any of it, and
 * `app_backup` sees everything.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const INSUFFICIENT_PRIVILEGE = '42501';

let db: ProvisionedDatabase;
let owner: pg.Client;
let user: pg.Client;
let backup: pg.Client;
let pool: ReturnType<typeof createPool>;
let drizzleDb: Database;

beforeAll(async () => {
  db = await provisionDatabase({ seed: false });
  owner = await connect(db.ownerUrl);

  await owner.query(`
    CREATE TABLE rls_probe (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      note text NOT NULL
    );
    ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
    CREATE POLICY rls_probe_user_policy ON rls_probe FOR ALL TO app_user
      USING (${RLS_USER_PREDICATE})
      WITH CHECK (${RLS_USER_PREDICATE});
  `);
  await owner.query(
    `INSERT INTO rls_probe (user_id, note) VALUES ($1,'A-1'), ($1,'A-2'), ($2,'B-1')`,
    [USER_A, USER_B],
  );

  user = await connect(db.userUrl);
  backup = await connect(db.backupUrl);
  pool = createPool({ connectionString: db.userUrl, max: 2 });
  drizzleDb = createDrizzle(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await Promise.allSettled([owner?.end(), user?.end(), backup?.end()]);
  if (db) await dropDatabase(adminUrl(), db.databaseName);
});

describe('RLS predicate behaviour under app_user', () => {
  it('denies without error when the setting was never set', async () => {
    await user.query(`SELECT set_config('app.current_user_id', NULL, false)`);
    const { rows } = await user.query('SELECT * FROM rls_probe');
    expect(rows).toHaveLength(0);
  });

  it('denies without error when the setting is empty (pooling reset)', async () => {
    await user.query(`SELECT set_config('app.current_user_id', '', false)`);
    const { rows } = await user.query('SELECT * FROM rls_probe');
    expect(rows).toHaveLength(0);
  });

  it('shows exactly one tenant’s rows when the setting carries a user id', async () => {
    await user.query(`SELECT set_config('app.current_user_id', $1, false)`, [USER_A]);
    const a = await user.query<{ note: string }>('SELECT note FROM rls_probe ORDER BY note');
    expect(a.rows.map((row) => row.note)).toEqual(['A-1', 'A-2']);

    await user.query(`SELECT set_config('app.current_user_id', $1, false)`, [USER_B]);
    const b = await user.query<{ note: string }>('SELECT note FROM rls_probe ORDER BY note');
    expect(b.rows.map((row) => row.note)).toEqual(['B-1']);
  });

  it('refuses an insert for another tenant (WITH CHECK)', async () => {
    await user.query(`SELECT set_config('app.current_user_id', $1, false)`, [USER_A]);
    const code = await errorCodeOf(
      user,
      `INSERT INTO rls_probe (user_id, note) VALUES ($1, 'forged')`,
      [USER_B],
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);

    // And cannot update or delete rows it cannot see.
    const updated = await user.query(`UPDATE rls_probe SET note = 'hijacked' WHERE note = 'B-1'`);
    expect(updated.rowCount).toBe(0);
    const deleted = await user.query(`DELETE FROM rls_probe WHERE note = 'B-1'`);
    expect(deleted.rowCount).toBe(0);
  });

  it('cannot turn RLS off', async () => {
    expect(await errorCodeOf(user, 'ALTER TABLE rls_probe DISABLE ROW LEVEL SECURITY')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await errorCodeOf(user, `CREATE POLICY escape ON rls_probe FOR ALL TO app_user USING (true)`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('app_backup and RLS', () => {
  it('reads every tenant’s rows, which is what makes a dump complete (R27, T12)', async () => {
    const { rows } = await backup.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM rls_probe',
    );
    expect(Number(rows[0]?.count)).toBe(3);

    const distinct = await backup.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM rls_probe ORDER BY user_id',
    );
    expect(distinct.rows.map((row) => row.user_id)).toEqual([USER_A, USER_B]);
  });

  it('still cannot write anything', async () => {
    expect(
      await errorCodeOf(backup, `INSERT INTO rls_probe (user_id, note) VALUES ($1,'x')`, [USER_A]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('withUser', () => {
  it('scopes a transaction to one user and does not leak the setting afterwards', async () => {
    const scoped = await withUser(drizzleDb, { userId: USER_A }, async (tx) => {
      const result = await tx.execute<{ note: string }>(
        sql`SELECT note FROM rls_probe ORDER BY note`,
      );
      return result.rows.map((row) => row.note);
    });
    expect(scoped).toEqual(['A-1', 'A-2']);

    // The GUC is transaction-local, so a later query sees nothing (fails closed).
    const leaked = await withoutUser(drizzleDb, async (tx) => {
      const result = await tx.execute(sql`SELECT note FROM rls_probe`);
      return result.rows;
    });
    expect(leaked).toHaveLength(0);
  });

  it('rejects anything that is not a canonical UUID before touching the database', async () => {
    for (const bad of ['', 'not-a-uuid', "' OR 1=1 --", `${USER_A} `, '11111111111141118111111111111111']) {
      await expect(withUser(drizzleDb, { userId: bad }, () => Promise.resolve(1))).rejects.toBeInstanceOf(
        InvalidUserIdError,
      );
    }
  });

  it('rolls back the whole transaction on failure', async () => {
    await expect(
      withUser(drizzleDb, { userId: USER_A }, async (tx) => {
        await tx.execute(sql`INSERT INTO rls_probe (user_id, note) VALUES (${USER_A}, 'rollback')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const remaining = await backup.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rls_probe WHERE note = 'rollback'`,
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });

  it('answers the health ping', async () => {
    await expect(ping(drizzleDb)).resolves.toBe(true);
  });
});
