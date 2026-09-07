import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  runBootstrap,
  type ProvisionedDatabase,
} from '../../src/testing/provision';

/**
 * Phase 0 acceptance, operational half (blueprint Phase 0, 21.3, 22.2):
 *
 *  - a fresh PostgreSQL database is provisioned from zero:
 *    admin bootstrap → migrations as `app_owner` → role assertions;
 *  - re-running the bootstrap is a no-op;
 *  - `app_user` can neither run DDL nor bypass RLS;
 *  - `app_backup` reads every row of every table and can write nothing.
 */

const INSUFFICIENT_PRIVILEGE = '42501';

let db: ProvisionedDatabase;
let owner: pg.Client;
let user: pg.Client;
let backup: pg.Client;

/** A privilege snapshot that ignores salted password hashes. */
async function privilegeSnapshot(client: pg.Client): Promise<string> {
  const roles = await client.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
            rolreplication, rolbypassrls, rolconnlimit
       FROM pg_roles
      WHERE rolname IN ('app_owner', 'app_user', 'app_backup')
      ORDER BY rolname`,
  );
  const grants = await client.query(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee IN ('app_owner', 'app_user', 'app_backup')
      ORDER BY grantee, table_name, privilege_type`,
  );
  const defaults = await client.query(
    `SELECT defaclnamespace::regnamespace::text AS schema, defaclobjtype,
            pg_catalog.array_to_string(defaclacl, chr(10)) AS acl
       FROM pg_default_acl
      ORDER BY 1, 2, 3`,
  );
  const schemaOwner = await client.query(
    `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
  );
  return JSON.stringify({
    roles: roles.rows,
    grants: grants.rows,
    defaults: defaults.rows,
    schemaOwner: schemaOwner.rows,
  });
}

beforeAll(async () => {
  db = await provisionDatabase();
  owner = await connect(db.ownerUrl);
  user = await connect(db.userUrl);
  backup = await connect(db.backupUrl);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), user?.end(), backup?.end()]);
  if (db) await dropDatabase(adminUrl(), db.databaseName);
});

describe('fresh database provisioning (bootstrap → migrate → assertions)', () => {
  it('creates the three roles with the attributes the blueprint requires', async () => {
    const { rows } = await owner.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
         FROM pg_roles WHERE rolname LIKE 'app\\_%' ORDER BY rolname`,
    );

    expect(rows.map((row) => row.rolname)).toEqual(['app_backup', 'app_owner', 'app_user']);
    const byName = Object.fromEntries(rows.map((row) => [row.rolname, row]));

    for (const role of ['app_owner', 'app_user', 'app_backup']) {
      expect(byName[role]?.rolcanlogin, `${role} can log in`).toBe(true);
      expect(byName[role]?.rolsuper, `${role} is not a superuser`).toBe(false);
      expect(byName[role]?.rolcreatedb, `${role} cannot create databases`).toBe(false);
      expect(byName[role]?.rolcreaterole, `${role} cannot create roles`).toBe(false);
    }

    // The runtime role can never bypass RLS; the backup role must (17.4, R27).
    expect(byName['app_user']?.rolbypassrls).toBe(false);
    expect(byName['app_owner']?.rolbypassrls).toBe(false);
    expect(byName['app_backup']?.rolbypassrls).toBe(true);
  });

  it('leaves app_owner owning the schema and the migrated tables', async () => {
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
    );
    expect(rows[0]?.owner).toBe('app_owner');

    const tables = await owner.query<{ tableowner: string; tablename: string }>(
      `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    for (const table of tables.rows) {
      expect(table.tableowner, `${table.tablename} is owned by app_owner`).toBe('app_owner');
    }
  });

  it('applied the migrations and recorded them', async () => {
    const applied = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(applied.rows[0]?.count)).toBeGreaterThanOrEqual(2);

    const currencies = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM currencies`,
    );
    expect(Number(currencies.rows[0]?.count)).toBeGreaterThan(50);
  });

  it('is idempotent: running the bootstrap again changes nothing', async () => {
    const before = await privilegeSnapshot(owner);
    const output = runBootstrap(db.adminUrl);
    const after = await privilegeSnapshot(owner);

    expect(after).toBe(before);
    // A second run creates nothing.
    expect(output).not.toContain('created role');

    // And the credentials still work afterwards.
    const stillWorks = await connect(db.userUrl);
    await stillWorks.query('SELECT 1');
    await stillWorks.end();
  }, 60_000);
});

describe('app_user cannot perform DDL or bypass RLS', () => {
  it('is refused every form of DDL', async () => {
    expect(await errorCodeOf(user, 'CREATE TABLE ddl_probe (id int)')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(user, 'CREATE SCHEMA ddl_probe')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(user, 'ALTER TABLE currencies ADD COLUMN probe int')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(user, 'DROP TABLE currencies')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(user, 'CREATE INDEX ddl_probe ON currencies (code)')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot grant itself anything or become another role', async () => {
    expect(await errorCodeOf(user, 'ALTER ROLE app_user WITH BYPASSRLS')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(user, 'SET ROLE app_owner')).toBe('42501');
    expect(await errorCodeOf(user, 'CREATE ROLE intruder LOGIN')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('may read reference data but never write it', async () => {
    const readable = await user.query<{ code: string }>(
      `SELECT code FROM currencies WHERE code = 'EUR'`,
    );
    expect(readable.rows[0]?.code).toBe('EUR');

    expect(
      await errorCodeOf(user, `INSERT INTO currencies (code, name, minor_units) VALUES ($1,$2,$3)`, [
        'XXX',
        'Fake',
        2,
      ]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(user, `UPDATE currencies SET name = 'x' WHERE code = 'EUR'`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(user, `DELETE FROM currencies WHERE code = 'EUR'`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('app_backup reads everything and writes nothing', () => {
  it('can read every table in the schema', async () => {
    const tables = await owner.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables.rows.length).toBeGreaterThan(0);

    for (const { tablename } of tables.rows) {
      const result = await errorCodeOf(backup, `SELECT count(*) FROM "${tablename}"`);
      expect(result, `app_backup can read ${tablename}`).toBeNull();
    }
  });

  it('is refused every write', async () => {
    expect(
      await errorCodeOf(
        backup,
        `INSERT INTO currencies (code, name, minor_units) VALUES ('XXX','Fake',2)`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(backup, `UPDATE currencies SET name = 'x'`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCodeOf(backup, `DELETE FROM currencies`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(backup, `TRUNCATE currencies`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCodeOf(backup, `CREATE TABLE backup_probe (id int)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
