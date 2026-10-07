import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoAfterRefresh, reloadAfterRefresh, waitForRouter } from '../support/navigation';

/**
 * Historical Correction, end to end (blueprint 15.3, 30.22; ADR 0010; §108–§111
 * of the slice prompt).
 *
 * Eight journeys, and each is a rule the product promises rather than a
 * rendering check:
 *
 *  - **a past month-end balance is corrected.** Edit it, read what it will
 *    recalculate, give a reason, confirm — and the month's reconciliation says
 *    something different afterwards;
 *  - **a recorded row is moved into another month.** The editor is where the
 *    date changes; the review is where both months are named; Back keeps the
 *    edit; the row lands in the month it now belongs to;
 *  - **a fact no figure reads is corrected.** A gross-only salary edit is still
 *    a revision of a closed month, so it is reviewed — and the review shows the
 *    gross it is changing, with the unchanged net beside it;
 *  - **a record moves between two accounts of the same name.** Names are not
 *    unique, so the review decides the change on the account itself and tells
 *    the two apart on screen;
 *  - **an ordinary-looking save wakes an account out of a dormant period.**
 *    Nothing about recording a balance looks historical, and the product stops
 *    and explains before it rewrites those months;
 *  - **a new income or expense in Monthly wakes one.** A single new record is
 *    a first assertion, but the dormant period it ends began in a closed month,
 *    so Monthly's Add income and Add expense open the review rather than
 *    stopping at the server's refusal;
 *  - **a skip from a finished month is restored.** Skipping stays ordinary,
 *    but taking a skip back reopens that month's expectation, so Restore opens
 *    the review there — and stays one click in the month still running;
 *  - **a recurring source's end date reaches a finished month.** An end date
 *    decides what a month expected, so a change that takes an occurrence from
 *    a finished month opens the review in place of the page's own
 *    confirmation — and a change that reaches no finished month keeps it.
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

  await waitForRouter(page);
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

    await gotoAfterRefresh(page, '/monthly/2026-09');
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
    await gotoAfterRefresh(page, '/monthly/2026-09');
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
    await expect(
      review(page)
        .locator('[data-testid="correction-field"][data-field="Date"]')
        .getByTestId('correction-before'),
    ).toContainText('30 Sept 2026');
    // A balance says whose balance it is.
    await expect(
      review(page)
        .locator('[data-testid="correction-field"][data-field="Account"]')
        .getByTestId('correction-after'),
    ).toContainText('Everyday');
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
    await gotoAfterRefresh(page, '/accounts?tab=cash');
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
    await gotoAfterRefresh(page, '/monthly/2026-09');
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
    await gotoAfterRefresh(page, '/monthly/2026-10');
    await expect(page.getByTestId('entry-received-on')).toHaveValue('2026-10-03');
  });
});

test.describe('correcting a fact no figure reads', () => {
  test('a gross-only salary correction shows the gross it is changing, then saves it', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-gross'));

    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '1000.00' });
    await recordSnapshot(page, '3100.00', '2026-09-30');
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    // A September salary with both figures, through the product's own form.
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('employment');
    await fillTestId(page, 'income-received-on', '2026-09-25');
    await fillTestId(page, 'income-net', '2100.00');
    await fillTestId(page, 'income-gross', '2600.00');
    await page.getByTestId('income-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');

    // --- only the gross moves -----------------------------------------------
    const gross = page.getByTestId('entry-gross');
    await gross.fill('2700.00');
    await gross.press('Tab');

    // A recorded row in a closed month is being revised, so this is the
    // review and not a save — and the review has to show what it is about.
    await expect(review(page)).toBeVisible();
    const grossRow = review(page).locator('[data-testid="correction-field"][data-field="Gross"]');
    await expect(grossRow).toHaveAttribute('data-changed', 'true');
    await expect(grossRow.getByTestId('correction-before')).toContainText('2600');
    await expect(grossRow.getByTestId('correction-after')).toContainText('2700');

    // Net sits beside it, unchanged, and is not presented as a change.
    const netRow = review(page).locator('[data-testid="correction-field"][data-field="Net"]');
    await expect(netRow).toHaveAttribute('data-changed', 'false');
    await expect(netRow.getByTestId('correction-before')).toContainText('2100');
    await expect(netRow.getByTestId('correction-after')).toContainText('2100');
    await expect(
      review(page).locator('[data-testid="correction-field"][data-changed="true"]'),
    ).toHaveCount(1);

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    // The row holds the corrected gross, and the net it always had.
    await reloadAfterRefresh(page);
    await expect(page.getByTestId('entry-gross')).toHaveValue('2700.00');
    await expect(page.getByTestId('entry-net')).toHaveValue('2100.00');
  });
});

test.describe('moving a record between two accounts of the same name', () => {
  /** The ids of every account currently listed as `name`, from their links. */
  async function idsNamed(page: Page, name: string): Promise<string[]> {
    const links = page.getByRole('link', { name, exact: true });
    const ids: string[] = [];
    for (let index = 0; index < (await links.count()); index += 1) {
      const href = await links.nth(index).getAttribute('href');
      if (href !== null) ids.push(href.split('?')[0]?.split('/').at(-1) as string);
    }
    return ids;
  }

  /** A second account with a name that is already taken, and its id. */
  async function anotherAccountNamed(
    page: Page,
    name: string,
    known: readonly string[],
  ): Promise<string> {
    await gotoAfterRefresh(page, '/accounts?tab=cash');
    await expect(page.getByTestId('account-submit')).toBeEnabled();
    await fillTestId(page, 'account-name', name);
    await page.getByTestId('account-currency').selectOption('EUR');
    await page.getByTestId('account-type').selectOption('savings');
    await fillTestId(page, 'account-balance', '400.00');
    await fillTestId(page, 'account-balance-date', '2026-08-31');
    await page.getByTestId('account-submit').click();
    await expect(page.getByText(`${name} added.`)).toBeVisible();
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(known.length + 1);

    const id = (await idsNamed(page, name)).find((candidate) => !known.includes(candidate));
    if (id === undefined) throw new Error('the new account has no link');
    await gotoAfterRefresh(page, `/accounts/${id}`);
    await page.getByTestId('confirm-statement-2026-08').click();
    await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
    return id;
  }

  test('an account-only correction says which Savings it left and which it joined', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-twins'));

    // Two EUR accounts, both called Savings: nothing forbids it.
    await accountWithAugustStatement(page, { name: 'Savings', type: 'savings', august: '1000.00' });
    const first = page.url().split('?')[0]?.split('/').at(-1) as string;
    const second = await anotherAccountNamed(page, 'Savings', [first]);
    expect(second).not.toBe(first);

    // A September salary into the first of them.
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('income-add-toggle').click();
    await page.getByTestId('income-kind').selectOption('employment');
    await fillTestId(page, 'income-received-on', '2026-09-25');
    await fillTestId(page, 'income-net', '500.00');
    await page.getByTestId('income-account').selectOption(first);
    await page.getByTestId('income-submit').click();
    await expect(page.getByTestId('income-saved')).toContainText('Income added.');
    await expect(page.getByTestId('entry-account')).toHaveValue(first);

    // --- only the account moves, to the other Savings ------------------------
    await page.getByTestId('entry-account').selectOption(second);

    await expect(review(page)).toBeVisible();
    const accountRow = review(page).locator('[data-testid="correction-field"][data-field="Account"]');
    await expect(accountRow).toHaveAttribute('data-changed', 'true');

    // Two different names on screen, though both accounts are called Savings.
    const before = (await accountRow.getByTestId('correction-before').textContent()) ?? '';
    const after = (await accountRow.getByTestId('correction-after').textContent()) ?? '';
    expect(before.startsWith('Savings')).toBe(true);
    expect(after.startsWith('Savings')).toBe(true);
    expect(before).not.toBe(after);

    // And nothing else is presented as changed.
    await expect(
      review(page).locator('[data-testid="correction-field"][data-changed="true"]'),
    ).toHaveCount(1);

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);

    // The row now belongs to the second Savings.
    await reloadAfterRefresh(page);
    await expect(page.getByTestId('entry-account')).toHaveValue(second);
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
    await reloadAfterRefresh(page);
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await expect(page.getByTestId('edit-dormant')).not.toBeChecked();
  });
});

test.describe('adding to an account dormant since a closed month, from Monthly', () => {
  /** "Old savings", emptied at the end of August and marked dormant from there. */
  async function dormantSinceAugust(page: Page): Promise<void> {
    await accountWithAugustStatement(page, { name: 'Old savings', type: 'savings', august: '0.00' });
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await page.getByTestId('edit-dormant').check();
    await page.getByTestId('edit-submit').click();
    await expect(review(page)).toBeVisible();
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('edit-dormant')).toBeChecked();
  }

  test('Add income opens Review changes, and Confirm correction saves it', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-monthly-add-income-dormant'));
    await dormantSinceAugust(page);

    // A payment into it today ends a dormant period that began in a closed
    // month. The form used to stop at the server's refusal; it now asks first.
    await gotoAfterRefresh(page, '/monthly/2026-10');
    await page.getByTestId('income-add-toggle').click();
    await expect(page.getByTestId('income-submit')).toBeEnabled();
    await page.getByTestId('income-kind').selectOption('other');
    await fillTestId(page, 'income-received-on', '2026-10-02');
    await fillTestId(page, 'income-net', '80.00');
    await page.getByTestId('income-account').selectOption({ label: 'Old savings' });
    await page.getByTestId('income-submit').click();

    await expect(review(page)).toBeVisible();
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'no longer dormant from 31 Aug 2026',
    );
    // Nothing is written until it is confirmed, and no refusal is shown.
    await expect(page.getByTestId('income-saved')).toHaveCount(0);
    await expect(page.getByTestId('income-error')).toHaveCount(0);
    await expect(page.getByTestId('income-entry')).toHaveCount(0);

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('add-income-confirmed')).toBeVisible();
    // The page is read again, and the form starts fresh.
    await expect(page.getByTestId('income-entry')).toHaveCount(1);
    await expect(page.getByTestId('income-direct')).toContainText('€80.00');
    await expect(page.getByTestId('income-net')).toHaveValue('');

    await gotoAfterRefresh(page, '/accounts?tab=cash');
    await page.getByRole('link', { name: 'Old savings', exact: true }).click();
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await expect(page.getByTestId('edit-dormant')).not.toBeChecked();
  });

  test('Add expense opens Review changes, and Confirm correction saves it', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-monthly-add-expense-dormant'));
    await dormantSinceAugust(page);

    // An expense paid from it today ends the same dormant period.
    await gotoAfterRefresh(page, '/monthly/2026-10');
    await page.getByTestId('expense-add-toggle').click();
    await expect(page.getByTestId('expense-add-submit')).toBeEnabled();
    await page.getByTestId('expense-add-category').selectOption({ label: 'Groceries' });
    await fillTestId(page, 'expense-add-date', '2026-10-02');
    await fillTestId(page, 'expense-add-amount', '12.00');
    await page.getByTestId('expense-add-account').selectOption({ label: 'Old savings' });
    await page.getByTestId('expense-add-submit').click();

    await expect(review(page)).toBeVisible();
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'no longer dormant from 31 Aug 2026',
    );
    await expect(page.getByTestId('expense-add-saved')).toHaveCount(0);
    await expect(page.getByTestId('expense-error')).toHaveCount(0);
    await expect(page.getByTestId('expense-entry')).toHaveCount(0);

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('add-expense-confirmed')).toBeVisible();
    await expect(page.getByTestId('expense-entry')).toHaveCount(1);
    await expect(page.getByTestId('expense-direct')).toContainText('€12.00');
    await expect(page.getByTestId('expense-add-amount')).toHaveValue('');

    await gotoAfterRefresh(page, '/accounts?tab=cash');
    await page.getByRole('link', { name: 'Old savings', exact: true }).click();
    await expect(page.getByTestId('edit-submit')).toBeEnabled();
    await expect(page.getByTestId('edit-dormant')).not.toBeChecked();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Restoring a skipped occurrence (ADR 0013 §1; cold review P3-27).
 *
 * A skip excuses its occurrence's month, so taking one back from a finished
 * month rewrites that month: September counts the rent as resolved while the
 * skip stands, and reports it missing once the skip goes. That restore is
 * reviewed. The same click in the month that is still running is what it
 * always was — one click.
 */
test.describe('restoring a skipped occurrence on Monthly', () => {
  test('an income skip from a finished month is reviewed, and one from this month is not', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-restore-income-skip'));
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });

    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('source-add-toggle').click();
    await expect(page.getByTestId('source-submit')).toBeEnabled();
    await fillTestId(page, 'source-name', 'Lodger');
    await page.getByTestId('source-kind').selectOption('rental');
    await page.getByTestId('source-frequency').selectOption('monthly');
    await fillTestId(page, 'source-day', '5');
    await fillTestId(page, 'source-start-date', '2026-09-01');
    await fillTestId(page, 'source-amount', '400.00');
    await page.getByTestId('source-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Lodger added.');

    // --- September: skipping is a first assertion, and stays ordinary ------------
    const lodger = page.getByTestId('income-occurrence').filter({ hasText: 'Lodger' });
    const missing = page.getByTestId('issue-group-suggested_income_missing');
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Not recorded');
    await expect(missing).toContainText('Lodger');
    await lodger.getByTestId('occurrence-skip').click();
    await page.getByTestId('skip-reason').selectOption({ label: 'Property was empty' });
    await page.getByTestId('skip-submit').click();
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Skipped');
    await expect(missing).toHaveCount(0);
    await expect(review(page)).toHaveCount(0);

    // --- …and taking it back is a correction of September ----------------------
    await lodger.getByTestId('occurrence-restore').click();
    await expect(review(page)).toBeVisible();
    await expect(review(page)).toContainText('Skipped occurrence · removed');
    await expect(review(page)).toContainText('Lodger');
    await expect(review(page)).toContainText('Property was empty');
    await expect(
      review(page).locator('[data-testid="correction-period"][data-month="2026-09"]'),
    ).toBeVisible();
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'September 2026 raises a new reconciliation issue.',
    );
    // Nothing is written while it is being reviewed.
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Skipped');

    // Back keeps it skipped, with the way back in on the row.
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Skipped');
    await lodger.getByTestId('correction-reopen').click();
    await expect(review(page)).toBeVisible();

    await fillTestId(page, 'correction-reason', 'The lodger paid after all');
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Not recorded');
    await expect(missing).toContainText('Lodger');

    // --- October: the month is still running, so it is one click ---------------
    await waitForRouter(page);
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    const october = page.getByTestId('income-occurrence').filter({ hasText: 'Lodger' });
    await expect(october).toHaveAttribute('data-occurrence-date', '2026-10-05');
    await october.getByTestId('occurrence-skip').click();
    await page.getByTestId('skip-submit').click();
    await expect(october.getByTestId('occurrence-status')).toHaveText('Skipped');
    await october.getByTestId('occurrence-restore').click();
    await expect(october.getByTestId('occurrence-status')).toHaveText('Not recorded');
    await expect(review(page)).toHaveCount(0);

    // Both restores were written.
    await reloadAfterRefresh(page);
    await expect(october.getByTestId('occurrence-status')).toHaveText('Not recorded');
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await expect(lodger.getByTestId('occurrence-status')).toHaveText('Not recorded');
  });

  test('a known expense skip from a finished month is reviewed, and one from this month is not', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-restore-expense-skip'));
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });

    await gotoAfterRefresh(page, '/monthly/2026-09');
    const section = page.getByTestId('monthly-known-expenses');
    await section.getByTestId('expense-source-add-toggle').click();
    await expect(page.getByTestId('expense-source-submit')).toBeEnabled();
    await fillTestId(page, 'expense-source-name', 'Gym');
    await page.getByTestId('expense-source-category').selectOption({ label: 'Subscriptions' });
    await page.getByTestId('expense-source-frequency').selectOption('monthly');
    await fillTestId(page, 'expense-source-day', '15');
    await fillTestId(page, 'expense-source-start-date', '2026-09-01');
    await fillTestId(page, 'expense-source-amount', '40.00');
    await page.getByTestId('expense-source-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('expense-source-submit').click();
    await expect(page.getByTestId('expense-source-saved')).toContainText('Gym added.');

    const occurrenceOn = (date: string) =>
      section.locator(`tr[data-testid="expense-occurrence"][data-occurrence-date="${date}"]`);
    const september = occurrenceOn('2026-09-15');
    await september.getByTestId('expense-skip').click();
    await page.getByTestId('expense-skip-submit').click();
    await expect(september.getByTestId('expense-occurrence-status')).toHaveText('Skipped');
    await expect(review(page)).toHaveCount(0);

    await september.getByTestId('expense-restore').click();
    await expect(review(page)).toBeVisible();
    await expect(review(page)).toContainText('Skipped occurrence · removed');
    await expect(review(page)).toContainText('Gym');
    await expect(review(page)).toContainText('Not charged');
    // Its completeness moves; missing income is about income, so no issue does.
    const structural = review(page).getByTestId('correction-structural');
    await expect(structural).toContainText('September 2026 becomes');
    await expect(structural).not.toContainText('issue');
    await expect(september.getByTestId('expense-occurrence-status')).toHaveText('Skipped');

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(september.getByTestId('expense-occurrence-status')).toHaveText('Not recorded');

    // --- October: the month is still running, so it is one click ---------------
    await waitForRouter(page);
    await page.getByTestId('month-next').click();
    await expect(page).toHaveURL(/\/monthly\/2026-10$/u);
    const october = occurrenceOn('2026-10-15');
    await expect(october.getByTestId('expense-occurrence-status')).toHaveText('Upcoming');
    await october.getByTestId('expense-skip').click();
    await page.getByTestId('expense-skip-submit').click();
    await expect(october.getByTestId('expense-occurrence-status')).toHaveText('Skipped');
    await october.getByTestId('expense-restore').click();
    await expect(october.getByTestId('expense-occurrence-status')).toHaveText('Upcoming');
    await expect(review(page)).toHaveCount(0);

    // Both restores were written.
    await reloadAfterRefresh(page);
    await expect(october.getByTestId('expense-occurrence-status')).toHaveText('Upcoming');
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await expect(september.getByTestId('expense-occurrence-status')).toHaveText('Not recorded');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Moving a recurring source's end date (ADR 0013 §2).
 *
 * An end date is historical schedule truth: ending a source on 31 August takes
 * September's occurrence out of what September expected. So that change is
 * reviewed, and the review is the only confirmation it gets. A change that
 * reaches no finished month keeps the page's own confirmation, as it always had.
 */
test.describe('moving a recurring source’s end date', () => {
  test('on the income source page, an end before a finished month’s payment is reviewed', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-end-date-income'));
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });

    await gotoAfterRefresh(page, '/monthly/2026-09');
    await page.getByTestId('source-add-toggle').click();
    await expect(page.getByTestId('source-submit')).toBeEnabled();
    await fillTestId(page, 'source-name', 'Lodger');
    await page.getByTestId('source-kind').selectOption('rental');
    await page.getByTestId('source-frequency').selectOption('monthly');
    await fillTestId(page, 'source-day', '5');
    await fillTestId(page, 'source-start-date', '2026-08-01');
    await fillTestId(page, 'source-amount', '400.00');
    await page.getByTestId('source-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('source-submit').click();
    await expect(page.getByTestId('source-saved')).toContainText('Lodger added.');

    await gotoAfterRefresh(page, '/income');
    await page.getByTestId('income-source').filter({ hasText: 'Lodger' }).getByTestId('income-source-link').click();
    await expect(page.getByTestId('source-title')).toHaveText('Lodger');
    await expect(page.getByTestId('source-detail-end')).toContainText('No end date');

    // --- an end that reaches no finished month keeps the page's confirmation --
    await fillTestId(page, 'source-end-date-input', '2026-12-31');
    await page.getByTestId('source-end-review').click();
    await expect(page.getByTestId('source-end-confirmation')).toContainText(
      'No completed month’s expected occurrences change.',
    );
    await expect(review(page)).toHaveCount(0);
    await page.getByTestId('source-end-confirm').click();
    await expect(page.getByTestId('source-end-saved')).toContainText('End date saved.');
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Dec 2026');
    await expect(review(page)).toHaveCount(0);

    // --- one before September's payment opens the review instead --------------
    await fillTestId(page, 'source-end-date-input', '2026-08-31');
    await page.getByTestId('source-end-review').click();
    await expect(review(page)).toBeVisible();
    await expect(page.getByTestId('source-end-confirmation')).toHaveCount(0);
    await expect(review(page)).toContainText('Recurring source');
    await expect(review(page)).toContainText('Lodger');
    await expect(review(page)).toContainText('31 Dec 2026');
    await expect(review(page)).toContainText('31 Aug 2026');
    await expect(review(page).locator('[data-testid="correction-period"][data-month="2026-09"]')).toBeVisible();
    await expect(review(page).getByTestId('correction-period')).toHaveCount(1);
    await expect(review(page).getByTestId('correction-structural')).toContainText(
      'A reconciliation issue in September 2026 clears.',
    );
    // Nothing is written while it is being reviewed.
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Dec 2026');

    // Back keeps the old end date, with the way back in beside the field.
    await review(page).getByTestId('correction-back').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Dec 2026');
    await page.getByTestId('source-end-date').getByTestId('correction-reopen').click();
    await expect(review(page)).toBeVisible();

    await fillTestId(page, 'correction-reason', 'The lodger moved out in August');
    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByTestId('source-end-saved')).toContainText('End date saved.');
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Aug 2026');

    // It was written, and September no longer expects the rent.
    await reloadAfterRefresh(page);
    await expect(page.getByTestId('source-detail-end')).toContainText('31 Aug 2026');
    await gotoAfterRefresh(page, '/monthly/2026-09');
    await expect(page.getByTestId('income-occurrence').filter({ hasText: 'Lodger' })).toHaveCount(0);
  });

  test('on Known expenses, an end before a finished month’s charge is reviewed', async ({ page, request }) => {
    test.slow();
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });
    await onboard(page, request, uniqueEmail('e2e-end-date-expense'));
    await accountWithAugustStatement(page, { name: 'Everyday', type: 'checking', august: '2000.00' });

    await gotoAfterRefresh(page, '/monthly/2026-09');
    const section = page.getByTestId('monthly-known-expenses');
    await section.getByTestId('expense-source-add-toggle').click();
    await expect(page.getByTestId('expense-source-submit')).toBeEnabled();
    await fillTestId(page, 'expense-source-name', 'Gym');
    await page.getByTestId('expense-source-category').selectOption({ label: 'Subscriptions' });
    await page.getByTestId('expense-source-frequency').selectOption('monthly');
    await fillTestId(page, 'expense-source-day', '15');
    await fillTestId(page, 'expense-source-start-date', '2026-08-01');
    await fillTestId(page, 'expense-source-amount', '40.00');
    await page.getByTestId('expense-source-account').selectOption({ label: 'Everyday' });
    await page.getByTestId('expense-source-submit').click();
    await expect(page.getByTestId('expense-source-saved')).toContainText('Gym added.');

    const september = section.locator('tr[data-testid="expense-occurrence"][data-occurrence-date="2026-09-15"]');
    const panel = page.getByTestId('expense-end-panel');

    // --- an end that reaches no finished month keeps the panel's confirmation -
    await september.getByTestId('expense-end').click();
    await fillTestId(page, 'expense-end-date', '2026-12-31');
    await page.getByTestId('expense-end-review').click();
    await expect(page.getByTestId('expense-end-confirmation')).toContainText(
      'No completed month’s expected occurrences change.',
    );
    await expect(review(page)).toHaveCount(0);
    await page.getByTestId('expense-end-confirm').click();
    await expect(panel).toHaveCount(0);
    await expect(review(page)).toHaveCount(0);

    // --- one before September's charge opens the review instead ---------------
    await waitForRouter(page);
    await september.getByTestId('expense-end').click();
    await expect(panel).toContainText('It ends on 31 Dec 2026.');
    await fillTestId(page, 'expense-end-date', '2026-08-31');
    await page.getByTestId('expense-end-review').click();
    await expect(review(page)).toBeVisible();
    await expect(page.getByTestId('expense-end-confirmation')).toHaveCount(0);
    await expect(review(page)).toContainText('Recurring source');
    await expect(review(page)).toContainText('Gym');
    await expect(review(page)).toContainText('31 Dec 2026');
    await expect(review(page)).toContainText('31 Aug 2026');
    await expect(review(page).locator('[data-testid="correction-period"][data-month="2026-09"]')).toBeVisible();
    // Its completeness moves; missing income is about income, so no issue does.
    const structural = review(page).getByTestId('correction-structural');
    await expect(structural).toContainText('September 2026 becomes');
    await expect(structural).not.toContainText('issue');
    // Nothing is written while it is being reviewed.
    await expect(september).toHaveCount(1);

    await review(page).getByTestId('correction-confirm').click();
    await expect(review(page)).toHaveCount(0);
    // September no longer expects the charge.
    await expect(september).toHaveCount(0);

    await reloadAfterRefresh(page);
    await expect(section.getByTestId('expense-occurrence')).toHaveCount(0);
  });
});
