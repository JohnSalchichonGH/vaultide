import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration (blueprint 21.5, 21.7).
 *
 * Phase 0 runs a smoke suite against the production build on desktop and mobile
 * viewports. The server starts with `NODE_ENV=test` so the `TEST_CLOCK` header
 * is available to the month-boundary flows that arrive in Phase 2.
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
          NODE_ENV: 'test',
          PORT: String(PORT),
          HOSTNAME: '127.0.0.1',
        },
      },
    }),
});
