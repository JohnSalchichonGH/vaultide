import {
  isWriteLockUnavailable,
  withUserRead as withUserReadTransaction,
  withUserWrite as withUserWriteTransaction,
  type Database,
  type Transaction,
  type UserScope,
  type UserWriteOptions,
} from '@vaultide/db';
import { WriteBusyError } from './errors';

/**
 * Financial write coordination, at the application boundary (blueprint 20.3,
 * 30.22; ADR 0010 §3, §5–§8).
 *
 * `@vaultide/db` owns the transaction: read committed, the RLS context, the
 * transaction-local lock timeout, the per-user advisory mutex before the first
 * authoritative read, and the one retry. It may not import this package's error
 * taxonomy (section 19), so it raises its own `WriteLockUnavailableError` and
 * this module is the **single** place that turns it into `WRITE_BUSY`.
 *
 * That is why mutation services import `withUserWrite` from here and never from
 * `@vaultide/db`: the db primitive would work, and would surface a database
 * error nobody mapped. `financial-write-boundary.test.ts` enforces the import
 * source along with everything else about the boundary.
 *
 * This wrapper adds nothing else. It does not begin a second transaction, it
 * does not catch a domain error, and it does not retry one: a version conflict,
 * a duplicate, a validation failure and a refusal are answers, and a caller
 * that repeated them would repeat them forever.
 */
export async function withUserWrite<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Transaction) => Promise<T>,
  options: UserWriteOptions = {},
): Promise<T> {
  try {
    return await withUserWriteTransaction(db, scope, fn, options);
  } catch (error) {
    if (isWriteLockUnavailable(error)) throw new WriteBusyError();
    throw error;
  }
}

/**
 * One coherent user-scoped read: repeatable read, read only, no write mutex.
 *
 * Re-exported through this module so the whole coordination contract is
 * readable in one place, and so the later correction preview reaches it exactly
 * as the mutations reach `withUserWrite`. It takes no lock, so it has nothing
 * to map: a failure inside it is the caller's own.
 */
export async function withUserRead<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withUserReadTransaction(db, scope, fn);
}
