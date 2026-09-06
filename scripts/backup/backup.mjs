#!/usr/bin/env node
/**
 * Nightly encrypted backup (blueprint 22.5, R27, T12).
 *
 *   1. `pg_dump -Fc` over the direct endpoint as **app_backup**, which is
 *      SELECT-only and `BYPASSRLS` so the dump is complete;
 *   2. verification: per-table row counts in the dump must equal the live
 *      counts, so an RLS-empty dump can never pass silently;
 *   3. encryption with `age` to a public recipient key — the private key stays
 *      offline and is never present in CI;
 *   4. upload to the EU object store (the workflow's own step).
 *
 *   DATABASE_URL_BACKUP=…            required
 *   BACKUP_AGE_PUBLIC_KEY=age1…      required (recipient; encryption only)
 *   BACKUP_OUTPUT_DIR=./backups      optional
 *   BACKUP_LABEL=production          optional, used in the file name
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Encrypter } from 'age-encryption';
import { runPgTool } from '../lib/pg-tools.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const connectionString = process.env.DATABASE_URL_BACKUP;
if (!connectionString) {
  console.error('DATABASE_URL_BACKUP is required (the SELECT-only backup credential).');
  process.exit(1);
}
const recipient = process.env.BACKUP_AGE_PUBLIC_KEY;
if (!recipient) {
  console.error('BACKUP_AGE_PUBLIC_KEY is required (the age recipient public key).');
  process.exit(1);
}

const outputDir = path.resolve(process.env.BACKUP_OUTPUT_DIR ?? path.join(repoRoot, 'backups'));
fs.mkdirSync(outputDir, { recursive: true });

const label = process.env.BACKUP_LABEL ?? 'local';
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const dumpFile = path.join(outputDir, `vaultide-${label}-${stamp}.dump`);
const encryptedFile = `${dumpFile}.age`;

console.log(`1/4 Dumping as app_backup → ${path.basename(dumpFile)}`);
runPgTool('pg_dump', [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--file',
  dumpFile,
  connectionString,
]);
const dumpSize = fs.statSync(dumpFile).size;
console.log(`    ${String(dumpSize)} bytes`);

let ciphertext;
let digest;
try {
  console.log('2/4 Verifying row counts against the live database');
  execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'backup', 'verify-dump.mjs'), dumpFile],
    { stdio: 'inherit', env: process.env },
  );

  console.log('3/4 Encrypting with age');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  ciphertext = await encrypter.encrypt(new Uint8Array(fs.readFileSync(dumpFile)));
  fs.writeFileSync(encryptedFile, ciphertext);

  digest = createHash('sha256').update(ciphertext).digest('hex');
  const header = Buffer.from(ciphertext.slice(0, 21)).toString('utf8');
  if (header !== 'age-encryption.org/v1') {
    throw new Error('Encryption did not produce an age archive.');
  }
} finally {
  // A plaintext dump never survives the job, successful or not.
  fs.rmSync(dumpFile, { force: true });
}

console.log('4/4 Encrypted archive ready');
console.log(`    file   ${encryptedFile}`);
console.log(`    bytes  ${String(ciphertext.length)}`);
console.log(`    sha256 ${digest}`);

const summaryPath = `${encryptedFile}.json`;
fs.writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      label,
      createdAt: new Date().toISOString(),
      encryptedFile: path.basename(encryptedFile),
      plaintextBytes: dumpSize,
      encryptedBytes: ciphertext.length,
      sha256: digest,
      recipient,
      verified: true,
    },
    null,
    2,
  )}\n`,
);
console.log(`    summary ${summaryPath}`);
