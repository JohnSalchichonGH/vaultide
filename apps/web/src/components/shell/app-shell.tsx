import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SessionContext } from '@vaultide/application';
import { MobileNavigation } from '@/components/shell/mobile-navigation';
import {
  phaseNote,
  resolveNavigation,
  type ResolvedNavigationGroup,
} from '@/components/shell/navigation';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { ReportingCurrencySelector } from '@/components/shell/reporting-currency-selector';
import { UserMenu } from '@/components/shell/user-menu';
import { cn } from '@/lib/utils';

/**
 * The Vaultide application shell (blueprint 15.1, 16.2), for a signed-in
 * visitor: every page under `(app)` renders inside it, behind
 * `requireSessionPage`. A visitor who is not signed in sees the public shell
 * on the homepage instead, so this one always has a session.
 *
 * The navigation is the roadmap's own structure (`navigation.ts`), resolved
 * once per request and rendered twice: as the sidebar from the desktop
 * breakpoint up, and below it as 15.1's bottom tabs with More. It is honest
 * about what exists: a section that has not been built yet is rendered as text
 * with the phase that brings it, not as a link to a page that would 404. The
 * header carries the reporting-currency selector and the user menu.
 */

export interface AppShellProps {
  readonly children: ReactNode;
  /** The signed-in visitor: the header and the Monthly link are theirs. */
  readonly session: SessionContext;
  /** Supported currency codes for the selector, from the catalogue (10.4). */
  readonly currencies?: readonly { code: string; name: string }[];
  /** Hide the sidebar on pages that are a single flow, such as onboarding. */
  readonly showNavigation?: boolean;
}

/** The sidebar, from the desktop breakpoint up. */
function DesktopNavigation({ groups }: { readonly groups: readonly ResolvedNavigationGroup[] }) {
  return (
    <nav aria-label="Sections" data-testid="desktop-navigation" className="hidden w-60 shrink-0 lg:block">
      <ul className="space-y-6">
        {groups.map((group) => (
          <li key={group.label}>
            <p className="mb-2 text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
              {group.label}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center justify-between rounded-[var(--radius-control)] px-2 py-1.5 text-[var(--color-muted-foreground)]"
                >
                  {item.href === null ? (
                    <span>{item.label}</span>
                  ) : (
                    <Link className="underline" href={item.href}>
                      {item.label}
                    </Link>
                  )}
                  <span
                    className="tabular text-[length:var(--text-meta)] text-[var(--color-unavailable)]"
                    title={phaseNote(item)}
                  >
                    P{item.phase}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppShell({
  children,
  session,
  currencies = [],
  showNavigation = true,
}: AppShellProps) {
  // Monthly's address is the current month from the session's own today —
  // never the browser's clock — for both surfaces alike.
  const navigation = resolveNavigation(session.today);

  return (
    // Below the desktop breakpoint the bottom tabs are fixed over the page, so
    // the page keeps their height (and the device's safe area) free beneath the
    // footer.
    <div
      className={cn(
        'min-h-dvh',
        showNavigation && 'pb-[calc(4rem_+_env(safe-area-inset-bottom))] lg:pb-0',
      )}
      data-mobile-navigation={showNavigation ? '' : undefined}
    >
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
            <ReportingCurrencySelector
              value={session.settings.reportingCurrency}
              version={session.settings.version}
              currencies={currencies}
            />
            <UserMenu email={session.email} name={session.name} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {showNavigation ? <MobileNavigation groups={navigation} /> : null}

      <div className="mx-auto flex max-w-[var(--container-content)] gap-8 px-4 py-8 sm:px-6">
        {showNavigation ? <DesktopNavigation groups={navigation} /> : null}

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <footer className="border-t">
        <div className="mx-auto max-w-[var(--container-content)] px-4 py-6 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:px-6">
          Vaultide · Phase 3 in progress · blueprint v2.1.17
        </div>
      </footer>
    </div>
  );
}
