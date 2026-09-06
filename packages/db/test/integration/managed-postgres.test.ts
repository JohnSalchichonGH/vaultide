import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  runBootstrap,
  runMigrations,
  urlFor,
  type RolePasswords,
} from '../helpers/provision';

/**
 * The bootstrap under a **managed** PostgreSQL (blueprint 22.2).
 *
 * Neon, RDS and every other managed platform hand you an administrator that is
 * emphatically *not* a superuser: it has CREATEROLE and BYPASSRLS, and nothing
 * more. That difference is not cosmetic — PostgreSQL refuses `ALTER ROLE …
 * NOSUPERUSER` from a non-superuser even when the attribute already has that
 * value, because naming the attribute counts as changing it.
 *
 * Both the local cluster and CI's service container connect as a superuser, so
 * neither would ever catch that. This suite creates a deliberately
 * Neon-shaped administrator and provisions through it.
 */

const suffix = randomBytes(4).toString('hex');
const MANAGED_ADMIN = `managed_admin_${suffix}`;
const DATABASE = `vaultide_managed_${suffix}`;

const passwords: RolePasswords = {
  appOwner: randomBytes(12).toString('base64url'),
  appUser: randomBytes(12).toString('base64url'),
  appBackup: randomBytes(12).toString('base64url'),
};
const managedAdminPassword = randomBytes(12).toString('base64url');

let superuser: pg.Client;
let managedAdminDbUrl: string;
let ownerUrl: string;

beforeAll(async () => {
  superuser = await connect(adminUrl());

  // Exactly the shape Neon's project owner has: CREATEROLE and BYPASSRLS so it
  // can create the roles, but no SUPERUSER.
  await superuser.query(
    `CREATE ROLE "${MANAGED_ADMIN}" WITH LOGIN CREATEDB CREATEROLE BYPASSRLS NOSUPERUSER PASSWORD '${managedAdminPassword}'`,
  );
  await superuser.query(`CREATE DATABASE "${DATABASE}" OWNER "${MANAGED_ADMIN}"`);

  // On Neon the administrator creates the application roles itself and so holds
  // ADMIN on them. Here the roles already exist from the other suites, created
  // by the superuser, so the grant reproduces that same state rather than
  // testing a situation the real platform never presents.
  await superuser.query(`
    DO $$
    DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY ARRAY['app_owner', 'app_user', 'app_backup'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('GRANT %I TO %I WITH ADMIN OPTION', r, '${MANAGED_ADMIN}');
        END IF;
      END LOOP;
    END $$;
  `);

  managedAdminDbUrl = urlFor(adminUrl(), {
    user: MANAGED_ADMIN,
    password: managedAdminPassword,
    database: DATABASE,
  });
  ownerUrl = urlFor(adminUrl(), {
    user: 'app_owner',
    password: passwords.appOwner,
    database: DATABASE,
  });
}, 120_000);

afterAll(async () => {
  if (!superuser) return;
  await superuser.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [DATABASE],
  );
  await superuser.query(`DROP DATABASE IF EXISTS "${DATABASE}"`);
  // The app_* roles are cluster-wide and shared with the other suites; only the
  // administrator this suite invented is dropped.
  await superuser.query(`DROP ROLE IF EXISTS "${MANAGED_ADMIN}"`);
  await superuser.end();
});

describe('bootstrap under a non-superuser administrator', () => {
  it('provisions the database without ever needing SUPERUSER', () => {
    // The whole point: this must not raise "permission denied to alter role".
    expect(() => runBootstrap(managedAdminDbUrl, passwords)).not.toThrow();
  }, 120_000);

  it('is still idempotent when re-run by that administrator', () => {
    expect(() => runBootstrap(managedAdminDbUrl)).not.toThrow();
    expect(() => runBootstrap(managedAdminDbUrl, passwords)).not.toThrow();
  }, 120_000);

  it('produces roles with the attributes the security model depends on', async () => {
    const { rows } = await superuser.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
         FROM pg_roles WHERE rolname IN ('app_owner','app_user','app_backup') ORDER BY rolname`,
    );
    const byName = Object.fromEntries(rows.map((row) => [row.rolname, row]));

    for (const role of ['app_owner', 'app_user', 'app_backup']) {
      expect(byName[role]?.rolsuper, `${role} must never be a superuser`).toBe(false);
      expect(byName[role]?.rolcreaterole, `${role} must not create roles`).toBe(false);
    }
    expect(byName['app_user']?.rolbypassrls).toBe(false);
    expect(byName['app_owner']?.rolbypassrls).toBe(false);
    // Created by a non-superuser administrator that holds BYPASSRLS itself.
    expect(byName['app_backup']?.rolbypassrls).toBe(true);
  });

  it('leaves app_owner owning the schema, so migrations can run', async () => {
    expect(() => runMigrations(ownerUrl)).not.toThrow();

    const owner = await connect(ownerUrl);
    try {
      const { rows } = await owner.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
      );
      expect(rows[0]?.owner).toBe('app_owner');

      const tables = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'`,
      );
      expect(Number(tables.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await owner.end();
    }
  }, 120_000);

  it('refuses to finish if app_backup ever loses BYPASSRLS', async () => {
    // The verification block is the last line of defence against a platform
    // that silently declines the attribute (T12).
    await superuser.query('ALTER ROLE app_backup WITH NOBYPASSRLS');
    try {
      expect(() => runBootstrap(managedAdminDbUrl)).toThrow(/BYPASSRLS/u);
    } finally {
      await superuser.query('ALTER ROLE app_backup WITH BYPASSRLS');
    }
  }, 120_000);
});
