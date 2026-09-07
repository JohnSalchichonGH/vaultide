import type { Metadata } from 'next';
import { ChooseNewPasswordForm, RequestResetForm } from '@/features/auth/forms';

export const metadata: Metadata = { title: 'Reset your password' };
export const dynamic = 'force-dynamic';

/**
 * Both halves of the reset flow (blueprint 15.1 `/auth/reset`, 17.1).
 *
 * Without a token it asks for an address and answers identically whether or not
 * that address has an account (17.3). With one, it takes the new password.
 *
 * Better Auth redirects here with `?token=` after checking the token exists; it
 * is consumed by `/api/auth/reset-password`, which is where its single use is
 * enforced. Nothing on this page trusts the token for anything else.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params['token'] === 'string' ? params['token'] : undefined;

  return token === undefined || token === '' ? (
    <RequestResetForm />
  ) : (
    <ChooseNewPasswordForm token={token} />
  );
}
