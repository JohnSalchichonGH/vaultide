import { expect, test, type APIRequestContext, type Dialog, type Locator, type Page } from '@playwright/test';

/**
 * Bulk History, end to end (blueprint 15.3 "Bulk history"; ADR 0011).
 *
 * Two journeys, each a promise the product makes rather than a rendering check:
 *
 *  - **history is reconstructed from a spreadsheet.** From a completed month
 *    a person opens the grid, sees which balances are stored, carried and
 *    missing, pastes a block of balances and income, is asked before a link
 *    would take the unsaved block away, reviews it — the review opens even
 *    though every cell is new — steps back, reopens, confirms, and the months
 *    it filled reconcile in Monthly;
 *  - **a cell changed in another tab is never saved over.** Two tabs edit the
 *    same grid. The second saves first; the first one's confirm is refused,
 *    keeps its other edit, lists the cell it lost with what is there now, and
 *    then saves what is left.
 *
 * Every record is written through the product's own pages: there is no seeding
 * endpoint. "Today" is 6 October 2026.
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
  await page.getByLabel('Your name').fill('Bulk history');
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

/** An account whose August statement is entered and confirmed. */
async function accountWithAugustStatement(page: Page, name: string, august: string): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption('checking');
  await fillTestId(page, 'account-balance', august);
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();

  await page.getByRole('link', { name, exact: true }).click();
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
}

/** A monthly salary into the account, from June, created from the month itself. */
async function salarySource(page: Page, account: string): Promise<void> {
  await page.goto('/monthly/2026-09');
  await page.getByTestId('source-add-toggle').click();
  await fillTestId(page, 'source-name', 'Salary');
  await page.getByTestId('source-kind').selectOption('employment');
  await page.getByTestId('source-frequency').selectOption('monthly');
  await fillTestId(page, 'source-day', '25');
  await fillTestId(page, 'source-start-date', '2026-06-01');
  await fillTestId(page, 'source-amount', '2000.00');
  await page.getByTestId('source-account').selectOption({ label: account });
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-saved')).toContainText('Salary added.');
}

/** The grid cell of one column and month. */
function gridCell(page: Page, month: string, column: number): Locator {
  return page.locator(`tr[data-month="${month}"]`).getByTestId('bulk-cell').nth(column);
}

/**
 * Paste as the browser does when a spreadsheet block is on the clipboard: a
 * `paste` event carrying the text, at the focused cell.
 */
async function pasteInto(page: Page, cell: Locator, text: string): Promise<void> {
  await cell.getByTestId('bulk-input').focus();
  await page.evaluate((clipboard) => {
    const data = new DataTransfer();
    data.setData('text/plain', clipboard);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

const review = (page: Page) => page.getByTestId('correction-review');

/* -------------------------------------------------------------------------- */

test.describe('reconstructing history in bulk', () => {
  test('a person pastes balances and income for months that are closed, reviews them, and confirms', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-bulk'));
    await accountWithAugustStatement(page, 'Everyday', '2000.00');
    await salarySource(page, 'Everyday');

    // --- From a completed month, into the grid that starts there ------------
    await page.goto('/monthly/2026-06');
    await page.getByTestId('monthly-bulk-history').click();
    await expect(page).toHaveURL(/\/monthly\/2026-06\/history$/u);
    await expect(page.getByTestId('bulk-title')).toHaveText('Bulk history');
    await expect(page.getByTestId('bulk-column')).toHaveCount(2);

    // What the grid states: missing in June and July, August's statement,
    // September carrying it, and October in progress.
    await expect(gridCell(page, '2026-06', 0)).toHaveAttribute('data-state', 'empty');
    await expect(gridCell(page, '2026-07', 0)).toHaveAttribute('data-state', 'empty');
    await expect(gridCell(page, '2026-08', 0)).toHaveAttribute('data-state', 'stored');
    await expect(gridCell(page, '2026-08', 0).getByTestId('bulk-input')).toHaveValue('2000.00');
    await expect(gridCell(page, '2026-09', 0)).toHaveAttribute('data-state', 'carried');
    await expect(gridCell(page, '2026-09', 0).getByTestId('bulk-input')).toHaveAttribute('placeholder', '2000.00');
    await expect(gridCell(page, '2026-06', 1)).toHaveAttribute('data-state', 'open');
    await expect(page.locator('tr[data-month="2026-10"]').getByTestId('bulk-input')).toHaveCount(0);

    // --- An edit undone leaves nothing unsaved --------------------------------
    const august = gridCell(page, '2026-08', 0).getByTestId('bulk-input');
    await august.fill('2100.00');
    await expect(page.getByTestId('bulk-status')).toContainText('1 changed cell');
    await expect(page.getByTestId('bulk-start')).toBeDisabled();
    await august.fill('2000.00');
    await expect(page.getByTestId('bulk-status')).toContainText('No unsaved changes');
    await expect(page.getByTestId('bulk-start')).toBeEnabled();
    await gridCell(page, '2026-07', 0).getByTestId('bulk-input').fill('5');
    await gridCell(page, '2026-07', 0).getByTestId('bulk-input').press('Escape');
    await expect(page.getByTestId('bulk-status')).toContainText('No unsaved changes');
    await expect(page.getByTestId('bulk-start')).toBeEnabled();

    // --- A block from a spreadsheet: June and July, balance and salary -------
    await pasteInto(page, gridCell(page, '2026-06', 0), '1,500.00\t2,000.00\r\n1,800.00\t2,000.00\r\n');
    await expect(page.getByTestId('bulk-notice')).toContainText('Pasted 4 cells');
    await expect(gridCell(page, '2026-06', 0).getByTestId('bulk-input')).toHaveValue('1500.00');
    await expect(gridCell(page, '2026-07', 1).getByTestId('bulk-input')).toHaveValue('2000.00');
    await expect(page.getByTestId('bulk-status')).toContainText('4 changed cells');

    // --- Unsaved edits are not lost by following a link in the app ---------
    const asked: string[] = [];
    const stay = (dialog: Dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    };
    page.on('dialog', stay);
    await page.getByTestId('bulk-back').click();
    await expect.poll(() => asked.length).toBe(1);
    await page.locator('tr[data-month="2026-07"] th a').click();
    await expect.poll(() => asked.length).toBe(2);
    page.off('dialog', stay);
    expect(asked[0]).toContain('not saved');
    await expect(page).toHaveURL(/\/monthly\/2026-06\/history$/u);
    await expect(page.getByTestId('bulk-status')).toContainText('4 changed cells');

    // --- Every cell is new, and the save is still reviewed -------------------
    await page.getByTestId('bulk-review').click();
    await expect(review(page)).toBeVisible();
    await expect(page.getByTestId('bulk-review-headline')).toContainText('Balances: 2 added');
    await expect(page.getByTestId('bulk-review-headline')).toContainText('Income: 2 added');

    // Back keeps every edit; the review can be reopened as it was.
    await page.getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(gridCell(page, '2026-07', 0).getByTestId('bulk-input')).toHaveValue('1800.00');
    await page.getByTestId('correction-reopen').click();
    await expect(review(page)).toBeVisible();

    await page.getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    // --- The grid reloads with what was recorded ------------------------------
    await expect(page.getByTestId('bulk-status')).toContainText('No unsaved changes');
    await expect(gridCell(page, '2026-06', 0)).toHaveAttribute('data-state', 'stored');
    await expect(gridCell(page, '2026-07', 0).getByTestId('bulk-input')).toHaveValue('1800.00');
    await expect(gridCell(page, '2026-07', 1)).toHaveAttribute('data-state', 'materialized');

    // --- Nothing unsaved now, so the way back is not questioned --------------
    page.on('dialog', stay);
    await page.getByTestId('bulk-back').click();
    await expect(page).toHaveURL(/\/monthly\/2026-06$/u);
    page.off('dialog', stay);
    expect(asked).toHaveLength(2);

    // --- And Monthly reads them: July reconciles from June to July ------------
    await page.goto('/monthly/2026-07');
    await expect(page.locator('#accounts').getByTestId('closing-amount')).toHaveValue('1800.00');
    const bucket = page.getByTestId('bucket-EUR');
    await expect(bucket.getByTestId('identity-I')).toContainText('€2,000.00');
    await expect(bucket.getByTestId('identity-delta')).toContainText('€300.00');
    await expect(bucket.getByTestId('identity-tracked')).toContainText('€1,700.00');
    await expect(page.getByTestId('income-occurrence').first().getByTestId('occurrence-status')).toHaveText(
      'Recorded',
    );
  });
});

test.describe('two tabs on one grid', () => {
  test('a cell saved in another tab is lost from this one, said so, and the rest is kept', async ({
    page,
    request,
    context,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-bulk-tabs'));
    await accountWithAugustStatement(page, 'Everyday', '2000.00');

    const other = await context.newPage();
    await other.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });

    for (const tab of [page, other]) {
      await tab.goto('/monthly/2026-07/history');
      await expect(gridCell(tab, '2026-08', 0).getByTestId('bulk-input')).toHaveValue('2000.00');
    }

    // Tab A changes August's statement and fills September, and opens the review.
    await gridCell(page, '2026-08', 0).getByTestId('bulk-input').fill('2100.00');
    await gridCell(page, '2026-09', 0).getByTestId('bulk-input').fill('2050.00');
    await page.getByTestId('bulk-review').click();
    await expect(review(page)).toBeVisible();

    // Meanwhile tab B corrects August to something else, and saves first.
    await gridCell(other, '2026-08', 0).getByTestId('bulk-input').fill('2200.00');
    await other.getByTestId('bulk-review').click();
    await expect(review(other)).toBeVisible();
    await other.getByTestId('correction-confirm').click();
    await expect(review(other)).toHaveCount(0);
    await expect(other.getByTestId('bulk-status')).toContainText('No unsaved changes');

    // Tab A's confirm is refused: nothing it saw is the truth any more.
    await page.getByTestId('correction-confirm').click();
    await expect(page.getByTestId('correction-error')).toContainText('changed after you opened the grid');
    await page.getByTestId('correction-back').click();

    // The lost cell is listed with what it holds now; the other edit is kept.
    await expect(page.getByTestId('bulk-dropped')).toContainText('1 cell changed elsewhere and was not kept');
    await expect(page.getByTestId('bulk-dropped-item')).toContainText('you typed “2100.00”');
    await expect(page.getByTestId('bulk-dropped-item')).toContainText('2200.00 EUR');
    await expect(gridCell(page, '2026-08', 0).getByTestId('bulk-input')).toHaveValue('2200.00');
    await expect(gridCell(page, '2026-09', 0).getByTestId('bulk-input')).toHaveValue('2050.00');
    await expect(page.getByTestId('correction-reopen')).toHaveCount(0);

    // What is left saves.
    await page.getByTestId('bulk-review').click();
    await expect(page.getByTestId('bulk-review-headline')).toContainText('Balances: 1 added');
    await page.getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(gridCell(page, '2026-09', 0)).toHaveAttribute('data-state', 'stored');
    await expect(gridCell(page, '2026-08', 0).getByTestId('bulk-input')).toHaveValue('2200.00');
  });
});
