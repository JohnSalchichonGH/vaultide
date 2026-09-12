import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The first Monthly journey (blueprint 15.2 "Monthly", 15.3, 21.5).
 *
 * On 1 October, with the test clock: a person with two euro accounts — an
 * everyday account that spent 100 and a savings account that grew by 10 nobody
 * recorded — opens this month from the dashboard, finds it in progress with no
 * common balance date and no completeness, steps back to September, reads its
 * overview and reconciliation, hides the interest advisory and brings it back,
 * marks the month reviewed and finds it still reviewed after a reload, and
 * moves between months with the links, the month control and the `[` / `]`
 * keys — never into a month that has not begun.
 *
 * Every record is written through the product's own pages; there is no seeding
 * endpoint. The savings account's small unexplained growth is what raises the
 * advisory, exactly as it would for anybody.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_1 = '2026-10-01T10:00:00Z';

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
  await page.getByLabel('Your name').fill('Monthly');
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
 * An existing account with statement balances at the end of August and of
 * September, both entered as last-day snapshots and confirmed as statements —
 * the ordinary way a month is closed (8.1, 15.3).
 */
async function accountWithStatements(
  page: Page,
  options: { name: string; type: 'checking' | 'savings'; august: string; september: string },
): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption(options.type);
  await fillTestId(page, 'account-balance', options.august);
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();

  await page.getByRole('link', { name: options.name, exact: true }).click();
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);

  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', options.september);
  await fillTestId(page, 'valuation-date', '2026-09-30');
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-saved')).toBeVisible();
  await page.getByTestId('confirm-statement-2026-09').click();
  await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);
}

/**
 * An existing account whose August statement was entered as a last-day snapshot
 * and confirmed, leaving the browser on the account's page.
 */
async function accountWithAugustStatement(
  page: Page,
  options: { name: string; type: 'checking' | 'savings' | 'cash'; august: string },
): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await expect(page.getByTestId('account-submit')).toBeEnabled();
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption('EUR');
  await page.getByTestId('account-type').selectOption(options.type);
  await fillTestId(page, 'account-balance', options.august);
  await fillTestId(page, 'account-balance-date', '2026-08-31');
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();

  await page.getByRole('link', { name: options.name, exact: true }).click();
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
}

/** An ordinary snapshot on the account page the browser is on. */
async function recordSnapshot(page: Page, amount: string, on: string): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', on);
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-history')).toContainText(on);
}

test.describe('the monthly page', () => {
  test('a person opens this month, reviews last month, and hides and restores an advisory', async ({
    page,
    request,
  }, testInfo) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    const email = uniqueEmail('e2e-monthly');
    await onboard(page, request, email);

    await accountWithStatements(page, { name: 'Everyday', type: 'checking', august: '2000.00', september: '1900.00' });
    await accountWithStatements(page, { name: 'Savings', type: 'savings', august: '10000.00', september: '10010.00' });

    // --- this month, from the dashboard ------------------------------------
    await page.goto('/dashboard');
    if (!testInfo.project.name.startsWith('mobile')) {
      // The sidebar's Monthly entry opens the current month, from the server's today.
      await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Monthly' })).toHaveAttribute(
        'href',
        '/monthly/2026-10',
      );
    }
    await page.getByTestId('open-current-month').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    await expect(page.getByTestId('monthly-title')).toHaveText('October 2026');
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');

    // Nobody has updated both accounts on one October day: no month-to-date
    // figure at all, not a zero, and the reason in the product's own words.
    await expect(page.getByTestId('mtd-no-common-date')).toContainText(
      'Update all cash accounts to the same date to calculate month-to-date spending.',
    );
    await expect(page.getByTestId('mtd-no-identity')).toBeVisible();
    await expect(page.getByTestId('figure-trackedTotalSpending')).toHaveCount(0);
    // The current month has no completeness and cannot be marked reviewed.
    await expect(page.getByTestId('completeness')).toHaveCount(0);
    await expect(page.getByTestId('mark-reviewed')).toHaveCount(0);
    // …and nothing leads into November.
    await expect(page.getByTestId('month-next')).toHaveCount(0);

    // --- September ----------------------------------------------------------
    await page.getByTestId('month-previous').click();
    await expect(page).toHaveURL(/\/monthly\/2026-09$/u);
    await expect(page.getByTestId('monthly-title')).toHaveText('September 2026');
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');

    // Overview: 90 spent, reconciled, every requirement met.
    await expect(page.getByTestId('reconciliation-status')).toContainText('Reliable');
    await expect(page.getByTestId('figure-trackedTotalSpending')).toContainText('90.00');
    await expect(page.getByTestId('figure-trackedTotalSpending')).toHaveAttribute('data-availability', 'available');
    await expect(page.getByTestId('completeness-state')).toHaveText('Sufficient');
    await expect(page.getByTestId('completeness-count')).toContainText('2 of 2 requirements met');

    // Reconciliation: the identity in the bucket's own currency.
    const bucket = page.getByTestId('bucket-EUR');
    await expect(bucket.getByTestId('identity-delta')).toContainText('90.00');
    await expect(bucket.getByTestId('identity-tracked')).toContainText('€90.00');
    await expect(bucket.getByTestId('identity-unclassified')).toContainText('€90.00');

    // --- hide the advisory, and bring it back -------------------------------
    const advisory = page.getByTestId('issue-group-possible_missing_interest');
    await expect(advisory).toContainText('Possible unrecorded interest');
    await expect(advisory).toContainText('Savings');
    await expect(page.getByTestId('dismiss-possible_missing_interest')).toBeEnabled();
    await page.getByTestId('dismiss-possible_missing_interest').click();

    await expect(page.getByTestId('issue-group-possible_missing_interest')).toHaveCount(0);
    await expect(page.getByTestId('no-issues')).toBeVisible();
    const hidden = page.getByTestId('dismissed-advisories');
    await expect(hidden).toContainText('Hidden advisories (1)');

    // Hidden is persisted, and it hid nothing but the advisory: the figures
    // and the reconciliation are what they were.
    await page.reload();
    await expect(page.getByTestId('issue-group-possible_missing_interest')).toHaveCount(0);
    await expect(page.getByTestId('figure-trackedTotalSpending')).toContainText('90.00');
    await expect(page.getByTestId('reconciliation-status')).toContainText('Reliable');

    await page.getByTestId('dismissed-advisories').locator('summary').click();
    await expect(page.getByTestId('restore-possible_missing_interest')).toBeEnabled();
    await page.getByTestId('restore-possible_missing_interest').click();
    await expect(page.getByTestId('issue-group-possible_missing_interest')).toBeVisible();
    await expect(page.getByTestId('dismissed-advisories')).toHaveCount(0);

    // --- mark September reviewed -------------------------------------------
    await expect(page.getByTestId('mark-reviewed')).toBeEnabled();
    await page.getByTestId('mark-reviewed').click();
    await expect(page.getByTestId('reviewed-at')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('reviewed-at')).toBeVisible();
    await expect(page.getByTestId('mark-reviewed')).toHaveCount(0);
    // Reviewing it changed nothing it reports.
    await expect(page.getByTestId('completeness-state')).toHaveText('Sufficient');
    await expect(page.getByTestId('figure-trackedTotalSpending')).toContainText('90.00');

    // --- moving between months ---------------------------------------------
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);

    // `[` steps back a month; `]` forward, but never past the current month.
    await expect(page.getByTestId('month-go')).toBeEnabled();
    // Nothing editable has focus: the keys are the page's.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('[');
    await expect(page).toHaveURL(/\/monthly\/2026-09$/u);
    await expect(page.getByTestId('month-go')).toBeEnabled();
    await page.keyboard.press(']');
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    await expect(page.getByTestId('month-go')).toBeEnabled();
    await page.keyboard.press(']');
    await expect(page.getByTestId('monthly-title')).toHaveText('October 2026');
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);

    // A key typed into a field belongs to the field, not to month navigation.
    await page.getByTestId('month-picker').focus();
    await page.keyboard.press('[');
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);

    // The month control goes back in time, and refuses to go forward.
    await page.getByTestId('month-picker').fill('2026-12');
    await page.getByTestId('month-go').click();
    await expect(page.getByTestId('month-picker-error')).toContainText('up to 2026-10');
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    await page.getByTestId('month-picker').fill('2026-08');
    await page.getByTestId('month-go').click();
    await expect(page).toHaveURL(/\/monthly\/2026-08$/u);
    await expect(page.getByTestId('monthly-title')).toHaveText('August 2026');

    // A month that has not begun is not a page.
    const future = await page.goto('/monthly/2026-11');
    expect(future?.status()).toBe(404);
  });

  /**
   * Keeping cash evidence up to date from Monthly (15.3 section 4), on 6
   * October: September is closed account by account — a statement typed in, a
   * last-day snapshot confirmed, the untouched account confirmed unchanged — and
   * its reconciliation follows; then October's accounts, which never share a
   * balance date, are all updated today and month to date reaches today.
   */
  test('a person closes last month’s accounts and brings this month’s up to date', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-06T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-monthly-accounts'));

    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });
    await recordSnapshot(page, '1950.00', '2026-09-20');
    await recordSnapshot(page, '1880.00', '2026-10-03');
    await accountWithAugustStatement(page, { name: 'Savings', type: 'savings', august: '10000.00' });
    await recordSnapshot(page, '10010.00', '2026-09-30');
    await recordSnapshot(page, '10010.00', '2026-10-04');
    await accountWithAugustStatement(page, { name: 'Cash box', type: 'cash', august: '50.00' });

    // --- September: nothing is closed yet --------------------------------------
    await page.goto('/monthly/2026-09');
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');
    const accounts = page.getByTestId('monthly-accounts');
    const row = (name: string) => accounts.locator('tbody tr', { hasText: name });

    // Everyday has only an ordinary snapshot inside September: a hint, not a statement.
    await expect(row('Everyday').getByTestId('account-status')).toHaveText(/Needs statement balance/u);
    await expect(row('Everyday').getByTestId('closing-hint')).toHaveText(/Last snapshot €1,950\.00 on 20 Sept? 2026/u);
    await expect(row('Everyday').getByTestId('closing-amount')).toHaveValue('');
    // Savings has a snapshot on the last day, which is not a statement until confirmed.
    await expect(row('Savings').getByTestId('closing-hint')).toContainText('not yet a statement balance');
    await expect(row('Cash box').getByTestId('confirm-unchanged')).toBeVisible();
    await expect(page.getByTestId('bucket-EUR')).toContainText('Unavailable');

    // Enter moves down, and leaving the field saves Everyday's statement.
    await row('Everyday').getByTestId('closing-amount').fill('1900.00');
    await row('Everyday').getByTestId('closing-amount').press('Enter');
    await expect(row('Everyday').getByTestId('account-status')).toHaveText(/Complete/u);
    await expect(row('Everyday').getByTestId('save-status')).toHaveText('Saved.');
    await expect(row('Everyday').getByTestId('closing-amount')).toHaveValue('1900.00');
    await expect(row('Everyday').getByTestId('account-closing')).toContainText('Statement balance');

    // The last-day snapshot becomes Savings' statement, amount untouched.
    await row('Savings').getByTestId('confirm-statement').click();
    await expect(row('Savings').getByTestId('account-status')).toHaveText(/Complete/u);
    await expect(row('Savings').getByTestId('closing-amount')).toHaveValue('10010.00');

    // Only the account nobody touched is confirmed unchanged, at August's statement.
    await expect(page.getByTestId('confirm-all-unchanged-panel')).toContainText(
      'for the 1 account you have not edited here: Cash box.',
    );
    await page.getByTestId('confirm-all-unchanged').click();
    await expect(row('Cash box').getByTestId('account-status')).toHaveText(/Complete/u);
    await expect(row('Cash box').getByTestId('account-closing')).toContainText('Confirmed unchanged');
    await expect(row('Cash box').getByTestId('closing-amount')).toHaveValue('50.00');

    // The server's reconciliation replaced the page: September now reconciles.
    const bucket = page.getByTestId('bucket-EUR');
    await expect(bucket).toContainText('Reliable');
    await expect(bucket.getByTestId('identity-delta')).toContainText('90.00');
    await expect(bucket.getByTestId('identity-tracked')).toContainText('€90.00');
    await expect(page.getByTestId('reconciliation-status')).toContainText('Reliable');
    await page.reload();
    await expect(page.getByTestId('bucket-EUR')).toContainText('Reliable');

    // --- October: in progress, and never a month-end control ------------------
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');
    // Everyday was last updated on the 3rd and Savings on the 4th: no shared date.
    await expect(page.getByTestId('mtd-no-common-date')).toBeVisible();
    await expect(row('Everyday').getByTestId('account-opening')).toContainText('€1,900.00');
    await expect(row('Everyday').getByTestId('account-latest')).toHaveText(/€1,880\.00\s*Snapshot, 3 Oct 2026/u);
    await expect(row('Cash box').getByTestId('account-latest')).toHaveText(/€50\.00\s*Statement balance, 30 Sept? 2026/u);
    await expect(page.getByTestId('accounts-current-note')).toContainText('can be closed from 1 Nov 2026');
    for (const control of ['closing-amount', 'confirm-statement', 'confirm-unchanged', 'confirm-all-unchanged']) {
      await expect(page.getByTestId(control)).toHaveCount(0);
    }

    // The section never widens the page: a narrow screen scrolls the table
    // inside its own container, and the page itself not at all (16.5).
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // Update all today: every account gets an exact balance dated today.
    await expect(page.getByTestId('quick-update-open')).toHaveText('Update all today');
    await page.getByTestId('quick-update-open').click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByLabel(/^Everyday/u).fill('1870.00');
    await dialog.getByLabel(/^Savings/u).fill('10010.00');
    await dialog.getByLabel(/^Cash box/u).fill('50.00');
    await page.getByTestId('quick-update-save').click();
    await expect(page.getByTestId('quick-update-saved')).toContainText('Saved 3 balances dated 2026-10-06');

    // Month to date now runs through today, over the balances just entered.
    await expect(page.getByTestId('mtd-as-of')).toContainText('6 Oct 2026');
    await expect(page.getByTestId('figure-trackedTotalSpending')).toContainText('30.00');
    for (const name of ['Everyday', 'Savings', 'Cash box']) {
      await expect(row(name).getByTestId('account-latest')).toContainText('Snapshot, today');
    }

    // One account corrected from its own row: today's row is updated, not duplicated.
    await expect(row('Everyday').getByTestId('today-amount')).toHaveValue('1870.00');
    await row('Everyday').getByTestId('today-amount').fill('1860.00');
    await row('Everyday').getByTestId('today-amount').press('Tab');
    await expect(row('Everyday').getByTestId('save-status')).toHaveText('Saved.');
    await expect(row('Everyday').getByTestId('account-latest')).toContainText('€1,860.00');
    await expect(page.getByTestId('mtd-as-of')).toContainText('6 Oct 2026');
    await expect(page.getByTestId('figure-trackedTotalSpending')).toContainText('40.00');
  });
});

/**
 * The Monthly Income journey (blueprint 15.3 section 2, 21.5).
 *
 * On 6 October, with the test clock: a person with one euro account adds a
 * recurring salary from the Monthly page itself, records September's occurrence,
 * watches the reconciliation change to the server's own answer, records the next
 * occurrence early as received today, and adds a one-off payment by hand.
 *
 * Every record is written through the product's own pages — there is no seeding
 * endpoint — which is only possible because Monthly can create an income source.
 * The cross-month identity of an early receipt is pinned by the application
 * integration tests, where both months can be read at once without moving the
 * clock mid-journey.
 */
test.describe('the monthly income editor', () => {
  test('a person adds a salary source, records it, takes the next one early, and adds a one-off', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-06T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-monthly-income'));

    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '1000.00' });
    await recordSnapshot(page, '3000.00', '2026-09-30');
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    // --- A recurring source, created from the month itself ---------------------
    await page.goto('/monthly/2026-09');
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');
    await expect(page.getByTestId('income-occurrences-empty')).toBeVisible();

    await page.getByTestId('source-add-toggle').click();
    await fillTestId(page, 'source-name', 'Salary');
    await page.getByTestId('source-kind').selectOption('employment');
    await page.getByTestId('source-frequency').selectOption('monthly');
    await fillTestId(page, 'source-day', '25');
    await fillTestId(page, 'source-start-date', '2026-09-01');
    await fillTestId(page, 'source-amount', '2000.00');
    await fillTestId(page, 'source-gross', '2600.00');
    await page.getByTestId('source-account').selectOption({ label: 'Everyday' });

    // A start date in a finished month is allowed and says what it means (§30.10).
    await expect(page.getByTestId('source-historical-warning')).toContainText(
      'may become incomplete',
    );
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Salary added.');

    // --- September's occurrence, recorded ---------------------------------------
    const occurrence = page.getByTestId('income-occurrence').first();
    await expect(occurrence).toHaveAttribute('data-occurrence-date', '2026-09-25');
    await expect(occurrence.getByTestId('occurrence-status')).toHaveText('Not recorded');
    await expect(occurrence.getByTestId('occurrence-amount')).toContainText('€2,000.00');

    // The month expected a salary it has no record of, and says so.
    await expect(page.getByTestId('issue-group-suggested_income_missing')).toBeVisible();

    await occurrence.getByTestId('occurrence-accept').click();
    await expect(page.getByTestId('income-occurrence').first().getByTestId('occurrence-status')).toHaveText(
      'Recorded',
    );
    await expect(page.getByTestId('income-occurrence').first()).toContainText('Received 25 Sept 2026');

    // The server's reconciliation replaced the page: €2,000 of income arrived,
    // the balance rose by €2,000, so nothing was spent.
    const bucket = page.getByTestId('bucket-EUR');
    await expect(bucket.getByTestId('identity-I')).toContainText('€2,000.00');
    await expect(bucket.getByTestId('identity-tracked')).toContainText('€0.00');
    await expect(page.getByTestId('issue-group-suggested_income_missing')).toHaveCount(0);

    // And it stays recorded, and is never suggested a second time.
    await page.reload();
    await expect(page.getByTestId('income-occurrence')).toHaveCount(1);
    await expect(page.getByTestId('occurrence-status')).toHaveText('Recorded');
    await expect(page.getByTestId('occurrence-accept')).toHaveCount(0);

    // --- October: the next occurrence, received early --------------------------
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    await expect(page.getByTestId('monthly-kind')).toHaveText('In progress');

    const october = page.getByTestId('income-occurrence').first();
    await expect(october).toHaveAttribute('data-occurrence-date', '2026-10-25');
    await expect(october.getByTestId('occurrence-status')).toHaveText('Upcoming');
    // Nothing may be dated ahead of itself: the only way in is "received today".
    await expect(october.getByTestId('occurrence-accept')).toHaveCount(0);

    await october.getByTestId('occurrence-received-today').click();
    await expect(page.getByTestId('accept-panel')).toContainText('Recorded as arriving today');
    await page.getByTestId('accept-submit').click();

    // The money is today's; the occurrence keeps its own scheduled date.
    const recorded = page.getByTestId('income-occurrence').first();
    await expect(recorded.getByTestId('occurrence-status')).toHaveText('Recorded');
    await expect(recorded.getByTestId('occurrence-dates')).toContainText('Scheduled 25 Oct 2026');
    await expect(recorded.getByTestId('occurrence-received-on')).toContainText('Received 6 Oct 2026');

    // --- One payment by hand ----------------------------------------------------
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('other');
    await fillTestId(page, 'income-received-on', '2026-10-02');
    await fillTestId(page, 'income-net', '150.00');
    await page.getByTestId('income-account').selectOption({ label: 'Everyday' });
    await fillTestId(page, 'income-description', 'Sold the old bike');
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');

    // It appears once, in the group for income nothing scheduled.
    await expect(page.getByTestId('income-entry')).toHaveCount(1);
    await expect(page.getByTestId('income-direct')).toContainText('Sold the old bike');
    await expect(page.getByTestId('income-direct')).toContainText('€150.00');

    // A date outside the month on screen is not offered at all.
    await expect(page.getByTestId('income-received-on')).toHaveAttribute('min', '2026-10-01');
    await expect(page.getByTestId('income-received-on')).toHaveAttribute('max', '2026-10-06');

    // --- Correcting what was recorded --------------------------------------------
    const directRow = page.getByTestId('income-entry').first();

    // A direct row is the one kind with no source identity to keep, so how the
    // money arrived is correctable here (7.4).
    await directRow.getByTestId('entry-kind').selectOption('freelance');
    await directRow.getByTestId('entry-settlement').selectOption('external');
    await directRow.getByTestId('entry-apply-kind').click();
    // The server's answer replaced the row: it now states a settlement that
    // never touched tracked cash, so it carries no account either (7.4, 6.2).
    await expect(directRow.getByTestId('entry-attribution')).toHaveText(
      'Outside my tracked accounts',
    );
    await expect(directRow.getByTestId('entry-account')).toHaveCount(0);

    // The recurring row this month owns: its financial date moves inside the
    // month, and the occurrence it fulfils does not move with it.
    const recorded2 = page.getByTestId('income-occurrence').first();
    await expect(recorded2).toHaveAttribute('data-occurrence-date', '2026-10-25');
    await recorded2.getByTestId('entry-received-on').fill('2026-10-05');
    await expect(
      page.getByTestId('income-occurrence').first().getByTestId('occurrence-received-on'),
    ).toContainText('Received 5 Oct 2026');
    // The scheduling identity did not move with the money's date.
    await expect(page.getByTestId('income-occurrence').first()).toHaveAttribute(
      'data-occurrence-date',
      '2026-10-25',
    );
    // Still October's, still recorded once.
    await expect(page.getByTestId('income-occurrence')).toHaveCount(1);
    await expect(page.getByTestId('occurrence-status')).toHaveText('Recorded');

    // And it cannot be pushed out of the month from here.
    await expect(recorded2.getByTestId('entry-received-on')).toHaveAttribute('min', '2026-10-01');
    await expect(recorded2.getByTestId('entry-received-on')).toHaveAttribute('max', '2026-10-06');

    // The section never widens the page on a narrow screen (16.5).
    // The section never widens the page on a narrow screen (16.5): a table
    // wider than the viewport scrolls inside its own container, and nothing —
    // including the visually hidden labels inside its cells — escapes it.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

/**
 * A version conflict on a Monthly income amount, and the way out of it
 * (blueprint 15.3, 20.3).
 *
 * Two views of the same row in one signed-in session, which is the ordinary way
 * a conflict happens: a second tab, or a phone left open. One of them saves and
 * the other is holding the version that write consumed.
 *
 * What it proves is the pair of rules that only make sense together. A refused
 * save keeps what the user typed — the server stored nothing, so their amount
 * exists nowhere else and must not be thrown away by a refresh they did not ask
 * for. Reload is the one deliberate way to give it up, and it has to reach the
 * amount inputs too: their draft is their own state, so clearing the row's
 * drafts alone would leave a rejected figure rendering over the real one.
 */
test.describe('two views of one income row', () => {
  test('a refused amount stays on screen, and Reload replaces it with the server’s', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-06T10:00:00Z' });
    await onboard(page, request, uniqueEmail('e2e-monthly-conflict'));
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '1000.00' });

    // One ordinary income row, recorded through the product's own form.
    await page.goto('/monthly/2026-10');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('other');
    await fillTestId(page, 'income-received-on', '2026-10-02');
    await fillTestId(page, 'income-net', '100.00');
    await page.getByTestId('income-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');
    await expect(page.getByTestId('entry-net')).toHaveValue('100.00');

    // A second view of the same row, in the same session and the same clock.
    const stale = await page.context().newPage();
    await stale.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-06T10:00:00Z' });
    await stale.goto('/monthly/2026-10');
    await expect(stale.getByTestId('entry-net')).toHaveValue('100.00');

    // The first view corrects the amount, which consumes the row's version.
    await page.getByTestId('entry-net').fill('150.00');
    await page.getByTestId('entry-net').press('Tab');
    await expect(page.getByTestId('income-save-status').last()).toHaveText('Saved.');
    await expect(page.getByTestId('entry-net')).toHaveValue('150.00');

    // The second view is holding the version that write consumed.
    await stale.getByTestId('entry-net').fill('200.00');
    await stale.getByTestId('entry-net').press('Tab');
    await expect(stale.getByTestId('income-save-status').last()).toContainText(
      'Nothing was overwritten.',
    );
    // Nothing was stored, so 200 exists nowhere but here — it stays visible,
    // and no refresh runs over it.
    await expect(stale.getByTestId('entry-net')).toHaveValue('200.00');
    await expect(stale.getByTestId('entry-reload')).toBeVisible();

    // Reload is the explicit choice to give it up.
    await stale.getByTestId('entry-reload').click();
    await expect(stale.getByTestId('entry-net')).toHaveValue('150.00');
    await expect(stale.getByTestId('income-save-status').last()).toHaveText('');

    // And the row really is the server's now: the next edit from here succeeds.
    await stale.getByTestId('entry-net').fill('175.00');
    await stale.getByTestId('entry-net').press('Tab');
    await expect(stale.getByTestId('income-save-status').last()).toHaveText('Saved.');
    await stale.close();

    await page.reload();
    await expect(page.getByTestId('entry-net')).toHaveValue('175.00');
  });
});
