import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { closePosition, createCashAccount, updateCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createCashTransfer } from '../../src/flows/transfers';
import { getMonthToDate } from '../../src/reconciliation/mtd-service';

/**
 * Month-to-date reconciliation against a real database (blueprint 21.3, 8.6).
 *
 * September 2026, today on the 10th, so "the 6th" and "the 8th" are 8.6's own
 * example. Every figure is derived at read time; nothing stores a provisional
 * result, and 8.6 adds that nothing provisional feeds averages or completeness.
 */

const USER_A = '55555555-5555-4555-8555-555555555555';
const USER_B = '66666666-6666-4666-8666-666666666666';

let harness: Harness;
let categoryId: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const SEPT_10 = on('2026-09-10');

function deps() {
  return harness.services.flows;
}

function readDeps() {
  return { db: harness.db };
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
  options: { currency?: string; openedOn?: string | null } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, SEPT_10, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: options.openedOn ?? null,
  });
  return created.id;
}

/** August's statement balance, written on the 1st when September had not begun. */
async function opening(positionId: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, SEPT_10, {
    positionId,
    valuedOn: '2026-08-31',
    amount,
    datePrecision: 'month_end',
  });
}

/** An ordinary snapshot: the only closing evidence the current month can have. */
async function snapshot(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, on(valuedOn), {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'mtd-a@example.test'],
    [USER_B, 'mtd-b@example.test'],
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
  categoryId = categories.find((row) => row.name === 'Groceries')?.id as string;
});

describe('the common as-of date', () => {
  it('reconciles through the latest day every account shares', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await opening(a, '1000.00');
    await opening(b, '500.00');
    await createExpenseEntry(deps(), on('2026-09-04'), {
      categoryId,
      incurredOn: '2026-09-04',
      amount: '100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '500.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.month).toBe('2026-09');
    expect(result.asOf).toBe('2026-09-06');
    expect(result.status).toBe('provisional');

    const bucket = result.buckets?.find((x) => x.currency === 'EUR');
    expect(bucket?.totals.cashDelta?.amount).toBe('-100');
    expect(bucket?.totals.knownTrackedExpenses.amount).toBe('100');
    expect(bucket?.totals.trackedTotalSpending?.amount).toBe('100');
    expect(bucket?.totals.unclassified?.amount).toBe('0');
  });

  it('keeps the date where the others are when one account is newer', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await opening(a, '1000.00');
    await opening(b, '500.00');
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '500.00');
    await snapshot(a, '2026-09-08', '850.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    expect(result.accountsWithNewerBalances).toEqual([a]);
    expect(result.issues.map((i) => i.key)).toEqual(['mtd_newer_balances']);
    expect(result.issues[0]?.class).toBe('advisory');
    expect(result.issues[0]?.currency).toBeNull();
    // The 8th balance is not in the arithmetic.
    expect(result.buckets?.[0]?.totals.cashDelta?.amount).toBe('-100');
    expect(result.status).toBe('provisional');
  });

  it('reports no figure at all when no day is shared', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await opening(a, '1000.00');
    await opening(b, '500.00');
    await createIncomeEntry(deps(), on('2026-09-04'), {
      kind: 'employment',
      receivedOn: '2026-09-04',
      netAmount: '700.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-07', '500.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBeNull();
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('mtd_no_common_date');
    // 30.13 item 5: no interval, so no total of any kind — not even the 700 of
    // income the month really does contain.
    expect(result.buckets).toBeNull();
    expect(result.issues.map((i) => i.key)).toEqual(['mtd_no_common_date']);
  });
});

describe('account states at the as-of date', () => {
  it('excludes an account first tracked this month, and stays provisional', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Newly tracked');
    await opening(a, '1000.00');
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '5000.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    expect(result.status).toBe('provisional');

    const bucket = result.buckets?.[0];
    const excluded = bucket?.accounts.find((x) => x.positionId === b);
    expect(excluded?.excludedFirstBalance).toBe(true);
    expect(excluded?.included).toBe(false);
    expect(bucket?.totals.cashDelta?.amount).toBe('-100');
    expect(bucket?.issues.find((i) => i.key === 'first_balance')?.class).toBe('info');
  });

  it('needs no snapshot from a dormant account', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Old account');
    await opening(a, '1000.00');
    await recordValuation(harness.services.positions, on('2026-01-02'), {
      positionId: b,
      valuedOn: '2026-01-01',
      amount: '0.00',
      datePrecision: 'exact',
    });
    await updateCashAccount(harness.services.positions, SEPT_10, {
      positionId: b,
      isDormant: true,
      expectedVersion: 1,
    });
    await snapshot(a, '2026-09-06', '1000.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    const dormant = result.buckets?.[0]?.accounts.find((x) => x.positionId === b);
    expect(dormant?.snapshotRequired).toBe(false);
    expect(dormant?.asOfState).toBe('dormant_zero');
  });

  it('needs no snapshot from an account closed before the date', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Closed');
    await opening(a, '1000.00');
    await opening(b, '80.00');
    // M6: an account closes only against a final balance of zero on the day.
    await snapshot(b, '2026-09-04', '0.00');
    await closePosition(harness.services.positions, SEPT_10, {
      positionId: b,
      closedOn: '2026-09-04',
      expectedVersion: 1,
    });
    await snapshot(a, '2026-09-06', '1000.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    const closed = result.buckets?.[0]?.accounts.find((x) => x.positionId === b);
    expect(closed?.asOfState).toBe('closed_zero');
    expect(closed?.asOfAmount?.amount).toBe('0');
    expect(result.buckets?.[0]?.totals.cashDelta?.amount).toBe('-80');
  });

  it('opens an account created this month at zero and still asks for the date', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('New', { openedOn: '2026-09-03' });
    await opening(a, '1000.00');
    await createCashTransfer(deps(), on('2026-09-05'), {
      occurredOn: '2026-09-05',
      fromPositionId: a,
      toPositionId: b,
      fromAmount: '100.00',
      toAmount: '100.00',
    });
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '100.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    const opened = result.buckets?.[0]?.accounts.find((x) => x.positionId === b);
    expect(opened?.openState).toBe('opened_zero');
    expect(opened?.snapshotRequired).toBe(true);
    // The transfer cancels inside the bucket.
    expect(result.buckets?.[0]?.totals.cashDelta?.amount).toBe('0');
    expect(result.buckets?.[0]?.totals.trackedTotalSpending?.amount).toBe('0');
  });

  it('lets an account opened later in the month keep an earlier date', async () => {
    const a = await makeAccount('BBVA');
    await makeAccount('Opened later', { openedOn: '2026-09-08' });
    await opening(a, '1000.00');
    await snapshot(a, '2026-09-06', '900.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    // It is not in the interval `[start(M), D]` at all (30.13 item 8).
    expect(result.buckets?.[0]?.accounts.map((x) => x.positionId)).toEqual([a]);
  });

  it('keeps a currency whose accounts are all excluded, with no figures', async () => {
    // The EUR pair are the month's first_balance exclusions, so USD fixes the
    // date alone. The EUR bucket still exists — 8.1 enumerates it from
    // participating accounts — and reports both info issues, four measured
    // zeros and no balance-derived figure at all.
    const one = await makeAccount('Newly tracked');
    const two = await makeAccount('Also newly tracked');
    const usdAccount = await makeAccount('USD account', { currency: 'USD' });
    await opening(usdAccount, '500.00');
    await snapshot(one, '2026-09-06', '5000.00');
    await snapshot(two, '2026-09-06', '900.00');
    await snapshot(usdAccount, '2026-09-06', '480.00');
    await createIncomeEntry(deps(), on('2026-09-04'), {
      kind: 'employment',
      receivedOn: '2026-09-04',
      netAmount: '5000.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: one,
    });

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');

    const eur = result.buckets?.find((x) => x.currency === 'EUR');
    expect(eur?.status).toBe('unavailable');
    expect(eur?.reason).toBeNull();
    expect(eur?.issues.map((i) => i.key)).toEqual(['first_balance', 'first_balance']);
    expect(eur?.totals.externalInflows.amount).toBe('0');
    expect(eur?.totals.knownTrackedExpenses.amount).toBe('0');
    expect(eur?.totals.cashDelta).toBeNull();
    expect(eur?.totals.trackedTotalSpending).toBeNull();
    expect(eur?.totals.unclassified).toBeNull();

    const usd = result.buckets?.find((x) => x.currency === 'USD');
    expect(usd?.status).toBe('provisional');
    expect(usd?.totals.cashDelta?.amount).toBe('-20');
    expect(result.status).toBe('unavailable');
  });

  it('makes one bucket unavailable for a missing opening and leaves the other', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('USD account', { currency: 'USD' });
    // EUR: only a July snapshot, so no usable September opening.
    await recordValuation(harness.services.positions, on('2026-07-16'), {
      positionId: a,
      valuedOn: '2026-07-15',
      amount: '1000.00',
      datePrecision: 'exact',
    });
    await opening(b, '500.00');
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '480.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');

    const eur = result.buckets?.find((x) => x.currency === 'EUR');
    const usd = result.buckets?.find((x) => x.currency === 'USD');
    expect(eur?.status).toBe('unavailable');
    expect(eur?.reason).toBe('missing_opening');
    expect(eur?.totals.cashDelta).toBeNull();
    // 30.13 item 4: the USD figure survives.
    expect(usd?.status).toBe('provisional');
    expect(usd?.totals.cashDelta?.amount).toBe('-20');
    expect(result.status).toBe('unavailable');
  });
});

describe('flows through the as-of date', () => {
  async function twoAccountsThrough(sixth: string): Promise<string> {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await opening(a, '1000.00');
    await opening(b, '0.00');
    await snapshot(a, '2026-09-06', sixth);
    await snapshot(b, '2026-09-06', '0.00');
    return a;
  }

  it('counts a flow dated on the date itself', async () => {
    const a = await makeAccount('BBVA');
    await opening(a, '1000.00');
    await createExpenseEntry(deps(), on('2026-09-06'), {
      categoryId,
      incurredOn: '2026-09-06',
      amount: '100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });
    await snapshot(a, '2026-09-06', '900.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    expect(result.buckets?.[0]?.totals.knownTrackedExpenses.amount).toBe('100');
    expect(result.buckets?.[0]?.totals.unclassified?.amount).toBe('0');
  });

  it('ignores a flow dated the day after, although it is recorded', async () => {
    const a = await twoAccountsThrough('900.00');
    await createExpenseEntry(deps(), on('2026-09-07'), {
      categoryId,
      incurredOn: '2026-09-07',
      amount: '100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    expect(result.buckets?.[0]?.totals.knownTrackedExpenses.amount).toBe('0');
    expect(result.buckets?.[0]?.totals.unclassified?.amount).toBe('100');
  });

  it('places a flow with no account named in its currency bucket', async () => {
    const a = await makeAccount('BBVA');
    await opening(a, '1000.00');
    await createIncomeEntry(deps(), on('2026-09-04'), {
      kind: 'employment',
      receivedOn: '2026-09-04',
      netAmount: '100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
    });
    await snapshot(a, '2026-09-06', '1100.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.buckets?.[0]?.totals.externalInflows.amount).toBe('100');
    expect(result.buckets?.[0]?.totals.trackedTotalSpending?.amount).toBe('0');
    expect(result.status).toBe('provisional');
  });

  it('splits a cross-currency transfer into two native buckets on one date', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('USD account', { currency: 'USD' });
    await opening(a, '1000.00');
    await opening(b, '0.00');
    await createCashTransfer(deps(), on('2026-09-05'), {
      occurredOn: '2026-09-05',
      fromPositionId: a,
      toPositionId: b,
      fromAmount: '200.00',
      toAmount: '216.45',
    });
    await snapshot(a, '2026-09-06', '800.00');
    await snapshot(b, '2026-09-06', '216.45');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    const eur = result.buckets?.find((x) => x.currency === 'EUR');
    const usd = result.buckets?.find((x) => x.currency === 'USD');
    expect(eur?.totals.nonExpenseOutflows.amount).toBe('200');
    expect(usd?.totals.nonIncomeInflows.amount).toBe('216.45');
    expect(eur?.totals.trackedTotalSpending?.amount).toBe('0');
    expect(usd?.totals.trackedTotalSpending?.amount).toBe('0');
  });

  it('is unresolved when the records contradict each other', async () => {
    const a = await makeAccount('BBVA');
    await opening(a, '1000.00');
    await snapshot(a, '2026-09-06', '1300.00');

    const result = await getMonthToDate(readDeps(), SEPT_10);
    expect(result.status).toBe('unresolved');
    const raised = result.buckets?.[0]?.issues.find((i) => i.key === 'unexplained_inflow');
    expect(raised?.class).toBe('blocking');
    expect(raised?.amount?.amount).toBe('300');
    expect(raised?.variant).toBe('a');
  });
});

describe('the read itself', () => {
  it('shows another user nothing', async () => {
    const a = await makeAccount('BBVA');
    await opening(a, '1000.00');
    await snapshot(a, '2026-09-06', '900.00');

    const mine = await getMonthToDate(readDeps(), SEPT_10);
    expect(mine.asOf).toBe('2026-09-06');

    const theirs = await getMonthToDate(readDeps(), on('2026-09-10', USER_B));
    // No accounts at all, so no included set and therefore no date (30.13 item 6).
    expect(theirs.asOf).toBeNull();
    expect(theirs.buckets).toBeNull();
  });

  it('stores nothing, and answers differently when a balance is corrected', async () => {
    const a = await makeAccount('BBVA');
    await opening(a, '1000.00');
    await snapshot(a, '2026-09-06', '900.00');

    const before = await getMonthToDate(readDeps(), SEPT_10);
    expect(before.buckets?.[0]?.totals.cashDelta?.amount).toBe('-100');

    // A later snapshot everyone shares moves the date forward, and the answer
    // with it — nothing was stored to become stale.
    await snapshot(a, '2026-09-08', '850.00');
    const after = await getMonthToDate(readDeps(), SEPT_10);
    expect(after.asOf).toBe('2026-09-08');
    expect(after.buckets?.[0]?.totals.cashDelta?.amount).toBe('-150');
    expect(after.accountsWithNewerBalances).toEqual([]);
  });

  it('reads the month in a fixed number of round trips', async () => {
    // 23.2: the count does not grow with the data. Every repository call opens
    // one transaction, so counting those counts the round trips.
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await opening(a, '1000.00');
    await opening(b, '0.00');
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '0.00');

    const small = await countRoundTrips();

    for (let index = 0; index < 12; index += 1) {
      await createExpenseEntry(deps(), on('2026-09-05'), {
        categoryId,
        incurredOn: '2026-09-05',
        amount: '1.00',
        currency: 'EUR',
        settlement: 'untracked_self',
      });
      await createIncomeEntry(deps(), on('2026-09-05'), {
        kind: 'employment',
        receivedOn: '2026-09-05',
        netAmount: '1.00',
        currency: 'EUR',
        settlement: 'external',
      });
    }
    const large = await countRoundTrips();

    expect(large).toBe(small);
    // Named so a regression that adds a query per account is visible, not just
    // "the same as whatever it was".
    expect(small).toBe(5);
  });
});

/**
 * How many transactions one month-to-date read opens.
 *
 * Counted by proxying the database handle rather than by reading a server
 * counter, so it measures this read and nothing else running alongside it.
 */
async function countRoundTrips(): Promise<number> {
  let transactions = 0;
  const counting = new Proxy(harness.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'transaction' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        transactions += 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  await getMonthToDate({ db: counting }, SEPT_10);
  return transactions;
}
