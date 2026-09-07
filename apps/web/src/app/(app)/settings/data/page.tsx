import Link from 'next/link';
import type { Metadata } from 'next';
import { requireSessionPage } from '@/server/context';

export const metadata: Metadata = { title: 'Data' };
export const dynamic = 'force-dynamic';

/**
 * Settings → Data (blueprint 15.2, 18.3).
 *
 * Export arrives in Phase 7, when there is something to export; deletion is
 * live now and lives under Security, next to the password that authorizes it.
 * This page says plainly what Vaultide holds and what happens to it — which is
 * most of what a data page is for.
 */
export default async function DataSettingsPage() {
  const session = await requireSessionPage('/settings/data');

  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-surface)] border p-4">
        <h2 className="text-[length:var(--text-section)] font-semibold">What Vaultide holds</h2>
        <ul className="mt-3 space-y-2 text-[length:var(--text-table)] text-[var(--color-muted-foreground)]">
          <li>
            Your email address, name and password hash, held by the authentication layer. The
            password itself is never stored.
          </li>
          <li>
            Your settings: base and reporting currency, time zone, locale and favourite currencies.
          </li>
          <li>Your categories and tags.</li>
          <li>
            From Phase 2 onward, the financial records you enter — always in their native currency,
            never converted on the way in.
          </li>
        </ul>
        <p className="mt-3 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Everything is stored in Frankfurt. Exchange rates are public reference data and belong to
          no account.
        </p>
      </section>

      <section className="rounded-[var(--radius-surface)] border p-4">
        <h2 className="text-[length:var(--text-section)] font-semibold">Export</h2>
        <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          A full export of every record — JSON and one CSV per table — arrives in Phase 7, with the
          history it is meant to carry. Today the export would contain your settings and category
          names, which this page already shows you.
        </p>
      </section>

      <section className="rounded-[var(--radius-surface)] border p-4">
        <h2 className="text-[length:var(--text-section)] font-semibold">Delete your account</h2>
        <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Deleting removes every row that belongs to <strong>{session.email}</strong> from the live
          database. It needs your password, so it lives with the other operations that do.
        </p>
        <Link className="mt-3 inline-block underline" href="/settings/security">
          Go to Security to delete your account
        </Link>
      </section>
    </div>
  );
}
