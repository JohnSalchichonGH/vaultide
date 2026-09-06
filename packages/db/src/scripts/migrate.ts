/**
 * Applies migrations as `app_owner` over the direct endpoint (blueprint 22.3).
 * The runtime role has no DDL; the owner credential exists only in CI and in a
 * developer's local environment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { requireDatabaseUrl } from '../env';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const connectionString = requireDatabaseUrl('app_owner');
const pool = new pg.Pool({ connectionString, max: 1 });

try {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied from ${migrationsFolder}`);
} finally {
  await pool.end();
}
