import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The Phase 2 end-to-end journey (blueprint 21.5, Phase 2 acceptance).
 *
 * A real signed-in person: create a euro account with a dated balance, correct
 * it, add a dollar account, see native and reporting figures side by side, add
 * a car that is deliberately outside financial net worth, watch the two metrics
 * separate and rejoin as the flag is toggled, quick-update both accounts, and
 * find every earlier balance still there afterwards. Then sign out and back in,
 * and find all of it unchanged.
 *
 * A second scenario drives the clock across a month boundary, which is the one
 * rule that cannot be tested any other way: on 30 September there is no
 * statement balance to give, and on 1 October there is.
 *
 * Rates come from the deterministic fixture (`FX_PROVIDER=fixture`), so the
 * browser matrix never depends on a free public service being fast. Adapter
 * compatibility with the real Frankfurter v2 is proven separately by
 * `pnpm test:live`.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';

interface CapturedMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly tag: string;
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
    const response = await request.get(
      `/api/test/mailbox?to=${encodeURIComponent(to)}&tag=${tag}`,
    );
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

/** Controlled React forms are not usable until React owns them (`useHydrated`). */
async function ready(page: Page, testId: string): Promise<void> {
  await expect(page.getByTestId(testId)).toBeEnabled();
}

async function fillField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

async function fillTestId(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

/**
 * Sign up, verify and finish the wizard, landing on the dashboard with the
 * reporting currency set to EUR.
 */
async function onboard(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto('/sign-up');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  await fillField(page, 'Your name', 'Phase Two');
  await fillField(page, 'Email address', email);
  await fillField(page, 'Password', PASSWORD);
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

  // Step 4 — the first account, added in Phase 2. Skipped here so the scenario
  // below exercises the accounts page itself.
  await expect(page.getByTestId('create-cash-account')).toBeVisible();
  await page.getByTestId('onboarding-skip').click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/$/u);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await fillField(page, 'Email address', email);
  await fillField(page, 'Password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Today, as the server computes it — read off the page rather than guessed. */
async function todayFromForm(page: Page): Promise<string> {
  return (await page.getByTestId('account-balance-date').inputValue()) || '';
}

async function addCashAccount(
  page: Page,
  options: { name: string; currency: string; balance: string; on?: string },
): Promise<void> {
  await page.goto('/accounts?tab=cash');
  await ready(page, 'account-submit');
  await fillTestId(page, 'account-name', options.name);
  await page.getByTestId('account-currency').selectOption(options.currency);
  await fillTestId(page, 'account-balance', options.balance);
  if (options.on !== undefined) await fillTestId(page, 'account-balance-date', options.on);
  await page.getByTestId('account-submit').click();
  await expect(page.getByText(`${options.name} added.`)).toBeVisible();
}

test.describe('accounts, balances and the two net-worth metrics', () => {
  test('a person records balances in two currencies, adds an excluded asset, and finds everything intact', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-accounts');
    await onboard(page, request, email);

    // --- the empty state is honest -----------------------------------------
    await expect(page.getByText('Add your first account')).toBeVisible();

    // --- a euro account with a dated balance -------------------------------
    await page.goto('/accounts?tab=cash');
    await ready(page, 'account-submit');
    const today = await todayFromForm(page);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    // A balance cannot be dated after today — the control says so, and the
    // server says so again (M5, R17).
    await expect(page.getByTestId('account-balance-date')).toHaveAttribute('max', today);

    await addCashAccount(page, { name: 'BBVA checking', currency: 'EUR', balance: '8055.00' });

    await expect(page.getByTestId('cash-accounts-table')).toContainText('BBVA checking');
    await expect(page.getByTestId('cash-accounts-table')).toContainText('8,055.00');

    // --- correct that balance, and the history keeps both facts ------------
    await page.getByRole('link', { name: 'BBVA checking' }).click();
    await expect(page.getByTestId('position-native')).toContainText('8,055.00');

    await page.getByTestId(`edit-valuation-${today}`).click();
    await fillTestId(page, 'edit-valuation-amount', '8120.00');
    await page.getByTestId('save-valuation-edit').click();
    await expect(page.getByTestId('position-native')).toContainText('8,120.00');

    // …and an earlier, separate balance is a separate row, not a replacement.
    await fillTestId(page, 'valuation-amount', '7900.00');
    await fillTestId(page, 'valuation-date', '2026-01-15');
    await page.getByTestId('valuation-submit').click();
    await expect(page.getByTestId('valuation-saved')).toBeVisible();
    await expect(page.getByTestId('valuation-history')).toContainText('2026-01-15');
    await expect(page.getByTestId('valuation-history')).toContainText('7,900.00');
    // The current value is still the latest one, not the one just added.
    await expect(page.getByTestId('position-native')).toContainText('8,120.00');

    // --- a dollar account, and both figures side by side -------------------
    await addCashAccount(page, { name: 'US checking', currency: 'USD', balance: '3000.00' });

    const usdRow = page.getByRole('row', { name: /US checking/u });
    // The native amount is exactly what was entered…
    await expect(usdRow).toContainText('3,000.00');
    // …and a euro figure appears beside it, from a rate, not from a guess.
    await page.getByRole('link', { name: 'US checking' }).click();
    await expect(page.getByTestId('position-native')).toContainText('$');
    await expect(page.getByTestId('position-reporting')).toContainText('€');
    await expect(page.getByTestId('position-rate')).not.toHaveText('—');

    // --- an other asset, excluded from the headline figure ------------------
    await page.goto('/accounts?tab=other');
    await expect(page.getByText('Track something else you own.')).toBeVisible();
    await ready(page, 'asset-submit');
    await fillTestId(page, 'asset-name', 'Car');
    await page.getByTestId('asset-currency').selectOption('EUR');
    await fillTestId(page, 'asset-value', '20000.00');
    await page.getByTestId('asset-submit').click();
    await expect(page.getByText('Car added.')).toBeVisible();

    // Excluded by default (6.2): total net worth only.
    await expect(page.getByTestId('other-assets-table')).toContainText('Total only');

    // --- the two metrics differ by exactly the car -------------------------
    await page.goto('/dashboard');
    await expect(page.getByTestId('metrics-differ')).toBeVisible();

    const financialBefore = await page.getByTestId('financial-net-worth').innerText();
    const totalBefore = await page.getByTestId('total-net-worth').innerText();
    expect(financialBefore).not.toBe(totalBefore);
    // The car is in the total and named as the reason the two differ.
    await expect(page.getByTestId('component-other-excluded')).toContainText('20,000.00');
    await expect(page.getByTestId('component-other-included')).toContainText('0.00');

    // --- turn the flag on: the headline moves, the total does not ----------
    await page.goto('/accounts?tab=other');
    await page.getByRole('link', { name: 'Car' }).click();
    await ready(page, 'edit-submit');
    await page.getByTestId('edit-include').check();
    await page.getByTestId('edit-submit').click();
    await expect(page.getByTestId('accounts-success')).toHaveText('Saved.');
    // The badge in the page header, not the checkbox label beside it.
    await expect(
      page.getByText('In financial net worth', { exact: true }),
    ).toBeVisible();

    await page.goto('/dashboard');
    await expect(page.getByTestId('metrics-differ')).toHaveCount(0);
    const totalAfter = await page.getByTestId('total-net-worth').innerText();
    const financialAfter = await page.getByTestId('financial-net-worth').innerText();
    // Nothing a user switches can move total net worth…
    expect(headlineOf(totalAfter)).toBe(headlineOf(totalBefore));
    // …and the headline now equals it.
    expect(headlineOf(financialAfter)).toBe(headlineOf(totalAfter));
    // (The financial card also carries a change-since line, which is why the
    //  comparison is on the headline figure rather than on every number.)

    // --- quick update -------------------------------------------------------
    await page.getByTestId('quick-update-open').click();
    const bbvaField = page.locator('[data-testid^="quick-balance-"]').first();
    await bbvaField.fill('8200.00');
    await page.getByTestId('quick-update-save').click();
    await expect(page.getByTestId('quick-update-saved')).toContainText(today);

    // --- history survived it ------------------------------------------------
    await page.goto('/accounts?tab=cash');
    await page.getByRole('link', { name: 'BBVA checking' }).click();
    const history = page.getByTestId('valuation-history');
    await expect(history).toContainText('8,200.00');
    // The January balance is untouched: quick update writes today, and only
    // today (15.3).
    await expect(history).toContainText('2026-01-15');
    await expect(history).toContainText('7,900.00');

    // --- sign out and back in ----------------------------------------------
    await signOut(page);
    await signIn(page, email);
    await expect(page).toHaveURL(/\/dashboard/u);

    await page.goto('/accounts?tab=cash');
    await expect(page.getByTestId('cash-accounts-table')).toContainText('8,200.00');
    await expect(page.getByTestId('cash-accounts-table')).toContainText('US checking');
    await page.goto('/accounts?tab=other');
    await expect(page.getByTestId('other-assets-table')).toContainText('Included');
  });

  test('an asset nobody has valued is shown as unknown, never as zero', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-unknown');
    await onboard(page, request, email);

    await addCashAccount(page, { name: 'BBVA', currency: 'EUR', balance: '1000.00' });

    await page.goto('/accounts?tab=other');
    await ready(page, 'asset-submit');
    await fillTestId(page, 'asset-name', 'Coin collection');
    await page.getByTestId('asset-include').check();
    await page.getByTestId('asset-submit').click();
    await expect(page.getByText('Coin collection added.')).toBeVisible();

    // The row says "no value recorded" rather than showing a zero.
    await expect(page.getByTestId('other-assets-table')).toContainText('No value recorded');

    // …and the totals say they are incomplete, and name what is missing.
    await page.goto('/dashboard');
    await expect(page.getByText('Partial').first()).toBeVisible();
    await expect(page.getByText(/Not included: .*Coin collection/u).first()).toBeVisible();
  });
});

test.describe('closing a month with the clock', () => {
  test('offers no statement balance on 30 September, and offers one on 1 October', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-monthend');

    // 30 September: the month is not over, however late in it we are.
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-09-30T10:00:00Z' });
    await onboard(page, request, email);

    await addCashAccount(page, {
      name: 'BBVA',
      currency: 'EUR',
      balance: '8055.00',
      on: '2026-09-30',
    });

    await page.getByRole('link', { name: 'BBVA' }).click();
    await expect(page.getByTestId('month-end-section')).toBeVisible();
    // September is not on the list, because September has not ended (R15, C8).
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    // 1 October: it is.
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-01T10:00:00Z' });
    await page.reload();
    await expect(page.getByTestId('month-end-2026-09')).toBeVisible();

    // The 30 September snapshot can now be confirmed as the statement balance.
    await page.getByTestId('confirm-statement-2026-09').click();
    await expect(page.getByTestId('valuation-history')).toContainText('Statement balance');

    // …and once it is, the month is no longer waiting for one.
    await expect(page.getByTestId('month-end-2026-09')).toHaveCount(0);

    // The accounts page agrees.
    await page.goto('/accounts?tab=cash');
    await expect(page.getByTestId('cash-accounts-table')).toContainText('2026-09 closed');
  });

  test('a pre-existing account’s first balance is marked as such', async ({ page, request }) => {
    const email = uniqueEmail('e2e-firstbalance');

    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': '2026-10-01T10:00:00Z' });
    await onboard(page, request, email);

    // "It already existed — I am starting to track it now" is the default, and
    // it is the case that makes the first month unreadable as activity (8.1).
    await addCashAccount(page, {
      name: 'BBVA',
      currency: 'EUR',
      balance: '8055.00',
      on: '2026-09-30',
    });

    await page.getByRole('link', { name: 'BBVA' }).click();
    await page.getByTestId('confirm-statement-2026-09').click();

    await expect(page.getByTestId('first-balance-note')).toBeVisible();
    await page.goto('/accounts?tab=cash');
    await expect(page.getByTestId('cash-accounts-table')).toContainText('First balance');
  });
});

/** The first grouped figure on a card — its headline amount, as rendered. */
function headlineOf(text: string): string {
  const match = /[\d][\d.,]{2,}/u.exec(text);
  if (match === null) throw new Error(`No figure in: ${text}`);
  return match[0];
}

test.describe('dormant accounts', () => {
  test('can only be marked dormant at zero, and stop being dormant when money returns', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-dormant');
    await onboard(page, request, email);

    await page.goto('/accounts?tab=cash');
    await ready(page, 'account-submit');
    const today = await todayFromForm(page);

    await addCashAccount(page, { name: 'Old bank', currency: 'EUR', balance: '120.00' });
    await page.getByRole('link', { name: 'Old bank' }).click();
    await ready(page, 'edit-submit');

    // While it still holds money, the server refuses and says what to do.
    await page.getByTestId('edit-dormant').check();
    await page.getByTestId('edit-submit').click();
    await expect(page.getByTestId('accounts-error')).toContainText('exactly zero');

    // Empty it — correcting today's balance rather than adding a second one for
    // the same day, which M1 forbids — and the flag is accepted.
    await page.getByTestId(`edit-valuation-${today}`).click();
    await fillTestId(page, 'edit-valuation-amount', '0');
    await page.getByTestId('save-valuation-edit').click();
    await expect(page.getByTestId('position-native')).toContainText('0.00');

    await page.reload();
    await page.getByTestId('edit-dormant').check();
    await page.getByTestId('edit-submit').click();
    await expect(page.getByTestId('accounts-success')).toHaveText('Saved.');
    await expect(page.getByText('Dormant').first()).toBeVisible();

    // A dormant account is left out of the quick update (15.3).
    await page.goto('/accounts?tab=cash');
    await expect(page.getByTestId('quick-update-open')).toBeDisabled();
  });
});
