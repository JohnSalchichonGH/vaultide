#!/usr/bin/env node
/**
 * Verifies a `pg_dump -Fc` archive against the live database (blueprint 22.5).
 *
 * Row counts read from the dump are compared with `SELECT count(*)` executed as
 * `app_backup`. This is the check that makes an RLS-empty dump impossible to
 * miss: if the backup role ever lost `BYPASSRLS`, every user table would come
 * back empty here and the job would fail instead of quietly storing a useless
 * archive.
 *
 *   DATABASE_URL_BACKUP=…  node scripts/backup/verify-dump.mjs <dump-file>
 *
 * Exits non-zero on any mismatch. Prints a manifest of table row counts.
 */
import fs from 'node:fs';
import pg from 'pg';
import { runPgTool } from '../lib/pg-tools.mjs';

const dumpFile = process.argv[2];
if (!dumpFile || !fs.existsSync(dumpFile)) {
  console.error('Usage: node scripts/backup/verify-dump.mjs <dump-file>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_BACKUP;
if (!connectionString) {
  console.error('DATABASE_URL_BACKUP is required (the SELECT-only backup credential).');
  process.exit(1);
}

/**
 * Row counts per table, read from the archive's COPY blocks in one pass.
 * Restoring to stdout keeps this read-only: nothing is written anywhere.
 */
function rowCountsInDump() {
  const sql = runPgTool('pg_restore', ['--data-only', '--no-owner', '-f', '-', dumpFile]);

  const counts = new Map();
  let current = null;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (current === null) {
      const copy = /^COPY (?:"?public"?\.)?"?([^". (]+)"?\s*\(/u.exec(line);
      if (copy && line.includes('FROM stdin;')) {
        current = copy[1];
        if (!counts.has(current)) counts.set(current, 0);
      }
      continue;
    }
    if (line === '\\.') {
      current = null;
      continue;
    }
    if (line !== '') counts.set(current, counts.get(current) + 1);
  }
  return counts;
}

const client = new pg.Client({ connectionString });
await client.connect();

let failures = 0;
const manifest = [];

try {
  const { rows: tables } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );

  if (tables.length === 0) {
    console.error('No tables found in schema public — refusing to verify an empty schema.');
    process.exit(1);
  }

  const dumpCounts = rowCountsInDump();

  for (const { tablename } of tables) {
    const live = await client.query(`SELECT count(*)::int AS count FROM "${tablename}"`);
    const liveCount = live.rows[0].count;
    const dumpCount = dumpCounts.get(tablename) ?? 0;
    const ok = liveCount === dumpCount;

    manifest.push({ table: tablename, live: liveCount, dump: dumpCount, ok });
    if (!ok) failures += 1;

    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${tablename.padEnd(28)} live=${String(liveCount).padStart(7)} dump=${String(dumpCount).padStart(7)}`,
    );
  }

  const totalLive = manifest.reduce((sum, row) => sum + row.live, 0);
  if (totalLive === 0) {
    console.error(
      'Every table is empty. A backup of an empty database is never accepted as verified.',
    );
    failures += 1;
  }

  const manifestPath = `${dumpFile}.manifest.json`;
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ dumpFile, verifiedAt: new Date().toISOString(), tables: manifest }, null, 2)}\n`,
  );
  console.log(`Manifest written to ${manifestPath}`);
} finally {
  await client.end();
}

if (failures > 0) {
  console.error(`Dump verification failed for ${String(failures)} table(s).`);
  process.exit(1);
}
console.log('Dump verified: every table row count matches the live database.');
