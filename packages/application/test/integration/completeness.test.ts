import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertIncomeEntryIn, insertSkipIn, sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  closePosition,
  createCashAccount,
  createOtherAsset,
  updateCashAccount,
} from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { archiveTemplate, createTemplate } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import { ValidationError } from '../../src/errors';

/**
 * Completed-month completeness against a real database (blueprint 12.6, 21.3,
 * v2.1.15 30.18).
 *
 * September 2026, judged from 1 October. Every row here is one Phase 3 can
 * store through its own services; the only exception is one fixture that
 * writes a flow and a skip for the same occurrence below the service layer,
 * because the services refuse that combination and the read still has to count
 * it once if it ever exists.
 */

const USER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let harness: Harness;
let insurance: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
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

async function makeAccount(name: string, options: { currency?: string } = {}) {
  return createCashAccount(harness.services.positions, OCT_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
}

async function balance(
  positionId: string,
  valuedOn: string,
  amount: string,
  datePrecision: 'exact' | 'month_end' = 'month_end',
): Promise<void> {
  await recordValuation(harness.services.positions, OCT_1, { positionId, valuedOn, amount, datePrecision });
}

/** An account with August's and September's statements. */
async function closedAccount(name: string): Promise<string> {
  const account = await makeAccount(name);
  await balance(account.id, '2026-08-31', '1000.00');
  await balance(account.id, '2026-09-30', '900.00');
  return account.id;
}

async function salaryTemplate(options: { currency?: string; cashPositionId?: string } = {}) {
  const created = await createTemplate(deps(), OCT_1, {
    kind: 'income',
    name: 'Salary',
    incomeKind: 'employment',
    currency: options.currency ?? 'EUR',
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: '2026-01-01',
    ...(options.cashPositionId === undefined ? {} : { cashPositionId: options.cashPositionId }),
    amount: '2100.00',
  });
  return created.template;
}

async function insuranceTemplate(cashPositionId: string) {
  const created = await createTemplate(deps(), OCT_1, {
    kind: 'expense',
    name: 'Insurance',
    categoryId: insurance,
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 12,
    startDate: '2026-01-01',
    cashPositionId,
    amount: '300.00',
  });
  return created.template;
}

const completeness = (ctx: RequestContext = OCT_1) => getMonthCompleteness(readDeps(), ctx, SEPTEMBER);

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'completeness-a@example.test'],
    [USER_B, 'completeness-b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
  const categories = await listCategories(harness.db, USER_A);
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
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');
});

describe('a Phase 3 month, read from the database', () => {
  it('is sufficient when every account is closed and every occurrence accounted for', async () => {
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });
    const policy = await insuranceTemplate(bbva);
    await acceptSuggestion(deps(), OCT_1, { templateId: salary.id, occurrenceDate: '2026-09-25' });
    await acceptSuggestion(deps(), OCT_1, { templateId: policy.id, occurrenceDate: '2026-09-12' });

    const result = await completeness();
    expect(result).toMatchObject({ month: '2026-09', state: 'sufficient', satisfied: 3, required: 3, ratio: '1' });
    expect(result.cashAccounts).toEqual([
      { positionId: bbva, name: 'BBVA', currency: 'EUR', satisfied: true, closeState: 'month_end' },
    ]);
    expect(result.recurringOccurrences.map((item) => [item.templateKind, item.occurrenceDate, item.satisfied])).toEqual([
      ['expense', '2026-09-12', true],
      ['income', '2026-09-25', true],
    ]);
  });

  it('is partial when a missing expense occurrence is the only gap, with no new reconciliation issue', async () => {
    const bbva = await closedAccount('BBVA');
    await insuranceTemplate(bbva);

    const result = await completeness();
    expect(result).toMatchObject({ state: 'partial', satisfied: 1, required: 2, ratio: '0.5' });
    expect(result.recurringOccurrences[0]).toMatchObject({ templateKind: 'expense', satisfied: false });

    // 8.5 has no expense counterpart to `suggested_income_missing`, and this
    // slice invents none.
    const reconciliation = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);
    expect(reconciliation.buckets.flatMap((bucket) => bucket.issues)).toEqual([]);
  });

  it('counts a missing income occurrence, and the reconciliation still raises its advisory', async () => {
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });

    expect(await completeness()).toMatchObject({ state: 'partial', satisfied: 1, required: 2 });
    const reconciliation = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);
    const issues = reconciliation.buckets.flatMap((bucket) => bucket.issues);
    expect(issues.map((issue) => [issue.key, issue.templateId, issue.occurrenceDate])).toEqual([
      ['suggested_income_missing', salary.id, '2026-09-25'],
    ]);
  });

  it('is satisfied by an explicit skip, exactly as by a flow', async () => {
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });
    await skipSuggestion(deps(), OCT_1, { templateId: salary.id, occurrenceDate: '2026-09-25', reason: 'skipped' });

    expect(await completeness()).toMatchObject({ state: 'sufficient', satisfied: 2, required: 2 });
  });

  it('still expects the occurrence of a template archived since', async () => {
    // 30.10: archiving today cannot erase what September expected.
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });
    await archiveTemplate(deps(), OCT_1, { templateId: salary.id, expectedVersion: salary.version });

    const result = await completeness();
    expect(result.state).toBe('partial');
    expect(result.recurringOccurrences).toEqual([
      expect.objectContaining({ templateId: salary.id, occurrenceDate: '2026-09-25', satisfied: false }),
    ]);
  });

  it('does not need a term to expect an occurrence, nor does a term satisfy one', async () => {
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });
    await harness.asOwner('DELETE FROM recurring_template_terms');

    expect(await completeness()).toMatchObject({ state: 'partial', satisfied: 1, required: 2 });

    // With no term the amount is the user's to give; the occurrence is then
    // accounted for like any other.
    await acceptSuggestion(deps(), OCT_1, {
      templateId: salary.id,
      occurrenceDate: '2026-09-25',
      amount: '2050.00',
    });
    expect(await completeness()).toMatchObject({ state: 'sufficient', satisfied: 2, required: 2 });
  });

  it('counts one occurrence once, even when a flow and a skip both name it', async () => {
    // The services refuse this pair (30.8 item 5); written below them so the read
    // is proved to count the occurrence, not the rows that resolve it.
    const bbva = await closedAccount('BBVA');
    const salary = await salaryTemplate({ cashPositionId: bbva });
    await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const audit = { userId: USER_A, requestId: 'fixture' };
      await insertIncomeEntryIn(tx, audit, {
        kind: 'employment',
        receivedOn: '2026-09-25',
        netAmount: '2100.00',
        grossAmount: null,
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
        description: null,
        occurrence: { templateId: salary.id, occurrenceDate: '2026-09-25' },
      });
      await insertSkipIn(tx, audit, { templateId: salary.id, occurrenceDate: '2026-09-25', reason: 'skipped' });
    });

    expect(await completeness()).toMatchObject({ state: 'sufficient', satisfied: 2, required: 2 });
  });

  it('counts a template in a currency no reconciliation bucket exists for', async () => {
    await closedAccount('BBVA');
    await salaryTemplate({ currency: 'USD' });

    const result = await completeness();
    expect(result).toMatchObject({ state: 'partial', satisfied: 1, required: 2 });
    expect(result.recurringOccurrences[0]?.currency).toBe('USD');

    const reconciliation = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);
    expect(reconciliation.buckets.map((bucket) => bucket.currency)).toEqual(['EUR']);
  });
});

describe('cash accounts, by 8.1 participation', () => {
  it('is incomplete when an account has no September statement', async () => {
    const bbva = await closedAccount('BBVA');
    const savings = await makeAccount('Savings');
    await balance(savings.id, '2026-08-31', '500.00');

    const result = await completeness();
    expect(result).toMatchObject({ state: 'incomplete', satisfied: 1, required: 2, ratio: '0.5' });
    expect(result.cashAccounts.find((item) => item.positionId === savings.id)).toMatchObject({
      satisfied: false,
      closeState: 'carried',
    });
    expect(result.cashAccounts.find((item) => item.positionId === bbva)?.satisfied).toBe(true);
  });

  it('is satisfied by closing inside the month', async () => {
    const old = await makeAccount('Old');
    await balance(old.id, '2026-08-31', '300.00');
    await balance(old.id, '2026-09-15', '0', 'exact');
    await closePosition(harness.services.positions, OCT_1, {
      positionId: old.id,
      expectedVersion: old.version,
      closedOn: '2026-09-15',
    });

    const result = await completeness();
    expect(result.cashAccounts).toEqual([
      { positionId: old.id, name: 'Old', currency: 'EUR', satisfied: true, closeState: 'closed_zero' },
    ]);
    expect(result.state).toBe('sufficient');
  });

  it('leaves a dormant account out of the count', async () => {
    await closedAccount('BBVA');
    const dormant = await makeAccount('Dormant');
    await balance(dormant.id, '2026-07-31', '0');
    await updateCashAccount(harness.services.positions, OCT_1, {
      positionId: dormant.id,
      expectedVersion: dormant.version,
      isDormant: true,
    });

    const result = await completeness();
    expect(result.cashAccounts.map((item) => item.name)).toEqual(['BBVA']);
    expect(result).toMatchObject({ state: 'sufficient', satisfied: 1, required: 1 });
  });
});

describe('the stale state (30.18)', () => {
  it('outranks incomplete when nothing at all was valued in September', async () => {
    const bbva = await makeAccount('BBVA');
    await balance(bbva.id, '2026-08-31', '1000.00');

    expect(await completeness()).toMatchObject({ state: 'stale', satisfied: 0, required: 1, ratio: '0' });
  });

  it('outranks sufficient: a close that needed no September valuation', async () => {
    // Closed on the 15th on the strength of August's zero statement (M6 wants a
    // zero balance on or before the closing date, not one dated that day).
    const old = await makeAccount('Old');
    await balance(old.id, '2026-08-31', '0');
    await closePosition(harness.services.positions, OCT_1, {
      positionId: old.id,
      expectedVersion: old.version,
      closedOn: '2026-09-15',
    });

    expect(await completeness()).toMatchObject({ state: 'stale', satisfied: 1, required: 1, ratio: '1' });
  });

  it('is prevented by an other asset valued in September', async () => {
    const bbva = await makeAccount('BBVA');
    await balance(bbva.id, '2026-08-31', '1000.00');
    const car = await createOtherAsset(harness.services.positions, OCT_1, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
      currentValue: '9000.00',
      currentValueOn: '2026-08-10',
    });
    expect((await completeness()).state).toBe('stale');

    await balance(car.id, '2026-09-10', '8800.00', 'exact');
    expect(await completeness()).toMatchObject({ state: 'incomplete', satisfied: 0, required: 1 });
  });

  it('with nothing required, is stale without evidence and sufficient with it, and never has a ratio', async () => {
    const dormant = await makeAccount('Dormant');
    await balance(dormant.id, '2026-07-31', '0');
    await updateCashAccount(harness.services.positions, OCT_1, {
      positionId: dormant.id,
      expectedVersion: dormant.version,
      isDormant: true,
    });
    expect(await completeness()).toMatchObject({ state: 'stale', satisfied: 0, required: 0, ratio: null });

    const car = await createOtherAsset(harness.services.positions, OCT_1, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: true,
    });
    await balance(car.id, '2026-09-20', '9000.00', 'exact');
    expect(await completeness()).toMatchObject({ state: 'sufficient', satisfied: 0, required: 0, ratio: null });
  });

  it('applies to a user with no positions at all, and sees only that user’s rows', async () => {
    await closedAccount('BBVA');
    expect(await completeness(on('2026-10-01', USER_B))).toEqual({
      month: '2026-09',
      state: 'stale',
      satisfied: 0,
      required: 0,
      ratio: null,
      cashAccounts: [],
      recurringOccurrences: [],
    });
  });
});

describe('boundaries', () => {
  it('refuses the current month, on its last day too', async () => {
    await expect(completeness(on('2026-09-30'))).rejects.toBeInstanceOf(ValidationError);
    await expect(completeness(on('2026-09-10'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('leaves the reconciliation read exactly as it was', async () => {
    const bbva = await closedAccount('BBVA');
    const savings = await makeAccount('Savings');
    await balance(savings.id, '2026-08-31', '500.00');
    await salaryTemplate({ cashPositionId: bbva });
    await insuranceTemplate(bbva);

    const before = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);
    await completeness();
    const after = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);

    expect(after).toEqual(before);
    expect(Object.keys(after)).toEqual(['month', 'status', 'buckets']);
    expect(after.status).toBe('unavailable');
  });

  /**
   * The read contract, which is a constant bound rather than a single number.
   *
   * The completed-month loader and nothing else: seven reads with no template
   * covering the month and eight with any, because every template's terms come
   * back in one batched query. The `stale` rule reads valuations that window
   * already holds, so it adds none.
   */
  describe('the read count is bounded by a constant', () => {
    beforeEach(async () => {
      await closedAccount('BBVA');
    });

    it('takes seven reads with no template and eight with any', async () => {
      expect(await countRoundTrips()).toBe(7);
      await salaryTemplate();
      expect(await countRoundTrips()).toBe(8);
      await salaryTemplate({ currency: 'USD' });
      expect(await countRoundTrips()).toBe(8);
    });

    it('does not grow with accounts, valuations, other assets or resolutions', async () => {
      const salary = await salaryTemplate();
      const before = await countRoundTrips();

      for (const name of ['Savings', 'Brokerage', 'Joint']) await closedAccount(name);
      await createOtherAsset(harness.services.positions, OCT_1, {
        name: 'Car',
        currency: 'EUR',
        assetType: 'vehicle',
        includeInFinancialNetWorth: false,
        currentValue: '9000.00',
        currentValueOn: '2026-09-10',
      });
      await skipSuggestion(deps(), OCT_1, { templateId: salary.id, occurrenceDate: '2026-09-25', reason: 'skipped' });

      expect(await countRoundTrips()).toBe(before);
    });
  });
});

/** How many transactions one completeness read opens. */
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

  await getMonthCompleteness({ db: counting }, OCT_1, SEPTEMBER);
  return transactions;
}
