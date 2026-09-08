import type { Metadata } from 'next';
import Link from 'next/link';
import { getNetWorth, getServices } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AggregateFigure } from '@/components/finance/aggregate-figure';
import { MoneyText } from '@/components/finance/money-text';
import { NetWorthChart } from '@/components/charts/net-worth-chart';
import { QuickUpdate } from '@/features/accounts/quick-update';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * Dashboard v0 (blueprint Phase 2, 15.2, 15.4).
 *
 * "Where am I, and how well do I know it." The headline is **financial net
 * worth**, with **total net worth** beside it whenever the two differ (15.4) —
 * and the page says which is which, because a user who has excluded their car
 * needs to see both numbers and understand the gap.
 *
 * Phase 8 builds the real dashboard: drivers waterfall, allocation, analytics.
 * This is the honest minimum for Phase 2 — the two metrics, their components,
 * freshness, a twelve-month history, and the current month's state.
 */
export default async function DashboardPage() {
  const session = await requireSessionPage('/dashboard');
  const netWorth = await getNetWorth(getServices().positions, session);

  const { locale } = session.settings;
  const positions = netWorth.positions;
  const cashAccounts = positions.filter((position) => position.kind === 'cash');
  const hasAnything = positions.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-[var(--color-muted-foreground)]">
            Everything is shown in {netWorth.reportingCurrency}, converted from what each account
            actually holds. Nothing converted is ever stored.
          </p>
        </div>
        <QuickUpdate
          positions={positions}
          today={netWorth.asOf}
          locale={locale}
          monthEndsOn={netWorth.currentMonth.endsOn}
        />
      </div>

      {!hasAnything ? (
        <Card>
          <CardHeader>
            <CardTitle>Start with one account</CardTitle>
            <CardDescription>
              Add a cash account and its balance, and the two net-worth figures appear here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/accounts"
              className="inline-block rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)]"
            >
              Add your first account
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Net worth</CardTitle>
          <CardDescription>
            As of {netWorth.asOf}. Financial net worth is the headline; total net worth is
            everything you track, and no preference can take anything out of it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-1" data-testid="financial-net-worth">
              <p className="text-[length:var(--text-meta)] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Financial net worth
              </p>
              <AggregateFigure
                aggregate={netWorth.financialNetWorth}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="headline"
              />
              <p
                data-testid="financial-change"
                className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
              >
                Since {netWorth.changeSinceLastMonthEnd?.from ?? '—'}:{' '}
                <MoneyText
                  amount={netWorth.changeSinceLastMonthEnd?.financial?.amount ?? null}
                  currency={netWorth.reportingCurrency}
                  locale={locale}
                  minorUnits={netWorth.minorUnits}
                  signed
                  colored
                  unavailableReason="Not comparable while a figure is incomplete."
                />
              </p>
            </div>

            <div className="space-y-1" data-testid="total-net-worth">
              <p className="text-[length:var(--text-meta)] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Total net worth
              </p>
              <AggregateFigure
                aggregate={netWorth.totalNetWorth}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="headline"
              />
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                {netWorth.metricsDiffer ? (
                  <span data-testid="metrics-differ">
                    Higher by the assets you have left out of the financial figure.
                  </span>
                ) : (
                  'Same as the financial figure: nothing is excluded.'
                )}
              </p>
            </div>
          </div>

          <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
            <div>
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                Cash &amp; savings
              </p>
              <AggregateFigure
                aggregate={netWorth.components.cash}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="section"
                showNative
              />
            </div>
            <div data-testid="component-other-included">
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                Other assets, included
              </p>
              <AggregateFigure
                aggregate={netWorth.components.otherAssetsIncluded}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="section"
              />
            </div>
            <div data-testid="component-other-excluded">
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                Other assets, excluded
              </p>
              <AggregateFigure
                aggregate={netWorth.components.otherAssetsExcluded}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="section"
              />
              <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                In total net worth, not in the financial figure.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>This month</CardTitle>
          <CardDescription>
            {netWorth.currentMonth.month} is in progress and closes on {netWorth.currentMonth.endsOn}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge tone="info" data-testid="current-month-chip">
            {netWorth.currentMonth.updatedAccounts} of {netWorth.currentMonth.totalAccounts} accounts
            updated this month
          </Badge>
          <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            End-of-month balances can be entered from {addOneDay(netWorth.currentMonth.endsOn)} —
            not before, because the month has not finished.
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Last twelve months</CardTitle>
          <CardDescription>
            One point per month end, plus today. Today&rsquo;s point is provisional: the month has
            not closed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NetWorthChart
            points={netWorth.series}
            locale={locale}
            minorUnits={netWorth.minorUnits}
            metric="financial"
            label={`Financial net worth (${netWorth.reportingCurrency})`}
          />
        </CardContent>
      </Card>

      {cashAccounts.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardDescription>
              What each holds, in its own currency, and how recently you said so.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full border-collapse text-[length:var(--text-table)]">
              <thead>
                <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Native</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    {netWorth.reportingCurrency}
                  </th>
                  <th scope="col" className="py-2 font-medium">As of</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <Link className="underline" href={`/accounts/${position.id}`}>
                        {position.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <MoneyText
                        amount={position.value.native?.amount ?? null}
                        currency={position.currency}
                        locale={locale}
                        minorUnits={position.minorUnits}
                        unavailableReason="No value recorded."
                      />
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <MoneyText
                        amount={position.value.reporting?.amount ?? null}
                        currency={netWorth.reportingCurrency}
                        locale={locale}
                        minorUnits={netWorth.minorUnits}
                        unavailableReason="No exchange rate for this date yet."
                      />
                    </td>
                    <td className="tabular py-2 text-[var(--color-muted-foreground)]">
                      {position.value.valuedOn ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The first day of the next month, as text. Dates are strings here (7.7). */
function addOneDay(date: string): string {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}
