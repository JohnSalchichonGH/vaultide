import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { incomeSettlements } from '@vaultide/validation';
import { authUser } from './auth';
import { currencyCodeColumn, moneyNumeric, tagsColumn, timestamps, version } from './columns';
import { currencies } from './currencies';
import { positionKind } from './positions';
import { incomeKind, recurringTemplates } from './recurring-templates';
import { userOwnedPolicy } from './rls';
import { typedPositionRefConstraints } from './typed-position-ref';

/**
 * `income_entries` (blueprint 6.2, 7.4, v2.1.6 §30.9).
 *
 * Money arriving. `settlement` decides what it means: `tracked_cash` is the
 * external cash inflow `I` of the reconciliation identity, `external` is
 * informational income that never entered the tracked balance sheet, and
 * `reinvested` belongs to Phase 4's distributions.
 *
 * ## The two dates
 *
 * `received_on` is the **financial** date — when the money actually arrived,
 * never after today (M5, enforced in validation and the domain, never as a
 * CHECK). `occurrence_date` is the **scheduling** identity of the recurring
 * occurrence this row materializes: fixed at creation, immutable afterwards,
 * and free to differ from `received_on`. That is what makes "received today"
 * safe — a salary scheduled for 1 October and received on 30 September is one
 * row with `occurrence_date = 2026-10-01` and `received_on = 2026-09-30`, so
 * September's reconciliation sees the cash on the 30th while October never
 * suggests it again (§30.9 item 2).
 *
 * The pair is all-or-nothing, and the partial unique index makes a second
 * acceptance of one occurrence a database conflict rather than a race.
 */

export const incomeSettlement = pgEnum('income_settlement', incomeSettlements);

export const incomeEntries = pgTable(
  'income_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id'),
    occurrenceDate: date('occurrence_date'),
    kind: incomeKind('kind').notNull(),
    /** The financial date. */
    receivedOn: date('received_on').notNull(),
    netAmount: moneyNumeric('net_amount').notNull(),
    grossAmount: moneyNumeric('gross_amount'),
    currency: currencyCodeColumn('currency')
      .notNull()
      .references(() => currencies.code),
    settlement: incomeSettlement('settlement').notNull().default('tracked_cash'),
    cashPositionId: uuid('cash_position_id'),
    cashPositionKind: positionKind('cash_position_kind'),
    propertyPositionId: uuid('property_position_id'),
    propertyPositionKind: positionKind('property_position_kind'),
    investmentPositionId: uuid('investment_position_id'),
    investmentPositionKind: positionKind('investment_position_kind'),
    description: text('description'),
    tags: tagsColumn('tags').notNull().default(sql`'{}'`),
    isOneOff: boolean('is_one_off').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (table) => [
    check('income_entries_net_amount_non_negative', sql`${table.netAmount} >= 0`),
    check(
      'income_entries_gross_amount_non_negative',
      sql`${table.grossAmount} IS NULL OR ${table.grossAmount} >= 0`,
    ),
    // Only investment distributions may be reinvested (7.4, F5).
    check(
      'income_entries_reinvested_is_distribution',
      sql`${table.settlement} <> 'reinvested' OR (${table.investmentPositionId} IS NOT NULL AND ${table.kind} IN ('dividend', 'interest'))`,
    ),
    // A non-tracked settlement has no cash position: it never touched tracked cash.
    check(
      'income_entries_settlement_cash_leg',
      sql`${table.settlement} = 'tracked_cash' OR ${table.cashPositionId} IS NULL`,
    ),
    // Both or neither: a manual flow carries no occurrence, a materialized one
    // carries both (§30.9 item 2). The implication form would allow a third
    // state the partial unique index does not constrain.
    check(
      'income_entries_occurrence_pair',
      sql`(${table.templateId} IS NULL) = (${table.occurrenceDate} IS NULL)`,
    ),
    foreignKey({
      name: 'income_entries_template_fk',
      columns: [table.templateId, table.userId],
      foreignColumns: [recurringTemplates.id, recurringTemplates.userId],
    }),
    ...typedPositionRefConstraints({
      name: 'income_entries_cash_position',
      kind: 'cash',
      idColumn: table.cashPositionId,
      kindColumn: table.cashPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'income_entries_property_position',
      kind: 'property',
      idColumn: table.propertyPositionId,
      kindColumn: table.propertyPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'income_entries_investment_position',
      kind: 'investment',
      idColumn: table.investmentPositionId,
      kindColumn: table.investmentPositionKind,
      userIdColumn: table.userId,
    }),
    // One accepted entry per scheduled occurrence. Partial, so the many manual
    // rows that carry neither column are not accidentally made unique.
    uniqueIndex('income_entries_occurrence_uidx')
      .on(table.templateId, table.occurrenceDate)
      .where(sql`template_id IS NOT NULL AND occurrence_date IS NOT NULL`),
    index('income_entries_user_received_idx').on(table.userId, table.receivedOn),
    index('income_entries_investment_received_idx').on(table.investmentPositionId, table.receivedOn),
    index('income_entries_property_received_idx').on(table.propertyPositionId, table.receivedOn),
    index('income_entries_tags_idx').using('gin', table.tags),
    userOwnedPolicy('income_entries_user_policy'),
  ],
);

export type IncomeEntryRow = typeof incomeEntries.$inferSelect;
export type NewIncomeEntryRow = typeof incomeEntries.$inferInsert;
