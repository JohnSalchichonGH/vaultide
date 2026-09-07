import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { currencyCodeColumn, rateNumeric } from './columns';
import { currencies } from './currencies';

/**
 * `fx_rates` (blueprint 6.2, 10.1, 10.4) — global, append-only.
 *
 * Every stored rate is `EUR → quote` (the ECB pivot); a cross rate `A → B` is
 * derived at read time as `rate(EUR→B) / rate(EUR→A)`. Rows are **never
 * updated**: an alternative rate for the same day is a new row with another
 * `source`, and readers apply a source preference. That is what makes a
 * historical conversion reproducible.
 *
 * The table has **no** `user_id` and therefore **no RLS** (17.4): rates belong
 * to nobody. It is also why the daily refresh job can run with no user context
 * at all — under `app_user` every user-owned table returns zero rows, so a job
 * that only touches `currencies` and `fx_rates` provably cannot read across
 * tenants (R26, T11).
 *
 * `app_user` holds SELECT and INSERT only; the UPDATE and DELETE the default
 * privileges would grant are revoked by migration (6.1).
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    base: currencyCodeColumn('base')
      .notNull()
      .references(() => currencies.code),
    quote: currencyCodeColumn('quote')
      .notNull()
      .references(() => currencies.code),
    /** A calendar date, not a timestamp: a reference rate belongs to a day. */
    rateDate: date('rate_date').notNull(),
    rate: rateNumeric('rate').notNull(),
    /** Which publisher the rate came from, e.g. `ecb`. */
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('fx_rates_base_quote_date_source_key').on(
      table.base,
      table.quote,
      table.rateDate,
      table.source,
    ),
    index('fx_rates_quote_date_idx').on(table.quote, table.rateDate.desc()),
    check('fx_rates_rate_positive', sql`${table.rate} > 0`),
    // A pivot table only ever stores one base; stated as an invariant so a
    // provider change cannot quietly start writing rows readers cannot combine.
    check('fx_rates_base_is_pivot', sql`${table.base} = 'EUR'`),
  ],
);

export type FxRateRow = typeof fxRates.$inferSelect;
export type NewFxRateRow = typeof fxRates.$inferInsert;
