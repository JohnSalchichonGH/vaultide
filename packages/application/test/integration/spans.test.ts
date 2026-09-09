import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createCashTransfer } from '../../src/flows/transfers';
import { getSpans } from '../../src/reconciliation/span-service';
import { monthKey, plainDate } from '@vaultide/finance';

/**
 * Multi-month reconciliation spans against a real database (blueprint 21.3, 8.7).
 *
 * Today is 1 December 2026 throughout, so September, October and November are
 * completed months and December is not. Nothing is stored: 8.7 recomputes a
 * span on every read.
 */

const USER_A = '77777777-7777-4777-8777-777777777777';
const USER_B = '88888888-8888-4888-8888-888888888888';

let harness: Harness;
let categoryId: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const DEC_1 = on('2026-12-01');

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
  const created = await createCashAccount(harness.services.positions, DEC_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: options.openedOn ?? null,
  });
  return created.id;
}

/** A statement month-end balance, written once the month has ended (M5). */
async function statement(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, DEC_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'span-a@example.test'],
    [USER_B, 'span-b@example.test'],
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

describe('a gap between two statement balances', () => {
  it('reports one span over the whole gap, from real rows', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '700.00');
    await createExpenseEntry(deps(), on('2026-10-11'), {
      categoryId,
      incurredOn: '2026-10-11',
      amount: '120.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });

    const spans = await getSpans(readDeps(), DEC_1);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe('2026-09-01');
    expect(spans[0]?.to).toBe('2026-11-30');
    expect(spans[0]?.months).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(spans[0]?.totals.cashDelta.amount).toBe('-300');
    expect(spans[0]?.totals.knownTrackedExpenses.amount).toBe('120');
    expect(spans[0]?.trackedTotalSpending.amount).toBe('300');
    expect(spans[0]?.unclassified.amount).toBe('180');
    expect(spans[0]?.status).toBe('reliable');
  });

  it('splits when the missing statement is entered', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-06-30', '1000.00');
    await statement(a, '2026-09-30', '940.00');
    await statement(a, '2026-11-30', '900.00');

    const before = await getSpans(readDeps(), DEC_1);
    expect(before.map((s) => `${s.from}..${s.to}`)).toEqual([
      '2026-07-01..2026-09-30',
      '2026-10-01..2026-11-30',
    ]);

    await statement(a, '2026-08-31', '960.00');
    const after = await getSpans(readDeps(), DEC_1);
    // July–August remains a span; September alone is now reconcilable.
    expect(after.map((s) => `${s.from}..${s.to}`)).toEqual([
      '2026-07-01..2026-08-31',
      '2026-10-01..2026-11-30',
    ]);
  });

  it('reports nothing when every month end is present', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-09-30', '1000.00');
    await statement(a, '2026-10-31', '900.00');
    await statement(a, '2026-11-30', '900.00');

    // Absence is absence: no result object explaining why (30.14).
    expect(await getSpans(readDeps(), DEC_1)).toEqual([]);
  });
});

describe('accounts inside the interval', () => {
  it('opens an account created mid-span at zero', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    const b = await makeAccount('New', { openedOn: '2026-10-05' });
    await createCashTransfer(deps(), on('2026-10-06'), {
      occurredOn: '2026-10-06',
      fromPositionId: a,
      toPositionId: b,
      fromAmount: '300.00',
      toAmount: '300.00',
    });
    await statement(a, '2026-11-30', '600.00');
    await statement(b, '2026-11-30', '300.00');

    const spans = await getSpans(readDeps(), DEC_1);
    expect(spans).toHaveLength(1);
    const opened = spans[0]?.accounts.find((x) => x.positionId === b);
    expect(opened?.openingState).toBe('opened_zero');
    expect(opened?.opening.amount).toBe('0');
    // −400 on BBVA and +300 on the new account.
    expect(spans[0]?.totals.cashDelta.amount).toBe('-100');
    expect(spans[0]?.trackedTotalSpending.amount).toBe('100');
  });

  it('leaves no span when a pre-existing account has no opening evidence', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');
    // Existed all along; its first statement is November, so August is not a
    // complete anchor (30.14 item 5).
    const b = await makeAccount('Newly tracked');
    await statement(b, '2026-11-30', '5000.00');

    expect(await getSpans(readDeps(), DEC_1)).toEqual([]);
  });
});

describe('currencies and boundaries', () => {
  it('discovers each currency on its own evidence', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('USD account', { currency: 'USD' });
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');
    await statement(b, '2026-08-31', '500.00');
    await statement(b, '2026-10-31', '480.00');
    await statement(b, '2026-11-30', '480.00');

    const spans = await getSpans(readDeps(), DEC_1);
    expect(spans.map((s) => `${s.currency} ${s.from}..${s.to}`)).toEqual([
      'EUR 2026-09-01..2026-11-30',
      'USD 2026-09-01..2026-10-31',
    ]);
  });

  it('counts a flow on either boundary day and nothing outside', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '1000.00');
    for (const [day, amount] of [
      ['2026-08-31', '11.00'],
      ['2026-09-01', '22.00'],
      ['2026-11-30', '33.00'],
    ] as const) {
      await createExpenseEntry(deps(), on(day), {
        categoryId,
        incurredOn: day,
        amount,
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: a,
      });
    }

    const spans = await getSpans(readDeps(), DEC_1);
    // The first and last days are in; 31 August is not.
    expect(spans[0]?.totals.knownTrackedExpenses.amount).toBe('55');
  });

  it('never reaches into the current month', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');
    // A December snapshot, which is not a month end and not in any span.
    await recordValuation(harness.services.positions, DEC_1, {
      positionId: a,
      valuedOn: '2026-12-01',
      amount: '880.00',
      datePrecision: 'exact',
    });

    const spans = await getSpans(readDeps(), DEC_1);
    expect(spans[0]?.to).toBe('2026-11-30');
    expect(spans[0]?.months).not.toContain('2026-12');
  });
});

describe('the read itself', () => {
  it('is unresolved when the records contradict each other', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '1300.00');

    const spans = await getSpans(readDeps(), DEC_1);
    expect(spans[0]?.unclassified.amount).toBe('-300');
    expect(spans[0]?.status).toBe('unresolved');
  });

  it('exposes no per-month figure and no issues', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');
    await createIncomeEntry(deps(), on('2026-10-02'), {
      kind: 'employment',
      receivedOn: '2026-10-02',
      netAmount: '50.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: a,
    });

    const spans = await getSpans(readDeps(), DEC_1);
    const keys = Object.keys(spans[0] ?? {}).sort();
    expect(keys).toEqual([
      'accounts',
      'currency',
      'explanation',
      'from',
      'months',
      'status',
      'to',
      'totals',
      'trackedTotalSpending',
      'unclassified',
    ]);
  });

  it('shows another user nothing', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');

    expect(await getSpans(readDeps(), DEC_1)).toHaveLength(1);
    expect(await getSpans(readDeps(), on('2026-12-01', USER_B))).toEqual([]);
  });

  /**
   * The requested window and the reads it implies (8.7, ADR 0004 §3).
   *
   * A window says which spans to report, never how much evidence to consult.
   * Both halves have to hold together against a real database: discovery has to
   * see an anchor older than the window, and the flow reads have to reach back
   * to whatever it found — a correct interval with half its flows missing would
   * be worse than no span at all, because it would look like an answer.
   */
  describe('W — a requested window selects spans, it does not truncate history', () => {
    it('W1 — returns a span whose anchor and flows both precede the window', async () => {
      const a = await makeAccount('BBVA');
      await statement(a, '2026-08-31', '1000.00');
      await statement(a, '2026-11-30', '700.00');
      // September is before the requested window on both counts: the anchor it
      // follows is August, and this expense is dated inside it.
      await createExpenseEntry(deps(), on('2026-09-15'), {
        categoryId,
        incurredOn: '2026-09-15',
        amount: '100.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: a,
      });

      const spans = await getSpans(readDeps(), DEC_1, {
        from: monthKey(plainDate('2026-10-01')),
      });

      expect(spans).toHaveLength(1);
      expect(spans[0]?.from).toBe('2026-09-01');
      expect(spans[0]?.to).toBe('2026-11-30');
      expect(spans[0]?.months).toEqual(['2026-09', '2026-10', '2026-11']);
      expect(spans[0]?.totals.knownTrackedExpenses.amount).toBe('100');
      expect(spans[0]?.totals.cashDelta.amount).toBe('-300');
      expect(spans[0]?.unclassified.amount).toBe('200');
    });

    it('W3 — leaves out a span that ended before the window began', async () => {
      const a = await makeAccount('BBVA');
      for (const [on_, amount] of [
        ['2026-01-31', '1000.00'],
        ['2026-05-31', '900.00'],
        ['2026-08-31', '800.00'],
        ['2026-11-30', '700.00'],
      ] as const) {
        await statement(a, on_, amount);
      }

      const whole = await getSpans(readDeps(), DEC_1, {
        from: monthKey(plainDate('2026-01-01')),
      });
      expect(whole.map((span) => span.from)).toEqual([
        '2026-02-01',
        '2026-06-01',
        '2026-09-01',
      ]);

      const windowed = await getSpans(readDeps(), DEC_1, {
        from: monthKey(plainDate('2026-09-01')),
      });
      expect(windowed.map((span) => span.from)).toEqual(['2026-09-01']);
    });

    it('W2 — reaches back years when that is where the anchor is', async () => {
      const a = await makeAccount('BBVA');
      await statement(a, '2023-04-30', '5000.00');
      await statement(a, '2026-11-30', '4000.00');
      await createIncomeEntry(deps(), on('2023-07-11'), {
        kind: 'employment',
        receivedOn: '2023-07-11',
        netAmount: '250.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: a,
      });

      // More than three years before the requested window, and past any
      // lookback a single-stage read could have been given.
      const spans = await getSpans(readDeps(), DEC_1, {
        from: monthKey(plainDate('2026-11-01')),
      });

      expect(spans).toHaveLength(1);
      expect(spans[0]?.from).toBe('2023-05-01');
      expect(spans[0]?.months).toHaveLength(43);
      expect(spans[0]?.totals.externalInflows.amount).toBe('250');
      expect(spans[0]?.totals.cashDelta.amount).toBe('-1000');
    });

    it('still reads that history in the same five round trips', async () => {
      const a = await makeAccount('BBVA');
      await statement(a, '2023-04-30', '5000.00');
      await statement(a, '2026-11-30', '4000.00');

      expect(
        await countRoundTrips({ from: monthKey(plainDate('2026-11-01')) }),
      ).toBe(5);
    });
  });

  it('reads the history in a fixed number of round trips', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-11-30', '900.00');

    const small = await countRoundTrips();

    const b = await makeAccount('Savings');
    await statement(b, '2026-08-31', '500.00');
    await statement(b, '2026-11-30', '500.00');
    for (let index = 0; index < 10; index += 1) {
      await createExpenseEntry(deps(), on('2026-10-05'), {
        categoryId,
        incurredOn: '2026-10-05',
        amount: '1.00',
        currency: 'EUR',
        settlement: 'untracked_self',
      });
    }
    const large = await countRoundTrips();

    expect(large).toBe(small);
    expect(small).toBe(5);
  });
});

/** How many transactions one span read opens. */
async function countRoundTrips(query: Parameters<typeof getSpans>[2] = {}): Promise<number> {
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

  await getSpans({ db: counting }, DEC_1, query);
  return transactions;
}
