import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';
import type { SessionContext } from '@vaultide/application';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { ReportingCurrencySelector } from '@/components/shell/reporting-currency-selector';
import { UserMenu } from '@/components/shell/user-menu';

/**
 * The Vaultide application shell (blueprint 15.1, 16.2).
 *
 * The navigation is the roadmap's own structure, and it is honest about what
 * exists: a section that has not been built yet is rendered as text with the
 * phase that brings it, not as a link to a page that would 404. Two things in
 * the header become real in Phase 1 — the reporting-currency selector and the
 * user menu — and both appear only for a signed-in visitor.
 */

interface NavigationItem {
  readonly label: string;
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
      { label: 'Dashboard', href: '/dashboard', phase: 2 },
      { label: 'Monthly', currentMonth: true, phase: 3 },
    ],
  },
  {
    label: 'Finances',
    items: [
      { label: 'Accounts', href: '/accounts', phase: 2 },
      { label: 'Income', phase: 3 },
      { label: 'Spending', phase: 3 },
      { label: 'Investments', phase: 4 },
      { label: 'Real Estate', phase: 6 },
      { label: 'Debts', phase: 5 },
    ],
  },
  {
    label: 'Planning',
    items: [
      { label: 'Analytics', phase: 8 },
      { label: 'Projections', phase: 10 },
      { label: 'Goals', phase: 9 },
    ],
  },
  { label: 'System', items: [{ label: 'Settings', href: '/settings/profile', phase: 1 }] },
];

export interface AppShellProps {
  readonly children: ReactNode;
  /** Present when somebody is signed in; the header changes accordingly. */
  readonly session?: SessionContext | undefined;
  /** Supported currency codes for the selector, from the catalogue (10.4). */
  readonly currencies?: readonly { code: string; name: string }[];
  /** Hide the sidebar on pages that are a single flow, such as onboarding. */
  readonly showNavigation?: boolean;
}

/**
 * Where an item points for this visitor: its fixed page, or — for Monthly — the
 * current month from the session's own today (never the browser's clock).
 */
function hrefOf(item: NavigationItem, session: SessionContext | undefined): Route | undefined {
  if (item.currentMonth === true) {
    return session === undefined ? undefined : (`/monthly/${session.today.slice(0, 7)}` as Route);
  }
  return item.href;
}

export function AppShell({
  children,
  session,
  currencies = [],
  showNavigation = true,
}: AppShellProps) {
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:border focus:bg-[var(--color-surface)] focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b bg-[var(--color-surface)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[var(--container-content)] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="text-[length:var(--text-page)] font-semibold tracking-tight">
            Vaultide
          </Link>
          <span className="hidden text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:inline">
            Personal finance, reconciled monthly
          </span>
          <div className="ml-auto flex items-center gap-3">
            {session === undefined ? (
              <>
                <Link
                  href="/sign-in"
                  className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)]"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-3 py-1.5 text-[length:var(--text-meta)] text-[var(--color-accent-foreground)]"
                >
                  Create account
                </Link>
              </>
            ) : (
              <>
                <ReportingCurrencySelector
                  value={session.settings.reportingCurrency}
                  version={session.settings.version}
                  currencies={currencies}
                />
                <UserMenu email={session.email} name={session.name} />
              </>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[var(--container-content)] gap-8 px-4 py-8 sm:px-6">
        {showNavigation ? (
          <nav aria-label="Sections" className="hidden w-60 shrink-0 lg:block">
            <ul className="space-y-6">
              {NAVIGATION.map((group) => (
                <li key={group.label}>
                  <p className="mb-2 text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    {group.label}
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((item) => {
                      const href = hrefOf(item, session);
                      return (
                        <li
                          key={item.label}
                          className="flex items-center justify-between rounded-[var(--radius-control)] px-2 py-1.5 text-[var(--color-muted-foreground)]"
                        >
                          {href === undefined ? (
                            <span>{item.label}</span>
                          ) : (
                            <Link className="underline" href={href}>
                              {item.label}
                            </Link>
                          )}
                          <span
                            className="tabular text-[length:var(--text-meta)] text-[var(--color-unavailable)]"
                            title={
                              item.href === undefined && item.currentMonth !== true
                                ? `Arrives in Phase ${String(item.phase)}`
                                : `Available since Phase ${String(item.phase)}`
                            }
                          >
                            P{item.phase}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <footer className="border-t">
        <div className="mx-auto max-w-[var(--container-content)] px-4 py-6 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:px-6">
          Vaultide · Phase 3 in progress · blueprint v2.1.15
        </div>
      </footer>
    </div>
  );
}
