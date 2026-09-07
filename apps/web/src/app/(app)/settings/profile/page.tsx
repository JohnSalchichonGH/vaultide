import type { Metadata } from 'next';
import { requireSessionPage } from '@/server/context';
import { ProfileSettingsForm } from '@/features/settings/settings-forms';
import { SUGGESTED_LOCALES, suggestedTimeZones } from '@/lib/intl-options';

export const metadata: Metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

/** Settings → Profile (blueprint 15.2): identity, time zone and locale. */
export default async function ProfileSettingsPage() {
  const session = await requireSessionPage('/settings/profile');

  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-surface)] border p-4">
        <h2 className="text-[length:var(--text-section)] font-semibold">Your account</h2>
        <dl className="mt-3 grid gap-2 text-[length:var(--text-table)] sm:grid-cols-[8rem_1fr]">
          <dt className="text-[var(--color-muted-foreground)]">Name</dt>
          <dd>{session.name}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Email</dt>
          <dd data-testid="profile-email">{session.email}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Today, where you are</dt>
          <dd className="tabular" data-testid="profile-today">
            {session.today}
          </dd>
        </dl>
      </section>

      <ProfileSettingsForm
        settings={session.settings}
        timezones={suggestedTimeZones(session.settings.timezone)}
        locales={SUGGESTED_LOCALES}
      />
    </div>
  );
}
