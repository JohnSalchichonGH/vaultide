import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * `@vaultide/db/testing` — provisions a PostgreSQL database from zero the way
 * an environment is provisioned in production (blueprint 22.2, 21.3, Phase 0 acceptance):
 *
 *   1. an admin credential creates the database;
 *   2. `scripts/db/bootstrap-roles.sql` runs as the platform admin;
 *   3. migrations run as `app_owner`;
 *   4. the currency seed runs as `app_owner`.
 *
 * The real scripts are executed, not re-implemented, so what the tests prove is
 * what CI and production actually run.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dbPackageRoot = path.join(repoRoot, 'packages', 'db');

export interface RolePasswords {
  readonly appOwner: string;
  readonly appUser: string;
  readonly appBackup: string;
}

export interface ProvisionedDatabase {
  readonly databaseName: string;
  readonly adminUrl: string;
  readonly ownerUrl: string;
  readonly userUrl: string;
  readonly backupUrl: string;
  readonly passwords: RolePasswords;
}

/**
 * The admin connection string. CI supplies `TEST_DATABASE_URL_ADMIN` (the
 * postgres:16 service container); locally the harness falls back to the cluster
 * started by `pnpm db:local start`.
 */
export function adminUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL_ADMIN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const connectionFile = path.join(repoRoot, '.vaultide-pg', 'connection.json');
  if (fs.existsSync(connectionFile)) {
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8')) as { url: string };
    return connection.url;
  }

  throw new Error(
    'No admin database URL. Set TEST_DATABASE_URL_ADMIN, or run "pnpm db:local start".',
  );
}

/** Swap the role and database of a connection string. */
export function urlFor(base: string, options: { user: string; password: string; database: string }) {
  const url = new URL(base);
  url.username = options.user;
  url.password = options.password;
  url.pathname = `/${options.database}`;
  return url.toString();
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function runScript(script: string, env: NodeJS.ProcessEnv, cwd = repoRoot): string {
  return execFileSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Step 2: the platform-admin role bootstrap, exactly as an operator runs it. */
export function runBootstrap(
  databaseAdminUrl: string,
  passwords?: Partial<RolePasswords>,
): string {
  return runScript(path.join('scripts', 'db', 'bootstrap.mjs'), {
    DATABASE_URL_ADMIN: databaseAdminUrl,
    ...(passwords?.appOwner === undefined ? {} : { APP_OWNER_PASSWORD: passwords.appOwner }),
    ...(passwords?.appUser === undefined ? {} : { APP_USER_PASSWORD: passwords.appUser }),
    ...(passwords?.appBackup === undefined ? {} : { APP_BACKUP_PASSWORD: passwords.appBackup }),
  });
}

/** Step 3: migrations as `app_owner`, through the committed migration runner. */
export function runMigrations(ownerUrl: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'scripts', 'migrate.ts')],
    {
      cwd: dbPackageRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL_DIRECT_OWNER: ownerUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** Step 4: the currency seed, also as `app_owner`. */
export function runCurrencySeed(ownerUrl: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'scripts', 'seed-currencies.ts')],
    {
      cwd: dbPackageRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL_DIRECT_OWNER: ownerUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export async function createDatabase(base: string, databaseName: string): Promise<void> {
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(base: string, databaseName: string): Promise<void> {
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await client.end();
  }
}

export interface ProvisionOptions {
  /** Stop after the bootstrap step (used by the from-zero test). */
  readonly migrate?: boolean;
  readonly seed?: boolean;
  readonly passwords?: RolePasswords;
}

/** Provision a brand-new database end to end and return its four credentials. */
export async function provisionDatabase(
  options: ProvisionOptions = {},
): Promise<ProvisionedDatabase> {
  const { migrate = true, seed = true } = options;
  const base = adminUrl();
  const databaseName = `vaultide_test_${randomBytes(6).toString('hex')}`;

  const passwords: RolePasswords = options.passwords ?? {
    appOwner: generatePassword(),
    appUser: generatePassword(),
    appBackup: generatePassword(),
  };

  await createDatabase(base, databaseName);

  const parsed = new URL(base);
  const databaseAdminUrl = urlFor(base, {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: databaseName,
  });
  const ownerUrl = urlFor(base, {
    user: 'app_owner',
    password: passwords.appOwner,
    database: databaseName,
  });
  const userUrl = urlFor(base, {
    user: 'app_user',
    password: passwords.appUser,
    database: databaseName,
  });
  const backupUrl = urlFor(base, {
    user: 'app_backup',
    password: passwords.appBackup,
    database: databaseName,
  });

  runBootstrap(databaseAdminUrl, passwords);
  if (migrate) runMigrations(ownerUrl);
  if (seed) runCurrencySeed(ownerUrl);

  return { databaseName, adminUrl: databaseAdminUrl, ownerUrl, userUrl, backupUrl, passwords };
}

export async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** Run a statement and return the PostgreSQL error code it raises, if any. */
export async function errorCodeOf(
  client: pg.Client,
  statement: string,
  values: unknown[] = [],
): Promise<string | null> {
  try {
    await client.query(statement, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
