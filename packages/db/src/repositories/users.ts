import { eq, sql } from 'drizzle-orm';
import { authUser } from '../schema/auth';
import { categories } from '../schema/categories';
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
 * Phase 1 owns three. Each later phase adds its tables here, and the deletion
 * test cross-checks this list against the live schema — so a table that exists
 * without being listed fails the suite rather than quietly surviving deletion.
 */
export const USER_OWNED_TABLES = ['user_settings', 'categories', 'tags'] as const;
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
    const [settings] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    const [categoryRows] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(categories)
      .where(eq(categories.userId, userId));
    const [tagRows] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tags)
      .where(eq(tags.userId, userId));

    return {
      user_settings: settings?.n ?? 0,
      categories: categoryRows?.n ?? 0,
      tags: tagRows?.n ?? 0,
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
    await tx.delete(categories).where(eq(categories.userId, userId));
    await tx.delete(tags).where(eq(tags.userId, userId));
    await tx.delete(userSettings).where(eq(userSettings.userId, userId));
  });
}
