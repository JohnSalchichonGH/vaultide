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
    await expect(page.getByText('Phase 0 — Foundations')).toBeVisible();
    await expect(page.getByText('Blueprint v2.1.2').first()).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('Vaultide');

    // The skip link is the first focusable element (16.6).
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('shows the reporting currency and the theme control', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Reporting currency (selectable from Phase 1)')).toHaveText('EUR');

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

    // A fifth decimal is rejected against the currency's minor units.
    await input.fill('38123.45678');
    await expect(page.locator('p[role="alert"]')).toContainText('at most 4 decimals');

    // A comma is accepted as the decimal separator (16.6).
    await input.fill('1234,5678');
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
    await expect(page.getByText(/Today is \d{4}-\d{2}-\d{2}\. Later dates are not accepted\./u)).toBeVisible();

    // Typing a future date is rejected by the component as well as by `max`.
    const future = '2099-12-31';
    await dateInput.fill(future);
    await expect(page.locator('p[role="alert"]')).toContainText('This date is in the future.');
  });
});

test.describe('operations', () => {
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
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
