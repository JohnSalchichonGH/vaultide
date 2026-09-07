import { areTestEndpointsEnabled, getServices } from '@vaultide/application';

/**
 * Which rate publisher this server is wired to, for the end-to-end suite
 * (blueprint 21.5).
 *
 * The browser matrix must not depend on a free public API being fast: three
 * projects in parallel, each picking a currency, is exactly the concurrent
 * long-range request pattern that makes Frankfurter stall. So the E2E server
 * runs against the deterministic fixture, and this route is how the suite
 * *proves* it rather than assuming it — an assertion that the substitution is
 * really in place, not a claim in a comment.
 *
 * It returns one identifier and nothing else, behind the same gate as the
 * mailbox (`areTestEndpointsEnabled`), so a production deployment answers 404.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  if (!areTestEndpointsEnabled()) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  return Response.json(
    { provider: getServices().fxProvider.id },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
