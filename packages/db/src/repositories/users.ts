import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { auditEntries } from '../schema/audit';
import { authUser } from '../schema/auth';
import { cashAccounts } from '../schema/cash-accounts';
import { categories } from '../schema/categories';
import { otherAssets } from '../schema/other-assets';
import { positions } from '../schema/positions';
import { positionValuations } from '../schema/position-valuations';
import { tags } from '../schema/tags';
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
 * Phase 1 owned three; Phase 2 adds the financial core and the audit trail.
 * Each later phase adds its tables here, and the deletion test cross-checks
 * this list against the live schema — so a table that exists without being
 * listed fails the suite rather than quietly surviving deletion.
 */
export const USER_OWNED_TABLES = [
  'audit_entries',
  'cash_accounts',
  'categories',
  'other_assets',
  'position_valuations',
  'positions',
  'tags',
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
      other_assets: await count(otherAssets, otherAssets.userId),
      position_valuations: await count(positionValuations, positionValuations.userId),
      positions: await count(positions, positions.userId),
      tags: await count(tags, tags.userId),
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
