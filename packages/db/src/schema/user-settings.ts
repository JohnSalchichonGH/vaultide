import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth';
import { currencyCodeArrayColumn, currencyCodeColumn, timestamps, version } from './columns';
import { currencies } from './currencies';
import { userOwnedPolicy } from './rls';

/**
 * `user_settings` (blueprint 6.2, T10) — one row per user, created in the same
 * workflow as the user (Phase 1 provisioning), deleted with them.
 *
 * Base currency is what the user thinks in; reporting currency is what totals
 * are displayed in and may be changed at any time — it is a presentation
 * choice, and no converted value is ever persisted (M10, T8).
 *
 * `count_additional_spending` decides whether spending the user paid from
 * outside their tracked accounts reduces the personal savings rate (12.5, D40).
 * It is defined here in Phase 1 so the setting exists before Phase 3 reads it;
 * nothing in Phase 1 computes a savings rate.
 */
export const userSettings = pgTable(
  'user_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    baseCurrency: currencyCodeColumn('base_currency')
      .notNull()
      .references(() => currencies.code),
    reportingCurrency: currencyCodeColumn('reporting_currency')
      .notNull()
      .references(() => currencies.code),
    /** IANA zone. Determines "today", and therefore which records may exist (T1). */
    timezone: text('timezone').notNull(),
    /** BCP 47 tag. Drives number and date formatting only. */
    locale: text('locale').notNull(),
    favoriteCurrencies: currencyCodeArrayColumn('favorite_currencies')
      .notNull()
      .default(sql`'{}'`),
    staleInvestmentMonths: smallint('stale_investment_months').notNull().default(2),
    stalePropertyMonths: smallint('stale_property_months').notNull().default(12),
    countAdditionalSpending: boolean('count_additional_spending').notNull().default(true),
    /** UI preferences only. Nothing financial or relational lives here (6.1). */
    preferences: jsonb('preferences').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
    ...version,
  },
  () => [userOwnedPolicy('user_settings_user_policy')],
);

export type UserSettingsRow = typeof userSettings.$inferSelect;
export type NewUserSettingsRow = typeof userSettings.$inferInsert;
