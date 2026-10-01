import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertValuationIn, sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { withUserRead, withUserWrite } from '../../src/coordination';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, updateCashAccount } from '../../src/positions/service';
import {
  applyConfirmUnchangedPlanIn,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  recordValuation,
  resolveConfirmUnchangedBatchIn,
} from '../../src/positions/valuations';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';
import { applyCorrectionIn } from '../../src/corrections/resolve';
import { saveOrCorrect } from '../helpers/corrections';

/**
 * "Confirm unchanged" and the dormant account it writes into (blueprint 8.8,
 * v2.1.17 30.20 items 6 and 8, 30.22 items 1 and 2; ADR 0007 §4, ADR 0010 §1).
 *
 * Confirming a month unchanged writes a real balance: the previous month's
 * statement figure, dated `end(M)`. Every other new non-zero balance wakes a
 * dormant account whatever its date, and this one did not — single and batch
 * alike, it wrote a non-zero statement and left the account dormant. Two ways of
 * asserting the same balance obeyed two rules.
 *
 * The ruling this suite holds the code to:
 *
 *  - the balance is a **first assertion**, ordinary even in a closed month, for
 *    one account or several;
 *  - its **dormancy consequence** is the ordinary one — a non-zero figure wakes,
 *    a zero does not — and is judged on its own terms: when the episode it ends
 *    is anchored in a closed month, the whole act goes through Review → Confirm;
 *  - a month the episode **covers** is still refused, never turned into a wake.
 *
 * `today` is 5 October 2026 unless a case says otherwise: September has closed,
 * October has not. On 5 November, October has closed too.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let bbva: string;
let savings: string;

const on = (today: string, requestId?: string): RequestContext =>
  testContext({
    today,
    userId: USER_A,
    reportingCurrency: 'EUR',
    ...(requestId === undefined ? {} : { requestId }),
  });

const OCT_5 = on('2026-10-05');
const NOV_5 = on('2026-11-05');

const positions = () => harness.services.positions;
const corrections = () => harness.services.corrections;

const REVIEW_REQUIRED = { code: 'HISTORICAL_REVIEW_REQUIRED' };
const AWAKE = { dormant: false, from: null };

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function state(positionId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT c.is_dormant AS dormant, c.dormant_from::text AS "from", p.version
            FROM cash_accounts c JOIN positions p ON p.id = c.position_id
           WHERE c.position_id = ${positionId}`,
    );
    return result.rows[0] as { dormant: boolean; from: string | null; version: number };
  });
}

/** Every balance of an account on a date, as written. */
async function rowsOn(positionId: string, valuedOn: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, amount::text AS amount, source::text AS source,
                 date_precision::text AS precision, version
            FROM position_valuations WHERE position_id = ${positionId} AND valued_on = ${valuedOn}`,
    );
    return result.rows as {
      id: string;
      amount: string;
      source: string;
      precision: string;
      version: number;
    }[];
  });
}

async function auditCount(): Promise<number> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM audit_entries`);
    return (result.rows[0] as { n: number }).n;
  });
}

async function auditFor(requestId: string) {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT entity_table AS "table", entity_id AS "entityId", action::text AS action, reason
            FROM audit_entries WHERE request_id = ${requestId}
           ORDER BY entity_table, entity_id`,
    );
    return result.rows as { table: string; entityId: string; action: string; reason: string | null }[];
  });
}

/** A balance written the way the interface writes one: asking first. */
async function balance(
  positionId: string,
  valuedOn: string,
  amount: string,
  datePrecision: 'exact' | 'month_end',
  ctx: RequestContext,
): Promise<void> {
  await saveOrCorrect(
    corrections(),
    ctx,
    { kind: 'valuation_create', positionId, valuedOn, amount, datePrecision },
    () => recordValuation(positions(), ctx, { positionId, valuedOn, amount, datePrecision }),
  );
}

async function markDormant(positionId: string, ctx: RequestContext): Promise<void> {
  const expectedVersion = (await state(positionId)).version;
  await saveOrCorrect(
    corrections(),
    ctx,
    { kind: 'cash_account_update', positionId, expectedVersion, isDormant: true },
    () => updateCashAccount(positions(), ctx, { positionId, expectedVersion, isDormant: true }),
  );
}

/**
 * A non-zero August statement, then emptied on 1 October and dormant from that
 * zero. Asked on 5 October the episode is in the current month; on 5 November
 * it is anchored in a month that has closed.
 */
async function dormantSinceOctober(positionId: string, amount: string, ctx: RequestContext) {
  await balance(positionId, '2026-08-31', amount, 'month_end', ctx);
  await balance(positionId, '2026-10-01', '0', 'exact', ctx);
  await markDormant(positionId, ctx);
  expect(await state(positionId)).toMatchObject({ dormant: true, from: '2026-10-01' });
}

async function preview(draft: CorrectionDraft, ctx: RequestContext) {
  return previewHistoricalCorrection(corrections(), ctx, { draft });
}

async function requireReview(draft: CorrectionDraft, ctx: RequestContext): Promise<CorrectionPreview> {
  const prepared = await preview(draft, ctx);
  if (prepared.status !== 'review_required') throw new Error('expected a review to be required');
  return prepared.preview;
}

const prospective = (positionId: string, valuedOn: string) => ({
  identity: {
    scope: 'prospective',
    kind: 'valuation',
    role: 'valuation',
    owner: `${positionId}#${valuedOn}`,
  },
  operation: 'create',
});

const wakeOf = (positionId: string) => ({
  identity: { scope: 'existing', kind: 'cash_dormancy', id: positionId },
  operation: 'update',
});

/* -------------------------------------------------------------------------- */
/* Statement capture and an outside writer                                     */
/* -------------------------------------------------------------------------- */

/** Every statement one call sends, lower-cased and on one line. */
async function capturing(run: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;
  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    const text = typeof first === 'string' ? first : (first?.text ?? '');
    sent.push(text.replace(/\s+/gu, ' ').trim().toLowerCase());
    return Reflect.apply(original, this, args) as unknown;
  };
  try {
    await run().catch(() => undefined);
  } finally {
    driver.query = original;
  }
  return sent;
}

const isWrite = (statement: string): boolean => /^(insert|update|delete)\b/u.test(statement);
const isLockingRead = (statement: string): boolean => /\bfor (update|share|no key update|key share)\b/u.test(statement);

/**
 * Wait until PostgreSQL itself reports a backend of this database blocked on a
 * lock. A barrier, not a delay: it returns the moment somebody waits, and fails
 * if nobody ever does.
 */
async function waitUntilBlockedOnALock(): Promise<void> {
  const client = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
  await client.connect();
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await client.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting
           FROM pg_locks locks
           JOIN pg_stat_activity backends ON backends.pid = locks.pid
          WHERE NOT locks.granted AND backends.datname = current_database()`,
      );
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no backend ever waited for a lock');
  } finally {
    await client.end();
  }
}

/**
 * A balance on `end(M)` written by a transaction outside the financial mutex —
 * the only kind of writer that can race a confirmation — begun and held open
 * while `run` proceeds, then committed once `run` is waiting on it.
 */
async function racedByOutsideWriter(
  positionId: string,
  valuedOn: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const outside = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
  await outside.connect();
  let outcome: Promise<unknown> | undefined;
  try {
    await outside.query('BEGIN');
    await outside.query(
      `INSERT INTO position_valuations (user_id, position_id, valued_on, amount, source, date_precision)
       VALUES ($1, $2, $3, '1.00', 'entered', 'exact')`,
      [USER_A, positionId, valuedOn],
    );
    outcome = run().then(
      () => 'saved',
      (error: unknown) => error,
    );
    await waitUntilBlockedOnALock();
    await outside.query('COMMIT');
  } finally {
    await outside.end();
  }
  return outcome;
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const table of ['audit_entries', 'position_valuations', 'cash_accounts', 'positions']) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }
  const make = (name: string, accountType: 'checking' | 'savings') =>
    createCashAccount(positions(), OCT_5, { name, currency: 'EUR', accountType, openedOn: null });
  bbva = (await make('BBVA', 'checking')).id;
  savings = (await make('Savings', 'savings')).id;
});

/* -------------------------------------------------------------------------- */
/* The defect                                                                  */
/* -------------------------------------------------------------------------- */

describe('a confirmed non-zero statement wakes a dormant account (reproduced on 5656cec)', () => {
  // On 5656cec both calls saved September at 5,000.00, `confirmed_unchanged`,
  // and left Savings dormant from 1 October.
  it('one account: the ordinary action refuses, having written nothing', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const before = await auditCount();

    await expect(
      confirmUnchanged(positions(), NOV_5, { positionId: savings, month: '2026-09' }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-10-01' });
    expect(await auditCount()).toBe(before);
  });

  it('several accounts: the same, for the whole request', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const before = await auditCount();

    await expect(
      confirmUnchangedBatch(positions(), NOV_5, { month: '2026-09', positionIds: [savings] }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);

    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-10-01' });
    expect(await auditCount()).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* One account                                                                 */
/* -------------------------------------------------------------------------- */

describe('confirming one account unchanged', () => {
  it('1 — an awake account: an ordinary first assertion, as before', async () => {
    await balance(bbva, '2026-08-31', '5000.00', 'month_end', OCT_5);

    expect(await preview({ kind: 'confirm_unchanged', positionId: bbva, month: '2026-09' }, OCT_5)).toEqual({
      status: 'not_required',
    });
    const written = await confirmUnchanged(positions(), OCT_5, { positionId: bbva, month: '2026-09' });

    expect(written).toMatchObject({
      valuedOn: '2026-09-30',
      amount: '5000.00000000',
      source: 'confirmed_unchanged',
      datePrecision: 'month_end',
    });
    expect(await state(bbva)).toMatchObject(AWAKE);
  });

  /** Zero through July, a zero snapshot on 15 September, dormant from it. */
  async function dormantSinceSeptember(): Promise<void> {
    await balance(savings, '2026-07-31', '0', 'month_end', OCT_5);
    await balance(savings, '2026-09-15', '0', 'exact', OCT_5);
    await markDormant(savings, OCT_5);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-09-15' });
  }

  it('2 — a zero carried forward is not money: no wake and no review', async () => {
    await dormantSinceSeptember();

    // August is before the episode, so it is an ordinary month to confirm.
    expect(
      await preview({ kind: 'confirm_unchanged', positionId: savings, month: '2026-08' }, OCT_5),
    ).toEqual({ status: 'not_required' });
    const written = await confirmUnchanged(positions(), OCT_5, { positionId: savings, month: '2026-08' });

    expect(written).toMatchObject({ valuedOn: '2026-08-31', amount: '0.00000000', source: 'confirmed_unchanged' });
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-09-15' });
  });

  it('3 — a month the episode covers is still refused, never turned into a wake', async () => {
    await dormantSinceSeptember();

    await expect(
      confirmUnchanged(positions(), OCT_5, { positionId: savings, month: '2026-09' }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await expect(
      preview({ kind: 'confirm_unchanged', positionId: savings, month: '2026-09' }, OCT_5),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });

    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-09-15' });
  });

  it('4 — a wake ending an episode in the current month is ordinary, and one outcome', async () => {
    await dormantSinceOctober(savings, '5000.00', OCT_5);
    const ctx = on('2026-10-05', 'confirm-current-wake');

    expect(
      await preview({ kind: 'confirm_unchanged', positionId: savings, month: '2026-09' }, ctx),
    ).toEqual({ status: 'not_required' });
    const written = await confirmUnchanged(positions(), ctx, { positionId: savings, month: '2026-09' });

    expect(written).toMatchObject({ valuedOn: '2026-09-30', amount: '5000.00000000', source: 'confirmed_unchanged' });
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await auditFor('confirm-current-wake')).toEqual([
      { table: 'cash_accounts', entityId: savings, action: 'update', reason: null },
      { table: 'position_valuations', entityId: written.id, action: 'insert', reason: null },
    ]);
  });

  it('5 — a wake reaching a closed month is reviewed, and the review writes both', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged', positionId: savings, month: '2026-09' };
    const before = await auditCount();

    await expect(
      confirmUnchanged(positions(), NOV_5, { positionId: savings, month: '2026-09' }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
    expect(await auditCount()).toBe(before);

    // The review shows the balance being added and the episode it ends.
    const reviewed = await requireReview(draft, NOV_5);
    expect(reviewed.sourceScope).toEqual(
      expect.arrayContaining([prospective(savings, '2026-09-30'), wakeOf(savings)]),
    );
    expect(reviewed.sourceScope).toHaveLength(2);
    expect(reviewed.sourceChanges).toContainEqual(
      expect.objectContaining({
        operation: 'create',
        before: null,
        after: {
          kind: 'valuation',
          positionId: savings,
          valuedOn: '2026-09-30',
          amount: '5000',
          currency: 'EUR',
          datePrecision: 'month_end',
          note: null,
        },
      }),
    );
    expect(reviewed.structuralChanges).toContainEqual({
      kind: 'dormancy_episode',
      positionId: savings,
      before: '2026-10-01',
      after: null,
    });
    // The month the balance lands in and the closed month the episode began in.
    expect(reviewed.periods.map((period) => period.month)).toEqual(
      expect.arrayContaining(['2026-09', '2026-10']),
    );
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);

    const ctx = on('2026-11-05', 'confirm-historical-wake');
    const outcome = await confirmHistoricalCorrection(corrections(), ctx, {
      draft,
      fingerprint: reviewed.fingerprint,
      reason: 'The September statement shows no movement',
    });
    expect(outcome).toMatchObject({ status: 'committed', summary: { dormancyChanged: true } });

    const [row] = await rowsOn(savings, '2026-09-30');
    expect(row).toMatchObject({ amount: '5000.00000000', source: 'confirmed_unchanged', precision: 'month_end' });
    expect(await state(savings)).toMatchObject(AWAKE);
    // The reason travels with the balance; the wake keeps the dormancy
    // consequence's own convention.
    expect(await auditFor('confirm-historical-wake')).toEqual([
      { table: 'cash_accounts', entityId: savings, action: 'update', reason: null },
      {
        table: 'position_valuations',
        entityId: row?.id,
        action: 'insert',
        reason: 'The September statement shows no movement',
      },
    ]);
  });

  it('6 — a previous statement that moved after the review asks again, writing nothing', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged', positionId: savings, month: '2026-09' };
    const reviewed = await requireReview(draft, NOV_5);

    // August is corrected to 5,100 meanwhile — itself a reviewed correction,
    // and a non-zero balance, so it wakes Savings too.
    const [august] = await rowsOn(savings, '2026-08-31');
    const correction: CorrectionDraft = {
      kind: 'valuation_update',
      valuationId: august!.id,
      expectedVersion: august!.version,
      valuedOn: '2026-08-31',
      amount: '5100.00',
      datePrecision: 'month_end',
    };
    await saveOrCorrect(corrections(), NOV_5, correction, () =>
      correctValuation(positions(), NOV_5, {
        valuationId: august!.id,
        expectedVersion: august!.version,
        valuedOn: '2026-08-31',
        amount: '5100.00',
        datePrecision: 'month_end',
      }),
    );

    // Still a perfectly valid confirmation — of a different figure, with no
    // episode left to end. That is a changed impact, not a conflict.
    const outcome = await confirmHistoricalCorrection(corrections(), NOV_5, {
      draft,
      fingerprint: reviewed.fingerprint,
    });
    expect(outcome.status).toBe('impact_changed');
    if (outcome.status === 'impact_changed') {
      expect(outcome.preview.sourceChanges).toContainEqual(
        expect.objectContaining({ after: expect.objectContaining({ amount: '5100' }) as unknown }),
      );
    }
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
  });

  it('7 — a balance written on the target date meanwhile is its own conflict, not a changed impact', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged', positionId: savings, month: '2026-09' };
    const reviewed = await requireReview(draft, NOV_5);

    // A zero snapshot on 30 September: a first assertion that wakes nothing.
    await recordValuation(positions(), NOV_5, {
      positionId: savings,
      valuedOn: '2026-09-30',
      amount: '0',
      datePrecision: 'exact',
    });

    await expect(
      confirmHistoricalCorrection(corrections(), NOV_5, { draft, fingerprint: reviewed.fingerprint }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await rowsOn(savings, '2026-09-30')).toMatchObject([
      { amount: '0.00000000', source: 'entered', precision: 'exact' },
    ]);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-10-01' });
  });
});

/* -------------------------------------------------------------------------- */
/* Several accounts                                                            */
/* -------------------------------------------------------------------------- */

describe('confirming several accounts unchanged', () => {
  it('8 — every account ordinary: all of them, with no review, as before', async () => {
    await balance(bbva, '2026-08-31', '5000.00', 'month_end', OCT_5);
    await balance(savings, '2026-08-31', '2000.00', 'month_end', OCT_5);
    const draft: CorrectionDraft = {
      kind: 'confirm_unchanged_batch',
      month: '2026-09',
      positionIds: [bbva, savings],
    };

    expect(await preview(draft, OCT_5)).toEqual({ status: 'not_required' });
    const summary = await confirmUnchangedBatch(positions(), OCT_5, {
      month: '2026-09',
      positionIds: [bbva, savings],
    });

    expect(summary).toEqual({
      month: '2026-09',
      valuedOn: '2026-09-30',
      confirmed: 2,
      positionIds: [bbva, savings],
    });
    expect(await rowsOn(bbva, '2026-09-30')).toMatchObject([{ amount: '5000.00000000', source: 'confirmed_unchanged' }]);
    expect(await rowsOn(savings, '2026-09-30')).toMatchObject([{ amount: '2000.00000000', source: 'confirmed_unchanged' }]);
  });

  it('9 — one historical wake: nothing saves ordinarily, and one review commits it all', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', NOV_5);
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = {
      kind: 'confirm_unchanged_batch',
      month: '2026-09',
      positionIds: [bbva, savings],
    };

    await expect(
      confirmUnchangedBatch(positions(), NOV_5, { month: '2026-09', positionIds: [bbva, savings] }),
    ).rejects.toMatchObject(REVIEW_REQUIRED);
    // Not even the account that needed no review.
    expect(await rowsOn(bbva, '2026-09-30')).toEqual([]);
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);

    const reviewed = await requireReview(draft, NOV_5);
    expect(reviewed.sourceScope).toEqual(
      expect.arrayContaining([
        prospective(bbva, '2026-09-30'),
        prospective(savings, '2026-09-30'),
        wakeOf(savings),
      ]),
    );
    expect(reviewed.sourceScope).toHaveLength(3);
    expect(reviewed.structuralChanges).toContainEqual({
      kind: 'dormancy_episode',
      positionId: savings,
      before: '2026-10-01',
      after: null,
    });

    const ctx = on('2026-11-05', 'batch-historical-wake');
    const outcome = await confirmHistoricalCorrection(corrections(), ctx, {
      draft,
      fingerprint: reviewed.fingerprint,
    });
    expect(outcome.status).toBe('committed');
    expect(await rowsOn(bbva, '2026-09-30')).toMatchObject([{ amount: '1000.00000000', source: 'confirmed_unchanged' }]);
    expect(await rowsOn(savings, '2026-09-30')).toMatchObject([{ amount: '5000.00000000', source: 'confirmed_unchanged' }]);
    expect(await state(savings)).toMatchObject(AWAKE);
    expect((await auditFor('batch-historical-wake')).map((row) => `${row.table}:${row.action}`)).toEqual([
      'cash_accounts:update',
      'position_valuations:insert',
      'position_valuations:insert',
    ]);
  });

  it('10 — a wake in the current month: the ordinary batch saves and wakes in one go', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);
    await dormantSinceOctober(savings, '5000.00', OCT_5);

    await confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [bbva, savings] });

    expect(await rowsOn(bbva, '2026-09-30')).toHaveLength(1);
    expect(await rowsOn(savings, '2026-09-30')).toHaveLength(1);
    expect(await state(savings)).toMatchObject(AWAKE);
    expect(await state(bbva)).toMatchObject(AWAKE);
  });

  it('11 — two accounts woken: one wake each, and both in the one transaction', async () => {
    await dormantSinceOctober(bbva, '1000.00', OCT_5);
    await dormantSinceOctober(savings, '5000.00', OCT_5);

    const plan = await withUserRead(harness.db, { userId: USER_A }, (tx) =>
      resolveConfirmUnchangedBatchIn(tx, OCT_5, { month: '2026-09', positionIds: [savings, bbva] }, { lock: false }),
    );
    expect(plan.revision).toBe(false);
    expect(plan.entries.map((entry) => entry.position.id)).toEqual([bbva, savings].sort());
    expect(plan.dormancy.map((effect) => effect.positionId)).toEqual([bbva, savings].sort());

    const ctx = on('2026-10-05', 'batch-two-wakes');
    await confirmUnchangedBatch(positions(), ctx, { month: '2026-09', positionIds: [savings, bbva] });

    expect(await state(bbva)).toMatchObject(AWAKE);
    expect(await state(savings)).toMatchObject(AWAKE);
    expect((await auditFor('batch-two-wakes')).map((row) => `${row.table}:${row.action}`)).toEqual([
      'cash_accounts:update',
      'cash_accounts:update',
      'position_valuations:insert',
      'position_valuations:insert',
    ]);
  });

  it('12 — one ineligible account: nothing commits, the dormant one included', async () => {
    await dormantSinceOctober(bbva, '1000.00', OCT_5);
    // Savings has no August statement to carry forward.
    const before = await auditCount();

    await expect(
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [bbva, savings] }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });
    await expect(
      preview({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [bbva, savings] }, OCT_5),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA' });

    expect(await rowsOn(bbva, '2026-09-30')).toEqual([]);
    expect(await state(bbva)).toMatchObject({ dormant: true, from: '2026-10-01' });
    expect(await auditCount()).toBe(before);
  });

  it('13 — an account named twice is refused, never quietly de-duplicated', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);

    await expect(
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [bbva, bbva] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // The review resolves through the same rules, whoever asks.
    await expect(
      preview({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [bbva, bbva] }, OCT_5),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await rowsOn(bbva, '2026-09-30')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* A balance that reaches end(M) after the resolution                          */
/* -------------------------------------------------------------------------- */

describe('a balance reaching end(M) after the resolution is the same conflict on every path', () => {
  it('the ordinary single action', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);

    const outcome = await racedByOutsideWriter(bbva, '2026-09-30', () =>
      confirmUnchanged(positions(), OCT_5, { positionId: bbva, month: '2026-09' }),
    );
    expect(outcome).toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await rowsOn(bbva, '2026-09-30')).toMatchObject([{ source: 'entered', amount: '1.00000000' }]);
  });

  it('a reviewed single confirmation', async () => {
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged', positionId: savings, month: '2026-09' };
    const reviewed = await requireReview(draft, NOV_5);

    const outcome = await racedByOutsideWriter(savings, '2026-09-30', () =>
      confirmHistoricalCorrection(corrections(), NOV_5, { draft, fingerprint: reviewed.fingerprint }),
    );
    expect(outcome).toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    // Nothing of the reviewed act landed: neither its balance nor its wake.
    expect(await rowsOn(savings, '2026-09-30')).toMatchObject([{ source: 'entered' }]);
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-10-01' });
  });

  it('the ordinary batch and a reviewed batch: the account lock makes it the resolver’s own conflict', async () => {
    // A batch locks its accounts before it reads anything, and an outside
    // write's foreign key needs that same row, so the batch waits for it and
    // then reads the balance it wrote: the duplicate is refused before apply.
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);
    const ordinary = await racedByOutsideWriter(bbva, '2026-09-30', () =>
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [bbva] }),
    );
    expect(ordinary).toMatchObject({ code: 'CONFLICT_DUPLICATE' });

    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [savings] };
    const reviewed = await requireReview(draft, NOV_5);
    const confirmed = await racedByOutsideWriter(savings, '2026-09-30', () =>
      confirmHistoricalCorrection(corrections(), NOV_5, { draft, fingerprint: reviewed.fingerprint }),
    );
    expect(confirmed).toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await state(savings)).toMatchObject({ dormant: true, from: '2026-10-01' });
  });

  it('and when the constraint itself refuses, the shared apply answers it — for both callers', async () => {
    // The apply step is where the constraint can fire, so that is where it is
    // answered: the ordinary actions and Historical Confirm both reach it.
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);
    await balance(savings, '2026-08-31', '2000.00', 'month_end', OCT_5);

    for (const caller of ['ordinary', 'correction'] as const) {
      const attempt = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
        const plan = await resolveConfirmUnchangedBatchIn(tx, OCT_5, {
          month: '2026-09',
          positionIds: [bbva, savings],
        });
        // Somebody reached Savings' end(M) between the resolution and the write.
        await insertValuationIn(
          tx,
          { userId: USER_A, requestId: 'outside' },
          { positionId: savings, valuedOn: '2026-09-30', amount: '1.00', source: 'entered', datePrecision: 'exact' },
        );
        if (caller === 'ordinary') await applyConfirmUnchangedPlanIn(tx, OCT_5, plan);
        else await applyCorrectionIn(tx, OCT_5, { family: 'confirm_unchanged', plan });
      });
      await expect(attempt).rejects.toMatchObject({
        code: 'CONFLICT_DUPLICATE',
        message: expect.stringContaining('in the meantime') as unknown,
      });
    }
    expect(await rowsOn(bbva, '2026-09-30')).toEqual([]);
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* What each path sends                                                        */
/* -------------------------------------------------------------------------- */

describe('the preview reads, and the write decides everything before it writes', () => {
  it('a preview is one read-only snapshot: no mutex, no row lock, no write, no provider', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', NOV_5);
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const callsBefore = harness.fxProvider.calls.length;

    for (const draft of [
      { kind: 'confirm_unchanged', positionId: savings, month: '2026-09' },
      { kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [bbva, savings] },
    ] satisfies CorrectionDraft[]) {
      const sent = await capturing(() => requireReview(draft, NOV_5));
      expect(sent[0]).toBe('begin isolation level repeatable read read only');
      expect(sent.filter((statement) => statement.startsWith('begin'))).toHaveLength(1);
      expect(sent.some((statement) => statement.includes('pg_advisory_xact_lock'))).toBe(false);
      expect(sent.filter(isLockingRead)).toEqual([]);
      expect(sent.filter(isWrite)).toEqual([]);
    }
    expect(harness.fxProvider.calls.length).toBe(callsBefore);
    expect(await rowsOn(savings, '2026-09-30')).toEqual([]);
  });

  it('the ordinary batch: mutex, then the accounts locked in order, every read, then every write', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', OCT_5);
    await dormantSinceOctober(savings, '5000.00', OCT_5);

    const sent = await capturing(() =>
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [savings, bbva] }),
    );

    expect(sent[0]).toBe('begin isolation level read committed');
    expect(sent.filter((statement) => statement.startsWith('begin'))).toHaveLength(1);
    const mutex = sent.findIndex((statement) => statement.includes('pg_advisory_xact_lock'));
    const accounts = sent.findIndex((statement) => /from "positions"/u.test(statement));
    expect(mutex).toBeGreaterThan(0);
    expect(accounts).toBeGreaterThan(mutex);
    expect(sent[accounts]).toContain('order by "positions"."id"');
    expect(sent[accounts]).toContain('for update of "positions", "cash_accounts"');

    // Each previous statement held FOR SHARE, as before.
    expect(sent.filter((statement) => /from "position_valuations".*for share/u.test(statement))).toHaveLength(2);

    // Nothing is written until every account and balance is read. (A wake reads
    // its own before-image for the audit afterwards; that is the write, not the
    // resolution.)
    const firstWrite = sent.findIndex(isWrite);
    const lastResolutionRead = sent.findLastIndex((statement) =>
      /^select .* from "(positions|position_valuations)"/u.test(statement),
    );
    expect(lastResolutionRead).toBeGreaterThan(accounts);
    expect(firstWrite).toBeGreaterThan(lastResolutionRead);
    expect(sent.filter((statement) => /^insert into "position_valuations"/u.test(statement))).toHaveLength(2);
    expect(sent.at(-1)).toBe('commit');
  });

  it('the ordinary single action: mutex, the previous statement held, every read, then every write', async () => {
    await dormantSinceOctober(savings, '5000.00', OCT_5);

    const sent = await capturing(() =>
      confirmUnchanged(positions(), OCT_5, { positionId: savings, month: '2026-09' }),
    );

    expect(sent.filter((statement) => statement.startsWith('begin'))).toHaveLength(1);
    const mutex = sent.findIndex((statement) => statement.includes('pg_advisory_xact_lock'));
    const firstRead = sent.findIndex((statement) => /^select .* from "(positions|position_valuations)"/u.test(statement));
    expect(mutex).toBeGreaterThan(0);
    expect(firstRead).toBeGreaterThan(mutex);
    expect(sent.filter((statement) => /from "position_valuations".*for share/u.test(statement))).toHaveLength(1);

    const firstWrite = sent.findIndex(isWrite);
    const lastResolutionRead = sent.findLastIndex((statement) =>
      /^select .* from "(positions|position_valuations)"/u.test(statement),
    );
    expect(firstWrite).toBeGreaterThan(lastResolutionRead);
    // The balance and the wake, each audited, in the one transaction.
    expect(sent.filter(isWrite).map((statement) => statement.split(' (')[0])).toEqual([
      'insert into "position_valuations"',
      'insert into "audit_entries"',
      expect.stringMatching(/^update "cash_accounts"/u) as unknown as string,
      'insert into "audit_entries"',
    ]);
    expect(sent.at(-1)).toBe('commit');
  });

  it('a reviewed batch confirms the same way: mutex and locks first, the writes last', async () => {
    await balance(bbva, '2026-08-31', '1000.00', 'month_end', NOV_5);
    await dormantSinceOctober(savings, '5000.00', NOV_5);
    const draft: CorrectionDraft = { kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [bbva, savings] };
    const reviewed = await requireReview(draft, NOV_5);

    const sent = await capturing(() =>
      confirmHistoricalCorrection(corrections(), NOV_5, { draft, fingerprint: reviewed.fingerprint }),
    );

    const mutex = sent.findIndex((statement) => statement.includes('pg_advisory_xact_lock'));
    const accounts = sent.findIndex((statement) => /for update of "positions", "cash_accounts"/u.test(statement));
    expect(mutex).toBeGreaterThan(0);
    expect(accounts).toBeGreaterThan(mutex);
    const firstWrite = sent.findIndex(isWrite);
    expect(firstWrite).toBeGreaterThan(accounts);
    // The resolution and the re-derived impact are all read first; after the
    // first write come only writes, the wake's own audit before-image, and the
    // commit.
    expect(
      sent
        .slice(firstWrite)
        .filter((statement) => !isWrite(statement) && statement !== 'commit')
        .every((statement) => /^select .* from "cash_accounts"/u.test(statement)),
    ).toBe(true);
    expect(sent.at(-1)).toBe('commit');
    expect(await state(savings)).toMatchObject(AWAKE);
  });

  it('a refusal anywhere in the resolution writes nothing at all', async () => {
    await dormantSinceOctober(bbva, '1000.00', OCT_5);

    const sent = await capturing(() =>
      confirmUnchangedBatch(positions(), OCT_5, { month: '2026-09', positionIds: [bbva, savings] }),
    );
    expect(sent.filter(isWrite)).toEqual([]);
    expect(sent.at(-1)).toBe('rollback');
  });
});
