import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index';
import { CURRENT_USER_SETTING } from './schema/rls';
import {
  WriteLockUnavailableError,
  isLockNotAvailable,
  userWriteLockKey,
  writeLockTimeoutMs,
} from './write-lock';

/**
 * Database connections and the RLS primitive (blueprint 17.4, 22.4).
 *
 * The runtime connects as `app_user`, which is `NOBYPASSRLS` and has no DDL.
 * Every query that touches user data runs inside one of the transactions
 * below — `withUser` for an ordinary read, `withUserWrite` for a financial
 * mutation, `withUserRead` for one coherent read — each of which sets the
 * transaction-local GUC the RLS policies read. Outside them the GUC is unset,
 * the policy predicate is NULL and the query returns nothing: the database
 * fails closed.
 */

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Canonical UUID, the only shape any of them will ever put into the GUC. */
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
 * Set the RLS user context for the current transaction.
 *
 * `set_config(…, true)` is transaction-local, which is what makes RLS correct
 * under PgBouncer transaction pooling. The id always comes from the
 * authenticated session.
 */
async function setUserContext(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config(${CURRENT_USER_SETTING}, ${userId}::text, true)`);
}

export interface UserWriteOptions {
  /**
   * How long to wait for a lock before giving up, in milliseconds. Defaults to
   * the reviewed value, or to `VAULTIDE_WRITE_LOCK_TIMEOUT_MS` where one is
   * configured. Present so a test can provoke the timeout deterministically.
   */
  readonly lockTimeoutMs?: number;
}

/** The bounded pause between the first attempt and the retry (ADR 0010 §7). */
const RETRY_BASE_DELAY_MS = 25;
const RETRY_JITTER_MS = 50;

/**
 * The financial write transaction (blueprint 20.3, 30.22; ADR 0010 §5–§7).
 *
 * **Every ordinary** mutation of Vaultide's mutable financial evidence runs
 * inside one of these — every edit a signed-in user can make to an account that
 * exists. Account bootstrap and account teardown are lifecycle operations with
 * their own contracts and stay outside it (ADR 0010 §4.1).
 *
 * The order of what it does is the contract:
 *
 * ```
 * BEGIN ISOLATION LEVEL READ COMMITTED
 * set app.current_user_id          -- RLS, fail-closed, from the session alone
 * set lock_timeout                 -- transaction-local; no request hangs
 * pg_advisory_xact_lock(<key>)     -- the per-user write mutex
 *
 * -- only now: authoritative reads, reference-dependency locks, row locks,
 * -- version checks, validation, derived decisions, writes, audit
 *
 * COMMIT
 * ```
 *
 * ## Why the lock precedes the first read
 *
 * A mutation that read an existing row, decided something from it, and only
 * then took the mutex would have decided against a state another writer of the
 * same user was free to replace. Locking the write alone serializes the SQL and
 * leaves the decision racy — which is exactly the shape of the valuation
 * defects this primitive was built to repair.
 *
 * ## Why READ COMMITTED
 *
 * After waiting for the mutex, the first authoritative read has to see what the
 * previous holder committed. A `REPEATABLE READ` snapshot is taken at the
 * transaction's first statement — the GUC set-up, *before* the wait — so every
 * read after the wait would be answered from a world that predates the writer
 * we just queued behind. Under `READ COMMITTED` each statement takes a fresh
 * snapshot and sees the truth.
 *
 * The usual objection — that two statements of one transaction can disagree —
 * does not reach the state that matters, because no participating financial
 * writer of this user can commit while the mutex is held. What *can* commit
 * underneath is non-financial: category administration, which is why a
 * financial write that chooses a category locks that row itself (ADR 0010 §9).
 *
 * ## Why a transaction-scoped advisory lock
 *
 * `pg_advisory_xact_lock` is released by `COMMIT`, by `ROLLBACK` and by an
 * error, with no `finally` to forget. A session-scoped lock leaked onto a
 * pooled connection would lock a user out of their own account until that
 * connection was recycled.
 *
 * ## The one retry
 *
 * A `lock_timeout` while waiting — PostgreSQL's `55P03` — rolls the whole
 * transaction back, so nothing was written and nothing outside the database
 * happened: `fn` may perform no external side effect, and the primitive repeats
 * it once after a small jittered pause. A second failure is
 * `WriteLockUnavailableError`, which the application layer turns into
 * `WRITE_BUSY`. Nothing else is retried: a version conflict, a duplicate or a
 * refusal is an answer, not contention.
 */
export async function withUserWrite<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Transaction) => Promise<T>,
  options: UserWriteOptions = {},
): Promise<T> {
  if (!UUID_PATTERN.test(scope.userId)) throw new InvalidUserIdError();

  const key = userWriteLockKey(scope.userId).toString();
  const timeout = `${String(options.lockTimeoutMs ?? writeLockTimeoutMs())}ms`;

  const attempt = async (): Promise<T> =>
    db.transaction(
      async (tx) => {
        await setUserContext(tx, scope.userId);
        // `set_config` rather than SQL text: the value is a parameter, and the
        // setting is transaction-local so it cannot escape onto a pooled
        // connection (17.3 bans `sql.raw` outside migrations for this reason).
        await tx.execute(sql`SELECT set_config('lock_timeout', ${timeout}, true)`);
        // The key is sent as text and cast, so no driver has to decide what a
        // JavaScript `bigint` parameter means.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);
        return fn(tx);
      },
      { isolationLevel: 'read committed' },
    );

  try {
    return await attempt();
  } catch (error) {
    if (!isLockNotAvailable(error)) throw error;
  }

  await new Promise((resolve) =>
    setTimeout(resolve, RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS)),
  );

  try {
    return await attempt();
  } catch (error) {
    if (isLockNotAvailable(error)) throw new WriteLockUnavailableError();
    throw error;
  }
}

/**
 * One coherent user-scoped read (blueprint 20.3, 30.22; ADR 0010 §8).
 *
 * `REPEATABLE READ`, `READ ONLY`, the RLS context, and **no** write mutex: every
 * statement inside sees the same snapshot, so several questions about one state
 * of the world cannot be answered from two different worlds. `READ ONLY` is the
 * database enforcing what the name promises — an accidental write inside fails
 * rather than succeeding quietly.
 *
 * It takes no mutex and therefore blocks no writer, and a writer does not block
 * it. Built for the correction preview a later slice adds; ordinary reads keep
 * using `withUser`, and this is not a reason to migrate them.
 */
export async function withUserRead<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(scope.userId)) throw new InvalidUserIdError();

  return db.transaction(
    async (tx) => {
      // Permitted in a read-only transaction: a transaction-local GUC is not a
      // write to any table.
      await setUserContext(tx, scope.userId);
      return fn(tx);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
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

/**
 * The few Drizzle helpers callers outside this package legitimately need.
 *
 * Re-exported rather than imported directly by `@vaultide/application` and its
 * tests, so exactly one copy of Drizzle is ever loaded. Two copies type-check
 * against each other as unrelated classes and fail at the first `sql` template
 * that crosses the boundary — a confusing failure with a boring cause.
 */
export { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
