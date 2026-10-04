import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getIncomeSourcePage, getServices, isDomainError } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { META } from '@/features/spending/figure';
import { incomeKindLabel } from '@/features/monthly/income-presentation';
import { incomeSourceHref } from '@/features/income/presentation';
import { SourceArchive, SourceEndDate, SourceNameAndPayer } from '@/features/income/source-editor';
import { AmountHistory, SourceDetails, SourceOccurrences } from '@/features/income/source-view';

export const metadata: Metadata = { title: 'Income source' };
export const dynamic = 'force-dynamic';

/**
 * One income source (blueprint 15.1 `/income/sources/[id]`, 15.2 "Income
 * source", v2.1.20 30.23; ADR 0012 D2–D4, D6, D7).
 *
 * Its details, its amount history against what arrived, and its occurrences
 * a year at a time, from `?year=` or the current one — all in the source's own
 * currency, read in one call. The page computes no financial figure and adds no
 * rule: each edit is an action that already exists, and the server judges it.
 *
 * An id that names no income source of this user — malformed, missing, someone
 * else's, or an expense — is not a page, and neither is a year outside the
 * source's own: from its start year (or the current one, for a source that
 * starts later) to the current one.
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

export default async function IncomeSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const { id } = await params;
  const { year } = await searchParams;
  if (Array.isArray(year)) notFound();
  const session = await requireSessionPage(`/income/sources/${id}${year === undefined ? '' : `?year=${year}`}`);

  const page = await getIncomeSourcePage(
    getServices().flows,
    session,
    year === undefined ? { templateId: id } : { templateId: id, year },
  ).catch((error: unknown) => {
    // Nothing this read refuses is a page: an id that names no income source
    // of this user, or a year outside the source's own.
    if (isDomainError(error) && (error.code === 'NOT_FOUND' || error.code === 'VALIDATION_ERROR')) notFound();
    throw error;
  });

  const { locale } = session.settings;
  const formatting = { locale, minorUnitsByCurrency: page.minorUnitsByCurrency };
  const { source, navigation } = page;
  const current = page.year === page.currentYear;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link href="/income" className="text-[length:var(--text-meta)] underline" data-testid="source-back">
          ← Income
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-[length:var(--text-page)] font-semibold tracking-tight" data-testid="source-title">
            {source.name}
          </h1>
          {source.archived ? (
            <Badge tone="neutral" data-testid="source-archived">
              Archived
            </Badge>
          ) : null}
        </div>
        <p className="text-[var(--color-muted-foreground)]" data-testid="source-intro">
          {incomeKindLabel(source.incomeKind)}
          {source.counterparty === null ? '' : ` from ${source.counterparty}`}, in {source.currency}. Every amount on
          this page is in {source.currency}. Payments are recorded and edited in Monthly.
        </p>
      </header>

      <Section id="details" title="Details">
        <Card>
          <CardContent className="space-y-6">
            <SourceDetails page={page} locale={locale} />
            <div className="space-y-6 border-t pt-4">
              <div className="space-y-2">
                <h3 className="font-medium">Name and payer</h3>
                <SourceNameAndPayer key={source.templateId} source={source} />
              </div>
              <div id="end-date" className="scroll-mt-20 space-y-2">
                <h3 className="font-medium">End date</h3>
                <SourceEndDate key={source.templateId} source={source} locale={locale} />
              </div>
              <div id="archive" className="scroll-mt-20 space-y-2">
                <h3 className="font-medium">{source.archived ? 'Unarchive' : 'Archive'}</h3>
                <SourceArchive key={source.templateId} source={source} />
              </div>
              <p className={META}>
                The schedule, kind, currency and account are fixed: they decide what this source’s past payments
                were. To change them, end this source and add a new one.
              </p>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        id="history"
        title="Amount history"
        description={`The amount ${source.name} was set to over time, and what arrived for each payment. The table has the exact figures.`}
      >
        <AmountHistory page={page} formatting={formatting} />
      </Section>

      <Section
        id="payments"
        title={`Payments in ${String(page.year)}${current ? ' (so far)' : ''}`}
        description={
          source.archived
            ? 'Each payment the schedule placed in the year. A payment is missing once its month has ended with nothing recorded or skipped.'
            : 'Each payment the schedule placed in the year. A payment is missing once its month has ended with nothing recorded or skipped. A new amount starts at the payment you change it from; payments already recorded keep theirs.'
        }
      >
        <nav aria-label="Years" className="flex flex-wrap items-center gap-4 text-[length:var(--text-meta)]">
          {navigation.previous === null ? null : (
            <Link href={incomeSourceHref(source.templateId, navigation.previous)} className="underline" data-testid="source-year-previous">
              ← {navigation.previous}
            </Link>
          )}
          {navigation.next === null ? null : (
            <Link href={incomeSourceHref(source.templateId, navigation.next)} className="underline" data-testid="source-year-next">
              {navigation.next} →
            </Link>
          )}
          {current ? null : (
            <Link href={incomeSourceHref(source.templateId)} className="underline" data-testid="source-year-current">
              This year
            </Link>
          )}
        </nav>
        <SourceOccurrences page={page} formatting={formatting} />
      </Section>
    </div>
  );
}
