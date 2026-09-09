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
import { readSettings, setCountAdditionalSpending } from '../../src/settings/service';
import { parseMonth } from '../../src/reconciliation/service';
import { getCompletedReportingCashFlowSeries } from '../../src/reconciliation/reporting-service';
import { getRollingTrackedSpendingSeries } from '../../src/reconciliation/rolling-service';
import { getSpans } from '../../src/reconciliation/span-service';
import type { RollingTrackedSpendingPointDto } from '../../src/reconciliation/types';

/**
 * Rolling tracked spending against a real database (15.2, 15.5, 30.15 item 5,
 * 30.16 item 11).
 *
 * Every fixture reads through the real completed reporting series and the real
 * rolling service, so what is averaged here is what Slice 10a actually reports.
 * The year runs to 1 December 2026, with November the last completed month.
 */

const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: Harness;
let categories: Awaited<ReturnType<typeof listCategories>>;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER, reportingCurrency: 'EUR' });

const DEC_1 = on('2026-12-01');
const range = (from: string, to: string) => ({ from: parseMonth(from), to: parseMonth(to) });

const deps = () => harness.services.flows;
const readDeps = () => ({ db: harness.db, fx: harness.services.fx });
type ReadDeps = ReturnType<typeof readDeps>;

const categoryOf = (kind: string): string => {
  const found = categories.find((category) => category.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} category`);
  return found.id;
};

async function makeAccount(name: string, currency = 'EUR'): Promise<string> {
  const created = await createCashAccount(harness.services.positions, DEC_1, {
    name,
    currency,
    accountType: 'checking',
    openedOn: null,
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

/** The last day of `YYYY-MM`. */
function endOf(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** Month-end statements from `first` to `last` inclusive, `step` lower each month. */
async function statementsEachMonth(
  positionId: string,
  first: string,
  last: string,
  opening: number,
  step: number,
): Promise<void> {
  let balance = opening;
  for (let month = first; month <= last; month = nextMonth(month)) {
    await statement(positionId, endOf(month), balance.toFixed(2));
    balance -= step;
  }
}

function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, m, 1));
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function expense(args: {
  kind: string;
  incurredOn: string;
  amount: string;
  settlement?: 'tracked_cash' | 'untracked_self' | 'third_party';
  cashPositionId?: string | null;
  currency?: string;
  isOneOff?: boolean;
}): Promise<void> {
  await createExpenseEntry(deps(), DEC_1, {
    categoryId: categoryOf(args.kind),
    incurredOn: args.incurredOn,
    amount: args.amount,
    currency: args.currency ?? 'EUR',
    settlement: args.settlement ?? 'tracked_cash',
    cashPositionId: args.cashPositionId ?? null,
    ...(args.isOneOff === undefined ? {} : { isOneOff: args.isOneOff }),
  });
}

/** Recording a foreign flow warms the cache, so a missing-rate fixture clears afterwards. */
const forgetRates = (): Promise<unknown> => harness.asOwner('DELETE FROM fx_rates');

async function rate(quote: string, rateDate: string, value: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at)
          VALUES ('EUR', ${quote}, ${rateDate}, ${value}, 'ECB', now())
          ON CONFLICT DO NOTHING`,
    );
  });
}

const window3 = (point: RollingTrackedSpendingPointDto) =>
  point.rolling3 === null ? null : { amount: point.rolling3.value.amount, count: point.rolling3.count };
const window6 = (point: RollingTrackedSpendingPointDto) =>
  point.rolling6 === null ? null : { amount: point.rolling6.value.amount, count: point.rolling6.count };
const window12 = (point: RollingTrackedSpendingPointDto) =>
  point.rolling12 === null ? null : { amount: point.rolling12.value.amount, count: point.rolling12.count };

const single = (points: readonly RollingTrackedSpendingPointDto[]): RollingTrackedSpendingPointDto => {
  const [point] = points;
  if (point === undefined || points.length !== 1) throw new Error('expected exactly one point');
  return point;
};

/** How many transactions one read opens, and its result. */
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
          VALUES (${USER}, ${'rolling@example.test'}, ${'rolling@example.test'}, true)
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
  const settings = await readSettings(harness.db, USER);
  await setCountAdditionalSpending(harness.services.settings, USER, settings.version, true);
  categories = await listCategories(harness.db, USER);
});

/* -------------------------------------------------------------------------- */
/* A. Calculation history is read, and not returned                           */
/* -------------------------------------------------------------------------- */

describe('the eleven months before the first display month', () => {
  it('feed its 12M window and are not returned as points', async () => {
    // Balances fall by 10 every month from July 2025 to November 2026: every
    // month reconciles with no flows, so its tracked spending is exactly 10.
    const a = await makeAccount('BBVA');
    await statementsEachMonth(a, '2025-06', '2026-11', 1000, 10);

    const points = await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-06', '2026-08'));

    expect(points.map((point) => point.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    // June's 12M window is July 2025 … June 2026: twelve reliable months, every
    // one of them loaded because the series was read from eleven months before
    // the first display month — and none of them is a point.
    const june = points[0] as RollingTrackedSpendingPointDto;
    expect(window12(june)).toEqual({ amount: '10', count: 12 });
    expect(window6(june)).toEqual({ amount: '10', count: 6 });
    expect(window3(june)).toEqual({ amount: '10', count: 3 });
    expect(june.reportingCurrency).toBe('EUR');
  });
});

/* -------------------------------------------------------------------------- */
/* B. A partial reporting month keeps its seat and adds nothing               */
/* -------------------------------------------------------------------------- */

describe('a reliable month whose reporting total is partial', () => {
  it('is skipped without reaching back, and its neighbours survive', async () => {
    // EUR spends 10 a month. USD spends 20 a month; it converts at 2.0 in
    // September and November, and has no rate at all in October.
    const eur = await makeAccount('BBVA');
    await statementsEachMonth(eur, '2026-07', '2026-11', 1000, 10);
    const usd = await makeAccount('Dollars', 'USD');
    await statementsEachMonth(usd, '2026-07', '2026-11', 500, 20);
    await forgetRates();
    for (const month of ['2026-08', '2026-09', '2026-11']) {
      for (const day of ['05', '15', '25']) await rate('USD', `${month}-${day}`, '2.0');
    }

    const series = await getCompletedReportingCashFlowSeries(readDeps(), DEC_1, range('2026-08', '2026-11'));
    const byMonth = new Map(series.map((month) => [month.month, month]));
    // October is reliable natively, and its reporting total is partial: the USD
    // residual could not be converted, the EUR side could.
    expect(byMonth.get('2026-10')?.monthStatus).toBe('reliable');
    expect(byMonth.get('2026-10')?.trackedTotalSpending.availability).toBe('partial');
    expect(byMonth.get('2026-10')?.trackedTotalSpending.value.amount).toBe('10');
    for (const month of ['2026-08', '2026-09', '2026-11']) {
      expect(byMonth.get(month)?.trackedTotalSpending.availability).toBe('available');
      expect(byMonth.get(month)?.trackedTotalSpending.value.amount).toBe('20');
    }

    const november = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    // 3M is September, October, November; October keeps its seat and adds
    // nothing, and August — a fine month — is not reached back to.
    expect(window3(november)).toEqual({ amount: '20', count: 2 });
    // 6M is June … November: August, September and November qualify.
    expect(window6(november)).toEqual({ amount: '20', count: 3 });
  });
});

/* -------------------------------------------------------------------------- */
/* C. An unconvertible memo is not this series' concern                       */
/* -------------------------------------------------------------------------- */

describe('a month whose additional spending cannot be converted', () => {
  it('still contributes its complete tracked spending', async () => {
    const a = await makeAccount('BBVA');
    await statementsEachMonth(a, '2026-08', '2026-11', 2000, 400);
    // A GBP memo with no GBP rate anywhere: additional spending is unavailable,
    // tracked spending — all EUR — is not.
    await expense({ kind: 'food', incurredOn: '2026-10-12', amount: '80.00', settlement: 'untracked_self', currency: 'GBP' });
    await forgetRates();

    const series = await getCompletedReportingCashFlowSeries(readDeps(), DEC_1, range('2026-10', '2026-10'));
    const october = series[0];
    expect(october?.monthStatus).toBe('reliable');
    expect(october?.trackedTotalSpending.availability).toBe('available');
    expect(october?.trackedTotalSpending.value.amount).toBe('400');
    expect(october?.additionalSpending.availability).toBe('unavailable');
    expect(october?.totalSpending.availability).toBe('partial');

    const november = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    expect(window3(november)).toEqual({ amount: '400', count: 3 });
  });
});

/* -------------------------------------------------------------------------- */
/* D. A one-off expense is spending                                           */
/* -------------------------------------------------------------------------- */

describe('a tracked one-off expense', () => {
  it('changes the month’s tracked spending and therefore the average', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');
    await statement(a, '2026-10-31', '800.00');
    await statement(a, '2026-11-30', '200.00');
    // November's 600 of spending is 100 of the usual and a 500 one-off.
    await expense({ kind: 'food', incurredOn: '2026-11-12', amount: '500.00', cashPositionId: a, isOneOff: true });

    const november = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    // (100 + 100 + 600) / 3. No layer here reads `is_one_off`; that exclusion
    // belongs to the projection baseline (13.6).
    expect(window3(november)).toEqual({ amount: '266.6666666666666666666666666666666666667', count: 3 });
  });
});

/* -------------------------------------------------------------------------- */
/* Additional spending is not rolled                                          */
/* -------------------------------------------------------------------------- */

describe('additional spending', () => {
  it('is not in the rolled figure, whatever the setting says', async () => {
    const a = await makeAccount('BBVA');
    await statementsEachMonth(a, '2026-08', '2026-11', 1000, 100);
    for (const month of ['2026-09', '2026-10', '2026-11']) {
      await expense({ kind: 'food', incurredOn: `${month}-10`, amount: '900.00', settlement: 'untracked_self' });
    }

    const series = await getCompletedReportingCashFlowSeries(readDeps(), DEC_1, range('2026-11', '2026-11'));
    expect(series[0]?.trackedTotalSpending.value.amount).toBe('100');
    expect(series[0]?.additionalSpending.value.amount).toBe('900');
    expect(series[0]?.totalSpending.value.amount).toBe('1000');

    const counted = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    expect(window3(counted)).toEqual({ amount: '100', count: 3 });

    const settings = await readSettings(harness.db, USER);
    await setCountAdditionalSpending(harness.services.settings, USER, settings.version, false);
    const uncounted = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    expect(uncounted).toEqual(counted);
  });
});

/* -------------------------------------------------------------------------- */
/* E. The current month is refused, not averaged                              */
/* -------------------------------------------------------------------------- */

describe('a range reaching the current month', () => {
  it('is refused by the completed-series boundary', async () => {
    const a = await makeAccount('BBVA');
    await statementsEachMonth(a, '2026-08', '2026-11', 1000, 10);
    await expect(
      getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-12')),
    ).rejects.toThrow('not over yet');
  });

  it('returns nothing for an inverted range without reading anything', async () => {
    const [count, points] = await countRoundTrips((d) =>
      getRollingTrackedSpendingSeries(d, DEC_1, range('2026-11', '2026-10')),
    );
    expect(points).toEqual([]);
    expect(count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* F. A span is not an observation                                            */
/* -------------------------------------------------------------------------- */

describe('a gap bridged by a span', () => {
  it('contributes nothing: not the span, not its months, not a share of either', async () => {
    // July reliable; August and September have no month end; October closes
    // the gap; November reliable. The span August–October spends 300 in all.
    const a = await makeAccount('BBVA');
    await statement(a, '2026-06-30', '1000.00');
    await statement(a, '2026-07-31', '900.00');
    await statement(a, '2026-10-31', '600.00');
    await statement(a, '2026-11-30', '550.00');

    const spans = await getSpans({ db: harness.db }, DEC_1, { from: parseMonth('2026-07') });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe('2026-08-01');
    expect(spans[0]?.to).toBe('2026-10-31');
    expect(spans[0]?.status).toBe('reliable');
    expect(spans[0]?.trackedTotalSpending.amount).toBe('300');

    const series = await getCompletedReportingCashFlowSeries(readDeps(), DEC_1, range('2026-07', '2026-11'));
    expect(series.map((month) => `${month.month}:${month.monthStatus}`)).toEqual([
      '2026-07:reliable',
      '2026-08:unavailable',
      '2026-09:unavailable',
      '2026-10:unavailable',
      '2026-11:reliable',
    ]);

    const points = await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-07', '2026-11'));
    const byMonth = new Map(points.map((point) => [point.month, point]));
    // November's 3M is September, October, November: only November qualifies.
    // Neither 300 nor 100 (a third of it) is anywhere in the numerator.
    expect(window3(byMonth.get('2026-11') as RollingTrackedSpendingPointDto)).toEqual({ amount: '50', count: 1 });
    // November's 6M reaches July: two reliable months, and nothing between.
    expect(window6(byMonth.get('2026-11') as RollingTrackedSpendingPointDto)).toEqual({ amount: '75', count: 2 });
    // The gap months themselves have July in their windows and nothing else.
    expect(window3(byMonth.get('2026-09') as RollingTrackedSpendingPointDto)).toEqual({ amount: '100', count: 1 });
    expect(window3(byMonth.get('2026-10') as RollingTrackedSpendingPointDto)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* G. Provenance is not eligibility                                           */
/* -------------------------------------------------------------------------- */

describe('a foreign month converted on an average and a dated fallback', () => {
  it('remains eligible', async () => {
    // USD: opening 500, closing 460 → residual 40 at the month average; one
    // cost of 20 dated the 12th with the nearest rate on the 10th.
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, '2026-09-30', '500.00');
    await statement(usd, '2026-10-31', '440.00');
    await statement(usd, '2026-11-30', '440.00');
    await expense({ kind: 'food', incurredOn: '2026-10-12', amount: '20.00', cashPositionId: usd, currency: 'USD' });
    await forgetRates();
    for (const day of ['02', '06', '10', '20', '30']) await rate('USD', `2026-10-${day}`, '2.0');
    // November's residual is zero and still converts, at November's own average.
    for (const day of ['10', '20']) await rate('USD', `2026-11-${day}`, '2.0');

    const series = await getCompletedReportingCashFlowSeries(readDeps(), DEC_1, range('2026-10', '2026-10'));
    const october = series[0];
    expect(october?.monthStatus).toBe('reliable');
    expect(october?.trackedTotalSpending.availability).toBe('available');
    expect(october?.trackedTotalSpending.value.amount).toBe('30');
    expect(october?.trackedTotalSpending.provenance.estimatedConversion).toBe(true);
    expect(october?.trackedTotalSpending.provenance.exact).toBe(false);

    const november = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    // October at 30 and November at 0 — an exact zero that is itself a survivor.
    expect(window3(november)).toEqual({ amount: '15', count: 2 });
  });
});

/* -------------------------------------------------------------------------- */
/* Precision                                                                  */
/* -------------------------------------------------------------------------- */

describe('a mean that does not terminate', () => {
  it('is serialised at working precision, rounded nowhere', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '1000.00');
    await statement(a, '2026-10-31', '1000.00');
    await statement(a, '2026-11-30', '999.00');

    const november = single(await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-11', '2026-11')));
    expect(window3(november)).toEqual({ amount: '0.3333333333333333333333333333333333333333', count: 3 });
    expect(november.rolling3?.value.currency).toBe('EUR');
  });
});

/* -------------------------------------------------------------------------- */
/* Read counts                                                                */
/* -------------------------------------------------------------------------- */

describe('the read count is that of one completed-series load', () => {
  beforeEach(async () => {
    const a = await makeAccount('BBVA');
    await statementsEachMonth(a, '2025-06', '2026-11', 1000, 10);
  });

  it('is the same for one, three and twelve display months, and equals the series', async () => {
    const [one] = await countRoundTrips((d) => getRollingTrackedSpendingSeries(d, DEC_1, range('2026-11', '2026-11')));
    const [three] = await countRoundTrips((d) => getRollingTrackedSpendingSeries(d, DEC_1, range('2026-09', '2026-11')));
    const [twelve] = await countRoundTrips((d) => getRollingTrackedSpendingSeries(d, DEC_1, range('2025-12', '2026-11')));
    const [series] = await countRoundTrips((d) =>
      getCompletedReportingCashFlowSeries(d, DEC_1, range('2024-12', '2026-11')),
    );
    expect(one).toBe(8);
    expect(three).toBe(one);
    expect(twelve).toBe(one);
    expect(series).toBe(one);
  });

  it('does not grow with accounts, flows, currencies or templates', async () => {
    const [before] = await countRoundTrips((d) => getRollingTrackedSpendingSeries(d, DEC_1, range('2026-09', '2026-11')));

    const usd = await makeAccount('Dollars', 'USD');
    await statementsEachMonth(usd, '2026-06', '2026-11', 100, 1);
    for (let index = 0; index < 8; index += 1) {
      await expense({ kind: 'food', incurredOn: '2026-10-05', amount: '1.00', settlement: 'untracked_self' });
    }
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

    const [after] = await countRoundTrips((d) => getRollingTrackedSpendingSeries(d, DEC_1, range('2026-09', '2026-11')));
    // Slice 10a's own ceiling: one batched terms read once templates exist and
    // one bulk FX read once a foreign currency does — and nothing per month.
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after).toBeLessThanOrEqual(10);
  });

  it('performs no provider request', async () => {
    const before = harness.fxProvider.calls.length;
    await getRollingTrackedSpendingSeries(readDeps(), DEC_1, range('2026-06', '2026-11'));
    expect(harness.fxProvider.calls.length).toBe(before);
  });
});
