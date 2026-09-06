#!/usr/bin/env node
/**
 * Runs scripts/db/bootstrap-roles.sql as the platform/admin role (blueprint 22.2).
 *
 *   DATABASE_URL_ADMIN=postgres://…            required (admin/superuser)
 *   APP_OWNER_PASSWORD / APP_USER_PASSWORD / APP_BACKUP_PASSWORD
 *                                              optional; set on create/rotate
 *
 * Passwords are passed as session settings, never interpolated into the SQL
 * file and never logged. The script is idempotent: running it twice changes
 * nothing.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(here, 'bootstrap-roles.sql');

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.error('DATABASE_URL_ADMIN is required (the platform/admin credential).');
  process.exit(1);
}

const passwords = {
  'vaultide.app_owner_password': process.env.APP_OWNER_PASSWORD ?? '',
  'vaultide.app_user_password': process.env.APP_USER_PASSWORD ?? '',
  'vaultide.app_backup_password': process.env.APP_BACKUP_PASSWORD ?? '',
};

const sql = await readFile(sqlPath, 'utf8');
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

client.on('notice', (notice) => {
  if (notice.message) console.log(`  ${notice.message}`);
});

try {
  for (const [setting, value] of Object.entries(passwords)) {
    if (value !== '') await client.query('SELECT set_config($1, $2, false)', [setting, value]);
  }
  await client.query(sql);

  const { rows } = await client.query(
    `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles
      WHERE rolname IN ('app_owner', 'app_user', 'app_backup')
      ORDER BY rolname`,
  );
  console.log('Role bootstrap complete:');
  for (const row of rows) {
    console.log(
      `  ${row.rolname.padEnd(11)} login=${row.rolcanlogin} bypassrls=${row.rolbypassrls} ` +
        `superuser=${row.rolsuper} createdb=${row.rolcreatedb} createrole=${row.rolcreaterole}`,
    );
  }
  if (rows.length !== 3) {
    console.error('Expected three roles after bootstrap.');
    process.exitCode = 1;
  }
} finally {
  // Clear the settings from this session before it returns to any pool.
  for (const setting of Object.keys(passwords)) {
    await client.query('SELECT set_config($1, $2, false)', [setting, '']).catch(() => undefined);
  }
  await client.end();
}
