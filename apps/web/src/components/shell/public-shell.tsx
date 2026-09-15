import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { FOOTER_LINE } from '@/features/home/content';

/**
 * The public shell (blueprint 16.1, 16.6): what a visitor who is not signed in
 * sees around the homepage.
 *
 * Deliberately small. A wordmark, the way in, the theme control, and nothing
 * from the signed-in product — no reporting-currency selector, no navigation,
 * no build or phase markers. The skip link comes first in the document, and
 * the content lands in `main#main`, the same target the signed-in shell uses.
 */
export function PublicShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:border focus:bg-[var(--color-surface)] focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-[var(--container-content)] items-center justify-between px-4 sm:px-6">
          <Link href="/" className="text-[length:var(--text-page)] font-semibold tracking-tight">
            Vaultide
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/sign-in"
              className="rounded-[var(--radius-control)] border px-3 py-1.5 font-medium hover:border-[var(--color-border-strong)]"
            >
              Sign in
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-[var(--container-content)] px-4 py-8 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:px-6">
          {FOOTER_LINE}
        </div>
      </footer>
    </div>
  );
}
