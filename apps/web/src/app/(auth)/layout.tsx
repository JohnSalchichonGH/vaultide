import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentSession } from '@/server/context';

/**
 * The authentication shell (blueprint 19: `src/app/(auth)/…`).
 *
 * A route group, so these pages live at `/sign-in`, `/sign-up`, `/verify` and
 * `/reset` rather than under a segment of their own. Deliberately minimal: no
 * navigation, nothing to click that is not part of signing in.
 *
 * Somebody who is already signed in has no business on a sign-in page, so they
 * are sent on to the app instead.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (session !== undefined) {
    redirect(session.settings.onboardingCompleted ? '/settings/profile' : '/onboarding/1');
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-10 sm:px-6">
      <header className="mb-10">
        <Link href="/" className="text-[length:var(--text-page)] font-semibold tracking-tight">
          Vaultide
        </Link>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="mt-10 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        Vaultide — personal finance, reconciled monthly.
      </footer>
    </div>
  );
}
