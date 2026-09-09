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
import { createTemplate } from '../../src/recurring/templates';
import { readSettings, setCountAdditionalSpending } from '../../src/settings/service';
import { parseMonth } from '../../src/reconciliation/service';
import {
  getCompletedReportingCashFlowSeries,
  getMonthReportingCashFlow,
  getMonthToDateReportingCashFlow,
} from '../../src/reconciliation/reporting-service';
import type {
  MonthToDateReportingCashFlowDto,
  MonthToDateTrackedReportingDto,
} from '../../src/reconciliation/types';

/**
 * Reporting-currency cash flow against a real database (21.3, 12.5, 8.11,
 * v2.1.13 30.16).
 *
 * September 2026 throughout. The completed cases read from 1 October; the
 * current-month cases sit on the 10th so "the 6th" is 8.6's own example and
 * there is room for FX evidence on both sides of `D`.
 */

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let harness: Harness;
let categories: Awaited<ReturnType<typeof listCategories>>;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
const SEPT_10 = on('2026-09-10');
const SEPTEMBER = parseMonth('2026-09');

const deps = () => harness.services.flows;
const readDeps = () => ({ db: harness.db, fx: harness.services.fx });
type ReadDeps = ReturnType<typeof readDeps>;

/**
 * Narrow to the variant that has 12.5's figures in it.
 *
 * Every tracked assertion below goes through this, which is the point: the
 * compiler will not let a test read `totalSpending` off a month that has no
 * interval to have spent anything in.
 */
function trackedMtd(result: MonthToDateReportingCashFlowDto): MonthToDateTrackedReportingDto {
  if (result.kind !== 'tracked_interval') {
    throw new Error(`expected a tracked interval, got ${result.kind}`);
  }
  return result;
}

const categoryOf = (kind: string): string => {
  const found = categories.find((category) => category.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} category`);
  return found.id;
};

async function makeAccount(name: string, currency = 'EUR'): Promise<string> {
  const created = await createCashAccount(harness.services.positions, OCT_1, {
    name,
    currency,
    accountType: 'checking',
    openedOn: null,
  });
  return created.id;
}

const statement = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, OCT_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });

const snapshot = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, SEPT_10, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });

async function expense(
  ctx: RequestContext,
  args: {
    kind: string;
    incurredOn: string;
    amount: string;
    settlement?: 'tracked_cash' | 'untracked_self' | 'third_party';
    cashPositionId?: string | null;
    currency?: string;
  },
): Promise<void> {
  await createExpenseEntry(deps(), ctx, {
    categoryId: categoryOf(args.kind),
    incurredOn: args.incurredOn,
    amount: args.amount,
    currency: args.currency ?? 'EUR',
    settlement: args.settlement ?? 'tracked_cash',
    cashPositionId: args.cashPositionId ?? null,
  });
}

const income = (
  ctx: RequestContext,
  args: { receivedOn: string; netAmount: string; cashPositionId: string; currency?: string },
): Promise<unknown> =>
  createIncomeEntry(deps(), ctx, {
    kind: 'employment',
    receivedOn: args.receivedOn,
    netAmount: args.netAmount,
    currency: args.currency ?? 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: args.cashPositionId,
  });

/**
 * Forget every stored rate.
 *
 * Recording a foreign flow calls `ensureHistory` (10.4), so writing the fixture
 * warms the cache. A test about a missing rate therefore clears it after the
 * writes rather than before them — and that ordering is itself the proof that
 * the reporting read does not re-fetch.
 */
const forgetRates = (): Promise<unknown> => harness.asOwner('DELETE FROM fx_rates');

/** Store an `EUR -> quote` rate, the only orientation 10.1 persists. */
async function rate(quote: string, rateDate: string, value: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at)
          VALUES ('EUR', ${quote}, ${rateDate}, ${value}, 'ECB', now())
          ON CONFLICT DO NOTHING`,
    );
  });
}

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${USER}, ${'report@example.test'}, ${'report@example.test'}, true)
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
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

describe('when the reporting currency is the only currency', () => {
  it('states every figure with no stored rate at all', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '2291.00');
    await income(OCT_1, { receivedOn: '2026-09-25', netAmount: '2131.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'insurance', incurredOn: '2026-09-12', amount: '411.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-13', amount: '50.00', settlement: 'untracked_self' });

    // No `fx_rates` row exists at all: an identity conversion needs none.
    const result = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);

    expect(result.reportingCurrency).toBe('EUR');
    expect(result.externalIncome.value.amount).toBe('2131');
    expect(result.knownConsumption.value.amount).toBe('411');
    expect(result.unclassified.value.amount).toBe('429');
    expect(result.consumption.value.amount).toBe('840');
    expect(result.trackedTotalSpending.value.amount).toBe('840');
    expect(result.trackedSavingsFromIncome.value.amount).toBe('1291');
    expect(result.personalSavings.value.amount).toBe('1241');
    expect(result.totalSpending.value.amount).toBe('890');
    // The §12.7 golden's rate, exact and unrounded.
    expect(result.savingsRate.kind).toBe('ratio');
    if (result.savingsRate.kind !== 'ratio') throw new Error('expected a rate');
    expect(result.savingsRate.value.startsWith('0.58235570')).toBe(true);
    // Nothing was converted, so nothing is estimated.
    expect(result.unclassified.provenance.estimatedConversion).toBe(false);
    expect(result.trackedTotalSpending.availability).toBe('available');
  });
});

/* -------------------------------------------------------------------------- */
/* A foreign bucket                                                           */
/* -------------------------------------------------------------------------- */

describe('a foreign bucket converts component by component', () => {
  it('uses each flow’s own date and the month average for the residual', async () => {
    const usd = await makeAccount('Dollars', 'USD');
    // Opening 0, closing 30: income 100 in, consumption 50 out, residual 20.
    // (Rates are re-seeded after the writes, below, because writing warms them.)
    await statement(usd, '2026-08-31', '0.00');
    await statement(usd, '2026-09-30', '30.00');
    await income(OCT_1, { receivedOn: '2026-09-01', netAmount: '100.00', cashPositionId: usd, currency: 'USD' });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-15',
      amount: '50.00',
      cashPositionId: usd,
      currency: 'USD',
    });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-20',
      amount: '10.00',
      settlement: 'untracked_self',
      currency: 'USD',
    });

    // EUR -> USD rates chosen so no two conventions can agree by accident.
    await forgetRates();
    for (const [day, value] of [
      ['2026-09-01', '2.0'],
      ['2026-09-10', '0.5'],
      ['2026-09-15', '2.5'],
      ['2026-09-20', '5.0'],
      ['2026-09-30', '10.0'],
    ] as const) {
      await rate('USD', day, value);
    }

    const result = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);

    // 100/2.0, 50/2.5, 20/4.0 (the mean), 10/5.0.
    expect(result.externalIncome.value.amount).toBe('50');
    expect(result.knownConsumption.value.amount).toBe('20');
    expect(result.unclassified.value.amount).toBe('5');
    expect(result.additionalSpending.value.amount).toBe('2');
    expect(result.consumption.value.amount).toBe('25');
    expect(result.trackedTotalSpending.value.amount).toBe('25');
    expect(result.trackedSavingsFromIncome.value.amount).toBe('25');
    expect(result.personalSavings.value.amount).toBe('23');
    expect(result.totalSpending.value.amount).toBe('27');
    expect(result.savingsRate).toEqual({ kind: 'ratio', value: '0.46' });

    // Only the residual is an estimated conversion.
    expect(result.externalIncome.provenance.estimatedConversion).toBe(false);
    expect(result.unclassified.provenance.estimatedConversion).toBe(true);

    // And the 30 September rate never converted a composite: at 10.0 the
    // native income of 100 would have become 10, not 50.
    expect(result.externalIncome.value.amount).not.toBe('10');
  });

  it('degrades only what a missing rate feeds', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');
    await income(OCT_1, { receivedOn: '2026-09-25', netAmount: '200.00', cashPositionId: a });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-13',
      amount: '80.00',
      settlement: 'third_party',
      currency: 'GBP',
    });
    await forgetRates();

    const result = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);

    expect(result.thirdPartyPaid.availability).toBe('unavailable');
    expect(result.thirdPartyPaid.missing[0]?.currency).toBe('GBP');
    // The memo is in no total, so nothing else moved.
    expect(result.trackedTotalSpending.availability).toBe('available');
    expect(result.personalSavings.availability).toBe('available');
    expect(result.savingsRate.kind).toBe('ratio');
  });
});

/* -------------------------------------------------------------------------- */
/* Source-only currencies                                                     */
/* -------------------------------------------------------------------------- */

describe('a currency with only untracked rows', () => {
  const seed = async (): Promise<void> => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    // 200 of income and 100 of growth, so 100 of tracked spending, all of it
    // unclassified.
    await statement(a, '2026-09-30', '1100.00');
    await income(OCT_1, { receivedOn: '2026-09-25', netAmount: '200.00', cashPositionId: a });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-13',
      amount: '50.00',
      settlement: 'untracked_self',
      currency: 'GBP',
    });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-14',
      amount: '80.00',
      settlement: 'third_party',
      currency: 'GBP',
    });
  };

  it('contributes at its own rate without gaining a bucket', async () => {
    await seed();
    await forgetRates();
    await rate('GBP', '2026-09-13', '2.0');
    await rate('GBP', '2026-09-14', '4.0');

    const result = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);

    expect(result.additionalSpending.value.amount).toBe('25');
    expect(result.thirdPartyPaid.value.amount).toBe('20');
    expect(result.additionalSpending.availability).toBe('available');
    // No GBP consumption, spending or savings was invented.
    expect(result.knownConsumption.value.amount).toBe('0');
    expect(result.trackedTotalSpending.value.amount).toBe('100');
    expect(result.totalSpending.value.amount).toBe('125');
    expect(result.personalSavings.value.amount).toBe('75');
  });

  it('degrades only its own figures when its rate is missing, and only when counted', async () => {
    await seed();
    await forgetRates();

    const counted = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    expect(counted.additionalSpending.availability).toBe('unavailable');
    expect(counted.additionalSpending.missing[0]?.currency).toBe('GBP');
    expect(counted.personalSavings.availability).toBe('partial');
    expect(counted.savingsRate.kind).toBe('unavailable');

    const settings = await readSettings(harness.db, USER);
    await setCountAdditionalSpending(harness.services.settings, USER, settings.version, false);

    const trackedOnly = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    // The formula subtracts nothing, so it never depended on the missing rate.
    expect(trackedOnly.personalSavings.availability).toBe('available');
    expect(trackedOnly.savingsRate.kind).toBe('ratio');
    expect(trackedOnly.totalSpending.availability).toBe('partial');
  });
});

/* -------------------------------------------------------------------------- */
/* The current month                                                          */
/* -------------------------------------------------------------------------- */

describe('the current month reports through D', () => {
  /** `D` = 6 Sep with today on the 10th: one account has a newer balance. */
  const seedThroughD = async (): Promise<string> => {
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, '2026-08-31', '0.00');
    await snapshot(usd, '2026-09-06', '30.00');
    // A newer balance after D. `D` stays on the 6th because the euro account
    // below has nothing later, which is 8.6's own `mtd_newer_balances` shape.
    await snapshot(usd, '2026-09-09', '31.00');
    const eur = await makeAccount('BBVA');
    await statement(eur, '2026-08-31', '500.00');
    await snapshot(eur, '2026-09-06', '500.00');
    await income(SEPT_10, {
      receivedOn: '2026-09-02',
      netAmount: '100.00',
      cashPositionId: usd,
      currency: 'USD',
    });
    await expense(SEPT_10, {
      kind: 'food',
      incurredOn: '2026-09-03',
      amount: '50.00',
      cashPositionId: usd,
      currency: 'USD',
    });
    return usd;
  };

  /** Five rates through D at 2.0, and wildly different ones after it. */
  const seedRates = async (afterD: string): Promise<void> => {
    await forgetRates();
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
      await rate('USD', day, '2.0');
    }
    await rate('USD', '2026-09-08', afterD);
    await rate('USD', '2026-09-09', afterD);
  };

  it('converts the residual on evidence no later than D', async () => {
    await seedThroughD();
    await seedRates('100.0');

    const result = trackedMtd(await getMonthToDateReportingCashFlow(readDeps(), SEPT_10));

    expect(result.asOf).toBe('2026-09-06');
    expect(result.sourceOnlyThrough).toBe('2026-09-06');
    // ΣI 100, ΣK 50, Δ 30 → tracked 70, unclassified 20, all at 2.0.
    expect(result.externalIncome.value.amount).toBe('50');
    expect(result.knownConsumption.value.amount).toBe('25');
    expect(result.unclassified.value.amount).toBe('10');
    expect(result.unclassified.quality).toBe('provisional');
    expect(result.unclassified.provenance.estimatedConversion).toBe(true);
    // Five eligible observations, so a real average and not a fallback.
    expect(result.unclassified.provenance.approximate).toBe(false);
  });

  it('is unchanged when only the rates after D change', async () => {
    await seedThroughD();
    await seedRates('100.0');
    const before = trackedMtd(await getMonthToDateReportingCashFlow(readDeps(), SEPT_10));

    await harness.asOwner("DELETE FROM fx_rates WHERE rate_date > '2026-09-06'");
    await rate('USD', '2026-09-08', '0.001');
    await rate('USD', '2026-09-09', '0.002');
    const after = trackedMtd(await getMonthToDateReportingCashFlow(readDeps(), SEPT_10));

    // The proof that the deployed `today` behaviour is gone from this path.
    expect(after.unclassified.value.amount).toBe(before.unclassified.value.amount);
    expect(after.trackedTotalSpending.value.amount).toBe(before.trackedTotalSpending.value.amount);
    expect(after.asOf).toBe('2026-09-06');
  });

  it('states exact zeros for an interval in which nothing happened', async () => {
    // A valid `D` with no flows at all. Every 12.5 formula genuinely evaluates
    // to zero here, and each figure says so — which is what the no-`D` case
    // below must not be mistaken for.
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await snapshot(a, '2026-09-06', '1000.00');

    const result = trackedMtd(await getMonthToDateReportingCashFlow(readDeps(), SEPT_10));

    expect(result.asOf).toBe('2026-09-06');
    for (const figure of [
      result.externalIncome,
      result.knownConsumption,
      result.propertyOperatingCosts,
      result.interestAndFees,
      result.transactionCosts,
      result.externalOutflows,
      result.unclassified,
      result.consumption,
      result.trackedTotalSpending,
      result.trackedSavingsFromIncome,
      result.personalSavings,
      result.totalSpending,
    ]) {
      expect(figure.availability).toBe('available');
      expect(figure.value.amount).toBe('0');
      expect(figure.missing).toEqual([]);
    }
    // Zero income is a measured zero, so the rate has a denominator and it is
    // zero — a different thing from having no denominator at all.
    expect(result.savingsRate).toEqual({
      kind: 'unavailable',
      reason: 'divide_by_zero',
      detail: 'External income is zero.',
    });
  });

  it('keeps the two settlements and states no tracked figure when there is no common date', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await statement(a, '2026-08-31', '1000.00');
    await statement(b, '2026-08-31', '500.00');
    // No day carries a snapshot for both.
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-03', '480.00');
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-08', amount: '50.00', settlement: 'untracked_self' });
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-09', amount: '80.00', settlement: 'third_party' });

    const result = await getMonthToDateReportingCashFlow(readDeps(), SEPT_10);

    expect(result.kind).toBe('no_tracked_interval');
    expect(result.asOf).toBeNull();
    expect(result.monthStatus).toBe('unavailable');
    expect(result.sourceOnlyThrough).toBe('2026-09-10');
    // The two settlements survive, through today. They never needed an interval.
    expect(result.additionalSpending.value.amount).toBe('50');
    expect(result.additionalSpending.availability).toBe('available');
    expect(result.thirdPartyPaid.value.amount).toBe('80');
    expect(result.thirdPartyPaid.availability).toBe('available');

    if (result.kind !== 'no_tracked_interval') throw new Error('expected no interval');
    expect(result.reason).toBe('mtd_no_common_date');

    // There is no tracked cash flow to read, at zero or at anything else. Not
    // `TotalSpending = AdditionalSpending`, not a negative `PersonalSavings`,
    // and not a rate that divides by an income nobody measured.
    const serialized = JSON.stringify(result);
    for (const absent of [
      'externalIncome',
      'knownConsumption',
      'propertyOperatingCosts',
      'interestAndFees',
      'transactionCosts',
      'externalOutflows',
      'unclassified',
      'consumption',
      'trackedTotalSpending',
      'trackedSavingsFromIncome',
      'personalSavings',
      'totalSpending',
      'savingsRate',
      'countsAdditionalSpending',
    ]) {
      expect(serialized).not.toContain(absent);
    }
    expect(Object.keys(result).sort()).toEqual([
      'additionalSpending',
      'asOf',
      'kind',
      'month',
      'monthStatus',
      'reason',
      'reportingCurrency',
      'sourceOnlyThrough',
      'thirdPartyPaid',
    ]);

    // A tracked figure is not merely absent at runtime: it does not typecheck.
    // If the union ever collapses back into one shape, `tsc` fails here on an
    // unused directive rather than in production.
    // @ts-expect-error -- no tracked figure exists without a tracked interval
    expect(result.totalSpending).toBeUndefined();
  });

  it('converts those settlements at their own dates, never at a month average', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await statement(a, '2026-08-31', '1000.00');
    await statement(b, '2026-08-31', '500.00');
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-03', '480.00');
    await expense(SEPT_10, {
      kind: 'food', incurredOn: '2026-09-08', amount: '100.00',
      settlement: 'untracked_self', currency: 'USD',
    });
    await expense(SEPT_10, {
      kind: 'food', incurredOn: '2026-09-09', amount: '40.00',
      settlement: 'third_party', currency: 'USD',
    });

    // Early rates far from the two the rows actually sit on: a month average
    // would be (10+10+10+10+10+2+4)/7 = 8, so 100 USD would come out at 12.5
    // instead of 50. Nothing here may take an average — there is no interval to
    // average over, and the residual that needs one was never built.
    await forgetRates();
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
      await rate('USD', day, '10.0');
    }
    await rate('USD', '2026-09-08', '2.0');
    await rate('USD', '2026-09-09', '4.0');
    const providerCalls = harness.fxProvider.calls.length;

    const result = await getMonthToDateReportingCashFlow(readDeps(), SEPT_10);

    expect(result.kind).toBe('no_tracked_interval');
    expect(result.additionalSpending.value.amount).toBe('50');
    expect(result.additionalSpending.provenance.estimatedConversion).toBe(false);
    expect(result.additionalSpending.provenance.exact).toBe(true);
    expect(result.thirdPartyPaid.value.amount).toBe('10');
    expect(result.thirdPartyPaid.provenance.estimatedConversion).toBe(false);
    // Stored rows only: no provider was asked to fill a gap.
    expect(harness.fxProvider.calls.length).toBe(providerCalls);
  });
});

/* -------------------------------------------------------------------------- */
/* The completed series                                                       */
/* -------------------------------------------------------------------------- */

describe('the completed series', () => {
  it('returns one result per month, each with its own status', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-06-30', '1000.00');
    await statement(a, '2026-07-31', '900.00');
    // August has no month-end balance, so August and September cannot reconcile.
    await statement(a, '2026-09-30', '700.00');

    const series = await getCompletedReportingCashFlowSeries(readDeps(), OCT_1, {
      from: parseMonth('2026-07'),
      to: parseMonth('2026-09'),
    });

    expect(series.map((month) => month.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(series[0]?.monthStatus).toBe('reliable');
    expect(series[1]?.monthStatus).toBe('unavailable');
    expect(series[2]?.monthStatus).toBe('unavailable');
    // July reconciled, so its spending is stated.
    expect(series[0]?.trackedTotalSpending.value.amount).toBe('100');
    // August did not, so the residual it needs is missing.
    expect(series[1]?.trackedTotalSpending.availability).not.toBe('available');
  });

  it('refuses a range reaching into a month that has not ended', async () => {
    await expect(
      getCompletedReportingCashFlowSeries(readDeps(), SEPT_10, {
        from: parseMonth('2026-08'),
        to: parseMonth('2026-09'),
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Working precision                                                          */
/* -------------------------------------------------------------------------- */

describe('a conversion that does not terminate', () => {
  it('serializes the whole decimal, rounded nowhere', async () => {
    // 100, 50 and a residual of 20, all USD, all at a rate of exactly 3. Every
    // figure below is a third of something and none of them terminates.
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, '2026-08-31', '0.00');
    await statement(usd, '2026-09-30', '30.00');
    await income(OCT_1, {
      receivedOn: '2026-09-02', netAmount: '100.00', cashPositionId: usd, currency: 'USD',
    });
    await expense(OCT_1, {
      kind: 'food', incurredOn: '2026-09-03', amount: '50.00',
      cashPositionId: usd, currency: 'USD',
    });
    await forgetRates();
    for (const day of ['2026-09-01', '2026-09-10', '2026-09-15', '2026-09-20', '2026-09-30']) {
      await rate('USD', day, '3.0');
    }

    const result = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);

    // Forty significant digits, serialized whole. Not 6.66666667, and not 6.67:
    // `NUMERIC(24,8)` is the scale these figures would be *stored* at, and 5.3
    // stores none of them. Rounding belongs at the display boundary (7.3), which
    // is somewhere else entirely.
    expect(result.externalIncome.value.amount).toBe(
      '33.33333333333333333333333333333333333333',
    );
    expect(result.knownConsumption.value.amount).toBe(
      '16.66666666666666666666666666666666666667',
    );
    expect(result.unclassified.value.amount).toBe(
      '6.666666666666666666666666666666666666666',
    );
    expect(result.trackedTotalSpending.value.amount).toBe(
      '23.33333333333333333333333333333333333334',
    );
    // And the working precision is visible where it should be: income minus
    // consumption is 10 in exact arithmetic, and 9.99…9 at forty significant
    // digits, because the subtraction changes the magnitude. That is arithmetic
    // at finite precision, not a rounding rule — a rounding rule would have
    // produced 10.00000000 and hidden the difference.
    expect(result.trackedSavingsFromIncome.value.amount).toBe(
      '9.99999999999999999999999999999999999999',
    );
  });

  it('is deterministic: the same rows give the same digits every time', async () => {
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, '2026-08-31', '0.00');
    await statement(usd, '2026-09-30', '30.00');
    await income(OCT_1, {
      receivedOn: '2026-09-02', netAmount: '100.00', cashPositionId: usd, currency: 'USD',
    });
    await forgetRates();
    for (const day of ['2026-09-01', '2026-09-10', '2026-09-15', '2026-09-20', '2026-09-30']) {
      await rate('USD', day, '3.0');
    }

    const first = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    const second = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    expect(second).toEqual(first);
  });
});

/* -------------------------------------------------------------------------- */
/* Read counts                                                                */
/* -------------------------------------------------------------------------- */

describe('the read count is bounded by a constant', () => {
  beforeEach(async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-06-30', '1000.00');
    await statement(a, '2026-07-31', '950.00');
    await statement(a, '2026-08-31', '900.00');
    await statement(a, '2026-09-30', '850.00');
  });

  it('reads a single completed month in a fixed number of round trips', async () => {
    const [count] = await countRoundTrips((d) => getMonthReportingCashFlow(d, OCT_1, SEPTEMBER));
    // The completed-month window's seven reads plus the user's setting. No
    // template exists here, so the terms query short-circuits — and every
    // currency is the reporting currency, so `loadTable` has nothing to ask for
    // and issues no query either.
    expect(count).toBe(8);
  });

  it('reads a three-month and a twelve-month series in the same number', async () => {
    const [three] = await countRoundTrips((d) =>
      getCompletedReportingCashFlowSeries(d, OCT_1, {
        from: parseMonth('2026-07'),
        to: parseMonth('2026-09'),
      }),
    );
    const [twelve] = await countRoundTrips((d) =>
      getCompletedReportingCashFlowSeries(d, OCT_1, {
        from: parseMonth('2025-10'),
        to: parseMonth('2026-09'),
      }),
    );
    expect(twelve).toBe(three);
    expect(three).toBe(8);
  });

  it('does not grow with accounts, flows, currencies or templates', async () => {
    const [before] = await countRoundTrips((d) =>
      getCompletedReportingCashFlowSeries(d, OCT_1, {
        from: parseMonth('2026-07'),
        to: parseMonth('2026-09'),
      }),
    );

    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, '2026-08-31', '10.00');
    await statement(usd, '2026-09-30', '10.00');
    // A foreign currency now exists, so the FX table is actually read: one bulk
    // query for every quote and every month at once.
    for (let index = 0; index < 8; index += 1) {
      await expense(OCT_1, {
        kind: 'food',
        incurredOn: '2026-09-05',
        amount: '1.00',
        settlement: 'untracked_self',
      });
    }
    for (const name of ['Salary A', 'Salary B', 'Salary C']) {
      await createTemplate(deps(), OCT_1, {
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

    const [after] = await countRoundTrips((d) =>
      getCompletedReportingCashFlowSeries(d, OCT_1, {
        from: parseMonth('2026-07'),
        to: parseMonth('2026-09'),
      }),
    );
    // At most one batched terms query once templates exist and one bulk FX read
    // once a foreign currency does — never one per template, per account, per
    // flow, per currency or per month.
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after).toBeLessThanOrEqual(10);
  });

  it('performs no provider request', async () => {
    // `loadTable` reads stored rows; `ensureHistory` is a write-path concern.
    const before = harness.fxProvider.calls.length;
    await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    await getCompletedReportingCashFlowSeries(readDeps(), OCT_1, {
      from: parseMonth('2026-07'),
      to: parseMonth('2026-09'),
    });
    await getMonthToDateReportingCashFlow(readDeps(), SEPT_10);
    expect(harness.fxProvider.calls.length).toBe(before);
  });
});

/** How many transactions one reporting read opens, and its result. */
async function countRoundTrips<T>(
  run: (deps: ReadDeps) => Promise<T>,
): Promise<[number, T]> {
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
