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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { transferKinds } from '@vaultide/validation';
import { authUser } from './auth';
import { currencyCodeColumn, moneyNumeric, tagsColumn, timestamps, version } from './columns';
import { currencies } from './currencies';
import { positions } from './positions';
import { recurringTemplates } from './recurring-templates';
import { userOwnedPolicy } from './rls';

/**
 * `transfers` (blueprint 6.2, 7.5, M13, M14).
 *
 * Value moving between two things the user already owns. A transfer is never
 * income and never spending: in the reconciliation identity its source leg is
 * `Nout` and its destination leg `Nin`, so a same-currency cash transfer
 * cancels exactly inside its bucket and a cross-currency one hits two buckets
 * that each reconcile on their own (8.2, 8.8).
 *
 * `kind` carries all eight values of 6.2 because the enum is a closed set;
 * **Phase 3 services accept `cash_transfer` only**, and `template_id` /
 * `occurrence_date` are required NULL there. They exist now so that an accepted
 * `contribution` occurrence is representable when Phase 4 builds it — 5.2
 * already promised accepted occurrences would live on transfer rows, and half
 * an identity is worse than none (§30.9 item 3).
 *
 * A fee is **one** `expense_entries` row pointing back here (M14). There is no
 * fee column: two representations of one fact is how a fee gets counted twice.
 */

export const transferKind = pgEnum('transfer_kind', transferKinds);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: transferKind('kind').notNull(),
    /** The financial date. */
    occurredOn: date('occurred_on').notNull(),
    templateId: uuid('template_id'),
    occurrenceDate: date('occurrence_date'),
    fromPositionId: uuid('from_position_id'),
    fromCurrency: currencyCodeColumn('from_currency')
      .notNull()
      .references(() => currencies.code),
    fromAmount: moneyNumeric('from_amount').notNull(),
    toPositionId: uuid('to_position_id'),
    toCurrency: currencyCodeColumn('to_currency')
      .notNull()
      .references(() => currencies.code),
    toAmount: moneyNumeric('to_amount').notNull(),
    description: text('description'),
    tags: tagsColumn('tags').notNull().default(sql`'{}'`),
    ...timestamps,
    ...version,
  },
  (table) => [
    unique('transfers_id_user_id_key').on(table.id, table.userId),
    check('transfers_from_amount_positive', sql`${table.fromAmount} > 0`),
    check('transfers_to_amount_positive', sql`${table.toAmount} > 0`),
    check(
      'transfers_has_an_endpoint',
      sql`${table.fromPositionId} IS NOT NULL OR ${table.toPositionId} IS NOT NULL`,
    ),
    check(
      'transfers_endpoints_differ',
      sql`${table.fromPositionId} IS DISTINCT FROM ${table.toPositionId}`,
    ),
    // M13: within one currency a transfer moves one amount, not two.
    check(
      'transfers_same_currency_same_amount',
      sql`${table.fromCurrency} <> ${table.toCurrency} OR ${table.fromAmount} = ${table.toAmount}`,
    ),
    check(
      'transfers_occurrence_pair',
      sql`(${table.templateId} IS NULL) = (${table.occurrenceDate} IS NULL)`,
    ),
    foreignKey({
      name: 'transfers_template_fk',
      columns: [table.templateId, table.userId],
      foreignColumns: [recurringTemplates.id, recurringTemplates.userId],
    }),
    // Endpoints are plain composite references: 7.5 validates which position
    // kinds each transfer kind may join, and it depends on `kind`, so it is a
    // domain rule rather than a typed column.
    foreignKey({
      name: 'transfers_from_position_fk',
      columns: [table.fromPositionId, table.userId],
      foreignColumns: [positions.id, positions.userId],
    }),
    foreignKey({
      name: 'transfers_to_position_fk',
      columns: [table.toPositionId, table.userId],
      foreignColumns: [positions.id, positions.userId],
    }),
    uniqueIndex('transfers_occurrence_uidx')
      .on(table.templateId, table.occurrenceDate)
      .where(sql`template_id IS NOT NULL AND occurrence_date IS NOT NULL`),
    index('transfers_user_occurred_idx').on(table.userId, table.occurredOn),
    index('transfers_from_occurred_idx').on(table.fromPositionId, table.occurredOn),
    index('transfers_to_occurred_idx').on(table.toPositionId, table.occurredOn),
    userOwnedPolicy('transfers_user_policy'),
  ],
);

export type TransferRow = typeof transfers.$inferSelect;
export type NewTransferRow = typeof transfers.$inferInsert;
