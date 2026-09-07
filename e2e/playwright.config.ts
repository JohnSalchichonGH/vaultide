import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration (blueprint 21.5, 21.7).
 *
 * The suite runs against the production build — the same standalone artifact
 * the deployment runs — on desktop and mobile viewports.
 *
 * The server runs with the test capabilities switched on: the `TEST_CLOCK`
 * header for the month-boundary flows of Phase 2, and the capturing mailer
 * behind `/api/test/mailbox`, which is how a test reads the verification link a
 * real user would click (21.5). Both are refused on a production deployment.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  // When E2E_BASE_URL points at an already-running deployment, Playwright
  // starts nothing itself.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
      webServer: {
        // The standalone server — the same artifact production runs (22.1) —
        // so the suite does not depend on a package manager being on PATH.
        command: 'node server.js',
        url: `http://127.0.0.1:${String(PORT)}`,
        cwd: '../apps/web/.next/standalone/apps/web',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // A Next standalone server sets `NODE_ENV=production` on itself, so
          // the test capabilities are enabled by their own explicit flag. It is
          // refused outright on a production deployment (`VERCEL_ENV`), so this
          // cannot open the mailbox anywhere that matters.
          VAULTIDE_TEST_ENDPOINTS: 'enabled',
          // The suite creates several accounts per run; the sign-up limit of
          // three per ten minutes exists to stop exactly that. The limits are
          // asserted in the integration suite, where a 429 can be provoked on
          // purpose (packages/application/test/integration/security.test.ts).
          VAULTIDE_AUTH_RATE_LIMIT: 'disabled',
          NODE_ENV: 'test',
          PORT: String(PORT),
          HOSTNAME: '127.0.0.1',
          // Auth needs a secret and its own origin. The suite generates one per
          // run rather than carrying a fixture secret in the repository (17.3).
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString('hex'),
          BETTER_AUTH_URL: `${baseURL}/api/auth`,
          APP_URL: baseURL,
          // No EMAIL_API_KEY: outside production the mailer captures instead of
          // sending, which is exactly what the suite reads back.
        },
      },
    }),
});
