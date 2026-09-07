import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  provisionDatabase,
  repoRoot,
  type ProvisionedDatabase,
} from '../../src/testing/provision';
import { RLS_USER_PREDICATE } from '../../src/schema/rls';
 
import { runPgTool } from '../../../../scripts/lib/pg-tools.mjs';

/**
 * The backup workflow (blueprint 22.5, R27, T12; Phase 0 acceptance):
 * a dump taken as `app_backup` is complete across tenants, is verified against
 * live row counts, and is stored encrypted with `age`.
 *
 * The negative case matters as much as the positive one: a dump taken with an
 * RLS-subject role must fail verification rather than be stored as a useless
 * archive.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let db: ProvisionedDatabase;
let owner: pg.Client;
let outputDir: string;
let recipient: string;
let identity: string;

function runBackup(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [path.join('scripts', 'backup', 'backup.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(async () => {
  db = await provisionDatabase();
  owner = await connect(db.ownerUrl);

  // Two tenants' rows behind RLS, so "complete dump" means something.
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
    GRANT SELECT ON rls_probe TO app_backup;
  `);
  await owner.query(`INSERT INTO rls_probe (user_id, note) VALUES ($1,'A-1'), ($2,'B-1')`, [
    USER_A,
    USER_B,
  ]);

  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultide-backup-'));
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  if (db) await dropDatabase(adminUrl(), db.databaseName);
  if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('nightly backup as app_backup', () => {
  it('produces a verified, encrypted, complete dump', async () => {
    const output = runBackup({
      DATABASE_URL_BACKUP: db.backupUrl,
      BACKUP_AGE_PUBLIC_KEY: recipient,
      BACKUP_OUTPUT_DIR: outputDir,
      BACKUP_LABEL: 'test',
    });

    expect(output).toContain('Dump verified');
    expect(output).toContain('Encrypted archive ready');

    const archives = fs.readdirSync(outputDir).filter((name) => name.endsWith('.dump.age'));
    expect(archives).toHaveLength(1);
    const archivePath = path.join(outputDir, archives[0] as string);

    // The plaintext dump is not left behind.
    expect(fs.readdirSync(outputDir).some((name) => name.endsWith('.dump'))).toBe(false);

    // It is a real age archive…
    const ciphertext = new Uint8Array(fs.readFileSync(archivePath));
    expect(Buffer.from(ciphertext.slice(0, 21)).toString('utf8')).toBe('age-encryption.org/v1');

    // …that decrypts back to the original custom-format PostgreSQL dump.
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await decrypter.decrypt(ciphertext);
    expect(Buffer.from(plaintext.slice(0, 5)).toString('utf8')).toBe('PGDMP');

    // The manifest proves both tenants' rows were captured.
    const manifestFile = fs
      .readdirSync(outputDir)
      .find((name) => name.endsWith('.manifest.json')) as string;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, manifestFile), 'utf8'),
    ) as { tables: { table: string; live: number; dump: number; ok: boolean }[] };

    const probe = manifest.tables.find((row) => row.table === 'rls_probe');
    expect(probe).toEqual({ table: 'rls_probe', live: 2, dump: 2, ok: true });
    expect(manifest.tables.every((row) => row.ok)).toBe(true);

    const currencies = manifest.tables.find((row) => row.table === 'currencies');
    expect(currencies?.live).toBeGreaterThan(50);
    expect(currencies?.dump).toBe(currencies?.live);

    // The summary records what was stored.
    const summary = JSON.parse(fs.readFileSync(`${archivePath}.json`, 'utf8')) as {
      verified: boolean;
      sha256: string;
      recipient: string;
    };
    expect(summary.verified).toBe(true);
    expect(summary.recipient).toBe(recipient);
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }, 180_000);

  it('cannot even be taken with an RLS-subject role without forcing it', () => {
    // pg_dump refuses outright when a policy would filter the rows it is
    // copying, so a backup taken with the runtime credential fails loudly.
    expect(() =>
      runPgTool('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--schema=public',
        '--file',
        path.join(outputDir, 'refused.dump'),
        db.userUrl,
      ]),
    ).toThrow(/row-level security/iu);
  }, 180_000);

  it('refuses a forced RLS-filtered dump (T12: never a silently empty backup)', () => {
    // With --enable-row-security the dump succeeds but, since app_user is
    // NOBYPASSRLS and carries no user context, it contains none of the tenant
    // rows. Verification against the live database must reject it rather than
    // let a useless archive be stored.
    const rlsSubjectDump = path.join(outputDir, 'rls-subject.dump');
    runPgTool('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--enable-row-security',
      '--file',
      rlsSubjectDump,
      db.userUrl,
    ]);
    expect(fs.existsSync(rlsSubjectDump)).toBe(true);

    let stdout = '';
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [path.join('scripts', 'backup', 'verify-dump.mjs'), rlsSubjectDump],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL_BACKUP: db.backupUrl },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      failed = true;
      const failure = error as { stdout?: string; stderr?: string };
      stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    expect(failed, 'a dump taken without BYPASSRLS must not verify').toBe(true);
    // The tenant table is the one that comes back empty.
    expect(stdout).toMatch(/FAIL rls_probe\s+live=\s*2 dump=\s*0/u);
  }, 180_000);
});
