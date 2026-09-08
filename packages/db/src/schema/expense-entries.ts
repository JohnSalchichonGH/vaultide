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
import { expenseSettlements } from '@vaultide/validation';
import { authUser } from './auth';
import { categories } from './categories';
import { currencyCodeColumn, moneyNumeric, tagsColumn, timestamps, version } from './columns';
import { currencies } from './currencies';
import { positionKind } from './positions';
import { recurringTemplates } from './recurring-templates';
import { userOwnedPolicy } from './rls';
import { transfers } from './transfers';
import { typedPositionRefConstraints } from './typed-position-ref';

/**
 * `expense_entries` (blueprint 6.2, 7.4, R24, M14).
 *
 * Money going out — and the table where the difference between three things
 * people casually call "an expense" is kept honest by `settlement`:
 *
 *  - `tracked_cash` left a tracked account, so it is the known expense `K` of
 *    the reconciliation identity and decomposes the inferred total rather than
 *    adding to it;
 *  - `untracked_self` is the user's own spending from outside tracked accounts:
 *    no cash leg, never in the identity, counted in `AdditionalSpending` and in
 *    total spending;
 *  - `third_party` was paid by somebody else: informational, in no total, in no
 *    savings figure and in no projection baseline.
 *
 * Collapsing the last two would silently move somebody else's money into the
 * user's spending, which is why they are separate values and not a boolean.
 *
 * The `category_id` is not decoration either: its `kind` fixes the accounting
 * bucket (7.4), which is why it is `NOT NULL`, why the reference is `NO ACTION`
 * (a category in use cannot be deleted), and why no editor may change a
 * category's kind after the fact.
 *
 * A `transfer_id` marks the single expense row that represents a transfer's fee
 * (M14). The database cascade behind it is a structural safeguard for account
 * deletion; the ordinary product path deletes the fee explicitly first so its
 * audit before-image is written (6.3, 18.1).
 */

export const expenseSettlement = pgEnum('expense_settlement', expenseSettlements);

export const expenseEntries = pgTable(
  'expense_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id'),
    occurrenceDate: date('occurrence_date'),
    categoryId: uuid('category_id').notNull(),
    /** The financial date. */
    incurredOn: date('incurred_on').notNull(),
    amount: moneyNumeric('amount').notNull(),
    currency: currencyCodeColumn('currency')
      .notNull()
      .references(() => currencies.code),
    settlement: expenseSettlement('settlement').notNull().default('tracked_cash'),
    cashPositionId: uuid('cash_position_id'),
    cashPositionKind: positionKind('cash_position_kind'),
    propertyPositionId: uuid('property_position_id'),
    propertyPositionKind: positionKind('property_position_kind'),
    investmentPositionId: uuid('investment_position_id'),
    investmentPositionKind: positionKind('investment_position_kind'),
    otherAssetPositionId: uuid('other_asset_position_id'),
    otherAssetPositionKind: positionKind('other_asset_position_kind'),
    /** Set only on the one expense row that is a transfer's fee (M14). */
    transferId: uuid('transfer_id'),
    /** Phase 6: the user's explicit estimate of market value added. */
    valueAddEstimate: moneyNumeric('value_add_estimate'),
    description: text('description'),
    tags: tagsColumn('tags').notNull().default(sql`'{}'`),
    isOneOff: boolean('is_one_off').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (table) => [
    check('expense_entries_amount_positive', sql`${table.amount} > 0`),
    check(
      'expense_entries_deducted_from_asset',
      sql`${table.settlement} <> 'deducted_from_asset' OR ${table.investmentPositionId} IS NOT NULL`,
    ),
    check(
      'expense_entries_settlement_cash_leg',
      sql`${table.settlement} = 'tracked_cash' OR ${table.cashPositionId} IS NULL`,
    ),
    check(
      'expense_entries_value_add_needs_asset',
      sql`${table.valueAddEstimate} IS NULL OR ${table.propertyPositionId} IS NOT NULL OR ${table.otherAssetPositionId} IS NOT NULL`,
    ),
    check(
      'expense_entries_value_add_non_negative',
      sql`${table.valueAddEstimate} IS NULL OR ${table.valueAddEstimate} >= 0`,
    ),
    check(
      'expense_entries_occurrence_pair',
      sql`(${table.templateId} IS NULL) = (${table.occurrenceDate} IS NULL)`,
    ),
    foreignKey({
      name: 'expense_entries_template_fk',
      columns: [table.templateId, table.userId],
      foreignColumns: [recurringTemplates.id, recurringTemplates.userId],
    }),
    foreignKey({
      name: 'expense_entries_category_fk',
      columns: [table.categoryId, table.userId],
      foreignColumns: [categories.id, categories.userId],
    }),
    foreignKey({
      name: 'expense_entries_transfer_fk',
      columns: [table.transferId, table.userId],
      foreignColumns: [transfers.id, transfers.userId],
    }).onDelete('cascade'),
    ...typedPositionRefConstraints({
      name: 'expense_entries_cash_position',
      kind: 'cash',
      idColumn: table.cashPositionId,
      kindColumn: table.cashPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'expense_entries_property_position',
      kind: 'property',
      idColumn: table.propertyPositionId,
      kindColumn: table.propertyPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'expense_entries_investment_position',
      kind: 'investment',
      idColumn: table.investmentPositionId,
      kindColumn: table.investmentPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'expense_entries_other_asset_position',
      kind: 'other_asset',
      idColumn: table.otherAssetPositionId,
      kindColumn: table.otherAssetPositionKind,
      userIdColumn: table.userId,
    }),
    uniqueIndex('expense_entries_occurrence_uidx')
      .on(table.templateId, table.occurrenceDate)
      .where(sql`template_id IS NOT NULL AND occurrence_date IS NOT NULL`),
    index('expense_entries_user_incurred_idx').on(table.userId, table.incurredOn),
    index('expense_entries_category_idx').on(table.categoryId),
    index('expense_entries_property_incurred_idx').on(table.propertyPositionId, table.incurredOn),
    index('expense_entries_transfer_idx').on(table.transferId),
    index('expense_entries_tags_idx').using('gin', table.tags),
    userOwnedPolicy('expense_entries_user_policy'),
  ],
);

export type ExpenseEntryRow = typeof expenseEntries.$inferSelect;
export type NewExpenseEntryRow = typeof expenseEntries.$inferInsert;
