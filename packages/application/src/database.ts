import { createDatabase, createPool, requireDatabaseUrl, type Database } from '@vaultide/db';

/**
 * The runtime database handle (blueprint 19, 22.4).
 *
 * `apps/web` never imports `@vaultide/db`; it asks the application layer for a
 * connection. The pool is created once per process against Neon's pooled
 * endpoint as `app_user` — the role that is `NOBYPASSRLS` and has no DDL.
 */

let database: Database | undefined;

export function isDatabaseConfigured(env = process.env): boolean {
  const url = env['DATABASE_URL'];
  return url !== undefined && url !== '';
}

export function getDatabase(): Database {
  database ??= createDatabase(
    createPool({
      connectionString: requireDatabaseUrl('app_user'),
      applicationName: 'vaultide-web',
    }),
  );
  return database;
}

/** Test seam: forget the cached handle (used when a suite swaps databases). */
export function resetDatabase(): void {
  database = undefined;
}
