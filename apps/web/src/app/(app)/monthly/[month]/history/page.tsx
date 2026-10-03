import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBulkHistoryPage, getServices, isDomainError, parseMonth } from '@vaultide/application';
import { requireSessionPage } from '@/server/context';
import { BulkHistoryGrid } from '@/features/history/grid';
import { monthlyHref } from '@/features/history/routes';
import { monthTitle } from '@/features/monthly/presentation';

export const metadata: Metadata = { title: 'Bulk history' };
export const dynamic = 'force-dynamic';

/**
 * Bulk History (blueprint 15.1 `/monthly/[yyyy-mm]/history`, 15.2, 15.3; ADR
 * 0011).
 *
 * The route's month is the grid's **first row**; the rows run from it through
 * the current month, whose row is shown disabled. A first row that is
 * malformed, current or still to come is not a page — exactly as Monthly treats
 * a month that has not begun.
 *
 * One read for the whole grid, never Monthly's read per row, and nothing
 * computed here: every cell is what the server stated it to be.
 */

function monthOrNotFound(value: string): ReturnType<typeof parseMonth> {
  try {
    return parseMonth(value);
  } catch {
    notFound();
  }
}

export default async function BulkHistoryPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  const session = await requireSessionPage(`/monthly/${month}/history`);
  const key = monthOrNotFound(month);

  const page = await getBulkHistoryPage(getServices().flows, session, key).catch((error: unknown) => {
    // The one validation this read performs is "is the first row completed?".
    if (isDomainError(error) && error.code === 'VALIDATION_ERROR') notFound();
    throw error;
  });

  const { locale } = session.settings;
  const first = monthTitle(page.startMonth, locale);
  const last = monthTitle(page.lastCompletedMonth, locale);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={monthlyHref(page.startMonth)}
          className="text-[length:var(--text-meta)] underline"
          data-testid="bulk-back"
        >
          Back to {first} in Monthly
        </Link>
        <h1 className="text-[length:var(--text-page)] font-semibold tracking-tight" data-testid="bulk-title">
          Bulk history
        </h1>
        <p className="max-w-3xl text-[var(--color-muted-foreground)]">
          Month-end balances and recurring income from {first} to {last}, one month per row. Type or
          paste figures from your statements; a muted figure is carried from an earlier balance and is
          not recorded until you type one. Every save is reviewed before anything is written.
        </p>
      </header>

      <BulkHistoryGrid key={page.startMonth} page={page} locale={locale} />
    </div>
  );
}
