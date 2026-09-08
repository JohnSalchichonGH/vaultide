import { sql } from 'drizzle-orm';
import { check, date, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth';
import { timestamps, version } from './columns';
import { userOwnedPolicy } from './rls';

/**
 * `month_reviews` (blueprint 6.2, D47).
 *
 * The user's own note on a month and the advisory issues they have dismissed.
 * Reviewing a month does not lock it, change a figure or complete anything: it
 * records that somebody looked.
 *
 * `dismissed_issues` is the one JSONB column here and it holds **UI dismissal
 * keys only** (6.1). Nothing financial and nothing about occupancy may live in
 * it — an explicitly skipped suggestion is a `recurring_template_skips` row,
 * which is what D47 decided and why that table exists.
 *
 * The CHECK pins `month` to the first of its month: a timeless property of the
 * value. "A month can be marked reviewed only once it is completed" is a rule
 * about the moving present, so it is a service rule and never a constraint
 * (6.1, M5).
 *
 * Phase 3 slices 1–5 create the table; the actions that write it belong to the
 * Monthly editor slice.
 */
export const monthReviews = pgTable(
  'month_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    month: date('month').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    notes: text('notes'),
    dismissedIssues: jsonb('dismissed_issues').notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
    ...version,
  },
  (table) => [
    unique('month_reviews_user_month_key').on(table.userId, table.month),
    check(
      'month_reviews_month_is_first_of_month',
      sql`${table.month} = date_trunc('month', ${table.month})::date`,
    ),
    userOwnedPolicy('month_reviews_user_policy'),
  ],
);

export type MonthReviewRow = typeof monthReviews.$inferSelect;
export type NewMonthReviewRow = typeof monthReviews.$inferInsert;
