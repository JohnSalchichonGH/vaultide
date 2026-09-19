import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * The standalone Spending page (blueprint 15.2 "Spending", 16.5, 16.6, 21.5;
 * ADR 0008).
 *
 * Every record is written through the product's own pages, with the test clock:
 *
 *  - a new person finds the empty state, moves between months with the links,
 *    reaches the current month, and cannot open a month that is not one or has
 *    not begun;
 *  - recording a tracked known expense from Spending moves money from
 *    unclassified to known and leaves tracked spending as it was; spending paid
 *    outside tracked accounts is added beside it; a partner's dinner changes no
 *    total — and the page stays usable at 375 px;
 *  - a missing month end is reconciled as one combined period — tracked 1,694,
 *    known 972, unclassified 722 — which no month inherits and rolling ignores;
 *  - a month before any account is not tracked, and adding a pre-existing
 *    account turns the same month into missing evidence;
 *  - the current month is provisional through its common date, and without one
 *    keeps only what needs no date.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';

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
  await page.getByLabel('Your name').fill('Spending');
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
 * A cash account whose first balance is entered as a last-day snapshot and
 * confirmed as that month's statement, leaving the browser on its page. `new`
 * gives it an opening date; otherwise it pre-existed, with no opening date.
 */
async function account(
  page: Page,
  options: { name: string; balance: string; on: string; openedOn?: string },
): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('checking');
  if (options.openedOn !== undefined) {
    await page.getByTestId('origin-new').check();
    await page.getByLabel('Opened on').fill(options.openedOn);
  }
  await fillTestId(page, 'account-balance', options.balance);
  await fillTestId(page, 'account-balance-date', options.on);
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();

  // The form refreshes the page after saving, and WebKit can drop a click that
  // lands while that refresh is in flight. Click until the address has moved,
  // never twice once it has.
  const link = page.getByRole('link', { name: options.name, exact: true });
  const accountPage = /\/accounts\/[0-9a-f-]{36}$/u;
  await expect(async () => {
    if (!accountPage.test(page.url())) await link.click({ timeout: 2_000 });
    await expect(page).toHaveURL(accountPage, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const month = options.on.slice(0, 7);
  if (options.on.endsWith(monthEndDay(month))) {
    await page.getByTestId(`confirm-statement-${month}`).click();
    await expect(page.getByTestId(`month-end-${month}`)).toHaveCount(0);
  }
}

function monthEndDay(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate());
}

/** A balance on the account page the browser is on; confirmed as the statement when it is a month's last day. */
async function balance(page: Page, amount: string, on: string, statement: boolean): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', on);
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-saved')).toBeVisible();
  if (statement) {
    const month = on.slice(0, 7);
    await page.getByTestId(`confirm-statement-${month}`).click();
    await expect(page.getByTestId(`month-end-${month}`)).toHaveCount(0);
  }
}

/** Record a known expense with Spending's own form, on the Spending page the browser is on. */
async function addExpense(
  page: Page,
  options: {
    amount: string;
    on: string;
    category?: string;
    payment?: 'Paid from tracked account' | 'Paid by me outside tracked accounts' | 'Paid by someone else';
    account?: string;
    note?: string;
  },
): Promise<void> {
  const form = page.getByTestId('add-expense');
  await form.scrollIntoViewIfNeeded();
  await page.getByTestId('expense-add-category').selectOption({ label: options.category ?? 'Groceries' });
  await fillTestId(page, 'expense-add-date', options.on);
  await fillTestId(page, 'expense-add-amount', options.amount);
  await page
    .getByTestId('expense-add-payment')
    .selectOption({ label: options.payment ?? 'Paid from tracked account' });
  if (options.account !== undefined) {
    await page.getByTestId('expense-add-account').selectOption({ label: options.account });
  }
  if (options.note !== undefined) await fillTestId(page, 'expense-add-description', options.note);
  await page.getByTestId('expense-add-submit').click();
  await expect(page.getByTestId('expense-add-saved')).toContainText('Expense added.');
}

const figure = (page: Page, testId: string): Locator => page.getByTestId(testId);
const historyRow = (page: Page, month: string): Locator =>
  page.locator(`[data-testid="spending-history-row"][data-month="${month}"]`);

/** Nothing on the page reaches past the viewport's right edge (16.5). */
async function fitsItsViewport(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

test.describe('the Spending page', () => {
  test('a new person finds the empty state, moves between months, and cannot open a month that is not one', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-01T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-spending-months'));

    await page.goto('/expenses');
    await expect(page.getByTestId('spending-title')).toHaveText('Spending');
    // The last completed month by default, not the one in progress.
    await expect(page.getByTestId('spending-month')).toHaveText('September 2026');
    await expect(page.getByTestId('spending-empty')).toContainText('Enter two month-end balances to see inferred spending');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'not_observed');

    await page.getByTestId('month-previous').click();
    await expect(page).toHaveURL(/\/expenses\?month=2026-08$/u);
    await expect(page.getByTestId('spending-month')).toHaveText('August 2026');
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/expenses\?month=2026-09$/u);
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/expenses\?month=2026-10$/u);
    await expect(page.getByTestId('spending-month')).toHaveText('October 2026');
    await expect(page.getByTestId('spending-status')).toContainText('No common date');
    // The current month never counts in rolling; the windows end at September and say so.
    await expect(page.getByTestId('spending-rolling-3')).toContainText('through September 2026');
    // Nothing leads into a month that has not begun.
    await expect(page.getByTestId('month-next')).toHaveCount(0);

    await page.getByTestId('spending-open-month').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);

    for (const month of ['2026-13', 'September', '2026-11']) {
      const response = await page.goto(`/expenses?month=${month}`);
      expect(response?.status()).toBe(404);
    }
  });

  test('recording expenses moves money from unclassified to known, adds outside spending beside it, and a partner’s dinner changes no total', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-01T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-spending-invariant'));

    // One euro account that fell from 1,000 to 700 in September, with nothing recorded.
    await account(page, { name: 'BBVA', balance: '1000.00', on: '2026-08-31' });
    await balance(page, '700.00', '2026-09-30', true);

    await page.goto('/expenses');
    await expect(page.getByTestId('spending-month')).toHaveText('September 2026');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'reliable');
    await expect(figure(page, 'spending-tracked')).toContainText('€300.00');
    await expect(figure(page, 'spending-known')).toContainText('€0.00');
    await expect(figure(page, 'spending-unclassified')).toContainText('€300.00');
    await expect(figure(page, 'spending-total')).toContainText('€300.00');

    // A tracked known expense: tracked unchanged, known +40, unclassified −40, total unchanged.
    await addExpense(page, { amount: '40.00', on: '2026-09-15', account: 'BBVA', note: 'Weekly shop' });
    await expect(figure(page, 'spending-known')).toContainText('€40.00');
    await expect(figure(page, 'spending-tracked')).toContainText('€300.00');
    await expect(figure(page, 'spending-unclassified')).toContainText('€260.00');
    await expect(figure(page, 'spending-total')).toContainText('€300.00');

    // Spending paid outside tracked accounts: tracked unchanged, additional +25, total +25.
    await addExpense(page, {
      amount: '25.00',
      on: '2026-09-20',
      category: 'Eating out',
      payment: 'Paid by me outside tracked accounts',
      note: 'Cash lunch',
    });
    await expect(figure(page, 'spending-additional')).toContainText('€25.00');
    await expect(figure(page, 'spending-total')).toContainText('€325.00');
    await expect(figure(page, 'spending-tracked')).toContainText('€300.00');
    const savedBefore = await figure(page, 'spending-saved-from-income').innerText();
    const personalBefore = await figure(page, 'spending-personal-savings').innerText();

    // --- the rest at 375 px, where the form must still be usable -------------
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await fitsItsViewport(page);

    // A partner's dinner: paid by others only, and in no spending or savings figure.
    await addExpense(page, {
      amount: '80.00',
      on: '2026-09-21',
      category: 'Eating out',
      payment: 'Paid by someone else',
      note: 'Partner paid',
    });
    await expect(figure(page, 'spending-paid-by-others')).toContainText('€80.00');
    await expect(figure(page, 'spending-total')).toContainText('€325.00');
    await expect(figure(page, 'spending-additional')).toContainText('€25.00');
    await expect(figure(page, 'spending-tracked')).toContainText('€300.00');
    await expect(figure(page, 'spending-known')).toContainText('€40.00');
    expect(await figure(page, 'spending-saved-from-income').innerText()).toBe(savedBefore);
    expect(await figure(page, 'spending-personal-savings').innerText()).toBe(personalBefore);

    // The breakdown explains known spending and nothing else.
    const categories = page.getByTestId('spending-categories');
    await expect(categories.locator('[data-category="Groceries"]')).toContainText('€40.00');
    await expect(categories.locator('[data-category="Eating out"]')).toContainText('€25.00');
    await expect(categories).not.toContainText('€80.00');
    await expect(page.getByTestId('spending-categories-unclassified')).toContainText('€260.00');
    const largest = page.getByTestId('spending-largest');
    await expect(largest.getByTestId('spending-largest-row')).toHaveCount(2);
    await expect(largest).toContainText('Weekly shop');
    await expect(largest).toContainText('Additional spending');
    await expect(largest).not.toContainText('Partner paid');

    // 16.5 at 375 px: the history table scrolls inside itself with its month
    // column pinned, the chart scrolls in its own container, the page itself
    // never widens, and the bottom tabs never cover the form's button.
    await fitsItsViewport(page);
    const scroller = page.getByTestId('spending-history-scroll');
    const overflow = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    const sticky = await historyRow(page, '2026-09')
      .locator('th')
      .evaluate((element) => getComputedStyle(element).position);
    expect(sticky).toBe('sticky');
    await expect(page.getByTestId('spending-chart-scroll')).toBeVisible();

    const tabs = page.getByTestId('mobile-navigation');
    const submit = page.getByTestId('expense-add-submit');
    await submit.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const [button, bar] = await Promise.all([submit.boundingBox(), tabs.boundingBox()]);
        if (button === null || bar === null) return Number.NaN;
        return bar.y - (button.y + button.height);
      })
      .toBeGreaterThanOrEqual(0);
  });

  test('a missing month end is one combined period — tracked 1,694, known 972, unclassified 722 — that no month inherits', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-11-02T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-spending-span'));

    // End of August, then nothing until the end of October: September's month
    // end is missing for both accounts.
    await account(page, { name: 'BBVA', balance: '8055.00', on: '2026-08-31' });
    await balance(page, '6361.00', '2026-10-31', true);
    await account(page, { name: 'Savings', balance: '8509.00', on: '2026-08-31' });
    await balance(page, '8509.00', '2026-10-31', true);

    await page.goto('/expenses?month=2026-09');
    await addExpense(page, { amount: '300.00', on: '2026-09-12', category: 'Insurance', account: 'BBVA' });
    await addExpense(page, { amount: '111.00', on: '2026-09-01', category: 'Rent & mortgage costs', account: 'BBVA' });
    await page.goto('/expenses?month=2026-10');
    await addExpense(page, { amount: '450.00', on: '2026-10-14', category: 'Home maintenance', account: 'BBVA' });
    await addExpense(page, { amount: '111.00', on: '2026-10-01', category: 'Rent & mortgage costs', account: 'BBVA' });

    const span = page.getByTestId('spending-span');
    await expect(span).toHaveCount(1);
    await expect(span).toContainText(/Combined period · 1 Sept? 2026 – 31 Oct 2026/u);
    await expect(span).toContainText('EUR');
    await expect(span.getByTestId('span-tracked')).toHaveText('€1,694.00');
    await expect(span.getByTestId('span-known')).toHaveText('€972.00');
    await expect(span.getByTestId('span-unclassified')).toHaveText('€722.00');

    // Neither month has a figure of its own; both point at the period.
    for (const month of ['2026-09', '2026-10']) {
      await expect(historyRow(page, month)).toHaveAttribute('data-state', 'unavailable');
      await expect(historyRow(page, month).getByTestId('spending-history-span-link')).toBeVisible();
      await expect(historyRow(page, month).getByTestId('history-rolling')).toHaveText('Does not count');
    }
    // It never enters rolling, and nothing divides it into months.
    await expect(page.getByTestId('spending-rolling-3-count')).toHaveText('No month in these 3 qualified');
    await expect(page.getByTestId('spending-chart-bracket')).toHaveText('Combined EUR period: €1,694.00 tracked');
    await expect(page.locator('body')).not.toContainText('€847');
    await expect(page.locator('body')).not.toContainText('€361');
  });

  test('a month before any account is not tracked, and a pre-existing account makes the same month missing evidence', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-01T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-spending-observed'));

    // A new account, opened on 10 June: May has no cash account at all.
    await account(page, { name: 'Fresh', balance: '500.00', on: '2026-06-30', openedOn: '2026-06-10' });
    await page.goto('/expenses');
    await expect(historyRow(page, '2026-05')).toHaveAttribute('data-state', 'not_observed');
    await expect(historyRow(page, '2026-05')).toContainText('Not tracked');

    await page.goto('/expenses?month=2026-05');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'not_observed');
    await expect(page.getByTestId('spending-status')).toContainText('Not tracked');
    await expect(page.getByTestId('spending-summary')).toContainText('nothing to fix');
    await expect(page.getByTestId('spending-fix-link')).toHaveCount(0);

    // An account that already existed takes part in every earlier month, so
    // May now lacks its evidence — an invitation to enter it, not "not tracked".
    await account(page, { name: 'Old', balance: '1000.00', on: '2026-08-31' });
    await page.goto('/expenses?month=2026-05');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'unavailable');
    await expect(page.getByTestId('spending-problems')).toContainText('missing month-end balance for Old');
    await expect(page.getByTestId('spending-fix-link')).toHaveAttribute('href', '/monthly/2026-05#accounts');
    await expect(historyRow(page, '2026-05')).toHaveAttribute('data-state', 'unavailable');
    await expect(historyRow(page, '2026-05')).not.toContainText('Not tracked');
  });

  test('the current month is provisional through its common date, and without one keeps only what needs no date', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-10T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-spending-current'));

    await account(page, { name: 'BBVA', balance: '1000.00', on: '2026-09-30' });
    await balance(page, '900.00', '2026-10-06', false);

    await page.goto('/expenses?month=2026-10');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'provisional');
    await expect(page.getByTestId('spending-as-of')).toContainText('6 Oct 2026');
    await expect(figure(page, 'spending-tracked')).toContainText('€100.00');
    await expect(historyRow(page, '2026-10')).toContainText('through 6 Oct 2026');
    await expect(historyRow(page, '2026-10').getByTestId('history-rolling')).toHaveText('Does not count');
    await expect(page.getByTestId('spending-rolling-3')).toContainText('through September 2026');

    // A second account measured on another day: no day is shared, so no
    // month-to-date figure exists at all.
    await account(page, { name: 'Savings', balance: '500.00', on: '2026-09-30' });
    await balance(page, '450.00', '2026-10-03', false);
    await page.goto('/expenses?month=2026-10');
    await expect(page.getByTestId('spending-summary')).toHaveAttribute('data-state', 'no_common_date');
    await expect(page.getByTestId('spending-summary')).toContainText('Update all cash accounts to the same date');
    await expect(figure(page, 'spending-tracked')).toHaveCount(0);
    await expect(figure(page, 'spending-total')).toHaveCount(0);

    // What needs no date still counts, through today, on its own.
    await addExpense(page, {
      amount: '9.00',
      on: '2026-10-08',
      category: 'Eating out',
      payment: 'Paid by me outside tracked accounts',
    });
    await expect(figure(page, 'spending-additional')).toContainText('Additional spending through today');
    await expect(figure(page, 'spending-additional')).toContainText('€9.00');
    await expect(page.getByTestId('spending-largest')).toHaveAttribute('data-mode', 'source_only');
    await expect(page.getByTestId('spending-categories-no-tracked')).toBeVisible();
  });
});
