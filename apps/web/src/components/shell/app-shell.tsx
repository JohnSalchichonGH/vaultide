import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/shell/theme-toggle';

/**
 * The Vaultide application shell (blueprint 15.1, 16.2).
 *
 * Phase 0 renders the frame only: product identity, the reporting-currency
 * indicator, the theme control and a skip link. The navigation groups are shown
 * as the roadmap's sections with their phase, so the shell is honest about what
 * exists rather than linking to pages that do not.
 */

interface NavigationGroup {
  readonly label: string;
  readonly items: readonly { readonly label: string; readonly phase: number }[];
}

const NAVIGATION: readonly NavigationGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', phase: 2 },
      { label: 'Monthly', phase: 3 },
    ],
  },
  {
    label: 'Finances',
    items: [
      { label: 'Accounts', phase: 2 },
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
  { label: 'System', items: [{ label: 'Settings', phase: 1 }] },
];

export function AppShell({ children }: { children: ReactNode }) {
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
          <span className="text-[length:var(--text-page)] font-semibold tracking-tight">
            Vaultide
          </span>
          <span className="hidden text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:inline">
            Personal finance, reconciled monthly
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span
              className="tabular rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
              title="Reporting currency (selectable from Phase 1)"
            >
              EUR
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[var(--container-content)] gap-8 px-4 py-8 sm:px-6">
        <nav aria-label="Sections" className="hidden w-60 shrink-0 lg:block">
          <ul className="space-y-6">
            {NAVIGATION.map((group) => (
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
                      <span>{item.label}</span>
                      <span
                        className="tabular text-[length:var(--text-meta)] text-[var(--color-unavailable)]"
                        title={`Arrives in Phase ${String(item.phase)}`}
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

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <footer className="border-t">
        <div className="mx-auto max-w-[var(--container-content)] px-4 py-6 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:px-6">
          Vaultide · Phase 0 foundations · blueprint v2.1.2
        </div>
      </footer>
    </div>
  );
}
