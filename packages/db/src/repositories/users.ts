import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { auditEntries } from '../schema/audit';
import { authUser } from '../schema/auth';
import { cashAccounts } from '../schema/cash-accounts';
import { categories } from '../schema/categories';
import { expenseEntries } from '../schema/expense-entries';
import { incomeEntries } from '../schema/income-entries';
import { monthReviews } from '../schema/month-reviews';
import { otherAssets } from '../schema/other-assets';
import { positions } from '../schema/positions';
import { positionValuations } from '../schema/position-valuations';
import { recurringTemplateSkips } from '../schema/recurring-template-skips';
import {
  recurringTemplateTerms,
  recurringTemplates,
} from '../schema/recurring-templates';
import { tags } from '../schema/tags';
import { transfers } from '../schema/transfers';
import { userSettings } from '../schema/user-settings';
import { withUser, withoutUser, type Database } from '../client';

/**
 * User lifecycle queries (blueprint 18.3, 6.3).
 *
 * `findAuthUserById` reads the Better Auth `user` table, which has no RLS, so
 * it runs without a user context. The per-user counts and the sweep run inside
 * `withUser`: those tables **do** have RLS, and a query without the GUC would
 * come back empty and make an unfinished deletion look complete. Setting the
 * GUC to a deleted user's id is well defined — the policy compares `user_id`
 * against the setting and does not care whether that user still exists — so the
 * counts are taken in exactly the scope the user themselves would have had.
 */

/**
 * Every user-owned table, with the column that ties a row to its owner.
 *
 * Phase 1 owned three; Phase 2 added the financial core and the audit trail;
 * Phase 3 adds the flow tables.
 * Each later phase adds its tables here, and the deletion test cross-checks
 * this list against the live schema — so a table that exists without being
 * listed fails the suite rather than quietly surviving deletion.
 */
export const USER_OWNED_TABLES = [
  'audit_entries',
  'cash_accounts',
  'categories',
  'expense_entries',
  'income_entries',
  'month_reviews',
  'other_assets',
  'position_valuations',
  'positions',
  'recurring_template_skips',
  'recurring_template_terms',
  'recurring_templates',
  'tags',
  'transfers',
  'user_settings',
] as const;
export type UserOwnedTable = (typeof USER_OWNED_TABLES)[number];

export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
}

export async function findAuthUserById(
  db: Database,
  userId: string,
): Promise<AuthUserRecord | undefined> {
  const [row] = await withoutUser(db, async (tx) =>
    tx
      .select({
        id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        emailVerified: authUser.emailVerified,
        twoFactorEnabled: authUser.twoFactorEnabled,
      })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .limit(1),
  );
  return row === undefined
    ? undefined
    : { ...row, twoFactorEnabled: row.twoFactorEnabled === true };
}

/** How many rows each user-owned table still holds for a user. */
export async function countUserRows(
  db: Database,
  userId: string,
): Promise<Record<UserOwnedTable, number>> {
  return withUser(db, { userId }, async (tx) => {
    const count = async (table: PgTable, column: PgColumn): Promise<number> => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(column, userId));
      return row?.n ?? 0;
    };

    return {
      audit_entries: await count(auditEntries, auditEntries.userId),
      cash_accounts: await count(cashAccounts, cashAccounts.userId),
      categories: await count(categories, categories.userId),
      expense_entries: await count(expenseEntries, expenseEntries.userId),
      income_entries: await count(incomeEntries, incomeEntries.userId),
      month_reviews: await count(monthReviews, monthReviews.userId),
      other_assets: await count(otherAssets, otherAssets.userId),
      position_valuations: await count(positionValuations, positionValuations.userId),
      positions: await count(positions, positions.userId),
      recurring_template_skips: await count(recurringTemplateSkips, recurringTemplateSkips.userId),
      recurring_template_terms: await count(recurringTemplateTerms, recurringTemplateTerms.userId),
      recurring_templates: await count(recurringTemplates, recurringTemplates.userId),
      tags: await count(tags, tags.userId),
      transfers: await count(transfers, transfers.userId),
      user_settings: await count(userSettings, userSettings.userId),
    };
  });
}

/**
 * Remove any user-owned row the `ON DELETE CASCADE` from `"user"` left behind.
 *
 * In a correct schema this deletes nothing. It exists so that "deleted" is a
 * checked claim rather than a trusted one (18.3), and so the failure mode of a
 * future table added without a cascading foreign key is a swept row and a
 * logged error rather than an orphan nobody notices.
 */
export async function sweepUserRows(db: Database, userId: string): Promise<void> {
  await withUser(db, { userId }, async (tx) => {
    // Dependency order: children before the parents they reference through a
    // `NO ACTION` foreign key (6.1, 6.3).
    // Flows first: they reference categories, positions, transfers and
    // templates through `NO ACTION` keys, so nothing they point at can go
    // until they have.
    await tx.delete(expenseEntries).where(eq(expenseEntries.userId, userId));
    await tx.delete(transfers).where(eq(transfers.userId, userId));
    await tx.delete(incomeEntries).where(eq(incomeEntries.userId, userId));
    await tx.delete(recurringTemplateSkips).where(eq(recurringTemplateSkips.userId, userId));
    await tx.delete(recurringTemplateTerms).where(eq(recurringTemplateTerms.userId, userId));
    await tx.delete(recurringTemplates).where(eq(recurringTemplates.userId, userId));
    await tx.delete(monthReviews).where(eq(monthReviews.userId, userId));
    await tx.delete(positionValuations).where(eq(positionValuations.userId, userId));
    await tx.delete(cashAccounts).where(eq(cashAccounts.userId, userId));
    await tx.delete(otherAssets).where(eq(otherAssets.userId, userId));
    await tx.delete(positions).where(eq(positions.userId, userId));
    await tx.delete(categories).where(eq(categories.userId, userId));
    await tx.delete(tags).where(eq(tags.userId, userId));
    await tx.delete(auditEntries).where(eq(auditEntries.userId, userId));
    await tx.delete(userSettings).where(eq(userSettings.userId, userId));
  });
}
