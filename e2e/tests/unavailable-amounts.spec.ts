import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoAfterRefresh, waitForRouter } from '../support/navigation';

/**
 * An amount that cannot be stated, on a phone (blueprint 16.2, 16.4, 16.6).
 *
 * `MoneyText` shows an unavailable amount as `—`, with its reason as the
 * mouse's tooltip and as text a screen reader reads in place of the dash. That
 * text is visually hidden, which positions it absolutely; inside a scroll box
 * that is not itself positioned it would escape the box and widen the whole
 * page at phone width. So each page that shows such an amount is opened at
 * 375 px with one on it, and must be exactly as wide as the screen.
 *
 * The person has an account whose September statement was never entered, so
 * September cannot be reconciled, and a coin collection counted in their net
 * worth that nobody has valued. "Today" is 6 October 2026.
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
  await page.getByLabel('Your name').fill('Unavailable');
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
 * Every unavailable amount the page shows reads its reason, not the dash, and
 * the page is no wider than the screen.
 *
 * Every `<details>` is opened first, so the table under each chart ("View as
 * table", 16.3) is laid out with the rest: a closed one lays nothing out. An
 * amount inside a dialog that is not open is not on the page.
 */
async function readsAndFits(page: Page, where: string): Promise<void> {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('details:not([open])')) details.setAttribute('open', '');
  });
  const unavailable = page.getByTestId('money-text-unavailable').filter({ visible: true });
  await expect(unavailable.first()).toBeVisible();
  for (const amount of await unavailable.all()) {
    const reason = (await amount.getAttribute('title')) ?? '';
    expect(reason).not.toBe('');
    const read = await amount.ariaSnapshot();
    expect(read, `${where}: what a screen reader reads`).toContain(reason);
    // The reason and nothing else: a reason may hold a dash of its own.
    expect(read.replace(reason, ''), `${where}: what a screen reader reads`).not.toContain('—');
  }

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll, `${where}: the page is ${String(width.scroll)} px wide on a ${String(width.client)} px screen`).toBe(
    width.client,
  );
}

test.use({ viewport: { width: 375, height: 812 } });

test.describe('an unavailable amount on a phone', () => {
  test('reads its reason to a screen reader, and widens no page that shows it', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-unavailable'));

    // An account with August's statement and no September one.
    await gotoAfterRefresh(page, '/accounts?tab=cash');
    await expect(page.getByTestId('account-submit')).toBeEnabled();
    await fillTestId(page, 'account-name', 'Everyday');
    await page.getByTestId('account-currency').selectOption('EUR');
    await page.getByTestId('account-type').selectOption('checking');
    await fillTestId(page, 'account-balance', '2000.00');
    await fillTestId(page, 'account-balance-date', '2026-08-31');
    await page.getByTestId('account-submit').click();
    await expect(page.getByText('Everyday added.')).toBeVisible();
    await waitForRouter(page);
    await page.getByRole('link', { name: 'Everyday', exact: true }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/u);
    await page.getByTestId('confirm-statement-2026-08').click();
    await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);

    // A coin collection, counted in net worth, that nobody has valued.
    await gotoAfterRefresh(page, '/accounts?tab=other');
    await expect(page.getByTestId('asset-submit')).toBeEnabled();
    await fillTestId(page, 'asset-name', 'Coin collection');
    await page.getByTestId('asset-include').check();
    await page.getByTestId('asset-submit').click();
    await expect(page.getByText('Coin collection added.')).toBeVisible();

    // --- each page that shows one --------------------------------------------
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');
    await expect(page.getByTestId('bucket-EUR')).toContainText('Unavailable');
    await readsAndFits(page, 'Monthly');

    await page.goto('/dashboard');
    await expect(page.getByTestId('financial-net-worth')).toBeVisible();
    await readsAndFits(page, 'the dashboard');

    await page.goto('/accounts?tab=other');
    await expect(page.getByTestId('other-assets-table')).toContainText('No value recorded');
    await readsAndFits(page, 'Accounts');

    await page.getByRole('link', { name: 'Coin collection', exact: true }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/u);
    await expect(page.getByTestId('position-native')).toBeVisible();
    await readsAndFits(page, 'the coin collection’s page');
  });
});
