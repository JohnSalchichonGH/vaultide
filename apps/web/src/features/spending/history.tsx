import Link from 'next/link';
import type {
  SpendingHistoryRowDto,
  SpendingRollingDto,
  SpendingSpanDto,
} from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { formatPercent } from '@/lib/format';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';
import { Amount, META, type Formatting } from '@/features/spending/figure';
import {
  MONTH_STATE_LABEL,
  MONTH_STATE_TONE,
  monthStateOf,
  monthlyHref,
  rollingCount,
  rollingTitle,
  savingsRateDisplay,
  spendingFigureDisplay,
  spendingHref,
} from '@/features/spending/presentation';

/**
 * Rolling averages, the monthly history and the combined periods (blueprint
 * 15.2 "Spending", 8.7, 30.15 item 5; ADR 0008 §2, §8).
 *
 * The history is a table because the table is the exact data: the chart above
 * it draws the same rows, and this is its alternative (16.6). A month covered by
 * a combined period keeps its own empty figures and points at the period; the
 * period is never divided back into it.
 */

export function RollingCards({
  rolling,
  formatting,
}: {
  readonly rolling: SpendingRollingDto;
  readonly formatting: Formatting;
}) {
  const through = monthTitle(rolling.displayMonth, formatting.locale);
  return (
    <div className="space-y-2" data-testid="spending-rolling">
      <p className={META}>
        Tracked spending only, over fixed calendar months. A month counts only when it is reliable
        and fully converted; a month that does not qualify keeps its place, and the current month
        never counts.
        {rolling.endsBeforeFocus ? ` These windows end at ${through}, the last completed month.` : null}
      </p>
      <dl className="grid gap-4 sm:grid-cols-3">
        {rolling.windows.map((window) => (
          <div
            key={window.months}
            className="space-y-1 rounded-[var(--radius-card,8px)] border p-3"
            data-testid={`spending-rolling-${String(window.months)}`}
          >
            <dt className={META}>
              {rollingTitle(window.months)}
              {rolling.endsBeforeFocus ? <span> · through {through}</span> : null}
            </dt>
            <dd className="space-y-1">
              <div className="tabular text-[length:var(--text-section)] font-semibold">
                {window.average === null ? (
                  <MoneyText amount={null} unavailableReason="No month in this window qualified." />
                ) : (
                  <MoneyText
                    amount={window.average.value.amount}
                    currency={window.average.value.currency}
                    locale={formatting.locale}
                    minorUnits={formatting.minorUnitsByCurrency[window.average.value.currency] ?? 2}
                  />
                )}
              </div>
              <p className={META} data-testid={`spending-rolling-${String(window.months)}-count`}>
                {rollingCount(window.average?.count ?? null, window.months)}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function spanLabel(span: SpendingSpanDto, locale: string): string {
  return `${dayTitle(span.from, locale)} – ${dayTitle(span.to, locale)}`;
}

const CELL = 'py-2 pr-2 text-right sm:pr-4';

function MoneyCell({
  amount,
  formatting,
  testId,
}: {
  readonly amount: SpendingHistoryRowDto['tracked'];
  readonly formatting: Formatting;
  readonly testId: string;
}) {
  return (
    <td className={CELL} data-testid={testId}>
      {amount === null ? (
        <MoneyText amount={null} unavailableReason="There is no interval to state this over yet." />
      ) : (
        <Amount display={spendingFigureDisplay(amount)} formatting={formatting} className="tabular" />
      )}
    </td>
  );
}

export function HistoryTable({
  history,
  focusMonth,
  formatting,
}: {
  readonly history: readonly SpendingHistoryRowDto[];
  readonly focusMonth: string;
  readonly formatting: Formatting;
}) {
  const { locale } = formatting;
  return (
    <div className="relative overflow-x-auto" data-testid="spending-history-scroll">
      <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid="spending-history">
        <caption className="sr-only">
          Spending month by month, oldest first, in your reporting currency
        </caption>
        <thead>
          <tr className="border-b text-left text-[var(--color-muted-foreground)]">
            <th scope="col" className="sticky left-0 z-10 bg-[var(--color-surface)] py-2 pr-2 font-medium sm:pr-4">
              Month
            </th>
            <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Status</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Tracked</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Known</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Unclassified</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Additional</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Total</th>
            <th scope="col" className="py-2 pr-2 text-right font-medium sm:pr-4">Savings rate</th>
            <th scope="col" className="py-2 pr-2 font-medium sm:pr-4">Rolling</th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">Open in Monthly</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {history.map((row) => {
            const state = monthStateOf(row);
            const rate = savingsRateDisplay(row.savingsRate);
            const name = monthTitle(row.month, locale);
            return (
              <tr
                key={row.month}
                className="border-b align-top last:border-0"
                data-testid="spending-history-row"
                data-month={row.month}
                data-state={state}
                aria-current={row.month === focusMonth ? 'true' : undefined}
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-[var(--color-surface)] py-2 pr-2 text-left font-normal whitespace-nowrap sm:pr-4"
                >
                  <Link href={spendingHref(row.month)} className={row.month === focusMonth ? 'font-semibold underline' : 'underline'}>
                    {name}
                  </Link>
                  {row.asOf === null ? null : (
                    <span className={`block ${META}`}>through {dayTitle(row.asOf, locale)}</span>
                  )}
                </th>
                <td className="py-2 pr-2 sm:pr-4">
                  <Badge tone={MONTH_STATE_TONE[state]}>{MONTH_STATE_LABEL[state]}</Badge>
                  {row.spans.length === 0 ? null : (
                    <a href={`#span-${row.spans[0] ?? ''}`} className={`block underline ${META}`} data-testid="spending-history-span-link">
                      In a combined period
                    </a>
                  )}
                </td>
                <MoneyCell amount={row.tracked} formatting={formatting} testId="history-tracked" />
                <MoneyCell amount={row.known} formatting={formatting} testId="history-known" />
                <MoneyCell amount={row.unclassified} formatting={formatting} testId="history-unclassified" />
                <MoneyCell amount={row.additional} formatting={formatting} testId="history-additional" />
                <MoneyCell amount={row.total} formatting={formatting} testId="history-total" />
                <td className={CELL} data-testid="history-savings-rate">
                  {rate.kind === 'value' ? (
                    <span className="tabular">{formatPercent(rate.ratio, { locale })}</span>
                  ) : (
                    <MoneyText amount={null} unavailableReason={rate.reason} />
                  )}
                </td>
                <td className="py-2 pr-2 sm:pr-4" data-testid="history-rolling">
                  {row.rollingEligible ? (
                    <span>Counts</span>
                  ) : (
                    <span className="text-[var(--color-muted-foreground)]">Does not count</span>
                  )}
                </td>
                <td className="py-2">
                  <Link href={monthlyHref(row.month)} className="underline whitespace-nowrap" data-testid="history-open-month">
                    Open<span className="sr-only"> {name} in Monthly</span>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CombinedPeriods({
  spans,
  formatting,
}: {
  readonly spans: readonly SpendingSpanDto[];
  readonly formatting: Formatting;
}) {
  const { locale } = formatting;
  if (spans.length === 0) {
    return (
      <p className={META} data-testid="spending-spans-empty">
        No combined period in this window. When a month is missing its month-end balances, the
        months around it can still be reconciled together once balances either side exist.
      </p>
    );
  }
  const money = (amount: SpendingSpanDto['trackedTotalSpending']) => (
    <MoneyText
      amount={amount.amount}
      currency={amount.currency}
      locale={locale}
      minorUnits={formatting.minorUnitsByCurrency[amount.currency] ?? 2}
    />
  );
  return (
    <div className="space-y-4" data-testid="spending-spans">
      <p className={META}>
        Where month-end balances are missing, Vaultide reconciles the months together. The result is
        one figure for the whole period, in its own currency — never divided into months, never
        averaged, and never counted in rolling.
      </p>
      {spans.map((span) => (
        <section
          key={span.key}
          id={`span-${span.key}`}
          className="scroll-mt-20 space-y-2 rounded-[var(--radius-card,8px)] border p-4"
          data-testid="spending-span"
          aria-label={`Combined period ${spanLabel(span, locale)}, ${span.currency}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">
              Combined period · {spanLabel(span, locale)}
            </h3>
            <Badge tone="neutral">{span.currency}</Badge>
            <Badge tone={span.status === 'reliable' ? 'positive' : 'negative'}>
              {span.status === 'reliable' ? 'Reliable' : 'Unresolved'}
            </Badge>
            <span className={META}>{span.months.length} months</span>
          </div>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
            <div>
              <dt className={META}>Tracked</dt>
              <dd className="tabular" data-testid="span-tracked">
                {span.status === 'reliable' ? (
                  money(span.trackedTotalSpending)
                ) : (
                  <MoneyText
                    amount={null}
                    unavailableReason="The records contradict the balances over this period; spending was at least the known amount."
                  />
                )}
              </dd>
            </div>
            <div>
              <dt className={META}>Known</dt>
              <dd className="tabular" data-testid="span-known">{money(span.totals.knownTrackedExpenses)}</dd>
            </div>
            <div>
              <dt className={META}>Unclassified</dt>
              <dd className="tabular" data-testid="span-unclassified">
                {span.status === 'reliable' ? (
                  money(span.unclassified)
                ) : (
                  <MoneyText amount={null} unavailableReason="The records contradict the balances over this period." />
                )}
              </dd>
            </div>
          </dl>
          <p className={META}>
            The months inside have no figure of their own: {span.months.map((month) => monthTitle(month, locale)).join(', ')}.
          </p>
        </section>
      ))}
    </div>
  );
}
