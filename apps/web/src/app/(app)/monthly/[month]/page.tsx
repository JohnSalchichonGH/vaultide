import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getMonthlyPage,
  getServices,
  isDomainError,
  parseMonth,
  type MonthlyPageDto,
  type ReconciliationIssueDto,
} from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CompletedAccountsEditor, CurrentAccountsEditor } from '@/features/monthly/accounts-editor';
import { MonthNavigation } from '@/features/monthly/month-navigation';
import { CompletedOverview, CurrentOverview } from '@/features/monthly/overview';
import { IssuesPanel } from '@/features/monthly/issues';
import { CompletedBucket, MonthToDateBucket } from '@/features/monthly/reconciliation';
import { dayTitle, monthTitle, presentIssues } from '@/features/monthly/presentation';

export const metadata: Metadata = { title: 'Monthly' };
export const dynamic = 'force-dynamic';

/**
 * The Monthly page (blueprint 15.2 "Monthly", 15.3).
 *
 * One month at a time, completed or current, read in one call: the page never
 * assembles financial figures from several reads, and never computes one. Its
 * sections are the ones this phase has built so far — the Overview, the cash
 * Accounts and the Reconciliation — and the review state (the review mark, the
 * hidden advisories) is applied to the presentation only.
 *
 * A month that is not well-formed, or has not begun, is not a page: there is no
 * evidence of any kind for it, and an empty result would be a synthetic one.
 */

function monthOrNotFound(value: string): ReturnType<typeof parseMonth> {
  try {
    return parseMonth(value);
  } catch {
    notFound();
  }
}

/** Every issue the month's reads raised, in the order they raised them. */
function issuesOf(page: MonthlyPageDto): ReconciliationIssueDto[] {
  if (page.kind === 'completed') return page.reconciliation.buckets.flatMap((bucket) => bucket.issues);
  return [
    ...page.monthToDate.issues,
    ...(page.monthToDate.buckets ?? []).flatMap((bucket) => bucket.issues),
  ];
}

/** Account names by position id, for issues that carry only an id. */
function namesOf(page: MonthlyPageDto): Map<string, string> {
  const accounts =
    page.kind === 'completed'
      ? page.reconciliation.buckets.flatMap((bucket) => bucket.accounts)
      : (page.monthToDate.buckets ?? []).flatMap((bucket) => bucket.accounts);
  return new Map(accounts.map((account) => [account.positionId, account.name]));
}

export default async function MonthlyPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  const session = await requireSessionPage(`/monthly/${month}`);
  const key = monthOrNotFound(month);

  const page = await getMonthlyPage(getServices().flows, session, key).catch((error: unknown) => {
    // The one validation this read performs is "has the month begun?".
    if (isDomainError(error) && error.code === 'VALIDATION_ERROR') notFound();
    throw error;
  });

  const { locale, timezone } = session.settings;
  const monthName = monthTitle(page.month, locale);
  const presentation = presentIssues(issuesOf(page), page.review.dismissedIssueKeys);
  const context = { locale, minorUnitsByCurrency: page.minorUnitsByCurrency, names: namesOf(page) };
  const { navigation } = page;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight" data-testid="monthly-title">
            {monthName}
          </h1>
          {page.kind === 'completed' ? (
            <Badge tone="neutral" data-testid="monthly-kind">Completed month</Badge>
          ) : (
            <Badge tone="info" data-testid="monthly-kind">In progress</Badge>
          )}
          {page.kind === 'completed' && page.review.reviewedAt !== null ? (
            <Badge tone="positive">Reviewed</Badge>
          ) : null}
        </div>
        <p className="text-[var(--color-muted-foreground)]">
          {page.kind === 'completed'
            ? `${monthName} ended on ${dayTitle(page.monthEndsOn, locale)}. Its figures are recomputed from your records every time you open it.`
            : `${monthName} is in progress and closes on ${dayTitle(page.monthEndsOn, locale)}. Its figures are month to date and provisional.`}
        </p>
        <MonthNavigation
          key={page.month}
          month={page.month}
          previous={navigation.previous}
          next={navigation.next}
          current={navigation.current}
          previousLabel={monthTitle(navigation.previous, locale)}
          nextLabel={navigation.next === null ? null : monthTitle(navigation.next, locale)}
        />
        <nav aria-label="Month sections" className="flex flex-wrap gap-4 border-b pb-2 text-[length:var(--text-meta)]">
          <a href="#overview" className="underline">Overview</a>
          <a href="#accounts" className="underline">Accounts</a>
          <a href="#reconciliation" className="underline">Reconciliation</a>
        </nav>
      </header>

      <section id="overview" aria-label="Overview" className="scroll-mt-20">
        {page.kind === 'completed' ? (
          <CompletedOverview
            page={page}
            locale={locale}
            timeZone={timezone}
            monthName={monthName}
            issues={presentation}
          />
        ) : (
          <CurrentOverview page={page} locale={locale} issues={presentation} />
        )}
      </section>

      <section id="accounts" aria-labelledby="accounts-heading" className="scroll-mt-20 space-y-4">
        <div>
          <h2 id="accounts-heading" className="text-[length:var(--text-section)] font-semibold tracking-tight">
            Accounts
          </h2>
          <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            {page.kind === 'completed'
              ? `Each cash account's statement balance at the end of ${monthName}. A snapshot is not a statement until you confirm it as one, and nothing is assumed unchanged unless you say so.`
              : `Each cash account's latest balance, with its own date. Update them to today to move month to date forward.`}
          </p>
        </div>
        <Card>
          <CardContent>
            {page.kind === 'completed' ? (
              <CompletedAccountsEditor
                key={page.month}
                month={page.month}
                monthName={monthName}
                monthEndsOn={page.monthEndsOn}
                previousMonthName={monthTitle(page.accounts.previousMonth, locale)}
                accounts={page.accounts}
                formatting={{ locale, minorUnitsByCurrency: page.minorUnitsByCurrency }}
              />
            ) : (
              <CurrentAccountsEditor
                key={page.month}
                monthName={monthName}
                monthEndsOn={page.monthEndsOn}
                today={page.today}
                previousMonthName={monthTitle(page.accounts.previousMonth, locale)}
                accounts={page.accounts}
                formatting={{ locale, minorUnitsByCurrency: page.minorUnitsByCurrency }}
              />
            )}
          </CardContent>
        </Card>
      </section>

      <section id="reconciliation" aria-labelledby="reconciliation-heading" className="scroll-mt-20 space-y-6">
        <div>
          <h2 id="reconciliation-heading" className="text-[length:var(--text-section)] font-semibold tracking-tight">
            Reconciliation
          </h2>
          <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Per currency, in the currency itself: the recorded flows, the change in cash, and what
            the difference says was spent.
          </p>
        </div>

        <IssuesPanel presentation={presentation} month={page.month} monthName={monthName} context={context} />

        {page.kind === 'completed' ? (
          page.reconciliation.buckets.length === 0 ? (
            <EmptyReconciliation monthName={monthName} />
          ) : (
            page.reconciliation.buckets.map((bucket) => (
              <CompletedBucket
                key={bucket.currency}
                bucket={bucket}
                formatting={{ locale, minorUnits: page.minorUnitsByCurrency[bucket.currency] ?? 2 }}
              />
            ))
          )
        ) : page.monthToDate.buckets === null || page.monthToDate.asOf === null ? (
          <Card data-testid="mtd-no-identity">
            <CardHeader>
              <CardTitle>No month-to-date reconciliation</CardTitle>
              <CardDescription>
                Your cash accounts do not share a balance date this month, so there is no interval to
                reconcile and no figure of any kind — not even a zero. Update all cash accounts to the
                same date to calculate month-to-date spending.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : page.monthToDate.buckets.length === 0 ? (
          <EmptyReconciliation monthName={monthName} />
        ) : (
          page.monthToDate.buckets.map((bucket) => (
            <MonthToDateBucket
              key={bucket.currency}
              bucket={bucket}
              asOf={page.monthToDate.asOf as string}
              formatting={{ locale, minorUnits: page.minorUnitsByCurrency[bucket.currency] ?? 2 }}
            />
          ))
        )}
      </section>
    </div>
  );
}

function EmptyReconciliation({ monthName }: { readonly monthName: string }) {
  return (
    <Card data-testid="reconciliation-empty">
      <CardHeader>
        <CardTitle>Nothing to reconcile</CardTitle>
        <CardDescription>No cash account took part in {monthName}.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/accounts" className="underline">
          Add an account or enter last month’s balances
        </Link>
      </CardContent>
    </Card>
  );
}
