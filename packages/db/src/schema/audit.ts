import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditActions } from '@vaultide/validation';
import { authUser } from './auth';
import { userOwnedPolicy } from './rls';

/**
 * `audit_entries` (blueprint 6.2, 18.1, R12, T7) — the before/after image of
 * every change to a source row.
 *
 * This is what makes "hard-delete financial rows" safe: a deleted valuation is
 * gone from `position_valuations`, but its full previous value is here, so the
 * change can be explained and — from Phase 7 — undone by writing the image
 * back as a new audited mutation.
 *
 * The rows hold real financial values. They live in the same protected database
 * under the same RLS and roles, and are never copied into logs, Sentry or
 * analytics (18.1, 18.2).
 *
 * Insert-only by privilege, not by convention: migration `0005` revokes UPDATE
 * and DELETE from `app_user`, so the runtime cannot rewrite its own history
 * even if some future code tried to (6.1).
 *
 * No `updated_at` and no `version`: an audit row is never edited.
 */

export const auditAction = pgEnum('audit_action', auditActions);

export const auditEntries = pgTable(
  'audit_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    /** Who acted. The same person today; a support or import actor later. */
    actorUserId: uuid('actor_user_id'),
    entityTable: text('entity_table').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: auditAction('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    changedFields: text('changed_fields')
      .array()
      .notNull()
      .default(sql`'{}'`),
    reason: text('reason'),
    /** Ties every row of one bulk save together (18.1). */
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_entries_lookup_idx').on(
      table.userId,
      table.entityTable,
      table.entityId,
      table.occurredAt.desc(),
    ),
    userOwnedPolicy('audit_entries_user_policy'),
  ],
);

export type AuditEntryRow = typeof auditEntries.$inferSelect;
export type NewAuditEntryRow = typeof auditEntries.$inferInsert;
