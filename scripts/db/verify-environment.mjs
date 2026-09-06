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
  // Reference data is read-only for the runtime role (6.1).
  const writes = await owner.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'app_user' AND table_name = 'currencies'
        AND privilege_type IN ('INSERT','UPDATE','DELETE')`,
  );
  check('app_user cannot write reference data', writes.rowCount === 0,
    writes.rows.map((row) => row.privilege_type).join(', '));

  const reads = await owner.query(
    `SELECT 1 FROM information_schema.role_table_grants
      WHERE grantee = 'app_user' AND table_name = 'currencies' AND privilege_type = 'SELECT'`,
  );
  check('app_user can read reference data', reads.rowCount === 1);

  const backupWrites = await owner.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'app_backup' AND privilege_type <> 'SELECT'`,
  );
  check('app_backup holds no privilege beyond SELECT', backupWrites.rowCount === 0,
    backupWrites.rows.map((row) => row.privilege_type).join(', '));

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
