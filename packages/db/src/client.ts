import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index';

/**
 * Database connections and the RLS primitive (blueprint 17.4, 22.4).
 *
 * The runtime connects as `app_user`, which is `NOBYPASSRLS` and has no DDL.
 * Every query that touches user data runs inside `withUser`, which sets the
 * transaction-local GUC the RLS policies read. Outside `withUser` the GUC is
 * unset, the policy predicate is NULL and the query returns nothing: the
 * database fails closed.
 */

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The RLS predicate used by every user-owned table (17.4, D44).
 *
 * `current_setting(…, true)` yields NULL when the GUC was never set and `''`
 * when it was set empty or reset by a pooler; `NULLIF` maps both to NULL, the
 * cast of NULL is NULL, the comparison is NULL, and the policy denies — without
 * a cast error and without ever matching a row.
 */
export const RLS_USER_PREDICATE =
  "user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid";

export const CURRENT_USER_SETTING = 'app.current_user_id';

/** Canonical UUID, the only shape `withUser` will ever put into the GUC. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidUserIdError extends Error {
  readonly code = 'INVALID_USER_ID';
  constructor() {
    // The value is never interpolated into the message (18.2).
    super('The request context does not carry a canonical user id.');
    this.name = 'InvalidUserIdError';
  }
}

export interface PoolOptions {
  readonly connectionString: string;
  /** Blueprint 22.4: pooled endpoint, max 5, idle 30 s. */
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly ssl?: pg.PoolConfig['ssl'];
  readonly applicationName?: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    application_name: options.applicationName ?? 'vaultide',
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** The minimum a caller must prove before touching user data. */
export interface UserScope {
  readonly userId: string;
}

/**
 * Run `fn` in one transaction with `app.current_user_id` set for that
 * transaction only (`set_config(…, true)`), which is what makes RLS correct
 * under PgBouncer transaction pooling.
 *
 * This is the **only** code path that sets the GUC, and the id always comes
 * from the authenticated session — never from request input.
 */
export async function withUser<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(scope.userId)) throw new InvalidUserIdError();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${CURRENT_USER_SETTING}, ${scope.userId}::text, true)`,
    );
    return fn(tx);
  });
}

/**
 * Run `fn` in a transaction with **no** user context: global tables only
 * (currencies, fx_rates). Any user-owned table read here returns zero rows,
 * which is exactly how the FX refresh job is prevented from reading across
 * tenants (10.4, R26).
 */
export async function withoutUser<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/** `/api/health` (blueprint 4.2): prove the connection is alive. */
export async function ping(db: Database): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 AS ok`);
  return result.rows.length === 1;
}

export { schema };
