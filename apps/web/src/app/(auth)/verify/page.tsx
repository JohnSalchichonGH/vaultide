import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthCard, Notice } from '@/features/auth/forms';

export const metadata: Metadata = { title: 'Confirm your email' };
export const dynamic = 'force-dynamic';

/**
 * Where the verification link lands (blueprint 15.1 `/auth/verify`, 17.1).
 *
 * The verification itself happens at `/api/auth/verify-email`, which consumes
 * the single-use token, marks the address confirmed and — because 17.1 sets
 * `autoSignInAfterVerification` — issues a session before redirecting here.
 * This page therefore only ever reports an outcome; it never holds a token and
 * never verifies anything itself.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params['error'] === 'string' ? params['error'] : undefined;

  if (error !== undefined) {
    return (
      <AuthCard
        title="That link did not work"
        description="A confirmation link is valid for one hour and can be used once. This one has expired, has already been used, or was not the latest one sent."
        footer={
          <>
            Signing in again sends a fresh confirmation email.{' '}
            <Link className="underline" href="/sign-in">
              Sign in
            </Link>
          </>
        }
      >
        <Notice tone="error">Confirmation failed: the link is no longer valid.</Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Email confirmed"
      description="Your address is confirmed and you are signed in. Next: tell Vaultide where you live and what currency you think in."
      footer={
        <Link className="underline" href="/onboarding/1">
          Continue to setup
        </Link>
      }
    >
      <Notice tone="success">Your email address has been confirmed.</Notice>
    </AuthCard>
  );
}
