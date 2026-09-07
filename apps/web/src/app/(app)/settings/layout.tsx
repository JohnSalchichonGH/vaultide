import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Settings (blueprint 15.2, R14 "Settings under System").
 *
 * The five areas of 15.1: profile, security, currencies, categories and data.
 * Phase 1 fills all of them to the extent Phase 1 has anything to put in them;
 * the spending preference of 12.5 lives under Currencies, next to the other
 * choices that change how money is reported.
 */
const AREAS = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/currencies', label: 'Currencies' },
  { href: '/settings/categories', label: 'Categories & tags' },
  { href: '/settings/data', label: 'Data' },
] as const;

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[var(--color-muted-foreground)]">
          How Vaultide reads your money: what you think in, what totals are shown in, and who can
          get in.
        </p>
      </div>

      <nav aria-label="Settings sections" className="flex flex-wrap gap-2 border-b pb-3">
        {AREAS.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)]"
          >
            {area.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
