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

/**
 * Raw Row Level Security and the schema invariants for the Phase 2 tables
 * (blueprint 17.4, 21.3, 21.4; §26 Phase 2 items 1, 2, 7, 8, 9, 10).
 *
 * Deliberately raw SQL as `app_user`, with no ORM and no repository in the way:
 * the point is what the **database** does when the guard rails above it are
 * absent. Every case of 17.4 is exercised on every new table.
 *
 * It also proves the two halves of the date rule are in the right places: the
 * timeless one (a month-end balance is dated the last day of its month) is a
 * CHECK the database enforces, and the time-dependent ones (not in the future;
 * not before the month has ended) are **not** constraints at all — 6.1 forbids
 * a constraint that references the moving present, and a test asserts the
 * schema contains none.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const INVALID_ENUM = '22P02';

/** A cash position and an other asset per user, created by the owner. */
const POSITION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const POSITION_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const ASSET_A = 'aaaaaaaa-0000-4000-8000-000000000002';
const ASSET_B = 'bbbbbbbb-0000-4000-8000-000000000002';

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

/** Seed one cash account, one other asset and one valuation each, as the owner. */
async function seed(): Promise<void> {
  for (const [userId, positionId, assetId] of [
    [USER_A, POSITION_A, ASSET_A],
    [USER_B, POSITION_B, ASSET_B],
  ] as const) {
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency)
       VALUES ($1, $2, 'cash', 'Probe cash', 'EUR')`,
      [positionId, userId],
    );
    await owner.query(
      `INSERT INTO cash_accounts (position_id, user_id, account_type)
       VALUES ($1, $2, 'checking')`,
      [positionId, userId],
    );
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency)
       VALUES ($1, $2, 'other_asset', 'Probe car', 'EUR')`,
      [assetId, userId],
    );
    await owner.query(
      `INSERT INTO other_assets (position_id, user_id, asset_type, include_in_financial_net_worth)
       VALUES ($1, $2, 'vehicle', false)`,
      [assetId, userId],
    );
    await owner.query(
      `INSERT INTO position_valuations (user_id, position_id, valued_on, amount)
       VALUES ($1, $2, DATE '2026-08-31', 1000)`,
      [userId, positionId],
    );
    await owner.query(
      `INSERT INTO audit_entries (user_id, entity_table, entity_id, action, after)
       VALUES ($1, 'positions', $2, 'insert', '{"probe":true}'::jsonb)`,
      [userId, positionId],
    );
  }
}

async function clear(): Promise<void> {
  await owner.query('DELETE FROM audit_entries');
  await owner.query('DELETE FROM position_valuations');
  await owner.query('DELETE FROM cash_accounts');
  await owner.query('DELETE FROM other_assets');
  await owner.query('DELETE FROM positions');
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
  await clear();
  await seed();
});

/** One insert per table that belongs to the given owner. */
const INSERTS: Record<string, (userId: string) => string> = {
  positions: (userId) =>
    `INSERT INTO positions (user_id, kind, name, currency)
     VALUES ('${userId}', 'cash', 'Forged ${userId.slice(0, 4)}', 'EUR')`,
  cash_accounts: (userId) =>
    `INSERT INTO cash_accounts (position_id, user_id, account_type)
     VALUES ('${userId === USER_A ? ASSET_A : ASSET_B}', '${userId}', 'checking')`,
  other_assets: (userId) =>
    `INSERT INTO other_assets (position_id, user_id, asset_type)
     VALUES ('${userId === USER_A ? POSITION_A : POSITION_B}', '${userId}', 'vehicle')`,
  position_valuations: (userId) =>
    `INSERT INTO position_valuations (user_id, position_id, valued_on, amount)
     VALUES ('${userId}', '${userId === USER_A ? POSITION_A : POSITION_B}', DATE '2026-07-31', 5)`,
  audit_entries: (userId) =>
    `INSERT INTO audit_entries (user_id, entity_table, entity_id, action)
     VALUES ('${userId}', 'positions', '${userId === USER_A ? POSITION_A : POSITION_B}', 'insert')`,
};

const PHASE_2_TABLES = [
  'positions',
  'cash_accounts',
  'other_assets',
  'position_valuations',
  'audit_entries',
] as const;

describe.each(PHASE_2_TABLES)('RLS on %s', (name) => {
  it('returns nothing, without erroring, when the setting was never set', async () => {
    await setGuc(user, null);
    expect(await countAs(user, name)).toBe(0);
  });

  it('returns nothing, without erroring, when the setting is empty', async () => {
    // A connection pooler can reset a GUC to the empty string; `NULLIF` turns
    // that into NULL so the policy denies rather than raising a cast error.
    await setGuc(user, '');
    expect(await countAs(user, name)).toBe(0);
  });

  it('shows exactly one tenant’s rows', async () => {
    await setGuc(user, USER_A);
    const a = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((row) => row.user_id === USER_A)).toBe(true);

    await setGuc(user, USER_B);
    const b = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.rows.every((row) => row.user_id === USER_B)).toBe(true);
  });

  it('refuses an insert forged for another tenant (WITH CHECK)', async () => {
    await setGuc(user, USER_A);
    expect(await errorCodeOf(user, (INSERTS[name] as (id: string) => string)(USER_B))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot update or delete a row it cannot see', async () => {
    await setGuc(user, USER_A);

    if (name === 'audit_entries') {
      // Refused a layer earlier than RLS: `app_user` holds INSERT and SELECT on
      // the audit trail and nothing more (6.1, 18.1). Denial by privilege is
      // stronger than denial by policy, and it is the one this table wants.
      expect(
        await errorCodeOf(user, `UPDATE ${name} SET reason = 'x' WHERE user_id = $1`, [USER_B]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await errorCodeOf(user, `DELETE FROM ${name} WHERE user_id = $1`, [USER_B]),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      return;
    }

    const updated = await user.query(
      `UPDATE ${name} SET user_id = user_id WHERE user_id = $1`,
      [USER_B],
    );
    expect(updated.rowCount).toBe(0);

    const deleted = await user.query(`DELETE FROM ${name} WHERE user_id = $1`, [USER_B]);
    expect(deleted.rowCount).toBe(0);

    // B's rows are all still there, seen by a role that bypasses RLS.
    expect(await countAs(backup, name)).toBeGreaterThanOrEqual(2);
  });

  it('cannot turn its own policy off', async () => {
    expect(await errorCodeOf(user, `ALTER TABLE ${name} DISABLE ROW LEVEL SECURITY`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await errorCodeOf(
        user,
        `CREATE POLICY escape_${name} ON ${name} FOR ALL TO app_user USING (true)`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is readable in full by the backup role, which can write nothing (R27)', async () => {
    expect(await countAs(backup, name)).toBeGreaterThanOrEqual(2);
    expect(await errorCodeOf(backup, (INSERTS[name] as (id: string) => string)(USER_A))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('a child can never reference another tenant’s parent (M8, 6.1)', () => {
  it('refuses a valuation pointing at the other user’s position', async () => {
    // The composite `(position_id, user_id)` foreign key is what makes this
    // impossible even when the application code is wrong — and it is the
    // database, not RLS, that says no: A owns this row and is allowed to write
    // it, but the parent it names is not A's.
    await setGuc(user, USER_A);
    const code = await errorCodeOf(
      user,
      `INSERT INTO position_valuations (user_id, position_id, valued_on, amount)
       VALUES ($1, $2, DATE '2026-06-30', 1)`,
      [USER_A, POSITION_B],
    );
    expect(code).toBe(FK_VIOLATION);
  });

  it('refuses a cash account attached to the other user’s position', async () => {
    // A fresh cash position of B's, with no subtype row yet, so the refusal
    // below is the composite foreign key and not the primary key.
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO positions (user_id, kind, name, currency)
       VALUES ($1, 'cash', 'Unclaimed', 'EUR') RETURNING id`,
      [USER_B],
    );
    const unclaimed = rows[0]?.id as string;

    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO cash_accounts (position_id, user_id, account_type)
         VALUES ($1, $2, 'checking')`,
        [unclaimed, USER_A],
      ),
    ).toBe(FK_VIOLATION);
  });

  it('refuses a subtype attached to a position of the wrong kind (typed FK, 6.1)', async () => {
    // `other_assets` targets `(id, user_id, kind = 'other_asset')`, so pointing
    // it at a cash position is a foreign-key failure, not a silent mismatch.
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO other_assets (position_id, user_id, asset_type)
         VALUES ($1, $2, 'vehicle')`,
        [POSITION_A, USER_A],
      ),
    ).toBe(FK_VIOLATION);
  });

  it('refuses a cash_accounts row whose kind is not cash', async () => {
    expect(
      await errorCodeOf(
        owner,
        `INSERT INTO cash_accounts (position_id, user_id, kind, account_type)
         VALUES ($1, $2, 'investment', 'checking')`,
        [ASSET_A, USER_A],
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('valuation constraints (M1, R15, 6.2)', () => {
  it('allows exactly one valuation per position per date', async () => {
    await setGuc(user, USER_A);
    const code = await errorCodeOf(
      user,
      `INSERT INTO position_valuations (user_id, position_id, valued_on, amount)
       VALUES ($1, $2, DATE '2026-08-31', 42)`,
      [USER_A, POSITION_A],
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a month-end balance dated anything but the month’s last day', async () => {
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount, date_precision)
         VALUES ($1, $2, DATE '2026-07-15', 10, 'month_end')`,
        [USER_A, POSITION_A],
      ),
    ).toBe(CHECK_VIOLATION);

    // …and accepts the last day, including February in a leap year.
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount, date_precision)
         VALUES ($1, $2, DATE '2024-02-29', 10, 'month_end')`,
        [USER_A, POSITION_A],
      ),
    ).toBeNull();
  });

  it('rejects a NULL in every required column', async () => {
    await setGuc(user, USER_A);
    const required: [string, string][] = [
      ['user_id', `NULL, '${POSITION_A}', DATE '2026-05-31', 1`],
      ['position_id', `'${USER_A}', NULL, DATE '2026-05-31', 1`],
      ['valued_on', `'${USER_A}', '${POSITION_A}', NULL, 1`],
      ['amount', `'${USER_A}', '${POSITION_A}', DATE '2026-05-31', NULL`],
    ];

    for (const [column, values] of required) {
      const code = await errorCodeOf(
        user,
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount) VALUES (${values})`,
      );
      // A NULL `user_id` fails the policy before the NOT NULL constraint; both
      // are refusals, and both are the point.
      expect([NOT_NULL_VIOLATION, INSUFFICIENT_PRIVILEGE], column).toContain(code);
    }
  });

  it('rejects an unknown value for every enum column', async () => {
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount, source)
         VALUES ($1, $2, DATE '2026-05-31', 1, 'guessed')`,
        [USER_A, POSITION_A],
      ),
    ).toBe(INVALID_ENUM);

    expect(
      await errorCodeOf(
        user,
        `INSERT INTO positions (user_id, kind, name, currency) VALUES ($1, 'timeshare', 'x', 'EUR')`,
        [USER_A],
      ),
    ).toBe(INVALID_ENUM);

    expect(
      await errorCodeOf(
        user,
        `INSERT INTO positions (user_id, kind, name, currency, status)
         VALUES ($1, 'cash', 'x', 'EUR', 'frozen')`,
        [USER_A],
      ),
    ).toBe(INVALID_ENUM);
  });

  it('refuses a position whose closing date precedes its opening', async () => {
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO positions (user_id, kind, name, currency, opened_on, closed_on)
         VALUES ($1, 'cash', 'Backwards', 'EUR', DATE '2026-08-01', DATE '2026-07-01')`,
        [USER_A],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a closed position with no closing date', async () => {
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO positions (user_id, kind, name, currency, status)
         VALUES ($1, 'cash', 'Closed', 'EUR', 'closed')`,
        [USER_A],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a currency that is not in the catalogue', async () => {
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO positions (user_id, kind, name, currency) VALUES ($1, 'cash', 'Crypto', 'BTC')`,
        [USER_A],
      ),
    ).toBe(FK_VIOLATION);
  });
});

describe('no constraint in this schema depends on the current time (6.1, M5)', () => {
  it('has no CHECK referencing now(), current_date or a moving clock', async () => {
    // The rule that makes this necessary: "not in the future" is not a row
    // invariant. A CHECK saying so would change its verdict on a row that never
    // changed, and would make a restored backup unrestorable. Both time rules
    // live in validation and the domain instead.
    const { rows } = await owner.query<{ conname: string; def: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.contype = 'c'`,
    );

    const offenders = rows.filter((row) =>
      /now\(\)|current_date|current_timestamp|localtimestamp|statement_timestamp|clock_timestamp/iu.test(
        row.def,
      ),
    );
    expect(offenders.map((row) => `${row.conname}: ${row.def}`)).toEqual([]);
  });

  it('does allow a valuation dated in the future, because the database is not the authority', async () => {
    // Stated explicitly so nobody "fixes" this by adding a CHECK. The refusal
    // belongs to the application layer, which knows the user's local today —
    // and `positions.test.ts` proves the server refuses it there.
    await setGuc(user, USER_A);
    expect(
      await errorCodeOf(
        user,
        `INSERT INTO position_valuations (user_id, position_id, valued_on, amount)
         VALUES ($1, $2, DATE '2099-01-01', 1)`,
        [USER_A, POSITION_A],
      ),
    ).toBeNull();
  });
});

describe('deleting a position (6.3)', () => {
  it('is refused while it has valuations, and allowed once it has none', async () => {
    await setGuc(user, USER_A);
    // `NO ACTION` rather than `RESTRICT`: checked at the end of the statement,
    // so the whole-account cascade still works while this ordinary delete does
    // not orphan history.
    expect(
      await errorCodeOf(user, `DELETE FROM positions WHERE id = $1`, [POSITION_A]),
    ).toBe(FK_VIOLATION);

    await user.query(`DELETE FROM position_valuations WHERE position_id = $1`, [POSITION_A]);
    await user.query(`DELETE FROM cash_accounts WHERE position_id = $1`, [POSITION_A]);
    expect(await errorCodeOf(user, `DELETE FROM positions WHERE id = $1`, [POSITION_A])).toBeNull();
  });
});

describe('account deletion still reaches everything (18.3, 6.3)', () => {
  it('empties every Phase 2 table for the deleted user and touches nothing of the other', async () => {
    for (const table of PHASE_2_TABLES) {
      expect(await countAs(backup, table)).toBeGreaterThanOrEqual(2);
    }

    await owner.query(`DELETE FROM "user" WHERE id = $1`, [USER_A]);

    for (const table of PHASE_2_TABLES) {
      const { rows } = await backup.query<{ user_id: string }>(`SELECT user_id FROM ${table}`);
      expect(rows.map((row) => row.user_id), table).toEqual(
        rows.map(() => USER_B),
      );
      expect(rows.length, table).toBeGreaterThan(0);
    }

    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [USER_A, 'a@example.test'],
    );
  });
});

describe('the audit trail cannot be rewritten by the runtime (18.1, 6.1)', () => {
  it('lets app_user insert and read, and nothing else', async () => {
    await setGuc(user, USER_A);

    expect(
      await errorCodeOf(
        user,
        `INSERT INTO audit_entries (user_id, entity_table, entity_id, action, before)
         VALUES ($1, 'position_valuations', $2, 'delete', '{"amount":"1000"}'::jsonb)`,
        [USER_A, POSITION_A],
      ),
    ).toBeNull();

    expect(await countAs(user, 'audit_entries')).toBeGreaterThan(0);

    // The role that deletes a valuation must not be able to erase the record
    // of having done so.
    expect(
      await errorCodeOf(user, `UPDATE audit_entries SET reason = 'edited' WHERE user_id = $1`, [
        USER_A,
      ]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCodeOf(user, `DELETE FROM audit_entries WHERE user_id = $1`, [USER_A]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('the runtime role is still boxed in (17.3, 17.4)', () => {
  it('cannot create a table, grant itself anything or change a table it does not own', async () => {
    expect(await errorCodeOf(user, `CREATE TABLE escape_hatch (id uuid)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(user, `ALTER TABLE positions ADD COLUMN sneaky text`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(user, `ALTER ROLE app_user BYPASSRLS`)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
