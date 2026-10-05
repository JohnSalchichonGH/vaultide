import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getIncomePage, getServices, isDomainError } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IncomeChart } from '@/components/charts/income-chart';
import { AddIncomeSourceForm } from '@/features/monthly/income-editor';
import { defaultPickerCurrency, pickerCurrencies } from '@/features/monthly/income-presentation';
import { META } from '@/features/spending/figure';
import { AddPayment } from '@/features/income/add-payment';
import { incomeChartModel } from '@/features/income/chart-model';
import { incomeYearHref, paymentDateBounds, SO_FAR } from '@/features/income/presentation';
import { IncomeSummary, MissingPayments, MonthsTable, SourcesTable, YearsTable } from '@/features/income/year-view';

export const metadata: Metadata = { title: 'Income' };
export const dynamic = 'force-dynamic';

/**
 * The Income year view (blueprint 15.1 `/income`, 15.2 "Income", v2.1.20
 * 30.23; ADR 0012 D1–D3, D5, D6).
 *
 * One calendar year, from `?year=` or the current one, read in one call. The
 * page computes no financial figure: every amount, availability and missing
 * payment arrives decided, and what happens here is how they read.
 *
 * A year that is not well-formed, or has not begun, is not a page — the rule
 * Spending keeps for a month (ADR 0008 §1).
 */

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

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const { year } = await searchParams;
  if (Array.isArray(year)) notFound();
  const session = await requireSessionPage(year === undefined ? '/income' : `/income?year=${year}`);

  const page = await getIncomePage(getServices().flows, session, year === undefined ? {} : { year }).catch(
    (error: unknown) => {
      // The one validation this read performs is "is it a year that has begun?".
      if (isDomainError(error) && error.code === 'VALIDATION_ERROR') notFound();
      throw error;
    },
  );

  const { locale } = session.settings;
  const formatting = { locale, minorUnitsByCurrency: page.minorUnitsByCurrency };
  const currencies = pickerCurrencies(page.selectableCurrencyCodes, page.reportingCurrency);
  const defaultCurrency = defaultPickerCurrency(currencies, page.reportingCurrency);
  const { view, navigation } = page;
  const yearName = `${String(view.year)}${view.current ? ` (${SO_FAR})` : ''}`;

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight" data-testid="income-title">
            Income
          </h1>
          <Badge tone={view.current ? 'info' : 'neutral'} data-testid="income-year-badge">
            {yearName}
          </Badge>
        </div>
        <p className="text-[var(--color-muted-foreground)]" data-testid="income-intro">
          Income recorded in {view.year}, by the day it arrived, in {page.reportingCurrency} — each payment
          converted from its own currency on its own date.
        </p>
        <nav aria-label="Years" className="flex flex-wrap items-center gap-4 text-[length:var(--text-meta)]">
          {navigation.previous === null ? null : (
            <Link href={incomeYearHref(navigation.previous)} className="underline" data-testid="income-year-previous">
              ← {navigation.previous}
            </Link>
          )}
          {navigation.next === null ? null : (
            <Link href={incomeYearHref(navigation.next)} className="underline" data-testid="income-year-next">
              {navigation.next} →
            </Link>
          )}
          {view.current ? null : (
            <Link href={incomeYearHref(page.currentYear)} className="underline" data-testid="income-year-current">
              This year
            </Link>
          )}
        </nav>
      </header>

      {page.empty ? (
        <Card data-testid="income-empty">
          <CardHeader>
            <CardTitle>Add a salary or other income source</CardTitle>
            <CardDescription>
              A source is income you receive on a schedule — a salary, a pension, rent. Vaultide suggests
              each payment when it is due, and this page totals what arrives. A one-off payment can be
              added on its own.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-[length:var(--text-meta)]">
            <a href="#add-source" className="underline" data-testid="income-empty-add-source">
              Add income source
            </a>
            <a href="#add-payment" className="underline">
              Add a payment
            </a>
          </CardContent>
        </Card>
      ) : (
        <>
          <Section id="summary" title={yearName}>
            <Card>
              <CardContent>
                <IncomeSummary page={page} formatting={formatting} />
              </CardContent>
            </Card>
          </Section>

          <Section
            id="months"
            title="Month by month"
            description="Net income each month, as salary, bonus and everything else. The table has the exact figures."
          >
            <IncomeChart
              {...incomeChartModel({
                months: view.months,
                year: view.year,
                reportingCurrency: page.reportingCurrency,
                locale,
                minorUnitsByCurrency: page.minorUnitsByCurrency,
              })}
            />
            <details className="group" data-testid="income-months-details">
              <summary className="cursor-pointer text-[length:var(--text-meta)] underline" data-testid="income-view-table">
                View as table
              </summary>
              <div className="pt-2">
                <MonthsTable months={view.months} formatting={formatting} />
              </div>
            </details>
          </Section>

          <Section
            id="sources"
            title="By source"
            description={`Each source with a payment received in ${String(view.year)} or a payment scheduled in it, then the payments that have no source.`}
          >
            <SourcesTable page={page} formatting={formatting} />
          </Section>

          <Section
            id="missing"
            title="Missing payments"
            description="Scheduled payments that nothing records or skips, in the months that have ended. Archived sources still count for the months they covered."
          >
            <MissingPayments page={page} formatting={formatting} />
          </Section>

          {page.years.length === 0 ? null : (
            <Section id="years" title="Every year">
              <YearsTable page={page} formatting={formatting} />
            </Section>
          )}
        </>
      )}

      <Section
        id="add-payment"
        title="Add a payment"
        description="A payment of any of the kinds this page counts, on any day up to today. It is edited afterwards in Monthly, in the month it arrived."
      >
        <Card>
          <CardContent>
            <AddPayment
              forms={page.forms}
              currencies={currencies}
              minorUnitsByCurrency={page.minorUnitsByCurrency}
              defaultCurrency={defaultCurrency}
              bounds={paymentDateBounds(page.today)}
              today={page.today}
              locale={locale}
            />
          </CardContent>
        </Card>
      </Section>

      <Section
        id="add-source"
        title="Add income source"
        description="Income you receive on a schedule. Its payments are suggested in Monthly when they are due."
      >
        <Card>
          <CardContent>
            <AddIncomeSourceForm
              accounts={page.forms.cashAccounts}
              currencies={currencies}
              minorUnitsByCurrency={page.minorUnitsByCurrency}
              defaultCurrency={defaultCurrency}
              today={page.today}
              locale={locale}
            />
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
