import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createDatabase,
  createPool,
  insertExpenseEntry,
  insertTemplate,
  insertTerm,
  listExpenseEntriesByOccurrenceIn,
  sql,
  withUser,
  withoutUser,
  type Database,
} from '@vaultide/db';
import { consumptionCategoryKinds } from '@vaultide/validation';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { archiveUserCategory, createCategory, listCategories } from '../../src/users/categories';
import {
  createExpenseEntry,
  deleteExpenseEntry,
  updateExpenseEntry,
} from '../../src/flows/expenses';
import { createCashTransfer } from '../../src/flows/transfers';
import {
  archiveTemplate,
  createTemplate,
  setTemplateTerm,
  updateTemplateDetails,
} from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion, unskipSuggestion } from '../../src/recurring/suggestions';
import { createFxService } from '../../src/fx/service';
import { DuplicateConflictError, ValidationError } from '../../src/errors';
import { parseMonth } from '../../src/reconciliation/service';
import { getMonthlyPage, type MonthlyDependencies } from '../../src/monthly/service';
import {
  loadCompletedMonthExpenses,
  loadCurrentMonthExpenses,
} from '../../src/monthly/expenses-loader';
import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  ExpenseOccurrenceDto,
  MonthlyExpensesDto,
} from '../../src/monthly/types';

/**
 * Monthly's Known-expenses section against a real database (blueprint 6.2,
 * 7.4, 12.6, 15.3 section 3, 20.3, 23.2, v2.1.6 §30.9, v2.1.7 §30.10).
 *
 * September 2026 is the completed month, read on 1 October; the current-month
 * cases sit on 10 September unless they say otherwise. What is pinned:
 *
 *  - **one expense, rendered once**, whichever of its two dates the displayed
 *    month holds — and editable only from the month holding its money;
 *  - **schedule truth**: which occurrences a month has, which term prices each,
 *    what "Paid today" may reach, and what an end date changes;
 *  - **what the section offers**: the Phase 3 category picker and the rows it
 *    shows without offering to change;
 *  - **the read's cost**: exactly one scope more than the page had, constant in
 *    the amount of data, with no second financial-date read of expenses.
 */

const USER_A = '56565656-5656-4565-8565-565656565656';
const USER_B = '78787878-7878-4787-8787-787878787878';

let harness: Harness;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
const NOV_1 = on('2026-11-01');
const SEPT_10 = on('2026-09-10');
const SEPT_30 = on('2026-09-30');
const AUGUST = parseMonth('2026-08');
const SEPTEMBER = parseMonth('2026-09');
const OCTOBER = parseMonth('2026-10');

const flowDeps = () => harness.services.flows;
const readDeps = (): MonthlyDependencies => ({ db: harness.db, fx: harness.services.fx });

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function categoryId(match: { name?: string; kind?: string }, userId = USER_A): Promise<string> {
  const rows = await listCategories(harness.db, userId, { includeArchived: true });
  const found = rows.find(
    (row) =>
      (match.name === undefined || row.name === match.name) &&
      (match.kind === undefined || row.kind === match.kind),
  );
  if (found === undefined) throw new Error(`no category ${JSON.stringify(match)}`);
  return found.id;
}

let groceries: string;
let subscriptions: string;

async function makeAccount(
  name: string,
  options: { currency?: string; ctx?: RequestContext; userId?: string } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, options.ctx ?? OCT_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  return created.id;
}

const statement = (positionId: string, valuedOn: string, amount: string, ctx = OCT_1): Promise<unknown> =>
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

interface SourceOptions {
  readonly name?: string;
  readonly categoryId?: string;
  readonly currency?: string;
  readonly frequency?: 'monthly' | 'annual';
  readonly dayOfMonth?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly amount?: string;
  readonly cashPositionId?: string;
  readonly ctx?: RequestContext;
}

async function expenseSource(options: SourceOptions = {}) {
  const created = await createTemplate(flowDeps(), options.ctx ?? OCT_1, {
    kind: 'expense',
    name: options.name ?? 'Gym',
    categoryId: options.categoryId ?? subscriptions,
    currency: options.currency ?? 'EUR',
    frequency: options.frequency ?? 'monthly',
    dayOfMonth: options.dayOfMonth ?? 15,
    startDate: options.startDate ?? '2026-01-01',
    ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
    ...(options.cashPositionId === undefined ? {} : { cashPositionId: options.cashPositionId }),
    amount: options.amount ?? '40.00',
  });
  return created.template;
}

interface ExpenseOptions {
  readonly categoryId?: string;
  readonly incurredOn: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly settlement?: 'tracked_cash' | 'untracked_self' | 'third_party';
  readonly cashPositionId?: string | null;
  readonly description?: string;
  readonly isOneOff?: boolean;
}

const expense = (ctx: RequestContext, options: ExpenseOptions) =>
  createExpenseEntry(flowDeps(), ctx, {
    categoryId: options.categoryId ?? groceries,
    incurredOn: options.incurredOn,
    amount: options.amount ?? '25.00',
    currency: options.currency ?? 'EUR',
    settlement: options.settlement ?? 'tracked_cash',
    cashPositionId: options.cashPositionId ?? null,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.isOneOff === undefined ? {} : { isOneOff: options.isOneOff }),
  });

async function completed(ctx: RequestContext = OCT_1, month = SEPTEMBER): Promise<CompletedMonthlyPageDto> {
  const page = await getMonthlyPage(readDeps(), ctx, month);
  if (page.kind !== 'completed') throw new Error('expected a completed month');
  return page;
}

async function current(ctx: RequestContext = SEPT_10, month = SEPTEMBER): Promise<CurrentMonthlyPageDto> {
  const page = await getMonthlyPage(readDeps(), ctx, month);
  if (page.kind !== 'current') throw new Error('expected the current month');
  return page;
}

const currentOctober = (): Promise<CurrentMonthlyPageDto> => current(OCT_1, OCTOBER);
const completedOctober = (): Promise<CompletedMonthlyPageDto> => completed(NOV_1, OCTOBER);

function occurrenceOf(
  expenses: MonthlyExpensesDto,
  templateId: string,
  occurrenceDate: string,
): ExpenseOccurrenceDto {
  const found = expenses.occurrences.find(
    (row) => row.templateId === templateId && row.occurrenceDate === occurrenceDate,
  );
  if (found === undefined) {
    throw new Error(
      `no occurrence ${occurrenceDate} for ${templateId}; page has ${expenses.occurrences
        .map((row) => `${row.templateId}@${row.occurrenceDate}`)
        .join(', ')}`,
    );
  }
  return found;
}

/**
 * Every expense a section renders, once each — the multiset, so a duplicate
 * shows up as a repeated id rather than as two assertions that each pass.
 */
function renderedEntryIds(expenses: MonthlyExpensesDto): string[] {
  return [
    ...expenses.occurrences.flatMap((row) =>
      row.state.kind === 'accepted' ? [row.state.entry.entryId] : [],
    ),
    ...expenses.otherRecurring.map((row) => row.entryId),
    ...expenses.direct.map((row) => row.entryId),
  ];
}

function eurTotals(page: CompletedMonthlyPageDto) {
  const bucket = page.reconciliation.buckets.find((row) => row.currency === 'EUR');
  if (bucket === undefined) throw new Error('no EUR bucket');
  return bucket.totals;
}

const eur = (amount: string) => ({ amount, currency: 'EUR' });

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'known-expenses-a@example.test'],
    [USER_B, 'known-expenses-b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
  groceries = await categoryId({ name: 'Groceries' });
  subscriptions = await categoryId({ name: 'Subscriptions' });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM month_reviews');
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
});

/* -------------------------------------------------------------------------- */
/* One expense, rendered once                                                  */
/* -------------------------------------------------------------------------- */

describe('the section lists a month’s own schedule and spending', () => {
  it('lists a direct expense incurred in the month once, with its evidence', async () => {
    const bbva = await makeAccount('BBVA');
    const created = await expense(OCT_1, {
      incurredOn: '2026-09-14',
      amount: '62.40',
      cashPositionId: bbva,
      description: 'Market',
    });

    const page = await completed();
    expect(renderedEntryIds(page.expenses)).toEqual([created.id]);
    expect(page.expenses.direct[0]).toEqual({
      entryId: created.id,
      version: created.version,
      category: {
        categoryId: groceries,
        name: 'Groceries',
        kind: 'food',
        use: 'spending',
        archived: false,
        selectable: true,
      },
      settlement: 'tracked_cash',
      incurredOn: '2026-09-14',
      incurredMonth: '2026-09',
      amount: eur('62.4'),
      currency: 'EUR',
      cashPositionId: bbva,
      cashAccountName: 'BBVA',
      description: 'Market',
      isOneOff: false,
      readOnly: null,
      occurrence: null,
    });
    expect(page.expenses.occurrences).toHaveLength(0);
    expect(page.expenses.otherRecurring).toHaveLength(0);
    // A completed month has no early-payment surface: nothing in it is ahead.
    expect('paidTodayCandidates' in page.expenses).toBe(false);
  });

  it('lists what the user paid outside tracked accounts and what somebody else paid, as the facts they are', async () => {
    await makeAccount('BBVA');
    const self = await expense(OCT_1, { incurredOn: '2026-09-05', settlement: 'untracked_self' });
    const partner = await expense(OCT_1, { incurredOn: '2026-09-06', settlement: 'third_party' });
    const unattributed = await expense(OCT_1, { incurredOn: '2026-09-07', cashPositionId: null });

    const direct = (await completed()).expenses.direct;
    expect(direct.map((row) => [row.entryId, row.settlement, row.cashPositionId])).toEqual([
      [self.id, 'untracked_self', null],
      [partner.id, 'third_party', null],
      // 8.1: a null leg is tracked cash awaiting attribution, never untracked.
      [unattributed.id, 'tracked_cash', null],
    ]);
  });

  it('embeds the entry of an accepted occurrence and never lists it twice', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
    });

    const page = await completed();
    const occurrence = occurrenceOf(page.expenses, source.id, '2026-09-15');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry).toMatchObject({
      entryId: accepted.entry.id,
      version: accepted.entry.version,
      settlement: 'tracked_cash',
      incurredOn: '2026-09-15',
      incurredMonth: '2026-09',
      amount: eur('40'),
      cashPositionId: bbva,
      readOnly: null,
      occurrence: {
        templateId: source.id,
        templateName: 'Gym',
        occurrenceDate: '2026-09-15',
        occurrenceMonth: '2026-09',
      },
    });
    expect(occurrence.recordableAsExpected).toBe(true);
    expect(renderedEntryIds(page.expenses)).toEqual([accepted.entry.id]);
    expect(page.expenses.otherRecurring).toHaveLength(0);
    expect(page.expenses.direct).toHaveLength(0);
  });

  it('describes a due occurrence with the source metadata its controls need', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva, startDate: '2026-07-01' });

    const occurrence = occurrenceOf((await completed()).expenses, source.id, '2026-09-15');
    expect(occurrence.state).toEqual({ kind: 'due' });
    expect(occurrence.term).toEqual({
      amount: eur('40'),
      effectiveFrom: '2026-07-01',
      exact: { state: 'absent' },
    });
    expect(occurrence.source).toEqual({
      templateId: source.id,
      version: source.version,
      name: 'Gym',
      counterparty: null,
      currency: 'EUR',
      category: expect.objectContaining({ categoryId: subscriptions, use: 'spending' }),
      startDate: '2026-07-01',
      endDate: null,
      archived: false,
      defaultCashPositionId: bbva,
      defaultCashAccountName: 'BBVA',
      completedOccurrenceDates: ['2026-07-15', '2026-08-15', '2026-09-15'],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Two dates, two months                                                       */
/* -------------------------------------------------------------------------- */

describe('an occurrence whose two dates fall in different months', () => {
  /** Scheduled 15 September, actually paid on 1 October. */
  async function paidLate() {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
      financialDate: '2026-10-01',
    });
    return { source, entryId: accepted.entry.id };
  }

  it('shows September’s schedule answered, owned by October', async () => {
    const { source, entryId } = await paidLate();

    const page = await completed();
    const occurrence = occurrenceOf(page.expenses, source.id, '2026-09-15');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    // Recorded for September's schedule; the month holding the money owns it.
    expect(occurrence.state.entry).toMatchObject({
      entryId,
      incurredOn: '2026-10-01',
      incurredMonth: '2026-10',
    });
    expect(renderedEntryIds(page.expenses)).toEqual([entryId]);
    expect(page.expenses.otherRecurring).toHaveLength(0);
    expect(page.expenses.direct).toHaveLength(0);
  });

  it('lists the same row in October as recurring spending for September’s occurrence', async () => {
    const { source, entryId } = await paidLate();

    const page = await currentOctober();
    expect(renderedEntryIds(page.expenses)).toEqual([entryId]);
    expect(page.expenses.otherRecurring[0]).toMatchObject({
      entryId,
      incurredOn: '2026-10-01',
      incurredMonth: '2026-10',
      occurrence: { templateId: source.id, occurrenceDate: '2026-09-15', occurrenceMonth: '2026-09' },
    });
  });

  it('counts it financially in October and never in September', async () => {
    await paidLate();
    expect(eurTotals(await completed()).knownTrackedExpenses).toEqual(eur('0'));
    expect(eurTotals(await completedOctober()).knownTrackedExpenses).toEqual(eur('40'));
  });

  /** Scheduled 1 October, paid early on 30 September through "Paid today". */
  async function paidEarly() {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_30 });
    const source = await expenseSource({ dayOfMonth: 1, cashPositionId: bbva, ctx: SEPT_30 });
    const accepted = await acceptSuggestion(flowDeps(), SEPT_30, {
      templateId: source.id,
      occurrenceDate: '2026-10-01',
      receivedToday: true,
    });
    return { source, entryId: accepted.entry.id };
  }

  it('lets September own an early payment while its own occurrence stays open', async () => {
    const { source, entryId } = await paidEarly();

    const page = await completed();
    expect(renderedEntryIds(page.expenses)).toEqual([entryId]);
    expect(page.expenses.otherRecurring[0]).toMatchObject({
      entryId,
      incurredOn: '2026-09-30',
      incurredMonth: '2026-09',
      occurrence: { occurrenceDate: '2026-10-01', occurrenceMonth: '2026-10' },
    });
    // 1 September is a different occurrence, and nothing answered it.
    expect(occurrenceOf(page.expenses, source.id, '2026-09-01').state).toEqual({ kind: 'due' });
  });

  it('shows October’s occurrence fulfilled, never offered again', async () => {
    const { source, entryId } = await paidEarly();

    const page = await currentOctober();
    const occurrence = occurrenceOf(page.expenses, source.id, '2026-10-01');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry).toMatchObject({ entryId, incurredMonth: '2026-09' });
    // The early payment moved "Paid today" on to the next occurrence.
    expect(page.expenses.paidTodayCandidates.map((row) => row.occurrenceDate)).toEqual(['2026-11-01']);
    await expect(
      acceptSuggestion(flowDeps(), OCT_1, { templateId: source.id, occurrenceDate: '2026-10-01' }),
    ).rejects.toBeInstanceOf(DuplicateConflictError);
  });

  it('counts an early payment financially in September and never in October', async () => {
    await paidEarly();
    expect(eurTotals(await completed()).knownTrackedExpenses).toEqual(eur('40'));
    expect(eurTotals(await completedOctober()).knownTrackedExpenses).toEqual(eur('0'));
  });

  it('prices an occurrence by its scheduled date, never by the day it was paid', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_30 });
    const source = await expenseSource({ dayOfMonth: 1, cashPositionId: bbva, ctx: SEPT_30 });
    await setTemplateTerm(flowDeps(), SEPT_30, {
      templateId: source.id,
      effectiveFrom: '2026-10-01',
      amount: '45.00',
      expected: { state: 'absent' },
    });
    const accepted = await acceptSuggestion(flowDeps(), SEPT_30, {
      templateId: source.id,
      occurrenceDate: '2026-10-01',
      receivedToday: true,
    });

    // Paid in September at October's term, because the occurrence is October's.
    if (accepted.kind !== 'expense') throw new Error('expected an expense');
    expect(accepted.entry.amount).toBe('45.00000000');
    const october = occurrenceOf((await currentOctober()).expenses, source.id, '2026-10-01');
    expect(october.term).toMatchObject({ amount: eur('45'), effectiveFrom: '2026-10-01' });
    expect(occurrenceOf((await completed()).expenses, source.id, '2026-09-01').term.amount).toEqual(
      eur('40'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Archived sources                                                            */
/* -------------------------------------------------------------------------- */

describe('an archived expense source', () => {
  it('keeps a completed month’s occurrence as schedule truth, marked archived', async () => {
    const source = await expenseSource();
    await archiveTemplate(flowDeps(), OCT_1, { templateId: source.id, expectedVersion: source.version });

    const occurrence = occurrenceOf((await completed()).expenses, source.id, '2026-09-15');
    expect(occurrence.state).toEqual({ kind: 'due' });
    expect(occurrence.source.archived).toBe(true);
  });

  it('offers the live month nothing new, and keeps what it already resolved', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const resolved = await expenseSource({ name: 'Paid', dayOfMonth: 5, cashPositionId: bbva, ctx: SEPT_10 });
    const accepted = await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: resolved.id,
      occurrenceDate: '2026-09-05',
    });
    const open = await expenseSource({ name: 'Open', dayOfMonth: 20, ctx: SEPT_10 });
    for (const template of [resolved, open]) {
      await archiveTemplate(flowDeps(), SEPT_10, {
        templateId: template.id,
        expectedVersion: template.version,
      });
    }

    const page = await current();
    expect(page.expenses.occurrences.map((row) => [row.templateId, row.state.kind])).toEqual([
      [resolved.id, 'accepted'],
    ]);
    expect(occurrenceOf(page.expenses, resolved.id, '2026-09-05').source.archived).toBe(true);
    expect(renderedEntryIds(page.expenses)).toEqual([accepted.entry.id]);
    expect(page.expenses.paidTodayCandidates).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Paid today                                                                  */
/* -------------------------------------------------------------------------- */

describe('what “Paid today” may reach', () => {
  it('is the earliest unresolved future occurrence, flagged in place when it is this month’s', async () => {
    const source = await expenseSource({ ctx: SEPT_10 });
    const annual = await expenseSource({
      name: 'Insurance',
      frequency: 'annual',
      dayOfMonth: 1,
      startDate: '2026-12-01',
      amount: '300.00',
      ctx: SEPT_10,
    });

    const page = await current();
    expect(occurrenceOf(page.expenses, source.id, '2026-09-15').state).toEqual({
      kind: 'upcoming',
      paidTodayEligible: true,
    });
    // One candidate per source, and only beyond the month.
    expect(page.expenses.paidTodayCandidates).toHaveLength(1);
    expect(page.expenses.paidTodayCandidates[0]).toMatchObject({
      templateId: annual.id,
      occurrenceDate: '2026-12-01',
      occurrenceMonth: '2026-12',
      source: { name: 'Insurance' },
      term: { amount: eur('300') },
      recordableAsExpected: true,
    });
  });

  it('is held back by an earlier unresolved future occurrence', async () => {
    const source = await expenseSource({ ctx: SEPT_10 });

    let page = await current();
    expect(page.expenses.paidTodayCandidates).toHaveLength(0);
    // The service holds the same line under the template's lock.
    await expect(
      acceptSuggestion(flowDeps(), SEPT_10, {
        templateId: source.id,
        occurrenceDate: '2026-10-15',
        receivedToday: true,
        amount: '40.00',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await skipSuggestion(flowDeps(), SEPT_10, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
      reason: 'skipped',
    });
    page = await current();
    expect(page.expenses.paidTodayCandidates.map((row) => row.occurrenceDate)).toEqual(['2026-10-15']);
  });

  it('is not held back by an unresolved occurrence that has already passed', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const source = await expenseSource({
      dayOfMonth: 5,
      startDate: '2026-08-01',
      cashPositionId: bbva,
      ctx: SEPT_10,
    });

    const page = await current();
    // 5 August and 5 September are both still open, and neither blocks October.
    expect(occurrenceOf(page.expenses, source.id, '2026-09-05').state).toEqual({ kind: 'due' });
    expect(page.expenses.paidTodayCandidates.map((row) => row.occurrenceDate)).toEqual(['2026-10-05']);
    const paid = await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: source.id,
      occurrenceDate: '2026-10-05',
      receivedToday: true,
    });
    expect(paid.entry).toMatchObject({ occurrenceDate: '2026-10-05', incurredOn: '2026-09-10' });
  });

  it('has no horizon, and prices a far occurrence by the term in force then', async () => {
    const source = await expenseSource({
      name: 'Domain renewal',
      frequency: 'annual',
      dayOfMonth: 15,
      startDate: '2026-06-15',
      amount: '60.00',
      ctx: SEPT_10,
    });
    await setTemplateTerm(flowDeps(), SEPT_10, {
      templateId: source.id,
      effectiveFrom: '2027-01-01',
      amount: '70.00',
      expected: { state: 'absent' },
    });

    const [candidate] = (await current()).expenses.paidTodayCandidates;
    expect(candidate).toMatchObject({
      templateId: source.id,
      occurrenceDate: '2027-06-15',
      occurrenceMonth: '2027-06',
      term: { amount: eur('70'), effectiveFrom: '2027-01-01' },
    });
  });

  it('keeps two sources sharing a scheduled date independent', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const first = await expenseSource({ name: 'Alpha', cashPositionId: bbva, ctx: SEPT_10 });
    const second = await expenseSource({ name: 'Beta', cashPositionId: bbva, ctx: SEPT_10 });
    await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: first.id,
      occurrenceDate: '2026-09-15',
      receivedToday: true,
    });

    const page = await current();
    expect(occurrenceOf(page.expenses, first.id, '2026-09-15').state.kind).toBe('accepted');
    expect(occurrenceOf(page.expenses, second.id, '2026-09-15').state).toEqual({
      kind: 'upcoming',
      paidTodayEligible: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Zero terms and default accounts                                             */
/* -------------------------------------------------------------------------- */

describe('an occurrence whose term cannot become an expense as it stands', () => {
  it('shows a zero term as zero, and needs an amount or a skip to resolve', async () => {
    await makeAccount('BBVA');
    const zero = await expenseSource({ name: 'Parking', dayOfMonth: 5, amount: '0.00' });
    const nothing = await expenseSource({ name: 'Car wash', dayOfMonth: 6, amount: '0.00' });

    const page = await completed();
    const occurrence = occurrenceOf(page.expenses, zero.id, '2026-09-05');
    // Zero is a real amount, not an absent one — and not one an expense can have.
    expect(occurrence.term.amount).toEqual(eur('0'));
    expect(occurrence.recordableAsExpected).toBe(false);
    expect(occurrence.state).toEqual({ kind: 'due' });

    await expect(
      acceptSuggestion(flowDeps(), OCT_1, { templateId: zero.id, occurrenceDate: '2026-09-05' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const adjusted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: zero.id,
      occurrenceDate: '2026-09-05',
      amount: '12.50',
    });
    if (adjusted.kind !== 'expense') throw new Error('expected an expense');
    expect(adjusted.entry.amount).toBe('12.50000000');

    await skipSuggestion(flowDeps(), OCT_1, {
      templateId: nothing.id,
      occurrenceDate: '2026-09-06',
      reason: 'skipped',
    });
    const after = await completed();
    expect(occurrenceOf(after.expenses, zero.id, '2026-09-05').state.kind).toBe('accepted');
    expect(occurrenceOf(after.expenses, nothing.id, '2026-09-06').state).toMatchObject({
      kind: 'skipped',
      reason: 'skipped',
    });
  });

  it('records a source with no default account through any participating account of its currency', async () => {
    await makeAccount('BBVA');
    const water = await expenseSource({ name: 'Water' });
    const storage = await expenseSource({ name: 'US storage', currency: 'USD' });

    const page = await completed();
    expect(occurrenceOf(page.expenses, water.id, '2026-09-15').source.defaultCashPositionId).toBeNull();

    const recorded = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: water.id,
      occurrenceDate: '2026-09-15',
    });
    // Tracked cash awaiting attribution — never untracked (§30.9 item 1).
    expect(recorded.entry).toMatchObject({ settlement: 'tracked_cash', cashPositionId: null });

    // No dollar account took part in September, so there is nothing to reconcile it against.
    await expect(
      acceptSuggestion(flowDeps(), OCT_1, { templateId: storage.id, occurrenceDate: '2026-09-15' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(occurrenceOf((await completed()).expenses, storage.id, '2026-09-15').state).toEqual({
      kind: 'due',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Categories and the rows the section does not change                         */
/* -------------------------------------------------------------------------- */

describe('the categories Known expenses offers', () => {
  it('are every live consumption category and money out of tracked accounts, and no other kind', async () => {
    const page = await completed();
    const eligible = page.expenses.eligibleCategories;
    const kinds = eligible.map((row) => row.kind);

    for (const excluded of [
      'property_operating',
      'investment_fee',
      'transfer_fee',
      'acquisition_cost',
      'disposal_cost',
      'capital_improvement',
    ]) {
      expect(kinds).not.toContain(excluded);
    }

    const all = await listCategories(harness.db, USER_A, { includeArchived: true });
    const liveConsumption = all
      .filter((row) => !row.archived && (consumptionCategoryKinds as readonly string[]).includes(row.kind))
      .map((row) => row.id)
      .sort();
    expect(eligible.filter((row) => row.use === 'spending').map((row) => row.categoryId).sort()).toEqual(
      liveConsumption,
    );
    expect(eligible.filter((row) => row.use === 'money_out')).toEqual([
      {
        categoryId: await categoryId({ kind: 'external_outflow' }),
        name: 'Money out of tracked accounts',
        kind: 'external_outflow',
        use: 'money_out',
        archived: false,
        selectable: true,
      },
    ]);
    expect(eligible.every((row) => row.selectable && !row.archived)).toBe(true);
  });

  it('classifies an external outflow as money out, editable like any other row', async () => {
    const bbva = await makeAccount('BBVA');
    const row = await expense(OCT_1, {
      categoryId: await categoryId({ kind: 'external_outflow' }),
      incurredOn: '2026-09-09',
      cashPositionId: bbva,
    });

    expect((await completed()).expenses.direct[0]).toMatchObject({
      entryId: row.id,
      category: { kind: 'external_outflow', use: 'money_out', selectable: true },
      readOnly: null,
    });
  });

  it('keeps an archived category on the rows filed under it, and offers it for nothing new', async () => {
    const custom = await createCategory(harness.db, USER_A, {
      kind: 'general',
      name: `Old club ${String(Date.now())}`,
    });
    const row = await expense(OCT_1, {
      categoryId: custom.id,
      incurredOn: '2026-09-03',
      settlement: 'untracked_self',
    });
    await archiveUserCategory(harness.db, USER_A, custom.id);

    const page = await completed();
    expect(page.expenses.direct[0]).toMatchObject({
      entryId: row.id,
      category: { categoryId: custom.id, name: custom.name, archived: true, selectable: false, use: 'spending' },
      readOnly: null,
    });
    expect(page.expenses.eligibleCategories.map((category) => category.categoryId)).not.toContain(custom.id);
  });

  it('shows a transfer’s fee as part of its transfer, and nothing to change here', async () => {
    const from = await makeAccount('BBVA');
    const to = await makeAccount('Savings');
    const transfer = await createCashTransfer(flowDeps(), OCT_1, {
      occurredOn: '2026-09-07',
      fromPositionId: from,
      toPositionId: to,
      fromAmount: '300.00',
      toAmount: '300.00',
      fee: {
        amount: '5.00',
        categoryId: await categoryId({ kind: 'transfer_fee' }),
        cashPositionId: from,
        currency: 'EUR',
      },
    });

    expect((await completed()).expenses.direct).toEqual([
      expect.objectContaining({
        entryId: transfer.fee?.id,
        amount: eur('5'),
        readOnly: 'transfer_fee',
        category: expect.objectContaining({ kind: 'transfer_fee', use: 'other', selectable: false }),
      }),
    ]);
  });

  it('shows a direct row another workflow files as recorded, while a scheduled one keeps its correction', async () => {
    const bbva = await makeAccount('BBVA');
    const propertyCosts = await categoryId({ kind: 'property_operating' });
    const direct = await expense(OCT_1, {
      categoryId: propertyCosts,
      incurredOn: '2026-09-04',
      cashPositionId: bbva,
    });
    const source = await expenseSource({ name: 'Community fee', categoryId: propertyCosts, cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
    });

    const page = await completed();
    // Nothing on this section could reclassify it back, so it is not offered for editing.
    expect(page.expenses.direct).toEqual([
      expect.objectContaining({ entryId: direct.id, readOnly: 'other_workflow' }),
    ]);
    // A source's occurrence has its source's category and no picker at all: its
    // amount, date, account and note stay correctable.
    const occurrence = occurrenceOf(page.expenses, source.id, '2026-09-15');
    expect(occurrence.state).toMatchObject({
      kind: 'accepted',
      entry: { entryId: accepted.entry.id, readOnly: null },
    });
  });

  it('lists no capital improvement, while every figure still counts it', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '500.00');
    const capital = await categoryId({ kind: 'capital_improvement' });
    // Phase 3's services refuse this row — there is no asset to link it to — but
    // imported or later-phase data can hold one, so it is written below the
    // domain, the way such data arrives.
    const legacy = await insertExpenseEntry(harness.db, { userId: USER_A }, {
      categoryId: capital,
      incurredOn: '2026-09-12',
      amount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    const works = await insertTemplate(harness.db, { userId: USER_A }, {
      kind: 'expense',
      name: 'Extension works',
      categoryId: capital,
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 20,
      startDate: '2026-01-01',
    });
    await insertTerm(harness.db, { userId: USER_A }, {
      templateId: works.id,
      effectiveFrom: '2026-01-01',
      amount: '100.00',
    });

    const page = await completed();
    expect(renderedEntryIds(page.expenses)).not.toContain(legacy.id);
    expect(page.expenses.occurrences.map((row) => row.templateId)).not.toContain(works.id);
    // Capital allocation (`Nout`), in the reconciliation that owns it (7.4).
    expect(eurTotals(page).nonExpenseOutflows).toEqual(eur('500'));
    expect(eurTotals(page).knownTrackedExpenses).toEqual(eur('0'));
  });
});

/* -------------------------------------------------------------------------- */
/* The current month                                                           */
/* -------------------------------------------------------------------------- */

describe('the current month’s known expenses', () => {
  it('run through today, while reconciliation stays through its own date', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    await statement(bbva, '2026-08-31', '1000.00', SEPT_10);
    await snapshot(bbva, '2026-09-06', '900.00');
    const before = await expense(SEPT_10, { incurredOn: '2026-09-04', amount: '30.00', cashPositionId: bbva });
    const after = await expense(SEPT_10, { incurredOn: '2026-09-08', amount: '25.00', cashPositionId: bbva });

    const page = await current();
    expect(page.monthToDate.asOf).toBe('2026-09-06');
    // Both expenses exist, and both are listed…
    expect(page.expenses.direct.map((row) => row.entryId)).toEqual([before.id, after.id]);
    // …while the figure labelled "through 6 September" holds only the one before it.
    const bucket = page.monthToDate.buckets?.find((row) => row.currency === 'EUR');
    expect(bucket?.totals.knownTrackedExpenses).toEqual(eur('30'));
  });
});

/* -------------------------------------------------------------------------- */
/* A source's end date                                                         */
/* -------------------------------------------------------------------------- */

describe('ending an expense source', () => {
  it('can be set, changed and cleared, and the schedule follows each time', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva, startDate: '2026-07-01' });

    const ended = await updateTemplateDetails(flowDeps(), OCT_1, {
      templateId: source.id,
      expectedVersion: source.version,
      endDate: '2026-09-30',
    });
    let october = await currentOctober();
    expect(october.expenses.occurrences.map((row) => row.templateId)).not.toContain(source.id);
    expect(october.expenses.paidTodayCandidates).toHaveLength(0);
    expect(occurrenceOf((await completed()).expenses, source.id, '2026-09-15').source).toMatchObject({
      version: ended.version,
      endDate: '2026-09-30',
    });

    const later = await updateTemplateDetails(flowDeps(), OCT_1, {
      templateId: source.id,
      expectedVersion: ended.version,
      endDate: '2026-10-31',
    });
    october = await currentOctober();
    expect(occurrenceOf(october.expenses, source.id, '2026-10-15').state).toEqual({
      kind: 'upcoming',
      paidTodayEligible: true,
    });

    // October's occurrence paid early: with the schedule ending on 31 October,
    // nothing is left for "Paid today" to reach.
    await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-10-15',
      receivedToday: true,
    });
    expect((await currentOctober()).expenses.paidTodayCandidates).toHaveLength(0);

    const cleared = await updateTemplateDetails(flowDeps(), OCT_1, {
      templateId: source.id,
      expectedVersion: later.version,
      endDate: null,
    });
    expect(cleared.endDate).toBeNull();
    october = await currentOctober();
    expect(occurrenceOf(october.expenses, source.id, '2026-10-15').source).toMatchObject({
      endDate: null,
      version: cleared.version,
    });
    // Without an end, the schedule goes on, and November is next.
    expect(october.expenses.paidTodayCandidates.map((row) => row.occurrenceDate)).toEqual(['2026-11-15']);
  });

  it('refuses to end before an occurrence already recorded, or already skipped, and changes neither', async () => {
    const bbva = await makeAccount('BBVA');
    const recorded = await expenseSource({ name: 'Recorded', cashPositionId: bbva });
    await acceptSuggestion(flowDeps(), OCT_1, { templateId: recorded.id, occurrenceDate: '2026-09-15' });
    const skipped = await expenseSource({ name: 'Skipped' });
    await skipSuggestion(flowDeps(), OCT_1, {
      templateId: skipped.id,
      occurrenceDate: '2026-09-15',
      reason: 'other',
    });

    await expect(
      updateTemplateDetails(flowDeps(), OCT_1, {
        templateId: recorded.id,
        expectedVersion: recorded.version,
        endDate: '2026-09-10',
      }),
    ).rejects.toThrow(/already recorded or skipped/u);
    await expect(
      updateTemplateDetails(flowDeps(), OCT_1, {
        templateId: skipped.id,
        expectedVersion: skipped.version,
        endDate: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const page = await completed();
    expect(occurrenceOf(page.expenses, recorded.id, '2026-09-15').state.kind).toBe('accepted');
    expect(occurrenceOf(page.expenses, skipped.id, '2026-09-15').state.kind).toBe('skipped');
    expect(occurrenceOf(page.expenses, recorded.id, '2026-09-15').source.endDate).toBeNull();
  });

  it('takes an unresolved occurrence out of a completed month’s schedule and completeness', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    const source = await expenseSource({ dayOfMonth: 5, startDate: '2026-09-01' });

    const before = await completed();
    expect(occurrenceOf(before.expenses, source.id, '2026-09-05').state).toEqual({ kind: 'due' });

    await updateTemplateDetails(flowDeps(), OCT_1, {
      templateId: source.id,
      expectedVersion: source.version,
      endDate: '2026-09-04',
    });

    const after = await completed();
    expect(after.expenses.occurrences.filter((row) => row.templateId === source.id)).toHaveLength(0);
    expect(after.completeness.required).toBe(before.completeness.required - 1);
    expect(after.completeness.satisfied).toBe(before.completeness.satisfied);
  });

  it('names a stale change as a conflict, in words that fit any kind of source', async () => {
    const source = await expenseSource();
    await updateTemplateDetails(flowDeps(), OCT_1, {
      templateId: source.id,
      expectedVersion: source.version,
      endDate: '2026-12-31',
    });

    await expect(
      updateTemplateDetails(flowDeps(), OCT_1, {
        templateId: source.id,
        expectedVersion: source.version,
        endDate: '2027-01-31',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT_VERSION',
      message: 'This source changed while you were editing it.',
    });
  });

  it('carries every completed-month date of the schedule, as though it had never ended', async () => {
    const source = await expenseSource({ startDate: '2026-07-01', endDate: '2026-08-31' });

    // Its last occurrence is August's; the dates an end-date change is measured
    // against run past the end it has, through the last completed month.
    const occurrence = occurrenceOf((await completed(OCT_1, AUGUST)).expenses, source.id, '2026-08-15');
    expect(occurrence.source.completedOccurrenceDates).toEqual(['2026-07-15', '2026-08-15', '2026-09-15']);
  });
});

/* -------------------------------------------------------------------------- */
/* Corrections and deletions                                                   */
/* -------------------------------------------------------------------------- */

describe('corrections through the existing services', () => {
  it('keeps the one-off flag through creation and correction', async () => {
    const created = await expense(OCT_1, {
      incurredOn: '2026-09-20',
      settlement: 'untracked_self',
      isOneOff: true,
    });
    expect((await completed()).expenses.direct[0]?.isOneOff).toBe(true);

    const corrected = await updateExpenseEntry(flowDeps(), OCT_1, {
      entryId: created.id,
      expectedVersion: created.version,
      amount: '30.00',
    });
    expect((await completed()).expenses.direct[0]).toMatchObject({
      isOneOff: true,
      amount: eur('30'),
      version: corrected.version,
    });

    await updateExpenseEntry(flowDeps(), OCT_1, {
      entryId: created.id,
      expectedVersion: corrected.version,
      isOneOff: false,
    });
    expect((await completed()).expenses.direct[0]?.isOneOff).toBe(false);
  });

  it('removes a deleted direct expense from the section', async () => {
    const created = await expense(OCT_1, { incurredOn: '2026-09-20', settlement: 'third_party' });
    await deleteExpenseEntry(flowDeps(), OCT_1, { entryId: created.id });
    expect(renderedEntryIds((await completed()).expenses)).toEqual([]);
  });

  it('makes an occurrence due again when its expense is deleted, and restores a skip to due', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
    });
    await deleteExpenseEntry(flowDeps(), OCT_1, { entryId: accepted.entry.id });

    let page = await completed();
    expect(occurrenceOf(page.expenses, source.id, '2026-09-15').state).toEqual({ kind: 'due' });
    expect(renderedEntryIds(page.expenses)).toEqual([]);

    const skip = await skipSuggestion(flowDeps(), OCT_1, {
      templateId: source.id,
      occurrenceDate: '2026-09-15',
      reason: 'skipped',
    });
    await unskipSuggestion(flowDeps(), OCT_1, { skipId: skip.id });
    page = await completed();
    expect(occurrenceOf(page.expenses, source.id, '2026-09-15').state).toEqual({ kind: 'due' });
  });
});

/* -------------------------------------------------------------------------- */
/* The read's cost                                                             */
/* -------------------------------------------------------------------------- */

/** A handle that counts `db.transaction` invocations, as the Monthly suite's does. */
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

async function countTransactions(ctx: RequestContext, month = SEPTEMBER): Promise<number> {
  const counting = countingDatabase();
  const fx = createFxService({ db: counting.db, provider: harness.fxProvider });
  await getMonthlyPage({ db: counting.db, fx }, ctx, month);
  return counting.transactions();
}

/**
 * A database whose every SQL statement is recorded, as the text the driver was
 * given. What a query *asked* is the only way to prove a read was not repeated
 * under another name.
 */
function capturingDatabase(): { db: Database; statements: string[]; close: () => Promise<void> } {
  const pool = createPool({ connectionString: harness.provisioned.userUrl, max: 5 });
  const statements: string[] = [];
  const wrapped = new WeakSet<object>();

  const wrap = (client: pg.PoolClient): pg.PoolClient => {
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.assign(client, {
      query: (...args: unknown[]): unknown => {
        const [first] = args;
        const text =
          typeof first === 'string' ? first : (first as { text?: unknown } | null | undefined)?.text;
        if (typeof text === 'string') statements.push(text);
        return query(...args);
      },
    });
    return client;
  };

  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  Object.assign(pool, {
    connect: (...args: unknown[]): unknown => {
      const [callback] = args;
      if (typeof callback === 'function') {
        return connect((error: unknown, client: pg.PoolClient | undefined, done: unknown) => {
          (callback as (...rest: unknown[]) => void)(
            error,
            client === undefined ? client : wrap(client),
            done,
          );
        });
      }
      return (connect() as Promise<pg.PoolClient>).then(wrap);
    },
  });

  return {
    db: createDatabase(pool),
    statements,
    close: async () => {
      await pool.end();
    },
  };
}

describe('the section’s read', () => {
  it('opens exactly one scope of its own, for either kind of month', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva, startDate: '2026-06-01' });
    await acceptSuggestion(flowDeps(), OCT_1, { templateId: source.id, occurrenceDate: '2026-09-15' });

    const completedHandle = countingDatabase();
    await loadCompletedMonthExpenses({ db: completedHandle.db }, USER_A, SEPTEMBER, [source.id]);
    expect(completedHandle.transactions()).toBe(1);

    const currentHandle = countingDatabase();
    await loadCurrentMonthExpenses({ db: currentHandle.db }, USER_A, SEPTEMBER, SEPT_10.today, [source.id]);
    expect(currentHandle.transactions()).toBe(1);
  });

  it('does not grow with sources, terms, skips, recordings, expenses, categories, accounts or candidates', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    // One source already, so the range loader's batched terms scope — which
    // predates this section — is inside the baseline.
    await expenseSource({ name: 'Baseline', cashPositionId: bbva });
    const baseCompleted = await countTransactions(OCT_1);
    const baseCurrent = await countTransactions(SEPT_10);

    for (const name of ['Rent', 'Phone', 'Streaming', 'Power']) {
      const source = await expenseSource({ name, dayOfMonth: 5, cashPositionId: bbva });
      for (const from of ['2026-04-05', '2026-06-05', '2026-08-05']) {
        await setTemplateTerm(flowDeps(), OCT_1, {
          templateId: source.id,
          effectiveFrom: from,
          amount: '15.00',
          expected: { state: 'absent' },
        });
      }
      await acceptSuggestion(flowDeps(), OCT_1, { templateId: source.id, occurrenceDate: '2026-09-05' });
      await skipSuggestion(flowDeps(), OCT_1, {
        templateId: source.id,
        occurrenceDate: '2026-08-05',
        reason: 'skipped',
      });
    }
    for (const name of ['Licence', 'Club', 'Warranty', 'Storage', 'Magazine']) {
      await expenseSource({ name, frequency: 'annual', dayOfMonth: 1, startDate: '2026-12-01' });
    }
    for (let index = 0; index < 5; index += 1) {
      await expense(OCT_1, { incurredOn: '2026-09-12', amount: '3.00', cashPositionId: bbva });
    }
    for (const name of ['Hobby', 'Garden', 'Pets']) {
      await createCategory(harness.db, USER_A, { kind: 'custom', name: `${name} ${String(Date.now())}` });
    }
    for (const name of ['Joint', 'Cash box', 'Travel card']) {
      const id = await makeAccount(name);
      await statement(id, '2026-08-31', '10.00');
      await statement(id, '2026-09-30', '10.00');
    }

    expect(await countTransactions(OCT_1)).toBe(baseCompleted);
    expect(await countTransactions(SEPT_10)).toBe(baseCurrent);
    const live = await current();
    expect(live.expenses.paidTodayCandidates.length).toBeGreaterThanOrEqual(5);
    expect((await completed()).expenses.occurrences.length).toBeGreaterThan(4);
  });

  it('reuses the reconciliation loaders’ expense and category rows rather than reading them again', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva });
    await acceptSuggestion(flowDeps(), OCT_1, { templateId: source.id, occurrenceDate: '2026-09-15' });
    await expense(OCT_1, { incurredOn: '2026-09-02', cashPositionId: bbva });

    for (const [ctx, month] of [
      [OCT_1, SEPTEMBER],
      [SEPT_10, SEPTEMBER],
    ] as const) {
      const capturing = capturingDatabase();
      try {
        const fx = createFxService({ db: capturing.db, provider: harness.fxProvider });
        const page = await getMonthlyPage({ db: capturing.db, fx }, ctx, month);
        expect(page.expenses.eligibleCategories.length).toBeGreaterThan(0);

        const expenseReads = capturing.statements.filter((text) => /from "expense_entries"/iu.test(text));
        // One read of the month's spending by financial date — the loader's —
        // and one of its occurrences by scheduled date, the section's own.
        expect(expenseReads.filter((text) => /"incurred_on" between/iu.test(text))).toHaveLength(1);
        expect(expenseReads.filter((text) => /"occurrence_date" between/iu.test(text))).toHaveLength(1);
        expect(capturing.statements.filter((text) => /from "categories"/iu.test(text))).toHaveLength(1);
      } finally {
        await capturing.close();
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

describe('another user’s known expenses', () => {
  it('are invisible to the section, to its categories and to the schedule read itself', async () => {
    const bbva = await makeAccount('BBVA');
    const source = await expenseSource({ cashPositionId: bbva });
    await acceptSuggestion(flowDeps(), OCT_1, { templateId: source.id, occurrenceDate: '2026-09-15' });
    await expense(OCT_1, { incurredOn: '2026-09-02', cashPositionId: bbva });

    const asB = on('2026-10-01', USER_B);
    const theirs = await completed(asB);
    expect(theirs.expenses.occurrences).toEqual([]);
    expect(theirs.expenses.otherRecurring).toEqual([]);
    expect(theirs.expenses.direct).toEqual([]);
    expect(theirs.expenses.cashAccounts).toEqual([]);

    const mine = await listCategories(harness.db, USER_A, { includeArchived: true });
    const mineIds = new Set(mine.map((row) => row.id));
    expect(theirs.expenses.eligibleCategories.length).toBeGreaterThan(0);
    expect(theirs.expenses.eligibleCategories.some((row) => mineIds.has(row.categoryId))).toBe(false);

    const [asOwner, asOther] = await Promise.all([
      withUser(harness.db, { userId: USER_A }, (tx) =>
        listExpenseEntriesByOccurrenceIn(tx, '2026-09-01', '2026-09-30'),
      ),
      withUser(harness.db, { userId: USER_B }, (tx) =>
        listExpenseEntriesByOccurrenceIn(tx, '2026-09-01', '2026-09-30'),
      ),
    ]);
    expect(asOwner).toHaveLength(1);
    expect(asOther).toEqual([]);
  });
});
