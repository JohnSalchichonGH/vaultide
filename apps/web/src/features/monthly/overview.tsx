import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  ReportingCashFlowFiguresDto,
  ReportingSavingsRateDto,
} from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPercent } from '@/lib/format';
import {
  CLOSE_STATE_LABEL,
  COMPLETENESS_LABEL,
  COMPLETENESS_TONE,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_TONE,
  completenessMeaning,
  dayTitle,
  savingsRateReason,
  stateLabel,
  type IssuePresentation,
} from '@/features/monthly/presentation';
import { ReportingFigure } from '@/features/monthly/reporting-figure';
import { MarkReviewedButton } from '@/features/monthly/review-controls';

/**
 * The Monthly Overview (blueprint 15.3 section 1).
 *
 * Phase 3's reachable figures in the reporting currency — income, tracked,
 * unclassified, additional and total spending, saved from income, personal
 * savings and the savings rate, with paid-by-others as a memo in no total —
 * each with its own availability. The rows later phases bring (invested,
 * investment performance, mortgage principal) are not drawn at all rather than
 * drawn as zero.
 */

type FigureKey = keyof Pick<
  ReportingCashFlowFiguresDto,
  | 'externalIncome'
  | 'trackedTotalSpending'
  | 'unclassified'
  | 'additionalSpending'
  | 'totalSpending'
  | 'trackedSavingsFromIncome'
  | 'personalSavings'
>;

const FIGURES: readonly { key: FigureKey; label: string; note?: string; emphasis?: boolean }[] = [
  { key: 'externalIncome', label: 'Income', emphasis: true },
  { key: 'trackedTotalSpending', label: 'Tracked spending', emphasis: true },
  {
    key: 'unclassified',
    label: 'Unclassified spending',
    note: 'Inferred from the balances: spending nobody recorded.',
  },
  {
    key: 'additionalSpending',
    label: 'Additional spending',
    note: 'Paid by you from outside your tracked accounts.',
  },
  { key: 'totalSpending', label: 'Total spending', note: 'Tracked plus additional spending.' },
  {
    key: 'trackedSavingsFromIncome',
    label: 'Saved from income',
    note: 'What your income left in tracked accounts.',
  },
  { key: 'personalSavings', label: 'Personal savings' },
];

function SavingsRate({
  rate,
  countsAdditionalSpending,
  locale,
}: {
  readonly rate: ReportingSavingsRateDto;
  readonly countsAdditionalSpending: boolean;
  readonly locale: string;
}) {
  return (
    <div className="space-y-1" data-testid="figure-savingsRate">
      <dt className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">Savings rate</dt>
      <dd className="space-y-1">
        {rate.kind === 'ratio' ? (
          <span className="tabular">{formatPercent(rate.value, { locale })}</span>
        ) : (
          <>
            <span className="tabular text-[var(--color-unavailable)]" aria-label="Not available">
              —
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="unavailable">Unavailable</Badge>
              <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                {savingsRateReason(rate.reason, rate.detail)}
              </span>
            </div>
          </>
        )}
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          {countsAdditionalSpending
            ? 'Counts spending you paid from outside tracked accounts.'
            : 'Tracked accounts only.'}
        </p>
      </dd>
    </div>
  );
}

function Figures({
  figures,
  locale,
  minorUnits,
}: {
  readonly figures: ReportingCashFlowFiguresDto;
  readonly locale: string;
  readonly minorUnits: number;
}) {
  return (
    <>
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        {FIGURES.map((figure) => (
          <ReportingFigure
            key={figure.key}
            label={figure.label}
            amount={figures[figure.key]}
            locale={locale}
            minorUnits={minorUnits}
            testId={`figure-${figure.key}`}
            {...(figure.note === undefined ? {} : { note: figure.note })}
            {...(figure.emphasis === true ? { emphasis: true } : {})}
          />
        ))}
        <SavingsRate
          rate={figures.savingsRate}
          countsAdditionalSpending={figures.countsAdditionalSpending}
          locale={locale}
        />
      </dl>
      <dl className="border-t pt-4">
        <ReportingFigure
          label="Paid by others"
          amount={figures.thirdPartyPaid}
          locale={locale}
          minorUnits={minorUnits}
          testId="figure-thirdPartyPaid"
          note="Informational: paid by someone else, and in no total."
        />
      </dl>
    </>
  );
}

function IssueCounts({ issues }: { readonly issues: IssuePresentation }) {
  const count = (issueClass: string) =>
    issues.active.filter((group) => group.issueClass === issueClass).length;
  const blocking = count('blocking');
  const advisory = count('advisory');
  if (blocking === 0 && advisory === 0) {
    return (
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]" data-testid="issue-counts">
        No open issues.
      </p>
    );
  }
  return (
    <p className="text-[length:var(--text-meta)]" data-testid="issue-counts">
      <a href="#issues" className="underline">
        {blocking > 0 ? `${String(blocking)} blocking` : null}
        {blocking > 0 && advisory > 0 ? ' · ' : null}
        {advisory > 0 ? `${String(advisory)} advisory` : null}
        {' — see the issues'}
      </a>
    </p>
  );
}

function reviewedOn(instant: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(instant));
}

export function CompletedOverview({
  page,
  locale,
  timeZone,
  monthName,
  issues,
}: {
  readonly page: CompletedMonthlyPageDto;
  readonly locale: string;
  readonly timeZone: string;
  readonly monthName: string;
  readonly issues: IssuePresentation;
}) {
  const { reporting, reconciliation, completeness, review } = page;
  const minorUnits = page.minorUnitsByCurrency[reporting.reportingCurrency] ?? 2;
  const status = reconciliation.status;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>
            In {reporting.reportingCurrency}, converted from what each record holds in its own currency.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-center gap-3" data-testid="reconciliation-status">
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
            <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              {STATUS_MEANING[status]}
            </span>
          </div>
          <IssueCounts issues={issues} />
          <Figures figures={reporting} locale={locale} minorUnits={minorUnits} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="completeness">
          <CardHeader>
            <CardTitle>Completeness</CardTitle>
            <CardDescription>
              Whether {monthName} holds the evidence it needs. Separate from reconciliation: it
              changes no figure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={COMPLETENESS_TONE[completeness.state]} data-testid="completeness-state">
                {COMPLETENESS_LABEL[completeness.state]}
              </Badge>
              <span className="tabular" data-testid="completeness-count">
                {completeness.satisfied} of {completeness.required}{' '}
                {completeness.required === 1 ? 'requirement' : 'requirements'} met
                {completeness.ratio === null
                  ? ''
                  : ` (${formatPercent(completeness.ratio, { locale, fractionDigits: 0 })})`}
              </span>
            </div>
            <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              {completenessMeaning(completeness.state, completeness.required)}
            </p>
            {completeness.cashAccounts.length + completeness.recurringOccurrences.length === 0 ? null : (
              <ul className="space-y-1 text-[length:var(--text-table)]" data-testid="completeness-items">
                {completeness.cashAccounts.map((item) => (
                  <li key={item.positionId} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {item.name} <span className="text-[var(--color-muted-foreground)]">({item.currency})</span>
                    </span>
                    <span className={item.satisfied ? '' : 'text-[var(--color-negative)]'}>
                      {item.satisfied ? 'Met' : 'Missing'} · {stateLabel(CLOSE_STATE_LABEL, item.closeState)}
                    </span>
                  </li>
                ))}
                {completeness.recurringOccurrences.map((item) => (
                  <li
                    key={`${item.templateId}#${item.occurrenceDate}`}
                    className="flex flex-wrap justify-between gap-2"
                  >
                    <span>
                      {item.templateName}{' '}
                      <span className="text-[var(--color-muted-foreground)]">
                        ({item.templateKind === 'expense' ? 'expense' : 'income'},{' '}
                        {dayTitle(item.occurrenceDate, locale)})
                      </span>
                    </span>
                    <span className={item.satisfied ? '' : 'text-[var(--color-negative)]'}>
                      {item.satisfied ? 'Recorded or skipped' : 'Not recorded'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card data-testid="review">
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>
              Marking a month reviewed records that you looked at it. It does not lock the month,
              change any figure, or make missing evidence complete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {review.reviewedAt === null ? (
              <MarkReviewedButton month={page.month} />
            ) : (
              <p data-testid="reviewed-at">
                <Badge tone="positive">Reviewed</Badge>{' '}
                <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                  on <time dateTime={review.reviewedAt}>{reviewedOn(review.reviewedAt, locale, timeZone)}</time>
                </span>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function CurrentOverview({
  page,
  locale,
  issues,
}: {
  readonly page: CurrentMonthlyPageDto;
  readonly locale: string;
  readonly issues: IssuePresentation;
}) {
  const { reporting, monthToDate } = page;
  const minorUnits = page.minorUnitsByCurrency[reporting.reportingCurrency] ?? 2;
  const newerBalances = issues.active.some((group) => group.key === 'mtd_newer_balances');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
        <CardDescription>
          In {reporting.reportingCurrency}. This month is in progress and closes on{' '}
          {dayTitle(page.monthEndsOn, locale)}; nothing here is final.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {reporting.kind === 'tracked_interval' ? (
          <>
            <div className="flex flex-wrap items-center gap-3" data-testid="mtd-as-of">
              <Badge tone={STATUS_TONE[monthToDate.status]}>{STATUS_LABEL[monthToDate.status]}</Badge>
              <span>
                Month to date through{' '}
                <time dateTime={reporting.asOf} className="font-medium">
                  {dayTitle(reporting.asOf, locale)}
                </time>
                , the latest day every cash account shares.
              </span>
            </div>
            {newerBalances ? (
              <p className="text-[length:var(--text-meta)] text-[var(--color-warning)]" data-testid="mtd-newer-note">
                Some accounts have newer individual balances; update all accounts to move the
                month-to-date date forward.
              </p>
            ) : null}
            <IssueCounts issues={issues} />
            <Figures figures={reporting} locale={locale} minorUnits={minorUnits} />
          </>
        ) : (
          <>
            <div className="space-y-2" data-testid="mtd-no-common-date">
              <Badge tone="unavailable">No month-to-date figure</Badge>
              <p>
                Update all cash accounts to the same date to calculate month-to-date spending. Until
                then there is no tracked spending, unclassified spending or savings figure for this
                month — not even a zero.
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                These two need no common date, so they run through{' '}
                <time dateTime={reporting.sourceOnlyThrough}>
                  {dayTitle(reporting.sourceOnlyThrough, locale)}
                </time>
                .
              </p>
              <dl className="grid gap-6 sm:grid-cols-2">
                <ReportingFigure
                  label="Additional spending"
                  amount={reporting.additionalSpending}
                  locale={locale}
                  minorUnits={minorUnits}
                  testId="figure-additionalSpending"
                  note="Paid by you from outside your tracked accounts."
                />
                <ReportingFigure
                  label="Paid by others"
                  amount={reporting.thirdPartyPaid}
                  locale={locale}
                  minorUnits={minorUnits}
                  testId="figure-thirdPartyPaid"
                  note="Informational: paid by someone else, and in no total."
                />
              </dl>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
