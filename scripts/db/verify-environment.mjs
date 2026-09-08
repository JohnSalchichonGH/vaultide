#!/usr/bin/env node
/**
 * Asserts that a live environment matches the role and privilege model
 * (blueprint 6.1, 17.4, 22.2). CI proves the behaviour on a throwaway database;
 * this proves the state of a real one — Neon, or any other deployment.
 *
 *   DATABASE_URL_DIRECT_OWNER=…  (required: reads the catalogs as app_owner)
 *   DATABASE_URL_BACKUP=…        (optional: also exercises the backup role)
 *
 * Read-only apart from one deliberate write attempt as app_backup, which must
 * fail. Prints a check list and exits non-zero on the first violation.
 */
import pg from 'pg';

// Either credential can read the catalogs; whichever is present is used for
// the state checks. The backup credential additionally proves it cannot write.
const backupUrl = process.env.DATABASE_URL_BACKUP;
const ownerUrl = process.env.DATABASE_URL_DIRECT_OWNER ?? backupUrl;
if (!ownerUrl) {
  console.error('Set DATABASE_URL_DIRECT_OWNER or DATABASE_URL_BACKUP.');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();

try {
  const version = await owner.query('SHOW server_version');
  console.log(`PostgreSQL ${version.rows[0].server_version}`);
  console.log('');

  console.log('Roles');
  const roles = await owner.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname IN ('app_owner','app_user','app_backup') ORDER BY rolname`,
  );
  const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));

  check('all three application roles exist', roles.rows.length === 3, `found ${roles.rows.length}`);
  for (const role of ['app_owner', 'app_user', 'app_backup']) {
    check(`${role} is not a superuser`, byName[role]?.rolsuper === false);
    check(`${role} cannot create roles or databases`,
      byName[role]?.rolcreaterole === false && byName[role]?.rolcreatedb === false);
  }
  // The property the whole tenant-isolation model rests on (17.4, R27).
  check('app_user cannot bypass row level security', byName['app_user']?.rolbypassrls === false);
  check('app_owner cannot bypass row level security', byName['app_owner']?.rolbypassrls === false);
  check('app_backup can bypass row level security', byName['app_backup']?.rolbypassrls === true);

  console.log('');
  console.log('Schema and migrations');
  const schema = await owner.query(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
  );
  check('app_owner owns the public schema', schema.rows[0]?.owner === 'app_owner',
    `owner is ${schema.rows[0]?.owner}`);

  const applied = await owner.query(`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
  check('migrations have been applied', applied.rows[0].count >= 2, `${applied.rows[0].count} applied`);

  const currencies = await owner.query(`SELECT count(*)::int AS count FROM currencies`);
  check('currencies are seeded', currencies.rows[0].count > 50, `${currencies.rows[0].count} rows`);

  const clf = await owner.query(`SELECT minor_units FROM currencies WHERE code = 'CLF'`);
  check('a four-minor-unit currency is present', clf.rows[0]?.minor_units === 4);

  const crypto = await owner.query(
    `SELECT count(*)::int AS count FROM currencies WHERE code IN ('BTC','ETH','USDT')`,
  );
  check('no crypto codes were seeded', crypto.rows[0].count === 0);

  console.log('');
  console.log('Privileges');
  // `has_table_privilege` reports the *effective* privilege of any role and can
  // be asked by any caller, unlike information_schema.role_table_grants, which
  // only shows grants involving roles the caller belongs to.
  const tables = await owner.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  check('the schema has tables to check', tables.rows.length > 0, `${tables.rows.length} tables`);

  const WRITES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

  /**
   * Tables the runtime role holds narrower privileges on than the bootstrap's
   * default grants would give (blueprint 6.1). Each entry lists the writes
   * `app_user` must **not** have; they are removed by a migration, so this is
   * also how a deployment proves that migration actually ran.
   *
   *   fx_rates       rows are immutable — a conversion made last year must
   *                  still reproduce next year (6.2, Phase 1).
   *   audit_entries  insert-only — the role that deletes a valuation must not
   *                  be able to erase the record of it (18.1, Phase 2).
   */
  const RUNTIME_WRITE_EXCEPTIONS = {
    fx_rates: ['UPDATE', 'DELETE', 'TRUNCATE'],
    audit_entries: ['UPDATE', 'DELETE', 'TRUNCATE'],
  };

  const violations = { userWrite: [], backupWrite: [], backupRead: [], narrowed: [] };
  const seenNarrowed = new Set();

  for (const { tablename } of tables.rows) {
    const qualified = `public.${tablename}`;
    const privileges = await owner.query(
      `SELECT
         has_table_privilege('app_user', $1, 'SELECT')   AS user_select,
         has_table_privilege('app_backup', $1, 'SELECT') AS backup_select,
         ${WRITES.map((p) => `has_table_privilege('app_user', $1, '${p}') AS user_${p.toLowerCase()}`).join(', ')},
         ${WRITES.map((p) => `has_table_privilege('app_backup', $1, '${p}') AS backup_${p.toLowerCase()}`).join(', ')}`,
      [qualified],
    );
    const row = privileges.rows[0];

    // Reference data is read-only for the runtime role (6.1); user tables are
    // writable by it and arrive with their phases.
    if (tablename === 'currencies') {
      check('app_user can read reference data', row.user_select === true);
      for (const privilege of WRITES) {
        if (row[`user_${privilege.toLowerCase()}`]) violations.userWrite.push(`${tablename}.${privilege}`);
      }
    }

    const forbidden = RUNTIME_WRITE_EXCEPTIONS[tablename];
    if (forbidden !== undefined) {
      seenNarrowed.add(tablename);
      if (!row.user_select) violations.narrowed.push(`${tablename}.SELECT missing`);
      for (const privilege of forbidden) {
        if (row[`user_${privilege.toLowerCase()}`]) {
          violations.narrowed.push(`${tablename}.${privilege}`);
        }
      }
    }

    // A backup must be able to read everything and change nothing (R27, T12).
    if (!row.backup_select) violations.backupRead.push(tablename);
    for (const privilege of WRITES) {
      if (row[`backup_${privilege.toLowerCase()}`]) {
        violations.backupWrite.push(`${tablename}.${privilege}`);
      }
    }
  }

  check('app_user cannot write reference data', violations.userWrite.length === 0,
    violations.userWrite.join(', '));
  check(
    'app_user holds only the narrowed privileges on immutable tables',
    violations.narrowed.length === 0,
    violations.narrowed.join(', '),
  );
  // A missing table here means a migration has not run, which the privilege
  // check above could not have noticed on its own.
  const missingNarrowed = Object.keys(RUNTIME_WRITE_EXCEPTIONS).filter(
    (table) => !seenNarrowed.has(table),
  );
  check('every table with narrowed privileges exists', missingNarrowed.length === 0,
    missingNarrowed.join(', '));
  check('app_backup can read every table', violations.backupRead.length === 0,
    violations.backupRead.join(', '));
  check('app_backup can write no table', violations.backupWrite.length === 0,
    violations.backupWrite.join(', '));

  if (backupUrl) {
    console.log('');
    console.log('Backup role, live');
    const backup = new pg.Client({ connectionString: backupUrl });
    await backup.connect();
    try {
      const readable = await backup.query('SELECT count(*)::int AS count FROM currencies');
      check('app_backup can read', readable.rows[0].count > 50);

      let refused = false;
      try {
        await backup.query(`INSERT INTO currencies (code, name, minor_units) VALUES ('ZZZ','probe',2)`);
      } catch (error) {
        refused = error.code === '42501';
      }
      check('app_backup cannot write', refused);
    } finally {
      await backup.end();
    }
  }
} finally {
  await owner.end();
}

const failed = results.filter((row) => !row.ok);
console.log('');
if (failed.length > 0) {
  console.error(`${failed.length} of ${results.length} checks failed.`);
  process.exit(1);
}
console.log(`All ${results.length} checks passed.`);
