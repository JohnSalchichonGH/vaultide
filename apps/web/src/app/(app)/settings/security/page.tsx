import type { Metadata } from 'next';
import { requireSessionPage } from '@/server/context';
import {
  ChangePasswordForm,
  DeleteAccountForm,
  TwoFactorSettings,
} from '@/features/settings/security-forms';

export const metadata: Metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

/** Settings → Security (blueprint 15.2, 17.1, 18.3). */
export default async function SecuritySettingsPage() {
  const session = await requireSessionPage('/settings/security');

  return (
    <div className="space-y-4">
      <ChangePasswordForm />
      <TwoFactorSettings enabled={session.twoFactorEnabled} />
      <DeleteAccountForm />
    </div>
  );
}
