/**
 * Seeds the global `currencies` table (blueprint 6.2, Phase 0).
 *
 * Runs as `app_owner`: `currencies` is reference data owned by migrations, and
 * the runtime role has SELECT on it only. Re-running updates names and flags in
 * place and never deletes a currency (6.2: "No delete").
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { requireDatabaseUrl } from '../env';
import { currencies } from '../schema/currencies';
import { currencySeed } from '../seed/currencies';

const pool = new pg.Pool({ connectionString: requireDatabaseUrl('app_owner'), max: 1 });

try {
  const db = drizzle(pool);
  await db
    .insert(currencies)
    .values(
      currencySeed.map((row) => ({
        code: row.code,
        name: row.name,
        minorUnits: row.minorUnits,
        isFxSupported: row.isFxSupported,
        isActive: true,
      })),
    )
    .onConflictDoUpdate({
      target: currencies.code,
      set: {
        name: sql`excluded.name`,
        minorUnits: sql`excluded.minor_units`,
        isFxSupported: sql`excluded.is_fx_supported`,
      },
    });

  const result = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM currencies`,
  );
  console.log(`Seeded currencies: ${result.rows[0]?.count ?? '0'} rows`);
} finally {
  await pool.end();
}
