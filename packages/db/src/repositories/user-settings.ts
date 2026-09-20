import { and, eq, sql } from 'drizzle-orm';
import { userSettings } from '../schema/user-settings';
import { withUser, type Database, type Transaction } from '../client';

/**
 * `user_settings` reads and writes (blueprint 6.2, 17.2, 20.3).
 *
 * Every statement runs inside a user-scoped transaction, so the database
 * enforces ownership as well as the `WHERE` clause: a query carrying the wrong
 * id returns nothing and an insert carrying the wrong id fails the policy's
 * `WITH CHECK`. The id is always the authenticated user's — no repository here
 * takes one from input.
 *
 * One column on this row is a financial input rather than a preference, and the
 * patch types below are what keep the two apart (30.22 item 6).
 */

export type UserSettingsRecord = typeof userSettings.$inferSelect;

export async function findUserSettings(
  db: Database,
  userId: string,
): Promise<UserSettingsRecord | undefined> {
  return withUser(db, { userId }, async (tx) => findUserSettingsIn(tx));
}

/**
 * The same read inside a caller's transaction.
 *
 * `count_additional_spending` is a financial input (12.5, 30.22 item 6), so the
 * write that changes it runs under the per-user write mutex and reads its
 * current state there.
 */
export async function findUserSettingsIn(
  tx: Transaction,
): Promise<UserSettingsRecord | undefined> {
  const [row] = await tx.select().from(userSettings).limit(1);
  return row;
}

/**
 * The display preferences an ordinary settings write may change.
 *
 * Cheap, reversible and visible to the account holder: none of them
 * re-interprets a past figure, so none of them is serialized against financial
 * writes (30.22 item 6).
 */
export interface UserPreferencesPatch {
  baseCurrency?: string;
  reportingCurrency?: string;
  timezone?: string;
  locale?: string;
  favoriteCurrencies?: string[];
  staleInvestmentMonths?: number;
  stalePropertyMonths?: number;
}

/**
 * Those, plus the one **financial input** this row carries.
 *
 * `count_additional_spending` decides whether spending paid from outside
 * tracked accounts reduces personal savings (12.5), so flipping it
 * re-interprets every past month's `PersonalSavings` and `SavingsRate`. Only
 * the transaction-taking writer below accepts this shape, and only a
 * mutex-owned write can reach it — the database-taking wrapper cannot express
 * the field at all.
 */
export interface UserSettingsPatch extends UserPreferencesPatch {
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
  patch: UserPreferencesPatch,
): Promise<UserSettingsRecord | undefined> {
  return withUser(db, { userId }, async (tx) =>
    updateUserSettingsIn(tx, userId, expectedVersion, patch),
  );
}

/**
 * The same update inside a caller's transaction.
 *
 * The wrapper above stays, and is the right one for the display preferences —
 * timezone, locale, favourite and reporting currency, the stale-months
 * thresholds. Those are not financial evidence and are deliberately not
 * serialized against financial writes (30.22 item 6). Only
 * `count_additional_spending` comes through here.
 */
export async function updateUserSettingsIn(
  tx: Transaction,
  userId: string,
  expectedVersion: number,
  patch: UserSettingsPatch,
): Promise<UserSettingsRecord | undefined> {
  const [row] = await tx
    .update(userSettings)
    .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
    .where(and(eq(userSettings.userId, userId), eq(userSettings.version, expectedVersion)))
    .returning();
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
