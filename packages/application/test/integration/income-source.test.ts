import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser, type Database } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { READ_OPEN, isLock, isWrite, perConnection, record } from '../helpers/statement-shapes';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { listCategories } from '../../src/users/categories';
import { createCashAccount } from '../../src/positions/service';
import { archiveTemplate, createTemplate, setTemplateTerm } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
import { NotFoundError, ValidationError } from '../../src/errors';
import { getIncomePage } from '../../src/income/service';
import { getIncomeSourcePage, type IncomeSourceQuery } from '../../src/income/source';
import type { IncomeSourcePageDto } from '../../src/income/source-types';

/**
 * One income source's page, against a real database (blueprint 15.2 "Income
 * source", v2.1.20 30.23; ADR 0012 D2, D4, D7).
 *
 * Read on 4 October 2026, so September is the last completed month. Every
 * record is written through the product's own services. What each occurrence
 * became is pinned by hand from the fixture; which ones are missing is
 * compared with the year view's own flag for the same source, because the two
 * pages must report the same payments missing (30.23 item 8).
 *
 * The fixture, in euros:
 *
 *  - **Salary** (the 25th, from July 2025, into BBVA, 2,000 with a gross of
 *    2,800): July to September 2025 recorded, October 2025 skipped, November
 *    and December 2025 missing. In 2026: January and February recorded;
 *    March's arrived on 2 April; from April's occurrence the amount is 2,100
 *    with no gross, and April's arrived on the 20th, before that occurrence's
 *    date; May skipped for unpaid leave; June's arrived early, on 30 May; July
 *    to September missing; October to December not yet due.
 *  - **Old job** (the 1st, through 2025, archived): January recorded,
 *    February skipped, March to December missing.
 */

const USER = '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a';
const OTHER = '7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b';

let harness: Harness;
let insurance: string;

const on = (today: string, userId = USER): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });
const OCT_4 = on('2026-10-04');

const flows = () => harness.services.flows;

const page = (
  templateId: string,
  year?: string,
  ctx: RequestContext = OCT_4,
  db: Database = harness.db,
): Promise<IncomeSourcePageDto> => {
  const query: IncomeSourceQuery = year === undefined ? { templateId } : { templateId, year };
  return getIncomeSourcePage({ db }, ctx, query);
};

async function makeAccount(name: string, ctx = OCT_4): Promise<string> {
  const created = await createCashAccount(harness.services.positions, ctx, {
    name,
    currency: 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  return created.id;
}

async function source(args: {
  name: string;
  day: number;
  start: string;
  end?: string;
  amount: string;
  gross?: string;
  account?: string;
  counterparty?: string;
  ctx?: RequestContext;
}): Promise<{ id: string; version: number }> {
  const created = await createTemplate(flows(), args.ctx ?? OCT_4, {
    kind: 'income',
    name: args.name,
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: args.day,
    startDate: args.start,
    ...(args.end === undefined ? {} : { endDate: args.end }),
    ...(args.account === undefined ? {} : { cashPositionId: args.account }),
    ...(args.counterparty === undefined ? {} : { counterparty: args.counterparty }),
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

const skip = (templateId: string, occurrenceDate: string, note?: string) =>
  skipSuggestion(flows(), OCT_4, {
    templateId,
    occurrenceDate,
    reason: note === undefined ? 'skipped' : 'other',
    ...(note === undefined ? {} : { note }),
  });

interface Fixture {
  readonly salary: string;
  readonly oldJob: string;
  readonly bbva: string;
}

async function fixture(): Promise<Fixture> {
  const bbva = await makeAccount('BBVA');

  const salary = await source({
    name: 'Salary',
    day: 25,
    start: '2025-07-01',
    amount: '2000.00',
    gross: '2800.00',
    account: bbva,
    counterparty: 'Acme',
  });
  for (const month of ['07', '08', '09']) await accept(salary.id, `2025-${month}-25`);
  await skip(salary.id, '2025-10-25');
  await accept(salary.id, '2026-01-25');
  await accept(salary.id, '2026-02-25');
  await accept(salary.id, '2026-03-25', '2026-04-02');
  await setTemplateTerm(flows(), OCT_4, {
    templateId: salary.id,
    effectiveFrom: '2026-04-25',
    amount: '2100.00',
    expected: { state: 'absent' },
  });
  await accept(salary.id, '2026-04-25', '2026-04-20');
  await skip(salary.id, '2026-05-25', 'Unpaid leave');
  await accept(salary.id, '2026-06-25', '2026-05-30');

  const oldJob = await source({ name: 'Old job', day: 1, start: '2025-01-01', end: '2025-12-31', amount: '1500.00' });
  await accept(oldJob.id, '2025-01-01');
  await skip(oldJob.id, '2025-02-01');
  await archiveTemplate(flows(), OCT_4, { templateId: oldJob.id, expectedVersion: oldJob.version });

  return { salary: salary.id, oldJob: oldJob.id, bbva };
}

const stateOf = (dto: IncomeSourcePageDto): Record<string, string> =>
  Object.fromEntries(dto.occurrences.map((row) => [row.occurrenceDate, row.state.kind]));

/** The year view's missing payments for one source and year, which this page must repeat. */
async function yearViewMissing(templateId: string, year: string): Promise<readonly string[]> {
  const view = await getIncomePage({ db: harness.db, fx: harness.services.fx }, OCT_4, { year });
  return view.view.missing.find((flag) => flag.templateId === templateId)?.occurrences ?? [];
}

const missingOf = (dto: IncomeSourcePageDto): string[] =>
  dto.occurrences.filter((row) => row.state.kind === 'missing').map((row) => row.occurrenceDate);

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    for (const [id, email] of [
      [USER, 'income-source@example.test'],
      [OTHER, 'income-source-other@example.test'],
    ] as const) {
      await tx.execute(
        sql`INSERT INTO "user" (id, name, email, email_verified)
            VALUES (${id}, 'Income source', ${email}, true)
            ON CONFLICT (id) DO NOTHING`,
      );
    }
  });
  await provisionUser(harness.db, { userId: USER });
  await provisionUser(harness.db, { userId: OTHER });
  const categories = await listCategories(harness.db, USER);
  insurance = categories.find((row) => row.kind === 'insurance')?.id as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_skips');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');
});

/* -------------------------------------------------------------------------- */
/* The source                                                                  */
/* -------------------------------------------------------------------------- */

describe('the source', () => {
  it('states its details, the account it pays into, and its version', async () => {
    const { salary, bbva } = await fixture();
    const dto = await page(salary);
    expect(dto.source).toMatchObject({
      templateId: salary,
      version: 1,
      name: 'Salary',
      counterparty: 'Acme',
      incomeKind: 'employment',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 25,
      startDate: '2025-07-01',
      endDate: null,
      archived: false,
      account: { positionId: bbva, name: 'BBVA' },
    });
    expect(dto.minorUnitsByCurrency.EUR).toBe(2);
  });

  it('names no account for a source that has none, and labels an archived one', async () => {
    const { oldJob } = await fixture();
    const dto = await page(oldJob, '2025');
    expect(dto.source.account).toBeNull();
    expect(dto.source.archived).toBe(true);
    expect(dto.source.endDate).toBe('2025-12-31');
  });

  it('gives an end-date change the completed occurrences as though the schedule never ended', async () => {
    const { salary, oldJob } = await fixture();
    const dates = (await page(salary)).source.completedOccurrenceDates;
    expect(dates[0]).toBe('2025-07-25');
    expect(dates.at(-1)).toBe('2026-09-25');
    expect(dates).toHaveLength(15);
    // Past its own end date, through September 2026.
    const ended = (await page(oldJob, '2025')).source.completedOccurrenceDates;
    expect(ended[0]).toBe('2025-01-01');
    expect(ended.at(-1)).toBe('2026-09-01');
  });
});

/* -------------------------------------------------------------------------- */
/* Amount history                                                              */
/* -------------------------------------------------------------------------- */

describe('the amount history', () => {
  it('lists every term, oldest first, with a gross only where one was set', async () => {
    const { salary } = await fixture();
    expect((await page(salary)).terms).toEqual([
      {
        effectiveFrom: '2025-07-01',
        net: { amount: '2000', currency: 'EUR' },
        gross: { amount: '2800', currency: 'EUR' },
        note: null,
      },
      { effectiveFrom: '2026-04-25', net: { amount: '2100', currency: 'EUR' }, gross: null, note: null },
    ]);
  });

  it('sets every payment beside the term of its scheduled date, whichever year is shown', async () => {
    const { salary } = await fixture();
    const arrivals = (await page(salary, '2025')).arrivals;
    expect(arrivals.map((row) => row.payment.occurrenceDate)).toEqual([
      '2025-07-25',
      '2025-08-25',
      '2025-09-25',
      '2026-01-25',
      '2026-02-25',
      '2026-03-25',
      '2026-04-25',
      '2026-06-25',
    ]);
    const april = arrivals.find((row) => row.payment.occurrenceDate === '2026-04-25');
    // Arrived on 20 April, before the 2,100 began — but it is the 25 April
    // occurrence, so that occurrence's term is what it is set against (§30.9 item 4).
    expect(april?.payment).toMatchObject({ receivedOn: '2026-04-20', net: { amount: '2100', currency: 'EUR' }, gross: null });
    expect(april?.term.net).toEqual({ amount: '2100', currency: 'EUR' });
    expect(april?.term.effectiveFrom).toBe('2026-04-25');
    const march = arrivals.find((row) => row.payment.occurrenceDate === '2026-03-25');
    expect(march?.payment).toMatchObject({ receivedOn: '2026-04-02', gross: { amount: '2800', currency: 'EUR' } });
    expect(march?.term.net).toEqual({ amount: '2000', currency: 'EUR' });
  });
});

/* -------------------------------------------------------------------------- */
/* Occurrences by year                                                         */
/* -------------------------------------------------------------------------- */

describe('the occurrences of a year', () => {
  it('are received, skipped, missing in completed months, and not yet due from the current one', async () => {
    const { salary } = await fixture();
    const dto = await page(salary);
    expect(dto.year).toBe(2026);
    expect(stateOf(dto)).toEqual({
      '2026-01-25': 'received',
      '2026-02-25': 'received',
      '2026-03-25': 'received',
      '2026-04-25': 'received',
      '2026-05-25': 'skipped',
      '2026-06-25': 'received',
      '2026-07-25': 'missing',
      '2026-08-25': 'missing',
      '2026-09-25': 'missing',
      '2026-10-25': 'not_yet_due',
      '2026-11-25': 'not_yet_due',
      '2026-12-25': 'not_yet_due',
    });
  });

  it('keeps a payment with its occurrence, with the day it arrived', async () => {
    const { salary } = await fixture();
    const dto = await page(salary);
    const march = dto.occurrences.find((row) => row.occurrenceDate === '2026-03-25');
    expect(march?.state).toMatchObject({ kind: 'received', payment: { receivedOn: '2026-04-02' } });
    const june = dto.occurrences.find((row) => row.occurrenceDate === '2026-06-25');
    expect(june?.state).toMatchObject({ kind: 'received', payment: { receivedOn: '2026-05-30' } });
  });

  it('says why one was skipped', async () => {
    const { salary } = await fixture();
    const may = (await page(salary)).occurrences.find((row) => row.occurrenceDate === '2026-05-25');
    expect(may?.state).toEqual({ kind: 'skipped', reason: 'other', note: 'Unpaid leave' });
  });

  it('gives each one the term "Change the amount from…" opens with, as Monthly does', async () => {
    const { salary } = await fixture();
    const dto = await page(salary);
    const april = dto.occurrences.find((row) => row.occurrenceDate === '2026-04-25');
    expect(april?.term).toMatchObject({ net: { amount: '2100', currency: 'EUR' }, effectiveFrom: '2026-04-25', exact: { state: 'version', version: 1 } });
    const july = dto.occurrences.find((row) => row.occurrenceDate === '2026-07-25');
    expect(july?.term).toMatchObject({ net: { amount: '2100', currency: 'EUR' }, exact: { state: 'absent' } });
  });

  it('reports missing exactly what the year view reports for the source, in each year', async () => {
    const { salary } = await fixture();
    const thisYear = await page(salary, '2026');
    expect(missingOf(thisYear)).toEqual(await yearViewMissing(salary, '2026'));
    expect(missingOf(thisYear)).toEqual(['2026-07-25', '2026-08-25', '2026-09-25']);

    const lastYear = await page(salary, '2025');
    expect(stateOf(lastYear)).toEqual({
      '2025-07-25': 'received',
      '2025-08-25': 'received',
      '2025-09-25': 'received',
      '2025-10-25': 'skipped',
      '2025-11-25': 'missing',
      '2025-12-25': 'missing',
    });
    expect(missingOf(lastYear)).toEqual(await yearViewMissing(salary, '2025'));
  });

  it('still reports an archived source’s missing payments for the months its schedule covered', async () => {
    const { oldJob } = await fixture();
    const dto = await page(oldJob, '2025');
    expect(stateOf(dto)['2025-01-01']).toBe('received');
    expect(stateOf(dto)['2025-02-01']).toBe('skipped');
    expect(missingOf(dto)).toHaveLength(10);
    expect(missingOf(dto)).toEqual(await yearViewMissing(oldJob, '2025'));
    // Nothing after its end date, archived or not.
    expect((await page(oldJob, '2026')).occurrences).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Years                                                                       */
/* -------------------------------------------------------------------------- */

describe('the years in the address', () => {
  it('default to the current one and step between the source’s start year and it', async () => {
    const { salary } = await fixture();
    expect((await page(salary)).navigation).toEqual({ previous: 2025, next: null });
    expect((await page(salary, '2025')).navigation).toEqual({ previous: null, next: 2026 });
  });

  it('refuse a malformed year, one before the source started, and one that has not begun', async () => {
    const { salary } = await fixture();
    for (const year of ['26', '2026x', '1899', '2024', '2027']) {
      await expect(page(salary, year)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('are just the current one for a source that starts after it', async () => {
    const later = await source({ name: 'Pension', day: 1, start: '2027-03-01', amount: '500.00' });
    const dto = await page(later.id);
    expect(dto.year).toBe(2026);
    expect(dto.navigation).toEqual({ previous: null, next: null });
    expect(dto.occurrences).toEqual([]);
    expect(dto.source.completedOccurrenceDates).toEqual([]);
    await expect(page(later.id, '2025')).rejects.toBeInstanceOf(ValidationError);
  });
});

/* -------------------------------------------------------------------------- */
/* Not a source                                                                */
/* -------------------------------------------------------------------------- */

describe('an address that names no income source of this user', () => {
  it('is not found, whether malformed, missing, an expense, or another user’s', async () => {
    const { salary } = await fixture();
    const expense = await createTemplate(flows(), OCT_4, {
      kind: 'expense',
      name: 'Insurance',
      categoryId: insurance,
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 12,
      startDate: '2026-01-01',
      amount: '30.00',
    });
    for (const id of ['nope', `${salary}x`, '00000000-0000-4000-8000-000000000000', expense.template.id]) {
      await expect(page(id)).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(page(salary, undefined, on('2026-10-04', OTHER))).rejects.toBeInstanceOf(NotFoundError);
    // And the owner still reaches it.
    expect((await page(salary)).source.name).toBe('Salary');
  });
});

/* -------------------------------------------------------------------------- */
/* The read's bound                                                            */
/* -------------------------------------------------------------------------- */

/** Every `db.transaction` a read opens, as the year view's suite counts them. */
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

async function countTransactions(templateId: string, year?: string): Promise<number> {
  const counting = countingDatabase();
  await page(templateId, year, OCT_4, counting.db);
  return counting.transactions();
}

describe('the user’s rows are one snapshot', () => {
  it('reads them in one read-only transaction, beside the global catalogue, and takes no lock', async () => {
    const { salary } = await fixture();
    const sent = await record(() => page(salary));
    expect(perConnection(sent)).toEqual([
      ['begin', 'select currencies', 'commit'],
      [
        ...READ_OPEN,
        'select recurring_templates',
        'select recurring_template_terms',
        'select income_entries',
        'select recurring_template_skips',
        // The account's name.
        'select positions',
        'commit',
      ],
    ]);
    const every = sent.map(({ shape }) => shape);
    expect(every.filter(isLock)).toEqual([]);
    expect(every.filter(isWrite)).toEqual([]);
  });

  it('reads no account for a source that names none', async () => {
    const { oldJob } = await fixture();
    const sent = await record(() => page(oldJob, '2025'));
    expect(perConnection(sent)[1]).toEqual([
      ...READ_OPEN,
      'select recurring_templates',
      'select recurring_template_terms',
      'select income_entries',
      'select recurring_template_skips',
      'commit',
    ]);
  });
});

describe('the repository transaction count is bounded by a constant', () => {
  it('does not grow with the source’s years, terms, payments or skips', async () => {
    const bbva = await makeAccount('BBVA');
    const created = await source({ name: 'Pension', day: 5, start: '2026-08-01', amount: '10.00', account: bbva });
    const small = await countTransactions(created.id);
    expect(small).toBe(2);

    const long = await source({ name: 'Rent', day: 5, start: '2015-01-01', amount: '10.00', account: bbva });
    for (const year of ['2016', '2018', '2020', '2022', '2024']) {
      await accept(long.id, `${year}-03-05`);
      await skip(long.id, `${year}-04-05`);
      await setTemplateTerm(flows(), OCT_4, {
        templateId: long.id,
        effectiveFrom: `${year}-06-05`,
        amount: `${year}.00`,
        expected: { state: 'absent' },
      });
    }
    expect(await countTransactions(long.id)).toBe(small);
    expect(await countTransactions(long.id, '2016')).toBe(small);
  });
});
