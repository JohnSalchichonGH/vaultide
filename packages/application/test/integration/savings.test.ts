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
import { readSettings, setCountAdditionalSpending } from '../../src/settings/service';
import { parseMonth } from '../../src/reconciliation/service';
import { getMonthSavings, getMonthToDateSavings } from '../../src/reconciliation/savings-service';
import type { NativeSavingsDto } from '../../src/reconciliation/types';

/**
 * Savings and the spending decomposition against a real database (21.3, 12.5,
 * v2.1.12 30.15).
 *
 * September 2026. The completed-month cases read it from 1 October; the
 * current-month cases sit on the 10th, so "the 6th" and "the 8th" are 8.6's own
 * example. Nothing here is stored: every figure is derived at read time.
 *
 * These fixtures use rows Phase 3 can actually store. Where domain validation
 * correctly refuses a row — a `capital_improvement` with no property to link
 * to, a standalone `transfer_fee`, an `investment_fee` deducted from an asset —
 * the rule is proved at the point that refuses it, and the classifier itself is
 * proved in the finance suite. No validation is weakened to manufacture a row.
 */

const USER_A = '99999999-9999-4999-8999-999999999999';

let harness: Harness;
let categories: Awaited<ReturnType<typeof listCategories>>;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
const SEPT_10 = on('2026-09-10');
const SEPTEMBER = parseMonth('2026-09');

function deps() {
  return harness.services.flows;
}

function readDeps() {
  return { db: harness.db };
}

function categoryOf(kind: string): string {
  const found = categories.find((category) => category.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} category`);
  return found.id;
}

async function makeAccount(
  name: string,
  options: { currency?: string } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, OCT_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  return created.id;
}

async function statement(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, OCT_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });
}

async function snapshot(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await recordValuation(harness.services.positions, SEPT_10, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });
}

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

async function income(
  ctx: RequestContext,
  args: {
    kind: 'employment' | 'interest' | 'dividend' | 'external_inflow' | 'adjustment';
    receivedOn: string;
    netAmount: string;
    cashPositionId?: string | null;
    settlement?: 'tracked_cash' | 'external';
  },
): Promise<void> {
  await createIncomeEntry(deps(), ctx, {
    kind: args.kind,
    receivedOn: args.receivedOn,
    netAmount: args.netAmount,
    currency: 'EUR',
    settlement: args.settlement ?? 'tracked_cash',
    cashPositionId: args.settlement === 'external' ? null : (args.cashPositionId ?? null),
  });
}

const eur = (buckets: readonly NativeSavingsDto[]): NativeSavingsDto => {
  const found = buckets.find((bucket) => bucket.currency === 'EUR');
  if (found === undefined) throw new Error('no EUR bucket');
  return found;
};

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${USER_A}, ${'savings-a@example.test'}, ${'savings-a@example.test'}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
  await provisionUser(harness.db, { userId: USER_A });
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
  await setCountAdditionalSpending(
    harness.services.settings,
    USER_A,
    (await readSettings(harness.db, USER_A)).version,
    true,
  );

  categories = await listCategories(harness.db, USER_A);
});

/* -------------------------------------------------------------------------- */
/* Income classification                                                      */
/* -------------------------------------------------------------------------- */

describe('income kinds map to ExternalIncome exactly as 12.5 says', () => {
  it('counts employment, interest and dividends received in tracked cash', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '1600.00');
    await income(OCT_1, { kind: 'employment', receivedOn: '2026-09-25', netAmount: '500.00', cashPositionId: a });
    await income(OCT_1, { kind: 'interest', receivedOn: '2026-09-26', netAmount: '31.00', cashPositionId: a });
    await income(OCT_1, { kind: 'dividend', receivedOn: '2026-09-27', netAmount: '69.00', cashPositionId: a });

    const result = await getMonthSavings(readDeps(), OCT_1, SEPTEMBER);
    expect(eur(result.buckets).source.externalIncome.amount).toBe('600');
  });

  it('leaves external_inflow and adjustment out while they still explain the cash', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '1500.00');
    await income(OCT_1, { kind: 'employment', receivedOn: '2026-09-25', netAmount: '200.00', cashPositionId: a });
    await income(OCT_1, { kind: 'external_inflow', receivedOn: '2026-09-26', netAmount: '180.00', cashPositionId: a });
    await income(OCT_1, { kind: 'adjustment', receivedOn: '2026-09-27', netAmount: '120.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.externalIncome.amount).toBe('200');
    // They are `Nin`, so they explain the 500 of cash growth and the month
    // still reconciles.
    expect(bucket.derived.kind).toBe('available');
  });

  it('leaves ordinary income settled external out of ExternalIncome', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '1000.00');
    await income(OCT_1, {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '900.00',
      settlement: 'external',
    });

    expect(eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets).source.externalIncome.amount).toBe('0');
  });
});

/* -------------------------------------------------------------------------- */
/* Expense classification                                                     */
/* -------------------------------------------------------------------------- */

describe('expense kinds map to the 12.3 buckets exactly as 7.4 says', () => {
  it('keeps consumption kinds, tax and property_operating in the remainder', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '700.00');
    await expense(OCT_1, { kind: 'general', incurredOn: '2026-09-02', amount: '100.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'insurance', incurredOn: '2026-09-03', amount: '50.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'tax', incurredOn: '2026-09-04', amount: '80.00', cashPositionId: a });
    // Phase 3 has no property positions, so this is 12.3's non-rental case.
    await expense(OCT_1, { kind: 'property_operating', incurredOn: '2026-09-05', amount: '70.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.knownConsumption.amount).toBe('300');
    expect(bucket.source.propertyOperatingCosts.amount).toBe('0');
    expect(bucket.source.interestAndFees.amount).toBe('0');
    expect(bucket.source.transactionCosts.amount).toBe('0');
    expect(bucket.source.externalOutflows.amount).toBe('0');
  });

  it('sends an investment fee paid from tracked cash to interest and fees', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '960.00');
    await expense(OCT_1, { kind: 'investment_fee', incurredOn: '2026-09-06', amount: '40.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.interestAndFees.amount).toBe('40');
    expect(bucket.source.knownConsumption.amount).toBe('0');
  });

  it('sends a transfer’s own fee to interest and fees', async () => {
    // A `transfer_fee` cannot be recorded on its own — M14 keeps it with the
    // transfer it was charged on — so this is the only real path to one.
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await statement(a, '2026-08-31', '1000.00');
    await statement(b, '2026-08-31', '0.00');
    await createCashTransfer(deps(), OCT_1, {
      occurredOn: '2026-09-07',
      fromPositionId: a,
      toPositionId: b,
      fromAmount: '300.00',
      toAmount: '300.00',
      fee: {
        amount: '5.00',
        categoryId: categoryOf('transfer_fee'),
        cashPositionId: a,
        currency: 'EUR',
      },
    });
    await statement(a, '2026-09-30', '695.00');
    await statement(b, '2026-09-30', '300.00');

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.interestAndFees.amount).toBe('5');
    expect(bucket.source.knownConsumption.amount).toBe('0');
    // The transfer itself is neither income nor cost, and nets to nothing.
    expect(bucket.source.externalIncome.amount).toBe('0');
    if (bucket.derived.kind !== 'available') throw new Error('expected available');
    expect(bucket.derived.consumption.amount).toBe('0');
  });

  it('sends acquisition and disposal costs to transaction costs', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '940.00');
    await expense(OCT_1, { kind: 'acquisition_cost', incurredOn: '2026-09-08', amount: '35.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'disposal_cost', incurredOn: '2026-09-09', amount: '25.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.transactionCosts.amount).toBe('60');
    expect(bucket.source.knownConsumption.amount).toBe('0');
  });

  it('sends an external outflow to its own bucket and does not subtract it from savings', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');
    await income(OCT_1, { kind: 'employment', receivedOn: '2026-09-25', netAmount: '100.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'external_outflow', incurredOn: '2026-09-10', amount: '200.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.externalOutflows.amount).toBe('200');
    if (bucket.derived.kind !== 'available') throw new Error('expected available');
    // ΣI 100, ΣK 200, Δ −100 → tracked 200, unclassified 0, consumption 0.
    expect(bucket.derived.consumption.amount).toBe('0');
    // 12.5 does not subtract external outflows here, so savings are income.
    expect(bucket.derived.trackedSavingsFromIncome.amount).toBe('100');
    expect(bucket.derived.totalSpending.amount).toBe('200');
  });

  it('refuses the two kinds Phase 3 cannot represent rather than mis-classifying them', async () => {
    const a = await makeAccount('BBVA');
    // A capital improvement has no property to improve yet, and 7.4 gives it
    // the `Nout` role rather than a cost bucket. The classifier's behaviour is
    // proved in the finance suite; here the row simply cannot exist.
    await expect(
      expense(OCT_1, {
        kind: 'capital_improvement',
        incurredOn: '2026-09-11',
        amount: '10.00',
        cashPositionId: a,
      }),
    ).rejects.toThrow();
    // A standalone transfer fee is refused for the same reason: it belongs to
    // its transfer, which is where the test above records one.
    await expect(
      expense(OCT_1, { kind: 'transfer_fee', incurredOn: '2026-09-11', amount: '10.00', cashPositionId: a }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The two independent settlements                                            */
/* -------------------------------------------------------------------------- */

describe('untracked and third-party spending stay beside the identity', () => {
  it('reports both and changes neither ΣK nor tracked spending', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-02', amount: '60.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-03', amount: '50.00', settlement: 'untracked_self' });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-04', amount: '80.00', settlement: 'third_party' });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.source.additionalSpending.amount).toBe('50');
    expect(bucket.source.thirdPartyPaid.amount).toBe('80');
    // ΣK is the tracked 60 alone; tracked spending is the 100 of cash change.
    expect(bucket.source.knownConsumption.amount).toBe('60');
    if (bucket.derived.kind !== 'available') throw new Error('expected available');
    expect(bucket.derived.consumption.amount).toBe('100');
    expect(bucket.derived.totalSpending.amount).toBe('150');
  });

  it('survives in a currency that reconciles nothing at all', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '1000.00');
    // No GBP cash account and no GBP tracked flow: no GBP bucket can exist.
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-05',
      amount: '50.00',
      settlement: 'untracked_self',
      currency: 'GBP',
    });
    await expense(OCT_1, {
      kind: 'food',
      incurredOn: '2026-09-06',
      amount: '80.00',
      settlement: 'third_party',
      currency: 'GBP',
    });

    const result = await getMonthSavings(readDeps(), OCT_1, SEPTEMBER);
    expect(result.buckets.map((bucket) => bucket.currency)).toEqual(['EUR']);
    expect(result.sourceOnlyByCurrency).toEqual([
      {
        currency: 'GBP',
        additionalSpending: { amount: '50', currency: 'GBP' },
        thirdPartyPaid: { amount: '80', currency: 'GBP' },
      },
    ]);
    // And nothing derived was invented for it.
    expect(JSON.stringify(result.sourceOnlyByCurrency)).not.toContain('personalSavings');
    expect(JSON.stringify(result.sourceOnlyByCurrency)).not.toContain('savingsRate');
  });
});

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

describe('a bucket reports derived figures only when it has them', () => {
  it('keeps the source classification when the month cannot be reconciled', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    // No September month-end balance.
    await income(OCT_1, { kind: 'employment', receivedOn: '2026-09-25', netAmount: '2100.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'insurance', incurredOn: '2026-09-12', amount: '300.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-13', amount: '50.00', settlement: 'untracked_self' });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    expect(bucket.reconciliationStatus).toBe('unavailable');
    expect(bucket.source.externalIncome.amount).toBe('2100');
    expect(bucket.source.knownConsumption.amount).toBe('300');
    expect(bucket.source.additionalSpending.amount).toBe('50');
    expect(bucket.derived).toEqual({ kind: 'unavailable', because: 'reconciliation_unavailable' });
  });

  it('reports no spending figure for a month whose records contradict each other', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '2291.00');
    await expense(OCT_1, { kind: 'insurance', incurredOn: '2026-09-12', amount: '411.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-13', amount: '50.00', settlement: 'untracked_self' });

    const result = await getMonthSavings(readDeps(), OCT_1, SEPTEMBER);
    const bucket = eur(result.buckets);
    expect(bucket.reconciliationStatus).toBe('unresolved');
    expect(bucket.source.knownConsumption.amount).toBe('411');
    expect(bucket.source.additionalSpending.amount).toBe('50');
    expect(bucket.derived).toEqual({ kind: 'unavailable', because: 'unresolved' });
    expect(JSON.stringify(result)).not.toContain('-1241');
  });

  it('takes only the rate when there is no income', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-02', amount: '60.00', cashPositionId: a });

    const bucket = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    if (bucket.derived.kind !== 'available') throw new Error('expected available');
    expect(bucket.derived.consumption.amount).toBe('100');
    expect(bucket.derived.personalSavings.amount).toBe('-100');
    expect(bucket.derived.savingsRate).toEqual({ kind: 'unavailable', reason: 'divide_by_zero' });
  });
});

/* -------------------------------------------------------------------------- */
/* The setting                                                                */
/* -------------------------------------------------------------------------- */

describe('count_additional_spending is read from the current setting', () => {
  it('changes the savings and the rate, and nothing about the spending', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '2291.00');
    await income(OCT_1, { kind: 'employment', receivedOn: '2026-09-25', netAmount: '2131.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'insurance', incurredOn: '2026-09-12', amount: '411.00', cashPositionId: a });
    await expense(OCT_1, { kind: 'food', incurredOn: '2026-09-13', amount: '50.00', settlement: 'untracked_self' });

    const counted = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    if (counted.derived.kind !== 'available') throw new Error('expected available');
    expect(counted.derived.trackedSavingsFromIncome.amount).toBe('1291');
    expect(counted.derived.personalSavings.amount).toBe('1241');
    expect(counted.derived.countsAdditionalSpending).toBe(true);
    expect(counted.derived.totalSpending.amount).toBe('890');

    await setCountAdditionalSpending(
      harness.services.settings,
      USER_A,
      (await readSettings(harness.db, USER_A)).version,
      false,
    );

    const trackedOnly = eur((await getMonthSavings(readDeps(), OCT_1, SEPTEMBER)).buckets);
    if (trackedOnly.derived.kind !== 'available') throw new Error('expected available');
    // The same source month, recomputed under the current setting (5.3).
    expect(trackedOnly.derived.personalSavings.amount).toBe('1291');
    expect(trackedOnly.derived.countsAdditionalSpending).toBe(false);
    expect(trackedOnly.derived.totalSpending.amount).toBe('890');
    expect(trackedOnly.source.additionalSpending.amount).toBe('50');
  });
});

/* -------------------------------------------------------------------------- */
/* The current month                                                          */
/* -------------------------------------------------------------------------- */

describe('the current month stops where its evidence stops', () => {
  it('computes every figure through D and excludes an untracked expense dated after it', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await snapshot(a, '2026-09-06', '1400.00');
    await income(SEPT_10, { kind: 'employment', receivedOn: '2026-09-03', netAmount: '600.00', cashPositionId: a });
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-04', amount: '150.00', cashPositionId: a });
    // Before D: counted.
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-05', amount: '50.00', settlement: 'untracked_self' });
    // After D: a real record, in no through-D figure.
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-08', amount: '90.00', settlement: 'untracked_self' });
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-09', amount: '70.00', settlement: 'third_party' });

    const result = await getMonthToDateSavings(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');
    expect(result.sourceOnlyThrough).toBe('2026-09-06');
    expect(result.buckets).not.toBeNull();

    const bucket = eur(result.buckets ?? []);
    expect(bucket.reconciliationStatus).toBe('provisional');
    expect(bucket.source.externalIncome.amount).toBe('600');
    expect(bucket.source.knownConsumption.amount).toBe('150');
    expect(bucket.source.additionalSpending.amount).toBe('50');
    expect(bucket.source.thirdPartyPaid.amount).toBe('0');
    if (bucket.derived.kind !== 'available') throw new Error('expected available');
    expect(bucket.derived.quality).toBe('provisional');
    expect(bucket.derived.consumption.amount).toBe('200');
    expect(bucket.derived.personalSavings.amount).toBe('350');
    expect(bucket.derived.totalSpending.amount).toBe('250');
  });

  it('keeps the two settlements through today when no common date exists', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Savings');
    await statement(a, '2026-08-31', '1000.00');
    await statement(b, '2026-08-31', '500.00');
    // No day carries a snapshot for both, so there is no common date.
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-03', '480.00');
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-08', amount: '50.00', settlement: 'untracked_self' });
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-09', amount: '80.00', settlement: 'third_party' });

    const result = await getMonthToDateSavings(readDeps(), SEPT_10);
    expect(result.asOf).toBeNull();
    expect(result.buckets).toBeNull();
    expect(result.sourceOnlyThrough).toBe('2026-09-10');
    expect(result.sourceOnlyByCurrency).toEqual([
      {
        currency: 'EUR',
        additionalSpending: { amount: '50', currency: 'EUR' },
        thirdPartyPaid: { amount: '80', currency: 'EUR' },
      },
    ]);
    // Nothing derived was invented from records with no interval to sit in.
    const serialised = JSON.stringify(result);
    for (const field of ['consumption', 'personalSavings', 'totalSpending', 'savingsRate']) {
      expect(serialised).not.toContain(field);
    }
  });

  it('leaves one bucket’s savings standing when another has no usable opening', async () => {
    const a = await makeAccount('BBVA');
    const b = await makeAccount('Dollars', { currency: 'USD' });
    // EUR has a snapshot before September but no August month-end balance, so
    // its opening is carried: unusable, and not a `first_balance` exclusion.
    await snapshot(a, '2026-08-20', '1000.00');
    await snapshot(a, '2026-09-06', '900.00');
    await statement(b, '2026-08-31', '500.00');
    await snapshot(b, '2026-09-06', '400.00');
    await expense(SEPT_10, { kind: 'food', incurredOn: '2026-09-02', amount: '60.00', cashPositionId: a });
    await expense(SEPT_10, {
      kind: 'food',
      incurredOn: '2026-09-03',
      amount: '100.00',
      cashPositionId: b,
      currency: 'USD',
    });

    const result = await getMonthToDateSavings(readDeps(), SEPT_10);
    expect(result.asOf).toBe('2026-09-06');

    const eurBucket = eur(result.buckets ?? []);
    expect(eurBucket.reconciliationStatus).toBe('unavailable');
    expect(eurBucket.source.knownConsumption.amount).toBe('60');
    expect(eurBucket.derived).toEqual({
      kind: 'unavailable',
      because: 'reconciliation_unavailable',
    });

    const usd = (result.buckets ?? []).find((bucket) => bucket.currency === 'USD');
    expect(usd?.reconciliationStatus).toBe('provisional');
    if (usd?.derived.kind !== 'available') throw new Error('expected available');
    expect(usd.derived.consumption.amount).toBe('100');
    expect(usd.derived.totalSpending.amount).toBe('100');
  });
});

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                 */
/* -------------------------------------------------------------------------- */

describe('boundaries', () => {
  it('refuses a month that has not ended', async () => {
    await expect(getMonthSavings(readDeps(), SEPT_10, SEPTEMBER)).rejects.toThrow();
  });

  it('reads the month in a fixed number of round trips', async () => {
    const a = await makeAccount('BBVA');
    await statement(a, '2026-08-31', '1000.00');
    await statement(a, '2026-09-30', '900.00');

    const small = await countRoundTrips();

    const b = await makeAccount('Savings');
    await statement(b, '2026-08-31', '500.00');
    await statement(b, '2026-09-30', '500.00');
    for (let index = 0; index < 10; index += 1) {
      await expense(OCT_1, {
        kind: 'food',
        incurredOn: '2026-09-05',
        amount: '1.00',
        settlement: 'untracked_self',
      });
    }

    expect(await countRoundTrips()).toBe(small);
    // The completed-month window plus the user's setting, and nothing per
    // account, flow, category or currency.
    expect(small).toBe(8);
  });
});

/** How many transactions one savings read opens. */
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

  await getMonthSavings({ db: counting }, OCT_1, SEPTEMBER);
  return transactions;
}
