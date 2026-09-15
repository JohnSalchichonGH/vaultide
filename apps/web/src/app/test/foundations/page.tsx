import { notFound } from 'next/navigation';
import { anonymousContext, areTestEndpointsEnabled } from '@vaultide/application';
import { FoundationsDemo } from '@/components/foundations-demo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormatterProbe } from './formatter-probe';

/**
 * The Phase 0 browser fixture (blueprint Phase 0 testing, 21.5). Test-only.
 *
 * The end-to-end suite's browser evidence for Phase 0 — money formatted exactly
 * by a real browser, the four-minor-unit money input, and the date input capped
 * at today — has a page of its own here, so the public landing page can change
 * without taking that evidence with it. Nothing in the product links to it.
 *
 * The gate is the one the captured mailbox and the FX fixture share,
 * `areTestEndpointsEnabled`, and it is checked before the page does anything
 * else. Wherever the test capabilities are off the page is a 404, and a Vercel
 * production deployment refuses them outright: `VERCEL_ENV=production` wins over
 * both `NODE_ENV=test` and `VAULTIDE_TEST_ENDPOINTS=enabled`.
 */

/**
 * Rendered per request, never prerendered: the gate must be read by the server
 * answering the request, not settled once at build time — and, as on the
 * landing page, `today` and the CSP nonce belong to the request.
 */
export const dynamic = 'force-dynamic';

export default function FoundationsFixturePage() {
  if (!areTestEndpointsEnabled()) notFound();

  // The date input's cap, computed the way the landing page computes it: today
  // once per request, in a stated timezone.
  const { today } = anonymousContext({
    timezone: 'Europe/Madrid',
    locale: 'en-GB',
    reportingCurrency: 'EUR',
  });

  return (
    <main className="mx-auto max-w-[var(--container-content)] space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-[length:var(--text-headline)] font-semibold tracking-tight">
          Phase 0 browser fixture
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
          Test-only: what the end-to-end suite checks in a real browser. Not part of the product.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exact money formatting</CardTitle>
          <CardDescription>
            The formatter self-test (blueprint 7.1.1) runs in this browser once React has hydrated.
            The server sends only its pending state, never a formatted value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormatterProbe />
        </CardContent>
      </Card>

      <FoundationsDemo today={today} />
    </main>
  );
}
