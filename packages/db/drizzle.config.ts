import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit generates SQL migrations that are committed with the PR and
 * applied by CI as `app_owner` (blueprint 22.3). Nothing here ever runs with
 * the runtime credential.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT_OWNER ?? 'postgres://localhost:5432/vaultide',
  },
});
