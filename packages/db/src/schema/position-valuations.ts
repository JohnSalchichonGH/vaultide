import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { datePrecisions, valuationSources } from '@vaultide/validation';
import { authUser } from './auth';
import { moneyNumeric, timestamps, version } from './columns';
import { positions } from './positions';
import { userOwnedPolicy } from './rls';

/**
 * `position_valuations` (blueprint 6.2, D1, M1, R4, R15) — one table for every
 * kind of snapshot: a bank balance, a fund value, a property valuation, an
 * other asset's worth, a liability balance.
 *
 * A valuation is a **snapshot, not a flow**. It says what something was worth
 * on a date. Nothing here infers income, spending or a transfer from a change
 * between two snapshots; that inference is the reconciliation engine's job and
 * it needs the flow tables to do it honestly.
 *
 * No currency column: a valuation inherits its position's currency (R4, C5). A
 * snapshot whose currency could disagree with its account's is a bug waiting
 * for a place to happen.
 *
 * ## The two date rules, and why only one of them is here
 *
 * `date_precision = 'month_end'` means "the balance at the end of that month,
 * as read from a statement" (T3, R15). Two rules govern it:
 *
 *  1. the date must be the last day of its month — a **timeless** property of
 *     the row, so it is a CHECK;
 *  2. the month must already be over (`today > end(M)`) and no actual record
 *     may be dated after today — both **time-dependent**, so neither may be a
 *     CHECK (6.1, M5). A constraint referencing `current_date` would change its
 *     verdict on a row that never changed, and would make a restored backup
 *     unrestorable. They are enforced in `validation` and the domain against
 *     the user's local today.
 */

export const valuationSource = pgEnum('valuation_source', valuationSources);
export const datePrecision = pgEnum('date_precision', datePrecisions);

export const positionValuations = pgTable(
  'position_valuations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id').notNull(),
    /** The financial date. A valuation dated d reflects every flow dated ≤ d (8.1). */
    valuedOn: date('valued_on').notNull(),
    /**
     * Signed, in the position's own currency. Negative is allowed only for cash
     * (an overdraft) — a service rule, because it depends on the parent's kind.
     * Liability balances stay positive in storage and carry their sign through
     * `netWorthSign` (7.8, R25).
     */
    amount: moneyNumeric('amount').notNull(),
    source: valuationSource('source').notNull().default('entered'),
    datePrecision: datePrecision('date_precision').notNull().default('exact'),
    note: text('note'),
    ...timestamps,
    ...version,
  },
  (table) => [
    // M1: one valuation per position per date. Two balances for one day is not
    // a correction, it is an ambiguity, and the editor offers a correction.
    unique('position_valuations_position_date_key').on(table.positionId, table.valuedOn),
    // The composite reference: a valuation can only ever belong to a position
    // of the same owner (M8). `NO ACTION` rather than `RESTRICT` so the
    // account-deletion cascade from `"user"` still succeeds, while an ordinary
    // attempt to delete a position that has history still fails (6.1, 6.3).
    foreignKey({
      name: 'position_valuations_position_fk',
      columns: [table.positionId, table.userId],
      foreignColumns: [positions.id, positions.userId],
    }),
    check(
      'position_valuations_month_end_shape',
      sql`${table.datePrecision} <> 'month_end' OR ${table.valuedOn} = (date_trunc('month', ${table.valuedOn}) + interval '1 month - 1 day')::date`,
    ),
    index('position_valuations_position_date_idx').on(table.positionId, table.valuedOn.desc()),
    index('position_valuations_user_date_idx').on(table.userId, table.valuedOn),
    userOwnedPolicy('position_valuations_user_policy'),
  ],
);

export type PositionValuationRow = typeof positionValuations.$inferSelect;
export type NewPositionValuationRow = typeof positionValuations.$inferInsert;
