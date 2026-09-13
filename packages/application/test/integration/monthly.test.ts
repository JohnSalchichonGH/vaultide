import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, withoutUser, type Database } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import {
  closePosition,
  createCashAccount,
  createOtherAsset,
  updateCashAccount,
} from '../../src/positions/service';
import {
  confirmMonthEnd,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  positionHistory,
  quickUpdate,
  recordValuation,
} from '../../src/positions/valuations';
import { getNetWorth } from '../../src/positions/queries';
import { listCategories } from '../../src/users/categories';
import { createExpenseEntry } from '../../src/flows/expenses';
import { createIncomeEntry } from '../../src/flows/income';
import { archiveTemplate, createTemplate, setTemplateTerm } from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion } from '../../src/recurring/suggestions';
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
 * A handle that counts user-scoped repository transactions — every
 * `db.transaction` invocation, which is what each `withUser` scope and each
 * global-table read opens. Not SQL statements: one scope sets the tenant and may
 * run several.
 */
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

/**
 * The one user-scoped transaction Monthly's Known-expenses section adds to every
 * kind of month (15.3 section 3).
 *
 * Kept apart from the figures it joined, so each named baseline below still
 * reads as what the page opened before that section — and the section's cost is
 * stated once, as exactly one scope, rather than folded into a new magic number.
 */
const KNOWN_EXPENSES_SCOPE = 1;

/**
 * The transactions one run of the page's read opens. The FX service is built
 * over the same counting handle, so its reads are counted like any other.
 */
async function countTransactions(ctx: RequestContext, month = SEPTEMBER): Promise<number> {
  const counting = countingDatabase();
  const fx = createFxService({ db: counting.db, provider: harness.fxProvider });
  await getMonthlyPage({ db: counting.db, fx }, ctx, month);
  return counting.transactions();
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
    // the Income section's one, settings, the currency catalogue and the review —
    // and the Known-expenses section's one on top. A euro-only month in a euro
    // reporting currency needs no stored rate, so the rate read returns without
    // opening one.
    expect(small).toBe(11 + KNOWN_EXPENSES_SCOPE);
  });

  it('reads rates once for the whole month, however many currencies it holds', async () => {
    const bbva = await makeAccount('BBVA');
    const dollars = await makeAccount('Dollars', { currency: 'USD' });
    for (const id of [bbva, dollars]) {
      await statement(id, '2026-08-31', '1000.00');
      await statement(id, '2026-09-30', '900.00');
    }
    const two = await countTransactions(OCT_1);
    // The euro-only eleven, plus the one rate read reporting makes for every
    // foreign currency together, plus the Known-expenses scope. Both buckets
    // spent, so no missing-conversion signature exists and the diagnostic reads
    // nothing.
    expect(two).toBe(12 + KNOWN_EXPENSES_SCOPE);

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
    // The month-to-date loader's five, the Income section's one, settings, the
    // currency catalogue and the review, and the Known-expenses section's one;
    // euro-only, so no rate read opens a scope. The Income scope runs several
    // statements — the month's occurrence entries and skips, the active sources,
    // everything resolved after today, the referenced sources and their terms —
    // inside that one transaction, and the Known-expenses scope does the same.
    expect(small).toBe(9 + KNOWN_EXPENSES_SCOPE);
  });
});

/* -------------------------------------------------------------------------- */
/* The Accounts section (15.3 section 4)                                       */
/* -------------------------------------------------------------------------- */

const positionDeps = () => harness.services.positions;

function accountNamed<T extends { readonly name: string }>(accounts: readonly T[], name: string): T {
  const found = accounts.find((account) => account.name === name);
  if (found === undefined) throw new Error(`no account named ${name}`);
  return found;
}

const completedAccount = async (name: string, ctx: RequestContext = OCT_1) =>
  accountNamed((await completed(ctx)).accounts.accounts, name);

const currentAccount = async (name: string, ctx: RequestContext = SEPT_10) =>
  accountNamed((await current(ctx)).accounts.accounts, name);

/** An account that opened empty on a known day (8.1 `opened_zero`). */
async function makeOpenedAccount(name: string, openedOn: string, ctx: RequestContext): Promise<string> {
  const created = await createCashAccount(positionDeps(), ctx, {
    name,
    currency: 'EUR',
    accountType: 'checking',
    openedOn,
  });
  return created.id;
}

/** A zero-balance account marked dormant, the only way it can be (6.2, R22). */
async function makeDormantAccount(name: string, zeroOn: string, ctx: RequestContext): Promise<string> {
  const id = await makeAccount(name, { ctx });
  await recordValuation(positionDeps(), ctx, {
    positionId: id,
    valuedOn: zeroOn,
    amount: '0',
    datePrecision: 'exact',
  });
  await updateCashAccount(positionDeps(), ctx, { positionId: id, expectedVersion: 1, isDormant: true });
  return id;
}

describe('a completed month’s Accounts section', () => {
  it('reads an ordinary month: the previous statement, and the current one with its version', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await statement(bbva, '2026-09-30', '7880.00');

    const page = await completed();
    expect(page.accounts.previousMonth).toBe('2026-08');
    const account = accountNamed(page.accounts.accounts, 'BBVA');
    expect(account).toMatchObject({
      positionId: bbva,
      currency: 'EUR',
      dormant: false,
      opening: { kind: 'statement', amount: { amount: '8055', currency: 'EUR' }, valuedOn: '2026-08-31' },
      closing: {
        kind: 'statement',
        version: 1,
        amount: { amount: '7880', currency: 'EUR' },
        confirmedUnchanged: false,
      },
    });
    expect(account.state).toMatchObject({ month: '2026-09', open: 'month_end', close: 'month_end', included: true });
  });

  it('carries the id and version a correction needs, and the version it replaced is refused afterwards', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await statement(bbva, '2026-09-30', '7880.00');

    const before = (await completedAccount('BBVA')).closing;
    if (before.kind !== 'statement') throw new Error('expected a statement');
    await correctValuation(positionDeps(), OCT_1, {
      valuationId: before.valuationId,
      expectedVersion: before.version,
      valuedOn: '2026-09-30',
      amount: '7890.00',
      datePrecision: 'month_end',
    });

    const after = (await completedAccount('BBVA')).closing;
    expect(after).toMatchObject({
      kind: 'statement',
      valuationId: before.valuationId,
      version: before.version + 1,
      amount: { amount: '7890', currency: 'EUR' },
    });

    // The page that still holds the old version cannot overwrite the new figure.
    await expect(
      correctValuation(positionDeps(), OCT_1, {
        valuationId: before.valuationId,
        expectedVersion: before.version,
        valuedOn: '2026-09-30',
        amount: '7000.00',
        datePrecision: 'month_end',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect((await completedAccount('BBVA')).closing).toMatchObject({ version: 2, amount: { amount: '7890' } });
  });

  it('offers a missing statement for entry, and "unchanged" because the month before is closed', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');

    const account = await completedAccount('BBVA');
    expect(account.closing).toEqual({
      kind: 'no_statement',
      state: 'carried',
      latestSnapshot: null,
      canConfirmUnchanged: true,
    });
    expect(account.state.included).toBe(false);

    // Entered exactly as the cell writes it: dated end(M), `month_end`.
    await recordValuation(positionDeps(), OCT_1, {
      positionId: bbva,
      valuedOn: '2026-09-30',
      amount: '8000.00',
      datePrecision: 'month_end',
    });
    expect((await completedAccount('BBVA')).closing).toMatchObject({
      kind: 'statement',
      version: 1,
      amount: { amount: '8000', currency: 'EUR' },
    });
  });

  it('shows an account with nothing recorded as unknown at both ends, with no amount anywhere', async () => {
    await makeAccount('Unvalued');

    const account = await completedAccount('Unvalued');
    expect(account.opening).toEqual({ kind: 'no_statement', state: 'missing' });
    expect(account.closing).toEqual({
      kind: 'no_statement',
      state: 'missing',
      latestSnapshot: null,
      canConfirmUnchanged: false,
    });
  });

  it('shows an ordinary snapshot inside the month only as a hint, never as the statement', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await snapshot(bbva, '2026-09-10', '8200.00');
    await snapshot(bbva, '2026-09-24', '8120.00');

    const account = await completedAccount('BBVA');
    expect(account.state.close).toBe('carried');
    expect(account.closing).toEqual({
      kind: 'no_statement',
      state: 'carried',
      latestSnapshot: { amount: { amount: '8120', currency: 'EUR' }, valuedOn: '2026-09-24' },
      canConfirmUnchanged: true,
    });
  });

  it('offers a last-day snapshot for confirmation, which upgrades that row and keeps its amount', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await snapshot(bbva, '2026-09-30', '7880.00');

    const closing = (await completedAccount('BBVA')).closing;
    expect(closing).toMatchObject({ kind: 'last_day_snapshot', version: 1, amount: { amount: '7880' } });
    if (closing.kind !== 'last_day_snapshot') throw new Error('expected a last-day snapshot');

    await confirmMonthEnd(positionDeps(), OCT_1, {
      valuationId: closing.valuationId,
      expectedVersion: closing.version,
    });

    expect((await completedAccount('BBVA')).closing).toMatchObject({
      kind: 'statement',
      valuationId: closing.valuationId,
      version: 2,
      amount: { amount: '7880', currency: 'EUR' },
    });
    // One row for the last day, the snapshot itself — nothing was duplicated (M1).
    const history = await positionHistory(positionDeps(), OCT_1, bbva);
    expect(history.filter((row) => row.valuedOn === '2026-09-30')).toHaveLength(1);
  });

  it('turns a last-day snapshot into the statement figure the user types, in the same row', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await snapshot(bbva, '2026-09-30', '7880.00');

    const closing = (await completedAccount('BBVA')).closing;
    if (closing.kind !== 'last_day_snapshot') throw new Error('expected a last-day snapshot');
    await correctValuation(positionDeps(), OCT_1, {
      valuationId: closing.valuationId,
      expectedVersion: closing.version,
      valuedOn: '2026-09-30',
      amount: '7875.50',
      datePrecision: 'month_end',
    });

    expect((await completedAccount('BBVA')).closing).toMatchObject({
      kind: 'statement',
      valuationId: closing.valuationId,
      amount: { amount: '7875.5', currency: 'EUR' },
    });
    const history = await positionHistory(positionDeps(), OCT_1, bbva);
    expect(history.filter((row) => row.valuedOn === '2026-09-30')).toHaveLength(1);
  });

  it('marks a month confirmed unchanged, at the previous statement’s exact amount', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.55');
    await confirmUnchanged(positionDeps(), OCT_1, { positionId: bbva, month: '2026-09' });

    expect((await completedAccount('BBVA')).closing).toMatchObject({
      kind: 'statement',
      version: 1,
      amount: { amount: '8055.55', currency: 'EUR' },
      confirmedUnchanged: true,
    });
  });

  it('opens an account opened in the month at zero by definition, and offers no "unchanged"', async () => {
    const fresh = await makeOpenedAccount('New savings', '2026-09-10', OCT_1);

    const before = await completedAccount('New savings');
    expect(before.opening).toEqual({ kind: 'opened_zero' });
    // Nothing before it opened to carry forward (8.1, R22).
    expect(before.closing).toMatchObject({ kind: 'no_statement', state: 'missing', canConfirmUnchanged: false });

    await statement(fresh, '2026-09-30', '500.00');
    const after = await completedAccount('New savings');
    expect(after.opening).toEqual({ kind: 'opened_zero' });
    expect(after.closing).toMatchObject({ kind: 'statement', amount: { amount: '500' } });
    expect(after.state.included).toBe(true);
  });

  it('closes an account closed in the month at zero by definition, with nothing to enter', async () => {
    const old = await makeAccount('Old bank');
    await statement(old, '2026-08-31', '100.00');
    await snapshot(old, '2026-09-15', '0');
    await closePosition(positionDeps(), OCT_1, { positionId: old, expectedVersion: 1, closedOn: '2026-09-15' });

    const account = await completedAccount('Old bank');
    expect(account.opening).toMatchObject({ kind: 'statement', amount: { amount: '100' } });
    expect(account.closing).toEqual({ kind: 'closed_zero' });
    expect(account.state).toMatchObject({ close: 'closed_zero', included: true });
  });

  it('carries a dormant account at zero at both ends, with nothing to enter or confirm', async () => {
    await makeDormantAccount('Dormant', '2026-07-10', OCT_1);

    const account = await completedAccount('Dormant');
    expect(account.dormant).toBe(true);
    expect(account.opening).toEqual({ kind: 'dormant_zero' });
    expect(account.closing).toEqual({ kind: 'dormant_zero' });
    expect(account.state.included).toBe(true);
  });

  it('keeps a pre-existing account first tracked in the month as a first balance, never an opening of zero', async () => {
    const found = await makeAccount('Found account');
    await statement(found, '2026-09-30', '3000.00');

    const account = await completedAccount('Found account');
    expect(account.opening).toEqual({ kind: 'first_balance' });
    expect(account.closing).toMatchObject({ kind: 'statement', amount: { amount: '3000' } });
    expect(account.state).toMatchObject({ firstBalance: true, included: false });
  });

  it('opens on the previous statement even when a snapshot sits on the month’s first day', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await snapshot(bbva, '2026-09-01', '8050.00');
    await statement(bbva, '2026-09-30', '7880.00');

    // 8.1: `open(a, M)` is `close(a, M−1)` — August's statement, whatever was
    // recorded inside September.
    expect((await completedAccount('BBVA')).opening).toEqual({
      kind: 'statement',
      amount: { amount: '8055', currency: 'EUR' },
      valuedOn: '2026-08-31',
    });
  });

  it('lists exactly the accounts taking part in the month, and states them as the Accounts pages do', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '8055.00');
    await snapshot(bbva, '2026-09-30', '7880.00');
    const found = await makeAccount('Found account');
    await statement(found, '2026-09-30', '3000.00');
    await makeDormantAccount('Dormant', '2026-07-10', OCT_1);
    await makeOpenedAccount('New savings', '2026-09-10', OCT_1);
    // Closed in August: not part of September at all.
    const gone = await makeAccount('Gone');
    await snapshot(gone, '2026-08-05', '0');
    await closePosition(positionDeps(), OCT_1, { positionId: gone, expectedVersion: 1, closedOn: '2026-08-05' });
    // Opened in October: not part of September either.
    await makeOpenedAccount('October account', '2026-10-01', OCT_1);
    // Not cash.
    await createOtherAsset(positionDeps(), OCT_1, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    });

    const accounts = (await completed()).accounts.accounts;
    expect(accounts.map((account) => account.name).sort()).toEqual([
      'BBVA',
      'Dormant',
      'Found account',
      'New savings',
    ]);

    // September is October 1st's last completed month, which is the state the
    // Accounts pages show — through the same helper, so it is the same object.
    const netWorth = await getNetWorth(positionDeps(), OCT_1);
    for (const account of accounts) {
      const position = netWorth.positions.find((item) => item.id === account.positionId);
      expect(account.state, account.name).toEqual(position?.lastCompletedMonth);
    }
  });
});

describe('the current month’s Accounts section', () => {
  async function withAugustStatement(name: string, amount = '1000.00'): Promise<string> {
    const id = await makeAccount(name, { ctx: SEPT_10 });
    await recordValuation(positionDeps(), SEPT_10, {
      positionId: id,
      valuedOn: '2026-08-31',
      amount,
      datePrecision: 'month_end',
    });
    return id;
  }

  it('shows the previous statement and the latest snapshot with its own date', async () => {
    const bbva = await withAugustStatement('BBVA');
    await snapshot(bbva, '2026-09-06', '900.00');

    const account = await currentAccount('BBVA');
    expect(account).toMatchObject({
      status: 'active',
      dormant: false,
      opening: { kind: 'statement', amount: { amount: '1000', currency: 'EUR' }, valuedOn: '2026-08-31' },
      latest: { state: 'carried', amount: { amount: '900', currency: 'EUR' }, valuedOn: '2026-09-06', statement: false },
      todaySnapshot: null,
      canUpdateToday: true,
    });
  });

  it('carries today’s own row, which an update corrects in place against its version', async () => {
    const bbva = await withAugustStatement('BBVA');
    await snapshot(bbva, '2026-09-10', '880.00');

    const before = await currentAccount('BBVA');
    expect(before.latest).toMatchObject({ state: 'exact', valuedOn: '2026-09-10' });
    expect(before.todaySnapshot).toMatchObject({ version: 1, amount: { amount: '880' } });
    const todayRow = before.todaySnapshot;
    if (todayRow === null) throw new Error('expected today’s row');

    await quickUpdate(positionDeps(), SEPT_10, {
      entries: [{ positionId: bbva, amount: '870.00', expectedVersion: todayRow.version }],
    });
    const after = await currentAccount('BBVA');
    expect(after.todaySnapshot).toEqual({
      valuationId: todayRow.valuationId,
      version: 2,
      amount: { amount: '870', currency: 'EUR' },
    });
    const history = await positionHistory(positionDeps(), SEPT_10, bbva);
    expect(history.filter((row) => row.valuedOn === '2026-09-10')).toHaveLength(1);

    // The version the page held is stale now: nothing is overwritten with it.
    await expect(
      quickUpdate(positionDeps(), SEPT_10, {
        entries: [{ positionId: bbva, amount: '860.00', expectedVersion: todayRow.version }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });
    expect((await currentAccount('BBVA')).todaySnapshot).toMatchObject({ version: 2, amount: { amount: '870' } });
  });

  it('shows the statement itself as the latest balance when nothing was recorded this month', async () => {
    await withAugustStatement('BBVA');

    const account = await currentAccount('BBVA');
    expect(account.latest).toEqual({
      state: 'carried',
      amount: { amount: '1000', currency: 'EUR' },
      valuedOn: '2026-08-31',
      statement: true,
    });
    expect(account.todaySnapshot).toBeNull();
    expect(account.canUpdateToday).toBe(true);
  });

  it('keeps a dormant account out of updates, carried at zero', async () => {
    await makeDormantAccount('Dormant', '2026-08-20', SEPT_10);

    const account = await currentAccount('Dormant');
    expect(account.dormant).toBe(true);
    expect(account.opening).toEqual({ kind: 'dormant_zero' });
    expect(account.canUpdateToday).toBe(false);
  });

  it('opens an account opened this month at zero, and a pre-existing one first tracked this month as a first balance', async () => {
    await makeOpenedAccount('New savings', '2026-09-05', SEPT_10);
    const found = await makeAccount('Found account', { ctx: SEPT_10 });
    await snapshot(found, '2026-09-03', '3000.00');

    const opened = await currentAccount('New savings');
    expect(opened.opening).toEqual({ kind: 'opened_zero' });
    expect(opened.latest).toMatchObject({ state: 'opened_zero', amount: { amount: '0' }, valuedOn: '2026-09-05' });
    expect(opened.canUpdateToday).toBe(true);

    // 8.6: a first valuation inside the month makes it the month's first balance.
    expect((await currentAccount('Found account')).opening).toEqual({ kind: 'first_balance' });
  });

  it('opens every account exactly as the month-to-date engine does', async () => {
    const a = await withAugustStatement('BBVA');
    const b = await withAugustStatement('Savings', '500.00');
    await makeOpenedAccount('New savings', '2026-09-02', SEPT_10);
    const opened = (await currentAccount('New savings')).positionId;
    for (const id of [a, b, opened]) await snapshot(id, '2026-09-06', '100.00');

    const page = await current();
    expect(page.monthToDate.asOf).toBe('2026-09-06');
    const engine = (page.monthToDate.buckets ?? []).flatMap((bucket) => bucket.accounts);
    for (const account of page.accounts.accounts) {
      const state = engine.find((item) => item.positionId === account.positionId);
      const opening = account.opening;
      expect(state?.openState, account.name).toBe(opening.kind === 'statement' ? 'month_end' : opening.kind);
      expect(state?.opening, account.name).toEqual(
        opening.kind === 'statement' ? opening.amount : opening.kind === 'opened_zero' ? { amount: '0', currency: 'EUR' } : null,
      );
    }
  });

  it('offers no month-end editing at all, even on the month’s last day', async () => {
    const bbva = await withAugustStatement('BBVA');
    await snapshot(bbva, '2026-09-30', '950.00');

    const page = await current(on('2026-09-30'));
    // The day it can be closed is the next one (M5, R15).
    expect(page.accounts.closableFrom).toBe('2026-10-01');
    const account = accountNamed(page.accounts.accounts, 'BBVA');
    expect(Object.keys(account)).not.toContain('closing');
    expect(account.todaySnapshot).toMatchObject({ amount: { amount: '950' } });
  });
});

describe('confirming untouched accounts unchanged, all together', () => {
  async function withAugustStatement(name: string, amount: string): Promise<string> {
    const id = await makeAccount(name);
    await statement(id, '2026-08-31', amount);
    return id;
  }

  /** Audit rows written under one request id, read as the table owner. */
  async function auditFor(requestId: string): Promise<{ entity_id: string; action: string; after: Record<string, unknown> }[]> {
    const client = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
    await client.connect();
    try {
      const result = await client.query<{ entity_id: string; action: string; after: Record<string, unknown> }>(
        `SELECT entity_id, action, after FROM audit_entries
          WHERE entity_table = 'position_valuations' AND request_id = $1
          ORDER BY occurred_at, id`,
        [requestId],
      );
      return result.rows;
    } finally {
      await client.end();
    }
  }

  const septemberRows = async (positionId: string) =>
    (await positionHistory(positionDeps(), OCT_1, positionId)).filter((row) => row.valuedOn === '2026-09-30');

  it('confirms every named account in one go, at each one’s own previous statement', async () => {
    const a = await withAugustStatement('BBVA', '1000.00');
    const b = await withAugustStatement('Savings', '500.55');

    const summary = await confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, b] });
    expect(summary).toEqual({ month: '2026-09', valuedOn: '2026-09-30', confirmed: 2, positionIds: [a, b] });

    const page = await completed();
    expect(accountNamed(page.accounts.accounts, 'BBVA').closing).toMatchObject({
      kind: 'statement',
      amount: { amount: '1000' },
      confirmedUnchanged: true,
    });
    expect(accountNamed(page.accounts.accounts, 'Savings').closing).toMatchObject({
      kind: 'statement',
      amount: { amount: '500.55' },
      confirmedUnchanged: true,
    });
    for (const id of [a, b]) {
      const [row] = await septemberRows(id);
      expect(row).toMatchObject({ datePrecision: 'month_end', source: 'confirmed_unchanged', version: 1 });
    }
  });

  /**
   * Two accounts with August statements, in the order the batch reaches them:
   * it locks and writes in id order, so `first` is written inside the
   * transaction before anything about `second` can fail it.
   */
  async function twoInLockOrder(): Promise<[string, string]> {
    const ids = [await withAugustStatement('One', '1000.00'), await withAugustStatement('Two', '500.00')].sort();
    return [ids[0] as string, ids[1] as string];
  }

  it('never rewrites a balance already on the last day, and then writes nothing at all', async () => {
    const [first, withStatement] = await twoInLockOrder();
    await statement(withStatement, '2026-09-30', '510.00');

    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [first, withStatement] }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await septemberRows(first)).toEqual([]);
    expect(await septemberRows(withStatement)).toMatchObject([
      { amount: '510.00000000', datePrecision: 'month_end', source: 'entered', version: 1 },
    ]);

    // An ordinary snapshot on the last day is confirmed, never replaced.
    const withSnapshot = await withAugustStatement('Joint', '200.00');
    await snapshot(withSnapshot, '2026-09-30', '190.00');
    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [first, withSnapshot] }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    expect(await septemberRows(first)).toEqual([]);
    expect(await septemberRows(withSnapshot)).toMatchObject([
      { amount: '190.00000000', datePrecision: 'exact', version: 1 },
    ]);
  });

  it('fails the whole request for one ineligible account, writing nothing for the others', async () => {
    const [a, noStatement] = await twoInLockOrder();
    // `noStatement` loses its August statement: nothing to carry forward.
    await harness.asOwner(`DELETE FROM position_valuations WHERE position_id = $1`, [noStatement]);
    await snapshot(noStatement, '2026-08-20', '300.00');
    const dormant = await makeDormantAccount('Dormant', '2026-07-10', OCT_1);
    const closed = await withAugustStatement('Closed', '0');
    await closePosition(positionDeps(), OCT_1, { positionId: closed, expectedVersion: 1, closedOn: '2026-09-20' });

    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, noStatement] }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_DATA', message: expect.stringContaining('August 2026') });
    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, dormant] }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, closed] }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    // Nor before the month is over, on its last day included (M5, R15).
    await expect(
      confirmUnchangedBatch(positionDeps(), on('2026-09-30'), { month: '2026-09', positionIds: [a] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, a] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    for (const id of [a, noStatement, dormant]) expect(await septemberRows(id)).toEqual([]);
  });

  it('lets exactly one of two simultaneous confirmations of the same account win', async () => {
    const a = await withAugustStatement('BBVA', '1000.00');
    const b = await withAugustStatement('Savings', '500.00');

    const results = await Promise.allSettled([
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [a, b] }),
      confirmUnchangedBatch(positionDeps(), OCT_1, { month: '2026-09', positionIds: [b, a] }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'CONFLICT_DUPLICATE' });
    for (const id of [a, b]) expect(await septemberRows(id)).toHaveLength(1);
  });

  /**
   * Wait until PostgreSQL itself reports a backend of this database blocked on
   * a lock.
   *
   * A barrier, not a delay: it returns the moment the database says somebody is
   * waiting, and fails if that never happens — which is exactly what an
   * implementation that read account eligibility *outside* the write
   * transaction would do, because nothing would block it.
   */
  async function waitUntilBlockedOnALock(): Promise<void> {
    const client = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
    await client.connect();
    try {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        // `pg_locks` is read from rather than `pg_stat_activity.wait_event`,
        // which PostgreSQL masks for a backend belonging to another role — and
        // the batch runs as `app_user` while this connection is the owner.
        const result = await client.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting
             FROM pg_locks locks
             JOIN pg_stat_activity backends ON backends.pid = locks.pid
            WHERE NOT locks.granted AND backends.datname = current_database()`,
        );
        if ((result.rows[0]?.waiting ?? 0) > 0) return;
        // The poll interval only decides how often the barrier is checked; the
        // condition is the database's, and never met is a failure below.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        'no backend ever waited for a lock: account eligibility was read outside the write transaction',
      );
    } finally {
      await client.end();
    }
  }

  it('cannot confirm an account that another transaction is closing', async () => {
    const account = await withAugustStatement('BBVA', '1000.00');

    // A close, begun and deliberately not committed: the position row is
    // changed and held. Its row lock (`FOR NO KEY UPDATE`) does not block a
    // foreign-key check, so an insert judged against a stale read would sail
    // straight past it.
    const closing = new pg.Client({ connectionString: harness.provisioned.ownerUrl });
    await closing.connect();
    let settled = false;
    let batch: Promise<unknown> | undefined;

    try {
      await closing.query('BEGIN');
      await closing.query(
        `UPDATE positions SET status = 'closed', closed_on = '2026-09-20', version = version + 1
          WHERE id = $1`,
        [account],
      );

      batch = confirmUnchangedBatch(positionDeps(), OCT_1, {
        month: '2026-09',
        positionIds: [account],
      }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      // Asserted below; this only keeps a rejection from going unhandled if the
      // barrier fails first.
      void batch.catch(() => undefined);

      await waitUntilBlockedOnALock();
      // It is waiting for the locked row rather than reading around it.
      expect(settled).toBe(false);

      await closing.query('COMMIT');
    } finally {
      await closing.end();
    }

    // And what it then reads is the account as it now is.
    await expect(batch).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
    expect(await septemberRows(account)).toEqual([]);
  });

  it('opens one user-scoped transaction, whatever the number of accounts', async () => {
    const one = await withAugustStatement('One', '1000.00');
    const two = await withAugustStatement('Two', '500.00');
    const three = await withAugustStatement('Three', '250.00');

    const transactionsFor = async (positionIds: readonly string[]): Promise<number> => {
      const counting = countingDatabase();
      await confirmUnchangedBatch({ db: counting.db, fx: harness.services.fx }, OCT_1, {
        month: '2026-09',
        positionIds,
      });
      return counting.transactions();
    };

    // Statements grow with the accounts; transactions do not. Eligibility is
    // read inside the one that writes, so there is no second scope to open.
    expect(await transactionsFor([one])).toBe(1);
    expect(await transactionsFor([two, three])).toBe(1);
  });

  it('writes every row under the one request id, each with its own insert audit', async () => {
    const a = await withAugustStatement('BBVA', '1000.00');
    const b = await withAugustStatement('Savings', '500.00');
    const ctx = testContext({ today: '2026-10-01', userId: USER_A, requestId: 'batch-unchanged-request' });

    await confirmUnchangedBatch(positionDeps(), ctx, { month: '2026-09', positionIds: [a, b] });

    const audit = await auditFor('batch-unchanged-request');
    const rows = [...(await septemberRows(a)), ...(await septemberRows(b))];
    expect(audit.map((row) => row.action)).toEqual(['insert', 'insert']);
    expect(audit.map((row) => row.entity_id).sort()).toEqual(rows.map((row) => row.id).sort());
    for (const row of audit) {
      expect(row.after).toMatchObject({ source: 'confirmed_unchanged', datePrecision: 'month_end', valuedOn: '2026-09-30' });
    }
  });

  it('answers another user as though the account did not exist, and changes nothing', async () => {
    const a = await withAugustStatement('BBVA', '1000.00');
    const asB = on('2026-10-01', USER_B);

    await expect(
      confirmUnchangedBatch(positionDeps(), asB, { month: '2026-09', positionIds: [a] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await septemberRows(a)).toEqual([]);
    expect((await completed(asB)).accounts.accounts).toEqual([]);
  });
});

describe('the Accounts section reads nothing of its own', () => {
  it('keeps both kinds of month at their constant bound with accounts of every kind', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    const small = await countTransactions(OCT_1);
    const smallCurrent = await countTransactions(SEPT_10);

    await makeDormantAccount('Dormant', '2026-07-10', OCT_1);
    await makeOpenedAccount('New savings', '2026-09-10', OCT_1);
    const found = await makeAccount('Found account');
    await statement(found, '2026-09-30', '3000.00');
    const snapshots = await makeAccount('Snapshots');
    await statement(snapshots, '2026-08-31', '10.00');
    for (const day of ['2026-09-03', '2026-09-17', '2026-09-30']) await snapshot(snapshots, day, '11.00');

    const page = await completed();
    expect(page.accounts.accounts).toHaveLength(5);
    expect(await countTransactions(OCT_1)).toBe(small);
    expect(small).toBe(11 + KNOWN_EXPENSES_SCOPE);
    expect(await countTransactions(SEPT_10)).toBe(smallCurrent);
  });
});

/* -------------------------------------------------------------------------- */
/* The Income section (15.3 section 2)                                         */
/* -------------------------------------------------------------------------- */

const NOV_1 = on('2026-11-01');

/** October read as the month in progress, and as a completed month. */
const currentOctober = async (): Promise<CurrentMonthlyPageDto> => {
  const page = await getMonthlyPage(readDeps(), OCT_1, OCTOBER);
  if (page.kind !== 'current') throw new Error('expected the current month');
  return page;
};

const completedOctober = async (): Promise<CompletedMonthlyPageDto> => {
  const page = await getMonthlyPage(readDeps(), NOV_1, OCTOBER);
  if (page.kind !== 'completed') throw new Error('expected a completed month');
  return page;
};

interface SourceOptions {
  readonly name?: string;
  readonly incomeKind?: 'employment' | 'rental' | 'bonus';
  readonly frequency?: 'monthly' | 'annual';
  readonly dayOfMonth?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly amount?: string;
  readonly grossAmount?: string;
  readonly cashPositionId?: string;
  readonly ctx?: RequestContext;
}

async function incomeSource(options: SourceOptions = {}) {
  const created = await createTemplate(flowDeps(), options.ctx ?? OCT_1, {
    kind: 'income',
    name: options.name ?? 'Salary',
    incomeKind: options.incomeKind ?? 'employment',
    currency: 'EUR',
    frequency: options.frequency ?? 'monthly',
    dayOfMonth: options.dayOfMonth ?? 25,
    startDate: options.startDate ?? '2026-01-01',
    ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
    ...(options.cashPositionId === undefined ? {} : { cashPositionId: options.cashPositionId }),
    amount: options.amount ?? '2100.00',
    ...(options.grossAmount === undefined ? {} : { grossAmount: options.grossAmount }),
  });
  return created.template;
}

/** The occurrence a page shows for one `(template, date)` identity. */
function occurrenceOf(
  page: CompletedMonthlyPageDto | CurrentMonthlyPageDto,
  templateId: string,
  occurrenceDate: string,
) {
  const found = page.income.occurrences.find(
    (row) => row.templateId === templateId && row.occurrenceDate === occurrenceDate,
  );
  if (found === undefined) {
    throw new Error(
      `no occurrence ${occurrenceDate} for ${templateId}; page has ${page.income.occurrences
        .map((row) => `${row.templateId}@${row.occurrenceDate}`)
        .join(', ')}`,
    );
  }
  return found;
}

/**
 * Every income entry a page renders, once each.
 *
 * The partition's whole point is that a materialized row appears in exactly one
 * group, so this collects all three and lets a test assert on the multiset: a
 * duplicate shows up as a repeated id rather than as a passing assertion in one
 * group while another quietly holds the same row.
 */
function renderedEntryIds(page: CompletedMonthlyPageDto | CurrentMonthlyPageDto): string[] {
  const accepted = page.income.occurrences.flatMap((row) =>
    row.state.kind === 'accepted' ? [row.state.entry.entryId] : [],
  );
  return [
    ...accepted,
    ...page.income.otherRecurring.map((row) => row.entryId),
    ...page.income.direct.map((row) => row.entryId),
  ];
}

describe('the Income section reads a month’s own schedule and money', () => {
  it('lists direct tracked income received in the month, once, with its evidence', async () => {
    const bbva = await makeAccount('BBVA');
    const created = await createIncomeEntry(flowDeps(), OCT_1, {
      kind: 'other',
      receivedOn: '2026-09-14',
      netAmount: '480.00',
      grossAmount: '600.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      description: 'Side work',
    });

    const page = await completed();
    expect(page.income.direct).toHaveLength(1);
    expect(page.income.direct[0]).toMatchObject({
      entryId: created.id,
      version: created.version,
      kind: 'other',
      settlement: 'tracked_cash',
      receivedOn: '2026-09-14',
      receivedMonth: '2026-09',
      net: { amount: '480', currency: 'EUR' },
      gross: { amount: '600', currency: 'EUR' },
      cashPositionId: bbva,
      cashAccountName: 'BBVA',
      description: 'Side work',
      occurrence: null,
    });
    expect(page.income.occurrences).toHaveLength(0);
    expect(page.income.otherRecurring).toHaveLength(0);
  });

  it('lists ordinary income received outside tracked accounts as the settlement it is', async () => {
    await makeAccount('BBVA');
    await createIncomeEntry(flowDeps(), OCT_1, {
      kind: 'freelance',
      receivedOn: '2026-09-04',
      netAmount: '300.00',
      currency: 'EUR',
      settlement: 'external',
    });

    expect((await completed()).income.direct[0]).toMatchObject({
      settlement: 'external',
      cashPositionId: null,
      cashAccountName: null,
      gross: null,
    });
  });

  it('keeps a tracked flow with no account attributed to none, never external', async () => {
    await makeAccount('BBVA');
    await createIncomeEntry(flowDeps(), OCT_1, {
      kind: 'other',
      receivedOn: '2026-09-04',
      netAmount: '75.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: null,
    });

    // 8.1: a null cash leg is a tracked flow awaiting attribution, and nothing
    // about the settlement may be inferred from it (§30.9 item 1).
    expect((await completed()).income.direct[0]).toMatchObject({
      settlement: 'tracked_cash',
      cashPositionId: null,
      cashAccountName: null,
    });
  });

  it('shows an unresolved occurrence of a completed month as due, with its term', async () => {
    const bbva = await makeAccount('BBVA');
    const template = await incomeSource({ cashPositionId: bbva, grossAmount: '2700.00' });

    const occurrence = occurrenceOf(await completed(), template.id, '2026-09-25');
    expect(occurrence.state).toEqual({ kind: 'due' });
    expect(occurrence).toMatchObject({
      templateName: 'Salary',
      incomeKind: 'employment',
      currency: 'EUR',
      sourceArchived: false,
      defaultCashPositionId: bbva,
      defaultCashAccountName: 'BBVA',
    });
    expect(occurrence.term.net).toEqual({ amount: '2100', currency: 'EUR' });
    expect(occurrence.term.gross).toEqual({ amount: '2700', currency: 'EUR' });
  });

  it('shows an occurrence dated after today as upcoming', async () => {
    const template = await incomeSource({ ctx: SEPT_10 });
    expect(occurrenceOf(await current(), template.id, '2026-09-25').state.kind).toBe('upcoming');
  });

  it('embeds the entry of an accepted occurrence and never lists it twice', async () => {
    const bbva = await makeAccount('BBVA');
    const template = await incomeSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
    });

    const page = await completed();
    const occurrence = occurrenceOf(page, template.id, '2026-09-25');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry).toMatchObject({
      entryId: accepted.entry.id,
      version: accepted.entry.version,
      receivedOn: '2026-09-25',
      receivedMonth: '2026-09',
      net: { amount: '2100', currency: 'EUR' },
      cashPositionId: bbva,
      occurrence: {
        templateId: template.id,
        templateName: 'Salary',
        occurrenceDate: '2026-09-25',
        occurrenceMonth: '2026-09',
      },
    });

    // The whole partition, not one group: the embedded entry is subtracted from
    // the financially-received rows rather than appearing in both.
    expect(renderedEntryIds(page)).toEqual([accepted.entry.id]);
    expect(page.income.otherRecurring).toHaveLength(0);
    expect(page.income.direct).toHaveLength(0);
  });

  it('shows a skipped occurrence with its reason and note, and the id a restore needs', async () => {
    const template = await incomeSource();
    const skip = await skipSuggestion(flowDeps(), OCT_1, {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
      reason: 'skipped',
      note: 'Contract ended mid-month.',
    });

    expect(occurrenceOf(await completed(), template.id, '2026-09-25').state).toEqual({
      kind: 'skipped',
      skipId: skip.id,
      reason: 'skipped',
      note: 'Contract ended mid-month.',
    });
  });

  it('carries a rental occupancy reason, which is the only occupancy fact recorded', async () => {
    const template = await incomeSource({ name: 'Flat 2B', incomeKind: 'rental', dayOfMonth: 5 });
    await skipSuggestion(flowDeps(), OCT_1, {
      templateId: template.id,
      occurrenceDate: '2026-09-05',
      reason: 'vacant',
    });

    expect(occurrenceOf(await completed(), template.id, '2026-09-05').state).toMatchObject({
      kind: 'skipped',
      reason: 'vacant',
    });
  });

  it('offers the month’s cash accounts for attribution, from the rows already read', async () => {
    const bbva = await makeAccount('BBVA');
    await makeAccount('Dollars', { currency: 'USD' });

    expect((await completed()).income.cashAccounts).toEqual(
      expect.arrayContaining([
        { positionId: bbva, name: 'BBVA', currency: 'EUR' },
        expect.objectContaining({ name: 'Dollars', currency: 'USD' }),
      ]),
    );
  });

  it('never returns a financial date after today', async () => {
    await makeAccount('BBVA', { ctx: SEPT_10 });
    const template = await incomeSource({ ctx: SEPT_10 });
    await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
      receivedToday: true,
    });

    const page = await current();
    const dates = [
      ...page.income.occurrences.flatMap((row) =>
        row.state.kind === 'accepted' ? [row.state.entry.receivedOn] : [],
      ),
      ...page.income.otherRecurring.map((row) => row.receivedOn),
      ...page.income.direct.map((row) => row.receivedOn),
    ];
    expect(dates).not.toHaveLength(0);
    for (const date of dates) expect(date <= page.today).toBe(true);
  });
});

describe('the currencies Monthly offers', () => {
  it('are the catalogue’s, not the ones the user holds an account in', async () => {
    await makeAccount('BBVA');

    const page = await completed();
    // A picker offers what this product is willing to convert (10.5) — income
    // received outside tracked accounts, and tracked income not yet attributed,
    // are both legitimate in a currency no account exists for.
    expect(page.selectableCurrencyCodes).toContain('USD');
    expect(page.selectableCurrencyCodes).toContain('EUR');
    expect(page.selectableCurrencyCodes.length).toBeGreaterThan(
      page.income.cashAccounts.length,
    );
    // Same rows as the formatter uses, so one read answers both questions.
    for (const code of page.selectableCurrencyCodes) {
      expect(page.minorUnitsByCurrency[code]).toBeTypeOf('number');
    }
  });

  it('are offered on the current month too, and stay sorted and unique', async () => {
    await makeAccount('BBVA', { ctx: SEPT_10 });
    const codes = (await current()).selectableCurrencyCodes;
    expect(codes).toEqual([...new Set(codes)]);
    expect([...codes]).toEqual([...codes].sort());
  });
});

describe('the Income section across a month boundary', () => {
  /**
   * The canonical early receipt (15.3, §30.9 item 2): a salary scheduled for 1
   * October, recorded on 30 September through "received today". One row, two
   * months, and each month answers its own question about it.
   */
  async function earlyReceipt() {
    const sept30 = on('2026-09-30');
    const bbva = await makeAccount('BBVA', { ctx: sept30 });
    const template = await incomeSource({ dayOfMonth: 1, cashPositionId: bbva, ctx: sept30 });
    const accepted = await acceptSuggestion(flowDeps(), sept30, {
      templateId: template.id,
      occurrenceDate: '2026-10-01',
      receivedToday: true,
    });
    return { template, entryId: accepted.entry.id, bbva };
  }

  it('shows an early receipt in September as recurring income for another month', async () => {
    const { template, entryId } = await earlyReceipt();

    const page = await completed();
    expect(renderedEntryIds(page)).toEqual([entryId]);
    expect(page.income.direct).toHaveLength(0);
    expect(page.income.otherRecurring).toHaveLength(1);
    expect(page.income.otherRecurring[0]).toMatchObject({
      entryId,
      receivedOn: '2026-09-30',
      receivedMonth: '2026-09',
      occurrence: {
        templateId: template.id,
        templateName: 'Salary',
        occurrenceDate: '2026-10-01',
        occurrenceMonth: '2026-10',
      },
    });

    // September's own 1 September occurrence is a different occurrence and is
    // still unresolved: the early receipt did not answer for it.
    expect(occurrenceOf(page, template.id, '2026-09-01').state).toEqual({ kind: 'due' });
  });

  it('shows the same row in October as an accepted occurrence received on 30 September', async () => {
    const { template, entryId } = await earlyReceipt();

    const page = await currentOctober();
    const occurrence = occurrenceOf(page, template.id, '2026-10-01');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry).toMatchObject({
      entryId,
      receivedOn: '2026-09-30',
      // October shows it; September owns editing it, because the financial month
      // is the one holding the money.
      receivedMonth: '2026-09',
    });
    expect(renderedEntryIds(page)).toEqual([entryId]);
  });

  it('counts an early receipt financially in September and never in October', async () => {
    await earlyReceipt();

    const september = await completed();
    expect(
      september.reconciliation.buckets.find((b) => b.currency === 'EUR')?.totals.externalInflows,
    ).toEqual({ amount: '2100', currency: 'EUR' });

    const october = await completedOctober();
    expect(
      october.reconciliation.buckets.find((b) => b.currency === 'EUR')?.totals.externalInflows,
    ).toEqual({ amount: '0', currency: 'EUR' });
  });

  it('raises no missing-income issue for the October occurrence it already resolved', async () => {
    const { template } = await earlyReceipt();

    const missing = (await completedOctober()).reconciliation.buckets
      .flatMap((bucket) => bucket.issues)
      .filter((issue) => issue.key === 'suggested_income_missing');
    expect(missing.map((issue) => issue.occurrenceDate)).not.toContain('2026-10-01');
    expect(missing.every((issue) => issue.templateId === template.id)).toBe(true);
  });

  /**
   * The mirror image: a salary scheduled for 25 September that actually arrived
   * on 1 October. The two dates may differ in either direction, and the read has
   * to answer for both months.
   */
  async function lateReceipt() {
    const bbva = await makeAccount('BBVA');
    const template = await incomeSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
      financialDate: '2026-10-01',
    });
    return { template, entryId: accepted.entry.id };
  }

  it('shows a late receipt in September as an accepted occurrence received in October', async () => {
    const { template, entryId } = await lateReceipt();

    const page = await completed();
    const occurrence = occurrenceOf(page, template.id, '2026-09-25');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry).toMatchObject({
      entryId,
      receivedOn: '2026-10-01',
      receivedMonth: '2026-10',
    });
    // Accepted, so September's schedule is answered — but the money is not
    // September's, so it is in no financially-received group here.
    expect(renderedEntryIds(page)).toEqual([entryId]);
    expect(page.income.otherRecurring).toHaveLength(0);
    expect(page.income.direct).toHaveLength(0);
  });

  it('shows the same row in October as recurring income for September’s occurrence', async () => {
    const { template, entryId } = await lateReceipt();

    const page = await currentOctober();
    expect(renderedEntryIds(page)).toEqual([entryId]);
    expect(page.income.otherRecurring[0]).toMatchObject({
      entryId,
      receivedOn: '2026-10-01',
      receivedMonth: '2026-10',
      occurrence: { templateId: template.id, occurrenceDate: '2026-09-25' },
    });
  });

  it('counts a late receipt financially in October and never in September', async () => {
    await lateReceipt();

    const september = await completed();
    expect(
      september.reconciliation.buckets.find((b) => b.currency === 'EUR')?.totals.externalInflows,
    ).toEqual({ amount: '0', currency: 'EUR' });

    const october = await completedOctober();
    expect(
      october.reconciliation.buckets.find((b) => b.currency === 'EUR')?.totals.externalInflows,
    ).toEqual({ amount: '2100', currency: 'EUR' });
  });

  it('accepts money that arrived before its scheduled date, with no lower bound', async () => {
    // The domain bounds the financial date by today and by nothing else. A
    // salary scheduled for the 25th that the bank posted on the 23rd is an
    // ordinary fact, and recording it later must not make it unrepresentable.
    const bbva = await makeAccount('BBVA');
    const template = await incomeSource({ cashPositionId: bbva });
    const accepted = await acceptSuggestion(flowDeps(), OCT_1, {
      templateId: template.id,
      occurrenceDate: '2026-09-25',
      financialDate: '2026-09-23',
    });

    const page = await completed();
    const occurrence = occurrenceOf(page, template.id, '2026-09-25');
    if (occurrence.state.kind !== 'accepted') throw new Error('expected an accepted occurrence');
    expect(occurrence.state.entry.receivedOn).toBe('2026-09-23');
    expect(occurrence.state.entry.receivedMonth).toBe('2026-09');
    expect(renderedEntryIds(page)).toEqual([accepted.entry.id]);
  });

  it('resolves the source of a row whose schedule window the month never loads', async () => {
    // "Received today" on 30 September for a source that starts on 1 November:
    // the entry is September's, and its template overlaps no month on the page.
    const sept30 = on('2026-09-30');
    const bbva = await makeAccount('BBVA', { ctx: sept30 });
    const template = await incomeSource({
      name: 'Annual bonus',
      incomeKind: 'bonus',
      frequency: 'annual',
      dayOfMonth: 1,
      startDate: '2026-11-01',
      cashPositionId: bbva,
      ctx: sept30,
    });
    await acceptSuggestion(flowDeps(), sept30, {
      templateId: template.id,
      occurrenceDate: '2026-11-01',
      receivedToday: true,
    });

    expect((await completed()).income.otherRecurring[0]?.occurrence).toMatchObject({
      templateId: template.id,
      templateName: 'Annual bonus',
      occurrenceDate: '2026-11-01',
      occurrenceMonth: '2026-11',
    });
  });
});

describe('the Income section’s early-receipt candidates', () => {
  it('names the next unresolved occurrence after today, and only that one', async () => {
    const template = await incomeSource({ ctx: SEPT_10 });

    const page = await current();
    // 25 September is inside the month, so it is the month's own upcoming
    // occurrence rather than a second offer beside it.
    expect(occurrenceOf(page, template.id, '2026-09-25').state).toEqual({
      kind: 'upcoming',
      receivedTodayEligible: true,
    });
    expect(page.income.earlyReceiptCandidates).toHaveLength(0);
  });

  it('offers only the earliest of two future occurrences', async () => {
    // §30.10 bounds the claim by the schedule: a user may record what arrived
    // early, and can never step over an earlier occurrence that is still
    // unresolved — which would leave a hole completeness then reports for ever.
    await incomeSource({
      frequency: 'annual',
      dayOfMonth: 1,
      startDate: '2026-12-01',
      ctx: SEPT_10,
    });

    const page = await current();
    expect(page.income.earlyReceiptCandidates).toHaveLength(1);
    expect(page.income.earlyReceiptCandidates[0]?.occurrenceDate).toBe('2026-12-01');
  });

  it('moves the offer on once the earlier future occurrence is resolved', async () => {
    const template = await incomeSource({
      frequency: 'annual',
      dayOfMonth: 1,
      startDate: '2026-12-01',
      ctx: SEPT_10,
    });
    await skipSuggestion(flowDeps(), SEPT_10, {
      templateId: template.id,
      occurrenceDate: '2026-12-01',
      reason: 'skipped',
    });

    expect((await current()).income.earlyReceiptCandidates[0]?.occurrenceDate).toBe('2027-12-01');
  });

  it('is not blocked by an unresolved occurrence that has already passed', async () => {
    // The bound is over occurrences **after** today (§30.10). One in the past
    // needs no early-receipt path at all — it can be accepted on its own terms
    // whenever the user gets to it — so it neither claims the offer nor holds
    // it back.
    const template = await incomeSource({ ctx: SEPT_10 });

    // September's own occurrence belongs to September's page; October shows its
    // own, and offers it even though the one behind it is still unresolved.
    expect(occurrenceOf(await completed(), template.id, '2026-09-25').state).toEqual({
      kind: 'due',
    });
    const page = await currentOctober();
    expect(occurrenceOf(page, template.id, '2026-10-25').state).toEqual({
      kind: 'upcoming',
      receivedTodayEligible: true,
    });
  });

  it('reaches an annual source months past the end of the month, with no horizon', async () => {
    const template = await incomeSource({
      name: 'Annual bonus',
      incomeKind: 'bonus',
      frequency: 'annual',
      dayOfMonth: 15,
      startDate: '2026-06-15',
      amount: '5000.00',
      grossAmount: '6200.00',
      ctx: SEPT_10,
    });
    await skipSuggestion(flowDeps(), SEPT_10, {
      templateId: template.id,
      occurrenceDate: '2026-06-15',
      reason: 'skipped',
    });

    // Nine months out, and still reachable because it is genuinely next.
    const page = await current();
    expect(page.income.earlyReceiptCandidates).toHaveLength(1);
    expect(page.income.earlyReceiptCandidates[0]).toMatchObject({
      templateId: template.id,
      templateName: 'Annual bonus',
      occurrenceDate: '2027-06-15',
      occurrenceMonth: '2027-06',
    });
    // And priced by the term in force at that date, which the bounded read had
    // to reach forward to find.
    expect(page.income.earlyReceiptCandidates[0]?.term.net).toEqual({
      amount: '5000',
      currency: 'EUR',
    });
    expect(page.income.earlyReceiptCandidates[0]?.term.gross).toEqual({
      amount: '6200',
      currency: 'EUR',
    });
  });

  it('prices a far candidate with a term that starts after the displayed month', async () => {
    const template = await incomeSource({
      frequency: 'annual',
      dayOfMonth: 15,
      startDate: '2026-06-15',
      amount: '5000.00',
      ctx: SEPT_10,
    });
    await skipSuggestion(flowDeps(), SEPT_10, {
      templateId: template.id,
      occurrenceDate: '2026-06-15',
      reason: 'skipped',
    });
    await setTemplateTerm(flowDeps(), SEPT_10, {
      templateId: template.id,
      effectiveFrom: '2027-01-01',
      amount: '5400.00',
      expected: { state: 'absent' },
    });

    expect((await current()).income.earlyReceiptCandidates[0]?.term.net).toEqual({
      amount: '5400',
      currency: 'EUR',
    });
  });

  it('keeps two sources sharing a scheduled date independent of each other', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const first = await incomeSource({ name: 'Alpha', cashPositionId: bbva, ctx: SEPT_10 });
    const second = await incomeSource({ name: 'Beta', cashPositionId: bbva, ctx: SEPT_10 });

    // One source's occurrence is claimed early; the other's identical date must
    // stay its own. `nextUnresolvedOccurrence` takes dates, so the resolved set
    // it is given has to be that template's own or the two resolve each other.
    await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: first.id,
      occurrenceDate: '2026-09-25',
      receivedToday: true,
    });

    const page = await current();
    expect(occurrenceOf(page, first.id, '2026-09-25').state.kind).toBe('accepted');
    expect(occurrenceOf(page, second.id, '2026-09-25').state).toEqual({
      kind: 'upcoming',
      receivedTodayEligible: true,
    });
  });

  it('offers no candidate at all for a source whose schedule has ended', async () => {
    await incomeSource({ endDate: '2026-09-30', ctx: SEPT_10 });
    expect((await currentOctober()).income.earlyReceiptCandidates).toHaveLength(0);
  });
});

describe('the Income section and an archived source', () => {
  it('keeps a historical occurrence of a source archived since, marked as archived', async () => {
    const template = await incomeSource();
    await archiveTemplate(flowDeps(), OCT_1, {
      templateId: template.id,
      expectedVersion: template.version,
    });

    // §30.10: archiving is present-tense visibility. It must not erase what a
    // past month expected, or a month would become complete because of an
    // action taken today.
    const occurrence = occurrenceOf(await completed(), template.id, '2026-09-25');
    expect(occurrence.state).toEqual({ kind: 'due' });
    expect(occurrence.sourceArchived).toBe(true);
  });

  it('agrees with the missing-income issue about which occurrence is unaccounted for', async () => {
    const template = await incomeSource();
    await archiveTemplate(flowDeps(), OCT_1, {
      templateId: template.id,
      expectedVersion: template.version,
    });
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');

    const page = await completed();
    const issues = page.reconciliation.buckets
      .flatMap((bucket) => bucket.issues)
      .filter((issue) => issue.key === 'suggested_income_missing');

    // The same `(template_id, occurrence_date)` identity on both sides, so a
    // jump from the issue lands on the exact row — never a name match.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ templateId: template.id, occurrenceDate: '2026-09-25' });
    expect(occurrenceOf(page, template.id, '2026-09-25').sourceArchived).toBe(true);
  });

  it('offers the live month no new suggestion from an archived source', async () => {
    const template = await incomeSource({ ctx: SEPT_10 });
    await archiveTemplate(flowDeps(), SEPT_10, {
      templateId: template.id,
      expectedVersion: template.version,
    });

    const page = await current();
    expect(page.income.occurrences).toHaveLength(0);
    expect(page.income.earlyReceiptCandidates).toHaveLength(0);
  });

  it('keeps a resolved occurrence of an archived source visible in the live month', async () => {
    const bbva = await makeAccount('BBVA', { ctx: SEPT_10 });
    const template = await incomeSource({ dayOfMonth: 5, cashPositionId: bbva, ctx: SEPT_10 });
    const accepted = await acceptSuggestion(flowDeps(), SEPT_10, {
      templateId: template.id,
      occurrenceDate: '2026-09-05',
    });
    await archiveTemplate(flowDeps(), SEPT_10, {
      templateId: template.id,
      expectedVersion: template.version,
    });

    // Archiving stops the feed; it does not unrecord what was recorded.
    const page = await current();
    const occurrence = occurrenceOf(page, template.id, '2026-09-05');
    expect(occurrence.state.kind).toBe('accepted');
    expect(occurrence.sourceArchived).toBe(true);
    expect(renderedEntryIds(page)).toEqual([accepted.entry.id]);
  });
});

describe('the Income section’s term evidence', () => {
  it('takes the term the scheduled date falls under, never the financial date', async () => {
    const bbva = await makeAccount('BBVA');
    const template = await incomeSource({ dayOfMonth: 1, cashPositionId: bbva });
    await setTemplateTerm(flowDeps(), OCT_1, {
      templateId: template.id,
      effectiveFrom: '2026-10-01',
      amount: '2250.00',
      expected: { state: 'absent' },
    });

    // §30.9 item 4 keys the term to the schedule, so October's raise applies to
    // October's occurrence however early the money arrives.
    expect(occurrenceOf(await currentOctober(), template.id, '2026-10-01').term.net).toEqual({
      amount: '2250',
      currency: 'EUR',
    });
    expect(occurrenceOf(await completed(), template.id, '2026-09-01').term.net).toEqual({
      amount: '2100',
      currency: 'EUR',
    });
  });

  it('says a term starts exactly here, with the row a replacement must claim', async () => {
    const template = await incomeSource({ dayOfMonth: 25 });
    const term = await setTemplateTerm(flowDeps(), OCT_1, {
      templateId: template.id,
      effectiveFrom: '2026-09-25',
      amount: '2200.00',
      note: 'Promotion.',
      expected: { state: 'absent' },
    });

    const occurrence = occurrenceOf(await completed(), template.id, '2026-09-25');
    expect(occurrence.term.net).toEqual({ amount: '2200', currency: 'EUR' });
    expect(occurrence.term.effectiveFrom).toBe('2026-09-25');
    expect(occurrence.term.exact).toEqual({
      state: 'version',
      termId: term.id,
      version: term.version,
      note: 'Promotion.',
    });
  });

  it('says no term starts here, and carries no older note into the one a write would create', async () => {
    const template = await incomeSource({ name: 'Stipend', dayOfMonth: 10 });
    await setTemplateTerm(flowDeps(), OCT_1, {
      templateId: template.id,
      effectiveFrom: '2026-03-10',
      amount: '400.00',
      note: 'Original agreement.',
      expected: { state: 'absent' },
    });

    const occurrence = occurrenceOf(await completed(), template.id, '2026-09-10');
    // The applicable term prices the occurrence…
    expect(occurrence.term.net).toEqual({ amount: '400', currency: 'EUR' });
    expect(occurrence.term.effectiveFrom).toBe('2026-03-10');
    // …but no term starts here, so a write creates one, and March's note explains
    // why *March's* term began. Copying it would fabricate provenance.
    expect(occurrence.term.exact).toEqual({ state: 'absent' });
  });

  it('prices an occurrence its source has no term for as unknown, never as zero', async () => {
    const template = await incomeSource({ startDate: '2026-09-01', dayOfMonth: 25 });
    await harness.asOwner('DELETE FROM recurring_template_terms');

    const occurrence = occurrenceOf(await completed(), template.id, '2026-09-25');
    expect(occurrence.term.net).toBeNull();
    expect(occurrence.term.gross).toBeNull();
    expect(occurrence.term.effectiveFrom).toBeNull();
    expect(occurrence.term.exact).toEqual({ state: 'absent' });
  });
});

describe('the Income section’s read stays bounded', () => {
  it('does not open a scope per source, term, entry, skip or occurrence', async () => {
    const bbva = await makeAccount('BBVA');
    await statement(bbva, '2026-08-31', '1000.00');
    await statement(bbva, '2026-09-30', '900.00');
    // A month that already has a source, so the range loader's batched terms
    // scope — which predates this section — is inside the baseline.
    await incomeSource({ name: 'Baseline', dayOfMonth: 5, cashPositionId: bbva });
    const baseCompleted = await countTransactions(OCT_1);
    const baseCurrent = await countTransactions(SEPT_10);

    for (const name of ['Salary', 'Rent', 'Stipend', 'Retainer']) {
      const template = await incomeSource({ name, dayOfMonth: 5, cashPositionId: bbva });
      for (const from of ['2026-04-05', '2026-06-05', '2026-08-05']) {
        await setTemplateTerm(flowDeps(), OCT_1, {
          templateId: template.id,
          effectiveFrom: from,
          amount: '150.00',
          expected: { state: 'absent' },
        });
      }
      await acceptSuggestion(flowDeps(), OCT_1, {
        templateId: template.id,
        occurrenceDate: '2026-09-05',
      });
      await skipSuggestion(flowDeps(), OCT_1, {
        templateId: template.id,
        occurrenceDate: '2026-08-05',
        reason: 'skipped',
      });
    }
    for (let index = 0; index < 5; index += 1) {
      await createIncomeEntry(flowDeps(), OCT_1, {
        kind: 'other',
        receivedOn: '2026-09-12',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      });
    }

    // Four more sources, twelve terms, four accepted occurrences, four skips and
    // five direct entries later, both pages open exactly the scopes they opened
    // with none of them.
    expect(await countTransactions(OCT_1)).toBe(baseCompleted);
    expect(await countTransactions(SEPT_10)).toBe(baseCurrent);
    expect((await completed()).income.occurrences.length).toBeGreaterThan(4);
  });

  it('does not grow with the number of early-receipt candidates', async () => {
    await incomeSource({ name: 'Baseline', ctx: SEPT_10 });
    const base = await countTransactions(SEPT_10);

    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await incomeSource({ name, frequency: 'annual', startDate: '2026-12-01', ctx: SEPT_10 });
    }

    const page = await current();
    expect(page.income.earlyReceiptCandidates).toHaveLength(5);
    expect(await countTransactions(SEPT_10)).toBe(base);
  });
});
