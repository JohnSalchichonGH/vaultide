import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser, type Database } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { providerOutage } from '../helpers/stub-fx-provider';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createTemplate } from '../../src/recurring/templates';
import { createFxService } from '../../src/fx/service';
import { ValidationError } from '../../src/errors';
import { parseMonth } from '../../src/reconciliation/service';
import {
  getCompletedReportingCashFlowSeries,
  getMonthReportingCashFlow,
  getMonthToDateReportingCashFlow,
} from '../../src/reconciliation/reporting-service';
import { getRollingTrackedSpendingSeries } from '../../src/reconciliation/rolling-service';
import { getSpans } from '../../src/reconciliation/span-service';
import { getMonthlyPage } from '../../src/monthly/service';
import { getSpendingPage, type SpendingDependencies } from '../../src/spending/service';
import type { SpendingFocusCompletedDto, SpendingPageDto } from '../../src/spending/types';

/**
 * The standalone Spending page's read, against a real database (blueprint 15.2
 * "Spending", 8.x, 12.5, 30.15, 30.16, 30.20; ADR 0008).
 *
 * Read on 1 October 2026 unless a case says otherwise, so September is the last
 * completed month and October is the current one. The oracles are the reads the
 * page's parts are supposed to be: each month's figures are compared with
 * `getMonthReportingCashFlow`, the current month with the month-to-date read,
 * rolling with the rolling read and the spans with `getSpans`. What is pinned
 * beyond that is what only this page decides — its months, its observed flag,
 * its breakdown and its bounded load.
 */

const USER = '56565656-5656-4565-8565-565656565656';

let harness: Harness;
let groceries: string;
let eatingOut: string;
let moneyOut: string;

const on = (today: string): RequestContext => testContext({ today, userId: USER, reportingCurrency: 'EUR' });
const OCT_1 = on('2026-10-01');
const OCT_10 = on('2026-10-10');

const deps = (): SpendingDependencies => ({ db: harness.db, fx: harness.services.fx });
const flowDeps = () => harness.services.flows;

async function makeAccount(
  name: string,
  options: { currency?: string; openedOn?: string | null; ctx?: RequestContext } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, options.ctx ?? OCT_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: options.openedOn ?? null,
  });
  return created.id;
}

const statement = (
  positionId: string,
  valuedOn: string,
  amount: string,
  ctx: RequestContext = OCT_1,
): Promise<unknown> =>
  recordValuation(harness.services.positions, ctx, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });

const snapshot = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, on(valuedOn), {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });

async function spend(
  options: {
    amount: string;
    on: string;
    account?: string | null;
    settlement?: 'tracked_cash' | 'untracked_self' | 'third_party';
    category?: string;
    currency?: string;
    description?: string;
    ctx?: RequestContext;
  },
): Promise<string> {
  const row = await createExpenseEntry(flowDeps(), options.ctx ?? OCT_1, {
    categoryId: options.category ?? groceries,
    incurredOn: options.on,
    amount: options.amount,
    currency: options.currency ?? 'EUR',
    settlement: options.settlement ?? 'tracked_cash',
    cashPositionId: (options.settlement ?? 'tracked_cash') === 'tracked_cash' ? (options.account ?? null) : null,
    ...(options.description === undefined ? {} : { description: options.description }),
  });
  return row.id;
}

async function salary(account: string, receivedOn: string, amount: string, ctx = OCT_1): Promise<void> {
  await createIncomeEntry(flowDeps(), ctx, {
    kind: 'employment',
    receivedOn,
    netAmount: amount,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: account,
  });
}

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

const page = (ctx: RequestContext = OCT_1, month?: string): Promise<SpendingPageDto> =>
  getSpendingPage(deps(), ctx, month === undefined ? {} : { month });

function completedFocus(dto: SpendingPageDto): SpendingFocusCompletedDto {
  if (dto.focus.shape !== 'completed') throw new Error('expected a completed focus');
  return dto.focus;
}

const row = (dto: SpendingPageDto, month: string) => {
  const found = dto.history.find((entry) => entry.month === month);
  if (found === undefined) throw new Error(`no history row for ${month}`);
  return found;
};

/** A reconciled BBVA: August 1,000 → September 700, a €2,000 salary and €150 of groceries. */
async function ordinarySeptember(): Promise<string> {
  const bbva = await makeAccount('BBVA');
  await statement(bbva, '2026-08-31', '1000.00');
  await statement(bbva, '2026-09-30', '700.00');
  await salary(bbva, '2026-09-25', '2000.00');
  await spend({ amount: '150.00', on: '2026-09-12', account: bbva, description: 'Weekly shop' });
  return bbva;
}

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${USER}, 'Spending', 'spending@example.test', true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
  await provisionUser(harness.db, { userId: USER });
  const categories = await listCategories(harness.db, USER);
  const id = (name: string): string => categories.find((row) => row.name === name)?.id as string;
  groceries = id('Groceries');
  eatingOut = id('Eating out');
  moneyOut = id('Money out of tracked accounts');
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  harness.fxProvider.reset();
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_skips');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');
  await harness.asOwner('DELETE FROM fx_rates');
});

/* -------------------------------------------------------------------------- */
/* Months                                                                      */
/* -------------------------------------------------------------------------- */

describe('which months the page reads', () => {
  it('opens on the last completed month, with twelve completed months and the current one', async () => {
    const dto = await page();
    expect(dto.month).toBe('2026-09');
    expect(dto.focus.shape).toBe('completed');
    expect(dto.history.map((entry) => entry.month)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(dto.history.at(-1)?.shape).toBe('current');
    expect(dto.navigation).toEqual({
      previous: '2026-08',
      next: '2026-10',
      currentMonth: '2026-10',
      lastCompletedMonth: '2026-09',
    });
  });

  it('reads an older completed month with its own twelve months and no current row', async () => {
    const dto = await page(OCT_1, '2026-03');
    expect(dto.month).toBe('2026-03');
    expect(dto.history.map((entry) => entry.month)).toEqual([
      '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09',
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
    ]);
    expect(dto.rolling.displayMonth).toBe('2026-03');
    expect(dto.rolling.endsBeforeFocus).toBe(false);
    expect(dto.navigation.next).toBe('2026-04');
  });

  it('reads the current month, with rolling ending at the last completed one', async () => {
    const dto = await page(OCT_10, '2026-10');
    expect(dto.focus.shape).toBe('current');
    expect(dto.navigation.next).toBeNull();
    expect(dto.rolling.displayMonth).toBe('2026-09');
    expect(dto.rolling.endsBeforeFocus).toBe(true);
    expect(dto.rolling.windows.map((window) => [window.months, window.from, window.to])).toEqual([
      [3, '2026-07', '2026-09'],
      [6, '2026-04', '2026-09'],
      [12, '2025-10', '2026-09'],
    ]);
  });

  it('refuses a month that is not one, and a month that has not begun', async () => {
    await expect(page(OCT_1, '2026-13')).rejects.toBeInstanceOf(ValidationError);
    await expect(page(OCT_1, 'September')).rejects.toBeInstanceOf(ValidationError);
    await expect(page(OCT_1, '2026-11')).rejects.toBeInstanceOf(ValidationError);
  });
});

/* -------------------------------------------------------------------------- */
/* The page is the standalone reads                                            */
/* -------------------------------------------------------------------------- */

describe('every figure is the figure its own read gives', () => {
  it('states each completed month exactly as the month’s reporting read does, later evidence notwithstanding', async () => {
    const bbva = await ordinarySeptember();
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    await statement(dollars, '2026-08-31', '500.00');
    await statement(dollars, '2026-09-30', '380.00');
    for (const day of ['01', '10', '15', '22', '30']) await rate('USD', `2026-09-${day}`, '1.2');
    await rate('USD', '2026-08-31', '1.2');
    // A snapshot in October: after September ends, so September must not see it.
    await snapshot(bbva, '2026-10-01', '650.00');

    const dto = await page();
    for (const month of ['2026-08', '2026-09']) {
      const expected = await getMonthReportingCashFlow(deps(), OCT_1, parseMonth(month));
      const entry = row(dto, month);
      expect(entry.tracked).toEqual(expected.trackedTotalSpending);
      expect(entry.known).toEqual(expected.knownTrackedSpending);
      expect(entry.unclassified).toEqual(expected.unclassified);
      expect(entry.additional).toEqual(expected.additionalSpending);
      expect(entry.total).toEqual(expected.totalSpending);
      expect(entry.savingsRate).toEqual(expected.savingsRate);
      expect(entry.status).toBe(expected.monthStatus);
    }
    expect(completedFocus(dto).figures).toEqual(
      await getMonthReportingCashFlow(deps(), OCT_1, parseMonth('2026-09')),
    );
    // And the same as Monthly shows for September.
    const monthly = await getMonthlyPage(deps(), OCT_1, parseMonth('2026-09'));
    if (monthly.kind !== 'completed') throw new Error('expected a completed month');
    expect(completedFocus(dto).figures).toEqual(monthly.reporting);
  });

  it('states the current month exactly as the month-to-date read does', async () => {
    const bbva = await makeAccount('BBVA', { ctx: OCT_10 });
    await statement(bbva, '2026-09-30', '1000.00');
    await snapshot(bbva, '2026-10-06', '900.00');
    await spend({ amount: '40.00', on: '2026-10-05', account: bbva, ctx: OCT_10 });
    await spend({ amount: '9.00', on: '2026-10-08', settlement: 'untracked_self', ctx: OCT_10 });

    const dto = await page(OCT_10, '2026-10');
    const expected = await getMonthToDateReportingCashFlow(deps(), OCT_10);
    if (dto.focus.shape !== 'current' || dto.focus.asOf === null) throw new Error('expected D');
    expect(expected.kind).toBe('tracked_interval');
    expect(dto.focus.figures).toEqual(expected);
    expect(dto.focus.asOf).toBe('2026-10-06');
    // The additional expense on the 8th is after D, so it is in no figure.
    expect(dto.focus.figures.additionalSpending.value.amount).toBe('0');
  });

  it('rolls exactly as the rolling read does', async () => {
    const bbva = await makeAccount('BBVA');
    const ends = ['2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'];
    const balances = ['1000.00', '900.00', '850.00', '850.00', '700.00'];
    for (const [index, end] of ends.entries()) await statement(bbva, end, balances[index] as string);

    const dto = await page();
    const [expected] = await getRollingTrackedSpendingSeries(deps(), OCT_1, {
      from: parseMonth('2026-09'),
      to: parseMonth('2026-09'),
    });
    expect(dto.rolling.windows.map((window) => window.average)).toEqual([
      expected?.rolling3,
      expected?.rolling6,
      expected?.rolling12,
    ]);
    // June 100, July 50, August a reliable zero, September 150: all four qualify.
    expect(dto.rolling.windows[0]?.average).toEqual({ value: { amount: '66.66666666666666666666666666666666666667', currency: 'EUR' }, count: 3 });
    expect(dto.rolling.windows[2]?.average?.count).toBe(4);
    expect(row(dto, '2026-08').tracked?.value.amount).toBe('0');
    expect(row(dto, '2026-08').rollingEligible).toBe(true);

    const series = await getCompletedReportingCashFlowSeries(deps(), OCT_1, {
      from: parseMonth('2025-10'),
      to: parseMonth('2026-09'),
    });
    expect(dto.history.slice(0, 12).map((entry) => entry.tracked)).toEqual(
      series.map((month) => month.trackedTotalSpending),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence and observation                                                    */
/* -------------------------------------------------------------------------- */

describe('what the page says a month observed', () => {
  it('keeps a pre-existing account’s earlier months observed and unavailable, never "not tracked"', async () => {
    // Opened date unknown, first balance at the end of August: August is its
    // first-balance month and every month before it lacks evidence (8.1).
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');

    const dto = await page();
    const july = row(dto, '2026-07');
    expect(july.observed).toBe(true);
    expect(july.status).toBe('unavailable');
    // The engine's own answer, kept as it is: nothing known was spent (an exact
    // zero) and the residual is missing, so tracked spending is partial at zero
    // with the missing evidence named. The page decides how to say that.
    expect(july.tracked).toMatchObject({ availability: 'partial', value: { amount: '0' } });
    expect(july.tracked?.missing).toEqual([
      { currency: 'EUR', reason: 'missing_month_end', detail: 'reconciliation_unavailable' },
    ]);
    expect(july.rollingEligible).toBe(false);

    const early = await page(OCT_1, '2026-07');
    expect(completedFocus(early).observed).toBe(true);
    expect(completedFocus(early).buckets).toEqual([
      expect.objectContaining({ cause: 'missing_month_end', accountsMissingEvidence: ['BBVA'] }),
    ]);

    const august = await page(OCT_1, '2026-08');
    expect(completedFocus(august).status).toBe('unavailable');
    expect(completedFocus(august).buckets).toEqual([
      expect.objectContaining({ cause: 'first_balance', firstBalanceAccounts: ['BBVA'] }),
    ]);
    expect(row(dto, '2026-09').status).toBe('reliable');
  });

  it('marks a month no cash account took part in as not observed — not a zero, and not missing evidence', async () => {
    const bbva = await makeAccount('BBVA', { openedOn: '2026-06-10' });
    await statement(bbva, '2026-06-30', '500.00');
    await statement(bbva, '2026-07-31', '500.00');
    await spend({ amount: '12.00', on: '2026-04-15', settlement: 'untracked_self' });

    const dto = await page();
    const april = row(dto, '2026-04');
    expect(april.observed).toBe(false);
    expect(april.status).toBe('unavailable');
    expect(april.tracked?.availability).toBe('unavailable');
    expect(april.tracked?.missing).toEqual([]);
    expect(april.total?.availability).toBe('unavailable');
    expect(april.rollingEligible).toBe(false);
    // The self-paid expense is still real, and still its own fact.
    expect(april.additional).toMatchObject({ availability: 'available', value: { amount: '12' } });

    const focus = completedFocus(await page(OCT_1, '2026-04'));
    expect(focus.observed).toBe(false);
    expect(focus.buckets).toEqual([]);
    // June opened inside the month, reconciled from zero: observed.
    expect(row(dto, '2026-06').observed).toBe(true);
    expect(row(dto, '2026-07')).toMatchObject({ status: 'reliable', rollingEligible: true });
  });

  it('shows an estimated month with its figures and leaves it out of rolling', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '800.00');
    const savings = await makeAccount('Savings');
    await statement(savings, '2026-09-30', '4000.00');
    await spend({ amount: '500.00', on: '2026-09-10', account: savings });

    const dto = await page();
    const september = row(dto, '2026-09');
    expect(september.status).toBe('estimated');
    expect(september.tracked).toMatchObject({ availability: 'available', quality: 'estimated' });
    expect(september.rollingEligible).toBe(false);
    // The first-balance account's €500 is outside the month, so outside its categories too.
    expect(dto.categories.rows.map((entry) => entry.name)).toEqual([]);
    expect(dto.largestKnown.mode).toBe('none');
  });

  it('keeps an unresolved month’s partial figures partial in the DTO, with the unexplained inflow', async () => {
    // Known expenses of €300 against €100 of cash that left: variant B.
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    await spend({ amount: '300.00', on: '2026-09-12', account: bbva });

    const focus = completedFocus(await page());
    expect(focus.status).toBe('unresolved');
    expect(focus.figures.knownTrackedSpending).toMatchObject({ availability: 'available', value: { amount: '300' } });
    expect(focus.figures.trackedTotalSpending).toMatchObject({ availability: 'partial', value: { amount: '300' } });
    expect(focus.figures.trackedSavingsFromIncome.availability).toBe('partial');
    expect(focus.figures.personalSavings.availability).toBe('partial');
    expect(focus.figures.savingsRate.kind).toBe('unavailable');
    expect(focus.buckets[0]?.unexplainedInflow).toEqual({ amount: { amount: '200', currency: 'EUR' }, variant: 'b' });
  });

  it('has no tracked figure for a current month with no common date, and keeps the two settlements through today', async () => {
    const bbva = await makeAccount('BBVA', { ctx: OCT_10 });
    const other = await makeAccount('Other', { ctx: OCT_10 });
    await statement(bbva, '2026-09-30', '1000.00');
    await statement(other, '2026-09-30', '500.00');
    await snapshot(bbva, '2026-10-06', '900.00');
    await snapshot(other, '2026-10-03', '450.00');
    await spend({ amount: '9.00', on: '2026-10-08', settlement: 'untracked_self', ctx: OCT_10 });
    await spend({ amount: '30.00', on: '2026-10-09', settlement: 'third_party', ctx: OCT_10 });

    const dto = await page(OCT_10, '2026-10');
    if (dto.focus.shape !== 'current' || dto.focus.asOf !== null) throw new Error('expected no D');
    expect(dto.focus.reason).toBe('mtd_no_common_date');
    expect(dto.focus.sourceOnlyThrough).toBe('2026-10-10');
    expect(dto.focus.sourceOnly.additionalSpending.value.amount).toBe('9');
    expect(dto.focus.sourceOnly.thirdPartyPaid.value.amount).toBe('30');
    expect(row(dto, '2026-10')).toMatchObject({ tracked: null, total: null, observed: false });
    expect(dto.categories.trackedInterval).toBeNull();
    expect(dto.categories.additionalInterval).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(dto.largestKnown.mode).toBe('source_only');
    expect(dto.largestKnown.groups[0]?.rows.map((entry) => entry.kind)).toEqual(['additional']);
  });
});

/* -------------------------------------------------------------------------- */
/* Spans                                                                       */
/* -------------------------------------------------------------------------- */

describe('spans', () => {
  it('finds a span whose anchor is older than the history, with its old flows, whole and in its own currency', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2025-01-31', '5000.00');
    await statement(bbva, '2026-08-31', '3000.00');
    await statement(bbva, '2026-09-30', '2900.00');
    // Inside the span, and more than a year before the history window opens.
    await spend({ amount: '400.00', on: '2025-03-15', account: bbva });
    await spend({ amount: '100.00', on: '2026-02-10', account: bbva });

    const dto = await page();
    expect(dto.spans).toHaveLength(1);
    const span = dto.spans[0];
    expect(span).toMatchObject({
      key: 'EUR:2025-02-01',
      currency: 'EUR',
      from: '2025-02-01',
      to: '2026-08-31',
      status: 'reliable',
    });
    expect(span?.totals.knownTrackedExpenses).toEqual({ amount: '500', currency: 'EUR' });
    expect(span?.trackedTotalSpending).toEqual({ amount: '2000', currency: 'EUR' });
    expect(span?.unclassified).toEqual({ amount: '1500', currency: 'EUR' });

    // The span read itself agrees.
    const expected = await getSpans(deps(), OCT_1, { from: parseMonth('2025-10') });
    expect(dto.spans.map(({ key: _key, ...rest }) => rest)).toEqual(expected);

    // Each covered month is unavailable on its own, points at the span, and is
    // no rolling observation; nothing covered is split.
    for (const month of ['2025-10', '2026-02', '2026-08']) {
      expect(row(dto, month)).toMatchObject({ status: 'unavailable', rollingEligible: false, spans: ['EUR:2025-02-01'] });
    }
    expect(row(dto, '2026-09')).toMatchObject({ status: 'reliable', spans: [] });
    expect(dto.rolling.windows[2]?.average?.count).toBe(1);
  });

  it('states a combined period as the blueprint does: tracked 1,694, known 972, unclassified 722', async () => {
    // 8.10's September–October gap, rebuilt from records Phase 3 can hold: two
    // salaries, known expenses of 300, 450 and 2 × 111, and two month ends.
    const nov = on('2026-11-02');
    const bbva = await makeAccount('BBVA', { ctx: nov });
    const savings = await makeAccount('Savings', { ctx: nov });
    await statement(bbva, '2026-08-31', '8055.00', nov);
    await statement(savings, '2026-08-31', '8509.00', nov);
    await statement(bbva, '2026-10-31', '10170.00', nov);
    await statement(savings, '2026-10-31', '8900.00', nov);
    await salary(bbva, '2026-09-25', '2100.00', nov);
    await salary(bbva, '2026-10-25', '2100.00', nov);
    for (const [amount, day] of [
      ['300.00', '2026-09-12'],
      ['111.00', '2026-09-01'],
      ['450.00', '2026-10-14'],
      ['111.00', '2026-10-01'],
    ] as const) {
      await spend({ amount, on: day, account: bbva, ctx: nov });
    }

    const dto = await page(nov, '2026-10');
    expect(dto.spans).toHaveLength(1);
    expect(dto.spans[0]).toMatchObject({
      currency: 'EUR',
      from: '2026-09-01',
      to: '2026-10-31',
      months: ['2026-09', '2026-10'],
      status: 'reliable',
      trackedTotalSpending: { amount: '1694', currency: 'EUR' },
      unclassified: { amount: '722', currency: 'EUR' },
    });
    expect(dto.spans[0]?.totals.knownTrackedExpenses).toEqual({ amount: '972', currency: 'EUR' });
    // Neither month has a figure of its own, and neither is a rolling observation.
    for (const month of ['2026-09', '2026-10']) {
      expect(row(dto, month)).toMatchObject({
        status: 'unavailable',
        rollingEligible: false,
        spans: ['EUR:2026-09-01'],
      });
      // Only the known part is stated; the month's own residual needs the missing month end.
      expect(row(dto, month).tracked?.availability).not.toBe('available');
      expect(row(dto, month).unclassified?.availability).toBe('unavailable');
    }
    expect(dto.rolling.windows[0]?.average).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Categories and largest known                                                */
/* -------------------------------------------------------------------------- */

describe('categories and the largest known rows', () => {
  it('add back to known tracked spending, keep additional apart, and leave paid-by-others and the residual out', async () => {
    const bbva = await ordinarySeptember();
    await spend({ amount: '80.00', on: '2026-09-14', account: bbva, category: eatingOut, description: 'Dinner' });
    await spend({ amount: '60.00', on: '2026-09-20', account: bbva, category: moneyOut, description: 'To mum' });
    await spend({ amount: '25.00', on: '2026-09-21', settlement: 'untracked_self', category: eatingOut, description: 'Cash lunch' });
    await spend({ amount: '999.00', on: '2026-09-22', settlement: 'third_party', category: eatingOut, description: 'Partner paid' });

    const dto = await page();
    const focus = completedFocus(dto);
    expect(dto.categories.order).toBe('amount');
    expect(
      dto.categories.rows.map((entry) => [
        entry.name,
        entry.group,
        entry.trackedKnown?.value.amount ?? null,
        entry.additional?.value.amount ?? null,
        entry.total.value.amount,
      ]),
    ).toEqual([
      ['Groceries', 'consumption', '150', null, '150'],
      ['Eating out', 'consumption', '80', '25', '105'],
      ['Money out of tracked accounts', 'money_out', '60', null, '60'],
    ]);
    const trackedSum = dto.categories.rows.reduce(
      (sum, entry) => sum + Number(entry.trackedKnown?.value.amount ?? '0'),
      0,
    );
    expect(String(trackedSum)).toBe(focus.figures.knownTrackedSpending.value.amount);
    expect(dto.categories.knownTrackedSpending).toEqual(focus.figures.knownTrackedSpending);
    expect(dto.categories.unclassified).toEqual(focus.figures.unclassified);
    expect(dto.categories.additionalSpending).toEqual(focus.figures.additionalSpending);

    expect(dto.largestKnown.mode).toBe('reporting_currency');
    expect(
      dto.largestKnown.groups[0]?.rows.map((entry) => [entry.description, entry.kind, entry.reporting.value.amount]),
    ).toEqual([
      ['Weekly shop', 'consumption', '150'],
      ['Dinner', 'consumption', '80'],
      ['To mum', 'money_out', '60'],
      ['Cash lunch', 'additional', '25'],
    ]);
    expect(JSON.stringify(dto.largestKnown)).not.toContain('Partner paid');
    expect(dto.largestKnown.groups[0]?.rows[0]).toMatchObject({ cashAccountName: 'BBVA', categoryName: 'Groceries' });
  });

  it('does not rank across currencies it cannot convert, and keeps the user’s category order', async () => {
    const bbva = await ordinarySeptember();
    // No dollar rate is ever stored: the publisher is down while the dollar
    // records are written, so every warm-up of their history fails.
    harness.fxProvider.failWith(providerOutage());
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    await statement(dollars, '2026-08-31', '900.00');
    await statement(dollars, '2026-09-30', '300.00');
    await spend({ amount: '500.00', on: '2026-09-15', account: dollars, currency: 'USD', category: eatingOut });
    harness.fxProvider.reset();
    await spend({ amount: '20.00', on: '2026-09-16', account: bbva, category: eatingOut });

    const dto = await page();
    expect(dto.largestKnown.mode).toBe('per_native_currency');
    expect(dto.largestKnown.groups.map((group) => [group.currency, group.rows.map((entry) => entry.native.amount)])).toEqual([
      ['EUR', ['150', '20']],
      ['USD', ['500']],
    ]);
    expect(dto.largestKnown.missing.map((item) => item.currency)).toEqual(['USD']);
    expect(dto.categories.order).toBe('category');
    expect(dto.categories.rows.map((entry) => entry.name)).toEqual(['Groceries', 'Eating out']);
    expect(dto.categories.rows[1]?.total.availability).toBe('partial');
  });
});

/* -------------------------------------------------------------------------- */
/* The form                                                                    */
/* -------------------------------------------------------------------------- */

describe('the Add known expense form', () => {
  it('offers Monthly’s own options, bounded to the focus month and never past today', async () => {
    await ordinarySeptember();
    const completed = await page();
    expect(completed.expenseForm.bounds).toEqual({ min: '2026-09-01', max: '2026-09-30' });

    const monthly = await getMonthlyPage(deps(), OCT_1, parseMonth('2026-09'));
    expect(completed.expenseForm.eligibleCategories).toEqual(monthly.expenses.eligibleCategories);
    expect(completed.expenseForm.cashAccounts).toEqual(monthly.expenses.cashAccounts);

    const current = await page(OCT_10, '2026-10');
    expect(current.expenseForm.bounds).toEqual({ min: '2026-10-01', max: '2026-10-10' });
  });
});

/* -------------------------------------------------------------------------- */
/* The read's bound                                                            */
/* -------------------------------------------------------------------------- */

/** Every `db.transaction` a read opens, as the Monthly suite counts them. */
function countingDatabase(): { db: Database; transactions: () => number } {
  let transactions = 0;
  const db = new Proxy(harness.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'transaction' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        transactions += 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db, transactions: () => transactions };
}

async function countTransactions(ctx: RequestContext = OCT_1, month?: string): Promise<number> {
  const counting = countingDatabase();
  const fx = createFxService({ db: counting.db, provider: harness.fxProvider });
  await getSpendingPage({ db: counting.db, fx }, ctx, month === undefined ? {} : { month });
  return counting.transactions();
}

/**
 * The page's stage one: the valuation window, the history's income, expenses and
 * transfers, the categories, the settings and the currency catalogue. A
 * euro-only page in a euro reporting currency needs no stored rate, so the rate
 * read opens nothing.
 */
const STAGE_ONE = 7;
/** The one rate read every foreign currency on the page shares. */
const RATES = 1;
/** The flows a span opening before the history window needs, read once. */
const OLD_SPAN_FLOWS = 3;

describe('the repository transaction count is bounded by a constant', () => {
  it('does not grow with accounts, expenses, categories, templates or history', async () => {
    const bbva = await ordinarySeptember();
    const small = await countTransactions();
    expect(small).toBe(STAGE_ONE);

    for (const name of ['Savings', 'Joint', 'Cash box']) {
      const id = await makeAccount(name);
      await statement(id, '2026-08-31', '100.00');
      await statement(id, '2026-09-30', '100.00');
    }
    for (let index = 0; index < 8; index += 1) {
      await spend({ amount: '1.00', on: `2026-0${String(index + 1)}-05`, account: bbva });
      await spend({ amount: '2.00', on: '2026-09-06', settlement: 'untracked_self', category: eatingOut });
      await spend({ amount: '3.00', on: '2026-09-07', settlement: 'third_party', category: eatingOut });
    }
    for (const name of ['Salary', 'Bonus', 'Rent']) {
      await createTemplate(flowDeps(), OCT_1, {
        kind: 'income',
        name,
        incomeKind: 'employment',
        currency: 'EUR',
        frequency: 'monthly',
        dayOfMonth: 25,
        startDate: '2026-01-01',
        amount: '10.00',
      });
    }
    // Older history, and a span inside the window its flows already cover.
    await statement(bbva, '2025-12-31', '800.00');

    expect(await countTransactions()).toBe(small);
    expect(await countTransactions(OCT_10, '2026-10')).toBe(small);
  });

  it('adds one rate read for foreign currencies, however many', async () => {
    await ordinarySeptember();
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    await statement(dollars, '2026-08-31', '100.00');
    await statement(dollars, '2026-09-30', '90.00');
    expect(await countTransactions()).toBe(STAGE_ONE + RATES);

    for (const currency of ['GBP', 'CHF']) {
      const id = await makeAccount(`In ${currency}`, { currency });
      await statement(id, '2026-08-31', '100.00');
      await statement(id, '2026-09-30', '90.00');
    }
    expect(await countTransactions()).toBe(STAGE_ONE + RATES);
  });

  it('reads a span’s flows from what is loaded when they cover it', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-05-31', '1000.00');
    await statement(bbva, '2026-08-31', '900.00');
    const dto = await page();
    expect(dto.spans.map((span) => span.key)).toEqual(['EUR:2026-06-01']);
    expect(await countTransactions()).toBe(STAGE_ONE);
  });

  it('adds the constant span stage once when a span reaches before the history, however old', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2023-02-28', '1200.00');
    await statement(bbva, '2026-08-31', '900.00');
    for (const day of ['2023-05-10', '2024-05-10', '2025-05-10']) {
      await spend({ amount: '5.00', on: day, account: bbva });
    }
    const dto = await page();
    expect(dto.spans.map((span) => span.key)).toEqual(['EUR:2023-03-01']);
    expect(dto.spans[0]?.totals.knownTrackedExpenses).toEqual({ amount: '15', currency: 'EUR' });
    expect(await countTransactions()).toBe(STAGE_ONE + OLD_SPAN_FLOWS);

    // An older focus whose span runs past the window reads that span's flows the same way.
    expect(await countTransactions(OCT_1, '2025-01')).toBe(STAGE_ONE + OLD_SPAN_FLOWS);
  });

  it('calls no rate provider', async () => {
    await ordinarySeptember();
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    await statement(dollars, '2026-08-31', '100.00');
    await statement(dollars, '2026-09-30', '90.00');
    harness.fxProvider.reset();
    await page();
    await page(OCT_10, '2026-10');
    expect(harness.fxProvider.calls).toEqual([]);
  });
});
