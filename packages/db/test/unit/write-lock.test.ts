import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WRITE_LOCK_TIMEOUT_MS,
  InvalidLockKeyInputError,
  LOCK_NOT_AVAILABLE,
  WRITE_LOCK_NAMESPACE,
  WRITE_LOCK_TIMEOUT_ENV_VAR,
  WriteLockUnavailableError,
  isLockNotAvailable,
  isWriteLockUnavailable,
  userWriteLockKey,
  writeLockTimeoutMs,
} from '../../src/write-lock';

/**
 * The per-user write-mutex key and its configuration (blueprint 20.3, 30.22;
 * ADR 0010 §7).
 *
 * The key is a contract, not an implementation detail: it has to mean the same
 * thing on every deployment, in every process and in every test, for as long as
 * the product exists. That is what these cases pin down.
 */

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
/** Differs from `USER_A` in one hex digit of the low half only. */
const USER_A_NEIGHBOUR = '11111111-1111-4111-8111-111111111112';
/** Its two 64-bit halves are equal, so the XOR fold alone would give zero. */
const SELF_CANCELLING = '89ab4def-89ab-4def-89ab-4def89ab4def';
/** Folds to a value whose bit 63 is set — a key PostgreSQL must see as negative. */
const HIGH_BIT = '0fffffff-ffff-4fff-8fff-000000000000';

describe('the per-user write-lock key (30.22, ADR 0010 §7)', () => {
  it('is the same key for the same user, every time', () => {
    expect(userWriteLockKey(USER_A)).toBe(userWriteLockKey(USER_A));
    // Not "stable within one process": a literal, so a change to the
    // derivation has to be a deliberate edit to this line.
    expect(userWriteLockKey(USER_A).toString()).toBe(
      BigInt.asIntN(
        64,
        (0x11111111_1111_4111n ^ 0x8111_111111111111n) ^ WRITE_LOCK_NAMESPACE,
      ).toString(),
    );
  });

  it('reads the case of a UUID as the same id', () => {
    expect(userWriteLockKey(USER_A.toUpperCase())).toBe(userWriteLockKey(USER_A));
  });

  it('gives different users different keys', () => {
    const keys = [USER_A, USER_B, USER_A_NEIGHBOUR, SELF_CANCELLING, HIGH_BIT].map(userWriteLockKey);
    expect(new Set(keys.map(String)).size).toBe(keys.length);
  });

  it('never folds an id down to the namespace itself', () => {
    // A UUID whose halves are equal XOR-folds to zero, so without the namespace
    // it would share a key with every other such id — and with key 0, which is
    // what an uninitialised variable looks like.
    expect(userWriteLockKey(SELF_CANCELLING)).toBe(BigInt.asIntN(64, WRITE_LOCK_NAMESPACE));
    expect(userWriteLockKey(SELF_CANCELLING)).not.toBe(0n);
  });

  it('stays inside signed 64 bits, and goes negative when the high bit is set', () => {
    // `pg_advisory_xact_lock(bigint)` takes a **signed** key. An id whose fold
    // sets bit 63 must arrive as a negative number rather than as a value
    // PostgreSQL refuses as out of range.
    expect(userWriteLockKey(HIGH_BIT)).toBeLessThan(0n);

    for (const id of [USER_A, USER_B, SELF_CANCELLING, HIGH_BIT]) {
      const key = userWriteLockKey(id);
      expect(key).toBeGreaterThanOrEqual(INT64_MIN);
      expect(key).toBeLessThanOrEqual(INT64_MAX);
    }
  });

  it('uses the product name as its namespace rather than a magic number', () => {
    expect(
      Buffer.from(WRITE_LOCK_NAMESPACE.toString(16), 'hex').toString('ascii'),
    ).toBe('VAULTIDE');
  });

  it('refuses anything that is not a canonical UUID', () => {
    for (const bad of ['', 'not-a-uuid', '11111111111141118111111111111111', `${USER_A} `]) {
      expect(() => userWriteLockKey(bad)).toThrow(InvalidLockKeyInputError);
    }
    // The rejected value is never echoed back (18.2).
    expect(() => userWriteLockKey('secret-looking-value')).toThrow(
      /^A write-lock key can only be derived from a canonical UUID\.$/u,
    );
  });
});

describe('the write-lock timeout (ADR 0010 §7)', () => {
  it('defaults to the reviewed value with no configuration at all', () => {
    expect(writeLockTimeoutMs({})).toBe(DEFAULT_WRITE_LOCK_TIMEOUT_MS);
    expect(writeLockTimeoutMs({ [WRITE_LOCK_TIMEOUT_ENV_VAR]: '' })).toBe(
      DEFAULT_WRITE_LOCK_TIMEOUT_MS,
    );
    expect(DEFAULT_WRITE_LOCK_TIMEOUT_MS).toBe(1500);
  });

  it('honours a configured whole number of milliseconds', () => {
    expect(writeLockTimeoutMs({ [WRITE_LOCK_TIMEOUT_ENV_VAR]: '250' })).toBe(250);
  });

  it('refuses a misconfiguration instead of falling back silently', () => {
    // A financial write that waits forever, or not at all, is not something to
    // discover in production.
    for (const bad of ['0', '-1', '1.5', 'soon', '10', '120000']) {
      expect(() => writeLockTimeoutMs({ [WRITE_LOCK_TIMEOUT_ENV_VAR]: bad })).toThrow(
        WRITE_LOCK_TIMEOUT_ENV_VAR,
      );
    }
  });
});

describe('lock failures (20.2, ADR 0010 §7)', () => {
  it('recognises PostgreSQL lock_not_available and nothing else', () => {
    expect(LOCK_NOT_AVAILABLE).toBe('55P03');
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
    expect(isLockNotAvailable({ code: '23505' })).toBe(false);
    expect(isLockNotAvailable(new Error('boom'))).toBe(false);
    expect(isLockNotAvailable(null)).toBe(false);
    expect(isLockNotAvailable(undefined)).toBe(false);
  });

  it('finds the SQLSTATE where the ORM actually puts it', () => {
    // Drizzle wraps the driver error. Reading only the outermost one would make
    // the retry and `WRITE_BUSY` unreachable without any test failing.
    expect(isLockNotAvailable({ cause: { code: '55P03' } })).toBe(true);
    expect(isLockNotAvailable({ cause: { cause: { code: '55P03' } } })).toBe(true);
    expect(isLockNotAvailable({ cause: { cause: { code: '40001' } } })).toBe(false);
  });

  it('raises a db-level error the application maps, naming no SQLSTATE', () => {
    const error = new WriteLockUnavailableError();
    expect(isWriteLockUnavailable(error)).toBe(true);
    expect(isWriteLockUnavailable(new Error('other'))).toBe(false);
    expect(error.message).not.toContain('55P03');
    expect(error.message).not.toMatch(/postgres/iu);
  });
});
