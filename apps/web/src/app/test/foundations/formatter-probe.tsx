'use client';

import { Badge } from '@/components/ui/badge';
import { runFormatterSelfTest, SELF_TEST_AMOUNT } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';

/** The Phase 0 cases: two, zero and four minor units, in four locales. */
const CASES = [
  { locale: 'en-US', currency: 'USD', minorUnits: 2 },
  { locale: 'de-DE', currency: 'EUR', minorUnits: 2 },
  { locale: 'ja-JP', currency: 'JPY', minorUnits: 0 },
  { locale: 'es-CL', currency: 'CLF', minorUnits: 4 },
] as const;

/**
 * The formatter self-test, run by the browser (blueprint 7.1.1), for the Phase 0
 * browser fixture.
 *
 * Until React has hydrated — and so in the server's HTML — this is only a
 * pending marker. The rows exist once it has, and every value in them is what
 * this browser's own `Intl` made of the decimal string: nothing formatted is
 * passed in or sent as HTML. A test that waits for the ready marker is reading
 * the browser's output.
 */
export function FormatterProbe() {
  const hydrated = useHydrated();

  if (!hydrated) {
    return (
      <p data-testid="foundations-browser-pending" className="text-[var(--color-muted-foreground)]">
        Waiting for this browser to run the formatter.
      </p>
    );
  }

  const rows = runFormatterSelfTest(CASES);

  return (
    <div data-testid="foundations-browser-ready" className="relative overflow-x-auto">
      <table className="w-full border-collapse text-[length:var(--text-table)]">
        <caption className="pb-2 text-left text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {SELF_TEST_AMOUNT}, formatted by this browser
        </caption>
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
            <th scope="col" className="py-2 pr-4 font-medium">
              Digits
            </th>
            <th scope="col" className="py-2 font-medium">
              Path
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = row.currency.toLowerCase();
            return (
              <tr
                key={row.currency}
                data-testid={`foundations-browser-row-${id}`}
                data-exact={String(row.exact)}
                className="border-b last:border-0"
              >
                <td className="py-2 pr-4">{row.locale}</td>
                <td className="py-2 pr-4">{row.currency}</td>
                <td className="tabular py-2 pr-4">{row.minorUnits}</td>
                <td
                  data-testid={`foundations-browser-value-${id}`}
                  className="tabular py-2 pr-4 text-right"
                >
                  {row.sample}
                </td>
                <td className="py-2 pr-4">
                  <Badge tone={row.exact ? 'positive' : 'negative'}>
                    {row.exact ? 'Exact' : 'Digits lost'}
                  </Badge>
                </td>
                <td className="py-2">
                  {row.strategy === 'intl-string' ? 'Intl string path' : 'Fallback assembler'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
