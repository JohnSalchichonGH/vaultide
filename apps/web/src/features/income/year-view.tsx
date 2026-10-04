import Link from 'next/link';
import type { IncomeMonthDto, IncomePageDto, IncomeTotalDto } from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { Amount, META, SpendingFigure, type Formatting } from '@/features/spending/figure';
import { monthTitle } from '@/features/monthly/presentation';
import { GrossCell, NativeNote } from '@/features/income/cells';
import { OneOffRows } from '@/features/income/one-off-rows';
import {
  ARCHIVED_MISSING_HELP,
  DIFFERS_FROM_MONTHLY,
  GROUP_LABEL,
  INCOME_RECORDED,
  OUTSIDE_LABEL,
  SO_FAR,
  TRACKED_LABEL,
  incomeFigureDisplay,
  incomeYearHref,
  missingFlagLink,
  missingFlagText,
  paymentCount,
  showsGross,
  sourceOrderNote,
  withoutGrossNote,
} from '@/features/income/presentation';

/**
 * The Income year view (blueprint 15.2 "Income", v2.1.20 30.23; ADR 0012 D1–D3).
 *
 * Every figure is income recorded, as the read stated it. A partial figure is a
 * lower bound and says what it leaves out; a gross appears only where some
 * payment in view recorded one, and says how many did not. Nothing here adds
 * or converts an amount.
 */

const CELL = 'py-2 pr-2 text-right sm:pr-4';
const HEAD = 'py-2 pr-2 text-right font-medium sm:pr-4';
/** The months table sits on the page, not in a card, so its sticky column wears the page's own background. */
const NAME = 'sticky left-0 z-10 bg-[var(--color-background)] py-2 pr-2 text-left font-normal sm:pr-4';

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

function grossNote(total: IncomeTotalDto): string {
  const note = withoutGrossNote(total.gross);
  return note === null
    ? `Every payment recorded a gross.`
    : `Covers ${String(total.count - total.gross.withoutGross)} of ${paymentCount(total.count)}; ${note}.`;
}

export function IncomeSummary({ page, formatting }: { readonly page: IncomePageDto; readonly formatting: Formatting }) {
  const { view, lastTwelveMonths } = page;
  const soFar = view.current ? ` (${SO_FAR})` : '';
  const window = `${monthTitle(lastTwelveMonths.from, formatting.locale)} – ${monthTitle(lastTwelveMonths.to, formatting.locale)}`;
  return (
    <div className="space-y-4" data-testid="income-summary">
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <SpendingFigure
          label={`${INCOME_RECORDED} in ${String(view.year)}${soFar}`}
          display={incomeFigureDisplay(view.total.net)}
          formatting={formatting}
          testId="income-total"
          emphasis
          note={paymentCount(view.total.count)}
        />
        <SpendingFigure
          label={TRACKED_LABEL}
          display={incomeFigureDisplay(view.tracked.net)}
          formatting={formatting}
          testId="income-tracked"
        />
        <SpendingFigure
          label={OUTSIDE_LABEL}
          display={incomeFigureDisplay(view.outside.net)}
          formatting={formatting}
          testId="income-outside"
          note="Received outside your tracked accounts. Recorded for information; it is in no savings figure."
        />
        <SpendingFigure
          label={`Last 12 months (${SO_FAR})`}
          display={incomeFigureDisplay(lastTwelveMonths.total.net)}
          formatting={formatting}
          testId="income-last-12"
          note={`${window}, whichever year is shown.`}
        />
        {view.total.gross.recorded === null ? null : (
          <SpendingFigure
            label={`Gross in ${String(view.year)}${soFar}`}
            display={incomeFigureDisplay(view.total.gross.recorded)}
            formatting={formatting}
            testId="income-gross-total"
            note={grossNote(view.total)}
          />
        )}
      </dl>
      <p className={META} data-testid="income-differs">
        {DIFFERS_FROM_MONTHLY}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Months                                                                      */
/* -------------------------------------------------------------------------- */

export function MonthsTable({
  months,
  formatting,
}: {
  readonly months: readonly IncomeMonthDto[];
  readonly formatting: Formatting;
}) {
  const gross = showsGross(months.map((month) => month.total));
  return (
    <div className="relative overflow-x-auto" data-testid="income-months-scroll">
      <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid="income-months">
        <caption className="sr-only">Income recorded each month, salary, bonus and other</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className={`${NAME} font-medium`}>Month</th>
            <th scope="col" className={HEAD}>{GROUP_LABEL.salary}</th>
            <th scope="col" className={HEAD}>{GROUP_LABEL.bonus}</th>
            <th scope="col" className={HEAD}>{GROUP_LABEL.other}</th>
            <th scope="col" className={HEAD}>Total</th>
            {gross ? <th scope="col" className={HEAD}>Gross</th> : null}
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr key={month.month} className="border-b last:border-0" data-testid="income-month" data-month={month.month}>
              <th scope="row" className={NAME}>
                {monthTitle(month.month, formatting.locale)}
                {month.current ? <span className={`block ${META}`}>{SO_FAR}</span> : null}
              </th>
              {[month.salary, month.bonus, month.other, month.total.net].map((amount, index) => (
                <td key={index} className={CELL}>
                  <Amount display={incomeFigureDisplay(amount)} formatting={formatting} />
                </td>
              ))}
              {gross ? <GrossCell gross={month.total.gross} formatting={formatting} className={CELL} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

export function SourcesTable({ page, formatting }: { readonly page: IncomePageDto; readonly formatting: Formatting }) {
  const { view } = page;
  if (view.sources.length === 0 && view.oneOff === null) {
    return (
      <p className={META} data-testid="income-sources-empty">
        No income source had a payment or an occurrence in {view.year}, and no payment arrived without one.
      </p>
    );
  }
  const gross = showsGross([...view.sources.map((row) => row.total), ...(view.oneOff === null ? [] : [view.oneOff.total])]);
  const note = sourceOrderNote(view.sourceOrder, page.reportingCurrency);
  return (
    <div className="space-y-2">
      {note === null ? null : (
        <p className={META} data-testid="income-source-order">
          {note}
        </p>
      )}
      <div className="relative overflow-x-auto" data-testid="income-sources-scroll">
        <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid="income-sources">
          <caption className="sr-only">Income recorded in {view.year}, by source</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Source</th>
              <th scope="col" className={HEAD}>Net ({page.reportingCurrency})</th>
              {gross ? <th scope="col" className={HEAD}>Gross ({page.reportingCurrency})</th> : null}
              <th scope="col" className={HEAD}>Payments</th>
            </tr>
          </thead>
          <tbody>
            {view.sources.map((row) => (
              <tr key={row.templateId} className="border-b last:border-0" data-testid="income-source" data-template-id={row.templateId}>
                <th scope="row" className="py-2 pr-2 text-left font-normal sm:pr-4">
                  {/* Plain text until the source page exists (ADR 0012 D9). */}
                  <span>{row.name}</span>
                  {row.archived ? (
                    <Badge tone="neutral" className="ml-2" data-testid="income-source-archived">
                      Archived
                    </Badge>
                  ) : null}
                </th>
                <td className={CELL}>
                  <Amount display={incomeFigureDisplay(row.total.net)} formatting={formatting} />
                  <NativeNote native={row.total.native} reportingCurrency={page.reportingCurrency} formatting={formatting} />
                </td>
                {gross ? <GrossCell gross={row.total.gross} formatting={formatting} className={CELL} /> : null}
                <td className={`${CELL} ${META}`}>{paymentCount(row.total.count)}</td>
              </tr>
            ))}
          </tbody>
          {view.oneOff === null ? null : (
            <OneOffRows
              oneOff={view.oneOff}
              showGross={gross}
              reportingCurrency={page.reportingCurrency}
              formatting={formatting}
            />
          )}
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Every year                                                                  */
/* -------------------------------------------------------------------------- */

export function YearsTable({ page, formatting }: { readonly page: IncomePageDto; readonly formatting: Formatting }) {
  const gross = showsGross(page.years.map((row) => row.total));
  return (
    <div className="relative overflow-x-auto" data-testid="income-years-scroll">
      <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid="income-years">
        <caption className="sr-only">Income recorded in every year with income</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Year</th>
            <th scope="col" className={HEAD}>{INCOME_RECORDED}</th>
            {gross ? <th scope="col" className={HEAD}>Gross</th> : null}
            <th scope="col" className={HEAD}>Payments</th>
          </tr>
        </thead>
        <tbody>
          {page.years.map((row) => (
            <tr key={row.year} className="border-b last:border-0" data-testid="income-year" data-year={row.year}>
              <th scope="row" className="py-2 pr-2 text-left font-normal sm:pr-4">
                <Link
                  href={incomeYearHref(row.year)}
                  className="underline"
                  aria-current={row.year === page.year ? 'page' : undefined}
                >
                  {row.year}
                </Link>
                {row.current ? <span className={`ml-1 ${META}`}>{SO_FAR}</span> : null}
              </th>
              <td className={CELL}>
                <Amount display={incomeFigureDisplay(row.total.net)} formatting={formatting} />
              </td>
              {gross ? <GrossCell gross={row.total.gross} formatting={formatting} className={CELL} /> : null}
              <td className={`${CELL} ${META}`}>{paymentCount(row.total.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Missing payments                                                            */
/* -------------------------------------------------------------------------- */

export function MissingPayments({ page, formatting }: { readonly page: IncomePageDto; readonly formatting: Formatting }) {
  const { view } = page;
  const { locale } = formatting;
  const monthName = (month: string): string => monthTitle(month, locale);
  const monthOnly = (date: string): string =>
    new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

  if (view.missing.length === 0) {
    return (
      <p className={META} data-testid="income-missing-none">
        {view.current && page.today.slice(5, 7) === '01'
          ? `No month of ${String(view.year)} has ended yet.`
          : `No scheduled payment is missing from ${String(view.year)}’s completed months.`}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="income-missing">
      {view.missing.map((flag) => {
        const link = missingFlagLink(flag, monthName);
        return (
          <li key={flag.templateId} className="space-y-1" data-testid="income-missing-flag" data-template-id={flag.templateId}>
            <p>
              {missingFlagText(flag, view.year, monthOnly)}
              {flag.archived ? (
                <Badge tone="neutral" className="ml-2">
                  Archived
                </Badge>
              ) : null}
            </p>
            {link === null ? (
              <p className={META} data-testid="income-missing-archived">
                {ARCHIVED_MISSING_HELP}
              </p>
            ) : (
              <Link href={link.href} className="text-[length:var(--text-meta)] underline" data-testid="income-missing-link" data-kind={link.kind}>
                {link.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
