import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, createOtherAsset } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { createTemplate } from '../../src/recurring/templates';
import { createFxService } from '../../src/fx/service';
import { ValidationError } from '../../src/errors';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';
import {
  getMonthReportingCashFlow,
  getMonthToDateReportingCashFlow,
} from '../../src/reconciliation/reporting-service';
import { getMonthCompleteness } from '../../src/reconciliation/completeness-service';
import { getMonthToDate } from '../../src/reconciliation/mtd-service';
import { getMonthlyPage, type MonthlyDependencies } from '../../src/monthly/service';
import {
  dismissMonthAdvisory,
  markMonthReviewed,
  readMonthReview,
  restoreMonthAdvisory,
} from '../../src/monthly/review-service';
import type { CompletedMonthlyPageDto, CurrentMonthlyPageDto } from '../../src/monthly/types';

/**
 * The Monthly page's read and its review state, against a real database
 * (blueprint 15.2, 15.3, 20.3, 21.3).
 *
 * September 2026 is the completed month, read on 1 October; the current-month
 * cases sit on 10 September. Three things are pinned here:
 *
 *  - **Review state is presentation state.** Marking a month reviewed and
 *    dismissing an advisory change no reconciliation, reporting figure or
 *    completeness result — the canonical reads answer the same before and after.
 *  - **The composite read is the standalone reads.** Each part of the page is
 *    compared with the read that owns it, over months that exercise the frozen
 *    advisories and the reporting partials.
 *  - **The read is bounded** by a constant number of repository transactions.
 */

const USER_A = '12121212-1212-4212-8212-121212121212';
const USER_B = '34343434-3434-4434-8434-343434343434';

let harness: Harness;
let groceries: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const OCT_1 = on('2026-10-01');
const SEPT_10 = on('2026-09-10');
const SEPTEMBER = parseMonth('2026-09');
const OCTOBER = parseMonth('2026-10');
const NOVEMBER = parseMonth('2026-11');

const flowDeps = () => harness.services.flows;
const readDeps = (): MonthlyDependencies => ({ db: harness.db, fx: harness.services.fx });
const reviewDeps = () => ({ db: harness.db });

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function makeAccount(
  name: string,
  options: { currency?: string; accountType?: 'checking' | 'savings'; ctx?: RequestContext } = {},
): Promise<string> {
  const created = await createCashAccount(harness.services.positions, options.ctx ?? OCT_1, {
    name,
    currency: options.currency ?? 'EUR',
    accountType: options.accountType ?? 'checking',
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
  recordValuation(harness.services.positions, on(valuedOn), {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'exact',
  });

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

/** Month ends from March to September 2026, in order. */
const ENDS = [
  '2026-02-28',
  '2026-03-31',
  '2026-04-30',
  '2026-05-31',
  '2026-06-30',
  '2026-07-31',
  '2026-08-31',
  '2026-09-30',
] as const;

/** Exact decimal-string subtraction at two decimals. */
function subtract(a: string, b: string): string {
  const cents = (s: string): number => Math.round(Number(s) * 100);
  return ((cents(a) - cents(b)) / 100).toFixed(2);
}

/**
 * A reliable September whose one issue is 8.5's `possible_missing_interest`
 * advisory: a savings account's residual is a small positive amount under half
 * a percent of its balance, and an everyday account's spending keeps the
 * bucket's unclassified positive (−100 + 10 → 90).
 */
async function interestMonth(): Promise<string> {
  const savings = await makeAccount('Savings', { accountType: 'savings' });
  await statement(savings, '2026-08-31', '10000.00');
  await statement(savings, '2026-09-30', '10010.00');
  const everyday = await makeAccount('Everyday');
  await statement(everyday, '2026-08-31', '2000.00');
  await statement(everyday, '2026-09-30', '1900.00');
  return savings;
}

const completed = async (ctx: RequestContext = OCT_1): Promise<CompletedMonthlyPageDto> => {
  const page = await getMonthlyPage(readDeps(), ctx, SEPTEMBER);
  if (page.kind !== 'completed') throw new Error('expected a completed month');
  return page;
};

const current = async (ctx: RequestContext = SEPT_10): Promise<CurrentMonthlyPageDto> => {
  const page = await getMonthlyPage(readDeps(), ctx, SEPTEMBER);
  if (page.kind !== 'current') throw new Error('expected the current month');
  return page;
};

/** The `month_reviews` audit trail of user A, oldest first, read as the table owner. */
async function auditRows(): Promise<{ action: string; before: unknown; after: unknown }[]> {
  const client = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
  await client.connect();
  try {
    const result = await client.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_entries
        WHERE entity_table = 'month_reviews' AND user_id = $1
        ORDER BY occurred_at, id`,
      [USER_A],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'monthly-a@example.test'],
    [USER_B, 'monthly-b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.name === 'Groceries')?.id as string;
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
/* Review state                                                               */
/* -------------------------------------------------------------------------- */

describe('the review mark', () => {
  it('reads an absent row as unreviewed with nothing dismissed', async () => {
    expect(await readMonthReview(reviewDeps(), OCT_1, SEPTEMBER)).toEqual({
      reviewedAt: null,
      dismissedIssueKeys: [],
    });
    expect((await completed()).review).toEqual({ reviewedAt: null, dismissedIssueKeys: [] });
  });

  it('marks a completed month reviewed, audited as an insert', async () => {
    const review = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    expect(review.reviewedAt).not.toBeNull();
    expect((await completed()).review.reviewedAt).toBe(review.reviewedAt);

    const audit = await auditRows();
    expect(audit.map((row) => row.action)).toEqual(['insert']);
    expect(audit[0]?.after).toMatchObject({ month: '2026-09-01', dismissedIssues: [] });
  });

  it('refuses the current month, on its last day too, and a month not yet begun', async () => {
    await expect(markMonthReviewed(reviewDeps(), OCT_1, OCTOBER)).rejects.toBeInstanceOf(ValidationError);
    await expect(markMonthReviewed(reviewDeps(), on('2026-09-30'), SEPTEMBER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(markMonthReviewed(reviewDeps(), OCT_1, NOVEMBER)).rejects.toBeInstanceOf(ValidationError);
    expect(await auditRows()).toEqual([]);
  });

  it('is allowed whatever the month’s reconciliation status and completeness', async () => {
    // BBVA has August's statement and none for September: unavailable, incomplete.
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    const before = await completed();
    expect(before.reconciliation.status).toBe('unavailable');
    expect(before.completeness.state).toBe('stale');

    const review = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    expect(review.reviewedAt).not.toBeNull();
  });

  it('is idempotent: marking again keeps the first time and writes nothing', async () => {
    const first = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    const second = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    expect(second.reviewedAt).toBe(first.reviewedAt);
    expect((await auditRows()).map((row) => row.action)).toEqual(['insert']);
  });

  it('keeps the dismissed keys and the note', async () => {
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    await harness.asOwner(`UPDATE month_reviews SET notes = 'Checked against the paper statement'`);

    const review = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    expect(review.dismissedIssueKeys).toEqual(['possible_missing_interest']);

    const audit = await auditRows();
    expect(audit.at(-1)?.action).toBe('update');
    expect(audit.at(-1)?.after).toMatchObject({
      notes: 'Checked against the paper statement',
      dismissedIssues: ['possible_missing_interest'],
    });
  });
});

describe('dismissing and restoring an advisory', () => {
  it('hides a known advisory key, once, and restores it', async () => {
    const first = await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    expect(first.dismissedIssueKeys).toEqual(['possible_missing_interest']);

    const again = await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    expect(again.dismissedIssueKeys).toEqual(['possible_missing_interest']);
    expect((await auditRows()).map((row) => row.action)).toEqual(['insert']);

    const restored = await restoreMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    expect(restored.dismissedIssueKeys).toEqual([]);
    expect((await auditRows()).map((row) => row.action)).toEqual(['insert', 'update']);
  });

  it('keeps the review mark and the note', async () => {
    const reviewed = await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    await harness.asOwner(`UPDATE month_reviews SET notes = 'kept'`);

    const dismissed = await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'large_unclassified');
    expect(dismissed.reviewedAt).toBe(reviewed.reviewedAt);
    const restored = await restoreMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'large_unclassified');
    expect(restored.reviewedAt).toBe(reviewed.reviewedAt);
    expect((await auditRows()).at(-1)?.after).toMatchObject({ notes: 'kept' });
  });

  it('refuses a blocking key, an info key and a key the catalogue does not have', async () => {
    for (const key of ['missing_month_end', 'unexplained_inflow', 'flow_without_cash_account', 'mtd_no_common_date']) {
      await expect(dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, key)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'first_balance')).rejects.toBeInstanceOf(
      ValidationError,
    );
    for (const key of ['not_an_issue', 'constructor', 'toString', '__proto__']) {
      await expect(dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, key)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(restoreMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, key)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await auditRows()).toEqual([]);
  });

  it('is allowed for the current month and refused for one not yet begun', async () => {
    const dismissed = await dismissMonthAdvisory(reviewDeps(), OCT_1, OCTOBER, 'mtd_newer_balances');
    expect(dismissed.dismissedIssueKeys).toEqual(['mtd_newer_balances']);
    await expect(
      dismissMonthAdvisory(reviewDeps(), OCT_1, NOVEMBER, 'mtd_newer_balances'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      restoreMonthAdvisory(reviewDeps(), OCT_1, NOVEMBER, 'mtd_newer_balances'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps stored keys it does not know, and never duplicates one', async () => {
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    // A key a later phase might write, and a duplicate, stored out of band.
    await harness.asOwner(
      `UPDATE month_reviews SET dismissed_issues = '["stale_property", "possible_missing_interest", "stale_property"]'::jsonb`,
    );

    const added = await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'large_unclassified');
    expect(added.dismissedIssueKeys).toEqual([
      'large_unclassified',
      'possible_missing_interest',
      'stale_property',
    ]);

    const restored = await restoreMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    expect(restored.dismissedIssueKeys).toEqual(['large_unclassified', 'stale_property']);
  });

  it('writes no row when restoring in a month that has none', async () => {
    const restored = await restoreMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    expect(restored).toEqual({ reviewedAt: null, dismissedIssueKeys: [] });
    expect(await auditRows()).toEqual([]);
  });

  it('refuses to rewrite a stored value that is not a list of keys', async () => {
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');
    await harness.asOwner(`UPDATE month_reviews SET dismissed_issues = '{"not": "a list"}'::jsonb`);

    await expect(
      dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'large_unclassified'),
    ).rejects.toThrow(/not an array of strings/u);
  });
});

describe('another user', () => {
  it('neither sees nor changes this user’s review', async () => {
    await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');

    const asB = on('2026-10-01', USER_B);
    expect(await readMonthReview(reviewDeps(), asB, SEPTEMBER)).toEqual({
      reviewedAt: null,
      dismissedIssueKeys: [],
    });
    await restoreMonthAdvisory(reviewDeps(), asB, SEPTEMBER, 'possible_missing_interest');
    await dismissMonthAdvisory(reviewDeps(), asB, SEPTEMBER, 'large_unclassified');

    const mine = await readMonthReview(reviewDeps(), OCT_1, SEPTEMBER);
    expect(mine.reviewedAt).not.toBeNull();
    expect(mine.dismissedIssueKeys).toEqual(['possible_missing_interest']);
    expect((await readMonthReview(reviewDeps(), asB, SEPTEMBER)).dismissedIssueKeys).toEqual([
      'large_unclassified',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Presentation state changes no canonical result                             */
/* -------------------------------------------------------------------------- */

describe('the canonical results', () => {
  it('are the same before and after a month is reviewed and an advisory dismissed', async () => {
    await interestMonth();
    const reconciliation = await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER);
    const reporting = await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER);
    const completeness = await getMonthCompleteness(readDeps(), OCT_1, SEPTEMBER);
    expect(reconciliation.buckets[0]?.issues.map((issue) => issue.key)).toEqual([
      'possible_missing_interest',
    ]);

    await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'possible_missing_interest');

    expect(await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER)).toEqual(reconciliation);
    expect(await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER)).toEqual(reporting);
    expect(await getMonthCompleteness(readDeps(), OCT_1, SEPTEMBER)).toEqual(completeness);

    // The page carries the dismissal beside the result, never inside it.
    const page = await completed();
    expect(page.reconciliation).toEqual(reconciliation);
    expect(page.review.dismissedIssueKeys).toEqual(['possible_missing_interest']);
  });

  it('keeps a month that is missing evidence incomplete after it is reviewed', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await snapshot(bbva, '2026-09-15', '950.00');

    await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    const page = await completed();
    expect(page.completeness.state).toBe('incomplete');
    expect(page.reconciliation.status).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/* The composite read is the standalone reads                                  */
/* -------------------------------------------------------------------------- */

async function expectCompletedParity(): Promise<CompletedMonthlyPageDto> {
  const page = await completed();
  expect(page.reconciliation).toEqual(await getMonthReconciliation(readDeps(), OCT_1, SEPTEMBER));
  expect(page.reporting).toEqual(await getMonthReportingCashFlow(readDeps(), OCT_1, SEPTEMBER));
  expect(page.completeness).toEqual(await getMonthCompleteness(readDeps(), OCT_1, SEPTEMBER));
  return page;
}

describe('a completed month, compared with the reads that own each part', () => {
  it('a reliable month with income, an expense and an interest advisory', async () => {
    const savings = await interestMonth();
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '2000.00');
    await createIncomeEntry(flowDeps(), OCT_1, {
      kind: 'employment',
      receivedOn: '2026-09-25',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await createExpenseEntry(flowDeps(), OCT_1, {
      categoryId: groceries,
      incurredOn: '2026-09-12',
      amount: '300.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await statement(bbva, '2026-09-30', '3500.00');

    const page = await expectCompletedParity();
    expect(page.reconciliation.status).toBe('reliable');
    expect(page.reporting.savingsRate.kind).toBe('ratio');
    expect(page.completeness.state).toBe('sufficient');
    expect(page.minorUnitsByCurrency['EUR']).toBe(2);
    expect(savings).toBeTruthy();
  });

  it('an unavailable month with a missing statement', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await snapshot(bbva, '2026-09-20', '900.00');

    const page = await expectCompletedParity();
    expect(page.reconciliation.status).toBe('unavailable');
    expect(page.reporting.unclassified.availability).toBe('unavailable');
    expect(page.completeness.state).toBe('incomplete');
  });

  it('an unresolved month whose cash grew more than its records explain', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '1500.00');

    const page = await expectCompletedParity();
    expect(page.reconciliation.status).toBe('unresolved');
    const issue = page.reconciliation.buckets[0]?.issues.find((item) => item.key === 'unexplained_inflow');
    expect(issue?.variant).toBe('a');
  });

  it('a month with the large-unclassified advisory, from its six-month baseline', async () => {
    const bbva = await makeAccount('BBVA');
    let running = '5000.00';
    await statement(bbva, ENDS[0], running);
    for (const end of ENDS.slice(1, -1)) {
      running = subtract(running, '10.00');
      await statement(bbva, end, running);
    }
    await statement(bbva, ENDS[ENDS.length - 1] as string, subtract(running, '100.00'));

    const page = await expectCompletedParity();
    expect(page.reconciliation.buckets[0]?.issues.map((issue) => issue.key)).toContain(
      'large_unclassified',
    );
  });

  it('a month with the possible-missing-conversion advisory, from stored rates only', async () => {
    const eur = await makeAccount('BBVA');
    const usd = await makeAccount('Dollars', { currency: 'USD' });
    await statement(eur, '2026-08-31', '1000.00');
    await statement(eur, '2026-09-30', '2000.00');
    await statement(usd, '2026-08-31', '10000.00');
    await statement(usd, '2026-09-30', '8900.00');
    await harness.asOwner('DELETE FROM fx_rates');
    await rate('USD', '2026-09-10', '1.08');
    await rate('USD', '2026-09-20', '1.10');

    const page = await expectCompletedParity();
    const eurBucket = page.reconciliation.buckets.find((bucket) => bucket.currency === 'EUR');
    expect(eurBucket?.issues.map((issue) => issue.key)).toContain('possible_missing_conversion');
  });

  it('a two-currency month whose reporting figures are partial for want of a rate', async () => {
    const eur = await makeAccount('BBVA');
    const usd = await makeAccount('Dollars', { currency: 'USD' });
    await statement(eur, '2026-08-31', '1000.00');
    await statement(eur, '2026-09-30', '900.00');
    await statement(usd, '2026-08-31', '500.00');
    await statement(usd, '2026-09-30', '450.00');
    await harness.asOwner('DELETE FROM fx_rates');

    const page = await expectCompletedParity();
    expect(page.reporting.trackedTotalSpending.availability).toBe('partial');
    expect(page.reporting.trackedTotalSpending.missing.map((item) => item.currency)).toContain('USD');
    expect(page.minorUnitsByCurrency['USD']).toBe(2);
  });
});

describe('the current month, compared with the month-to-date reads', () => {
  async function expectCurrentParity(): Promise<CurrentMonthlyPageDto> {
    const page = await current();
    expect(page.monthToDate).toEqual(await getMonthToDate(readDeps(), SEPT_10));
    expect(page.reporting).toEqual(await getMonthToDateReportingCashFlow(readDeps(), SEPT_10));
    expect(Object.keys(page)).not.toContain('completeness');
    return page;
  }

  async function twoAccounts(): Promise<[string, string]> {
    const a = await makeAccount('BBVA', { ctx: SEPT_10 });
    const b = await makeAccount('Savings', { ctx: SEPT_10 });
    await recordValuation(harness.services.positions, SEPT_10, {
      positionId: a,
      valuedOn: '2026-08-31',
      amount: '1000.00',
      datePrecision: 'month_end',
    });
    await recordValuation(harness.services.positions, SEPT_10, {
      positionId: b,
      valuedOn: '2026-08-31',
      amount: '500.00',
      datePrecision: 'month_end',
    });
    return [a, b];
  }

  it('with a common date every account shares', async () => {
    const [a, b] = await twoAccounts();
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '500.00');

    const page = await expectCurrentParity();
    expect(page.monthToDate.asOf).toBe('2026-09-06');
    expect(page.reporting.kind).toBe('tracked_interval');
  });

  it('with a newer individual balance after the common date', async () => {
    const [a, b] = await twoAccounts();
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-06', '500.00');
    await snapshot(a, '2026-09-08', '850.00');

    const page = await expectCurrentParity();
    expect(page.monthToDate.asOf).toBe('2026-09-06');
    expect(page.monthToDate.issues.map((issue) => issue.key)).toContain('mtd_newer_balances');
  });

  it('with no common date at all', async () => {
    const [a, b] = await twoAccounts();
    await snapshot(a, '2026-09-06', '900.00');
    await snapshot(b, '2026-09-03', '500.00');
    await createExpenseEntry(flowDeps(), SEPT_10, {
      categoryId: groceries,
      incurredOn: '2026-09-05',
      amount: '12.00',
      currency: 'EUR',
      settlement: 'untracked_self',
    });

    const page = await expectCurrentParity();
    expect(page.monthToDate.asOf).toBeNull();
    expect(page.monthToDate.buckets).toBeNull();
    expect(page.reporting.kind).toBe('no_tracked_interval');
  });
});

describe('the month and its neighbours', () => {
  it('refuses a month that has not begun rather than inventing an empty one', async () => {
    await expect(getMonthlyPage(readDeps(), OCT_1, NOVEMBER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('offers the previous month always and the next one only up to the current month', async () => {
    const september = await completed();
    expect(september.navigation).toEqual({ previous: '2026-08', next: '2026-10', current: '2026-10' });
    expect(september.month).toBe('2026-09');
    expect(september.monthEndsOn).toBe('2026-09-30');

    const october = await getMonthlyPage(readDeps(), OCT_1, OCTOBER);
    expect(october.kind).toBe('current');
    expect(october.navigation).toEqual({ previous: '2026-09', next: null, current: '2026-10' });
  });
});

/* -------------------------------------------------------------------------- */
/* The read's bound                                                            */
/* -------------------------------------------------------------------------- */

/**
 * User-scoped repository transactions — every `db.transaction` invocation,
 * which is what each `withUser` scope and each global-table read opens — for
 * one run of the page's read. Not SQL statements: a scope sets the tenant and
 * may run several. The FX service is built over the same counting handle so
 * its reads are counted like any other.
 */
async function countTransactions(ctx: RequestContext, month = SEPTEMBER): Promise<number> {
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
  const fx = createFxService({ db: counting, provider: harness.fxProvider });
  await getMonthlyPage({ db: counting, fx }, ctx, month);
  return transactions;
}

describe('the repository transaction count is bounded by a constant', () => {
  it('does not grow with the completed month’s accounts, flows, templates or review state', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    const small = await countTransactions(OCT_1);

    for (const name of ['Savings', 'Joint', 'Cash box']) {
      const id = await makeAccount(name);
      await statement(id, '2026-08-31', '100.00');
      await statement(id, '2026-09-30', '100.00');
    }
    for (let index = 0; index < 6; index += 1) {
      await createExpenseEntry(flowDeps(), OCT_1, {
        categoryId: groceries,
        incurredOn: '2026-09-05',
        amount: '1.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      });
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
    await createOtherAsset(harness.services.positions, OCT_1, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
      currentValue: '9000.00',
      currentValueOn: '2026-09-10',
    });
    await markMonthReviewed(reviewDeps(), OCT_1, SEPTEMBER);
    await dismissMonthAdvisory(reviewDeps(), OCT_1, SEPTEMBER, 'suggested_income_missing');

    // One more with templates in the month: their terms come back in one batched
    // scope, however many templates there are.
    const large = await countTransactions(OCT_1);
    expect(large).toBe(small + 1);
    // Named, so a regression that adds a scope per account or per template is
    // visible rather than merely "the same as before": the range loader's seven,
    // settings, the currency catalogue and the review. A euro-only month in a
    // euro reporting currency needs no stored rate, so the rate read returns
    // without opening one.
    expect(small).toBe(10);
  });

  it('reads rates once for the whole month, however many currencies it holds', async () => {
    const bbva = await makeAccount('BBVA');
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    for (const id of [bbva, dollars]) {
      await statement(id, '2026-08-31', '1000.00');
      await statement(id, '2026-09-30', '900.00');
    }
    const two = await countTransactions(OCT_1);
    // The euro-only ten, plus the one rate read reporting makes for every
    // foreign currency together. Both buckets spent, so no missing-conversion
    // signature exists and the diagnostic reads nothing.
    expect(two).toBe(11);

    for (const currency of ['GBP', 'CHF']) {
      const id = await makeAccount(`In ${currency}`, { currency });
      await statement(id, '2026-08-31', '100.00');
      await statement(id, '2026-09-30', '90.00');
    }
    expect(await countTransactions(OCT_1)).toBe(two);
  });

  it('does not grow with the current month’s accounts or flows', async () => {
    const a = await makeAccount('BBVA', { ctx: SEPT_10 });
    await snapshot(a, '2026-09-06', '900.00');
    const small = await countTransactions(SEPT_10);

    for (const name of ['Savings', 'Joint']) {
      const id = await makeAccount(name, { ctx: SEPT_10 });
      await snapshot(id, '2026-09-06', '100.00');
    }
    for (let index = 0; index < 6; index += 1) {
      await createExpenseEntry(flowDeps(), SEPT_10, {
        categoryId: groceries,
        incurredOn: '2026-09-05',
        amount: '1.00',
        currency: 'EUR',
        settlement: 'untracked_self',
      });
    }

    expect(await countTransactions(SEPT_10)).toBe(small);
    // The month-to-date loader's five, settings, the currency catalogue and the
    // review; euro-only, so no rate read opens a scope.
    expect(small).toBe(8);
  });
});
