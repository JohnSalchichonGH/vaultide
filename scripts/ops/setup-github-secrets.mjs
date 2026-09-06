#!/usr/bin/env node
/**
 * Composes the Vaultide role credentials and loads them into the right GitHub
 * environments (blueprint 22.2: each credential exists in exactly one place).
 *
 *   DATABASE_URL_ADMIN='postgresql://…neon.tech/neondb?sslmode=require' \
 *     node scripts/ops/setup-github-secrets.mjs
 *
 * What it does:
 *   1. generates a strong password for app_owner, app_user and app_backup;
 *   2. derives the direct and pooled endpoints from the Neon admin URL;
 *   3. writes each secret straight into its GitHub environment through
 *      `gh secret set` on stdin — no value is ever printed, echoed, or placed
 *      on a command line;
 *   4. writes the one value a human must paste elsewhere (the runtime
 *      DATABASE_URL for Vercel) into .secrets.local/, which is gitignored.
 *
 * Re-running rotates the passwords: run the bootstrap workflow with
 * `rotate_passwords = true` afterwards, or the roles keep their old ones.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Read a value from the environment, or from a gitignored file. The file form
 * exists so a connection string can be pasted once into an editor instead of
 * travelling through a shell history or a chat message.
 */
function readValue({ env, file, description }) {
  const fromEnv = process.env[env];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();

  const filePath = path.join(repoRoot, '.secrets.local', file);
  if (fs.existsSync(filePath)) {
    const value = fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'));
    if (value !== undefined) return value;
  }

  console.error(`Missing ${env} — ${description}`);
  console.error('');
  console.error('Provide it either way:');
  console.error(`  • environment:  export ${env}='…'   (PowerShell: $env:${env}='…')`);
  console.error(`  • or a file:    .secrets.local/${file}   (gitignored)`);
  process.exit(1);
}

const adminUrl = readValue({
  env: 'DATABASE_URL_ADMIN',
  file: 'neon-admin-url.txt',
  description: "the Neon connection string for the project's owner role.",
});

const recipient = readValue({
  env: 'BACKUP_AGE_PUBLIC_KEY',
  file: 'age-recipient.txt',
  description: 'the age recipient printed by scripts/backup/generate-age-key.mjs.',
});

// Fail early and clearly if the GitHub CLI cannot act on this repository.
try {
  execFileSync('gh', ['auth', 'status'], { cwd: repoRoot, stdio: 'ignore' });
} catch {
  console.error('The GitHub CLI is not authenticated in this shell. Run: gh auth login');
  process.exit(1);
}

const password = () => randomBytes(24).toString('base64url');

/** Neon exposes a pooled endpoint as `<endpoint>-pooler.<region>…`. */
function endpoints(url) {
  const parsed = new URL(url);
  const directHost = parsed.host.replace('-pooler.', '.');
  const pooledHost = directHost.replace(/^([^.]+)\./u, '$1-pooler.');
  return { directHost, pooledHost };
}

function urlFor({ user, pass, host, template }) {
  const parsed = new URL(template);
  parsed.username = user;
  parsed.password = pass;
  parsed.host = host;
  return parsed.toString();
}

const { directHost, pooledHost } = endpoints(adminUrl);

const passwords = {
  appOwner: password(),
  appUser: password(),
  appBackup: password(),
};

const secrets = {
  // Only the manual bootstrap workflow may see the admin credential.
  bootstrap: {
    DATABASE_URL_ADMIN: adminUrl,
    APP_OWNER_PASSWORD: passwords.appOwner,
    APP_USER_PASSWORD: passwords.appUser,
    APP_BACKUP_PASSWORD: passwords.appBackup,
  },
  // Migrations only, over the direct (unpooled) endpoint.
  production: {
    DATABASE_URL_DIRECT_OWNER: urlFor({
      user: 'app_owner',
      pass: passwords.appOwner,
      host: directHost,
      template: adminUrl,
    }),
  },
  // Backups only: SELECT-only, BYPASSRLS, direct endpoint.
  backup: {
    DATABASE_URL_BACKUP: urlFor({
      user: 'app_backup',
      pass: passwords.appBackup,
      host: directHost,
      template: adminUrl,
    }),
    BACKUP_AGE_PUBLIC_KEY: recipient,
  },
};

for (const [environment, entries] of Object.entries(secrets)) {
  for (const [name, value] of Object.entries(entries)) {
    execFileSync('gh', ['secret', 'set', name, '--env', environment], {
      cwd: repoRoot,
      input: value,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log(`set ${environment}/${name}`);
  }
}

// The runtime credential belongs in Vercel, not in GitHub. Write it where a
// human can copy it once, rather than printing it into a terminal history.
const runtimeUrl = urlFor({
  user: 'app_user',
  pass: passwords.appUser,
  host: pooledHost,
  template: adminUrl,
});

const outDir = path.join(repoRoot, '.secrets.local');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'vercel-env.txt');
fs.writeFileSync(
  outFile,
  [
    '# Paste these into Vercel → Project → Settings → Environment Variables.',
    '# This file is gitignored. Delete it once the values are in Vercel.',
    '',
    `DATABASE_URL=${runtimeUrl}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log('');
console.log('GitHub environment secrets are set. Nothing above was printed in the clear.');
console.log('');
console.log('The runtime database URL for Vercel was written to:');
console.log(`  ${outFile}`);
console.log('Paste it into Vercel, then delete the file.');
console.log('');
console.log('Next: run the bootstrap workflow so the roles actually exist:');
console.log('  gh workflow run bootstrap-database.yml -f environment=production -f rotate_passwords=true');
