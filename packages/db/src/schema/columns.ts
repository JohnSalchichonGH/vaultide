import { customType, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Column primitives shared by every table (blueprint 6.1, 7.1).
 *
 * `NUMERIC` values leave the database as strings and stay strings all the way
 * to the domain layer, where they become `Decimal`. `mode: 'number'` is never
 * used: a JavaScript number cannot hold a `NUMERIC(24,8)` without loss.
 */

/** Money: NUMERIC(24,8) — 16 integer digits, 8 decimals (6.1). */
export const moneyNumeric = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(24, 8)',
  fromDriver: (value) => String(value),
  toDriver: (value) => value,
});

/** FX rates: NUMERIC(24,12). */
export const rateNumeric = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(24, 12)',
  fromDriver: (value) => String(value),
  toDriver: (value) => value,
});

/** Rates and percentages as fractions: NUMERIC(12,8). */
export const fractionNumeric = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(12, 8)',
  fromDriver: (value) => String(value),
  toDriver: (value) => value,
});

/** ISO 4217 alphabetic code: char(3) referencing `currencies(code)` (6.1). */
export const currencyCodeColumn = customType<{ data: string; driverData: string }>({
  dataType: () => 'char(3)',
  fromDriver: (value) => String(value).trim(),
  toDriver: (value) => value,
});

/** `char(3)[]` of currency codes (6.2 `user_settings.favorite_currencies`). */
export const currencyCodeArrayColumn = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'char(3)[]',
  fromDriver: (value) => value.map((code) => String(code).trim()),
  toDriver: (value) => value,
});

/**
 * System times (6.1): `timestamptz`, UTC. `updated_at` is maintained by the
 * `set_updated_at` trigger every table installs, so no application path can
 * forget it and no client can set it.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Optimistic concurrency (6.1, 20.3): `UPDATE … WHERE version = expected`. */
export const version = {
  version: integer('version').notNull().default(1),
};
