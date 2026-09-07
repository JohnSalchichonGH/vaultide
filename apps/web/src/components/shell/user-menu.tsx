'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

/**
 * The user menu (blueprint 15.1 "Global shell: … user menu").
 *
 * Signing out revokes the session **row**, not merely the cookie (17.1: DB-backed
 * sessions), so it holds on this device and cannot be undone by replaying a
 * stolen token. `router.refresh()` afterwards makes the server components
 * re-render as an anonymous visitor rather than leaving a stale signed-in shell.
 */
export function UserMenu({ email, name }: { email: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="user-menu"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)]"
      >
        {name}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded-[var(--radius-surface)] border bg-[var(--color-surface)] p-2 shadow-sm"
        >
          <p className="truncate px-2 py-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            {email}
          </p>
          <Link
            role="menuitem"
            href="/settings/profile"
            className="block rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-[var(--color-surface-muted)]"
            onClick={() => {
              setOpen(false);
            }}
          >
            Settings
          </Link>
          <Link
            role="menuitem"
            href="/settings/security"
            className="block rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-[var(--color-surface-muted)]"
            onClick={() => {
              setOpen(false);
            }}
          >
            Security
          </Link>
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            data-testid="sign-out"
            className="block w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-[var(--color-surface-muted)]"
            onClick={() => {
              startTransition(async () => {
                await authClient.signOut();
                setOpen(false);
                router.push('/');
                router.refresh();
              });
            }}
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
