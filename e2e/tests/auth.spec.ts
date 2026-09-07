import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { generateSync } from 'otplib';

/**
 * The Phase 1 end-to-end flow (blueprint 21.5, Phase 1 acceptance).
 *
 * Sign up → receive the captured verification email → verify → sign in →
 * configure time zone, base and reporting currency → enable and disable TOTP →
 * confirm the settings persisted → sign out and back in. Password reset and
 * account deletion follow as their own scenarios.
 *
 * The mail is read from `/api/test/mailbox`, the capturing mailer 21.5 calls
 * for, which exists only when the server runs with `NODE_ENV=test`.
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

/** The most recent captured message of a kind, waiting briefly for delivery. */
async function waitForMessage(
  request: APIRequestContext,
  to: string,
  tag: string,
): Promise<CapturedMessage> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request.get(
      `/api/test/mailbox?to=${encodeURIComponent(to)}&tag=${tag}`,
    );
    expect(response.status(), 'the capturing mailbox must be available under NODE_ENV=test').toBe(
      200,
    );
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

/**
 * Wait until a form is actually usable.
 *
 * These are controlled React forms: between the server HTML arriving and React
 * hydrating it, anything typed is discarded the moment React first renders from
 * its own empty state, and a click runs no handler at all. Vaultide keeps the
 * submit button disabled until then (`useHydrated`), so waiting for it to be
 * enabled is an exact barrier — and it is the same signal a person gets.
 *
 * WebKit hydrates a little later than Chromium and hit this reliably.
 */
async function formReady(page: Page, submitLabel: string): Promise<void> {
  await expect(page.getByRole('button', { name: submitLabel })).toBeEnabled();
}

async function fillField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

/** The same, for a field addressed by its test id. */
async function fillTestId(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

async function signUp(page: Page, email: string, name = 'Test Person'): Promise<void> {
  await page.goto('/sign-up');
  await formReady(page, 'Create account');
  await fillField(page, 'Your name', name);
  await fillField(page, 'Email address', email);
  await fillField(page, 'Password', PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('auth-success')).toBeVisible();
}

async function verify(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const message = await waitForMessage(request, email, 'verification');
  await page.goto(linkFrom(message));
  // Verification signs the user in, so the shell is available from here.
  await page.goto('/settings/profile');
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

/** Sign out, and wait for it to have happened before doing anything else. */
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId('user-menu')).toHaveCount(0);
}

async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await formReady(page, 'Sign in');
  await fillField(page, 'Email address', email);
  await fillField(page, 'Password', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('sign-up, verification and settings', () => {
  test('a new user signs up, verifies, configures settings and signs back in', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-happy');

    // --- sign up -----------------------------------------------------------
    await signUp(page, email, 'Ada Lovelace');

    // Signing up must not sign you in (17.1 `autoSignIn: false`), so the
    // verification gate is real: the protected area still redirects.
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/sign-in/u);

    // ...and signing in before verifying is refused.
    await signIn(page, email);
    await expect(page.getByTestId('auth-error')).toBeVisible();

    // --- verify ------------------------------------------------------------
    const message = await waitForMessage(request, email, 'verification');
    expect(message.subject).toContain('Vaultide');
    await page.goto(linkFrom(message));

    // 17.1 `autoSignInAfterVerification`: verifying proves control of the
    // address, so the user lands signed in.
    await page.goto('/onboarding/1');
    await expect(page.getByTestId('onboarding-timezone')).toBeVisible();

    // --- onboarding steps 1-3 ----------------------------------------------
    await page.getByTestId('onboarding-timezone').selectOption('Europe/Madrid');
    await page.getByTestId('onboarding-locale').selectOption('es-ES');
    await page.getByTestId('onboarding-continue').click();

    await expect(page.getByTestId('onboarding-base-currency')).toBeVisible();
    await page.getByTestId('onboarding-base-currency').selectOption('EUR');
    await page.getByTestId('onboarding-same-currency').uncheck();
    await page.getByTestId('onboarding-reporting-currency').selectOption('GBP');
    await page.getByTestId('onboarding-continue').click();

    await expect(page.getByTestId('onboarding-favorites')).toBeVisible();
    await page.getByTestId('onboarding-continue').click();

    // --- the settings persisted --------------------------------------------
    await expect(page).toHaveURL(/\/settings\/profile/u);
    await expect(page.getByTestId('profile-email')).toHaveText(email);
    await expect(page.getByTestId('timezone')).toHaveValue('Europe/Madrid');
    await expect(page.getByTestId('locale')).toHaveValue('es-ES');
    // "Today" is computed in the user's own time zone (T1, 7.7).
    await expect(page.getByTestId('profile-today')).toHaveText(/^\d{4}-\d{2}-\d{2}$/u);
    // The shell's selector shows the reporting currency, not the base one.
    await expect(page.getByTestId('reporting-currency')).toHaveValue('GBP');

    await page.goto('/settings/currencies');
    await expect(page.getByTestId('base-currency')).toHaveValue('EUR');
    await expect(page.getByTestId('reporting-currency-setting')).toHaveValue('GBP');

    // --- crypto is not a currency (R28, Phase 1 acceptance item 7) ---------
    const offered = await page.getByTestId('base-currency').locator('option').allTextContents();
    for (const crypto of ['BTC', 'ETH', 'USDT']) {
      expect(offered.some((option) => option.startsWith(crypto))).toBe(false);
    }
    // Nor is a currency the rate provider no longer publishes.
    expect(offered.some((option) => option.startsWith('BGN'))).toBe(false);
    expect(offered.some((option) => option.startsWith('EUR'))).toBe(true);

    // --- change a setting from the settings page ---------------------------
    await page.getByTestId('count-additional-spending').uncheck();
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByTestId('settings-success')).toBeVisible();

    // --- sign out and back in ----------------------------------------------
    await signOut(page);

    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/sign-in/u);

    await signIn(page, email);
    await expect(page).toHaveURL(/\/(settings|onboarding)/u);

    // Everything chosen before the sign-out is still there.
    await page.goto('/settings/currencies');
    await expect(page.getByTestId('base-currency')).toHaveValue('EUR');
    await expect(page.getByTestId('reporting-currency-setting')).toHaveValue('GBP');
    await expect(page.getByTestId('count-additional-spending')).not.toBeChecked();
  });
});

test.describe('two-factor authentication', () => {
  test('enabling TOTP gates sign-in on a code, and disabling it lifts the gate', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-totp');
    await signUp(page, email);
    await verify(page, request, email);

    await page.goto('/settings/security');
    await expect(page.getByTestId('two-factor-state')).toContainText('off');
    await expect(page.getByTestId('enable-2fa')).toBeEnabled();

    await fillTestId(page, 'totp-password', PASSWORD);
    await page.getByTestId('enable-2fa').click();

    // The backup codes are shown once, at this moment, and never again.
    await expect(page.getByTestId('backup-codes')).toBeVisible();
    const backupCodes = await page.getByTestId('backup-codes').locator('li').allTextContents();
    expect(backupCodes.length).toBeGreaterThan(0);

    const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
    expect(secret.length).toBeGreaterThan(0);

    await fillTestId(page, 'totp-code', generateSync({ secret }));
    await page.getByTestId('confirm-2fa').click();
    await expect(page.getByTestId('two-factor-state')).toContainText('on');

    // Sign out, then sign in: the password alone is no longer enough.
    await signOut(page);

    await signIn(page, email);
    await expect(page.getByLabel('Authentication code')).toBeVisible();

    await fillField(page, 'Authentication code', '000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('auth-error')).toBeVisible();

    await fillField(page, 'Authentication code', generateSync({ secret }));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/(settings|onboarding)/u);

    // Turning it off needs the password, and then sign-in stops asking.
    await page.goto('/settings/security');
    await expect(page.getByTestId('disable-2fa')).toBeEnabled();
    await fillTestId(page, 'totp-password', PASSWORD);
    await page.getByTestId('disable-2fa').click();
    await expect(page.getByTestId('settings-error')).toHaveCount(0);
    await expect(page.getByTestId('two-factor-state')).toContainText('off');

    await signOut(page);
    await signIn(page, email);
    await expect(page).toHaveURL(/\/(settings|onboarding)/u);
  });
});

test.describe('password reset', () => {
  test('a reset link sets a new password and invalidates the old one', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-reset');
    const NEW_PASSWORD = 'an-entirely-different-passphrase-2026';

    await signUp(page, email);
    await verify(page, request, email);

    // Verifying signs the user in (17.1 `autoSignInAfterVerification`), and a
    // signed-in visitor has no business on the reset page — so sign out first,
    // which is the state somebody who forgot their password is actually in.
    await signOut(page);

    await page.goto('/reset');
    await formReady(page, 'Send reset link');
    await fillField(page, 'Email address', email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByTestId('auth-success')).toBeVisible();

    const message = await waitForMessage(request, email, 'reset-password');
    await page.goto(linkFrom(message));

    await formReady(page, 'Set new password');
    await fillField(page, 'New password', NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByTestId('auth-success')).toBeVisible();

    // The old password no longer works.
    await signIn(page, email, PASSWORD);
    await expect(page.getByTestId('auth-error')).toBeVisible();

    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/(settings|onboarding)/u);
  });

  test('asks for an address and says the same thing whichever it is', async ({ page }) => {
    // 17.3 "Enumeration": the interface must not be the oracle the API refuses
    // to be. An address with no account gets the identical answer.
    await page.goto('/reset');
    await formReady(page, 'Send reset link');
    await fillField(page, 'Email address', uniqueEmail('e2e-nobody'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByTestId('auth-success')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  });
});

test.describe('account deletion', () => {
  test('needs the password and the typed phrase, then the account is gone', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('e2e-delete');
    await signUp(page, email);
    await verify(page, request, email);

    await page.goto('/settings/security');
    await expect(page.getByTestId('delete-account')).toBeEnabled();

    // The typed confirmation alone is not enough.
    await fillTestId(page, 'delete-password', 'not-the-password');
    await fillTestId(page, 'delete-confirmation', 'DELETE MY ACCOUNT');
    await page.getByTestId('delete-account').click();
    await expect(page.getByTestId('settings-error')).toBeVisible();

    // Nor is the password without the phrase.
    await fillTestId(page, 'delete-password', PASSWORD);
    await fillTestId(page, 'delete-confirmation', 'delete');
    await page.getByTestId('delete-account').click();
    await expect(page.getByTestId('settings-error')).toBeVisible();

    await fillTestId(page, 'delete-confirmation', 'DELETE MY ACCOUNT');
    await page.getByTestId('delete-account').click();

    // Signed out and back on the public page.
    await expect(page).toHaveURL(/\/$/u);
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/sign-in/u);

    // 18.3: a confirmation email is sent once the data is gone.
    const message = await waitForMessage(request, email, 'account-deleted');
    expect(message.subject).toContain('deleted');

    // The credentials no longer belong to anything.
    await signIn(page, email);
    await expect(page.getByTestId('auth-error')).toBeVisible();
  });
});
