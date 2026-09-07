import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUser } from './auth';
import { timestamps, version } from './columns';
import { userOwnedPolicy } from './rls';

/**
 * `categories` (blueprint 6.2, T5, D25).
 *
 * `kind` fixes the accounting semantics of every expense filed under the
 * category; name, group, icon and colour are the user's own organization. A
 * PostgreSQL enum rather than `text + CHECK` (D48), so an unknown value is
 * rejected by the type system and by the database.
 *
 * Categories are copied per user at sign-up (D25): uniform RLS, and a user may
 * rename their own without touching anybody else's.
 */
export const categoryKind = pgEnum('category_kind', [
  // Consumption kinds: ordinary spending, by category.
  'general',
  'housing',
  'transport',
  'food',
  'travel',
  'health',
  'insurance',
  'tax',
  'subscriptions',
  'maintenance',
  'major_purchase',
  'custom',
  // System kinds: non-consumption semantics, one per user, never archivable.
  'property_operating',
  'investment_fee',
  'transfer_fee',
  'acquisition_cost',
  'disposal_cost',
  'capital_improvement',
  'external_outflow',
]);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: categoryKind('kind').notNull(),
    name: text('name').notNull(),
    groupName: text('group_name'),
    icon: text('icon'),
    color: text('color'),
    /** Created by provisioning rather than by the user. */
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Categories are archived, never deleted while referenced (R12, 6.3). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (table) => [
    // Children reference `(category_id, user_id)` as a composite FK (M8, 6.1).
    unique('categories_id_user_id_key').on(table.id, table.userId),
    // A live category name is unique per user; archived rows keep the name free.
    uniqueIndex('categories_user_name_uidx')
      .on(table.userId, table.name)
      .where(sql`archived_at IS NULL`),
    index('categories_user_kind_idx').on(table.userId, table.kind),
    userOwnedPolicy('categories_user_policy'),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
