import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { positionKinds, positionStatuses } from '@vaultide/validation';
import { authUser } from './auth';
import { currencyCodeColumn, timestamps, version } from './columns';
import { currencies } from './currencies';
import { userOwnedPolicy } from './rls';

/**
 * `positions` (blueprint 6.2, D1) — the supertype every tracked thing hangs
 * from: cash accounts, investments, properties, other assets and liabilities.
 *
 * One table rather than five (6.4) buys one freshness engine, one valuation
 * table, real foreign keys from flows, and uniform RLS and audit. Subtype
 * behaviour lives in the domain layer keyed by `kind`.
 *
 * Two things this table deliberately does **not** have:
 *
 *  - a net-worth inclusion flag. A generic toggle would let somebody "exclude"
 *    a mortgage from their net worth (F21). The only inclusion preference in
 *    the schema is `other_assets.include_in_financial_net_worth` (M15, R18).
 *  - any time-dependent constraint. "Not after today" is not a row invariant;
 *    it is enforced in validation and the domain against the user's local today
 *    (M5, 6.1).
 */

/**
 * All five kinds, declared once. Phase 2 creates rows for `cash` and
 * `other_asset` only, but the type is the closed set of 6.2 and the typed
 * foreign keys of later phases target it — a value is never renamed in place
 * and the enum is not re-created per phase (6.1).
 */
export const positionKind = pgEnum('position_kind', positionKinds);

export const positionStatus = pgEnum('position_status', positionStatuses);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: positionKind('kind').notNull(),
    name: text('name').notNull(),
    /**
     * The position's **native** currency, and the currency of every one of its
     * valuations (R4, C5). A valuation never carries a currency of its own.
     * Immutable once any valuation or flow exists — a service rule, because it
     * is a rule about other rows.
     */
    currency: currencyCodeColumn('currency')
      .notNull()
      .references(() => currencies.code),
    status: positionStatus('status').notNull().default('active'),
    /**
     * When the position started existing, if known.
     *
     * NULL is meaningful: "an account that already existed and which I am now
     * starting to track". A set date means the position opened empty then, so
     * the month containing it opens at zero (`opened_zero`, 8.1). Getting this
     * wrong changes reconciliation, which is why creation asks the question.
     */
    openedOn: date('opened_on'),
    closedOn: date('closed_on'),
    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...version,
  },
  (table) => [
    // Children reference `(id, user_id)`, so a child can never point at another
    // tenant's parent even if the application code is wrong (M8, 6.1).
    unique('positions_id_user_id_key').on(table.id, table.userId),
    // …and `(id, user_id, kind)` is the target of the typed reference pattern
    // of 6.1: a column that must point at a cash position carries a constant
    // `kind` column, so the database refuses a reference to the wrong kind.
    unique('positions_id_user_id_kind_key').on(table.id, table.userId, table.kind),
    check(
      'positions_dates_ordered',
      sql`${table.closedOn} IS NULL OR ${table.openedOn} IS NULL OR ${table.closedOn} >= ${table.openedOn}`,
    ),
    check(
      'positions_closed_has_date',
      sql`${table.status} <> 'closed' OR ${table.closedOn} IS NOT NULL`,
    ),
    index('positions_user_kind_status_idx').on(table.userId, table.kind, table.status),
    userOwnedPolicy('positions_user_policy'),
  ],
);

export type PositionRow = typeof positions.$inferSelect;
export type NewPositionRow = typeof positions.$inferInsert;
