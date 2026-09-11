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
});
