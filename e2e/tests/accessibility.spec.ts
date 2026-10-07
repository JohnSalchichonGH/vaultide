import { AxeBuilder } from '@axe-core/playwright';
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { gotoAfterRefresh, waitForRouter } from '../support/navigation';

/**
 * The accessibility audit (blueprint 16.6; 25 "Cross-cutting checkpoints").
 *
 * axe-core checks every page a person can reach, and every dialog those pages
 * open, against WCAG 2.0, 2.1 and 2.2 at levels A and AA, plus the
 * best-practice rules for what 16.6 asks for and those levels leave out:
 * landmarks, heading order, a first-level heading and the skip link. Each one
 * is scanned in the light and the dark theme, at a desktop width and at a
 * 375 px phone. Any violation fails the test; the report names the rule, the
 * page, the view and the element.
 *
 * What axe cannot decide — contrast over an image, text it cannot see behind —
 * comes back as "incomplete". That does not fail the test. It is attached to
 * the result and listed as annotations, so that a person can check it by eye.
 *
 * What it does not do:
 *
 *  - It runs once, in Chromium. axe reads the DOM and the computed styles, and
 *    its findings do not depend on the engine, so the WebKit and Pixel 7
 *    projects skip it. The phone width is its own view inside this run.
 *  - It is not the keyboard, focus, zoom and motion pass. axe cannot tab
 *    through a page, so whether every action is reachable and shows its ring,
 *    whether a dialog gives focus back, and how a page reads at 200 % are
 *    checked by hand. A clean scan here is necessary, not sufficient.
 *
 * The person's records are written once, through the product's own pages as
 * every journey writes them, on 6 October: two euro accounts with statements
 * for August and September, an asset, a salary recorded, a lodger's payment
 * skipped, a gym membership and a grocery shop, and in October a payment, a
 * transfer and balances on two different days. September therefore carries
 * an interest advisory and October has no common balance date, so Monthly
 * shows real issues, and every page shows real figures. The scans themselves
 * write nothing: every dialog is opened and left unconfirmed, and its page is
 * closed.
 */

const PASSWORD = 'correct-horse-battery-staple-2026';
const OCTOBER_6 = '2026-10-06T10:00:00Z';

/* -------------------------------------------------------------------------- */
/* The rules                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * WCAG 2.0, 2.1 and 2.2, levels A and AA (16.6: "WCAG 2.2 AA"). axe tags its
 * WCAG 2.2 A rules `wcag2a` or `wcag21a` by the version that introduced the
 * criterion, so `wcag22aa` is the only 2.2 tag there is.
 *
 * axe leaves its experimental rules out of a tag selection unless the
 * `experimental` tag is asked for too. It is not, so the five experimental
 * WCAG rules in 4.13 do not run.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * The best-practice rules for what 16.6 names and no WCAG tag covers:
 * "Semantic landmarks, skip link, heading order". Every `landmark-*` rule axe
 * 4.13 has, `region`, the two heading rules and `skip-link`. No other
 * best-practice rule runs.
 */
const BEST_PRACTICE = [
  'landmark-banner-is-top-level',
  'landmark-complementary-is-top-level',
  'landmark-contentinfo-is-top-level',
  'landmark-main-is-top-level',
  'landmark-no-duplicate-banner',
  'landmark-no-duplicate-contentinfo',
  'landmark-no-duplicate-main',
  'landmark-one-main',
  'landmark-unique',
  'region',
  'heading-order',
  'page-has-heading-one',
  'skip-link',
];

type AxeOptions = Parameters<AxeBuilder['options']>[0];
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeResult = AxeResults['violations'][number];

/** Tags select the WCAG rules; `rules` adds the named best-practice ones to them. */
const AXE_OPTIONS: AxeOptions = {
  runOnly: { type: 'tag', values: WCAG },
  rules: Object.fromEntries(BEST_PRACTICE.map((id) => [id, { enabled: true }])),
};

/* -------------------------------------------------------------------------- */
/* The views                                                                   */
/* -------------------------------------------------------------------------- */

type Width = 'desktop' | 'phone';

interface View {
  readonly theme: 'light' | 'dark';
  readonly width: Width;
}

const VIEWS: readonly View[] = [
  { theme: 'light', width: 'desktop' },
  { theme: 'dark', width: 'desktop' },
  { theme: 'light', width: 'phone' },
  { theme: 'dark', width: 'phone' },
];

const viewName = (view: View): string => `${view.theme} ${view.width}`;

/** 16.5's desktop starts at 1,280; the phone is the narrowest common one. */
const WIDTHS: Readonly<Record<Width, BrowserContextOptions>> = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: {
    viewport: { width: 375, height: 812 },
    userAgent: devices['Pixel 7'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

/** A browser context for one view, signed in as `state`'s owner when there is one. */
function openView(
  browser: Browser,
  baseURL: string,
  view: View,
  state?: BrowserContextOptions['storageState'],
): Promise<BrowserContext> {
  return browser.newContext({
    ...WIDTHS[view.width],
    baseURL,
    colorScheme: view.theme,
    extraHTTPHeaders: { 'x-vaultide-test-clock': OCTOBER_6 },
    ...(state === undefined ? {} : { storageState: state }),
  });
}

/* -------------------------------------------------------------------------- */
/* The scan                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether React has hydrated this element.
 *
 * React keys every DOM node it has taken over with a `__reactFiber$…`
 * property, the server's HTML included. A scan of a page React has not
 * hydrated reads markup that is about to change, and flakes.
 */
async function hydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber$'))),
    )
    .toBe(true);
}

/** The element that shows the page has its data, once it is visible and hydrated. */
async function readyAt(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await hydrated(locator);
}

/**
 * The page as a person reads it, settled.
 *
 * Every `<details>` is opened, so the table under each chart ("View as table",
 * 16.3) is scanned with the rest: a closed one hides it from axe, and its
 * summary reads the same open or closed. Fonts are loaded and finite
 * animations have finished, so contrast is measured on the colours that stay.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const details of document.querySelectorAll('details:not([open])')) details.setAttribute('open', '');
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

interface Node {
  readonly target: string;
  readonly html: string;
  readonly summary: string;
}

interface Finding {
  readonly rule: string;
  readonly impact: string;
  readonly help: string;
  readonly nodes: readonly Node[];
}

interface Scan {
  readonly surface: string;
  readonly view: string;
  readonly url: string;
  readonly violations: readonly Finding[];
  readonly incomplete: readonly Finding[];
}

const findingOf = (result: AxeResult): Finding => ({
  rule: result.id,
  impact: result.impact ?? 'unknown',
  help: result.help,
  nodes: result.nodes.map((node) => ({
    target: node.target.map(String).join(' '),
    html: node.html,
    summary: node.failureSummary ?? '',
  })),
});

async function scan(page: Page, surface: string, view: View): Promise<Scan> {
  await settle(page);
  const results = await new AxeBuilder({ page }).options(AXE_OPTIONS).analyze();

  // The selection is what it says: every named best-practice rule ran, and
  // nothing ran that is neither WCAG A/AA nor named.
  const ran = [...results.passes, ...results.violations, ...results.incomplete, ...results.inapplicable];
  expect(BEST_PRACTICE.filter((id) => !ran.some((result) => result.id === id))).toEqual([]);
  expect(
    ran
      .filter((result) => !BEST_PRACTICE.includes(result.id) && !result.tags.some((tag) => WCAG.includes(tag)))
      .map((result) => result.id),
  ).toEqual([]);

  return {
    surface,
    view: viewName(view),
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    violations: results.violations.map(findingOf),
    incomplete: results.incomplete.map(findingOf),
  };
}

/**
 * Something to scan: a page, or a dialog open on one. `open` takes a fresh
 * page to the state to scan, and waits until it has its data and has
 * hydrated. `only` limits it to the width it exists at.
 */
interface Surface {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly only?: Width;
}

/**
 * Scans each surface in each view. One context per view keeps the browser's
 * cache warm between pages; one page per surface leaves nothing open behind it.
 */
async function scanAll(
  browser: Browser,
  baseURL: string,
  surfaces: readonly Surface[],
  state?: BrowserContextOptions['storageState'],
): Promise<Scan[]> {
  const scans: Scan[] = [];
  for (const view of VIEWS) {
    const context = await openView(browser, baseURL, view, state);
    try {
      for (const surface of surfaces) {
        if (surface.only !== undefined && surface.only !== view.width) continue;
        await test.step(`${surface.name} · ${viewName(view)}`, async () => {
          const page = await context.newPage();
          try {
            await surface.open(page);
            scans.push(await scan(page, surface.name, view));
          } finally {
            await page.close();
          }
        });
      }
    } finally {
      await context.close();
    }
  }
  return scans;
}

/**
 * Each finding once per rule, surface and element, with the views it was found
 * in. A rule that fails on one element in four views is one line, not four.
 */
function grouped(scans: readonly Scan[], pick: (scan: Scan) => readonly Finding[]): string[] {
  const lines = new Map<string, { views: string[]; summary: string }>();
  for (const scan of scans) {
    for (const finding of pick(scan)) {
      for (const node of finding.nodes) {
        const key = `${finding.rule} (${finding.impact}) · ${scan.surface} (${scan.url}) · ${node.target}`;
        const line = lines.get(key) ?? { views: [], summary: node.summary.replaceAll(/\s+/gu, ' ').trim() };
        line.views.push(scan.view);
        lines.set(key, line);
      }
    }
  }
  return [...lines].map(([key, line]) => `${key} · [${line.views.join(', ')}]${line.summary === '' ? '' : ` · ${line.summary}`}`);
}

/**
 * Attaches every scan, lists what axe could not decide, and fails on any
 * violation with the list of them.
 */
async function report(testInfo: TestInfo, scans: readonly Scan[]): Promise<void> {
  await testInfo.attach('axe-scans.json', {
    body: JSON.stringify(scans, null, 2),
    contentType: 'application/json',
  });
  for (const line of grouped(scans, (scan) => scan.incomplete)) {
    testInfo.annotations.push({ type: 'axe incomplete (check by eye)', description: line });
  }
  const violations = grouped(scans, (scan) => scan.violations);
  expect(violations, `axe found ${String(violations.length)} violations:\n${violations.join('\n')}`).toEqual([]);
}

/* -------------------------------------------------------------------------- */
/* The person's records                                                        */
/* -------------------------------------------------------------------------- */

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

async function fillTestId(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

/** Sign up and follow the confirmation link, which signs the person in. */
async function signUpAndVerify(page: Page, request: APIRequestContext, email: string, name: string): Promise<void> {
  await page.goto('/sign-up');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('auth-success')).toBeVisible();
  await page.goto(linkFrom(await waitForMessage(request, email, 'verification')));
}

async function onboard(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await signUpAndVerify(page, request, email, 'Audit');
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

/** A balance on the account page the browser is on, confirmed as the statement when asked. */
async function balance(page: Page, amount: string, on: string, statement: boolean): Promise<void> {
  await expect(page.getByTestId('valuation-submit')).toBeEnabled();
  await fillTestId(page, 'valuation-amount', amount);
  await fillTestId(page, 'valuation-date', on);
  await page.getByTestId('valuation-submit').click();
  await expect(page.getByTestId('valuation-history')).toContainText(on);
  if (statement) {
    const month = on.slice(0, 7);
    await page.getByTestId(`confirm-statement-${month}`).click();
    await expect(page.getByTestId(`month-end-${month}`)).toHaveCount(0);
  }
}

/**
 * A euro account with statements for August and September and one balance in
 * October. Returns its id.
 */
async function account(
  page: Page,
  options: { name: string; type: 'checking' | 'savings'; august: string; september: string; october: string; on: string },
): Promise<string> {
  await gotoAfterRefresh(page, '/accounts?tab=cash');
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
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/u);
  await page.getByTestId('confirm-statement-2026-08').click();
  await expect(page.getByTestId('month-end-2026-08')).toHaveCount(0);
  await balance(page, options.september, '2026-09-30', true);
  await balance(page, options.october, options.on, false);
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

/**
 * A recurring income source, added with the Monthly form the browser has
 * open. The form stays open after a save, ready for the next one.
 */
async function incomeSource(
  page: Page,
  options: { name: string; kind: string; day: string; amount: string },
): Promise<void> {
  await waitForRouter(page);
  await expect(page.getByTestId('source-submit')).toBeEnabled();
  await fillTestId(page, 'source-name', options.name);
  await page.getByTestId('source-kind').selectOption(options.kind);
  await page.getByTestId('source-frequency').selectOption('monthly');
  await fillTestId(page, 'source-day', options.day);
  await fillTestId(page, 'source-start-date', '2026-09-01');
  await fillTestId(page, 'source-amount', options.amount);
  await page.getByTestId('source-account').selectOption({ label: 'Everyday' });
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-saved')).toContainText(`${options.name} added.`);
}

/** Everything the scans read, written as a person would. Returns the ids the addresses need. */
async function furnish(page: Page, request: APIRequestContext): Promise<{ account: string; source: string }> {
  await onboard(page, request, uniqueEmail('e2e-accessibility'));

  // Everyday spent 469 in September beyond what was recorded; Savings grew by
  // 31 nobody explained, which is what raises the interest advisory (8.5). In
  // October the two were last updated on different days.
  const everyday = await account(page, {
    name: 'Everyday',
    type: 'checking',
    august: '2000.00',
    september: '3500.00',
    october: '3460.00',
    on: '2026-10-04',
  });
  await account(page, {
    name: 'Savings',
    type: 'savings',
    august: '10000.00',
    september: '10031.00',
    october: '10031.00',
    on: '2026-10-02',
  });

  await gotoAfterRefresh(page, '/accounts?tab=other');
  await expect(page.getByTestId('asset-submit')).toBeEnabled();
  await fillTestId(page, 'asset-name', 'Car');
  await page.getByTestId('asset-currency').selectOption('EUR');
  await fillTestId(page, 'asset-value', '20000.00');
  await page.getByTestId('asset-submit').click();
  await expect(page.getByText('Car added.')).toBeVisible();

  // --- September: a salary recorded, a lodger's payment skipped, two expenses
  await gotoAfterRefresh(page, '/monthly/2026-09');
  await expect(page.locator('#accounts').getByTestId('closing-amount').first()).toBeEnabled();
  await page.getByTestId('source-add-toggle').click();
  await incomeSource(page, { name: 'Salary', kind: 'employment', day: '25', amount: '2000.00' });
  const salary = page.getByTestId('income-occurrence').filter({ hasText: 'Salary' });
  await salary.getByTestId('occurrence-accept').click();
  await expect(salary.getByTestId('occurrence-status')).toHaveText('Recorded');

  await incomeSource(page, { name: 'Lodger', kind: 'rental', day: '5', amount: '400.00' });
  const lodger = page.getByTestId('income-occurrence').filter({ hasText: 'Lodger' });
  await lodger.getByTestId('occurrence-skip').click();
  await page.getByTestId('skip-reason').selectOption({ label: 'Property was empty' });
  await page.getByTestId('skip-submit').click();
  await expect(lodger.getByTestId('occurrence-status')).toHaveText('Skipped');

  const known = page.getByTestId('monthly-known-expenses');
  await waitForRouter(page);
  await known.getByTestId('expense-source-add-toggle').click();
  await fillTestId(page, 'expense-source-name', 'Gym');
  await page.getByTestId('expense-source-category').selectOption({ label: 'Subscriptions' });
  await page.getByTestId('expense-source-frequency').selectOption('monthly');
  await fillTestId(page, 'expense-source-day', '15');
  await fillTestId(page, 'expense-source-start-date', '2026-09-01');
  await fillTestId(page, 'expense-source-amount', '40.00');
  await page.getByTestId('expense-source-account').selectOption({ label: 'Everyday' });
  await page.getByTestId('expense-source-submit').click();
  await expect(page.getByTestId('expense-source-saved')).toContainText('Gym added.');
  const gym = known.locator('tr[data-testid="expense-occurrence"][data-occurrence-date="2026-09-15"]');
  await gym.getByTestId('expense-record').click();
  await expect(gym.getByTestId('expense-occurrence-status')).toHaveText('Recorded');

  await waitForRouter(page);
  await known.getByTestId('expense-add-toggle').click();
  await page.getByTestId('expense-add-category').selectOption({ label: 'Groceries' });
  await fillTestId(page, 'expense-add-date', '2026-09-12');
  await fillTestId(page, 'expense-add-amount', '120.00');
  await page.getByTestId('expense-add-payment').selectOption({ label: 'Paid from tracked account' });
  await page.getByTestId('expense-add-account').selectOption({ label: 'Everyday' });
  await fillTestId(page, 'expense-add-description', 'Market');
  await page.getByTestId('expense-add-submit').click();
  await expect(page.getByTestId('expense-add-saved')).toContainText('Expense added.');
  await expect(page.getByTestId('issue-group-possible_missing_interest')).toBeVisible();

  // --- October: a payment by hand and a transfer -----------------------------
  await gotoAfterRefresh(page, '/monthly/2026-10');
  await expect(page.locator('#accounts').getByTestId('quick-update-open')).toBeEnabled();
  await page.getByTestId('income-add-toggle').click();
  await page.getByTestId('income-kind').selectOption('other');
  await fillTestId(page, 'income-received-on', '2026-10-02');
  await page.getByTestId('income-account').selectOption({ label: 'Everyday' });
  await fillTestId(page, 'income-description', 'Sold the old bike');
  await fillTestId(page, 'income-net', '40.00');
  await page.getByTestId('income-submit').click();
  await expect(page.getByTestId('income-saved')).toContainText('Income added.');

  await waitForRouter(page);
  await page.getByTestId('transfer-add').click();
  const transfer = page.getByTestId('transfer-dialog');
  await expect(transfer).toBeVisible();
  await transfer.getByTestId('transfer-date').fill('2026-10-03');
  await transfer.getByTestId('transfer-from').selectOption({ label: 'Everyday (EUR)' });
  await transfer.getByTestId('transfer-to').selectOption({ label: 'Savings (EUR)' });
  await transfer.getByTestId('transfer-amount').fill('100.00');
  await transfer.getByTestId('transfer-save').click();
  await expect(page.getByTestId('transfer-status')).toHaveText('Transfer added.');
  await expect(page.getByTestId('issue-group-mtd_no_common_date')).toBeVisible();

  // --- The salary's own page -------------------------------------------------
  await gotoAfterRefresh(page, '/income');
  const link = page.getByTestId('income-source').filter({ hasText: 'Salary' }).getByTestId('income-source-link');
  const href = (await link.getAttribute('href')) ?? '';
  const source = /^\/income\/sources\/([0-9a-f-]{36})$/u.exec(href)?.[1];
  if (source === undefined) throw new Error(`No source id in ${href}.`);
  return { account: everyday, source };
}

/* -------------------------------------------------------------------------- */
/* What is scanned                                                             */
/* -------------------------------------------------------------------------- */

/** The anonymous pages: the homepage and the four auth pages. */
const SIGNED_OUT: readonly Surface[] = [
  {
    name: 'homepage',
    open: async (page) => {
      await page.goto('/');
      await readyAt(page.getByRole('heading', { level: 1 }));
    },
  },
  {
    name: 'sign in',
    open: async (page) => {
      await page.goto('/sign-in');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    },
  },
  {
    name: 'sign up',
    open: async (page) => {
      await page.goto('/sign-up');
      await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
    },
  },
  {
    name: 'verify',
    open: async (page) => {
      await page.goto('/verify');
      await expect(page.locator('main button[type="submit"]')).toBeEnabled();
    },
  },
  {
    name: 'reset',
    open: async (page) => {
      await page.goto('/reset');
      await expect(page.locator('main button[type="submit"]')).toBeEnabled();
    },
  },
];

/** A person who has signed up and confirmed, and not finished onboarding. */
const NEWCOMER: readonly Surface[] = [
  {
    name: 'onboarding',
    open: async (page) => {
      await page.goto('/onboarding/1');
      await expect(page.getByTestId('onboarding-timezone')).toBeVisible();
      await expect(page.getByTestId('onboarding-continue')).toBeEnabled();
    },
  },
];

const monthlyAccount = (page: Page, name: string): Locator =>
  page.getByTestId('monthly-accounts').getByTestId('monthly-account').filter({ hasText: name });

/**
 * A Monthly page with its data, once its accounts can be edited: a completed
 * month's closing balances, or the current month's Update all today.
 */
async function monthly(page: Page, month: string, kind: 'Completed month' | 'In progress'): Promise<void> {
  await page.goto(`/monthly/${month}`);
  await expect(page.getByTestId('monthly-kind')).toHaveText(kind);
  await expect(
    kind === 'Completed month'
      ? monthlyAccount(page, 'Everyday').getByTestId('closing-amount')
      : page.locator('#accounts').getByTestId('quick-update-open'),
  ).toBeEnabled();
}

/** The person's pages and the dialogs they open. */
function signedIn(ids: { account: string; source: string }): Surface[] {
  return [
    {
      name: 'dashboard',
      open: async (page) => {
        await page.goto('/dashboard');
        await readyAt(page.getByTestId('financial-net-worth'));
        await expect(page.getByTestId('quick-update-open')).toBeEnabled();
      },
    },
    {
      name: 'accounts, cash',
      open: async (page) => {
        await page.goto('/accounts');
        await expect(page.getByTestId('cash-accounts-table')).toContainText('Everyday');
        await expect(page.getByTestId('account-submit')).toBeEnabled();
      },
    },
    {
      name: 'accounts, other assets',
      open: async (page) => {
        await page.goto('/accounts?tab=other');
        await expect(page.getByTestId('other-assets-table')).toContainText('Car');
        await expect(page.getByTestId('asset-submit')).toBeEnabled();
      },
    },
    {
      name: 'account',
      open: async (page) => {
        await page.goto(`/accounts/${ids.account}`);
        await expect(page.getByTestId('valuation-history')).toContainText('2026-10-04');
        await expect(page.getByTestId('valuation-submit')).toBeEnabled();
      },
    },
    {
      name: 'monthly, completed',
      open: async (page) => {
        await monthly(page, '2026-09', 'Completed month');
        await expect(page.getByTestId('issue-group-possible_missing_interest')).toBeVisible();
        await expect(
          page.getByTestId('income-occurrence').filter({ hasText: 'Lodger' }).getByTestId('occurrence-status'),
        ).toHaveText('Skipped');
      },
    },
    {
      name: 'monthly, current',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        await expect(page.getByTestId('issue-group-mtd_no_common_date')).toBeVisible();
        await expect(page.getByTestId('transfer')).toHaveCount(1);
      },
    },
    {
      // The add forms are closed until asked for, so a scan of the page alone
      // never reads their labels.
      name: 'monthly, current, add forms open',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        for (const toggle of ['source-add-toggle', 'income-add-toggle', 'expense-source-add-toggle', 'expense-add-toggle']) {
          await page.getByTestId(toggle).click();
          await expect(page.getByTestId(toggle)).toHaveAttribute('aria-expanded', 'true');
        }
        await expect(page.getByTestId('source-submit')).toBeEnabled();
        await expect(page.getByTestId('expense-add-submit')).toBeEnabled();
      },
    },
    {
      name: 'bulk history',
      open: async (page) => {
        await page.goto('/monthly/2026-09/history');
        await expect(page.getByTestId('bulk-column').filter({ hasText: 'Salary' })).toBeVisible();
        await readyAt(page.getByTestId('bulk-grid'));
      },
    },
    {
      name: 'spending',
      open: async (page) => {
        await page.goto('/expenses');
        await expect(page.getByTestId('spending-month')).toHaveText('September 2026');
        await readyAt(page.getByTestId('spending-title'));
        await expect(page.getByTestId('expense-add-submit')).toBeEnabled();
      },
    },
    {
      name: 'income',
      open: async (page) => {
        await page.goto('/income');
        await expect(page.getByTestId('income-source').filter({ hasText: 'Salary' })).toBeVisible();
        await readyAt(page.getByTestId('income-title'));
      },
    },
    {
      name: 'income source',
      open: async (page) => {
        await page.goto(`/income/sources/${ids.source}`);
        await expect(page.getByTestId('source-title')).toHaveText('Salary');
        await readyAt(page.getByTestId('source-occurrence').first());
      },
    },
    {
      // `/settings` has no page of its own: it sends the person to Profile.
      name: 'settings, profile',
      open: async (page) => {
        await page.goto('/settings');
        await expect(page).toHaveURL(/\/settings\/profile$/u);
        await readyAt(page.getByTestId('profile-email'));
      },
    },
    // Data has no form of its own; the others wait for theirs.
    ...(['categories', 'currencies', 'data', 'security'] as const).map(
      (area): Surface => ({
        name: `settings, ${area}`,
        open: async (page) => {
          await page.goto(`/settings/${area}`);
          await readyAt(page.getByRole('navigation', { name: 'Settings sections' }));
          if (area !== 'data') await expect(page.locator('main button[type="submit"]').first()).toBeEnabled();
        },
      }),
    ),

    /* --- dialogs, scanned open -------------------------------------------- */
    {
      name: 'dialog: correction review, from a Monthly edit',
      open: async (page) => {
        await monthly(page, '2026-09', 'Completed month');
        const closing = monthlyAccount(page, 'Everyday').getByTestId('closing-amount');
        await closing.fill('3600.00');
        await closing.press('Tab');
        await readyAt(page.getByTestId('correction-review'));
        await expect(page.getByTestId('correction-confirm')).toBeEnabled();
      },
    },
    {
      // From Monthly by its link, as a person arrives: the grid's inputs are
      // not hydration-gated, so a value typed straight after a full load can
      // be lost.
      name: 'dialog: bulk history save review',
      open: async (page) => {
        await monthly(page, '2026-09', 'Completed month');
        await page.getByTestId('monthly-bulk-history').click();
        await expect(page).toHaveURL(/\/monthly\/2026-09\/history$/u);
        await page.locator('tr[data-month="2026-09"]').getByTestId('bulk-input').first().fill('3600.00');
        await expect(page.getByTestId('bulk-status')).toContainText('1 changed cell');
        await page.getByTestId('bulk-review').click();
        await readyAt(page.getByTestId('correction-review'));
        await expect(page.getByTestId('bulk-review-headline')).toBeVisible();
      },
    },
    {
      name: 'dialog: delete confirmation',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        await page.getByTestId('income-direct').getByTestId('entry-delete').click();
        await readyAt(page.getByTestId('entry-delete-confirm-panel'));
      },
    },
    {
      name: 'dialog: issue action',
      open: async (page) => {
        await monthly(page, '2026-09', 'Completed month');
        await page.getByTestId('issue-group-possible_missing_interest').getByTestId('issue-action').first().click();
        await readyAt(page.getByTestId('issue-dialog'));
        await expect(page.getByTestId('issue-dialog').getByTestId('income-submit')).toBeEnabled();
      },
    },
    {
      name: 'dialog: transfer, new',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        await page.getByTestId('transfer-add').click();
        await readyAt(page.getByTestId('transfer-dialog'));
      },
    },
    {
      name: 'dialog: transfer, edit with a fee',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        await page.getByTestId('transfer').getByTestId('transfer-edit').click();
        const dialog = page.getByTestId('transfer-dialog');
        await readyAt(dialog);
        await dialog.getByTestId('transfer-fee-toggle').check();
        await expect(dialog.getByTestId('transfer-fee-amount')).toBeVisible();
      },
    },
    {
      name: 'dialog: quick update',
      open: async (page) => {
        await page.goto('/dashboard');
        await page.getByTestId('quick-update-open').click();
        await readyAt(page.getByRole('dialog'));
        await expect(page.getByTestId('quick-update-save')).toBeVisible();
      },
    },
    {
      name: 'dialog: quick update, from the Monthly issue',
      open: async (page) => {
        await monthly(page, '2026-10', 'In progress');
        await page.getByTestId('issue-group-mtd_no_common_date').getByTestId('quick-update-open').click();
        await readyAt(page.getByRole('dialog'));
      },
    },
    {
      name: 'menu: user menu',
      open: async (page) => {
        await page.goto('/dashboard');
        await readyAt(page.getByTestId('financial-net-worth'));
        await page.getByTestId('user-menu').click();
        await expect(page.getByTestId('user-menu')).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByTestId('sign-out')).toBeVisible();
      },
    },
    {
      name: 'dialog: More, the phone navigation',
      only: 'phone',
      open: async (page) => {
        await page.goto('/dashboard');
        await expect(page.getByTestId('mobile-tab-more')).toBeEnabled();
        await page.getByTestId('mobile-tab-more').click();
        await readyAt(page.getByRole('dialog', { name: 'More' }));
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */

test.describe('the accessibility audit', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'axe reads the DOM and computed styles, so one engine is enough; the phone width is a view of its own',
  );

  test('every signed-out page meets WCAG 2.2 AA and the landmark, heading and skip-link rules', async ({
    browser,
    baseURL,
  }, testInfo) => {
    if (baseURL === undefined) throw new Error('The suite has no base URL.');
    await report(testInfo, await scanAll(browser, baseURL, SIGNED_OUT));
  });

  test('every signed-in page, and every dialog they open, meets WCAG 2.2 AA and the landmark, heading and skip-link rules', async ({
    browser,
    baseURL,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(420_000);
    if (baseURL === undefined) throw new Error('The suite has no base URL.');
    await page.setExtraHTTPHeaders({ 'x-vaultide-test-clock': OCTOBER_6 });

    const ids = await test.step('the person’s records', () => furnish(page, request));
    const person = await page.context().storageState();

    const newcomer = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-vaultide-test-clock': OCTOBER_6 } });
    const arriving = await test.step('a newcomer who has confirmed and not onboarded', async () => {
      await signUpAndVerify(await newcomer.newPage(), newcomer.request, uniqueEmail('e2e-accessibility-new'), 'Newcomer');
      return newcomer.storageState();
    });
    await newcomer.close();

    await report(testInfo, [
      ...(await scanAll(browser, baseURL, NEWCOMER, arriving)),
      ...(await scanAll(browser, baseURL, signedIn(ids), person)),
    ]);
  });
});
