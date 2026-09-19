import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Correcting what reconciliation found (blueprint 8.5, 15.3 section 8, 30.21;
 * ADR 0009).
 *
 * Six journeys, each starting from a month that genuinely raises the issue —
 * every record is written through the product's own pages, there is no seeding
 * endpoint, and no fixture reaches past an invariant. What is asserted is what
 * a person would see: the correction offered beside the issue, what the form it
 * opens already knows, and what the month says once the record exists.
 *
 * Rates come from the deterministic fixture (`FX_PROVIDER=fixture`), so the
 * cross-currency journey's evidence is reproducible.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_1 = '2026-10-01T10:00:00Z';
const SEPTEMBER_10 = '2026-09-10T10:00:00Z';

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
  await page.getByLabel('Your name').fill('Corrections');
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
 * Go to a page after a save. The forms refresh their page once a save lands,
 * and WebKit reports a navigation issued while that refresh is in flight as
 * interrupted; retrying once it settles is the navigation the test meant.
 */
async function open(page: Page, url: string): Promise<void> {
  await expect(async () => {
    await page.goto(url);
  }).toPass({ timeout: 15_000 });
}

/** An account with an opening balance on a date, left on its own page. */
async function addAccount(
  page: Page,
  options: {
    name: string;
    type?: 'checking' | 'savings';
    currency?: string;
    balance?: string;
    balanceOn?: string;
  },
): Promise<void> {
  await open(page, '/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption(options.currency ?? 'EUR');
  await page.getByTestId('account-type').selectOption(options.type ?? 'checking');
  if (options.balance !== undefined && options.balanceOn !== undefined) {
    await fillTestId(page, 'account-balance', options.balance);
    await fillTestId(page, 'account-balance-date', options.balanceOn);
  }
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();
}

/** An ordinary snapshot, on the account page the browser is on. */
async function recordValuation(page: Page, amount: string, on: string): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', on);
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-history')).toContainText(on);
}

async function openAccount(page: Page, name: string): Promise<void> {
  await open(page, '/accounts?tab=cash');
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByTestId('position-native')).toBeVisible();
  // Controlled forms are not usable until React owns them (`useHydrated`), and
  // the buttons around them are not wired either.
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
}

/**
 * An account with statement balances at both month ends — the ordinary way a
 * month is closed: a last-day snapshot confirmed as the statement (8.1).
 */
async function accountWithStatements(
  page: Page,
  options: {
    name: string;
    august: string;
    september: string;
    type?: 'checking' | 'savings';
    currency?: string;
  },
): Promise<void> {
  await addAccount(page, {
    name: options.name,
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.currency === undefined ? {} : { currency: options.currency }),
    balance: options.august,
    balanceOn: '2026-08-31',
  });
  await openAccount(page, options.name);
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);

  await recordValuation(page, options.september, '2026-09-30');
  await page.getByTestId('confirm-statement-2026-09').click();
  await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);
}

/** The corrective control of one issue, by the action the model gave it. */
function actionIn(page: Page, group: string, actionId: string): Locator {
  return page.getByTestId(`issue-group-${group}`).locator(`[data-action-id="${actionId}"]`);
}

const dialog = (page: Page): Locator => page.getByTestId('issue-dialog');

test.describe('an unexplained inflow', () => {
  test('is accepted as an adjustment, which the month then shows as a record', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-adjustment'));

    // September closed 500 higher than August with nothing recorded to explain
    // it: 8.5's variant A, an unexplained inflow of 500.
    await accountWithStatements(page, { name: 'BBVA', august: '1000.00', september: '1500.00' });

    await open(page, '/monthly/2026-09');
    const group = page.getByTestId('issue-group-unexplained_inflow');
    await expect(group).toContainText('Cash grew more than your records explain');
    await expect(group).toContainText('€500.00');

    // The fallback is offered last, under the corrections that would explain it.
    const actions = group.getByTestId('issue-action');
    await expect(actions.first()).toHaveText('Add missing income');
    await expect(actions.last()).toHaveText('Record reconciliation adjustment');

    // The corrections wrap rather than widening the page, on a phone as much as
    // on a desktop (16.5).
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await actionIn(page, 'unexplained_inflow', 'unexplained_inflow:EUR::adjustment').click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('adjustment-amount')).toContainText('€500.00');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect(page.getByTestId('adjustment-date')).toContainText('30 Sept 2026');
    await expect(page.getByTestId('adjustment-date')).toContainText('bookkeeping date');
    // No account to choose, and no amount to edit: both are the month's own.
    await expect(dialog(page).locator('select')).toHaveCount(0);
    await expect(dialog(page).getByTestId('income-net')).toHaveCount(0);

    await fillTestId(page, 'adjustment-note', 'Could not trace it');
    await page.getByTestId('adjustment-submit').click();
    await expect(dialog(page)).toBeHidden();

    // The month reconciles, and the adjustment is a visible record.
    await expect(page.getByTestId('no-issues')).toBeVisible();
    await expect(page.getByTestId('bucket-EUR')).toContainText('Reliable');
    await expect(page.getByTestId('bucket-EUR').getByTestId('identity-unclassified')).toContainText(
      '€0.00',
    );
    const direct = page.getByTestId('income-direct');
    await expect(direct).toContainText('Reconciliation adjustment');
    await expect(direct).toContainText('Reconciliation adjustment — September 2026: Could not trace it');
    await expect(direct).toContainText('€500.00');
    // It explains the cash without becoming income (7.4, 12.5).
    await expect(page.getByTestId('figure-externalIncome')).toContainText('€0.00');
  });

  test('refuses a second acceptance from a view the month has moved past', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-vaultide-test-clock': OCTOBER_1 },
    });
    const first = await context.newPage();
    await onboard(first, request, uniqueEmail('e2e-adjustment-stale'));
    await accountWithStatements(first, { name: 'BBVA', august: '1000.00', september: '1500.00' });

    // Two views of the same month, both showing the same unexplained inflow.
    await first.goto('/monthly/2026-09');
    const second = await context.newPage();
    await second.goto('/monthly/2026-09');
    await expect(second.getByTestId('issue-group-unexplained_inflow')).toBeVisible();

    await actionIn(first, 'unexplained_inflow', 'unexplained_inflow:EUR::adjustment').click();
    await first.getByTestId('adjustment-submit').click();
    await expect(first.getByTestId('no-issues')).toBeVisible();

    // The stale view still offers it; the server refuses, and records nothing.
    await actionIn(second, 'unexplained_inflow', 'unexplained_inflow:EUR::adjustment').click();
    await second.getByTestId('adjustment-submit').click();
    await expect(second.getByTestId('adjustment-error')).toContainText('has changed since you opened it');

    await second.goto('/monthly/2026-09');
    await expect(second.getByTestId('income-direct').getByTestId('income-entry')).toHaveCount(1);
    await context.close();
  });
});

test.describe('a possible missing conversion', () => {
  test('records the transfer it suggests, once the accounts and the day are chosen', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-conversion'));

    // Euros gained 1,000 nobody recorded; dollars lost 3,200 nobody recorded.
    // At the month's average rate the two look like one conversion (30.15).
    await accountWithStatements(page, { name: 'Euros', august: '1000.00', september: '2000.00' });
    await accountWithStatements(page, {
      name: 'Dollars',
      currency: 'USD',
      august: '5000.00',
      september: '1800.00',
    });

    await open(page, '/monthly/2026-09');
    const group = page.getByTestId('issue-group-possible_missing_conversion');
    await expect(group).toContainText('Possible unrecorded currency conversion');
    await expect(group).toContainText('3,200.00');
    await expect(group).toContainText('€1,000.00');

    await actionIn(
      page,
      'possible_missing_conversion',
      'possible_missing_conversion:EUR::transfer:USD',
    ).click();
    await expect(dialog(page)).toBeVisible();

    // The two native residuals, and nothing else: no accounts, no day, no fee.
    await expect(dialog(page).getByTestId('transfer-amount-sent')).toHaveValue('3200');
    await expect(dialog(page).getByTestId('transfer-amount-received')).toHaveValue('1000');
    await expect(dialog(page).getByTestId('transfer-date')).toHaveValue('');
    await expect(dialog(page).getByTestId('transfer-from')).toHaveValue('');
    await expect(dialog(page).getByTestId('transfer-to')).toHaveValue('');
    await expect(dialog(page).getByTestId('transfer-fee-toggle')).not.toBeChecked();

    await dialog(page).getByTestId('transfer-date').fill('2026-09-15');
    // Each side is narrowed to its own currency, and the user picks the account.
    await dialog(page).getByTestId('transfer-from').selectOption({ label: 'Dollars (USD)' });
    await dialog(page).getByTestId('transfer-to').selectOption({ label: 'Euros (EUR)' });
    await dialog(page).getByTestId('transfer-save').click();
    await expect(dialog(page)).toBeHidden();

    // Both currencies now reconcile, and the advisory has nothing to suggest.
    await expect(page.getByTestId('bucket-EUR')).toContainText('Reliable');
    await expect(page.getByTestId('bucket-USD')).toContainText('Reliable');
    await expect(page.getByTestId('issue-group-possible_missing_conversion')).toHaveCount(0);
    await expect(page.getByTestId('issue-group-unexplained_inflow')).toHaveCount(0);
    await expect(page.getByTestId('transfer-list')).toContainText('Dollars → Euros');
  });
});

test.describe('a possible missing interest', () => {
  test('opens the income form knowing the account and the amount, but not the day', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-interest'));

    // Savings grew 31 more than its records explain — under half a per cent of
    // its balance, which is what 8.5 calls plausible interest.
    await accountWithStatements(page, { name: 'BBVA', august: '2000.00', september: '1500.00' });
    await accountWithStatements(page, {
      name: 'Savings',
      type: 'savings',
      august: '10000.00',
      september: '10031.00',
    });

    await open(page, '/monthly/2026-09');
    const group = page.getByTestId('issue-group-possible_missing_interest');
    await expect(group).toContainText('Possible unrecorded interest');

    // Its action id carries the account's own id, so the control is taken from
    // the group rather than guessed.
    await group.getByTestId('issue-action').first().click();
    await expect(dialog(page)).toBeVisible();

    await expect(dialog(page).getByTestId('income-kind')).toHaveValue('interest');
    await expect(dialog(page).getByTestId('income-net')).toHaveValue('31');
    await expect(dialog(page).getByTestId('income-received-on')).toHaveValue('');
    // The account the residual belongs to, already chosen (ADR 0009 §11).
    await expect(dialog(page).getByTestId('income-account')).not.toHaveValue('__none__');

    await dialog(page).getByTestId('income-received-on').fill('2026-09-30');
    await dialog(page).getByTestId('income-submit').click();
    await expect(dialog(page)).toBeHidden();

    // The residual is explained, so the advisory is gone; the unclassified
    // spending it had been hiding is now visible (8.10).
    await expect(page.getByTestId('issue-group-possible_missing_interest')).toHaveCount(0);
    await expect(page.getByTestId('bucket-EUR').getByTestId('identity-unclassified')).toContainText(
      '€500.00',
    );
  });
});

test.describe('the current month with no common balance date', () => {
  test('updates every account today from the issue itself', async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': SEPTEMBER_10 });
    await onboard(page, request, uniqueEmail('e2e-mtd'));

    // Two accounts with August statements, then snapshots on different days:
    // no date they share, so there is no month-to-date figure at all (8.6).
    await addAccount(page, { name: 'BBVA', balance: '1000.00', balanceOn: '2026-08-31' });
    await openAccount(page, 'BBVA');
    await page.getByTestId('confirm-statement-2026-08').click();
    await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
    await recordValuation(page, '900.00', '2026-09-06');

    await addAccount(page, { name: 'Savings', balance: '500.00', balanceOn: '2026-08-31' });
    await openAccount(page, 'Savings');
    await page.getByTestId('confirm-statement-2026-08').click();
    await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
    await recordValuation(page, '500.00', '2026-09-03');

    await open(page, '/monthly/2026-09');
    await expect(page.getByTestId('mtd-no-identity')).toBeVisible();
    const group = page.getByTestId('issue-group-mtd_no_common_date');
    await expect(group).toBeVisible();

    await group.getByTestId('quick-update-open').click();
    // The Accounts section has its own Quick update; this is the issue's.
    const rows = group.locator('[data-testid^="quick-balance-"]');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).fill('880.00');
    await rows.nth(1).fill('505.00');
    await group.getByTestId('quick-update-save').click();

    // Every account now shares today, so month to date reaches it — and the
    // issue that offered this correction, modal and all, is simply gone.
    await expect(page.getByTestId('mtd-no-identity')).toHaveCount(0);
    await expect(page.getByTestId('issue-group-mtd_no_common_date')).toHaveCount(0);
    await expect(page.getByTestId('mtd-as-of')).toContainText('10 Sept 2026');
    await expect(page.getByTestId('bucket-EUR')).toBeVisible();
  });
});

test.describe('missing evidence', () => {
  test('sends each issue to the exact row that holds it', async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-evidence'));

    // BBVA has August's statement and not September's; Savings is tracked from
    // September, so its first balance lands in the month (8.1).
    await addAccount(page, { name: 'BBVA', balance: '1000.00', balanceOn: '2026-08-31' });
    await openAccount(page, 'BBVA');
    await page.getByTestId('confirm-statement-2026-08').click();
    await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);

    await addAccount(page, { name: 'Savings', balance: '400.00', balanceOn: '2026-09-30' });
    await openAccount(page, 'Savings');
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    await open(page, '/monthly/2026-09');
    const missing = page.getByTestId('issue-group-missing_month_end');
    await expect(missing).toContainText('Month-end balance missing');

    // The closing statement is the one missing, so the correction is this
    // month's own row — and the row is where the balance is entered.
    await missing.getByTestId('issue-action').first().click();
    const bbvaRow = page.locator('[data-testid="monthly-account"]').filter({ hasText: 'BBVA' });
    await expect(bbvaRow.getByTestId('closing-amount')).toBeVisible();

    // The informational first balance offers the previous month's row.
    const firstBalance = page.getByTestId('issue-group-first_balance');
    await expect(firstBalance).toContainText('First balance this month');
    await firstBalance.getByTestId('issue-action').first().click();
    await expect(page).toHaveURL(/\/monthly\/2026-08#account-/u);
    const savingsRow = page.locator('[data-testid="monthly-account"]').filter({ hasText: 'Savings' });
    await expect(savingsRow.getByTestId('closing-amount')).toBeVisible();
  });
});

test.describe('a flow with no cash account', () => {
  test('names the record it is about and lands on it', async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-stranded'));
    await accountWithStatements(page, { name: 'BBVA', august: '1000.00', september: '1000.00' });

    // A dollar account, an income recorded without naming an account — which
    // the write path allows only while a dollar account exists — and then that
    // account, which has no balances of its own, deleted (6.3).
    await addAccount(page, { name: 'Dollars', currency: 'USD' });
    await open(page, '/monthly/2026-09');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-currency').selectOption('USD');
    await fillTestId(page, 'income-net', '400.00');
    await fillTestId(page, 'income-received-on', '2026-09-12');
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toBeVisible();

    await openAccount(page, 'Dollars');
    await page.getByTestId('delete-position').click();
    // The refresh the delete brings leaves no account page behind; navigating
    // before it lands would cancel the request in flight.
    await expect(page.getByTestId('delete-position')).toHaveCount(0);
    await open(page, '/accounts?tab=cash');
    await expect(page.getByRole('link', { name: 'Dollars', exact: true })).toHaveCount(0);

    await open(page, '/monthly/2026-09');
    const group = page.getByTestId('issue-group-flow_without_cash_account');
    await expect(group).toContainText('Flow without a cash account');
    await expect(group).toContainText('400.00');
    // It says which record, and where to go for the account it needs.
    await expect(group.getByTestId('issue-action').first()).toHaveText('Add a USD cash account');
    const review = group.getByTestId('issue-action').last();
    await expect(review).toHaveText('Review this record');
    await review.click();

    const row = page.locator('[data-testid="income-entry"]').filter({ hasText: '400.00' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Not attributed yet');
  });
});
