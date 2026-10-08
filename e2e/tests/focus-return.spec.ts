import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { gotoAfterRefresh, waitForRouter } from '../support/navigation';

/**
 * Focus comes back when a dialog or a confirmation closes (blueprint 16.6:
 * "dialogs trap and restore focus").
 *
 * A keyboard or screen-reader user who leaves a dialog should be where they
 * were before it opened, not at the top of the page. Escape closes a modal
 * `<dialog>` natively and the browser gives focus back by itself; every other
 * way out — Back, Cancel, a confirmed review — closes it by taking it off the
 * page, which the browser does not treat as a close. Four journeys:
 *
 *  - **a completed month.** The issue dialog closed with Cancel, and Review
 *    changes opened from a record's date, left with Escape and with Back, and
 *    reopened from its own button and left with Back again;
 *  - **the current month.** The transfer dialog closed with Cancel and with
 *    Escape, and the in-place delete confirmation, which swaps the Delete
 *    button for Keep and Delete and back again;
 *  - **Bulk History.** Its review left with Back and with Escape, where the
 *    grid's own Review changes button gives way to the review's;
 *  - the review opened inside the issue dialog is in `corrective-actions.spec.ts`,
 *    beside the journey that opens it.
 *
 * Every dialog is opened from the keyboard, as the people this is for open
 * it: WebKit does not focus a button that is clicked, so a click would leave
 * nothing to come back to.
 *
 * Every record is written through the product's own pages. "Today" is
 * 6 October 2026.
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
  await page.getByLabel('Your name').fill('Focus');
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

/** A euro checking account with its balance at the end of August. */
async function addAccount(page: Page, name: string, august: string): Promise<void> {
  await gotoAfterRefresh(page, '/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('checking');
  await fillTestId(page, 'account-balance', august);
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
}

/** An account whose August balance is confirmed as the statement, left on its own page. */
async function accountWithAugustStatement(page: Page, name: string, august: string): Promise<void> {
  await addAccount(page, name, august);
  await waitForRouter(page);
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/u);
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
}

/** A September statement on the account page the browser is on. */
async function septemberStatement(page: Page, amount: string): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', '2026-09-30');
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-history')).toContainText('2026-09-30');
  await page.getByTestId('confirm-statement-2026-09').click();
  await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);
}

/** One income entry, through the Monthly form the browser has open. */
async function addIncome(page: Page, options: { on: string; net: string; account: string }): Promise<void> {
  await waitForRouter(page);
  await page.getByTestId('income-add-toggle').click();
  await page.getByTestId('income-kind').selectOption('other');
  await fillTestId(page, 'income-received-on', options.on);
  await fillTestId(page, 'income-net', options.net);
  await page.getByTestId('income-account').selectOption({ label: options.account });
  await page.getByTestId('income-submit').click();
  await expect(page.getByTestId('income-saved')).toContainText('Income added.');
}

/** A Monthly page once its accounts can be edited, so every control on it is wired. */
async function monthly(page: Page, month: string, kind: 'Completed month' | 'In progress'): Promise<void> {
  await gotoAfterRefresh(page, `/monthly/${month}`);
  await expect(page.getByTestId('monthly-kind')).toHaveText(kind);
  await expect(
    kind === 'Completed month'
      ? page.getByTestId('monthly-accounts').getByTestId('closing-amount').first()
      : page.locator('#accounts').getByTestId('quick-update-open'),
  ).toBeEnabled();
}

/** Open from the keyboard: focus the control, then press Enter on it. */
async function pressOpen(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
}

const review = (page: Page): Locator => page.getByTestId('correction-review');

/* -------------------------------------------------------------------------- */

test.describe('a completed month', () => {
  test('the issue dialog and Review changes give focus back to what opened them', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-focus-completed'));

    // September closed 500 higher than August with nothing recorded to explain
    // it, so the month raises an unexplained inflow.
    await accountWithAugustStatement(page, 'Everyday', '1000.00');
    await septemberStatement(page, '1500.00');
    await monthly(page, '2026-09', 'Completed month');

    // --- the issue dialog, closed with Cancel --------------------------------
    const adjustment = page
      .getByTestId('issue-group-unexplained_inflow')
      .locator('[data-action-id="unexplained_inflow:EUR::adjustment"]');
    await pressOpen(adjustment);
    const issue = page.getByTestId('issue-dialog');
    await expect(issue).toBeVisible();
    await issue.getByTestId('adjustment-cancel').click();
    await expect(issue).toHaveCount(0);
    await expect(adjustment).toBeFocused();

    // --- Review changes, opened by moving a record out of the closed month ---
    await addIncome(page, { on: '2026-09-20', net: '200.00', account: 'Everyday' });
    const date = page.getByTestId('income-direct').getByTestId('entry-received-on');
    await date.fill('2026-10-03');
    await expect(review(page)).toBeVisible();

    // Escape: the browser closes the dialog, and gives focus back itself.
    await page.keyboard.press('Escape');
    await expect(review(page)).toHaveCount(0);
    await expect(date).toBeFocused();

    // Back: the dialog leaves the page, and focus comes back all the same.
    await date.fill('2026-10-04');
    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(date).toBeFocused();
    await expect(date).toHaveValue('2026-10-04');

    // Reopened from its own button, which gives way to the dialog while it is
    // open: Back lands on the button that takes its place.
    await pressOpen(page.getByTestId('correction-reopen'));
    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('correction-reopen')).toBeFocused();
  });
});

test.describe('the current month', () => {
  test('the transfer dialog and the delete confirmation give focus back', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-focus-current'));
    await addAccount(page, 'Everyday', '2000.00');
    await addAccount(page, 'Savings', '500.00');
    await monthly(page, '2026-10', 'In progress');

    // --- the transfer dialog, closed with Cancel and with Escape -------------
    const add = page.getByTestId('transfer-add');
    const transfer = page.getByTestId('transfer-dialog');
    await pressOpen(add);
    await expect(transfer).toBeVisible();
    await transfer.getByTestId('transfer-cancel').click();
    await expect(transfer).toHaveCount(0);
    await expect(add).toBeFocused();

    await pressOpen(add);
    await expect(transfer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(transfer).toHaveCount(0);
    await expect(add).toBeFocused();

    // --- the delete confirmation, which is not a dialog ----------------------
    // Delete gives way to Keep and Delete; the safe choice takes focus, and
    // Keep gives it back to the Delete it replaced.
    await addIncome(page, { on: '2026-10-02', net: '40.00', account: 'Everyday' });
    const entry = page.getByTestId('income-direct');
    const remove = entry.getByTestId('entry-delete');
    await pressOpen(remove);
    await expect(entry.getByTestId('entry-delete-confirm-panel')).toBeVisible();
    await expect(entry.getByTestId('entry-delete-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(entry.getByTestId('entry-delete-confirm-panel')).toHaveCount(0);
    await expect(remove).toBeFocused();
    await expect(entry.getByTestId('income-entry')).toHaveCount(1);
  });
});

test.describe('Bulk History', () => {
  test('its review gives focus to the way back into it, which takes the opener’s place', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-focus-bulk'));
    await accountWithAugustStatement(page, 'Everyday', '2000.00');

    // From Monthly by its link, as a person arrives: the grid's inputs are not
    // hydration-gated, so a value typed straight after a full load can be lost.
    await monthly(page, '2026-09', 'Completed month');
    await page.getByTestId('monthly-bulk-history').click();
    await expect(page).toHaveURL(/\/monthly\/2026-09\/history$/u);
    await page.locator('tr[data-month="2026-09"]').getByTestId('bulk-input').first().fill('2050.00');
    await expect(page.getByTestId('bulk-status')).toContainText('1 changed cell');

    // Back: the grid's Review changes button is replaced by the review's own
    // while a review stands, so that is where focus comes back to.
    await pressOpen(page.getByTestId('bulk-review'));
    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    const reopen = page.getByTestId('correction-reopen');
    await expect(reopen).toBeFocused();

    // Escape, from the reopened review, lands there too.
    await pressOpen(reopen);
    await expect(review(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(review(page)).toHaveCount(0);
    await expect(reopen).toBeFocused();
  });
});
