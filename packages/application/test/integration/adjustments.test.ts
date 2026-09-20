import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findPosition, listIncomeEntries, sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createIncomeEntry } from '../../src/flows/income';
import { createExpenseEntry } from '../../src/flows/expenses';
import { acceptUnexplainedInflowAsAdjustment } from '../../src/flows/adjustments';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import { getMonthToDate } from '../../src/reconciliation/mtd-service';
import { getMonthReportingCashFlow } from '../../src/reconciliation/reporting-service';
import { ValidationError, VersionConflictError } from '../../src/errors';
import { setDormantFlag } from '../helpers/corrections';

/**
 * "Accept as adjustment" against a real database (blueprint 8.5, 30.21; ADR
 * 0009 §5–§9).
 *
 * The month here is the simplest one that raises the issue: an account whose
 * balance grew with nothing recorded to explain it. Every figure is derived at
 * read time, and each case asserts what the *month* says afterwards rather than
 * how the service reached it.
 */

const USER_A = '77777777-7777-4777-8777-777777777777';
const USER_B = '88888888-8888-4888-8888-888888888888';

let harness: Harness;
let groceries: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

/** 8.1: September is completed from 1 October. */
const OCTOBER_1 = on('2026-10-01');
/** 8.6's own example day, with the evidence dates below inside it. */
const SEPT_10 = on('2026-09-10');
const SEPTEMBER = parseMonth('2026-09');

function deps() {
  return harness.services.flows;
}

function readDeps() {
  return { db: harness.db, fx: harness.services.fx };
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

async function makeAccount(
  name: string,
  options: { currency?: string; userId?: string; ctx?: RequestContext } = {},
): Promise<string> {
  const created = await createCashAccount(
    harness.services.positions,
    options.ctx ?? (options.userId === undefined ? OCTOBER_1 : on('2026-10-01', options.userId)),
    {
      name,
      currency: options.currency ?? 'EUR',
      accountType: 'checking',
      openedOn: null,
    },
  );
  return created.id;
}

async function statement(
  positionId: string,
  valuedOn: string,
  amount: string,
  ctx: RequestContext = OCTOBER_1,
): Promise<void> {
  await recordValuation(harness.services.positions, ctx, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });
}

async function snapshot(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, on(valuedOn), {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });
}

/** The month's income rows as the repository maps them — dates as dates, amounts exact. */
async function incomeRows(userId = USER_A) {
  return listIncomeEntries(harness.db, userId, '2026-09-01', '2026-09-30');
}

async function auditActionsFor(entityId: string, userId = USER_A): Promise<string[]> {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action FROM audit_entries WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    );
    return (result.rows as { action: string }[]).map((row) => row.action);
  });
}

async function countRows(table: string, userId = USER_A): Promise<number> {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    return (result.rows[0] as { n: number }).n;
  });
}

async function eurBucket(ctx: RequestContext = OCTOBER_1) {
  const result = await getMonthReconciliation(readDeps(), ctx, SEPTEMBER);
  return result.buckets.find((bucket) => bucket.currency === 'EUR');
}

/**
 * September with 500 of cash nobody explained: one account, two statements, no
 * flows. `ΣI = 0`, `Δ = 500`, so the tracked total is −500 and the unclassified
 * −500 — 8.5's variant A, with an unexplained inflow of 500.
 */
async function unexplainedSeptember(): Promise<string> {
  const account = await makeAccount('BBVA');
  await statement(account, '2026-08-31', '1000.00');
  await statement(account, '2026-09-30', '1500.00');
  return account;
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'adjust-a@example.test'],
    [USER_B, 'adjust-b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');

  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.name === 'Groceries')?.id as string;
});

describe('accepting a completed month’s unexplained inflow', () => {
  it('writes one adjustment with the facts the server derived', async () => {
    await unexplainedSeptember();
    expect((await eurBucket())?.issues.find((i) => i.key === 'unexplained_inflow')?.amount).toEqual({
      amount: '500',
      currency: 'EUR',
    });

    const created = await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
    });

    const rows = await incomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      kind: 'adjustment',
      settlement: 'tracked_cash',
      // 8.2's residual is the bucket's, so no account is named (ADR 0009 §6).
      cashPositionId: null,
      // The interval's endpoint, not a day anybody observed (30.21 item 5).
      receivedOn: '2026-09-30',
      currency: 'EUR',
      description: 'Reconciliation adjustment — September 2026',
      // Scheduling metadata belongs to a recurring occurrence, and this is none.
      templateId: null,
      occurrenceDate: null,
    });
    expect(rows[0]?.netAmount).toBe('500.00000000');
    // Written through the ordinary flow path, so it is audited like any row.
    expect(await auditActionsFor(created.id)).toEqual(['insert']);
  });

  it('carries the user’s note beside the description it derived', async () => {
    await unexplainedSeptember();
    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
      note: 'Cash I could not trace',
    });

    expect((await incomeRows())[0]?.description).toBe(
      'Reconciliation adjustment — September 2026: Cash I could not trace',
    );
  });

  it('leaves the month reconciled, with the issue gone', async () => {
    await unexplainedSeptember();
    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
    });

    const bucket = await eurBucket();
    expect(bucket?.status).toBe('reliable');
    expect(bucket?.totals.unclassified?.amount).toBe('0');
    expect(bucket?.totals.externalInflows.amount).toBe('500');
    expect(bucket?.issues).toEqual([]);
  });

  it('does not become income for the savings figures', async () => {
    await unexplainedSeptember();
    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
    });

    // 12.5 counts employment, freelance, bonus, rental, other, dividends and
    // interest — never an adjustment, whatever it does for the identity (7.4).
    const reporting = await getMonthReportingCashFlow(readDeps(), OCTOBER_1, SEPTEMBER);
    expect(reporting.externalIncome.value.amount).toBe('0');
    expect(reporting.externalIncome.availability).toBe('available');
    expect(reporting.savingsRate.kind).toBe('unavailable');
    expect(reporting.trackedTotalSpending.value.amount).toBe('0');
  });

  it('leaves a dormant account of the month dormant', async () => {
    // The adjustment attributes to no account, so nothing about it is an
    // attributed flow, and 8.8's wake never fires.
    const dormant = await makeAccount('Old wallet');
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: dormant,
      valuedOn: '2026-08-20',
      amount: '0.00',
      datePrecision: 'exact',
    });
    await setDormantFlag(harness.services, OCTOBER_1, {
      positionId: dormant,
      expectedVersion: 1,
      isDormant: true,
    });
    await unexplainedSeptember();

    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
    });

    const after = await findPosition(harness.db, USER_A, dormant);
    expect(after?.isDormant).toBe(true);
    expect(after?.dormantFrom).toBe('2026-08-20');
  });
});

describe('accepting the current month’s unexplained inflow', () => {
  /**
   * September to date, through the 6th: two accounts share that day, one of
   * them has a newer balance on the 8th that cannot move `D`, and the cash at
   * `D` is 400 more than the records explain.
   */
  async function unexplainedToDate(): Promise<void> {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const savings = await makeAccount('Savings', { ctx: SEPT_10 });
    await statement(bbva, '2026-08-31', '1000.00', SEPT_10);
    await statement(savings, '2026-08-31', '500.00', SEPT_10);
    await snapshot(bbva, '2026-09-06', '1400.00');
    await snapshot(savings, '2026-09-06', '500.00');
    await snapshot(bbva, '2026-09-08', '1900.00');
  }

  it('dates the adjustment at the month-to-date evidence date', async () => {
    await unexplainedToDate();
    const before = await getMonthToDate(readDeps(), SEPT_10);
    expect(before.asOf).toBe('2026-09-06');
    expect(
      before.buckets?.[0]?.issues.find((i) => i.key === 'unexplained_inflow')?.amount,
    ).toEqual({ amount: '400', currency: 'EUR' });

    await acceptUnexplainedInflowAsAdjustment(deps(), SEPT_10, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '400',
    });

    const rows = await incomeRows();
    expect(rows).toHaveLength(1);
    // `D`, never today: a row dated the 10th would not be in the figure it
    // was recorded to fix (8.6, 30.21 item 7).
    expect(rows[0]?.receivedOn).toBe('2026-09-06');
    expect(rows[0]?.netAmount).toBe('400.00000000');
  });

  it('leaves month to date reconciled through the same date', async () => {
    await unexplainedToDate();
    await acceptUnexplainedInflowAsAdjustment(deps(), SEPT_10, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '400',
    });

    const after = await getMonthToDate(readDeps(), SEPT_10);
    expect(after.asOf).toBe('2026-09-06');
    const bucket = after.buckets?.[0];
    expect(bucket?.status).toBe('provisional');
    expect(bucket?.totals.unclassified?.amount).toBe('0');
    // The 8th's balance still sits outside the interval, exactly as before.
    expect(after.accountsWithNewerBalances).toHaveLength(1);
  });

  it('refuses when there is no common date, so no interval exists', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const savings = await makeAccount('Savings', { ctx: SEPT_10 });
    await statement(bbva, '2026-08-31', '1000.00', SEPT_10);
    await statement(savings, '2026-08-31', '500.00', SEPT_10);
    await snapshot(bbva, '2026-09-06', '1400.00');
    await snapshot(savings, '2026-09-03', '500.00');

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), SEPT_10, {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '400',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await countRows('income_entries')).toBe(0);
  });
});

describe('a stale acceptance', () => {
  it('refuses an amount the month no longer shows', async () => {
    await unexplainedSeptember();
    const auditBefore = await countRows('audit_entries');

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '450',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await countRows('income_entries')).toBe(0);
    // Nothing was written, so nothing was audited either.
    expect(await countRows('audit_entries')).toBe(auditBefore);
  });

  it('refuses a second acceptance after the first resolved the month', async () => {
    await unexplainedSeptember();
    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '500',
    });
    const auditBefore = await countRows('audit_entries');

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    // Exactly one adjustment, and no second audit row.
    expect(await countRows('income_entries')).toBe(1);
    expect(await countRows('audit_entries')).toBe(auditBefore);
  });

  it('refuses once the real record explains the cash instead', async () => {
    const account = await unexplainedSeptember();
    await createIncomeEntry(deps(), on('2026-09-25'), {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: account,
    });

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await incomeRows()).map((row) => row.kind)).toEqual(['employment']);
  });

  it('refuses a currency the month has no bucket for', async () => {
    await unexplainedSeptember();

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: SEPTEMBER,
        currency: 'USD',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await countRows('income_entries')).toBe(0);
  });

  it('refuses a bucket that reconciles, however large its residual', async () => {
    // An ordinary reliable month: 500 of unclassified spending is a figure, not
    // a contradiction, and there is nothing to accept.
    const account = await makeAccount('BBVA');
    await statement(account, '2026-08-31', '1000.00');
    await statement(account, '2026-09-30', '500.00');
    expect((await eurBucket())?.totals.unclassified?.amount).toBe('500');

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await countRows('income_entries')).toBe(0);
  });

  it('refuses a month that has not started', async () => {
    await unexplainedSeptember();

    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
        month: parseMonth('2026-11'),
        currency: 'EUR',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await countRows('income_entries')).toBe(0);
  });
});

describe('another tenant', () => {
  it('cannot accept an adjustment against a month that is not theirs', async () => {
    await unexplainedSeptember();

    // User B's own September has no account, no bucket and nothing to accept.
    await expect(
      acceptUnexplainedInflowAsAdjustment(deps(), on('2026-10-01', USER_B), {
        month: SEPTEMBER,
        currency: 'EUR',
        expectedAmount: '500',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    expect(await countRows('income_entries', USER_A)).toBe(0);
    expect(await countRows('income_entries', USER_B)).toBe(0);
    // And user A's month is untouched: still the issue it had.
    expect((await eurBucket())?.issues.map((i) => i.key)).toEqual(['unexplained_inflow']);
  });
});

describe('the adjustment afterwards', () => {
  it('is an ordinary income row the month’s editors can correct', async () => {
    const account = await unexplainedSeptember();
    // A known expense as well, so the month has more than one record to read.
    await createExpenseEntry(deps(), on('2026-09-12'), {
      categoryId: groceries,
      incurredOn: '2026-09-12',
      amount: '40.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: account,
    });
    // Δ = 500, ΣK = 40 → total = −500, unclassified = −540.
    await acceptUnexplainedInflowAsAdjustment(deps(), OCTOBER_1, {
      month: SEPTEMBER,
      currency: 'EUR',
      expectedAmount: '540',
    });

    const bucket = await eurBucket();
    expect(bucket?.totals.externalInflows.amount).toBe('540');
    expect(bucket?.totals.knownTrackedExpenses.amount).toBe('40');
    expect(bucket?.totals.unclassified?.amount).toBe('0');
    expect(bucket?.status).toBe('reliable');
  });
});
