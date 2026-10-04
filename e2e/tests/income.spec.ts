import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The Income year view (blueprint 15.1 `/income`, 15.2 "Income", 16.5, 21.5;
 * v2.1.20 30.23; ADR 0012 D1–D3, D5, D8).
 *
 * Every record is written through the product's own pages, on 6 October 2026
 * with the test clock:
 *
 *  - a visitor who is not signed in is sent to sign-in with the whole address,
 *    year included, kept as the way back (17.2);
 *  - a new person finds Income in the navigation and its empty state; with a
 *    salary and payments recorded in Monthly — into a tracked account and
 *    outside one — the year shows them split, a past year shows its own, the
 *    missing salaries lead to Bulk History, and a payment and a source added
 *    from Income itself land on the page — which never widens a phone screen;
 *  - a payment that wakes an account dormant since a closed month opens Review
 *    changes and is confirmed there, rather than stopping at a refusal.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_6 = '2026-10-06T10:00:00Z';

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
  await page.getByLabel('Your name').fill('Income');
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
  await expect(page).toHaveURL(/\/dashboard$/u);
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

/** An account whose August statement is entered and confirmed, leaving the browser on its page. */
async function accountWithAugustStatement(page: Page, options: { name: string; august: string }): Promise<void> {
  await open(page, '/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('savings');
  await fillTestId(page, 'account-balance', options.august);
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();

  // The form refreshes the page after saving, and WebKit can drop a click that
  // lands while that refresh is in flight. Click until the address has moved.
  const link = page.getByRole('link', { name: options.name, exact: true });
  const accountPage = /\/accounts\/[0-9a-f-]{36}$/u;
  await expect(async () => {
    if (!accountPage.test(page.url())) await link.click({ timeout: 2_000 });
    await expect(page).toHaveURL(accountPage, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
}

/** The shared Add income form, on whichever page the browser is on. */
async function addIncome(
  page: Page,
  options: {
    kind: string;
    on: string;
    net: string;
    gross?: string;
    outside?: boolean;
    account?: string;
  },
): Promise<void> {
  await page.getByTestId('add-income').scrollIntoViewIfNeeded();
  await page.getByTestId('income-kind').selectOption(options.kind);
  await fillTestId(page, 'income-received-on', options.on);
  await fillTestId(page, 'income-net', options.net);
  if (options.gross !== undefined) await fillTestId(page, 'income-gross', options.gross);
  if (options.outside === true) {
    await page.getByTestId('income-settlement').selectOption('external');
  } else if (options.account !== undefined) {
    await page.getByTestId('income-account').selectOption({ label: options.account });
  }
  await page.getByTestId('income-submit').click();
}

/** The shared Add income source form, on whichever page the browser is on. */
async function addSource(
  page: Page,
  options: { name: string; kind: string; day: string; start: string; amount: string; gross?: string; account?: string },
): Promise<void> {
  await page.getByTestId('add-income-source').scrollIntoViewIfNeeded();
  await fillTestId(page, 'source-name', options.name);
  await page.getByTestId('source-kind').selectOption(options.kind);
  await fillTestId(page, 'source-day', options.day);
  await fillTestId(page, 'source-start-date', options.start);
  await fillTestId(page, 'source-amount', options.amount);
  if (options.gross !== undefined) await fillTestId(page, 'source-gross', options.gross);
  if (options.account !== undefined) await page.getByTestId('source-account').selectOption({ label: options.account });
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-saved')).toContainText(`${options.name} added.`);
}

/** Income from the shell: the sidebar on a desktop, More on a phone. */
async function incomeFromNavigation(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByTestId('mobile-navigation').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Income', exact: true }).click();
  } else {
    await page.getByTestId('desktop-navigation').getByRole('link', { name: 'Income', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/income$/u);
  await expect(page.getByTestId('income-title')).toHaveText('Income');
}

/** Nothing on the page reaches past the viewport's right edge (16.5). */
async function fitsItsViewport(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

const review = (page: Page) => page.getByTestId('correction-review');

test.describe('the Income page', () => {
  test('a visitor who is not signed in goes to sign-in and keeps the way back, year included', async ({ page }) => {
    // The (app) layout refuses too, but only the proxy remembers where the
    // visitor was going; without it the year, Income's URL state, is lost.
    for (const destination of ['/income', '/income?year=2025']) {
      await page.goto(destination);
      const landed = new URL(page.url());
      expect(landed.pathname).toBe('/sign-in');
      expect(landed.searchParams.get('next')).toBe(destination);
    }
  });

  test('a year of income recorded, tracked and outside, its missing salaries, and the two actions', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-income'));

    // --- Income in the navigation, before anything exists -------------------
    await incomeFromNavigation(page);
    await expect(page.getByTestId('income-empty')).toContainText('Add a salary or other income source');
    await expect(page.getByTestId('income-empty-add-source')).toHaveAttribute('href', '#add-source');
    // Only the kinds this page counts.
    const kinds = await page.getByTestId('income-kind').locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    expect(kinds).toEqual(['employment', 'freelance', 'bonus', 'rental', 'other', 'interest', 'dividend']);

    // --- what Monthly records ------------------------------------------------
    await accountWithAugustStatement(page, { name: 'BBVA', august: '1000.00' });
    await open(page, '/monthly/2026-09');
    await page.getByTestId('source-add-toggle').click();
    await addSource(page, { name: 'Salary', kind: 'employment', day: '25', start: '2026-07-01', amount: '2000.00', gross: '2800.00', account: 'BBVA' });
    // September's salary is recorded; July's and August's are not.
    const september = page.getByTestId('occurrence-accept');
    await expect(september).toBeVisible();
    await september.click();
    await expect(page.getByTestId('occurrence-status')).toContainText('Recorded');

    await page.getByTestId('income-add-toggle').click();
    await addIncome(page, { kind: 'freelance', on: '2026-09-10', net: '450.00', outside: true });
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');

    await open(page, '/monthly/2025-12');
    await page.getByTestId('income-add-toggle').click();
    await addIncome(page, { kind: 'bonus', on: '2025-12-20', net: '300.00', outside: true });
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');

    // --- the year view -------------------------------------------------------
    await open(page, '/dashboard');
    await incomeFromNavigation(page);
    await expect(page.getByTestId('income-empty')).toHaveCount(0);
    await expect(page.getByTestId('income-year-badge')).toHaveText('2026 (so far)');
    await expect(page.getByTestId('income-total')).toContainText('€2,450.00');
    await expect(page.getByTestId('income-tracked')).toContainText('€2,000.00');
    await expect(page.getByTestId('income-outside')).toContainText('€450.00');
    await expect(page.getByTestId('income-gross-total')).toContainText('€2,800.00');
    await expect(page.getByTestId('income-gross-total')).toContainText('1 without gross');
    await expect(page.getByTestId('income-differs')).toContainText('Reconciled income');

    const salaryRow = page.getByTestId('income-source').filter({ hasText: 'Salary' });
    await expect(salaryRow).toContainText('€2,000.00');
    await page.getByTestId('income-one-off-toggle').click();
    const freelance = page.getByTestId('income-one-off-payment');
    await expect(freelance).toHaveCount(1);
    await expect(freelance.getByRole('link')).toHaveAttribute('href', /^\/monthly\/2026-09#income-[0-9a-f-]{36}$/u);

    await page.getByTestId('income-view-table').click();
    await expect(page.locator('[data-testid="income-month"][data-month="2026-09"]')).toContainText('€2,450.00');
    await fitsItsViewport(page);

    // Monthly's September figure answers another question — what reconciliation
    // saw arrive in tracked accounts — and its label says so (30.23 item 3).
    await open(page, '/monthly/2026-09');
    await expect(page.getByTestId('figure-externalIncome')).toContainText('Reconciled income');
    await expect(page.getByTestId('figure-externalIncome')).toContainText('€2,000.00');
    await open(page, '/income');

    // --- change year ---------------------------------------------------------
    await page.getByTestId('income-year-previous').click();
    await expect(page).toHaveURL(/\/income\?year=2025$/u);
    await expect(page.getByTestId('income-year-badge')).toHaveText('2025');
    await expect(page.getByTestId('income-total')).toContainText('€300.00');
    await expect(page.getByTestId('income-missing-none')).toBeVisible();
    await page.getByTestId('income-year-next').click();
    await expect(page).toHaveURL(/\/income\?year=2026$/u);

    for (const year of ['26', '2027', 'next']) {
      const response = await page.goto(`/income?year=${year}`);
      expect(response?.status()).toBe(404);
    }
    await open(page, '/income');

    // --- a missing-payment line, and where it leads --------------------------
    const flag = page.getByTestId('income-missing-flag');
    await expect(flag).toHaveCount(1);
    await expect(flag).toContainText('Salary: 2 payments missing in 2026 (July, August).');
    const link = flag.getByTestId('income-missing-link');
    await expect(link).toHaveAttribute('href', '/monthly/2026-07/history');
    await link.click();
    await expect(page).toHaveURL(/\/monthly\/2026-07\/history$/u);
    await expect(page.getByTestId('bulk-title')).toBeVisible();

    // --- add a payment, into a month that has closed -------------------------
    await open(page, '/income');
    await addIncome(page, { kind: 'bonus', on: '2026-03-31', net: '500.00', gross: '700.00', account: 'BBVA' });
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');
    await expect(page.getByTestId('income-total')).toContainText('€2,950.00');
    await expect(page.getByTestId('income-gross-total')).toContainText('€3,500.00');

    // --- add a source --------------------------------------------------------
    await addSource(page, { name: 'Pension', kind: 'other', day: '1', start: '2026-11-01', amount: '100.00' });
    await expect(page.getByTestId('income-source').filter({ hasText: 'Pension' })).toContainText('€0.00');

    // A phone's width, with every table on the page.
    await page.setViewportSize({ width: 375, height: 800 });
    await fitsItsViewport(page);
  });

  test('a payment that wakes an account dormant since a closed month is reviewed and confirmed', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-income-dormant'));

    // An account emptied at the end of August and marked dormant from there.
    await accountWithAugustStatement(page, { name: 'Old savings', august: '0.00' });
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await page.getByTestId('edit-dormant').check();
    await page.getByTestId('edit-submit').click();
    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('edit-dormant')).toBeChecked();

    // A salary into it today ends a dormant period that began in a closed month.
    await open(page, '/income');
    await addIncome(page, { kind: 'employment', on: '2026-10-02', net: '80.00', account: 'Old savings' });
    await expect(review(page)).toBeVisible();
    await expect(review(page).getByTestId('correction-structural')).toContainText('no longer dormant from 31 Aug 2026');
    // Nothing is written until it is confirmed.
    await expect(page.getByTestId('income-saved')).toHaveCount(0);
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    await expect(page.getByTestId('income-payment-confirmed')).toBeVisible();
    await expect(page.getByTestId('income-total')).toContainText('€80.00');
    // The form starts again, empty.
    await expect(page.getByTestId('income-net')).toHaveValue('');
  });
});
