import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke suite (blueprint Phase 0 testing, 21.5).
 *
 * Proves the two Phase 0 acceptance criteria that are only true in the running
 * product: the Vaultide shell renders, and money is formatted exactly — a
 * 19-digit amount in three locales, and a four-minor-unit currency (CLF) with
 * all four decimals intact.
 */

const digitsOf = (text: string): string => [...text].filter((c) => c >= '0' && c <= '9').join('');

test.describe('Vaultide shell', () => {
  test('renders the application shell', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle('Vaultide');
    await expect(page.getByRole('heading', { level: 1, name: 'Vaultide' })).toBeVisible();
    await expect(
      page.getByText('Phase 2 — Accounts, balances and net worth', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Blueprint v2.1.2').first()).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('Vaultide');

    // The skip link is present, reachable and becomes visible on focus (16.6).
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();

    // …and it comes first in tab order. Asserted structurally rather than by
    // pressing Tab, because Safari only tabs to links when "Press Tab to
    // highlight each item" is enabled, which is off by default.
    const firstFocusable = await page.evaluate(() => {
      const selector =
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const first = document.querySelector<HTMLElement>(selector);
      return { tag: first?.tagName ?? null, text: first?.textContent?.trim() ?? null };
    });
    expect(firstFocusable).toEqual({ tag: 'A', text: 'Skip to content' });
  });

  test('offers a way in, and the theme control', async ({ page }) => {
    await page.goto('/');
    // The reporting-currency selector became real in Phase 1 and belongs to a
    // signed-in visitor; an anonymous one is offered the way in instead.
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Create an account|Create account/u }).first()).toBeVisible();
    await expect(page.getByTestId('reporting-currency')).toHaveCount(0);

    const themeToggle = page.getByRole('button', { name: /Switch to (dark|light) theme/u });
    await expect(themeToggle).toBeVisible();
    await themeToggle.click();
    await expect(page.locator('html')).toHaveClass(/dark|light/u);
  });
});

test.describe('exact money formatting', () => {
  test('formats 12345678901234567.89 without losing a digit', async ({ page }) => {
    await page.goto('/');

    const values = page.getByTestId('money-text');
    await expect(values.first()).toBeVisible();

    const usd = await values.nth(0).innerText();
    const eur = await values.nth(1).innerText();
    const jpy = await values.nth(2).innerText();
    const clf = await values.nth(3).innerText();

    // en-US and de-DE keep all 19 significant digits.
    expect(digitsOf(usd)).toBe('1234567890123456789');
    expect(usd).toBe('$12,345,678,901,234,567.89');
    expect(digitsOf(eur)).toBe('1234567890123456789');
    expect(eur).toContain('12.345.678.901.234.567,89');

    // JPY has no minor units, so the value is rounded half-up to …568.
    expect(digitsOf(jpy)).toBe('12345678901234568');

    // CLF has four, and keeps them.
    expect(digitsOf(clf)).toBe('123456789012345678900');

    // Every locale reports which formatting path it used, and that it was exact.
    await expect(page.getByText('Intl string path').first()).toBeVisible();
    await expect(page.getByText('Exact formatting verified')).toBeVisible();
  });

  test('round-trips a four-minor-unit currency through the money input', async ({ page }) => {
    await page.goto('/');

    const input = page.getByLabel('Balance (CLF)');
    await expect(input).toHaveValue('38123.4567');
    await expect(page.getByText('Up to 4 decimals.')).toBeVisible();

    // The displayed value keeps all four decimals.
    const displayed = page.getByTestId('money-text').last();
    expect(digitsOf(await displayed.innerText())).toBe('381234567');

    // A fifth decimal is rejected against the currency's minor units. Typed
    // rather than set programmatically, so the browser fires the same events a
    // person would.
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.pressSequentially('38123.45678');
    await expect(page.locator('p[role="alert"]')).toContainText('at most 4 decimals');

    // A comma is accepted as the decimal separator (16.6).
    await input.press('ControlOrMeta+a');
    await input.pressSequentially('1234,5678');
    await expect(page.locator('p[role="alert"]')).toHaveCount(0);
    expect(digitsOf(await displayed.innerText())).toBe('12345678');
  });
});

test.describe('dates are never in the future', () => {
  test('caps the date input at today and explains why', async ({ page }) => {
    await page.goto('/');

    const dateInput = page.getByLabel('Balance date');
    const max = await dateInput.getAttribute('max');
    expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    await expect(
      page.getByText(/Today is \d{4}-\d{2}-\d{2}\. Later dates are not accepted\./u),
    ).toBeVisible();

    // The value the field starts with is today, never later.
    const value = await dateInput.inputValue();
    expect(value <= (max as string)).toBe(true);

    // The rule itself — "no actual record after today" — is asserted directly
    // against the validator in apps/web/test/format.test.ts, and again at the
    // server boundary, rather than through a native date picker whose
    // programmatic behaviour differs between browsers.
  });
});

test.describe('operations', () => {
  test('runs against the FX fixture, not the public rate service', async ({ request }) => {
    // The matrix must not depend on a free public API being fast: three
    // projects in parallel, each picking a currency, is exactly the concurrent
    // long-range request pattern that makes Frankfurter stall. Asserted rather
    // than assumed, because a silent fall-back to the real adapter would show
    // up as intermittent failures somewhere else entirely.
    const response = await request.get('/api/test/fx-provider');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { provider: string };
    expect(body.provider).toBe('fixture');
  });

  test('serves the health endpoint', async ({ request }) => {
    const response = await request.get('/api/health');
    const body = (await response.json()) as { status: string; database: string; version: string };

    // 200 with a database configured, 503 without — never a false "ok".
    expect([200, 503]).toContain(response.status());
    expect(['ok', 'degraded']).toContain(body.status);
    expect(response.headers()['cache-control']).toContain('no-store');
    if (response.status() === 200) {
      expect(body.status).toBe('ok');
      expect(body.database).toBe('ok');
    }
  });

  test('sends the security headers the blueprint requires', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['content-security-policy']).toMatch(/script-src [^;]*'nonce-/u);
    // `upgrade-insecure-requests` and HSTS belong to the HTTPS deployment only.
    expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
