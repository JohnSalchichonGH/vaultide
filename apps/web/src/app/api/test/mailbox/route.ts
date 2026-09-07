import { areTestEndpointsEnabled, capturingMailer } from '@vaultide/application';

/**
 * The captured mailbox, for the end-to-end suite (blueprint 21.5: "Playwright,
 * seeded Postgres, **capturing mailer**, controlled clock").
 *
 * The E2E flow needs to click the verification link a real user would receive.
 * Rather than send mail from a test run, the capturing mailer keeps messages in
 * memory and this route reads them back.
 *
 * It shares the `TEST_CLOCK` gate exactly (`areTestEndpointsEnabled`): Vitest's
 * `NODE_ENV=test`, or an explicit `VAULTIDE_TEST_ENDPOINTS=enabled` that a
 * production deployment can never turn on. Anything else gets a 404, whatever
 * is requested — which matters here, because these messages carry single-use
 * verification and reset tokens.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NOT_FOUND = new Response('Not found', {
  status: 404,
  headers: { 'Cache-Control': 'no-store' },
});

export function GET(request: Request): Response {
  if (!areTestEndpointsEnabled()) return NOT_FOUND.clone();

  const to = new URL(request.url).searchParams.get('to');
  const tag = new URL(request.url).searchParams.get('tag');
  const mailer = capturingMailer();

  const messages = mailer.messages.filter(
    (message) =>
      (to === null || message.to.toLowerCase() === to.toLowerCase()) &&
      (tag === null || message.tag === tag),
  );

  return Response.json(
    { messages: messages.map(({ to: recipient, subject, text, tag: kind }) => ({ to: recipient, subject, text, tag: kind })) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Empty the mailbox between scenarios. */
export function DELETE(): Response {
  if (!areTestEndpointsEnabled()) return NOT_FOUND.clone();
  capturingMailer().clear();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
