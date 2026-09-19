import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: vi.fn(() => '/dashboard'),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/server/actions/settings', () => ({ setReportingCurrencyAction: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: vi.fn() } }));

const { usePathname } = await import('next/navigation');
const { AppShell } = await import('@/components/shell/app-shell');
const {
  MOBILE_TAB_KEYS,
  activeMobileTab,
  mobileTabsOf,
  moreGroupsOf,
  phaseNote,
  resolveNavigation,
  sectionOwning,
} = await import('@/components/shell/navigation');

type Session = Parameters<typeof AppShell>[0]['session'];

const TODAY = '2026-10-01';

function sessionOn(today: string): Session {
  return {
    today,
    email: 'person@example.test',
    name: 'Person',
    settings: { reportingCurrency: 'EUR', version: 1 },
  } as unknown as Session;
}

/** The shell's markup for a page at `pathname`, with the entities React writes undone. */
function shellAt(pathname: string, options: { showNavigation?: boolean; today?: string } = {}): string {
  vi.mocked(usePathname).mockReturnValue(pathname);
  return renderToStaticMarkup(
    createElement(AppShell, {
      session: sessionOn(options.today ?? TODAY),
      children: createElement('p', null, 'page'),
      ...(options.showNavigation === undefined ? {} : { showNavigation: options.showNavigation }),
    }),
  ).replaceAll('&amp;', '&');
}

function segment(markup: string, pattern: RegExp): string {
  const match = pattern.exec(markup);
  if (match === null) throw new Error(`No match for ${String(pattern)}`);
  return match[0];
}

const desktopOf = (markup: string) => segment(markup, /<nav[^>]*data-testid="desktop-navigation"[\s\S]*?<\/nav>/u);
const tabsOf = (markup: string) => segment(markup, /<nav[^>]*data-testid="mobile-navigation"[\s\S]*?<\/nav>/u);
const moreOf = (markup: string) => segment(markup, /<dialog[\s\S]*?<\/dialog>/u);
const hrefsIn = (markup: string): string[] =>
  [...markup.matchAll(/href="([^"]*)"/gu)].map((match) => match[1] as string);

/**
 * The element carrying a test id, from its opening tag to the end of the list
 * item around it — every tab and every More entry is alone in its `<li>`.
 */
function itemWith(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error(`No element with the test id ${testId}`);
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('</li>', at));
}

const tabElement = (markup: string, key: string): string => itemWith(tabsOf(markup), `mobile-tab-${key}`);

/** Every section that exists today, and nothing else. */
const LIVE = {
  dashboard: '/dashboard',
  monthly: '/monthly/2026-10',
  accounts: '/accounts',
  spending: '/expenses',
  settings: '/settings/profile',
};
const NOT_BUILT = ['income', 'investments', 'real-estate', 'debts', 'analytics', 'projections', 'goals'];

/**
 * The signed-in shell's navigation (blueprint 15.1).
 *
 * One table decides every section's route and phase; the desktop sidebar, the
 * mobile tabs and More render it. These tests pin the table's resolution, the
 * route ownership that decides the current tab, and the shell's markup —
 * that the two surfaces offer exactly the same destinations, that nothing
 * unbuilt is a link, and that `showNavigation={false}` leaves neither.
 */
describe('the navigation table', () => {
  it('resolves exactly the built sections to links, and Monthly to the session’s current month', () => {
    const items = resolveNavigation(TODAY).flatMap((group) => group.items);
    const live = Object.fromEntries(items.filter((item) => item.href !== null).map((item) => [item.key, item.href]));
    expect(live).toEqual(LIVE);
    expect(items.filter((item) => item.href === null).map((item) => item.key).sort()).toEqual([...NOT_BUILT].sort());
  });

  it('takes the month from the today it is given, never from the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-06-15T12:00:00Z'));
    try {
      const monthly = resolveNavigation('2031-02-28')
        .flatMap((group) => group.items)
        .find((item) => item.key === 'monthly');
      expect(monthly?.href).toBe('/monthly/2031-02');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the phase of every section, and says which way it points', () => {
    const items = resolveNavigation(TODAY).flatMap((group) => group.items);
    const investments = items.find((item) => item.key === 'investments');
    const dashboard = items.find((item) => item.key === 'dashboard');
    expect(investments && phaseNote(investments)).toBe('Arrives in Phase 4');
    expect(dashboard && phaseNote(dashboard)).toBe('Available since Phase 2');
  });

  it('gives the four tabs in the blueprint’s order, from the same entries', () => {
    const groups = resolveNavigation(TODAY);
    const tabs = mobileTabsOf(groups);
    expect(tabs.map((tab) => tab.key)).toEqual([...MOBILE_TAB_KEYS]);
    expect(tabs.map((tab) => tab.label)).toEqual(['Dashboard', 'Monthly', 'Investments', 'Analytics']);
    expect(tabs.map((tab) => [tab.href, tab.phase])).toEqual([
      ['/dashboard', 2],
      ['/monthly/2026-10', 3],
      [null, 4],
      [null, 8],
    ]);
  });

  it('puts every other section in More, grouped as the sidebar groups it', () => {
    const more = moreGroupsOf(resolveNavigation(TODAY));
    expect(more.map((group) => [group.label, group.items.map((item) => item.key)])).toEqual([
      ['Finances', ['accounts', 'income', 'spending', 'real-estate', 'debts']],
      ['Planning', ['projections', 'goals']],
      ['System', ['settings']],
    ]);
  });
});

describe('which section a page belongs to', () => {
  const groups = resolveNavigation(TODAY);

  it.each([
    ['/dashboard', 'dashboard'],
    ['/monthly/2026-09', 'monthly'],
    ['/monthly/2026-09/history', 'monthly'],
    ['/accounts', 'more'],
    ['/accounts/5f1c', 'more'],
    ['/settings/profile', 'more'],
    ['/settings/security', 'more'],
    ['/expenses', 'more'],
  ] as const)('%s belongs to the %s tab', (pathname, tab) => {
    expect(activeMobileTab(pathname, groups)).toBe(tab);
  });

  it('makes Spending a live section of More, owning /expenses and its months', () => {
    expect(sectionOwning('/expenses', groups)).toMatchObject({ key: 'spending', href: '/expenses' });
    // A month in the query string is still the same page and the same section.
    expect(sectionOwning('/expenses', groups)?.section).toBe('/expenses');
    expect(activeMobileTab('/expensesx', groups)).toBeNull();
  });

  it.each([
    ['/investments/abc', 'investments'],
    ['/analytics/cash-flow', 'analytics'],
    ['/income/sources/abc', 'more'],
    ['/real-estate', 'more'],
    ['/debts/abc', 'more'],
    ['/projections/compare', 'more'],
    ['/goals', 'more'],
  ] as const)('owns the future %s under %s, without making it reachable', (pathname, tab) => {
    expect(activeMobileTab(pathname, groups)).toBe(tab);
    expect(sectionOwning(pathname, groups)?.href).toBeNull();
  });

  it('claims a whole segment, and nothing outside every section', () => {
    expect(activeMobileTab('/accountsx', groups)).toBeNull();
    expect(activeMobileTab('/dashboards', groups)).toBeNull();
    expect(activeMobileTab('/onboarding/1', groups)).toBeNull();
    expect(activeMobileTab('/', groups)).toBeNull();
  });
});

describe('the shell', () => {
  it('offers the same destinations on the sidebar as on the tabs and More together', () => {
    const markup = shellAt('/dashboard');
    const desktop = hrefsIn(desktopOf(markup)).sort();
    const mobile = [...hrefsIn(tabsOf(markup)), ...hrefsIn(moreOf(markup))].sort();
    expect(desktop).toEqual(Object.values(LIVE).sort());
    expect(mobile).toEqual(desktop);
  });

  it('links nowhere a section has not been built', () => {
    const markup = shellAt('/dashboard');
    for (const route of ['/income', '/investments', '/real-estate', '/debts', '/analytics', '/projections', '/goals']) {
      expect(markup).not.toContain(`href="${route}`);
    }
  });

  it('shows the unbuilt tabs as text with the phase that brings them', () => {
    const markup = shellAt('/dashboard');
    for (const [key, phase] of [['investments', 4], ['analytics', 8]] as const) {
      const tab = tabElement(markup, key);
      expect(tab.startsWith('<span')).toBe(true);
      expect(tab).toContain(`Phase ${String(phase)}`);
      expect(tab).toContain(`arrives in Phase ${String(phase)}`);
    }
    expect(tabElement(markup, 'dashboard')).toMatch(/^<a href="\/dashboard"/u);
    expect(tabElement(markup, 'monthly')).toMatch(/^<a href="\/monthly\/2026-10"/u);
  });

  it('lists the unbuilt sections in More as text with their phase', () => {
    const more = moreOf(shellAt('/dashboard'));
    for (const [key, label, phase] of [
      ['income', 'Income', 3],
      ['real-estate', 'Real Estate', 6],
      ['debts', 'Debts', 5],
      ['projections', 'Projections', 10],
      ['goals', 'Goals', 9],
    ] as const) {
      const item = itemWith(more, `more-item-${key}`);
      expect(item.startsWith('<span')).toBe(true);
      expect(item).toContain(label);
      expect(item).toContain(`Phase ${String(phase)}`);
      expect(item).toContain(`arrives in Phase ${String(phase)}`);
    }
    expect(itemWith(more, 'more-item-accounts')).toMatch(/^<a href="\/accounts"/u);
    expect(itemWith(more, 'more-item-spending')).toMatch(/^<a href="\/expenses"/u);
    expect(itemWith(more, 'more-item-settings')).toMatch(/^<a href="\/settings\/profile"/u);
  });

  it('marks the current tab, and More for a section inside it', () => {
    const dashboard = shellAt('/dashboard');
    expect(tabElement(dashboard, 'dashboard')).toContain('aria-current="page"');
    expect(tabElement(dashboard, 'monthly')).not.toContain('aria-current');
    expect(tabElement(dashboard, 'more')).not.toContain('aria-current');

    const monthly = shellAt('/monthly/2026-10');
    expect(tabElement(monthly, 'monthly')).toContain('aria-current="page"');
    expect(tabElement(monthly, 'dashboard')).not.toContain('aria-current');

    for (const [pathname, key] of [
      ['/accounts', 'accounts'],
      ['/settings/security', 'settings'],
      ['/expenses', 'spending'],
    ] as const) {
      const markup = shellAt(pathname);
      expect(tabElement(markup, 'more')).toContain('aria-current="true"');
      expect(tabElement(markup, 'dashboard')).not.toContain('aria-current');
      const more = moreOf(markup);
      expect(itemWith(more, `more-item-${key}`)).toContain('aria-current="page"');
      expect([...more.matchAll(/aria-current="page"/gu)]).toHaveLength(1);
    }
  });

  it('names More as a control for a dialog', () => {
    const markup = shellAt('/dashboard');
    const more = tabElement(markup, 'more');
    expect(more).toMatch(/^<button\b/u);
    expect(more).toContain('aria-haspopup="dialog"');
    expect(more).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/u.exec(more)?.[1];
    expect(controls).toBeDefined();
    expect(markup).toContain(`<dialog id="${controls ?? ''}"`);
  });

  it('renders neither surface when the page suppresses navigation', () => {
    const markup = shellAt('/onboarding/1', { showNavigation: false });
    expect(markup).not.toContain('<nav');
    expect(markup).not.toContain('<dialog');
    expect(markup).not.toContain('data-mobile-navigation');
    expect(markup).not.toContain('safe-area-inset-bottom');
    expect(markup).toContain('<main id="main"');
  });

  it('marks the shell as carrying the tabs only while they are shown', () => {
    // What reserves their height beneath the page, and keeps a focused field
    // clear of them (globals.css); the layout itself is asserted in a browser.
    expect(shellAt('/dashboard')).toContain('data-mobile-navigation=""');
  });
});
