import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { cashAccountTypes } from '@vaultide/validation';
import { authUser } from './auth';
import { timestamps } from './columns';
import { positionKind, positions } from './positions';
import { userOwnedPolicy } from './rls';

/**
 * `cash_accounts` (blueprint 6.2) — the cash subtype of `positions`.
 *
 * The typed reference pattern of 6.1 in full: a constant `kind` column pinned
 * to `'cash'` by a CHECK, and a composite foreign key on
 * `(position_id, user_id, kind)`. The database therefore refuses to make a
 * property or a liability into a cash account, and refuses to attach this row
 * to another tenant's position — both without trusting a line of application
 * code.
 */

export const cashAccountType = pgEnum('cash_account_type', cashAccountTypes);

export const cashAccounts = pgTable(
  'cash_accounts',
  {
    positionId: uuid('position_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: positionKind('kind').notNull().default('cash'),
    accountType: cashAccountType('account_type').notNull(),
    institution: text('institution'),
    /**
     * A dormant account carries at zero without a monthly confirmation (R22,
     * 8.1 `dormant_zero`). It is settable only while the account's latest
     * balance is exactly zero, and the service clears it the moment a non-zero
     * balance is recorded — otherwise a forgotten flag would quietly assert
     * "still zero" about an account that is not.
     */
    isDormant: boolean('is_dormant').notNull().default(false),
    /**
     * Where the **current** dormant episode starts (8.8, v2.1.17 30.20, ADR
     * 0007): the `valued_on` of the zero balance that justified it — never the
     * day the flag was set. `is_dormant` says the account is dormant now; this
     * says from when, and a structural zero is permitted only on or after it.
     * An ended episode is not remembered: waking clears both columns.
     */
    dormantFrom: date('dormant_from'),
    ...timestamps,
  },
  (table) => [
    check('cash_accounts_kind_is_cash', sql`${table.kind} = 'cash'`),
    // The flag and the date are one fact in two columns, and neither may be
    // written without the other.
    check(
      'cash_accounts_dormant_anchor',
      sql`${table.isDormant} = (${table.dormantFrom} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'cash_accounts_position_fk',
      columns: [table.positionId, table.userId, table.kind],
      foreignColumns: [positions.id, positions.userId, positions.kind],
    }),
    index('cash_accounts_user_idx').on(table.userId),
    userOwnedPolicy('cash_accounts_user_policy'),
  ],
);

export type CashAccountRow = typeof cashAccounts.$inferSelect;
export type NewCashAccountRow = typeof cashAccounts.$inferInsert;
