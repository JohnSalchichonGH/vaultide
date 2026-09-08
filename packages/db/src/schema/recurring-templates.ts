import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { incomeKinds, recurrenceFrequencies, templateKinds } from '@vaultide/validation';
import { authUser } from './auth';
import { categories } from './categories';
import { currencyCodeColumn, moneyNumeric, timestamps, version } from './columns';
import { currencies } from './currencies';
import { positionKind } from './positions';
import { userOwnedPolicy } from './rls';
import { typedPositionRefConstraints } from './typed-position-ref';

/**
 * `recurring_templates` (blueprint 6.2, 15.3, v2.1.6 §30.9).
 *
 * A template is a **suggestion generator**, not a schedule of facts. Nothing it
 * describes exists financially until the user accepts an occurrence, and the
 * engine that turns a template into occurrences is pure (`@vaultide/finance`).
 *
 * Three rules the table cannot state for itself, all enforced in the domain:
 *
 *  - **Settlement.** There is no settlement column, so in Phase 3 a template
 *    materializes **tracked-cash flows only** (§30.9 item 1). Settlement is
 *    never inferred from `cash_position_id` being NULL — 8.1 says a tracked
 *    flow with a null cash leg is an ordinary tracked flow awaiting attribution,
 *    not an untracked one.
 *  - **Fixed-anchor occurrences.** The anchor day is clamped independently into
 *    each target month and never derived from the previous occurrence, and
 *    occurrences outside `start_date`/`end_date` are discarded without moving
 *    the anchor.
 *  - **Frozen identity.** Once an occurrence has been materialized or skipped,
 *    the fields that decide what the past contained cannot change; a real
 *    schedule change is a new template.
 */

export const templateKind = pgEnum('template_kind', templateKinds);
export const incomeKind = pgEnum('income_kind', incomeKinds);
export const recurrenceFrequency = pgEnum('recurrence_frequency', recurrenceFrequencies);

export const recurringTemplates = pgTable(
  'recurring_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: templateKind('kind').notNull(),
    name: text('name').notNull(),
    counterparty: text('counterparty'),
    incomeKind: incomeKind('income_kind'),
    categoryId: uuid('category_id'),
    currency: currencyCodeColumn('currency')
      .notNull()
      .references(() => currencies.code),
    frequency: recurrenceFrequency('frequency').notNull(),
    /** The anchor day; NULL means "use `start_date`'s day" (§30.9 item 3). */
    dayOfMonth: smallint('day_of_month'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    cashPositionId: uuid('cash_position_id'),
    cashPositionKind: positionKind('cash_position_kind'),
    propertyPositionId: uuid('property_position_id'),
    propertyPositionKind: positionKind('property_position_kind'),
    /** Phase 4 owns the contribution workflow; Phase 3 writes no such template. */
    targetInvestmentPositionId: uuid('target_investment_position_id'),
    targetInvestmentPositionKind: positionKind('target_investment_position_kind'),
    /** Retirement is archiving; a referenced template is never hard-deleted (6.3). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (table) => [
    unique('recurring_templates_id_user_id_key').on(table.id, table.userId),
    check('recurring_templates_income_kind', sql`(${table.kind} = 'income') = (${table.incomeKind} IS NOT NULL)`),
    check(
      'recurring_templates_no_special_income_kind',
      sql`${table.incomeKind} IS NULL OR ${table.incomeKind} NOT IN ('external_inflow', 'adjustment')`,
    ),
    check(
      'recurring_templates_expense_has_category',
      sql`${table.kind} <> 'expense' OR ${table.categoryId} IS NOT NULL`,
    ),
    check(
      'recurring_templates_contribution_has_target',
      sql`${table.kind} <> 'contribution' OR ${table.targetInvestmentPositionId} IS NOT NULL`,
    ),
    check(
      'recurring_templates_day_of_month_range',
      sql`${table.dayOfMonth} IS NULL OR (${table.dayOfMonth} BETWEEN 1 AND 31)`,
    ),
    // A timeless relation between two stored dates, so it is a CHECK; the rule
    // that `end_date` may not erase a referenced occurrence is about other rows
    // and lives in the domain.
    check(
      'recurring_templates_dates_ordered',
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
    foreignKey({
      name: 'recurring_templates_category_fk',
      columns: [table.categoryId, table.userId],
      foreignColumns: [categories.id, categories.userId],
    }),
    ...typedPositionRefConstraints({
      name: 'recurring_templates_cash_position',
      kind: 'cash',
      idColumn: table.cashPositionId,
      kindColumn: table.cashPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'recurring_templates_property_position',
      kind: 'property',
      idColumn: table.propertyPositionId,
      kindColumn: table.propertyPositionKind,
      userIdColumn: table.userId,
    }),
    ...typedPositionRefConstraints({
      name: 'recurring_templates_target_investment_position',
      kind: 'investment',
      idColumn: table.targetInvestmentPositionId,
      kindColumn: table.targetInvestmentPositionKind,
      userIdColumn: table.userId,
    }),
    index('recurring_templates_user_kind_idx').on(table.userId, table.kind, table.archivedAt),
    userOwnedPolicy('recurring_templates_user_policy'),
  ],
);

export type RecurringTemplateRow = typeof recurringTemplates.$inferSelect;
export type NewRecurringTemplateRow = typeof recurringTemplates.$inferInsert;

/**
 * `recurring_template_terms` (6.2) — the template's amount over time.
 *
 * Amounts are versioned rather than frozen with the rest of the template: "from
 * this month on" writes a row here with `effective_from` at the occurrence's
 * scheduled date, and the term of an occurrence is the row with the greatest
 * `effective_from ≤ occurrence_date` — the **scheduled** identity, never the
 * flow's financial date (§30.9 item 4). Adding a later term never rewrites an
 * already materialized flow.
 */
export const recurringTemplateTerms = pgTable(
  'recurring_template_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    amount: moneyNumeric('amount').notNull(),
    grossAmount: moneyNumeric('gross_amount'),
    note: text('note'),
    ...timestamps,
    ...version,
  },
  (table) => [
    unique('recurring_template_terms_template_effective_key').on(
      table.templateId,
      table.effectiveFrom,
    ),
    foreignKey({
      name: 'recurring_template_terms_template_fk',
      columns: [table.templateId, table.userId],
      foreignColumns: [recurringTemplates.id, recurringTemplates.userId],
    }).onDelete('cascade'),
    check('recurring_template_terms_amount_non_negative', sql`${table.amount} >= 0`),
    check(
      'recurring_template_terms_gross_non_negative',
      sql`${table.grossAmount} IS NULL OR ${table.grossAmount} >= 0`,
    ),
    index('recurring_template_terms_template_effective_idx').on(
      table.templateId,
      table.effectiveFrom.desc(),
    ),
    userOwnedPolicy('recurring_template_terms_user_policy'),
  ],
);

export type RecurringTemplateTermRow = typeof recurringTemplateTerms.$inferSelect;
export type NewRecurringTemplateTermRow = typeof recurringTemplateTerms.$inferInsert;
