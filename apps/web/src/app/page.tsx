import { redirect } from 'next/navigation';
import { PublicShell } from '@/components/shell/public-shell';
import { HomePage } from '@/features/home/home-page';
import { currentSession } from '@/server/context';

/**
 * The public homepage.
 *
 * What Vaultide is and what it can do today, for somebody who is not signed
 * in. The Phase 0 browser evidence that used to live here has a test-only
 * fixture of its own at `/test/foundations`; nothing on this page links to it.
 *
 * A signed-in visitor has no reason to be here and is sent on to the app: to
 * the dashboard once the wizard is done, otherwise into the wizard.
 */

/**
 * Rendered per request, never prerendered (blueprint 23.4): the redirect reads
 * the request's session, and the CSP nonce the proxy issues can only be
 * stamped on a response that is actually generated for that request.
 */
export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const session = await currentSession();
  if (session !== undefined) {
    redirect(session.settings.onboardingCompleted ? '/dashboard' : '/onboarding/1');
  }

  return (
    <PublicShell>
      <HomePage />
    </PublicShell>
  );
}
