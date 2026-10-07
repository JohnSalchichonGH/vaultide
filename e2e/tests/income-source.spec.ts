import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoAfterRefresh } from '../support/navigation';

/**
 * One income source's page (blueprint 15.1 `/income/sources/[id]`, 15.2
 * "Income source", 16.5, 17.2; v2.1.20 30.23; ADR 0012 D2, D4, D9).
 *
 * Every record is written through the product's own pages, on 6 October 2026
 * with the test clock:
 *
 *  - a visitor who is not signed in is sent to sign-in with the source's whole
 *    address, year included, kept as the way back;
 *  - a salary recorded in Monthly is reached from the Income year view by its
 *    name. Its page shows its details, its amount history and the year's
 *    payments; the amount changes from a later payment on, and the payment
 *    already recorded keeps its amount; an end date the history forbids is
 *    refused as the server words it, and an allowed one is confirmed; archived,
 *    the year view's missing line leads back to the page, and the page
 *    unarchives it; a payer saved from a second tab meets the first tab's
 *    draft as a conflict, and Reload shows it — all without widening a phone
 *    screen;
 *  - an amount saved from a second tab meets the first tab's open "Change the
 *    amount from…" form as a conflict, even after a refresh has brought the
 *    newer amount to the page under it: the form claims the amount it opened
 *    with, so nothing is written over the other tab's, and Reload shows it.
 *
 * Every navigation after a save goes through `gotoAfterRefresh`, so it never
 * races the save's own refresh.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_6 = '2026-10-06T10:00:00Z';
const SOURCE_PAGE = /\/income\/sources\/([0-9a-f-]{36})$/u;

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
  await page.getByLabel('Your name').fill('Income source');
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

/** A euro account with a balance at the end of August, so September's salary has somewhere to land. */
async function account(page: Page, name: string): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('checking');
  await fillTestId(page, 'account-balance', '1000.00');
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
}

/** Nothing on the page reaches past the viewport's right edge (16.5). */
async function fitsItsViewport(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

const occurrence = (page: Page, date: string) =>
  page.locator(`[data-testid="source-occurrence"][data-occurrence-date="${date}"]`);

test.describe('an income source’s page', () => {
  test('a visitor who is not signed in goes to sign-in and keeps the way back, year included', async ({ page }) => {
    // The (app) layout refuses too, but only the proxy remembers where the
    // visitor was going.
    const id = '6f9c1a52-8d3e-4b7a-9c21-5e0d4a7b3c18';
    for (const destination of [`/income/sources/${id}`, `/income/sources/${id}?year=2025`]) {
      await page.goto(destination);
      const landed = new URL(page.url());
      expect(landed.pathname).toBe('/sign-in');
      expect(landed.searchParams.get('next')).toBe(destination);
    }
  });

  test('from the year view to a salary’s page: its amount, end date and archive', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-income-source'));
    await account(page, 'BBVA');

    // --- a salary in Monthly, with September's payment recorded --------------
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('source-add-toggle').click();
    await page.getByTestId('add-income-source').scrollIntoViewIfNeeded();
    await fillTestId(page, 'source-name', 'Salary');
    await page.getByTestId('source-kind').selectOption('employment');
    await fillTestId(page, 'source-day', '25');
    await fillTestId(page, 'source-start-date', '2026-07-01');
    await fillTestId(page, 'source-amount', '2000.00');
    await fillTestId(page, 'source-gross', '2800.00');
    await page.getByTestId('source-account').selectOption({ label: 'BBVA' });
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Salary added.');
    await page.getByTestId('occurrence-accept').click();
    await expect(page.getByTestId('occurrence-status')).toContainText('Recorded');

    // --- the year view, then the source's name -------------------------------
    await gotoAfterRefresh(page, '/income');
    await page.getByTestId('income-source').filter({ hasText: 'Salary' }).getByTestId('income-source-link').click();
    await expect(page).toHaveURL(SOURCE_PAGE);
    const [, id] = SOURCE_PAGE.exec(new URL(page.url()).pathname) ?? [];
    if (id === undefined) throw new Error('No source id in the address.');
    await expect(page.getByTestId('source-title')).toHaveText('Salary');

    // Details.
    await expect(page.getByTestId('source-detail-account')).toContainText('BBVA');
    await expect(page.getByTestId('source-detail-schedule')).toContainText('Every month, on day 25');
    await expect(page.getByTestId('source-detail-end')).toContainText('No end date');

    // Amount history: one amount, one payment.
    await expect(page.getByTestId('income-source-chart')).toBeVisible();
    await page.getByTestId('source-history-view-table').click();
    await expect(page.getByTestId('source-term')).toHaveCount(1);
    await expect(page.getByTestId('source-arrival')).toHaveCount(1);
    await expect(page.getByTestId('source-arrival')).toContainText('€2,000.00');

    // The year's payments: July and August missing, September received, the rest not yet due.
    await expect(page.getByTestId('source-occurrence')).toHaveCount(6);
    await expect(occurrence(page, '2026-07-25')).toHaveAttribute('data-state', 'missing');
    await expect(occurrence(page, '2026-08-25')).toHaveAttribute('data-state', 'missing');
    await expect(occurrence(page, '2026-09-25')).toHaveAttribute('data-state', 'received');
    await expect(occurrence(page, '2026-10-25')).toHaveAttribute('data-state', 'not_yet_due');
    await expect(occurrence(page, '2026-09-25').getByTestId('source-occurrence-link')).toHaveAttribute(
      'href',
      /^\/monthly\/2026-09#income-[0-9a-f-]{36}$/u,
    );
    await expect(page.getByTestId('source-missing')).toContainText('Salary: 2 payments missing in 2026 (July, August).');
    await expect(page.getByTestId('source-missing-link')).toHaveAttribute('href', '/monthly/2026-07/history');

    // Years outside the source's own, and an address that names nothing, are not pages.
    for (const address of [`/income/sources/${id}?year=2025`, `/income/sources/${id}?year=2027`, '/income/sources/not-a-source']) {
      const response = await gotoAfterRefresh(page, address);
      expect(response?.status()).toBe(404);
    }
    await gotoAfterRefresh(page, `/income/sources/${id}`);
    await page.getByTestId('source-history-view-table').click();

    // --- change the amount from November's payment on -------------------------
    await occurrence(page, '2026-11-25').getByTestId('source-change-amount').click();
    const panel = occurrence(page, '2026-11-25').getByTestId('term-panel');
    await expect(panel).toContainText('Amount from 25 Nov 2026 on');
    await fillTestId(page, 'term-net', '2100.00');
    await fillTestId(page, 'term-gross', '2950.00');
    await page.getByTestId('term-save').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('source-term')).toHaveCount(2);
    await expect(page.locator('[data-testid="source-term"][data-effective-from="2026-11-25"]')).toContainText('€2,100.00');
    // The payment already recorded keeps its amount, and so does the term it was set against.
    await expect(page.getByTestId('source-arrival')).toContainText('€2,000.00');
    await expect(occurrence(page, '2026-09-25')).toContainText('€2,000.00');
    await expect(occurrence(page, '2026-12-25')).toContainText('€2,100.00');

    // --- an end date: refused before a recorded payment, then confirmed -------
    // 31 August reaches September, which has finished, so the page's own
    // confirmation is not shown; the refusal answers before any review would.
    await fillTestId(page, 'source-end-date-input', '2026-08-31');
    await page.getByTestId('source-end-review').click();
    await expect(page.getByTestId('source-end-problem')).toContainText('which you have already recorded or skipped');

    await fillTestId(page, 'source-end-date-input', '2026-12-31');
    await page.getByTestId('source-end-review').click();
    await expect(page.getByTestId('source-end-confirmation')).toContainText('Salary will end on 31 Dec 2026.');
    await expect(page.getByTestId('source-end-confirmation')).toContainText('No completed month’s expected occurrences change.');
    await page.getByTestId('source-end-confirm').click();
    await expect(page.getByTestId('source-end-saved')).toContainText('End date saved.');
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Dec 2026');

    // --- archive, and the year view's missing line comes back here ------------
    await page.getByTestId('source-archive-start').click();
    await expect(page.getByTestId('source-archive-confirmation')).toContainText(
      'Past missing payments cannot be recorded or skipped until it is unarchived.',
    );
    await page.getByTestId('source-archive-confirm').click();
    await expect(page.getByTestId('source-archived')).toBeVisible();
    await expect(page.getByTestId('source-change-amount')).toHaveCount(0);
    await expect(page.getByTestId('source-missing-archived')).toBeVisible();
    await expect(page.getByTestId('source-missing-unarchive')).toHaveAttribute('href', '#archive');

    await gotoAfterRefresh(page, '/income');
    const line = page.getByTestId('income-missing-flag').filter({ hasText: 'Salary' });
    await expect(line.getByTestId('income-missing-archived')).toBeVisible();
    const back = line.getByTestId('income-missing-link');
    await expect(back).toHaveAttribute('data-kind', 'source');
    await expect(back).toHaveAttribute('href', `/income/sources/${id}?year=2026`);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/income/sources/${id}\\?year=2026$`, 'u'));

    // --- unarchive ------------------------------------------------------------
    await page.getByTestId('source-unarchive').click();
    await expect(page.getByTestId('source-archived')).toHaveCount(0);
    await expect(page.getByTestId('source-change-amount')).toHaveCount(6);
    await expect(page.getByTestId('source-missing-link')).toHaveAttribute('href', '/monthly/2026-07/history');

    // --- a second tab saves first: this tab's draft meets a conflict ---------
    await fillTestId(page, 'source-edit-payer', 'Acme');
    const other = await page.context().newPage();
    await other.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await other.goto(`/income/sources/${id}`);
    // Typed before React takes the form over, a value never reaches its state.
    await expect(other.getByTestId('source-archive-start')).toBeEnabled();
    await fillTestId(other, 'source-edit-payer', 'Acme Ltd');
    await other.getByTestId('source-details-save').click();
    await expect(other.getByTestId('source-details-saved')).toContainText('Saved.');
    await expect(other.getByTestId('source-detail-payer')).toContainText('Acme Ltd');
    await other.close();

    await page.getByTestId('source-details-save').click();
    await expect(page.getByTestId('source-details-problem')).toContainText('This source changed while you were editing it.');
    await expect(page.getByTestId('source-details-problem')).toHaveAttribute('data-kind', 'conflict');
    await page.getByTestId('source-details-problem-reload').click();
    await expect(page.getByTestId('source-edit-payer')).toHaveValue('Acme Ltd');
    await expect(page.getByTestId('source-detail-payer')).toContainText('Acme Ltd');

    // A phone's width, with the history's tables open.
    await page.getByTestId('source-history-view-table').click();
    await expect(page.getByTestId('source-terms')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 800 });
    await fitsItsViewport(page);
  });

  test('an amount saved from a second tab meets this tab’s open amount form as a conflict, and Reload shows it', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-income-term-conflict'));
    await account(page, 'BBVA');

    // --- a salary, created in Monthly ----------------------------------------
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('source-add-toggle').click();
    await page.getByTestId('add-income-source').scrollIntoViewIfNeeded();
    await fillTestId(page, 'source-name', 'Salary');
    await page.getByTestId('source-kind').selectOption('employment');
    await fillTestId(page, 'source-day', '25');
    await fillTestId(page, 'source-start-date', '2026-07-01');
    await fillTestId(page, 'source-amount', '2000.00');
    await page.getByTestId('source-account').selectOption({ label: 'BBVA' });
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Salary added.');

    await gotoAfterRefresh(page, '/income');
    await page.getByTestId('income-source').filter({ hasText: 'Salary' }).getByTestId('income-source-link').click();
    await expect(page).toHaveURL(SOURCE_PAGE);
    const [, id] = SOURCE_PAGE.exec(new URL(page.url()).pathname) ?? [];
    if (id === undefined) throw new Error('No source id in the address.');

    // --- this tab opens November's amount, where no amount starts yet --------
    await expect(page.getByTestId('source-archive-start')).toBeEnabled();
    await occurrence(page, '2026-11-25').getByTestId('source-change-amount').click();
    const panel = occurrence(page, '2026-11-25').getByTestId('term-panel');
    await expect(panel).toContainText('Amount from 25 Nov 2026 on');
    await fillTestId(page, 'term-net', '2200.00');

    // --- a second tab sets it first ------------------------------------------
    const other = await page.context().newPage();
    await other.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await other.goto(`/income/sources/${id}`);
    // Typed before React takes the form over, a value never reaches its state.
    await expect(other.getByTestId('source-archive-start')).toBeEnabled();
    await occurrence(other, '2026-11-25').getByTestId('source-change-amount').click();
    await fillTestId(other, 'term-net', '2100.00');
    await other.getByTestId('term-save').click();
    await expect(occurrence(other, '2026-11-25').getByTestId('term-panel')).toHaveCount(0);
    await expect(occurrence(other, '2026-12-25')).toContainText('€2,100.00');
    await other.close();

    // --- a refresh brings the other tab's amount under the open form ---------
    // Any save's response reads the page again: here the payer's. The form
    // keeps what was typed, and the page around it now holds the newer amount.
    await fillTestId(page, 'source-edit-payer', 'Acme');
    await page.getByTestId('source-details-save').click();
    await expect(page.getByTestId('source-details-saved')).toContainText('Saved.');
    await expect(page.getByTestId('source-detail-payer')).toContainText('Acme');
    await expect(occurrence(page, '2026-12-25')).toContainText('€2,100.00');
    await expect(page.getByTestId('term-net')).toHaveValue('2200.00');

    // --- this tab's save still claims the November it opened with ------------
    // Built from the page's term instead, it would claim the other tab's and
    // silently replace it.
    await page.getByTestId('term-save').click();
    const problem = panel.getByTestId('term-problem');
    await expect(problem).toHaveAttribute('data-kind', 'conflict');
    await expect(problem).toContainText('There is already an amount starting 2026-11-25. Reload to see it before changing it.');
    // Nothing was written over the other tab's amount, and this tab's draft is
    // still on screen beside the message.
    await expect(page.getByTestId('term-net')).toHaveValue('2200.00');
    await expect(page.getByTestId('term-save')).toBeDisabled();

    await problem.getByTestId('term-problem-reload').click();
    await expect(problem).toHaveCount(0);
    // The form opens again on the other tab's amount, as the term holds it.
    await expect(page.getByTestId('term-net')).toHaveValue('2100');
    await expect(occurrence(page, '2026-12-25')).toContainText('€2,100.00');

    // Saved again, it claims the amount it now shows, and lands.
    await fillTestId(page, 'term-net', '2200.00');
    await page.getByTestId('term-save').click();
    await expect(panel).toHaveCount(0);
    await expect(occurrence(page, '2026-12-25')).toContainText('€2,200.00');
  });
});
