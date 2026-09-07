import {
  countUserRows,
  findAuthUserById,
  sweepUserRows,
  USER_OWNED_TABLES,
  type Database,
  type UserOwnedTable,
} from '@vaultide/db';
import type { Logger } from '../logging';

export { USER_OWNED_TABLES, type UserOwnedTable };

/**
 * Account deletion (blueprint 18.3, 6.3, Phase 1 acceptance item 8).
 *
 * The mechanism is the schema: every user-owned table carries
 * `user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE` (6.1), so
 * removing the `user` row removes everything keyed to it in one statement.
 * Referential-integrity actions are not subject to RLS, which is why the
 * cascade reaches rows the deleting session could not itself have selected.
 *
 * Two things sit on top of the cascade:
 *
 *  - a **verification** pass, because "the cascade covers every table" is a
 *    claim that has to keep being true as tables are added. The integration
 *    test seeds every user-owned table, deletes the account and asserts zero
 *    rows remain (18.3);
 *  - global rows are **not** deleted. `fx_rates` and `currencies` belong to
 *    nobody and are excluded from user deletion by design (10.4).
 */

export interface PurgeResult {
  readonly userId: string;
  /** Rows that survived the cascade and had to be removed explicitly. */
  readonly swept: Partial<Record<UserOwnedTable, number>>;
  readonly clean: boolean;
}

/** How many rows each user-owned table still holds for a user. */
export async function remainingUserRows(
  db: Database,
  userId: string,
): Promise<Record<UserOwnedTable, number>> {
  return countUserRows(db, userId);
}

/**
 * Belt and braces after Better Auth's `deleteUser` (18.3: "`auth.api.deleteUser`
 * **and** `DELETE FROM "user"`").
 *
 * Called from the `afterDelete` hook. In a correct system it finds nothing and
 * does nothing. If it ever does find something, the rows are removed and the
 * fact is logged as an error — because a half-deleted account is precisely the
 * outcome the deletion promise rules out, and silence would hide it.
 */
export async function purgeUserData(
  db: Database,
  userId: string,
  logger?: Logger,
): Promise<PurgeResult> {
  const before = await remainingUserRows(db, userId);
  const swept = Object.fromEntries(
    Object.entries(before).filter(([, count]) => count > 0),
  ) as Partial<Record<UserOwnedTable, number>>;

  if (Object.keys(swept).length === 0) return { userId, swept: {}, clean: true };

  logger?.error(
    { action: 'users.delete', user_id: userId, error_code: 'INCOMPLETE_CASCADE' },
    'user_rows_survived_cascade',
  );
  await sweepUserRows(db, userId);

  return { userId, swept, clean: false };
}

/** Does the auth user row still exist? Used by the deletion assertions. */
export async function userExists(db: Database, userId: string): Promise<boolean> {
  return (await findAuthUserById(db, userId)) !== undefined;
}
