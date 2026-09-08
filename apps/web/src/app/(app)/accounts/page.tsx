import type { Metadata } from 'next';
import Link from 'next/link';
import { getNetWorth, getServices, listCurrencies } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AggregateFigure } from '@/components/finance/aggregate-figure';
import { MoneyText } from '@/components/finance/money-text';
import { FreshnessBadge, MonthEndBadge } from '@/components/finance/freshness-badge';
import { Badge } from '@/components/ui/badge';
import { CreateCashAccountForm, CreateOtherAssetForm } from '@/features/accounts/account-forms';
import { QuickUpdate } from '@/features/accounts/quick-update';

export const metadata: Metadata = { title: 'Accounts' };
export const dynamic = 'force-dynamic';

/**
 * Accounts (blueprint 15.2, R14: "Other assets are a tab of the Accounts page").
 *
 * Two tabs over the same page: cash accounts, and the other things you own.
 * Each row shows the native amount, the reporting amount, the date the figure
 * belongs to and how well it is known — never a bare number.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireSessionPage('/accounts');
  const { tab } = await searchParams;
  const active = tab === 'other' ? 'other' : 'cash';

  const services = getServices();
  const [netWorth, currencies] = await Promise.all([
    getNetWorth(services.positions, session),
    listCurrencies(services.db, { fxSupportedOnly: true }),
  ]);

  const { locale, baseCurrency } = session.settings;
  const live = netWorth.positions;
  const cash = live.filter((position) => position.kind === 'cash');
  const other = live.filter((position) => position.kind === 'other_asset');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight">Accounts</h1>
          <p className="mt-1 text-[var(--color-muted-foreground)]">
            What you hold, in the currency you hold it in. Totals are converted for display only.
          </p>
        </div>
        <QuickUpdate
          positions={live}
          today={netWorth.asOf}
          locale={locale}
          monthEndsOn={netWorth.currentMonth.endsOn}
        />
      </div>

      <nav aria-label="Account kinds" className="flex gap-2 border-b pb-3">
        <Link
          href="/accounts?tab=cash"
          aria-current={active === 'cash' ? 'page' : undefined}
          data-testid="tab-cash"
          className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)] aria-[current=page]:bg-[var(--color-surface-muted)]"
        >
          Cash accounts ({cash.length})
        </Link>
        <Link
          href="/accounts?tab=other"
          aria-current={active === 'other' ? 'page' : undefined}
          data-testid="tab-other"
          className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)] aria-[current=page]:bg-[var(--color-surface-muted)]"
        >
          Other assets ({other.length})
        </Link>
      </nav>

      {active === 'cash' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Cash &amp; savings</CardTitle>
              <CardDescription>
                Total across every cash account, converted into {netWorth.reportingCurrency}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AggregateFigure
                aggregate={netWorth.components.cash}
                locale={locale}
                minorUnits={netWorth.minorUnits}
                minorUnitsByCurrency={netWorth.minorUnitsByCurrency}
                size="section"
                showNative
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your accounts</CardTitle>
              <CardDescription>
                {cash.length === 0
                  ? 'Add your first account below.'
                  : 'Open one to record balances, close a month, or edit its history.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {cash.length === 0 ? (
                <p className="text-[var(--color-muted-foreground)]">Nothing here yet.</p>
              ) : (
                <table
                  className="w-full border-collapse text-[length:var(--text-table)]"
                  data-testid="cash-accounts-table"
                >
                  <thead>
                    <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                      <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">Balance</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">
                        In {netWorth.reportingCurrency}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">As of</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Freshness</th>
                      <th scope="col" className="py-2 font-medium">Last completed month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cash.map((position) => (
                      <tr key={position.id} className="border-b last:border-0" data-testid={`account-row-${position.id}`}>
                        <td className="py-2 pr-4">
                          <Link className="underline" href={`/accounts/${position.id}`}>
                            {position.name}
                          </Link>
                          {position.isDormant === true ? (
                            <Badge tone="neutral" className="ml-2">Dormant</Badge>
                          ) : null}
                          <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                            {position.currency}
                            {position.institution === null ? '' : ` · ${position.institution}`}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <MoneyText
                            amount={position.value.native?.amount ?? null}
                            currency={position.currency}
                            locale={locale}
                            minorUnits={position.minorUnits}
                            unavailableReason="No balance recorded."
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
                        <td className="tabular py-2 pr-4 text-[var(--color-muted-foreground)]">
                          {position.value.valuedOn ?? '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <FreshnessBadge value={position.value} />
                        </td>
                        <td className="py-2">
                          {position.lastCompletedMonth === null ? null : (
                            <MonthEndBadge
                              month={position.lastCompletedMonth.month}
                              hasStatement={position.lastCompletedMonth.monthEnd !== null}
                              firstBalance={position.lastCompletedMonth.firstBalance}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add a cash account</CardTitle>
              <CardDescription>
                A current account, savings, physical cash, or the cash sitting in a brokerage.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateCashAccountForm
                currencies={currencies}
                baseCurrency={baseCurrency}
                today={netWorth.asOf}
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Other assets</CardTitle>
              <CardDescription>
                A car, a collection, equipment. Each one counts in total net worth; you choose
                whether it belongs in the financial figure.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {other.length === 0 ? (
                <p className="text-[var(--color-muted-foreground)]">
                  Track something else you own.
                </p>
              ) : (
                <table
                  className="w-full border-collapse text-[length:var(--text-table)]"
                  data-testid="other-assets-table"
                >
                  <thead>
                    <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                      <th scope="col" className="py-2 pr-4 font-medium">Asset</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">Value</th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">
                        In {netWorth.reportingCurrency}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">As of</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Freshness</th>
                      <th scope="col" className="py-2 font-medium">In financial net worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {other.map((position) => (
                      <tr key={position.id} className="border-b last:border-0" data-testid={`asset-row-${position.id}`}>
                        <td className="py-2 pr-4">
                          <Link className="underline" href={`/accounts/${position.id}`}>
                            {position.name}
                          </Link>
                          <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                            {position.currency}
                          </span>
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
                        <td className="tabular py-2 pr-4 text-[var(--color-muted-foreground)]">
                          {position.value.valuedOn ?? '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <FreshnessBadge value={position.value} />
                        </td>
                        <td className="py-2" data-testid={`asset-inclusion-${position.id}`}>
                          {position.includeInFinancialNetWorth === true ? (
                            <Badge tone="positive">Included</Badge>
                          ) : (
                            <Badge tone="neutral">Total only</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add another asset</CardTitle>
              <CardDescription>
                Its value only ever changes when you say so — nothing here is estimated for you.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateOtherAssetForm
                currencies={currencies}
                baseCurrency={baseCurrency}
                today={netWorth.asOf}
              />
            </CardContent>
          </Card>
        </>
      )}

    </div>
  );
}
