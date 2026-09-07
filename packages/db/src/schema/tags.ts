import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth';
import { timestamps } from './columns';
import { userOwnedPolicy } from './rls';

/**
 * `tags` (blueprint 6.2, T6, D24) — the managed list of labels a user may put
 * on a flow. The labels themselves live on each flow row as a `text[]` with a
 * GIN index (Phase 3); this table is what the tag picker offers and what a
 * rename edits.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('tags_user_name_key').on(table.userId, table.name),
    userOwnedPolicy('tags_user_policy'),
  ],
);

export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;
