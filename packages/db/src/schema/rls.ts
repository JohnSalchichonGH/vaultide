import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole } from 'drizzle-orm/pg-core';

/**
 * Row Level Security primitives (blueprint 17.4, D44).
 *
 * Every user-owned table carries exactly one policy, for the runtime role
 * `app_user`, built by `userOwnedPolicy`. The predicate is written once here so
 * a table can never accidentally ship a weaker variant.
 *
 * `current_setting(…, true)` returns NULL when the GUC was never set and `''`
 * when it was set empty (or reset by a connection pooler); `NULLIF` maps both to
 * NULL, the cast of NULL is NULL, the comparison is NULL, and the policy denies
 * — without a cast error and without ever matching a row. The database
 * therefore fails closed outside `withUser`.
 */

export const CURRENT_USER_SETTING = 'app.current_user_id';

/** The predicate as text, for raw SQL assertions in the security suite. */
export const RLS_USER_PREDICATE =
  "user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid";

/**
 * The runtime role. Marked `.existing()` because roles are created once per
 * environment by the platform-admin bootstrap script (22.2, D45), never by an
 * application migration — a migration cannot create the role it runs as (D45).
 */
export const appUser = pgRole('app_user').existing();

const predicate = sql`user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid`;

/**
 * The one policy every user-owned table gets: `app_user` may read and write
 * only the rows whose `user_id` matches the transaction-local GUC, and may not
 * write a row that would belong to anyone else (`WITH CHECK`).
 */
export function userOwnedPolicy(name: string) {
  return pgPolicy(name, {
    as: 'permissive',
    for: 'all',
    to: appUser,
    using: predicate,
    withCheck: predicate,
  });
}
