import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoAfterRefresh, waitForRouter } from '../support/navigation';

/**
 * A new user's first month (blueprint 8.6, 15.3; ADR 0014; ADR 0009 §3
 * addendum).
 *
 * Four journeys a person meets before any month has closed, each written
 * through the product's own pages — there is no seeding endpoint:
 *
 *  - **accounts that already existed, first tracked this month.** Month to date
 *    has nothing to measure, and Monthly and Spending say why — not that the
 *    accounts share no date, and with no "Update all today" that could not
 *    change it;
 *  - **no cash account at all.** The same month says none takes part, and
 *    points to adding one;
 *  - **the first day of a month.** The current month asks for the previous
 *    month's statements, and stops asking once they are in;
 *  - **an expected salary nobody recorded.** The unexplained inflow it causes
 *    leads with recording that salary, so the same money is not added twice.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_1 = '2026-10-01T10:00:00Z';
const OCTOBER_10 = '2026-10-10T10:00:00Z';
const SEPTEMBER_30 = '2026-09-30T10:00:00Z';

interface CapturedMessage {
  readonly to: string;
  readonly text: string;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function waitForMessage(request: APIRequestContext, to: string, tag: string): Promise<CapturedMessage> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request.get(`/api/test/mailbox?to=${encodeURIComponent(to)}&tag=${tag}`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { messages: CapturedMessage[] };
    const latest = body.messages.at(-1);
    if (latest !== undefined) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No ${tag} message for ${to}`);
}

function linkFrom(message: CapturedMessage): string {
  const match = /https?:\/\/\S+/u.exec(message.text);
  if (match === null) throw new Error('No link in the message.');
  return match[0];
}

async function fillTestId(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

async function onboard(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto('/sign-up');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  await page.getByLabel('Your name').fill('First month');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('auth-success')).toBeVisible();

  await page.goto(linkFrom(await waitForMessage(request, email, 'verification')));

  await page.goto('/onboarding/1');
  await expect(page.getByTestId('onboarding-timezone')).toBeVisible();
  await page.getByTestId('onboarding-timezone').selectOption('Europe/Madrid');
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('onboarding-base-currency')).toBeVisible();
  await page.getByTestId('onboarding-base-currency').selectOption('EUR');
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('onboarding-favorites')).toBeVisible();
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('create-cash-account')).toBeVisible();
  await page.getByTestId('onboarding-skip').click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

/**
 * An account that already existed — the form's default answer — with its
 * balance on a date, left on the accounts list.
 */
async function existingAccount(page: Page, name: string, balance: string, on: string): Promise<void> {
  await gotoAfterRefresh(page, '/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('checking');
  await expect(page.getByTestId('origin-existing')).toBeChecked();
  await fillTestId(page, 'account-balance', balance);
  await fillTestId(page, 'account-balance-date', on);
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
}

/** The same, with its August balance confirmed as the statement, left on its page. */
async function accountWithAugustStatement(page: Page, name: string, august: string): Promise<void> {
  await existingAccount(page, name, august, '2026-08-31');
  await waitForRouter(page);
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
}

/** An ordinary snapshot, on the account page the browser is on. */
async function recordSnapshot(page: Page, amount: string, on: string): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', on);
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-history')).toContainText(on);
}

test.describe('a first month with nothing to measure', () => {
  test('a new user who adds the accounts they already have is told month to date starts next month', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_10 });
    await onboard(page, request, uniqueEmail('e2e-first-month'));

    // Both accounts existed before Vaultide, and both are first measured on the
    // 6th: a shared day, and still nothing to measure from (8.1, 8.6).
    await existingAccount(page, 'BBVA', '1500.00', '2026-10-06');
    await existingAccount(page, 'Savings', '4000.00', '2026-10-06');

    await gotoAfterRefresh(page, '/monthly/2026-10');
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');

    // The Overview says why there is no figure, and asks for nothing that would not help.
    const overview = page.getByTestId('mtd-no-common-date');
    await expect(overview).toHaveAttribute('data-cause', 'all_first_balance');
    await expect(overview).toContainText(
      'Every cash account started being tracked this month, so there is nothing to measure yet. Next month is measured from this month’s closing balances, once you enter them.',
    );
    await expect(overview).not.toContainText('Update all cash accounts');

    // So does the Reconciliation section, in place of an identity.
    await expect(page.getByTestId('mtd-no-identity')).toContainText(
      'Every cash account was first tracked this month, so there is nothing to reconcile yet',
    );

    // The issue keeps its key and its class, says the same, and offers no
    // "Update all today": a snapshot today leaves a first balance a first balance.
    const issue = page.getByTestId('issue-group-mtd_no_common_date');
    await expect(issue).toContainText('Blocking');
    await expect(issue).toContainText('Nothing to measure yet');
    await expect(issue.getByTestId('issue-action')).toHaveCount(0);
    await expect(issue.getByTestId('quick-update-open')).toHaveCount(0);

    // Nowhere does the page claim the accounts share no date.
    await expect(page.locator('main')).not.toContainText('do not share a balance date');
    await expect(page.locator('main')).not.toContainText('Update all cash accounts to the same date');

    // Spending says the same about the same month.
    await gotoAfterRefresh(page, '/expenses?month=2026-10');
    const summary = page.getByTestId('spending-summary');
    await expect(summary).toHaveAttribute('data-state', 'all_first_balance');
    await expect(page.getByTestId('spending-status')).toContainText('First month tracked');
    await expect(summary).toContainText(
      'Every cash account started being tracked this month, so there is nothing to measure yet',
    );
    await expect(page.getByTestId('spending-interval')).toContainText(
      'Every cash account started being tracked this month.',
    );
    await expect(page.getByTestId('spending-fix-link')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('share no balance date');
    await expect(page.locator('main')).not.toContainText('do not share a balance date');
  });

  test('someone with no cash account is told none takes part, and where to add one', async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_10 });
    await onboard(page, request, uniqueEmail('e2e-first-month-none'));

    await gotoAfterRefresh(page, '/monthly/2026-10');
    const overview = page.getByTestId('mtd-no-common-date');
    await expect(overview).toHaveAttribute('data-cause', 'no_cash_account');
    await expect(overview).toContainText('No cash account takes part in this month, so month to date has nothing to measure.');
    await expect(overview.getByTestId('mtd-add-account')).toHaveAttribute('href', '/accounts');
    await expect(page.getByTestId('mtd-no-identity')).toContainText(
      'No cash account takes part in this month, so there is nothing to reconcile',
    );

    // Adding one is the correction; updating balances there are none of is not.
    const issue = page.getByTestId('issue-group-mtd_no_common_date');
    await expect(issue).toContainText('No cash account this month');
    await expect(issue.getByTestId('issue-action')).toHaveCount(1);
    await expect(issue.getByTestId('issue-action')).toHaveText('Add a cash account');
    await expect(issue.getByTestId('issue-action')).toHaveAttribute('href', '/accounts');
    await expect(issue.getByTestId('quick-update-open')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('do not share a balance date');

    await gotoAfterRefresh(page, '/expenses?month=2026-10');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'no_cash_account');
    await expect(page.getByTestId('spending-summary')).toContainText(
      'No cash account takes part in October 2026, so there is no month-to-date spending figure',
    );
    await expect(page.getByTestId('spending-add-account')).toHaveAttribute('href', '/accounts');
    await expect(page.locator('main')).not.toContainText('share no balance date');
  });
});

test.describe('the first day of a month', () => {
  test('asks for the previous month’s statements, and stops once they are in', async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-first-month-close'));

    // August closed with a statement; September has none yet.
    await accountWithAugustStatement(page, 'Everyday', '1000.00');

    await gotoAfterRefresh(page, '/monthly/2026-10');
    const prompt = page.getByTestId('close-previous-month');
    await expect(prompt).toHaveText('Enter end-of-September balances to close the month.');
    await expect(prompt.getByRole('link')).toHaveAttribute('href', '/monthly/2026-09#accounts');
    // And beside it, when October itself can be closed (15.3).
    await expect(page.getByTestId('close-this-month')).toHaveText('October can be closed from 1 Nov 2026.');

    // The prompt leads to September's Accounts, where the statement is entered.
    await waitForRouter(page);
    await prompt.getByRole('link').click();
    await expect(page).toHaveURL(/\/monthly\/2026-09#accounts$/u);
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');
    const row = page.getByTestId('monthly-accounts').locator('tbody tr', { hasText: 'Everyday' });
    await row.getByTestId('closing-amount').fill('1200.00');
    await row.getByTestId('closing-amount').press('Enter');
    await expect(row.getByTestId('account-status')).toHaveText(/Complete/u);
    await expect(row.getByTestId('save-status')).toHaveText('Saved.');

    // Every opening of October now has its statement: nothing left to ask for.
    await gotoAfterRefresh(page, '/monthly/2026-10');
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');
    await expect(page.getByTestId('close-previous-month')).toHaveCount(0);
    await expect(page.getByTestId('close-this-month')).toHaveText('October can be closed from 1 Nov 2026.');
  });
});

test.describe('an expected salary nobody recorded', () => {
  test('leads the unexplained inflow with recording the salary, which then explains it', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': SEPTEMBER_30 });
    await onboard(page, request, uniqueEmail('e2e-first-month-salary'));

    // Everyday closed August at 1,000 and holds 3,100 today: 2,100 more than
    // anything recorded explains — the salary that arrived on the 25th.
    await accountWithAugustStatement(page, 'Everyday', '1000.00');
    await recordSnapshot(page, '3100.00', '2026-09-30');

    await gotoAfterRefresh(page, '/monthly/2026-09');
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');
    await page.getByTestId('source-add-toggle').click();
    await expect(page.getByTestId('source-submit')).toBeEnabled();
    await fillTestId(page, 'source-name', 'Salary');
    await page.getByTestId('source-kind').selectOption('employment');
    await page.getByTestId('source-frequency').selectOption('monthly');
    await fillTestId(page, 'source-day', '25');
    await fillTestId(page, 'source-start-date', '2026-09-01');
    await fillTestId(page, 'source-amount', '2100.00');
    await page.getByTestId('source-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Salary added.');

    await gotoAfterRefresh(page, '/monthly/2026-09');
    const issue = page.getByTestId('issue-group-unexplained_inflow');
    await expect(issue).toContainText('Cash grew more than your records explain');
    await expect(issue).toContainText('€2,100.00');

    // First: the salary itself, named with its date and amount, on its own row.
    const actions = issue.getByTestId('issue-action');
    const first = actions.first();
    await expect(first).toHaveText('Record Salary · €2,100.00');
    await expect(first).toHaveAttribute('data-action-id', /^unexplained_inflow:EUR::occurrence:[0-9a-f-]+:2026-09-25$/u);
    await expect(first).toHaveAttribute('href', /^#occurrence-[0-9a-f-]+-2026-09-25$/u);
    await expect(issue).toContainText('Expected on 25 Sept 2026 and not recorded yet.');
    // Then Add missing income, which says the salary is not recorded yet.
    await expect(actions.nth(1)).toHaveText('Add missing income');
    await expect(issue).toContainText(
      'Salary, expected this month, is not recorded yet — if that is this money, record it in Income instead, or the same money is counted twice.',
    );

    // Following it, and recording the salary there, explains the whole difference.
    await first.click();
    await expect(page).toHaveURL(/#occurrence-[0-9a-f-]+-2026-09-25$/u);
    const salary = page.getByTestId('income-occurrence').filter({ hasText: 'Salary' });
    await salary.getByTestId('occurrence-accept').click();
    await expect(salary.getByTestId('occurrence-status')).toHaveText('Recorded');
    await expect(page.getByTestId('issue-group-unexplained_inflow')).toHaveCount(0);
  });
});
