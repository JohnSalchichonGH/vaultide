import {
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { skipReasons } from '@vaultide/validation';
import { authUser } from './auth';
import { timestamps, version } from './columns';
import { recurringTemplates } from './recurring-templates';
import { userOwnedPolicy } from './rls';

/**
 * `recurring_template_skips` (blueprint 6.2, 11.2, F18, D47).
 *
 * The durable record that a suggested occurrence was deliberately not taken —
 * and the **only** source of occupancy facts in the whole product. A month with
 * no rent entry means nothing; a skip with reason `vacant` means the property
 * was empty. Absence is never read as vacancy, which is why this is a table and
 * not a JSON dismissal key (D47: `month_reviews.dismissed_issues` holds UI
 * state only).
 *
 * `occurrence_date` is the suggestion's **scheduled** date, the same identity
 * the materialized flow tables carry. A skip creates no financial flow, and an
 * occurrence is accepted or skipped, never both — accept and skip serialize on
 * the template row (20.3).
 *
 * `vacant` and `non_payment` are restricted to rental templates by a domain
 * rule: it is a statement about another row (the template's `income_kind`), so
 * it cannot be a CHECK here.
 */

export const skipReason = pgEnum('skip_reason', skipReasons);

export const recurringTemplateSkips = pgTable(
  'recurring_template_skips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').notNull(),
    /** The scheduled occurrence, never a financial date. */
    occurrenceDate: date('occurrence_date').notNull(),
    reason: skipReason('reason').notNull(),
    note: text('note'),
    ...timestamps,
    ...version,
  },
  (table) => [
    unique('recurring_template_skips_template_occurrence_key').on(
      table.templateId,
      table.occurrenceDate,
    ),
    foreignKey({
      name: 'recurring_template_skips_template_fk',
      columns: [table.templateId, table.userId],
      foreignColumns: [recurringTemplates.id, recurringTemplates.userId],
    }).onDelete('cascade'),
    index('recurring_template_skips_template_occurrence_idx').on(
      table.templateId,
      table.occurrenceDate,
    ),
    userOwnedPolicy('recurring_template_skips_user_policy'),
  ],
);

export type RecurringTemplateSkipRow = typeof recurringTemplateSkips.$inferSelect;
export type NewRecurringTemplateSkipRow = typeof recurringTemplateSkips.$inferInsert;
