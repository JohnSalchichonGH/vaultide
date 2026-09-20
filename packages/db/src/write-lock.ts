/**
 * The per-user financial write mutex: its key, its timeout and its failure
 * (blueprint 20.3, 30.22; ADR 0010 §5–§7).
 *
 * Nothing here talks to a database. It is the arithmetic and the configuration
 * `withUserWrite` needs, kept apart so both can be tested without one.
 */

/**
 * The namespace every Vaultide write-mutex key is folded against.
 *
 * The ASCII bytes of `VAULTIDE`, read as a big-endian 64-bit integer:
 * `0x56 41 55 4C 54 49 44 45`. A readable constant rather than an unexplained
 * random number — a reader can check where it came from, and its top bit is
 * clear, so it is a positive `bigint` before the fold.
 *
 * It exists so that two products sharing one PostgreSQL cluster, or a future
 * second Vaultide advisory lock, cannot collide on a key derived from the same
 * user id. Changing it changes every key, so it never changes.
 */
export const WRITE_LOCK_NAMESPACE = 0x5641554c54494445n;

const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIXTY_FOUR_BITS = (1n << 64n) - 1n;

export class InvalidLockKeyInputError extends Error {
  readonly code = 'INVALID_LOCK_KEY_INPUT';
  constructor() {
    // The value is never interpolated into the message (blueprint 18.2).
    super('A write-lock key can only be derived from a canonical UUID.');
    this.name = 'InvalidLockKeyInputError';
  }
}

/**
 * The advisory-lock key for one user.
 *
 * `pg_advisory_xact_lock(bigint)` takes one signed 64-bit key, and a UUID is
 * 128 bits, so the two halves are XOR-folded together and then XORed with the
 * namespace above. `BigInt.asIntN` reinterprets the result as signed, which is
 * what PostgreSQL's `bigint` is: a key whose high bit is set becomes a negative
 * number rather than being rejected as out of range.
 *
 * Deterministic by construction — the same id always produces the same key, on
 * every deployment and in every test. Deliberately **not** PostgreSQL's
 * `hashtext()`: that is an implementation detail whose value carries no
 * cross-version guarantee, and this key has to be stable for as long as the
 * product is.
 *
 * Two different users colliding on one key would serialize their writes against
 * each other. That is a liveness cost at 1 in 2^64, not a correctness one, and
 * it does not justify a cryptographic construction.
 */
export function userWriteLockKey(userId: string): bigint {
  if (!UUID_HEX.test(userId)) throw new InvalidLockKeyInputError();

  const bits = BigInt(`0x${userId.replace(/-/gu, '')}`);
  const hi = bits >> 64n;
  const lo = bits & SIXTY_FOUR_BITS;

  return BigInt.asIntN(64, (hi ^ lo) ^ WRITE_LOCK_NAMESPACE);
}

/**
 * How long a financial write waits for a lock before giving up (ADR 0010 §7).
 *
 * The reviewed default is in the code, so deploying the mutex needs no
 * environment change anywhere. The override exists for operations and for the
 * tests that have to provoke a timeout deterministically instead of by
 * sleeping.
 */
export const DEFAULT_WRITE_LOCK_TIMEOUT_MS = 1_500;

export const WRITE_LOCK_TIMEOUT_ENV_VAR = 'VAULTIDE_WRITE_LOCK_TIMEOUT_MS';

const MIN_WRITE_LOCK_TIMEOUT_MS = 50;
const MAX_WRITE_LOCK_TIMEOUT_MS = 60_000;

/**
 * The configured wait, or the safe default.
 *
 * An unset variable is the default; a value that is not a whole number of
 * milliseconds inside the permitted band is a configuration error and is
 * refused loudly rather than silently falling back — a financial write that
 * waits forever, or not at all, is not something to discover in production.
 */
export function writeLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WRITE_LOCK_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_WRITE_LOCK_TIMEOUT_MS;

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_WRITE_LOCK_TIMEOUT_MS ||
    value > MAX_WRITE_LOCK_TIMEOUT_MS
  ) {
    throw new Error(
      `${WRITE_LOCK_TIMEOUT_ENV_VAR} must be a whole number of milliseconds between ${String(MIN_WRITE_LOCK_TIMEOUT_MS)} and ${String(MAX_WRITE_LOCK_TIMEOUT_MS)}.`,
    );
  }
  return value;
}

/** PostgreSQL's `lock_not_available`: a `lock_timeout` expired while waiting. */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Was this failure a lock timeout?
 *
 * Drizzle wraps the driver error, so the SQLSTATE sits on `cause` rather than
 * on what was thrown. The chain is walked rather than assumed to be one deep —
 * the same shape `isUniqueViolation` already needs, and for the same reason:
 * reading only the outermost error would make the retry silently unreachable.
 */
export function isLockNotAvailable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The write mutex could not be taken, twice.
 *
 * A `db`-level error on purpose: this package may not import the application's
 * error taxonomy (blueprint section 19), so it raises its own and
 * `@vaultide/application` maps it to `WRITE_BUSY` in exactly one place.
 */
export class WriteLockUnavailableError extends Error {
  readonly code = 'WRITE_LOCK_UNAVAILABLE';
  constructor() {
    super('The write lock for this user could not be acquired.');
    this.name = 'WriteLockUnavailableError';
  }
}

export function isWriteLockUnavailable(error: unknown): error is WriteLockUnavailableError {
  return error instanceof WriteLockUnavailableError;
}
