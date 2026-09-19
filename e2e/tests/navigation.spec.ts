import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * The signed-in shell's navigation (blueprint 15.1, 16.5, 16.6).
 *
 * "Mobile: bottom tabs Dashboard · Monthly · Investments · Analytics · More."
 * Below the desktop breakpoint the sidebar is not there, so these tabs are the
 * only way between sections. A person on a 375 px phone reaches every section
 * that exists — Dashboard and Monthly from the tabs, Accounts and Settings from
 * More — finds the ones that do not exist yet named with the phase that brings
 * them and leading nowhere, and never loses the page's end behind the bar. At
 * the desktop breakpoint the sidebar takes over and the tabs are gone.
 *
 * On 1 October with the test clock, so Monthly's address is the server's
 * current month, never the browser's.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_1 = '2026-10-01T10:00:00Z';
const CURRENT_MONTH = '/monthly/2026-10';

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

/** Sign up, verify, and finish onboarding without an account, landing on the dashboard. */
async function onboard(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto('/sign-up');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  await page.getByLabel('Your name').fill('Navigator');
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
  await expect(page).toHaveURL(/\/dashboard$/u);
}

/** Nothing on the page reaches past the viewport's right edge (16.5). */
async function fitsItsViewport(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

/**
 * The page's end — the footer — clears the bottom tabs once the page is
 * scrolled all the way down: the shell keeps their height free beneath it.
 */
async function footerClearsTheTabs(page: Page, tabs: Locator): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const footer = page.getByRole('contentinfo');
  await expect(footer).toBeVisible();
  await expect
    .poll(async () => {
      const [end, bar] = await Promise.all([footer.boundingBox(), tabs.boundingBox()]);
      if (end === null || bar === null) return Number.NaN;
      return bar.y - (end.y + end.height);
    })
    .toBeGreaterThanOrEqual(0);
}

/** The element that has focus lies inside `container`. */
async function focusIsInside(container: Locator): Promise<boolean> {
  return container.evaluate((element) => element.contains(document.activeElement));
}

test.describe('the signed-in navigation', () => {
  test('on a 375 px phone, a person reaches every built section from the tabs and More', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await page.setViewportSize({ width: 375, height: 812 });
    await onboard(page, request, uniqueEmail('e2e-navigation'));

    // --- the tabs, on the dashboard -----------------------------------------
    // Exactly "Sections": Monthly has a "Month sections" navigation of its own.
    const tabs = page.getByRole('navigation', { name: 'Sections', exact: true });
    await expect(tabs).toBeVisible();
    await expect(page.getByTestId('mobile-navigation')).toBeVisible();
    // The sidebar is not there below the desktop breakpoint, and nothing of it can be reached.
    await expect(page.getByTestId('desktop-navigation')).toBeHidden();
    await expect(page.getByTestId('desktop-navigation').getByRole('link')).toHaveCount(0);

    const dashboard = tabs.getByRole('link', { name: 'Dashboard', exact: true });
    const monthly = tabs.getByRole('link', { name: 'Monthly', exact: true });
    const more = tabs.getByRole('button', { name: 'More', exact: true });
    await expect(dashboard).toHaveAttribute('href', '/dashboard');
    await expect(dashboard).toHaveAttribute('aria-current', 'page');
    // Monthly opens the current month from the server's today, as the sidebar does.
    await expect(monthly).toHaveAttribute('href', CURRENT_MONTH);
    await expect(monthly).not.toHaveAttribute('aria-current', /.*/u);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).not.toHaveAttribute('aria-current', /.*/u);

    // Investments and Analytics are the blueprint's tabs, named with the phase
    // that brings them — and they are not links, so nothing leads to a 404.
    for (const [key, label, phase] of [
      ['investments', 'Investments', 4],
      ['analytics', 'Analytics', 8],
    ] as const) {
      const tab = page.getByTestId(`mobile-tab-${key}`);
      await expect(tab).toBeVisible();
      await expect(tab).toContainText(label);
      await expect(tab).toContainText(`Phase ${String(phase)}`);
      await expect(tab).toContainText(`arrives in Phase ${String(phase)}`);
      await expect(tabs.getByRole('link', { name: new RegExp(label, 'u') })).toHaveCount(0);
      await tab.click();
      await expect(page).toHaveURL(/\/dashboard$/u);
    }
    await expect(page.locator('a[href^="/investments"], a[href^="/analytics"]')).toHaveCount(0);

    await fitsItsViewport(page);
    await footerClearsTheTabs(page, tabs);

    // --- Monthly, then back to the dashboard --------------------------------
    await monthly.click();
    await expect(page).toHaveURL(new RegExp(`${CURRENT_MONTH}$`, 'u'));
    await expect(page.getByTestId('monthly-title')).toHaveText('October 2026');
    await expect(monthly).toHaveAttribute('aria-current', 'page');
    await expect(dashboard).not.toHaveAttribute('aria-current', /.*/u);
    await fitsItsViewport(page);
    await footerClearsTheTabs(page, tabs);

    await dashboard.click();
    await expect(page).toHaveURL(/\/dashboard$/u);
    await expect(dashboard).toHaveAttribute('aria-current', 'page');

    // --- More: what exists, and what does not yet ---------------------------
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeHidden();
    await more.click();
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    await expect(sheet.getByRole('link', { name: 'Accounts', exact: true })).toHaveAttribute('href', '/accounts');
    await expect(sheet.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/settings/profile');
    for (const [key, label, phase] of [
      ['income', 'Income', 3],
      ['spending', 'Spending', 3],
      ['real-estate', 'Real Estate', 6],
      ['debts', 'Debts', 5],
      ['projections', 'Projections', 10],
      ['goals', 'Goals', 9],
    ] as const) {
      const entry = sheet.getByTestId(`more-item-${key}`);
      await expect(entry).toBeVisible();
      await expect(entry).toContainText(label);
      await expect(entry).toContainText(`Phase ${String(phase)}`);
      await expect(sheet.getByRole('link', { name: new RegExp(label, 'u') })).toHaveCount(0);
    }
    // Spending is not a page yet, so nothing anywhere leads to it.
    await expect(page.locator('a[href^="/expenses"]')).toHaveCount(0);
    await fitsItsViewport(page);

    // --- Accounts through More ----------------------------------------------
    await sheet.getByRole('link', { name: 'Accounts', exact: true }).click();
    await expect(page).toHaveURL(/\/accounts$/u);
    await expect(sheet).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // More is the current tab while the page belongs to a section inside it.
    await expect(more).toHaveAttribute('aria-current', 'true');
    await expect(dashboard).not.toHaveAttribute('aria-current', /.*/u);
    await fitsItsViewport(page);
    await footerClearsTheTabs(page, tabs);

    // --- the keyboard: into More and out with Escape ------------------------
    // Opening moves focus into the sheet, and closing hands it back to More.
    // Tabbing through the sheet's links is left alone: Safari only tabs to
    // links when "Press Tab to highlight each item" is on, which it is not by
    // default.
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await expect.poll(() => focusIsInside(sheet)).toBe(true);
    await expect(sheet.getByRole('link', { name: 'Accounts', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    // A tap outside the sheet closes it as well.
    await more.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(187, 40);
    await expect(sheet).toBeHidden();

    // --- Settings through More ----------------------------------------------
    await more.click();
    await sheet.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/u);
    await expect(sheet).toBeHidden();
    await expect(more).toHaveAttribute('aria-current', 'true');
    await fitsItsViewport(page);
    await footerClearsTheTabs(page, tabs);

    await dashboard.click();
    await expect(page).toHaveURL(/\/dashboard$/u);
  });

  test('each viewport gets the navigation that fits it, switching at the desktop breakpoint', async ({
    page,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_1 });
    await onboard(page, request, uniqueEmail('e2e-navigation-viewport'));

    const sidebar = page.getByTestId('desktop-navigation');
    const tabs = page.getByTestId('mobile-navigation');
    const width = page.viewportSize()?.width ?? 0;

    if (width < 1024) {
      // The repository's own phone (Pixel 7): the tabs, and More to Accounts.
      await expect(tabs).toBeVisible();
      await expect(sidebar).toBeHidden();
      await expect(tabs.getByRole('link', { name: 'Monthly', exact: true })).toHaveAttribute('href', CURRENT_MONTH);
      await fitsItsViewport(page);
      await footerClearsTheTabs(page, tabs);
      await tabs.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Accounts', exact: true }).click();
      await expect(page).toHaveURL(/\/accounts$/u);
      await fitsItsViewport(page);
      await footerClearsTheTabs(page, tabs);
    } else {
      // Desktop: the sidebar as it always was, and no tabs at all.
      await expect(sidebar).toBeVisible();
      await expect(tabs).toBeHidden();
      await expect(page.getByTestId('mobile-tab-more')).toBeHidden();
      await expect(sidebar.getByRole('link', { name: 'Monthly', exact: true })).toHaveAttribute('href', CURRENT_MONTH);
      await sidebar.getByRole('link', { name: 'Accounts', exact: true }).click();
      await expect(page).toHaveURL(/\/accounts$/u);
    }

    // Either side of the breakpoint, whatever the device: one of the two, never both.
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect(tabs).toBeVisible();
    await expect(sidebar).toBeHidden();
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(sidebar).toBeVisible();
    await expect(tabs).toBeHidden();
  });
});
