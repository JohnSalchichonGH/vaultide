import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { correctValuation, recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createCashTransfer } from '../../src/flows/transfers';
import { archiveTemplate, createTemplate } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import { loadCompletedMonth } from '../../src/reconciliation/loader';
import { ValidationError } from '../../src/errors';

/**
 * Completed-month reconciliation against a real database (blueprint 21.3, 8.10).
 *
 * The month here is 8.10's September, minus the two records Phase 3 has no
 * table for — the investment contribution and the mortgage payment. Removing
 * both from the balances as well as from the records leaves the two per-account
 * residuals exactly where 8.10 puts them (BBVA −429, Savings +31) and therefore
 * the same unclassified 398, which is why this is still that example rather
 * than a different one: the arithmetic below is recomputed for these records in
 * the file's own comments and matches the golden's structure line for line.
 *
 * Every figure asserted here is derived at read time. Nothing stores it (5.3),
 * and one of the tests proves that by correcting a balance afterwards.
 */

const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

let harness: Harness;
let bbva: string;
let savings: string;
let insurance: string;
let food: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

/** 8.1: September is completed from 1 October, and not one day earlier. */
const OCTOBER_1 = on('2026-10-01');
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

/** The bucket of the one currency these fixtures use. */
async function eurBucket(ctx: RequestContext = OCTOBER_1) {
  const result = await getMonthReconciliation(readDeps(), ctx, SEPTEMBER);
  const bucket = result.buckets.find((b) => b.currency === 'EUR');
  return { result, bucket };
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'recon-a@example.test'],
    [USER_B, 'recon-b@example.test'],
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
  await harness.asOwner('DELETE FROM recurring_template_skips');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');

  const checking = await createCashAccount(harness.services.positions, OCTOBER_1, {
    name: 'BBVA',
    currency: 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  bbva = checking.id;

  const savingsAccount = await createCashAccount(harness.services.positions, OCTOBER_1, {
    name: 'Savings',
    currency: 'EUR',
    accountType: 'savings',
    openedOn: null,
  });
  savings = savingsAccount.id;

  const categories = await listCategories(harness.db, USER_A);
  insurance = categories.find((row) => row.kind === 'insurance')?.id as string;
  food = categories.find((row) => row.name === 'Groceries')?.id as string;
});

/**
 * 8.10's September, in the records Phase 3 has.
 *
 * ```
 * BBVA    8,055.00 → 9,226.00      Savings 8,509.00 → 8,740.00
 * ΣI 2,100   ΣNin 200   ΣNout 200   ΣK 300
 * Δ    = 1,171 + 231 = 1,402
 * Total= 2,100 + 200 − 200 − 1,402 = 698
 * Unclassified = 698 − 300 = 398
 * residuals: BBVA 1,171 − (2,100 − 200 − 300) = −429 ; Savings 231 − 200 = +31
 * ```
 */
async function recordSeptember(options: { withSalary?: boolean } = {}): Promise<void> {
  const { withSalary = true } = options;

  for (const [positionId, amount] of [
    [bbva, '8055.00'],
    [savings, '8509.00'],
  ] as const) {
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId,
      valuedOn: '2026-08-31',
      amount,
      datePrecision: 'month_end',
    });
  }

  if (withSalary) {
    await createIncomeEntry(deps(), on('2026-09-25'), {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
  }

  await createCashTransfer(deps(), on('2026-09-05'), {
    occurredOn: '2026-09-05',
    fromPositionId: bbva,
    toPositionId: savings,
    fromAmount: '200.00',
    toAmount: '200.00',
  });

  await createExpenseEntry(deps(), on('2026-09-12'), {
    categoryId: insurance,
    incurredOn: '2026-09-12',
    amount: '300.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: bbva,
  });

  // Paid by a partner: not the user's spending at all (7.4).
  await createExpenseEntry(deps(), on('2026-09-20'), {
    categoryId: food,
    incurredOn: '2026-09-20',
    amount: '80.00',
    currency: 'EUR',
    settlement: 'third_party',
  });

  // From an old untracked account: real spending, in none of the totals.
  await createExpenseEntry(deps(), on('2026-09-22'), {
    categoryId: food,
    incurredOn: '2026-09-22',
    amount: '50.00',
    currency: 'EUR',
    settlement: 'untracked_self',
  });

  for (const [positionId, amount] of [
    [bbva, '9226.00'],
    [savings, '8740.00'],
  ] as const) {
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId,
      valuedOn: '2026-09-30',
      amount,
      datePrecision: 'month_end',
    });
  }
}

describe('a completed month, from real rows', () => {
  beforeEach(async () => {
    await recordSeptember();
  });

  it('infers the month from the records and says how it got there', async () => {
    const { result, bucket } = await eurBucket();

    expect(result.month).toBe('2026-09');
    expect(result.status).toBe('reliable');
    expect(bucket?.totals.cashDelta?.amount).toBe('1402');
    expect(bucket?.totals.externalInflows.amount).toBe('2100');
    expect(bucket?.totals.nonIncomeInflows.amount).toBe('200');
    expect(bucket?.totals.nonExpenseOutflows.amount).toBe('200');
    expect(bucket?.totals.knownTrackedExpenses.amount).toBe('300');
    expect(bucket?.totals.trackedTotalSpending?.amount).toBe('698');
    expect(bucket?.totals.unclassified?.amount).toBe('398');
    expect(bucket?.explanation.length).toBeGreaterThan(0);
  });

  it('keeps untracked spending out of the identity and reports it beside', async () => {
    const { bucket } = await eurBucket();
    expect(bucket?.additionalSpending.amount).toBe('50');
    expect(bucket?.thirdPartyPaid.amount).toBe('80');
  });

  it('reports the per-account residuals and suspects the missing interest', async () => {
    const { bucket } = await eurBucket();

    const bbvaState = bucket?.accounts.find((a) => a.positionId === bbva);
    const savingsState = bucket?.accounts.find((a) => a.positionId === savings);
    expect(bbvaState?.residual?.amount).toBe('-429');
    expect(savingsState?.residual?.amount).toBe('31');
    expect(bbvaState?.name).toBe('BBVA');

    const issue = bucket?.issues.find((i) => i.key === 'possible_missing_interest');
    expect(issue?.positionId).toBe(savings);
    expect(issue?.positionName).toBe('Savings');
    expect(issue?.class).toBe('advisory');
  });

  it('stores no derived truth anywhere', async () => {
    // 5.3: there is no table holding a reconciled figure, so there is nothing
    // to recompute, invalidate or drift. The proof is structural rather than a
    // claim: no user-owned table carries any of these columns.
    const columns = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = 'public'
               AND column_name IN (
                 'unclassified', 'tracked_total_spending', 'inferred_spending',
                 'reconciliation_status', 'cash_delta'
               )`,
      );
      return result.rows;
    });
    expect(columns).toEqual([]);
  });

  it('reflects a correction made months later, on the next read', async () => {
    const before = await eurBucket();
    expect(before.bucket?.totals.unclassified?.amount).toBe('398');

    // The August statement was wrong by 100: the month opened lower, so 100
    // less cash left, and the unclassified figure falls by the same.
    const august = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id, version FROM position_valuations
             WHERE position_id = ${bbva} AND valued_on = '2026-08-31'`,
      );
      return result.rows[0] as { id: string; version: number };
    });

    await correctValuation(harness.services.positions, on('2027-03-04'), {
      valuationId: august.id,
      expectedVersion: august.version,
      valuedOn: '2026-08-31',
      amount: '7955.00',
      datePrecision: 'month_end',
    });

    // An opening 100 lower makes Δ 100 larger, so 100 less cash left than the
    // engine thought, and the unclassified part falls by the same 100. Nothing
    // was recomputed: the month is simply read again.
    const after = await eurBucket(on('2027-03-04'));
    expect(after.bucket?.totals.cashDelta?.amount).toBe('1502');
    expect(after.bucket?.totals.unclassified?.amount).toBe('298');
  });

  it('shows another user nothing of it', async () => {
    const result = await getMonthReconciliation(
      readDeps(),
      on('2026-10-01', USER_B),
      SEPTEMBER,
    );
    // No positions, no flows: no bucket at all, rather than someone else's.
    expect(result.buckets).toEqual([]);
    expect(result.status).toBe('reliable');
  });

  it('refuses a month that is not over', async () => {
    await expect(
      getMonthReconciliation(readDeps(), on('2026-09-30'), SEPTEMBER),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('an ordinary snapshot dated the first of the month', () => {
  beforeEach(async () => {
    await recordSeptember();
    // Quick Update writes exactly this row, and nothing about it is wrong: a
    // snapshot of what BBVA held on 1 September, entered as an ordinary balance.
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: bbva,
      valuedOn: '2026-09-01',
      amount: '8000.00',
      datePrecision: 'exact',
    });
  });

  it('opens the month on August, and moves no figure the month reports', async () => {
    const { result, bucket } = await eurBucket();
    const bbvaState = bucket?.accounts.find((a) => a.positionId === bbva);

    // 8.1: `open(a, M) = close(a, M−1)`, so September opens on August's
    // statement balance. The snapshot is September's own and belongs to neither
    // endpoint, whichever day of the month it carries (8.8).
    expect(bbvaState?.openState).toBe('month_end');
    expect(bbvaState?.opening?.amount).toBe('8055');
    expect(bbvaState?.closing?.amount).toBe('9226');

    // Every figure of the block above, unchanged by the extra row.
    expect(bucket?.totals.cashDelta?.amount).toBe('1402');
    expect(bucket?.totals.trackedTotalSpending?.amount).toBe('698');
    expect(bucket?.totals.unclassified?.amount).toBe('398');
    expect(bbvaState?.residual?.amount).toBe('-429');
    expect(result.status).toBe('reliable');
  });
});

describe('a month whose statement balance is missing', () => {
  it('is unavailable, names the account and reports no figure', async () => {
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: bbva,
      valuedOn: '2026-08-31',
      amount: '8055.00',
      datePrecision: 'month_end',
    });
    await createIncomeEntry(deps(), on('2026-09-25'), {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    const { result, bucket } = await eurBucket();
    expect(result.status).toBe('unavailable');
    expect(bucket?.totals.cashDelta).toBeNull();
    expect(bucket?.totals.trackedTotalSpending).toBeNull();
    expect(bucket?.totals.unclassified).toBeNull();

    // 8.9: the role sums are sums of source records and need no balance
    // evidence, so the salary is still 2,100 and the absent spending figure is
    // the only thing that says the month cannot be reconciled. `0` here would
    // have thrown away a number the user entered.
    expect(bucket?.totals.externalInflows.amount).toBe('2100');
    expect(bucket?.totals.knownTrackedExpenses.amount).toBe('0');

    // Both accounts lack a September statement — BBVA has only August's, and
    // Savings has nothing at all — and each is named in its own issue rather
    // than the month simply saying "something is missing".
    const missing = bucket?.issues.filter((i) => i.key === 'missing_month_end') ?? [];
    expect(missing.every((i) => i.class === 'blocking')).toBe(true);
    expect(new Set(missing.map((i) => i.positionName))).toEqual(
      new Set(['BBVA', 'Savings']),
    );
  });
});

describe('a first-balance account inside an unavailable month', () => {
  it('keeps its attributed income out of the sums', async () => {
    // 8.1 excludes a `first_balance` account and its attributed flow legs from
    // the month. Another account losing its statement makes the bucket
    // unavailable; it does not bring the excluded leg back.
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: bbva,
      valuedOn: '2026-08-31',
      amount: '8055.00',
      datePrecision: 'month_end',
    });
    await createIncomeEntry(deps(), on('2026-09-25'), {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    const brokerage = await createCashAccount(harness.services.positions, OCTOBER_1, {
      name: 'Brokerage cash',
      currency: 'EUR',
      accountType: 'brokerage_cash',
      openedOn: null,
    });
    await createIncomeEntry(deps(), on('2026-09-10'), {
      kind: 'interest',
      receivedOn: '2026-09-10',
      netAmount: '500.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: brokerage.id,
    });
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: brokerage.id,
      valuedOn: '2026-09-30',
      amount: '500.00',
      datePrecision: 'month_end',
    });

    const { result, bucket } = await eurBucket();
    expect(result.status).toBe('unavailable');
    // BBVA's salary only. The 500 on the newly tracked account is excluded with
    // the account, exactly as it would be in a month that reconciled.
    expect(bucket?.totals.externalInflows.amount).toBe('2100');
    expect(bucket?.totals.trackedTotalSpending).toBeNull();

    const excluded = bucket?.accounts.find((a) => a.positionId === brokerage.id);
    expect(excluded?.excludedFirstBalance).toBe(true);
    expect(bucket?.issues.some((i) => i.key === 'first_balance')).toBe(true);
  });
});

describe('a forgotten salary', () => {
  it('is unresolved with a blocking unexplained inflow', async () => {
    await recordSeptember({ withSalary: false });

    const { result, bucket } = await eurBucket();
    expect(result.status).toBe('unresolved');
    // Total = 0 + 200 − 200 − 1,402 = −1,402; unclassified = −1,702.
    expect(bucket?.totals.trackedTotalSpending?.amount).toBe('-1402');
    const issue = bucket?.issues.find((i) => i.key === 'unexplained_inflow');
    expect(issue?.amount?.amount).toBe('1702');
    expect(issue?.class).toBe('blocking');
  });
});

describe('historical recurring completeness', () => {
  async function salaryTemplate(): Promise<{ id: string; version: number }> {
    const created = await createTemplate(deps(), OCTOBER_1, {
      kind: 'income',
      name: 'Salary',
      incomeKind: 'employment',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 25,
      startDate: '2026-01-01',
      cashPositionId: bbva,
      // The opening term, effective from the schedule's own start — which is
      // eight months before the month under test, and still the term in force.
      amount: '2100.00',
    });
    return { id: created.template.id, version: created.template.version };
  }

  beforeEach(async () => {
    await recordSeptember({ withSalary: false });
  });

  it('reports the occurrence nothing accounted for, with the term amount', async () => {
    const template = await salaryTemplate();

    const { bucket } = await eurBucket();
    const issue = bucket?.issues.find((i) => i.key === 'suggested_income_missing');
    expect(issue?.templateId).toBe(template.id);
    expect(issue?.occurrenceDate).toBe('2026-09-25');
    expect(issue?.class).toBe('advisory');
    // 30.9 item 4: the term in force at the occurrence, which was set in
    // January and is still what September was worth.
    expect(issue?.expectedAmount?.amount).toBe('2100');
  });

  it('says nothing once the occurrence carries a flow', async () => {
    const template = await salaryTemplate();
    await acceptSuggestion(deps(), on('2026-09-25'), {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
    });

    const { bucket } = await eurBucket();
    expect(bucket?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(false);
  });

  it('says nothing once the occurrence is explicitly skipped', async () => {
    const template = await salaryTemplate();
    await skipSuggestion(deps(), on('2026-09-25'), {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
      reason: 'skipped',
    });

    const { bucket } = await eurBucket();
    expect(bucket?.issues.some((i) => i.key === 'suggested_income_missing')).toBe(false);
  });

  it('is not resolved by a skip belonging to another month', async () => {
    // The occurrence identity is `(template_id, occurrence_date)`, and the
    // loader is bounded by the month it was asked about. Skipping August says
    // nothing about September.
    const template = await salaryTemplate();
    await skipSuggestion(deps(), on('2026-08-25'), {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      reason: 'skipped',
    });

    const { bucket } = await eurBucket();
    const issue = bucket?.issues.find((i) => i.key === 'suggested_income_missing');
    expect(issue?.occurrenceDate).toBe('2026-09-25');
  });

  it('still expects the occurrence after the template is archived', async () => {
    // v2.1.7 §30.10: archiving is present-tense visibility. Tidying up in
    // October must not erase a genuinely missing September salary — which is
    // exactly what using the active-suggestion loader here would do.
    const template = await salaryTemplate();
    await archiveTemplate(deps(), OCTOBER_1, {
      templateId: template.id,
      expectedVersion: template.version,
    });

    const { bucket } = await eurBucket();
    const issue = bucket?.issues.find((i) => i.key === 'suggested_income_missing');
    expect(issue?.templateId).toBe(template.id);
    expect(issue?.occurrenceDate).toBe('2026-09-25');
  });
});

describe('an account first tracked in the month', () => {
  it('is excluded, the month is estimated, and spending is unaffected', async () => {
    // 8.8: BBVA → the new account 5,000, where the new account's first balance
    // lands in September. Only BBVA's `Nout` counts, against BBVA's own Δ of
    // −5,000, so tracked spending is exactly zero.
    const brokerage = await createCashAccount(harness.services.positions, OCTOBER_1, {
      name: 'Brokerage cash',
      currency: 'EUR',
      accountType: 'brokerage_cash',
      openedOn: null,
    });

    // Savings is untouched all month, and still needs both statement balances:
    // an account with no evidence would make the whole bucket unavailable.
    for (const [positionId, valuedOn] of [
      [bbva, '2026-08-31'],
      [savings, '2026-08-31'],
      [savings, '2026-09-30'],
    ] as const) {
      await recordValuation(harness.services.positions, OCTOBER_1, {
        positionId,
        valuedOn,
        amount: positionId === bbva ? '8055.00' : '8509.00',
        datePrecision: 'month_end',
      });
    }

    await createCashTransfer(deps(), on('2026-09-05'), {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: brokerage.id,
      fromAmount: '5000.00',
      toAmount: '5000.00',
    });
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: bbva,
      valuedOn: '2026-09-30',
      amount: '3055.00',
      datePrecision: 'month_end',
    });
    await recordValuation(harness.services.positions, OCTOBER_1, {
      positionId: brokerage.id,
      valuedOn: '2026-09-30',
      amount: '5000.00',
      datePrecision: 'month_end',
    });

    const { result, bucket } = await eurBucket();
    expect(result.status).toBe('estimated');
    expect(bucket?.totals.trackedTotalSpending?.amount).toBe('0');

    const excluded = bucket?.accounts.find((a) => a.positionId === brokerage.id);
    expect(excluded?.excludedFirstBalance).toBe(true);
    expect(excluded?.included).toBe(false);
    expect(excluded?.opening).toBeNull();
    expect(bucket?.issues.find((i) => i.key === 'first_balance')?.class).toBe('info');
  });
});

describe('the pre-classified leg seam', () => {
  it('is empty on every production load', async () => {
    // The seam exists for records a later phase will own — a mortgage payment
    // whose principal is `Nout` and whose interest is `K`, an investment
    // contribution's cash leg — and for the pure golden that has to contain
    // both. Phase 3 has no table for either, so its loader supplies none, and
    // there is no request shape that could.
    await recordSeptember();

    const data = await loadCompletedMonth(readDeps(), USER_A, SEPTEMBER, '2026-10-01');
    expect(data.input.preClassifiedLegs ?? []).toEqual([]);
  });

  it('is reachable from the engine input alone, never from a request', async () => {
    // `getMonthReconciliation` takes a month and nothing else: a caller cannot
    // hand it a leg, and no action or DTO carries one. The classification of a
    // user's record into I/Nin/Nout/K stays inside the role matrix, computed
    // from the record's own fields (7.4).
    await recordSeptember();

    const result = await getMonthReconciliation(readDeps(), OCTOBER_1, SEPTEMBER);
    expect(getMonthReconciliation.length).toBe(3);
    expect(Object.keys(result)).toEqual(['month', 'status', 'buckets']);
  });
});
