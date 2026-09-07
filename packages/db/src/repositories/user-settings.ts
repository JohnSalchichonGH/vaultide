import { and, eq, sql } from 'drizzle-orm';
import { userSettings } from '../schema/user-settings';
import { withUser, type Database } from '../client';

/**
 * `user_settings` reads and writes (blueprint 6.2, 17.2, 20.3).
 *
 * Every statement runs inside `withUser`, so the database enforces ownership as
 * well as the `WHERE` clause: a query carrying the wrong id returns nothing and
 * an insert carrying the wrong id fails the policy's `WITH CHECK`. The id is
 * always the authenticated user's — no repository here takes one from input.
 */

export type UserSettingsRecord = typeof userSettings.$inferSelect;

export async function findUserSettings(
  db: Database,
  userId: string,
): Promise<UserSettingsRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(userSettings).limit(1),
  );
  return row;
}

export interface UserSettingsPatch {
  baseCurrency?: string;
  reportingCurrency?: string;
  timezone?: string;
  locale?: string;
  favoriteCurrencies?: string[];
  staleInvestmentMonths?: number;
  stalePropertyMonths?: number;
  countAdditionalSpending?: boolean;
}

/**
 * Optimistic update (20.3): the row moves only if its version is still the one
 * the form was rendered from. Zero rows updated means somebody else got there
 * first, and the caller turns that into `CONFLICT_VERSION` with the current
 * values rather than silently overwriting them.
 */
export async function updateUserSettings(
  db: Database,
  userId: string,
  expectedVersion: number,
  patch: UserSettingsPatch,
): Promise<UserSettingsRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .update(userSettings)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(userSettings.userId, userId), eq(userSettings.version, expectedVersion)))
      .returning(),
  );
  return row;
}

/**
 * Merge keys into `preferences` (6.1: JSONB holds UI preferences only).
 *
 * A shallow `||` merge rather than a read-modify-write, so two tabs setting
 * different preferences cannot lose each other's change. `version` is
 * deliberately untouched: a UI preference is not a financial edit and must not
 * invalidate an open settings form.
 */
export async function mergeUserPreferences(
  db: Database,
  userId: string,
  preferences: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .update(userSettings)
      .set({ preferences: sql`${userSettings.preferences} || ${JSON.stringify(preferences)}::jsonb` })
      .where(eq(userSettings.userId, userId))
      .returning({ preferences: userSettings.preferences }),
  );
  return (row?.preferences ?? {}) as Record<string, unknown>;
}
