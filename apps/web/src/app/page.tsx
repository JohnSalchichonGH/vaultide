import Link from 'next/link';
import { redirect } from 'next/navigation';
import { anonymousContext } from '@vaultide/application';
import { AppShell } from '@/components/shell/app-shell';
import { currentSession } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyText } from '@/components/finance/money-text';
import { FoundationsDemo } from '@/components/foundations-demo';
import { runFormatterSelfTest, SELF_TEST_AMOUNT } from '@/lib/format';

/**
 * The public landing page.
 *
 * Phase 0 made this the "sign-in-less landing page" and used it to prove, in
 * the running product, the two things Phase 0 had to establish: money formats
 * exactly from decimal strings in every locale, and a four-minor-unit currency
 * round-trips without loss. That evidence stays — it is what the Phase 0
 * acceptance record points at — and Phase 1 adds the way in.
 *
 * A signed-in visitor has no reason to be here and is sent on to the app.
 */

/**
 * Rendered per request, never prerendered (blueprint 23.4): the page computes
 * `today` in the user's timezone, and the CSP nonce the proxy issues can only
 * be stamped on a response that is actually generated for that request.
 */
export const dynamic = 'force-dynamic';

const LOCALES = [
  { locale: 'en-US', currency: 'USD', minorUnits: 2 },
  { locale: 'de-DE', currency: 'EUR', minorUnits: 2 },
  { locale: 'ja-JP', currency: 'JPY', minorUnits: 0 },
  { locale: 'es-CL', currency: 'CLF', minorUnits: 4 },
] as const;

export default async function LandingPage() {
  const session = await currentSession();
  if (session !== undefined) {
    // Phase 2 gives the application a home page, so a signed-in visitor who
    // has been through the wizard lands there rather than in Settings.
    redirect(session.settings.onboardingCompleted ? '/dashboard' : '/onboarding/1');
  }

  const selfTest = runFormatterSelfTest(LOCALES);
  const allExact = selfTest.every((row) => row.exact);
  // The server computes today once per request, in the stated timezone; Phase 1
  // reads the timezone from the signed-in user's settings instead of this default.
  const { today } = anonymousContext({
    timezone: 'Europe/Madrid',
    locale: 'en-GB',
    reportingCurrency: 'EUR',
  });

  return (
    <AppShell>
      <div className="space-y-8">
      <section>
        <h1 className="text-[length:var(--text-headline)] font-semibold tracking-tight">
          Vaultide
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
          A monthly, snapshot-driven personal finance platform. You enter balances and the flows you
          know; Vaultide infers the rest by cash reconciliation, keeps every record in its native
          currency, and never presents a number it cannot justify.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)]"
          >
            Create an account
          </Link>
          <Link href="/sign-in" className="rounded-[var(--radius-control)] border px-4 py-2 font-medium">
            Sign in
          </Link>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone="info">Phase 2 — Accounts, balances and net worth</Badge>
          <Badge tone={allExact ? 'positive' : 'negative'}>
            {allExact ? 'Exact formatting verified' : 'Formatter self-test failed'}
          </Badge>
          <Badge tone="neutral">Blueprint v2.1.2</Badge>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Exact money formatting</CardTitle>
          <CardDescription>
            {SELF_TEST_AMOUNT} formatted from its decimal string. Nineteen significant digits — far
            beyond what a JavaScript number can hold — with every digit intact (blueprint 7.1.1).
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full border-collapse text-[length:var(--text-table)]">
            <thead>
              <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Locale
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Currency
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Minor units
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Formatted
                </th>
                <th scope="col" className="py-2 font-medium">
                  Path
                </th>
              </tr>
            </thead>
            <tbody>
              {selfTest.map((row) => (
                <tr key={`${row.locale}-${row.currency}`} className="border-b last:border-0">
                  <td className="py-2 pr-4">{row.locale}</td>
                  <td className="py-2 pr-4">{row.currency}</td>
                  <td className="tabular py-2 pr-4">{row.minorUnits}</td>
                  <td className="py-2 pr-4 text-right">
                    <MoneyText
                      amount={SELF_TEST_AMOUNT}
                      currency={row.currency}
                      locale={row.locale}
                      minorUnits={row.minorUnits}
                    />
                  </td>
                  <td className="py-2">
                    <Badge tone={row.exact ? 'positive' : 'negative'}>
                      {row.strategy === 'intl-string' ? 'Intl string path' : 'Fallback assembler'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <FoundationsDemo today={today} />

      <Card>
        <CardHeader>
          <CardTitle>What is built so far</CardTitle>
          <CardDescription>
            Foundations, identity and exchange rates. Balances, spending and net worth arrive with
            their phases.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {[
              'Exact decimal money: 0.1 + 0.2 = 0.3',
              'Dates and an injected clock (no engine reads the time)',
              'Unavailable and partial values instead of silent zeros',
              'Allocation and rounding that always sum exactly',
              'Signed net-worth arithmetic (assets +1, liabilities −1)',
              'Decimal and float numeric backends that agree',
              'Three database roles with RLS that fails closed',
              'Verified, encrypted nightly backups',
              'Verified email, optional two-factor sign-in, DB-backed sessions',
              'Settings: base and reporting currency, time zone, locale, favourites',
              'ECB reference rates for every supported currency, refreshed daily',
              'Cash accounts and other assets, with balances dated to the day',
              'Total and financial net worth, with what is missing spelled out',
              'Statement month-end balances, only once the month has ended',
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-[var(--color-positive)]">
                  ✓
                </span>
                <span className="text-[var(--color-muted-foreground)]">{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      </div>
    </AppShell>
  );
}
