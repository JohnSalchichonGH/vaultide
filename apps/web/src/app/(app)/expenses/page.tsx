import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServices, getSpendingPage, isDomainError, type SpendingPageDto } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AddExpenseForm } from '@/features/monthly/expenses-editor';
import { defaultPickerCurrency, pickerCurrencies } from '@/features/monthly/income-presentation';
import { MonthNavigation } from '@/features/monthly/month-navigation';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';
import { Categories, LargestKnown } from '@/features/spending/breakdown';
import { META } from '@/features/spending/figure';
import { CombinedPeriods, HistoryTable, RollingCards } from '@/features/spending/history';
import { hasTrackedEvidence, monthlyHref } from '@/features/spending/presentation';
import { FocusSummary } from '@/features/spending/summary';

export const metadata: Metadata = { title: 'Spending' };
export const dynamic = 'force-dynamic';

/**
 * The standalone Spending page (blueprint 15.2 "Spending"; ADR 0008).
 *
 * One month in focus, from `?month=` or the last completed month, and the
 * twelve months around it — read in one call. The page never computes a
 * financial figure: every amount, status and availability arrives decided, and
 * what happens here is how they read.
 *
 * A month that is not well-formed, or has not begun, is not a page — the same
 * rule Monthly keeps.
 */

function intervalLine(page: SpendingPageDto, locale: string): string {
  const { focus } = page;
  if (focus.shape === 'completed') {
    return `${dayTitle(focus.interval.from, locale)} – ${dayTitle(focus.interval.to, locale)}. Recomputed from your records every time you open it.`;
  }
  if (focus.asOf === null) {
    return `In progress. Your cash accounts share no balance date yet this month.`;
  }
  return `Provisional · month to date through ${dayTitle(focus.asOf, locale)}.`;
}

function Section({
  id,
  title,
  description,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20 space-y-3">
      <div>
        <h2 id={`${id}-heading`} className="text-[length:var(--text-section)] font-semibold tracking-tight">
          {title}
        </h2>
        {description === undefined ? null : <p className={`mt-1 ${META}`}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const { month } = await searchParams;
  if (Array.isArray(month)) notFound();
  const session = await requireSessionPage(month === undefined ? '/expenses' : `/expenses?month=${month}`);

  const page = await getSpendingPage(getServices().flows, session, month === undefined ? {} : { month }).catch(
    (error: unknown) => {
      // The one validation this read performs is "is it a month that has begun?".
      if (isDomainError(error) && error.code === 'VALIDATION_ERROR') notFound();
      throw error;
    },
  );

  const { locale } = session.settings;
  const formatting = { locale, minorUnitsByCurrency: page.minorUnitsByCurrency };
  const monthName = monthTitle(page.month, locale);
  const { navigation } = page;
  const currencies = pickerCurrencies(page.selectableCurrencyCodes, page.reportingCurrency);
  const evidence = hasTrackedEvidence(page);

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight" data-testid="spending-title">
            Spending
          </h1>
          <Badge tone={page.focus.shape === 'completed' ? 'neutral' : 'info'} data-testid="spending-month">
            {monthName}
          </Badge>
        </div>
        <p className="text-[var(--color-muted-foreground)]" data-testid="spending-interval">
          {intervalLine(page, locale)} In {page.reportingCurrency}, converted from what each record
          holds in its own currency.
        </p>
        <MonthNavigation
          key={page.month}
          section="spending"
          month={page.month}
          previous={navigation.previous}
          next={navigation.next}
          current={navigation.currentMonth}
          previousLabel={monthTitle(navigation.previous, locale)}
          nextLabel={navigation.next === null ? null : monthTitle(navigation.next, locale)}
        />
        <p className="text-[length:var(--text-meta)]">
          <Link href={monthlyHref(page.month)} className="underline" data-testid="spending-open-month">
            Open {monthName} in Monthly
          </Link>
        </p>
      </header>

      {evidence ? null : (
        <Card data-testid="spending-empty">
          <CardHeader>
            <CardTitle>Enter two month-end balances to see inferred spending</CardTitle>
            <CardDescription>
              Vaultide works out your spending from your cash balances at the start and end of a
              month, together with the income, expenses and transfers you know about.
              {page.hasCashAccounts
                ? ' Enter the statement balances for two consecutive month ends to reconcile the month between them.'
                : ' Start by adding the cash accounts you want to track.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-[length:var(--text-meta)]">
            <Link href={page.hasCashAccounts ? monthlyHref(navigation.lastCompletedMonth, 'accounts') : '/accounts'} className="underline">
              {page.hasCashAccounts ? 'Enter month-end balances' : 'Add a cash account'}
            </Link>
            <a href="#add-expense" className="underline">
              Add a known expense
            </a>
          </CardContent>
        </Card>
      )}

      <Section id="summary" title={monthName}>
        <Card>
          <CardContent>
            <FocusSummary
              focus={page.focus}
              monthName={monthName}
              formatting={formatting}
              countsAdditionalSpending={page.countsAdditionalSpending}
            />
          </CardContent>
        </Card>
      </Section>

      <Section id="rolling" title="Rolling averages">
        <RollingCards rolling={page.rolling} formatting={formatting} />
      </Section>

      <Section
        id="history"
        title="Month by month"
        description="Tracked spending as known and unclassified parts, with additional spending beside it, one row per month."
      >
        <HistoryTable history={page.history} focusMonth={page.month} formatting={formatting} />
      </Section>

      <Section id="combined" title="Combined periods">
        <CombinedPeriods spans={page.spans} formatting={formatting} />
      </Section>

      <Section
        id="categories"
        title="Categories"
        description={`Where ${monthName}’s known spending went: tracked known expenses and spending paid from outside tracked accounts, each by its category. Paid by others is not included.`}
      >
        <Categories categories={page.categories} formatting={formatting} />
      </Section>

      <Section
        id="largest"
        title="Largest known"
        description="The biggest expenses you recorded in this period, tracked and additional. Paid by others is not included."
      >
        <LargestKnown largest={page.largestKnown} formatting={formatting} />
      </Section>

      <Section
        id="add-expense"
        title="Add known expense"
        description={`Record an expense in ${monthName}. From a tracked account it moves spending from unclassified to known and leaves tracked spending as it was. Paid by you outside tracked accounts, it is additional spending. Paid by someone else, it is kept for information only.`}
      >
        <Card>
          <CardContent className="space-y-3">
            <p className={META} data-testid="spending-additional-warning">
              Cash you withdrew from a tracked account has already left tracked cash, so it is already
              in tracked spending. Recording what you bought with it as spending paid outside tracked
              accounts would count it twice — record it from the tracked account instead, or not at
              all.
            </p>
            <AddExpenseForm
              key={page.month}
              accounts={page.expenseForm.cashAccounts}
              eligibleCategories={page.expenseForm.eligibleCategories}
              currencies={currencies}
              bounds={page.expenseForm.bounds}
              defaultCurrency={defaultPickerCurrency(currencies, page.reportingCurrency)}
              formatting={formatting}
            />
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
