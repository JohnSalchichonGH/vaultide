import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke suite (blueprint Phase 0 testing, 21.5).
 *
 * What only the running product can show. Besides the operational checks at the
 * end, it looks at two pages:
 *
 *  - the public landing page `/`: the shell renders and offers the way in, the
 *    theme control works, and status text keeps its contrast;
 *  - `/test/foundations`, a test-only fixture behind the same gate as the
 *    captured mailbox, so a production deployment answers 404: a real browser
 *    formats a 19-digit amount exactly, and the four-minor-unit (CLF) money
 *    input and the date input capped at today behave as a person finds them.
 *
 * The browser proves input and display, not storage. That a CLF amount is
 * serialized and read back with all four decimals is proven by the finance
 * tests, and that the currency catalogue keeps CLF's four minor units by the
 * database tests.
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

    // The theme control names the theme in effect, and its accessible name
    // contains that same word (WCAG 2.5.3) — asserted as such, not as one fixed
    // sentence. Each press moves one step through System, Dark and Light and
    // back to System, which forgets the stored choice and leaves the document
    // to the device's preference. A press changing the document is also what
    // proves the page hydrated under the CSP (ADR 0001).
    const themeToggle = page.getByTestId('theme-toggle');
    const html = page.locator('html');
    const storedTheme = () => page.evaluate(() => window.localStorage.getItem('vaultide-theme'));
    const expectShowing = async (label: 'System' | 'Dark' | 'Light') => {
      await expect(themeToggle).toHaveText(label);
      await expect(themeToggle).toHaveAccessibleName(new RegExp(`\\b${label}\\b`, 'u'));
    };

    await expect(themeToggle).toBeVisible();
    await expect(themeToggle).toHaveRole('button');
    await expectShowing('System');

    await themeToggle.click();
    await expectShowing('Dark');
    await expect(html).toContainClass('dark');
    await expect.poll(storedTheme).toBe('dark');

    // An explicit choice is remembered.
    await page.reload();
    await expectShowing('Dark');
    await expect(html).toContainClass('dark');

    await themeToggle.click();
    await expectShowing('Light');
    await expect(html).toContainClass('light');
    await expect(html).not.toContainClass('dark');
    await expect.poll(storedTheme).toBe('light');

    await themeToggle.click();
    await expectShowing('System');
    await expect(html).not.toContainClass('light');
    await expect(html).not.toContainClass('dark');
    await expect.poll(storedTheme).toBeNull();
  });

  test('sets warning and unavailable text at 4.5:1 or more in the light theme', async ({ page }) => {
    // Blueprint 16.2: text contrast of at least 4.5:1. Words in these two
    // tones are set on the page background and on cards. The engine resolves
    // each token and paints it into one canvas pixel, so the ratio is measured
    // on the sRGB colour the browser actually draws.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    const ratios = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d');
      if (context === null) throw new Error('No 2D canvas.');
      const tokens = getComputedStyle(document.documentElement);
      const luminance = (token: string): number => {
        const value = tokens.getPropertyValue(token).trim();
        context.fillStyle = '#010203';
        context.fillStyle = value;
        if (context.fillStyle === '#010203') throw new Error(`${token} is not a colour: "${value}".`);
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        const linear = (index: number): number => {
          const channel = (pixel[index] ?? Number.NaN) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(0) + 0.7152 * linear(1) + 0.0722 * linear(2);
      };
      const result: Record<string, number> = {};
      for (const text of ['--color-warning', '--color-unavailable']) {
        for (const surface of ['--color-background', '--color-surface']) {
          const [a, b] = [luminance(text), luminance(surface)];
          result[`${text} on ${surface}`] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }
      }
      return result;
    });

    expect(Object.keys(ratios)).toHaveLength(4);
    for (const [pair, ratio] of Object.entries(ratios)) {
      expect(ratio, pair).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * The test-only Phase 0 browser fixture. It answers 404 wherever the test
 * capabilities are off, a production deployment included.
 */
const FOUNDATIONS = '/test/foundations';

const FORMATTED_CURRENCIES = ['usd', 'eur', 'jpy', 'clf'] as const;

test.describe('exact money formatting in the browser', () => {
  test('formats 12345678901234567.89 in the browser without losing a digit', async ({
    page,
    request,
  }) => {
    // Browser formatter evidence. The server's HTML holds the formatter pending:
    // no ready marker, no row and no formatted amount. The rows appear only once
    // React has hydrated and the browser has run the self-test, so every value
    // asserted below was formatted by the browser itself.
    const response = await request.get(FOUNDATIONS);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="foundations-browser-pending"');
    expect(html).not.toContain('foundations-browser-ready');
    for (const currency of FORMATTED_CURRENCIES) {
      expect(html).not.toContain(`foundations-browser-row-${currency}`);
      expect(html).not.toContain(`foundations-browser-value-${currency}`);
    }
    expect(html).not.toMatch(/12[.,]345[.,]678[.,]901[.,]234[.,]56[78]/u);

    await page.goto(FOUNDATIONS);
    await expect(page.getByTestId('foundations-browser-ready')).toBeVisible();
    await expect(page.getByTestId('foundations-browser-pending')).toHaveCount(0);

    const formatted = (currency: string) =>
      page.getByTestId(`foundations-browser-value-${currency}`).innerText();
    const usd = await formatted('usd');
    const eur = await formatted('eur');
    const jpy = await formatted('jpy');
    const clf = await formatted('clf');

    // en-US and de-DE keep all 19 significant digits. For de-DE the grouping and
    // the decimal comma are asserted, not the spacing around the euro sign, whose
    // Unicode whitespace differs between engines.
    expect(digitsOf(usd)).toBe('1234567890123456789');
    expect(usd).toBe('$12,345,678,901,234,567.89');
    expect(digitsOf(eur)).toBe('1234567890123456789');
    expect(eur).toContain('12.345.678.901.234.567,89');

    // JPY has no minor units, so the value is rounded half-up to …568.
    expect(digitsOf(jpy)).toBe('12345678901234568');

    // CLF has four, and keeps them.
    expect(digitsOf(clf)).toBe('123456789012345678900');

    // Every row reports that the browser's output kept its digits. Which path
    // produced it — Intl's string path or the fallback assembler — is the
    // runtime's choice, and either is correct.
    for (const currency of FORMATTED_CURRENCIES) {
      await expect(page.getByTestId(`foundations-browser-row-${currency}`)).toHaveAttribute(
        'data-exact',
        'true',
      );
    }
  });

  test('validates a four-minor-unit MoneyInput in the browser', async ({ page }) => {
    await page.goto(FOUNDATIONS);
    // The inputs hydrate in the same pass as the formatter probe beside them, so
    // once it is ready React owns the field and nothing typed is discarded.
    await expect(page.getByTestId('foundations-browser-ready')).toBeVisible();

    const input = page.getByLabel('Balance (CLF)');
    await expect(input).toHaveValue('38123.4567');
    await expect(page.getByText('Up to 4 decimals.')).toBeVisible();

    // The value shown beside the field keeps all four decimals. It is the
    // fixture's only MoneyText (the formatter rows are plain cells), so the
    // locator is strict rather than positional.
    const displayed = page.getByTestId('money-text');
    expect(digitsOf(await displayed.innerText())).toBe('381234567');

    // A fifth decimal is rejected against the currency's minor units. Typed
    // rather than set programmatically, so the browser fires the same events a
    // person would.
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.pressSequentially('38123.45678');
    await expect(page.locator('p[role="alert"]')).toHaveText(
      'Use at most 4 decimals for this currency.',
    );

    // A comma is accepted as the decimal separator (16.6), and the displayed
    // value follows what was typed.
    await input.press('ControlOrMeta+a');
    await input.pressSequentially('1234,5678');
    await expect(page.locator('p[role="alert"]')).toHaveCount(0);
    expect(digitsOf(await displayed.innerText())).toBe('12345678');
  });
});

test.describe('dates are never in the future', () => {
  test('caps the date input at today and explains why', async ({ page }) => {
    await page.goto(FOUNDATIONS);

    const dateInput = page.getByLabel('Balance date');
    const max = await dateInput.getAttribute('max');
    expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // The explanation states the same today the field is capped at.
    await expect(
      page.getByText(`Today is ${max as string}. Later dates are not accepted.`, { exact: true }),
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
