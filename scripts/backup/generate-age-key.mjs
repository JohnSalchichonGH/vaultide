#!/usr/bin/env node
/**
 * Generates the age key pair that protects the nightly backups (blueprint 22.5).
 *
 *   node scripts/backup/generate-age-key.mjs [output-path]
 *
 * The **private** key is written to a file with owner-only permissions and is
 * never printed: move it to your password manager or sealed store, then delete
 * the file. Only the recipient (public key) is printed — that is the value CI
 * needs, and it can encrypt but never decrypt.
 *
 * Rotation is documented in docs/ops/secrets.md: keep the old private key until
 * every archive encrypted to it has aged out of retention.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity, identityToRecipient } from 'age-encryption';

const outputPath = path.resolve(
  process.argv[2] ?? path.join(os.homedir(), '.vaultide', 'age-backup-key.txt'),
);

if (fs.existsSync(outputPath)) {
  console.error(
    `${outputPath} already exists. Refusing to overwrite a key that may still be\n` +
      'needed to decrypt existing archives. Pass a different path to generate another.',
  );
  process.exit(1);
}

const identity = await generateIdentity();
const recipient = await identityToRecipient(identity);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `# Vaultide backup identity — created ${new Date().toISOString()}\n` +
    `# Public recipient: ${recipient}\n` +
    `# KEEP OFFLINE. This is the only thing that can decrypt a Vaultide backup.\n` +
    `${identity}\n`,
  { mode: 0o600 },
);

console.log('Private key written to:');
console.log(`  ${outputPath}`);
console.log('');
console.log('Move it to your password manager or sealed store, then delete the file.');
console.log('Without it, no backup can ever be restored; with it, anyone can read one.');
console.log('');
console.log('Public recipient (this is what CI needs, as BACKUP_AGE_PUBLIC_KEY):');
console.log(`  ${recipient}`);
