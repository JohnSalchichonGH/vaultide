import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser, type Database } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { providerOutage } from '../helpers/stub-fx-provider';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { createIncomeEntry } from '../../src/flows/income';
import { archiveTemplate, createTemplate } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
import { createFxService } from '../../src/fx/service';
import { ValidationError } from '../../src/errors';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import { parseMonth } from '../../src/reconciliation/service';
import { getIncomePage, type IncomeDependencies } from '../../src/income/service';
import type { IncomePageDto, IncomeTotalDto } from '../../src/income/types';

/**
 * The Income year view's read, against a real database (blueprint 15.2
 * "Income", v2.1.20 30.23; ADR 0012 D1–D3, D7).
 *
 * Read on 4 October 2026, so September is the last completed month. Every
 * record is written through the product's own services. The figures are pinned
 * by hand from the fixture below, because what the page counts is a ruling
 * (30.23 items 1, 2, 4, 5) rather than an engine another read already has; the
 * missing flags are compared with the completeness read month by month, because
 * they must be that computation (30.23 item 8).
 *
 * The fixture, in euros unless it says otherwise, with $1 = €0.80 on every date
 * a dollar is converted:
 *
 *  - **Salary** (EUR, the 25th, from 2026): January to June recorded at 2,000
 *    with a gross of 2,800, July skipped, August and September missing;
 *  - **Royalties** (USD, quarterly on the 15th, from January 2026): $100 in
 *    January and April, July missing;
 *  - **Flat rent** (EUR, the 1st, from October 2026): October's 700 arrived on
 *    30 September;
 *  - **Interest** (EUR, the 2nd, from September 2026): September's 3.10
 *    recorded, October's due and not;
 *  - **Old job** (EUR, the 1st, through 2025, archived): January to March 2025
 *    at 1,500, April skipped, May to December missing;
 *  - one-off: a 2024 freelance payment of 300 outside tracked accounts; a March
 *    bonus of 500 with a gross of 700; September's freelance 450 outside, an
 *    "other" 20 and a $40 dividend;
 *  - not income here: a September reconciliation adjustment of 999 and 5,000 in
 *    from outside.
 */

const USER = '78787878-7878-4787-8787-787878787878';
const OTHER = '79797979-7979-4797-8797-797979797979';

let harness: Harness;

const on = (today: string, userId = USER): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });
const OCT_4 = on('2026-10-04');

const deps = (): IncomeDependencies => ({ db: harness.db, fx: harness.services.fx });
const flows = () => harness.services.flows;

const page = (year?: string, ctx: RequestContext = OCT_4): Promise<IncomePageDto> =>
  getIncomePage(deps(), ctx, year === undefined ? {} : { year });

async function makeAccount(name: string, currency = 'EUR', ctx = OCT_4): Promise<string> {
  const created = await createCashAccount(harness.services.positions, ctx, {
    name,
    currency,
    accountType: 'checking',
    openedOn: null,
  });
  return created.id;
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

async function source(args: {
  name: string;
  incomeKind: 'employment' | 'other' | 'rental' | 'interest';
  currency?: string;
  day: number;
  start: string;
  end?: string;
  frequency?: 'monthly' | 'quarterly';
  amount: string;
  gross?: string;
  account?: string;
  ctx?: RequestContext;
}): Promise<{ id: string; version: number }> {
  const created = await createTemplate(flows(), args.ctx ?? OCT_4, {
    kind: 'income',
    name: args.name,
    incomeKind: args.incomeKind,
    currency: args.currency ?? 'EUR',
    frequency: args.frequency ?? 'monthly',
    dayOfMonth: args.day,
    startDate: args.start,
    ...(args.end === undefined ? {} : { endDate: args.end }),
    ...(args.account === undefined ? {} : { cashPositionId: args.account }),
    amount: args.amount,
    ...(args.gross === undefined ? {} : { grossAmount: args.gross }),
  });
  return { id: created.template.id, version: created.template.version };
}

const accept = (templateId: string, occurrenceDate: string, financialDate?: string) =>
  acceptSuggestion(flows(), OCT_4, {
    templateId,
    occurrenceDate,
    ...(financialDate === undefined ? {} : { financialDate }),
  });

const skip = (templateId: string, occurrenceDate: string) =>
  skipSuggestion(flows(), OCT_4, { templateId, occurrenceDate, reason: 'skipped' });

async function oneOff(args: {
  kind: 'employment' | 'bonus' | 'freelance' | 'other' | 'dividend' | 'adjustment' | 'external_inflow';
  on: string;
  net: string;
  gross?: string;
  currency?: string;
  account?: string | null;
  external?: boolean;
  isOneOff?: boolean;
  description?: string;
  ctx?: RequestContext;
}): Promise<string> {
  const row = await createIncomeEntry(flows(), args.ctx ?? OCT_4, {
    kind: args.kind,
    receivedOn: args.on,
    netAmount: args.net,
    ...(args.gross === undefined ? {} : { grossAmount: args.gross }),
    currency: args.currency ?? 'EUR',
    settlement: args.external === true ? 'external' : 'tracked_cash',
    cashPositionId: args.external === true ? null : (args.account ?? null),
    ...(args.isOneOff === undefined ? {} : { isOneOff: args.isOneOff }),
    ...(args.description === undefined ? {} : { description: args.description }),
  });
  return row.id;
}

interface Fixture {
  readonly salary: string;
  readonly royalties: string;
  readonly flatRent: string;
  readonly interest: string;
  readonly oldJob: string;
  readonly bbva: string;
}

/** The fixture in the header, with every dollar rate stored by hand. */
async function fixture(): Promise<Fixture> {
  // No rate reaches the table except the ones stored below: the publisher is
  // down while the records are written, so no warm-up fills one in.
  harness.fxProvider.failWith(providerOutage());

  const bbva = await makeAccount('BBVA');
  const chase = await makeAccount('Chase', 'USD');

  const salary = await source({
    name: 'Salary',
    incomeKind: 'employment',
    day: 25,
    start: '2026-01-01',
    amount: '2000.00',
    gross: '2800.00',
    account: bbva,
  });
  for (const month of ['01', '02', '03', '04', '05', '06']) await accept(salary.id, `2026-${month}-25`);
  await skip(salary.id, '2026-07-25');

  const royalties = await source({
    name: 'Royalties',
    incomeKind: 'other',
    currency: 'USD',
    frequency: 'quarterly',
    day: 15,
    start: '2026-01-15',
    amount: '100.00',
    account: chase,
  });
  await accept(royalties.id, '2026-01-15');
  await accept(royalties.id, '2026-04-15');

  const flatRent = await source({ name: 'Flat rent', incomeKind: 'rental', day: 1, start: '2026-10-01', amount: '700.00', account: bbva });
  // October's rent, scheduled for the 1st, arrived on 30 September.
  await accept(flatRent.id, '2026-10-01', '2026-09-30');

  const interest = await source({ name: 'Interest', incomeKind: 'interest', day: 2, start: '2026-09-01', amount: '3.10', account: bbva });
  await accept(interest.id, '2026-09-02');

  const oldJob = await source({ name: 'Old job', incomeKind: 'employment', day: 1, start: '2025-01-01', end: '2025-12-31', amount: '1500.00', account: bbva });
  for (const month of ['01', '02', '03']) await accept(oldJob.id, `2025-${month}-01`);
  await skip(oldJob.id, '2025-04-01');
  await archiveTemplate(flows(), OCT_4, { templateId: oldJob.id, expectedVersion: oldJob.version });

  await oneOff({ kind: 'freelance', on: '2024-05-10', net: '300.00', external: true });
  await oneOff({ kind: 'bonus', on: '2026-03-31', net: '500.00', gross: '700.00', account: bbva });
  await oneOff({ kind: 'freelance', on: '2026-09-10', net: '450.00', external: true, isOneOff: true, description: 'Logo' });
  await oneOff({ kind: 'other', on: '2026-09-12', net: '20.00', account: bbva, isOneOff: false });
  await oneOff({ kind: 'dividend', on: '2026-09-15', net: '40.00', currency: 'USD', account: chase });
  await oneOff({ kind: 'adjustment', on: '2026-09-20', net: '999.00', account: bbva });
  await oneOff({ kind: 'external_inflow', on: '2026-09-21', net: '5000.00', account: bbva });

  harness.fxProvider.reset();
  // EUR -> USD 1.25, so $1 is €0.80, on each date a dollar converts at.
  for (const day of ['2026-01-15', '2026-04-15', '2026-09-15']) await rate('USD', day, '1.25');

  return { salary: salary.id, royalties: royalties.id, flatRent: flatRent.id, interest: interest.id, oldJob: oldJob.id, bbva };
}

const net = (total: IncomeTotalDto): string => total.net.value.amount;

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    for (const [id, email] of [
      [USER, 'income@example.test'],
      [OTHER, 'income-other@example.test'],
    ] as const) {
      await tx.execute(
        sql`INSERT INTO "user" (id, name, email, email_verified)
            VALUES (${id}, 'Income', ${email}, true)
            ON CONFLICT (id) DO NOTHING`,
      );
    }
  });
  await provisionUser(harness.db, { userId: USER });
  await provisionUser(harness.db, { userId: OTHER });
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
/* The year                                                                    */
/* -------------------------------------------------------------------------- */

describe('the year in view', () => {
  it('counts what was recorded, by the day it arrived, split into tracked and outside', async () => {
    await fixture();
    const dto = await page();

    expect(dto.year).toBe(2026);
    expect(dto.view.current).toBe(true);
    expect(net(dto.view.total)).toBe('13865.1');
    expect(net(dto.view.tracked)).toBe('13415.1');
    expect(net(dto.view.outside)).toBe('450');
    expect(dto.view.total.net.availability).toBe('available');
    // Neither the adjustment nor the money in from outside is in any figure.
    expect(dto.view.total.count).toBe(14);
  });

  it('places each month by received_on and splits it salary, bonus and other', async () => {
    await fixture();
    const dto = await page();
    expect(dto.view.months.map((month) => month.month)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(dto.view.months.map((month) => net(month.total))).toEqual([
      '2080', '2000', '2500', '2080', '2000', '2000', '0', '0', '1205.1', '0',
    ]);
    const march = dto.view.months[2];
    expect([march?.salary.value.amount, march?.bonus.value.amount, march?.other.value.amount]).toEqual([
      '2000', '500', '0',
    ]);
    // October's rent arrived on 30 September, so it is September's.
    const september = dto.view.months[8];
    expect(september?.other.value.amount).toBe('1205.1');
    expect(dto.view.months.filter((month) => month.current).map((month) => month.month)).toEqual(['2026-10']);
  });

  it('shows each source with a payment or an occurrence in the year, and keeps one-offs apart', async () => {
    await fixture();
    const dto = await page();
    expect(dto.view.sourceOrder).toBe('amount');
    expect(dto.view.sources.map((row) => [row.name, net(row.total), row.archived, row.currency])).toEqual([
      ['Salary', '12000', false, 'EUR'],
      ['Flat rent', '700', false, 'EUR'],
      ['Royalties', '160', false, 'USD'],
      ['Interest', '3.1', false, 'EUR'],
    ]);
    const royalties = dto.view.sources.find((row) => row.name === 'Royalties');
    expect(royalties?.total.native).toEqual([{ amount: '200', currency: 'USD' }]);

    expect(dto.view.oneOff?.kinds.map((group) => [group.kind, net(group.total), group.payments.length])).toEqual([
      ['bonus', '500', 1],
      ['freelance', '450', 1],
      ['dividend', '32', 1],
      ['other', '20', 1],
    ]);
    const freelance = dto.view.oneOff?.kinds.find((group) => group.kind === 'freelance')?.payments[0];
    expect(freelance).toMatchObject({
      receivedOn: '2026-09-10',
      settlement: 'external',
      description: 'Logo',
      net: { amount: '450', currency: 'EUR' },
    });
  });

  it('lets is_one_off play no part: a source’s entry stays the source’s, a flagless manual one is one-off', async () => {
    const ids = await fixture();
    await harness.asOwner('UPDATE income_entries SET is_one_off = true WHERE template_id = $1', [ids.salary]);
    const dto = await page();
    expect(dto.view.sources.find((row) => row.name === 'Salary')?.total.count).toBe(6);
    // The "other" 20 was recorded with is_one_off false and is a one-off all the same.
    expect(dto.view.oneOff?.kinds.find((group) => group.kind === 'other')?.total.count).toBe(1);
  });

  it('states a gross only over the payments that recorded one, and how many did not', async () => {
    await fixture();
    const dto = await page();
    expect(dto.view.total.gross.recorded?.value.amount).toBe('17500');
    expect(dto.view.total.gross.withoutGross).toBe(7);
    const flatRent = dto.view.sources.find((row) => row.name === 'Flat rent');
    expect(flatRent?.total.gross).toEqual({ recorded: null, withoutGross: 1 });
  });

  it('gives every year with income, and the last twelve months whichever year is shown', async () => {
    await fixture();
    for (const year of [undefined, '2025', '2024']) {
      const dto = await page(year);
      expect(dto.years.map((row) => [row.year, net(row.total), row.current])).toEqual([
        [2026, '13865.1', true],
        [2025, '4500', false],
        [2024, '300', false],
      ]);
      expect(dto.lastTwelveMonths).toMatchObject({ from: '2025-11', to: '2026-10' });
      expect(net(dto.lastTwelveMonths.total)).toBe('13865.1');
    }
  });

  it('shows a past year whole, with its archived source labelled', async () => {
    await fixture();
    const dto = await page('2025');
    expect(dto.view.current).toBe(false);
    expect(dto.view.months).toHaveLength(12);
    expect(dto.view.sources.map((row) => [row.name, net(row.total), row.archived])).toEqual([
      ['Old job', '4500', true],
    ]);
    expect(dto.navigation).toEqual({ previous: 2024, next: 2026 });
    expect((await page()).navigation).toEqual({ previous: 2025, next: null });
  });

  it('offers the seven counted kinds and the user’s cash accounts to the forms', async () => {
    await fixture();
    const dto = await page();
    expect([...dto.forms.paymentKinds].sort()).toEqual(
      ['bonus', 'dividend', 'employment', 'freelance', 'interest', 'other', 'rental'],
    );
    expect(dto.forms.cashAccounts.map((row) => [row.name, row.currency])).toEqual([
      ['BBVA', 'EUR'],
      ['Chase', 'USD'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing rates                                                               */
/* -------------------------------------------------------------------------- */

describe('a missing rate', () => {
  it('leaves the figures partial, naming the currency, and orders sources by name instead', async () => {
    await fixture();
    await harness.asOwner("DELETE FROM fx_rates WHERE rate_date = '2026-04-15'");
    const dto = await page();

    expect(dto.view.total.net.availability).toBe('partial');
    expect(dto.view.total.net.missing).toEqual([expect.objectContaining({ currency: 'USD', reason: 'fx_missing' })]);
    expect(net(dto.view.total)).toBe('13785.1');
    expect(dto.view.months[3]?.total.net.availability).toBe('partial');
    expect(dto.lastTwelveMonths.total.net.availability).toBe('partial');
    expect(dto.years[0]?.total.net.availability).toBe('partial');

    expect(dto.view.sourceOrder).toBe('name');
    expect(dto.view.sources.map((row) => row.name)).toEqual(['Flat rent', 'Interest', 'Royalties', 'Salary']);
    // The native figure needs no rate and stays whole.
    expect(dto.view.sources.find((row) => row.name === 'Royalties')?.total.native).toEqual([
      { amount: '200', currency: 'USD' },
    ]);
  });

  it('calls no rate provider', async () => {
    await fixture();
    harness.fxProvider.reset();
    await harness.asOwner('DELETE FROM fx_rates');
    await page();
    expect(harness.fxProvider.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing occurrences                                                         */
/* -------------------------------------------------------------------------- */

/** The completeness read's unsatisfied income occurrences, month by month: the oracle. */
async function completenessMissing(year: number, lastMonth: number): Promise<Map<string, string[]>> {
  const missing = new Map<string, string[]>();
  for (let month = 1; month <= lastMonth; month += 1) {
    const key = `${String(year)}-${String(month).padStart(2, '0')}`;
    const completeness = await getMonthCompleteness(deps(), OCT_4, parseMonth(key));
    for (const item of completeness.recurringOccurrences) {
      if (item.satisfied || item.templateKind !== 'income') continue;
      missing.set(item.templateId, [...(missing.get(item.templateId) ?? []), item.occurrenceDate]);
    }
  }
  return missing;
}

describe('missing occurrences', () => {
  it('are the completeness read’s, month by month, over completed months only', async () => {
    const ids = await fixture();
    const dto = await page();
    expect(new Map(dto.view.missing.map((flag) => [flag.templateId, [...flag.occurrences]]))).toEqual(
      await completenessMissing(2026, 9),
    );
    expect(dto.view.missing.map((flag) => [flag.name, flag.occurrences, flag.archived])).toEqual([
      ['Royalties', ['2026-07-15'], false],
      ['Salary', ['2026-08-25', '2026-09-25'], false],
    ]);
    // October's interest is due and unrecorded, and the current month is never flagged.
    expect(dto.view.missing.some((flag) => flag.templateId === ids.interest)).toBe(false);
  });

  it('still count an archived source for the months its schedule covered', async () => {
    const ids = await fixture();
    const dto = await page('2025');
    expect(new Map(dto.view.missing.map((flag) => [flag.templateId, [...flag.occurrences]]))).toEqual(
      await completenessMissing(2025, 12),
    );
    expect(dto.view.missing).toEqual([
      {
        templateId: ids.oldJob,
        name: 'Old job',
        archived: true,
        occurrences: ['2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01'],
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The address                                                                 */
/* -------------------------------------------------------------------------- */

describe('the year in the address', () => {
  it('refuses one that is not a year, or has not begun', async () => {
    for (const year of ['26', '20266', 'abcd', '2026-01', ' 2026', '2027']) {
      await expect(page(year)).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await page('2026')).year).toBe(2026);
  });
});

/* -------------------------------------------------------------------------- */
/* The empty state                                                             */
/* -------------------------------------------------------------------------- */

describe('the empty state', () => {
  it('belongs to a user with no income and no income source', async () => {
    expect((await page()).empty).toBe(true);
    // A reconciliation adjustment is not income.
    await oneOff({ kind: 'adjustment', on: '2026-09-20', net: '9.00', account: await makeAccount('BBVA') });
    expect((await page()).empty).toBe(true);
  });

  it('ends with the first source, before anything has arrived', async () => {
    await source({ name: 'Salary', incomeKind: 'employment', day: 25, start: '2026-11-01', amount: '1.00' });
    const dto = await page();
    expect(dto.empty).toBe(false);
    expect(dto.view.sources.map((row) => [row.name, net(row.total)])).toEqual([['Salary', '0']]);
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

describe('another user', () => {
  it('reaches none of these rows, and its own page shows only its own', async () => {
    await fixture();
    const otherCtx = on('2026-10-04', OTHER);
    const theirs = await getIncomePage(deps(), otherCtx, {});
    expect(theirs.empty).toBe(true);
    expect(theirs.years).toEqual([]);
    expect(theirs.forms.cashAccounts).toEqual([]);

    await createIncomeEntry(flows(), otherCtx, {
      kind: 'freelance',
      receivedOn: '2026-09-01',
      netAmount: '7.00',
      currency: 'EUR',
      settlement: 'external',
    });
    expect(net((await getIncomePage(deps(), otherCtx, {})).view.total)).toBe('7');
    expect(net((await page()).view.total)).toBe('13865.1');
  });
});

/* -------------------------------------------------------------------------- */
/* The read's bound                                                            */
/* -------------------------------------------------------------------------- */

/** Every `db.transaction` a read opens, as the Spending suite counts them. */
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

async function countTransactions(year?: string): Promise<number> {
  const counting = countingDatabase();
  const fx = createFxService({ db: counting.db, provider: harness.fxProvider });
  await getIncomePage({ db: counting.db, fx }, OCT_4, year === undefined ? {} : { year });
  return counting.transactions();
}

/**
 * The page's reads: the entries, the templates, the year's resolved occurrences
 * (one transaction, four statements side by side), the settings, the currency
 * catalogue and the cash accounts. A euro-only page in a euro reporting
 * currency needs no stored rate, so the rate read opens nothing.
 */
const READS = 6;
/** The one rate read every foreign currency on the page shares. */
const RATES = 1;

describe('the repository transaction count is bounded by a constant', () => {
  it('does not grow with years, sources, entries or skips', async () => {
    const bbva = await makeAccount('BBVA');
    await oneOff({ kind: 'other', on: '2026-09-01', net: '1.00', account: bbva });
    const small = await countTransactions();
    expect(small).toBe(READS);

    for (const name of ['Salary', 'Pension', 'Rent']) {
      const created = await source({ name, incomeKind: 'employment', day: 5, start: '2020-01-01', amount: '10.00', account: bbva });
      for (const year of ['2021', '2022', '2023', '2024', '2025']) await accept(created.id, `${year}-03-05`);
      await skip(created.id, '2026-02-05');
    }
    for (let index = 0; index < 12; index += 1) {
      await oneOff({ kind: 'bonus', on: `20${String(10 + index)}-06-30`, net: '5.00', external: true });
    }

    expect(await countTransactions()).toBe(small);
    expect(await countTransactions('2015')).toBe(small);
  });

  it('adds one rate read for foreign currencies, however many', async () => {
    harness.fxProvider.failWith(providerOutage());
    await oneOff({ kind: 'other', on: '2026-09-01', net: '1.00', currency: 'USD', external: true });
    expect(await countTransactions()).toBe(READS + RATES);
    for (const currency of ['GBP', 'CHF']) {
      await oneOff({ kind: 'other', on: '2019-09-01', net: '1.00', currency, external: true });
    }
    expect(await countTransactions()).toBe(READS + RATES);
  });
});
