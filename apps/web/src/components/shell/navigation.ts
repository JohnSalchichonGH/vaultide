import type { Route } from 'next';

/**
 * The signed-in shell's navigation, stated once (blueprint 15.1).
 *
 * The desktop sidebar, the mobile bottom tabs and the mobile "More" sheet all
 * render from this table, so whether a section exists, where it lives and which
 * phase brings it is decided here and nowhere else. Making a section live is one
 * edit: give its entry an `href`.
 *
 * The table is honest about what exists: a section that has not been built yet
 * has no `href`, and every surface renders it as text with the phase that brings
 * it — never as a link to a page that would 404.
 */

export type NavigationKey =
  | 'dashboard'
  | 'monthly'
  | 'accounts'
  | 'income'
  | 'spending'
  | 'investments'
  | 'real-estate'
  | 'debts'
  | 'analytics'
  | 'projections'
  | 'goals'
  | 'settings';

interface NavigationItem {
  readonly key: NavigationKey;
  readonly label: string;
  /**
   * The route prefix the section owns (15.1's route list), whether or not it is
   * built yet: it decides which section a page belongs to, never whether the
   * section is reachable.
   */
  readonly section: string;
  /** Absent while the section has not been built yet. */
  readonly href?: Route;
  /**
   * The item opens the signed-in user's current month. Its address depends on
   * today in the user's timezone, which only the server's session knows, so it
   * is filled in per request rather than written into this table.
   */
  readonly currentMonth?: true;
  readonly phase: number;
}

interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

const NAVIGATION: readonly NavigationGroup[] = [
  {
    label: 'Overview',
    items: [
      { key: 'dashboard', label: 'Dashboard', section: '/dashboard', href: '/dashboard', phase: 2 },
      { key: 'monthly', label: 'Monthly', section: '/monthly', currentMonth: true, phase: 3 },
    ],
  },
  {
    label: 'Finances',
    items: [
      { key: 'accounts', label: 'Accounts', section: '/accounts', href: '/accounts', phase: 2 },
      { key: 'income', label: 'Income', section: '/income', phase: 3 },
      { key: 'spending', label: 'Spending', section: '/expenses', href: '/expenses', phase: 3 },
      { key: 'investments', label: 'Investments', section: '/investments', phase: 4 },
      { key: 'real-estate', label: 'Real Estate', section: '/real-estate', phase: 6 },
      { key: 'debts', label: 'Debts', section: '/debts', phase: 5 },
    ],
  },
  {
    label: 'Planning',
    items: [
      { key: 'analytics', label: 'Analytics', section: '/analytics', phase: 8 },
      { key: 'projections', label: 'Projections', section: '/projections', phase: 10 },
      { key: 'goals', label: 'Goals', section: '/goals', phase: 9 },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'settings', label: 'Settings', section: '/settings', href: '/settings/profile', phase: 1 },
    ],
  },
];

/** One section as a surface renders it: a link when `href` is set, text when it is not. */
export interface ResolvedNavigationItem {
  readonly key: NavigationKey;
  readonly label: string;
  readonly section: string;
  readonly href: Route | null;
  readonly phase: number;
}

export interface ResolvedNavigationGroup {
  readonly label: string;
  readonly items: readonly ResolvedNavigationItem[];
}

/** Where an item points for this visitor: its fixed page, the current month, or nowhere yet. */
function hrefOf(item: NavigationItem, today: string): Route | null {
  if (item.currentMonth === true) return `/monthly/${today.slice(0, 7)}` as Route;
  return item.href ?? null;
}

/**
 * The navigation for one request, with Monthly pointing at the current month
 * from the session's own today (never the browser's clock).
 */
export function resolveNavigation(today: string): ResolvedNavigationGroup[] {
  return NAVIGATION.map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      key: item.key,
      label: item.label,
      section: item.section,
      href: hrefOf(item, today),
      phase: item.phase,
    })),
  }));
}

/** The phase note every surface shows beside an item. */
export function phaseNote(item: Pick<ResolvedNavigationItem, 'href' | 'phase'>): string {
  return item.href === null
    ? `Arrives in Phase ${String(item.phase)}`
    : `Available since Phase ${String(item.phase)}`;
}

/* -------------------------------------------------------------------------- */
/* Mobile: four tabs and More (15.1)                                          */
/* -------------------------------------------------------------------------- */

/** "Mobile: bottom tabs Dashboard · Monthly · Investments · Analytics · More." */
export const MOBILE_TAB_KEYS = ['dashboard', 'monthly', 'investments', 'analytics'] as const;

export type MobileTabKey = (typeof MOBILE_TAB_KEYS)[number] | 'more';

const isTabKey = (key: NavigationKey): key is (typeof MOBILE_TAB_KEYS)[number] =>
  (MOBILE_TAB_KEYS as readonly NavigationKey[]).includes(key);

const itemsOf = (groups: readonly ResolvedNavigationGroup[]): ResolvedNavigationItem[] =>
  groups.flatMap((group) => group.items);

/** The four tab sections, in the blueprint's order. */
export function mobileTabsOf(groups: readonly ResolvedNavigationGroup[]): ResolvedNavigationItem[] {
  const items = itemsOf(groups);
  return MOBILE_TAB_KEYS.map((key) => {
    const item = items.find((candidate) => candidate.key === key);
    /* v8 ignore next -- every tab key is an entry of the table above. */
    if (item === undefined) throw new Error(`No navigation entry for the ${key} tab.`);
    return item;
  });
}

/** Everything the tabs do not already show, grouped as the sidebar groups it. */
export function moreGroupsOf(groups: readonly ResolvedNavigationGroup[]): ResolvedNavigationGroup[] {
  return groups
    .map((group) => ({ label: group.label, items: group.items.filter((item) => !isTabKey(item.key)) }))
    .filter((group) => group.items.length > 0);
}

/**
 * The section a page belongs to, by route prefix: `/accounts` owns `/accounts`
 * and `/accounts/…`, but not `/accountsx`.
 */
export function sectionOwning(
  pathname: string,
  groups: readonly ResolvedNavigationGroup[],
): ResolvedNavigationItem | undefined {
  return itemsOf(groups).find(
    (item) => pathname === item.section || pathname.startsWith(`${item.section}/`),
  );
}

/**
 * Which bottom tab a page belongs to: its own tab, More for every other
 * section, and none for a page outside every section (onboarding, say).
 */
export function activeMobileTab(
  pathname: string,
  groups: readonly ResolvedNavigationGroup[],
): MobileTabKey | null {
  const owner = sectionOwning(pathname, groups);
  if (owner === undefined) return null;
  return isTabKey(owner.key) ? owner.key : 'more';
}
