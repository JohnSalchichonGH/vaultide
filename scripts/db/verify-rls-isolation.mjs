#!/usr/bin/env node
/**
 * Proves row level security still isolates tenants on a live database
 * (blueprint 17.4, M8).
 *
 * The privilege model is checked elsewhere; this asks the sharper question. It
 * connects as **`app_user`** — the credential the running application actually
 * uses, which cannot bypass RLS — and reads the user-owned tables:
 *
 *   1. with no `app.current_user_id` set at all. Every policy resolves the
 *      setting through `NULLIF(current_setting('app.current_user_id', true),
 *      '')::uuid`, so an unset session must see **nothing**. A request that
 *      forgot to establish who it is gets an empty database, not everybody's.
 *   2. with `app.current_user_id` set to a user id that does not exist. Same
 *      answer, for the same reason.
 *
 * It matters that this runs where the data is: an empty result here would be
 * meaningless if the tables were empty, so the run first confirms — through the
 * separate `app_backup` credential, when one is available — that there are rows
 * to be hidden.
 *
 *   DATABASE_URL=…          (required: the app_user runtime credential)
 *   DATABASE_URL_BACKUP=…   (optional: to prove the tables are not simply empty)
 *
 * Read-only. Exits non-zero on any leak.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const runtimeUrl = process.env.DATABASE_URL;
if (!runtimeUrl) {
  console.error('DATABASE_URL is required (the app_user runtime credential).');
  process.exit(1);
}
const backupUrl = process.env.DATABASE_URL_BACKUP;

/** Every table whose rows belong to one person (17.4). */
const TABLES = [
  'positions',
  'position_valuations',
  'cash_accounts',
  'other_assets',
  'user_settings',
  'audit_entries',
  'categories',
  'tags',
];

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const runtime = new pg.Client({ connectionString: runtimeUrl });
await runtime.connect();

try {
  const who = await runtime.query('SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass');
  console.log(`Connected as ${who.rows[0].current_user}\n`);
  check('the runtime role cannot bypass row level security', who.rows[0].bypass === false);

  // Only tables that actually exist, so this survives a phase that has not
  // created all of them yet.
  const present = await runtime.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [TABLES],
  );
  const tables = present.rows.map((row) => row.tablename).sort();
  check('there are user-owned tables to check', tables.length > 0, `${String(tables.length)} tables`);

  if (backupUrl) {
    const backup = new pg.Client({ connectionString: backupUrl });
    await backup.connect();
    let populated = 0;
    for (const table of tables) {
      const { rows } = await backup.query(`SELECT count(*)::int AS count FROM ${table}`);
      if (rows[0].count > 0) populated += 1;
    }
    await backup.end();
    check(
      'the tables hold rows that could leak',
      populated > 0,
      `${String(populated)} of ${String(tables.length)} tables are non-empty`,
    );
  } else {
    console.log('  note  DATABASE_URL_BACKUP not set — cannot prove the tables are non-empty');
  }

  console.log('\nWith no app.current_user_id');
  for (const table of tables) {
    const { rows } = await runtime.query(`SELECT count(*)::int AS count FROM ${table}`);
    check(`${table} is empty to an unidentified session`, rows[0].count === 0, `${String(rows[0].count)} rows`);
  }

  console.log('\nWith app.current_user_id set to a user that does not exist');
  const stranger = randomUUID();
  await runtime.query(`SELECT set_config('app.current_user_id', $1, false)`, [stranger]);
  for (const table of tables) {
    const { rows } = await runtime.query(`SELECT count(*)::int AS count FROM ${table}`);
    check(`${table} is empty to a stranger`, rows[0].count === 0, `${String(rows[0].count)} rows`);
  }
} finally {
  await runtime.end();
}

if (failed > 0) {
  console.error(`\n${String(failed)} check(s) failed.`);
  process.exit(1);
}
console.log('\nRow level security isolates every user-owned table.');
