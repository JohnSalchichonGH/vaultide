import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createTemplate } from '../../src/recurring/templates';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import { getRollingTrackedSpendingSeries } from '../../src/reconciliation/rolling-service';
import { getSpans } from '../../src/reconciliation/span-service';
import type { MonthReconciliationDto, ReconciliationBucketDto } from '../../src/reconciliation/types';

/**
 * `large_unclassified` against a real database (8.5, 30.15 item 4).
 *
 * Every month here is built from month-end statements alone, so a month's
 * unclassified residual is exactly the balance it lost. November 2026 is the
 * target throughout and today is 1 December; May … October are its window.
 */

const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let harness: Harness;
let categories: Awaited<ReturnType<typeof listCategories>>;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER, reportingCurrency: 'EUR' });

const DEC_1 = on('2026-12-01');
const NOVEMBER = parseMonth('2026-11');

const deps = () => harness.services.flows;
const readDeps = () => ({ db: harness.db, fx: harness.services.fx });
type ReadDeps = ReturnType<typeof readDeps>;

const categoryOf = (kind: string): string => {
  const found = categories.find((category) => category.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} category`);
  return found.id;
};

async function makeAccount(name: string, currency = 'EUR', openedOn: string | null = null): Promise<string> {
  const created = await createCashAccount(harness.services.positions, DEC_1, {
    name,
    currency,
    accountType: 'checking',
    openedOn,
  });
  return created.id;
}

const statement = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, DEC_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });

/** Month ends from April 2026 to November 2026, in order. */
const ENDS = {
  apr: '2026-04-30', may: '2026-05-31', jun: '2026-06-30', jul: '2026-07-31',
  aug: '2026-08-31', sep: '2026-09-30', oct: '2026-10-31', nov: '2026-11-30',
} as const;

/**
 * Statements whose successive drops are the given residuals: the first entry
 * is the anchor balance at `ends[0]`, and each drop is the next month's
 * unclassified.
 */
async function drops(positionId: string, ends: readonly string[], opening: string, values: readonly string[]): Promise<void> {
  await statement(positionId, ends[0] as string, opening);
  let running = opening;
  for (let index = 0; index < values.length; index += 1) {
    running = subtract(running, values[index] as string);
    await statement(positionId, ends[index + 1] as string, running);
  }
}

/** Exact decimal-string subtraction at two decimals. */
function subtract(a: string, b: string): string {
  const cents = (s: string): number => Math.round(Number(s) * 100);
  return ((cents(a) - cents(b)) / 100).toFixed(2);
}

async function expense(args: { kind: string; incurredOn: string; amount: string; cashPositionId: string }): Promise<void> {
  await createExpenseEntry(deps(), DEC_1, {
    categoryId: categoryOf(args.kind),
    incurredOn: args.incurredOn,
    amount: args.amount,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: args.cashPositionId,
  });
}

const bucketOf = (result: MonthReconciliationDto, currency = 'EUR'): ReconciliationBucketDto => {
  const bucket = result.buckets.find((b) => b.currency === currency);
  if (bucket === undefined) throw new Error(`no ${currency} bucket`);
  return bucket;
};

const advisoryOf = (bucket: ReconciliationBucketDto) =>
  bucket.issues.filter((issue) => issue.key === 'large_unclassified');

async function countRoundTrips<T>(run: (deps: ReadDeps) => Promise<T>): Promise<[number, T]> {
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
  const result = await run({ db: counting, fx: harness.services.fx });
  return [transactions, result];
}

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${USER}, ${'large@example.test'}, ${'large@example.test'}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
  await provisionUser(harness.db, { userId: USER });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');
  await harness.asOwner('DELETE FROM fx_rates');
  categories = await listCategories(harness.db, USER);
});

/** April anchor, then six baseline drops 10,20,30,10,20,30 (median 20) and the target's. */
async function baselineThenTarget(targetDrop: string): Promise<string> {
  const a = await makeAccount('BBVA');
  await drops(a, Object.values(ENDS), '1000.00', ['10', '20', '30', '10', '20', '30', targetDrop]);
  return a;
}

/* -------------------------------------------------------------------------- */
/* A / B — the trigger, and its exact edge                                    */
/* -------------------------------------------------------------------------- */

describe('a month that lost far more than it usually does', () => {
  it('A — carries the advisory, in its own currency, with its residual', async () => {
    await baselineThenTarget('100');

    const result = await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER);
    const bucket = bucketOf(result);

    expect(bucket.status).toBe('reliable');
    expect(bucket.totals.unclassified?.amount).toBe('100');
    expect(advisoryOf(bucket)).toEqual([
      expect.objectContaining({
        key: 'large_unclassified',
        class: 'advisory',
        currency: 'EUR',
        amount: { amount: '100', currency: 'EUR' },
        positionId: null,
        variant: null,
      }),
    ]);
  });

  it('B — says nothing at exactly twice the median, and speaks one cent above it', async () => {
    const a = await baselineThenTarget('40');
    expect(advisoryOf(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER)))).toEqual([]);

    // One more cent of residual in November: correct the statement.
    await harness.asOwner(`DELETE FROM position_valuations WHERE valued_on = '${ENDS.nov}'`);
    await statement(a, ENDS.nov, '839.99');
    const bucket = bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER));
    expect(bucket.totals.unclassified?.amount).toBe('40.01');
    expect(advisoryOf(bucket)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* C / D — the asymmetry, on real months                                      */
/* -------------------------------------------------------------------------- */

describe('the target may be estimated; the baseline may not', () => {
  it('C — judges an estimated target month and keeps it estimated', async () => {
    await baselineThenTarget('100');
    // A second account opened in October whose first balance lands in November:
    // excluded there, and the month is estimated (8.1, 8.8). October, where it
    // existed without a closing balance, becomes unavailable — one baseline
    // slot spent, five reliable ones left, median still 20.
    const late = await makeAccount('Late', 'EUR', '2026-10-15');
    await statement(late, ENDS.nov, '50.00');

    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-10'))).status).toBe('unavailable');
    const bucket = bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER));
    expect(bucket.status).toBe('estimated');
    expect(bucket.issues.map((issue) => issue.key)).toEqual(['first_balance', 'large_unclassified']);
    expect(bucket.totals.unclassified?.amount).toBe('100');
  });

  it('D — excludes an estimated baseline month, and admits it once it is reliable', async () => {
    // April anchor, then May 10, June 20, July 30; nothing in August and
    // September; an October statement so November can open; November loses
    // 1000. A second account opened in April whose first balance lands in May
    // makes May estimated: June and July are the only reliable baselines.
    const a = await makeAccount('BBVA');
    await statement(a, ENDS.apr, '1000.00');
    await statement(a, ENDS.may, '990.00');
    await statement(a, ENDS.jun, '970.00');
    await statement(a, ENDS.jul, '940.00');
    await statement(a, ENDS.oct, '900.00');
    await statement(a, ENDS.nov, '-100.00');
    const late = await makeAccount('Late', 'EUR', '2026-04-15');
    for (const end of [ENDS.may, ENDS.jun, ENDS.jul, ENDS.oct, ENDS.nov]) await statement(late, end, '50.00');

    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-05'))).status).toBe('estimated');
    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-06'))).status).toBe('reliable');
    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER)).totals.unclassified?.amount).toBe('1000');
    expect(advisoryOf(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER)))).toEqual([]);

    // Give the late account its April balance: its first balance no longer
    // lands in May, May is reliable, three baselines exist, median 20.
    await statement(late, ENDS.apr, '50.00');
    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-05'))).status).toBe('reliable');
    expect(advisoryOf(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER)))).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* E — buckets are judged on their own, in their own currency                 */
/* -------------------------------------------------------------------------- */

describe('a second currency', () => {
  it('E — neither suppresses a reliable EUR bucket nor enters its median', async () => {
    await baselineThenTarget('100');
    // Dollars: huge residuals every month, and no August statement — so August
    // and September are unavailable for USD, and unavailable as months.
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, ENDS.apr, '90000.00');
    await statement(usd, ENDS.may, '85000.00');
    await statement(usd, ENDS.jun, '80000.00');
    await statement(usd, ENDS.jul, '75000.00');
    await statement(usd, ENDS.sep, '65000.00');
    await statement(usd, ENDS.oct, '60000.00');
    await statement(usd, ENDS.nov, '59900.00');

    const august = await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-08'));
    expect(august.status).toBe('unavailable');
    expect(bucketOf(august, 'EUR').status).toBe('reliable');
    expect(bucketOf(august, 'USD').status).toBe('unavailable');

    const november = await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER);
    // EUR: six reliable baselines, median 20, threshold 40, residual 100.
    expect(advisoryOf(bucketOf(november, 'EUR'))).toHaveLength(1);
    // USD: reliable baselines May, Jun, Jul, Oct = 5000 each, threshold 10000,
    // residual 100 — nothing. Had the dollars entered the euro median, the euro
    // threshold would have been in the thousands and the advisory absent.
    expect(bucketOf(november, 'USD').totals.unclassified?.amount).toBe('100');
    expect(advisoryOf(bucketOf(november, 'USD'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* F / G — spans and the edge of the window                                   */
/* -------------------------------------------------------------------------- */

describe('history the window cannot use', () => {
  it('F — a reliable span across missing month ends contributes nothing', async () => {
    // May, June, July reliable (10, 20, 30); August and September without a
    // month end; October closes the gap 3000 lower; November loses 100.
    const a = await makeAccount('BBVA');
    await statement(a, ENDS.apr, '10000.00');
    await statement(a, ENDS.may, '9990.00');
    await statement(a, ENDS.jun, '9970.00');
    await statement(a, ENDS.jul, '9940.00');
    await statement(a, ENDS.oct, '6940.00');
    await statement(a, ENDS.nov, '6840.00');

    const spans = await getSpans(readDeps(), DEC_1, { from: parseMonth('2026-05') });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe('reliable');
    expect(spans[0]?.unclassified.amount).toBe('3000');

    for (const month of ['2026-08', '2026-09', '2026-10']) {
      expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth(month))).status).toBe('unavailable');
    }

    // Baseline is May, June, July only: median 20, threshold 40. Had the span's
    // 3000 — or 1000 a month — been counted, the median would be 1000 or more
    // and 100 would raise nothing.
    const bucket = bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER));
    expect(bucket.totals.unclassified?.amount).toBe('100');
    expect(advisoryOf(bucket)).toHaveLength(1);
  });

  it('G — never reaches back to M−7 for a third observation', async () => {
    // March anchor; April (M−7) 10, May 20, June 30 reliable; then nothing until
    // an October statement, so July … October are unavailable; November loses
    // 1000. Two reliable months in the window, and April is not one of them.
    const a = await makeAccount('BBVA');
    await statement(a, '2026-03-31', '1000.00');
    await statement(a, ENDS.apr, '990.00');
    await statement(a, ENDS.may, '970.00');
    await statement(a, ENDS.jun, '940.00');
    await statement(a, ENDS.oct, '900.00');
    await statement(a, ENDS.nov, '-100.00');

    expect(bucketOf(await getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-04'))).status).toBe('reliable');
    const bucket = bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER));
    expect(bucket.status).toBe('reliable');
    expect(bucket.totals.unclassified?.amount).toBe('1000');
    expect(advisoryOf(bucket)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* H — the current month                                                      */
/* -------------------------------------------------------------------------- */

describe('the current month', () => {
  it('H — is refused by the completed-month guard, and nothing is computed from month-to-date', async () => {
    await baselineThenTarget('100');
    await expect(getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-12'))).rejects.toThrow('not over yet');
  });
});

/* -------------------------------------------------------------------------- */
/* Financial truth is untouched                                               */
/* -------------------------------------------------------------------------- */

describe('the advisory is metadata', () => {
  it('leaves every figure, status and other issue of the month as the engine gave it', async () => {
    const a = await baselineThenTarget('100');
    await expense({ kind: 'food', incurredOn: '2026-11-12', amount: '25.00', cashPositionId: a });

    const bucket = bucketOf(await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER));
    // Δ −100 with 25 known: tracked 100, unclassified 75, still above 40.
    expect(bucket.status).toBe('reliable');
    expect(bucket.totals.knownTrackedExpenses.amount).toBe('25');
    expect(bucket.totals.cashDelta?.amount).toBe('-100');
    expect(bucket.totals.trackedTotalSpending?.amount).toBe('100');
    expect(bucket.totals.unclassified?.amount).toBe('75');
    expect(bucket.issues.map((issue) => issue.key)).toEqual(['large_unclassified']);
    // 8.3's per-account diagnostic is `(close − open) − Σ attributed flows`:
    // −100 − (−25). Its sign is that convention's, not the bucket's.
    expect(bucket.accounts[0]?.residual?.amount).toBe('-75');
  });
});

/* -------------------------------------------------------------------------- */
/* Read counts                                                                */
/* -------------------------------------------------------------------------- */

describe('the read count is that of one bounded range load', () => {
  it('is fixed for a single-currency month, unchanged by a second currency, and bounded with templates', async () => {
    await baselineThenTarget('100');
    const [simple] = await countRoundTrips((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    // The range's seven parallel reads; no template, so no terms query.
    expect(simple).toBe(7);

    const usd = await makeAccount('Dollars', 'USD');
    for (const end of Object.values(ENDS)) await statement(usd, end, '500.00');
    const [multi] = await countRoundTrips((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    expect(multi).toBe(simple);

    for (const name of ['Salary A', 'Salary B', 'Salary C']) {
      await createTemplate(deps(), DEC_1, {
        kind: 'income',
        name,
        incomeKind: 'employment',
        currency: 'EUR',
        frequency: 'monthly',
        dayOfMonth: 25,
        startDate: '2026-01-25',
        amount: '100.00',
      });
    }
    const [expanded] = await countRoundTrips((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    // One batched terms read once templates exist — never one per template,
    // per month, per account or per currency.
    expect(expanded).toBe(simple + 1);
  });

  it('does not make the rolling series more expensive', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2025-06-30', '1000.00');
    for (const [index, end] of ['2025-07-31', '2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', ...Object.values(ENDS)].entries()) {
      await statement(a, end, (1000 - 10 * (index + 1)).toFixed(2));
    }
    const rolling = { db: harness.db, fx: harness.services.fx };
    const count = async (from: string, to: string): Promise<number> => {
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
      await getRollingTrackedSpendingSeries({ ...rolling, db: counting }, DEC_1, { from: parseMonth(from), to: parseMonth(to) });
      return transactions;
    };
    expect(await count('2026-11', '2026-11')).toBe(8);
    expect(await count('2026-09', '2026-11')).toBe(8);
    expect(await count('2025-12', '2026-11')).toBe(8);
  });

  it('performs no provider request', async () => {
    await baselineThenTarget('100');
    const before = harness.fxProvider.calls.length;
    await getMonthReconciliation(readDeps(), DEC_1, NOVEMBER);
    expect(harness.fxProvider.calls.length).toBe(before);
  });
});
