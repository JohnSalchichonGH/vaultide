import Link from 'next/link';
import type { IncomeSourceOccurrenceDto, IncomeSourcePageDto } from '@vaultide/application';
import type { MoneyDto } from '@vaultide/finance/client';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { IncomeSourceChart } from '@/components/charts/income-source-chart';
import { ScrollRegion } from '@/components/ui/scroll-region';
import { META, type Formatting } from '@/features/spending/figure';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';
import { incomeKindLabel } from '@/features/monthly/income-presentation';
import { ChangeAmountFrom } from '@/features/income/source-editor';
import { sourceChartModel } from '@/features/income/source-chart-model';
import { missingFlagLink, missingFlagText, withoutGrossNote } from '@/features/income/presentation';
import {
  ARCHIVED_SOURCE_MISSING,
  NO_ACCOUNT,
  OCCURRENCE_STATE_LABEL,
  OCCURRENCE_STATE_TONE,
  canChangeAmount,
  historyGross,
  occurrenceLink,
  occurrencesGross,
  scheduleText,
  skipReasonText,
  sourceMissingFlag,
} from '@/features/income/source-presentation';

/**
 * The Income source page's read-only parts (blueprint 15.2 "Income source",
 * v2.1.20 30.23; ADR 0012 D2–D4, D6).
 *
 * Everything is in the source's own currency and arrives decided: no amount is
 * added, converted or compared here. A gross appears only where some term or
 * payment in view recorded one, and a missing gross is never shown as a zero.
 */

const CELL = 'py-2 pr-2 text-right sm:pr-4';
const HEAD = 'py-2 pr-2 text-right font-medium sm:pr-4';
const NAME = 'py-2 pr-2 text-left font-normal sm:pr-4';
const TABLE = 'w-full border-collapse text-[length:var(--text-table)]';

function Money({ value, formatting }: { readonly value: MoneyDto; readonly formatting: Formatting }) {
  return (
    <MoneyText
      amount={value.amount}
      currency={value.currency}
      locale={formatting.locale}
      minorUnits={formatting.minorUnitsByCurrency[value.currency] ?? 2}
      className="whitespace-nowrap"
    />
  );
}

/** A gross cell: the recorded amount, or that none was recorded — never a zero (30.23 item 4). */
function Gross({ value, formatting }: { readonly value: MoneyDto | null; readonly formatting: Formatting }) {
  return (
    <td className={CELL} data-testid="source-gross-cell">
      {value === null ? <span className={META}>No gross</span> : <Money value={value} formatting={formatting} />}
    </td>
  );
}

function WithoutGross({ count, testId }: { readonly count: number; readonly testId: string }) {
  const note = withoutGrossNote({ recorded: null, withoutGross: count });
  return note === null ? null : (
    <p className={META} data-testid={testId}>
      Gross: {note}.
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Details                                                                     */
/* -------------------------------------------------------------------------- */

export function SourceDetails({ page, locale }: { readonly page: IncomeSourcePageDto; readonly locale: string }) {
  const { source } = page;
  const rows: readonly [string, string, string][] = [
    ['Payer', source.counterparty ?? 'Not stated', 'payer'],
    ['Kind', incomeKindLabel(source.incomeKind), 'kind'],
    ['Currency', source.currency, 'currency'],
    ['Paid into', source.account?.name ?? NO_ACCOUNT, 'account'],
    ['Schedule', scheduleText(source), 'schedule'],
    ['Starts', dayTitle(source.startDate, locale), 'start'],
    ['Ends', source.endDate === null ? 'No end date' : dayTitle(source.endDate, locale), 'end'],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="source-details">
      {rows.map(([label, value, key]) => (
        <div key={key} className="min-w-0" data-testid={`source-detail-${key}`}>
          <dt className={META}>{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Amount history (30.23 item 7)                                               */
/* -------------------------------------------------------------------------- */

export function AmountHistory({ page, formatting }: { readonly page: IncomeSourcePageDto; readonly formatting: Formatting }) {
  const day = (date: string): string => dayTitle(date, formatting.locale);
  const gross = historyGross(page);
  return (
    <div className="space-y-3">
      <IncomeSourceChart {...sourceChartModel(page, formatting.locale)} />
      <details className="group" data-testid="source-history-details">
        <summary className="cursor-pointer text-[length:var(--text-meta)] underline" data-testid="source-history-view-table">
          View as table
        </summary>
        <div className="space-y-4 pt-2">
          <ScrollRegion label={`The amounts ${page.source.name} was set to, oldest first`} className="relative overflow-x-auto">
            <table className={TABLE} data-testid="source-terms">
              <caption className="sr-only">The amounts {page.source.name} was set to, oldest first</caption>
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Amount from</th>
                  <th scope="col" className={HEAD}>Net</th>
                  {gross.show ? <th scope="col" className={HEAD}>Gross</th> : null}
                  <th scope="col" className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {page.terms.map((term) => (
                  <tr key={term.effectiveFrom} className="border-b last:border-0" data-testid="source-term" data-effective-from={term.effectiveFrom}>
                    <th scope="row" className={NAME}>{day(term.effectiveFrom)}</th>
                    <td className={CELL}>
                      <Money value={term.net} formatting={formatting} />
                    </td>
                    {gross.show ? <Gross value={term.gross} formatting={formatting} /> : null}
                    <td className={`py-2 ${META}`}>{term.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          {page.arrivals.length === 0 ? (
            <p className={META} data-testid="source-arrivals-none">
              Nothing has been received from this source yet.
            </p>
          ) : (
            <ScrollRegion label={`What arrived for each of ${page.source.name}’s payments, against the amount set for it`} className="relative overflow-x-auto">
              <table className={TABLE} data-testid="source-arrivals">
                <caption className="sr-only">What arrived for each of {page.source.name}’s payments, against the amount set for it</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Scheduled</th>
                    <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Arrived</th>
                    <th scope="col" className={HEAD}>Received</th>
                    {gross.show ? <th scope="col" className={HEAD}>Gross</th> : null}
                    <th scope="col" className={HEAD}>Set at</th>
                  </tr>
                </thead>
                <tbody>
                  {page.arrivals.map(({ payment, term }) => (
                    <tr key={payment.entryId} className="border-b last:border-0" data-testid="source-arrival" data-occurrence-date={payment.occurrenceDate}>
                      <th scope="row" className={NAME}>{day(payment.occurrenceDate)}</th>
                      <td className="py-2 pr-2 sm:pr-4">{day(payment.receivedOn)}</td>
                      <td className={CELL}>
                        <Money value={payment.net} formatting={formatting} />
                      </td>
                      {gross.show ? <Gross value={payment.gross} formatting={formatting} /> : null}
                      <td className={CELL}>
                        {term.net === null ? <span className={META}>No amount set</span> : <Money value={term.net} formatting={formatting} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
          {gross.show ? <WithoutGross count={gross.withoutGross} testId="source-history-without-gross" /> : null}
        </div>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Occurrences by year                                                         */
/* -------------------------------------------------------------------------- */

function OccurrenceAmount({ occurrence, formatting }: { readonly occurrence: IncomeSourceOccurrenceDto; readonly formatting: Formatting }) {
  const { state, term } = occurrence;
  if (state.kind === 'received') return <Money value={state.payment.net} formatting={formatting} />;
  if (state.kind === 'skipped') return <span className={META}>—</span>;
  return (
    <>
      {term.net === null ? <span className={META}>No amount set</span> : <Money value={term.net} formatting={formatting} />}
      <span className={`block ${META}`}>Expected</span>
    </>
  );
}

export function SourceOccurrences({ page, formatting }: { readonly page: IncomeSourcePageDto; readonly formatting: Formatting }) {
  const { source, occurrences, year } = page;
  const { locale } = formatting;
  const day = (date: string): string => dayTitle(date, locale);
  const monthName = (month: string): string => monthTitle(month, locale);
  const monthOnly = (date: string): string =>
    new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

  if (occurrences.length === 0) {
    return (
      <p className={META} data-testid="source-occurrences-none">
        The schedule places no payment in {year}.
      </p>
    );
  }

  const flag = sourceMissingFlag(page);
  const flagLink = flag === null || flag.archived ? null : missingFlagLink(flag, monthName);
  const gross = occurrencesGross(occurrences);
  const changes = canChangeAmount(source);

  return (
    <div className="space-y-3">
      {flag === null ? null : (
        <div className="space-y-1" data-testid="source-missing" data-archived={flag.archived ? 'true' : 'false'}>
          <p>{missingFlagText(flag, year, monthOnly)}</p>
          {flag.archived ? (
            <p className={META} data-testid="source-missing-archived">
              {ARCHIVED_SOURCE_MISSING.reason}{' '}
              <a href={ARCHIVED_SOURCE_MISSING.unarchive.href} className="underline" data-testid="source-missing-unarchive">
                {ARCHIVED_SOURCE_MISSING.unarchive.label}
              </a>
              {ARCHIVED_SOURCE_MISSING.ifEnded}{' '}
              <a href={ARCHIVED_SOURCE_MISSING.endDate.href} className="underline" data-testid="source-missing-end-date">
                {ARCHIVED_SOURCE_MISSING.endDate.label}
              </a>{' '}
              {ARCHIVED_SOURCE_MISSING.before}
            </p>
          ) : flagLink === null ? null : (
            <Link href={flagLink.href} className="text-[length:var(--text-meta)] underline" data-testid="source-missing-link" data-kind={flagLink.kind}>
              {flagLink.label}
            </Link>
          )}
        </div>
      )}

      <div className="relative overflow-x-auto" data-testid="source-occurrences-scroll">
        <table className={TABLE} data-testid="source-occurrences">
          <caption className="sr-only">
            {source.name}’s scheduled payments in {year}, and what became of each
          </caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Scheduled</th>
              <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Status</th>
              <th scope="col" className={HEAD}>Net</th>
              {gross.show ? <th scope="col" className={HEAD}>Gross</th> : null}
              {changes ? (
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Change the amount</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {occurrences.map((occurrence) => {
              const { state } = occurrence;
              const link = occurrenceLink(occurrence, source.templateId, flag, monthName);
              const shownGross =
                state.kind === 'received' ? state.payment.gross : state.kind === 'skipped' ? undefined : occurrence.term.gross;
              return (
                <tr
                  key={occurrence.occurrenceDate}
                  className="border-b align-top last:border-0"
                  data-testid="source-occurrence"
                  data-occurrence-date={occurrence.occurrenceDate}
                  data-state={state.kind}
                >
                  <th scope="row" className={`${NAME} whitespace-nowrap`}>{day(occurrence.occurrenceDate)}</th>
                  <td className="py-2 pr-2 sm:pr-4">
                    <Badge tone={OCCURRENCE_STATE_TONE[state.kind]} data-testid="source-occurrence-status">
                      {OCCURRENCE_STATE_LABEL[state.kind]}
                    </Badge>
                    {state.kind === 'received' && state.payment.receivedOn !== occurrence.occurrenceDate ? (
                      <span className={`block ${META}`} data-testid="source-occurrence-arrived">
                        Arrived {day(state.payment.receivedOn)}
                      </span>
                    ) : null}
                    {state.kind === 'skipped' ? (
                      <span className={`block ${META}`} data-testid="source-occurrence-reason">
                        {skipReasonText(state.reason, state.note)}
                      </span>
                    ) : null}
                    {link === null ? null : (
                      <Link href={link.href} className={`block underline ${META}`} data-testid="source-occurrence-link" data-kind={link.kind}>
                        {link.label}
                      </Link>
                    )}
                  </td>
                  <td className={CELL}>
                    <OccurrenceAmount occurrence={occurrence} formatting={formatting} />
                  </td>
                  {gross.show ? (
                    shownGross === undefined ? (
                      <td className={CELL} />
                    ) : (
                      <Gross value={shownGross} formatting={formatting} />
                    )
                  ) : null}
                  {changes ? (
                    <td className="py-2">
                      <ChangeAmountFrom
                        templateId={source.templateId}
                        occurrenceDate={occurrence.occurrenceDate}
                        currency={source.currency}
                        term={occurrence.term}
                        formatting={formatting}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {gross.show ? <WithoutGross count={gross.withoutGross} testId="source-occurrences-without-gross" /> : null}
    </div>
  );
}
