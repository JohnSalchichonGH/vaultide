import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPositionDetail, getServices, isDomainError } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FreshnessBadge, MonthEndBadge } from '@/components/finance/freshness-badge';
import { MoneyText } from '@/components/finance/money-text';
import { EditPositionForm } from '@/features/accounts/account-forms';
import { ValuationEditor } from '@/features/accounts/valuation-editor';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

/**
 * Account detail (blueprint 15.2 "Account detail").
 *
 * One position: what it is worth now and how well that is known, its whole
 * balance timeline with statement balances distinguished from ordinary
 * snapshots, the months still waiting for a statement figure, and the editing
 * that goes with all of it.
 *
 * A position belonging to somebody else is a 404 here, not a "forbidden":
 * existence is never leaked (17.2, 20.2).
 */
export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSessionPage(`/accounts/${id}`);

  const detail = await getPositionDetail(getServices().positions, session, id).catch((error: unknown) => {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  });

  const { position } = detail;
  const { locale } = session.settings;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={position.kind === 'cash' ? '/accounts?tab=cash' : '/accounts?tab=other'}
          className="text-[length:var(--text-meta)] underline"
        >
          ← All accounts
        </Link>
        <h1 className="mt-2 text-[length:var(--text-page)] font-semibold tracking-tight">
          {position.name}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[var(--color-muted-foreground)]">
          <span>{position.currency}</span>
          {position.institution === null ? null : <span>· {position.institution}</span>}
          {position.status === 'active' ? null : <Badge tone="neutral">{position.status}</Badge>}
          {position.isDormant === true ? <Badge tone="neutral">Dormant</Badge> : null}
          {position.includeInFinancialNetWorth === null ? null : position.includeInFinancialNetWorth ? (
            <Badge tone="positive">In financial net worth</Badge>
          ) : (
            <Badge tone="neutral">Total net worth only</Badge>
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current value</CardTitle>
          <CardDescription>
            The latest figure on or before {session.today} — and where it came from.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-4">
            <span className="tabular text-[length:var(--text-headline)] font-semibold" data-testid="position-native">
              <MoneyText
                amount={position.value.native?.amount ?? null}
                currency={position.currency}
                locale={locale}
                minorUnits={position.minorUnits}
                unavailableReason="No value recorded — which is not the same as zero."
              />
            </span>
            <span className="text-[var(--color-muted-foreground)]" data-testid="position-reporting">
              <MoneyText
                amount={position.value.reporting?.amount ?? null}
                currency={detail.reportingCurrency}
                locale={locale}
                minorUnits={detail.reportingMinorUnits}
                unavailableReason="No exchange rate for this date yet."
              />
            </span>
            <FreshnessBadge value={position.value} />
          </div>

          <dl className="grid gap-2 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] sm:grid-cols-3">
            <div>
              <dt className="font-medium">Valued on</dt>
              <dd className="tabular">{position.value.valuedOn ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-medium">Opened</dt>
              <dd className="tabular">
                {position.openedOn ?? 'Existed before tracking started'}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Exchange rate used</dt>
              <dd className="tabular" data-testid="position-rate">
                {position.value.rate === null
                  ? '—'
                  : `${position.value.rate.rate} on ${position.value.rate.rateDate} (${position.value.rate.source}${
                      position.value.rate.exact ? '' : ', nearest earlier'
                    })`}
              </dd>
            </div>
          </dl>

          {position.lastCompletedMonth === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <MonthEndBadge
                month={position.lastCompletedMonth.month}
                hasStatement={position.lastCompletedMonth.monthEnd !== null}
                firstBalance={position.lastCompletedMonth.firstBalance}
              />
              {position.lastCompletedMonth.firstBalance ? (
                <span
                  data-testid="first-balance-note"
                  className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
                >
                  This is the first month with a balance, so what moved through the account before
                  it is unknown — and that month is not read as a month of activity.
                </span>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Balances</CardTitle>
          <CardDescription>
            Every figure is a snapshot: what this held on a date. Nothing here infers where money
            went — that arrives with income, spending and transfers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ValuationEditor detail={detail} today={session.today} locale={locale} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            Renaming changes nothing financial. Closing and archiving both stop it counting
            towards net worth; closing needs a final balance of zero first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EditPositionForm position={position} today={session.today} />
        </CardContent>
      </Card>
    </div>
  );
}
