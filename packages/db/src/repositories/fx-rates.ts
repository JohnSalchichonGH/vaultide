import { and, asc, eq, gte, inArray, lte, max, sql } from 'drizzle-orm';
import { fxRates } from '../schema/fx-rates';
import { withoutUser, type Database } from '../client';

/**
 * `fx_rates` reads and appends (blueprint 6.2, 10.4, R26).
 *
 * Global and append-only. Every function here runs through `withoutUser`, which
 * documents at the call site that no tenant data is involved — and is why the
 * daily refresh can run with no user context at all: as `app_user` without the
 * GUC, every user-owned table returns zero rows, so a job restricted to these
 * two tables provably cannot read across tenants (17.4, T11).
 */

export interface FxRateInput {
  readonly base: string;
  readonly quote: string;
  readonly rateDate: string;
  /** Exact decimal string; `NUMERIC(24,12)` never passes through a float (7.1). */
  readonly rate: string;
  readonly source: string;
  readonly fetchedAt: Date;
}

export interface StoredFxRate {
  readonly quote: string;
  readonly rateDate: string;
  readonly rate: string;
  readonly source: string;
}

/**
 * Chunk size for a bulk append. A full ECB backfill is roughly 7,000 rows per
 * currency; this keeps any single statement's parameter count modest.
 */
const INSERT_CHUNK = 1000;

/**
 * Append rates, ignoring any that already exist.
 *
 * The conflict target is the natural key of a published rate — one publisher's
 * rate, for one currency, on one day — so a repeated refresh inserts nothing
 * and changes nothing. Idempotence is a constraint, not a check that could
 * race, and rows already stored are never rewritten (6.2: rows are immutable).
 *
 * Returns the number of rows that were genuinely new.
 */
export async function appendFxRates(db: Database, rows: readonly FxRateInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK);
    const written = await withoutUser(db, async (tx) =>
      tx
        .insert(fxRates)
        .values([...chunk])
        .onConflictDoNothing({
          target: [fxRates.base, fxRates.quote, fxRates.rateDate, fxRates.source],
        })
        .returning({ id: fxRates.id }),
    );
    inserted += written.length;
  }

  return inserted;
}

/** The rows one request needs, ordered so the lookup table can index them cheaply. */
export async function selectFxRates(
  db: Database,
  quotes: readonly string[],
  from: string,
  to: string,
): Promise<StoredFxRate[]> {
  if (quotes.length === 0) return [];

  const rows = await withoutUser(db, async (tx) =>
    tx
      .select({
        quote: fxRates.quote,
        rateDate: fxRates.rateDate,
        rate: fxRates.rate,
        source: fxRates.source,
      })
      .from(fxRates)
      .where(
        and(inArray(fxRates.quote, [...quotes]), gte(fxRates.rateDate, from), lte(fxRates.rateDate, to)),
      )
      .orderBy(asc(fxRates.quote), asc(fxRates.rateDate)),
  );

  return rows.map((row) => ({ ...row, quote: row.quote.trim() }));
}

/** The earliest stored date for a currency, or `undefined` when it has none. */
export async function earliestRateDate(
  db: Database,
  quote: string,
): Promise<string | undefined> {
  const [row] = await withoutUser(db, async (tx) =>
    tx
      .select({ earliest: sql<string | null>`min(${fxRates.rateDate})::text` })
      .from(fxRates)
      .where(eq(fxRates.quote, quote)),
  );
  return row?.earliest ?? undefined;
}

/** The latest stored date per currency — the cron's own health report. */
export async function latestRateDateByQuote(db: Database): Promise<Record<string, string>> {
  const rows = await withoutUser(db, async (tx) =>
    tx.select({ quote: fxRates.quote, latest: max(fxRates.rateDate) }).from(fxRates).groupBy(fxRates.quote),
  );
  return Object.fromEntries(
    rows.flatMap((row) => (row.latest == null ? [] : [[row.quote.trim(), row.latest]])),
  );
}

/** Total rows stored. Used by the cron response and the integration tests. */
export async function countFxRates(db: Database): Promise<number> {
  const [row] = await withoutUser(db, async (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(fxRates),
  );
  return row?.n ?? 0;
}
