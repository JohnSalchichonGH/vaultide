import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { currencyCodeColumn } from './columns';

/**
 * `currencies` (blueprint 6.2) — a global reference table.
 *
 * Fiat / official currencies only: crypto is an investment asset class, not a
 * currency (R28, D35). `minor_units` carries the real ISO 4217 value, from 0
 * (JPY) through 4 (CLF, UYW), because the formatter and the input validators
 * read it — a currency with four decimals must round-trip exactly.
 *
 * No RLS: the table belongs to no tenant. `app_user` may only SELECT it; the
 * migration revokes the write privileges the default grants would give.
 */
export const currencies = pgTable(
  'currencies',
  {
    code: currencyCodeColumn('code').primaryKey(),
    name: text('name').notNull(),
    minorUnits: smallint('minor_units').notNull(),
    isFxSupported: boolean('is_fx_supported').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    check('currencies_minor_units_range', sql`${table.minorUnits} BETWEEN 0 AND 8`),
    check('currencies_code_shape', sql`${table.code} ~ '^[A-Z]{3}$'`),
  ],
);

export type CurrencyRow = typeof currencies.$inferSelect;
export type NewCurrencyRow = typeof currencies.$inferInsert;
