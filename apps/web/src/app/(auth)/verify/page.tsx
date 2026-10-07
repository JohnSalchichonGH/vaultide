import type { Metadata } from 'next';
import { ResendVerificationForm } from '@/features/auth/forms';

export const metadata: Metadata = { title: 'Get a new confirmation link' };
export const dynamic = 'force-dynamic';

/**
 * Where every verification link lands, and where a new one is asked for
 * (blueprint 15.1 `/auth/verify`, 17.1, 17.3; ADR 0002 decision 21).
 *
 * The verification itself happens at `/api/auth/verify-email`, which checks the
 * token and redirects here: the link's `callbackURL` is always this page. A
 * valid link marks the address confirmed and — because 17.1 sets
 * `autoSignInAfterVerification` — issues a session first, so its visitor
 * arrives signed in and the `(auth)` layout sends them on before this page
 * renders. A link that did not work arrives with `?error=`. This page never
 * holds a token and never verifies anything itself.
 *
 * So it only ever renders for somebody who is not signed in, and what it offers
 * them is a new link: with the explanation when theirs did not work, and on its
 * own when they came to ask for one.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <ResendVerificationForm linkFailed={typeof params['error'] === 'string'} />;
}
