import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, userWriteLockKey, withUser, withoutUser, type Transaction } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { withUserRead, withUserWrite } from '../../src/coordination';
import { WriteBusyError } from '../../src/errors';
import { provisionUser } from '../../src/users/provisioning';

/**
 * The write-coordination primitives, against a real PostgreSQL
 * (blueprint 20.3, 30.22; ADR 0010 §5–§8).
 *
 * Nothing here is mocked. An advisory lock that is asserted rather than taken
 * proves nothing, and the whole point of the ordering — mutex, *then* the first
 * authoritative read — is a property of what the database does to two
 * connections at once.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function scalar(tx: Transaction, statement: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute(statement);
  return String(Object.values(result.rows[0] as Record<string, unknown>)[0]);
}

/**
 * How many sessions hold this user's advisory write lock right now.
 *
 * `pg_locks` splits a 64-bit advisory key into two 32-bit halves — `classid`
 * for the high half, `objid` for the low — and marks the single-`bigint` form
 * with `objsubid = 1` (the two-`int4` form is 2). The halves are computed here
 * rather than reassembled in SQL, so no signed-shift subtlety sits between the
 * assertion and the fact.
 */
async function advisoryLockHolders(userId: string): Promise<number> {
  const unsigned = BigInt.asUintN(64, userWriteLockKey(userId));
  const classid = (unsigned >> 32n).toString();
  const objid = (unsigned & 0xffff_ffffn).toString();

  const rows = await withoutUser(harness.db, async (tx) =>
    tx.execute(sql`
      SELECT count(*)::text AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND granted
         AND objsubid = 1
         AND classid = ${classid}::oid
         AND objid = ${objid}::oid
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`),
  );
  return Number((rows.rows[0] as { n: string }).n);
}

/** The SQLSTATE of a failure, wherever the ORM put it in the cause chain. */
function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await createAuthUser(USER_B, 'b@example.test');
  await provisionUser(harness.db, { userId: USER_A });
  await provisionUser(harness.db, { userId: USER_B });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

describe('withUserWrite: the transaction it opens (ADR 0010 §5–§7)', () => {
  it('runs read committed, with the RLS context, a lock timeout and the mutex held', async () => {
    const observed = await withUserWrite(harness.db, { userId: USER_A }, async (tx) => ({
      isolation: await scalar(tx, sql`SHOW transaction_isolation`),
      readOnly: await scalar(tx, sql`SHOW transaction_read_only`),
      lockTimeout: await scalar(tx, sql`SHOW lock_timeout`),
      rlsUser: await scalar(tx, sql`SELECT current_setting('app.current_user_id', true)`),
      // Taken **before** this callback ran, which is the whole contract.
      holders: await advisoryLockHolders(USER_A),
    }));

    // Not repeatable read and not serializable: after waiting for the mutex the
    // first authoritative read has to see what the previous holder committed.
    expect(observed.isolation).toBe('read committed');
    expect(observed.readOnly).toBe('off');
    expect(observed.lockTimeout).toBe('1500ms');
    expect(observed.rlsUser).toBe(USER_A);
    expect(observed.holders).toBe(1);
  });

  it('releases the mutex on commit, on rollback and on an error', async () => {
    await withUserWrite(harness.db, { userId: USER_A }, (tx) => tx.execute(sql`SELECT 1`));
    expect(await advisoryLockHolders(USER_A)).toBe(0);

    await expect(
      withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    // `pg_advisory_xact_lock`, never `pg_advisory_lock`: nothing to release by
    // hand, and nothing left behind on a pooled connection.
    expect(await advisoryLockHolders(USER_A)).toBe(0);
  });

  it('refuses a user id that is not canonical, before opening anything', async () => {
    await expect(
      withUserWrite(harness.db, { userId: 'not-a-uuid' }, (tx) => tx.execute(sql`SELECT 1`)),
    ).rejects.toThrow(/canonical user id/u);
  });

  it('keeps RLS fail-closed inside the transaction', async () => {
    const otherId = 'aaaaaaaa-0000-4000-8000-00000000f001';
    await withUserWrite(harness.db, { userId: USER_B }, async (tx) => {
      await tx.execute(
        sql`INSERT INTO positions (id, user_id, kind, name, currency)
            VALUES (${otherId}, ${USER_B}, 'cash', 'B only', 'EUR')`,
      );
    });

    const seen = await withUserWrite(harness.db, { userId: USER_A }, async (tx) =>
      scalar(tx, sql`SELECT count(*)::text FROM positions WHERE id = ${otherId}`),
    );
    expect(seen).toBe('0');

    await withUser(harness.db, { userId: USER_B }, async (tx) => {
      await tx.execute(sql`DELETE FROM positions WHERE id = ${otherId}`);
    });
  });
});

describe('withUserWrite: the mutex locks before the first read (30.22 item 5)', () => {
  it('holds a second writer of the same user out of its decision section', async () => {
    const entered = deferred();
    const release = deferred();

    const first = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
      entered.resolve();
      await release.promise;
      await tx.execute(sql`SELECT 1`);
      return 'first';
    });

    let secondReachedItsRead = false;
    let second: Promise<string> | undefined;
    try {
      await entered.promise;

      second = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        // The first statement of the decision section. If the mutex were taken
        // after the reads — or not at all — this would already have run.
        secondReachedItsRead = true;
        await tx.execute(sql`SELECT 1`);
        return 'second';
      });

      await delay(250);
      expect(secondReachedItsRead).toBe(false);
    } finally {
      // Always, so a failed expectation cannot leave the mutex held and turn
      // every later case in this file into a cascade of WRITE_BUSY.
      release.resolve();
    }

    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(secondReachedItsRead).toBe(true);
  });

  it('lets a second writer see what the first committed, under read committed', async () => {
    const positionId = 'aaaaaaaa-0000-4000-8000-00000000f002';
    const entered = deferred();
    const release = deferred();

    const writer = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
      entered.resolve();
      await release.promise;
      await tx.execute(
        sql`INSERT INTO positions (id, user_id, kind, name, currency)
            VALUES (${positionId}, ${USER_A}, 'cash', 'Written first', 'EUR')`,
      );
    });

    let reader: Promise<string> | undefined;
    try {
      await entered.promise;
      reader = withUserWrite(harness.db, { userId: USER_A }, async (tx) =>
        scalar(tx, sql`SELECT count(*)::text FROM positions WHERE id = ${positionId}`),
      );
      await delay(100);
    } finally {
      release.resolve();
    }
    await writer;

    // The reader's transaction began before the writer committed. A repeatable
    // read snapshot would have been taken at its GUC set-up — before the wait —
    // and would still say zero.
    expect(await reader).toBe('1');

    await withUser(harness.db, { userId: USER_A }, async (tx) => {
      await tx.execute(sql`DELETE FROM positions WHERE id = ${positionId}`);
    });
  });

  it('does not serialize two different users against each other', async () => {
    const aEntered = deferred();
    const bEntered = deferred();
    const release = deferred();

    const a = withUserWrite(harness.db, { userId: USER_A }, async () => {
      aEntered.resolve();
      await release.promise;
    });
    const b = withUserWrite(harness.db, { userId: USER_B }, async () => {
      bEntered.resolve();
      await release.promise;
    });


    try {
      // Both reach their decision section while the other is still inside it:
      // the key is per user, not one global financial lock.
      await Promise.all([aEntered.promise, bEntered.promise]);
      expect(await advisoryLockHolders(USER_A)).toBe(1);
      expect(await advisoryLockHolders(USER_B)).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([a, b]);
    }
  });
});

describe('withUserWrite: the timeout and the one retry (20.2, ADR 0010 §7)', () => {
  it('retries once and then answers WRITE_BUSY, having written nothing', async () => {
    const lockTimeoutMs = 120;
    const positionId = 'aaaaaaaa-0000-4000-8000-00000000f003';
    const entered = deferred();
    const release = deferred();

    const holder = withUserWrite(harness.db, { userId: USER_A }, async () => {
      entered.resolve();
      await release.promise;
    });


    let attempts = 0;
    try {
      await entered.promise;

      const startedAt = Date.now();
      const busy = withUserWrite(
        harness.db,
        { userId: USER_A },
        async (tx) => {
          attempts += 1;
          await tx.execute(
            sql`INSERT INTO positions (id, user_id, kind, name, currency)
                VALUES (${positionId}, ${USER_A}, 'cash', 'Never written', 'EUR')`,
          );
        },
        { lockTimeoutMs },
      );

      await expect(busy).rejects.toBeInstanceOf(WriteBusyError);
      const elapsed = Date.now() - startedAt;

      // Two waits of the configured timeout, not one and not three.
      expect(elapsed).toBeGreaterThanOrEqual(lockTimeoutMs * 2);
      expect(elapsed).toBeLessThan(lockTimeoutMs * 20);
      // The decision section never ran, so there is nothing to have half-written.
      expect(attempts).toBe(0);
    } finally {
      release.resolve();
      await holder;
    }

    const written = await withUser(harness.db, { userId: USER_A }, async (tx) =>
      scalar(tx, sql`SELECT count(*)::text FROM positions WHERE id = ${positionId}`),
    );
    expect(written).toBe('0');
  });

  it('says nothing about PostgreSQL, and is a conflict rather than an internal error', () => {
    const error = new WriteBusyError();
    expect(error.code).toBe('WRITE_BUSY');
    expect(error.logLevel).toBe('info');
    expect(error.message).toBe('Another change is still saving. Nothing was saved — try again.');
    expect(error.message).not.toMatch(/lock|postgres|55P03/iu);
  });

  it('does not retry a domain failure, and never disguises one as WRITE_BUSY', async () => {
    let calls = 0;
    await expect(
      withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        calls += 1;
        await tx.execute(sql`SELECT 1`);
        throw new Error('a refusal, not contention');
      }),
    ).rejects.toThrow('a refusal, not contention');
    expect(calls).toBe(1);
  });
});

describe('withUserRead: one coherent read (ADR 0010 §8)', () => {
  it('runs repeatable read, read only, with the RLS context and no write mutex', async () => {
    const observed = await withUserRead(harness.db, { userId: USER_A }, async (tx) => ({
      isolation: await scalar(tx, sql`SHOW transaction_isolation`),
      readOnly: await scalar(tx, sql`SHOW transaction_read_only`),
      rlsUser: await scalar(tx, sql`SELECT current_setting('app.current_user_id', true)`),
      holders: await advisoryLockHolders(USER_A),
    }));

    // Asserted against the server rather than against the call site: the point
    // is what PostgreSQL was told, not what the ORM was asked for.
    expect(observed.isolation).toBe('repeatable read');
    expect(observed.readOnly).toBe('on');
    expect(observed.rlsUser).toBe(USER_A);
    expect(observed.holders).toBe(0);
  });

  it('refuses a write inside it', async () => {
    const failure = await withUserRead(harness.db, { userId: USER_A }, async (tx) =>
      tx.execute(
        sql`INSERT INTO positions (id, user_id, kind, name, currency)
            VALUES (gen_random_uuid(), ${USER_A}, 'cash', 'Not allowed', 'EUR')`,
      ),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // `read_only_sql_transaction`: the database refusing, not a convention.
    expect(sqlStateOf(failure)).toBe('25006');
  });

  it('answers every statement from one snapshot, and blocks no writer', async () => {
    const positionId = 'aaaaaaaa-0000-4000-8000-00000000f004';
    const opened = deferred();
    const written = deferred();

    const read = withUserRead(harness.db, { userId: USER_A }, async (tx) => {
      const before = await scalar(
        tx,
        sql`SELECT count(*)::text FROM positions WHERE id = ${positionId}`,
      );
      opened.resolve();
      await written.promise;
      const after = await scalar(
        tx,
        sql`SELECT count(*)::text FROM positions WHERE id = ${positionId}`,
      );
      return { before, after };
    });

    try {
      await opened.promise;
      // The writer is not held up by the reader: no mutex, no row lock, nothing.
      await withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO positions (id, user_id, kind, name, currency)
              VALUES (${positionId}, ${USER_A}, 'cash', 'Written during a read', 'EUR')`,
        );
      });
    } finally {
      written.resolve();
    }

    const { before, after } = await read;
    expect(before).toBe('0');
    // The same snapshot: the row exists now, and this transaction still says so
    // consistently with its own first answer.
    expect(after).toBe('0');

    await withUser(harness.db, { userId: USER_A }, async (tx) => {
      await tx.execute(sql`DELETE FROM positions WHERE id = ${positionId}`);
    });
  });

  it('keeps RLS fail-closed', async () => {
    const seen = await withUserRead(harness.db, { userId: USER_A }, async (tx) =>
      scalar(tx, sql`SELECT count(*)::text FROM positions WHERE user_id = ${USER_B}`),
    );
    expect(seen).toBe('0');
  });
});
