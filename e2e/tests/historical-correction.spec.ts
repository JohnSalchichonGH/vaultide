import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Historical Correction, end to end (blueprint 15.3, 30.22; ADR 0010; §108–§111
 * of the slice prompt).
 *
 * Three journeys, and each is a rule the product promises rather than a
 * rendering check:
 *
 *  - **a past month-end balance is corrected.** Edit it, read what it will
 *    recalculate, give a reason, confirm — and the month's reconciliation says
 *    something different afterwards;
 *  - **a recorded row is moved into another month.** The editor is where the
 *    date changes; the review is where both months are named; Back keeps the
 *    edit; the row lands in the month it now belongs to;
 *  - **an ordinary-looking save wakes an account out of a dormant period.**
 *    Nothing about recording a balance looks historical, and the product stops
 *    and explains before it rewrites those months.
 *
 * Every record is written through the product's own pages: there is no seeding
 * endpoint, so what these journeys prove is what a person actually gets.
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

async function waitForMessage(
  request: APIRequestContext,
  to: string,
  tag: string,
): Promise<CapturedMessage> {
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

/** An account whose August statement is entered and confirmed. */
async function accountWithAugustStatement(
  page: Page,
  options: { name: string; type: 'checking' | 'savings'; august: string },
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

const review = (page: Page) => page.getByTestId('correction-review');

/* -------------------------------------------------------------------------- */

test.describe('correcting a past month-end balance', () => {
  test('a person edits September’s statement, reviews what it changes, and confirms it', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-correction'));

    // --- a September that reconciles ---------------------------------------
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });
    await recordSnapshot(page, '1900.00', '2026-09-30');
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    await page.goto('/monthly/2026-09');
    await expect(page.getByTestId('monthly-kind')).toHaveText('Completed month');
    const row = page
      .getByTestId('monthly-accounts')
      .getByTestId('monthly-account')
      .filter({ hasText: 'Everyday' });
    await expect(row.getByTestId('closing-amount')).toHaveValue('1900.00');

    // --- a current-month record, to prove the short delete stays short -----
    await page.goto('/monthly/2026-10');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('other');
    await fillTestId(page, 'income-received-on', '2026-10-02');
    await fillTestId(page, 'income-net', '40.00');
    await page.getByTestId('income-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');

    // A current-month delete asks once, in place. No impact review (§110).
    await page.getByTestId('entry-delete').click();
    await expect(page.getByTestId('entry-delete-confirm-panel')).toContainText(
      'Delete this income entry?',
    );
    await expect(review(page)).toHaveCount(0);
    await page.getByTestId('entry-delete-cancel').click();
    await expect(page.getByTestId('entry-delete-confirm-panel')).toHaveCount(0);

    // --- the correction ----------------------------------------------------
    await page.goto('/monthly/2026-09');
    const closing = page
      .getByTestId('monthly-accounts')
      .getByTestId('monthly-account')
      .filter({ hasText: 'Everyday' })
      .getByTestId('closing-amount');
    // A higher close: more cash arrived in September than the records explain,
    // which is a real consequence rather than a figure moving quietly.
    await closing.fill('2100.00');
    await closing.press('Tab');

    // Review changes: the dialog, not a save.
    await expect(review(page)).toBeVisible();
    await expect(review(page).getByRole('heading', { name: 'Review changes' })).toBeVisible();

    // Before → after, on the fields a person cares about.
    await expect(review(page).getByTestId('correction-before').first()).toContainText('30 Sept 2026');
    await expect(review(page)).toContainText('1900');
    await expect(review(page)).toContainText('2100');
    // Neither an id nor the consent fingerprint is shown.
    await expect(review(page)).not.toContainText('hc-v1');

    // The months it will recalculate, and a real consequence of this edit:
    // September's cash no longer matches what the records explain.
    await expect(review(page).getByTestId('correction-periods')).toContainText('September 2026');
    await expect(review(page).getByTestId('correction-tags').first()).toContainText('Reconciliation');
    await expect(review(page).getByTestId('correction-structural')).toContainText('unresolved');

    await review(page).getByTestId('correction-reason').fill('Corrected from the statement');
    await review(page).getByTestId('correction-confirm').click();

    // The dialog closes, and the page shows the server's own new figure.
    await expect(review(page)).toHaveCount(0);
    await expect(
      page
        .getByTestId('monthly-accounts')
        .getByTestId('monthly-account')
        .filter({ hasText: 'Everyday' })
        .getByTestId('closing-amount'),
    ).toHaveValue('2100.00');

    // And the month itself says something different: the correction was applied
    // once, and every derived figure was read again from it.
    await expect(page.getByTestId('reconciliation-status')).toContainText('Unresolved');

    // The account's own history holds exactly one balance for 30 September.
    await page.goto('/accounts?tab=cash');
    await page.getByRole('link', { name: 'Everyday', exact: true }).click();
    const history = page.getByTestId('valuation-history');
    await expect(history).toContainText('2026-09-30');
    await expect(history.getByText('2026-09-30')).toHaveCount(1);
  });
});

test.describe('moving a recorded row into another month', () => {
  test('a person corrects a September income row into October, stepping back on the way', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-cross-month'));

    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '1000.00' });
    await recordSnapshot(page, '1200.00', '2026-09-30');
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    // One ordinary income row in September, through the product's own form.
    await page.goto('/monthly/2026-09');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('other');
    await fillTestId(page, 'income-received-on', '2026-09-20');
    await fillTestId(page, 'income-net', '200.00');
    await page.getByTestId('income-account').selectOption({ label: 'Everyday' });

    // Adding into a month that has closed is a first assertion, so it says what
    // it means once and saves normally — no review (§107).
    await expect(page.getByTestId('add-income-historical-note')).toContainText(
      'already closed',
    );
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');
    await expect(review(page)).toHaveCount(0);

    // --- the date moves into October ---------------------------------------
    await page.getByTestId('entry-received-on').fill('2026-10-03');

    await expect(review(page)).toBeVisible();
    // Both months are named: the one it leaves, and the one it arrives in.
    await expect(review(page).getByTestId('correction-periods')).toContainText('September 2026');
    await expect(review(page).getByTestId('correction-periods')).toContainText('October 2026');

    // Back keeps the edit exactly as it was typed, and the way in stays.
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('entry-received-on')).toHaveValue('2026-10-03');
    await page.getByTestId('correction-reopen').click();

    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    // September no longer owns it; October does.
    await expect(page.getByTestId('income-entry')).toHaveCount(0);
    await page.goto('/monthly/2026-10');
    await expect(page.getByTestId('entry-received-on')).toHaveValue('2026-10-03');
  });
});

test.describe('waking an account out of a dormant period', () => {
  test('an ordinary balance stops and explains before it rewrites those months', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-dormancy'));

    // An account emptied at the end of August and marked dormant from there.
    await accountWithAugustStatement(page, { name: 'Old savings', type: 'savings', august: '0.00' });
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await page.getByTestId('edit-dormant').check();
    await page.getByTestId('edit-submit').click();

    // Marking it dormant is itself a correction: the zero it rests on is in a
    // month that has already closed, so those months would carry it at zero.
    await expect(review(page)).toBeVisible();
    await expect(review(page).getByTestId('correction-intro')).toContainText('dormant');
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'becomes dormant from 31 Aug 2026',
    );
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('edit-dormant')).toBeChecked();

    // --- money comes back, months later ------------------------------------
    await expect(page.getByTestId('valuation-submit')).toBeEnabled();
    await fillTestId(page, 'valuation-amount', '500.00');
    await fillTestId(page, 'valuation-date', '2026-10-04');
    await page.getByTestId('valuation-submit').click();

    // Nothing about recording today's balance looks historical, and it is: the
    // dormant period it ends began in a month that closed (§9, §111).
    await expect(review(page)).toBeVisible();
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'no longer dormant from 31 Aug 2026',
    );
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    await expect(page.getByTestId('valuation-history')).toContainText('2026-10-04');
    await page.reload();
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await expect(page.getByTestId('edit-dormant')).not.toBeChecked();
  });
});
