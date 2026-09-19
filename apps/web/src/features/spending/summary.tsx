import Link from 'next/link';
import type {
  ReportingCashFlowFiguresDto,
  SpendingBucketDto,
  SpendingFocusDto,
} from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { dayTitle } from '@/features/monthly/presentation';
import { META, RateFigure, SpendingFigure, type Formatting } from '@/features/spending/figure';
import {
  MONTH_STATE_LABEL,
  MONTH_STATE_TONE,
  bucketProblem,
  focusAnchorOf,
  monthStateMeaning,
  monthStateOf,
  monthlyHref,
  savingsFigureDisplay,
  savingsRateDisplay,
  spendingFigureDisplay,
} from '@/features/spending/presentation';

/**
 * The focus month's summary (blueprint 15.2 "Spending", 12.5; ADR 0008 §5).
 *
 * Total spending is the headline where it exists; tracked spending with its
 * known and unclassified parts, additional spending, the three savings figures
 * and paid-by-others as a memo follow. Every number is the read's, and each says
 * whether it is exact, a lower bound, or not available — and why.
 */

function stateOf(focus: SpendingFocusDto) {
  if (focus.shape === 'current' && focus.asOf === null) return 'no_common_date' as const;
  return monthStateOf({
    shape: focus.shape,
    asOf: focus.shape === 'current' ? focus.asOf : null,
    observed: focus.observed,
    status: focus.status,
  });
}

function Problems({
  buckets,
  formatting,
}: {
  readonly buckets: readonly SpendingBucketDto[];
  readonly formatting: Formatting;
}) {
  const problems = buckets.map(bucketProblem).filter((line): line is string => line !== null);
  const inflows = buckets.filter((bucket) => bucket.unexplainedInflow !== null);
  const firstBalance = buckets.filter(
    (bucket) => bucket.cause === null && bucket.firstBalanceAccounts.length > 0,
  );
  if (problems.length === 0 && inflows.length === 0 && firstBalance.length === 0) return null;
  return (
    <ul className="space-y-1 text-[length:var(--text-table)]" data-testid="spending-problems">
      {problems.map((line) => (
        <li key={line}>{line}</li>
      ))}
      {inflows.map((bucket) =>
        bucket.unexplainedInflow === null ? null : (
          <li key={`inflow-${bucket.currency}`} data-testid="spending-unexplained-inflow">
            {bucket.unexplainedInflow.variant === 'a'
              ? 'Cash grew more than your records explain by '
              : 'Your known expenses exceed the cash that left by '}
            <MoneyText
              amount={bucket.unexplainedInflow.amount.amount}
              currency={bucket.currency}
              locale={formatting.locale}
              minorUnits={formatting.minorUnitsByCurrency[bucket.currency] ?? 2}
              className="font-medium"
            />
            {bucket.unexplainedInflow.variant === 'a'
              ? ' — an income may be missing.'
              : ' — an inflow may be missing, or an expense was paid from outside tracked cash.'}
          </li>
        ),
      )}
      {firstBalance.map((bucket) => (
        <li key={`first-${bucket.currency}`}>
          {bucket.firstBalanceAccounts.join(', ')} started being tracked this month; its earlier
          movements are not included.
        </li>
      ))}
    </ul>
  );
}

function TrackedFigures({
  figures,
  formatting,
  countsAdditionalSpending,
}: {
  readonly figures: ReportingCashFlowFiguresDto;
  readonly formatting: Formatting;
  readonly countsAdditionalSpending: boolean;
}) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <SpendingFigure
          label="Total spending"
          display={spendingFigureDisplay(figures.totalSpending)}
          formatting={formatting}
          testId="spending-total"
          note="Tracked plus additional spending. Paid by others is not in it."
          emphasis
        />
        <SpendingFigure
          label="Tracked spending"
          display={spendingFigureDisplay(figures.trackedTotalSpending)}
          formatting={formatting}
          testId="spending-tracked"
          note="What your tracked cash says was spent."
        />
        <SpendingFigure
          label="Known"
          display={spendingFigureDisplay(figures.knownTrackedSpending)}
          formatting={formatting}
          testId="spending-known"
          note="Tracked spending you recorded as known expenses."
        />
        <SpendingFigure
          label="Unclassified"
          display={spendingFigureDisplay(figures.unclassified)}
          formatting={formatting}
          testId="spending-unclassified"
          note="Inferred from your balances: spending nobody recorded."
        />
        <SpendingFigure
          label="Additional spending"
          display={spendingFigureDisplay(figures.additionalSpending)}
          formatting={formatting}
          testId="spending-additional"
          note="Paid by you from outside your tracked accounts."
        />
      </dl>

      <div className="space-y-2">
        <h3 className="text-[length:var(--text-table)] font-semibold">What tracked spending was made of</h3>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <SpendingFigure
            label="Consumption"
            display={spendingFigureDisplay(figures.consumption)}
            formatting={formatting}
            testId="spending-consumption"
            note="Known consumption plus unclassified spending."
          />
          <SpendingFigure
            label="Interest and fees"
            display={spendingFigureDisplay(figures.interestAndFees)}
            formatting={formatting}
            testId="spending-fees"
          />
          <SpendingFigure
            label="Transaction costs"
            display={spendingFigureDisplay(figures.transactionCosts)}
            formatting={formatting}
            testId="spending-transaction-costs"
          />
          <SpendingFigure
            label="Money out of tracked accounts"
            display={spendingFigureDisplay(figures.externalOutflows)}
            formatting={formatting}
            testId="spending-money-out"
            note="Tracked spending, not consumption, and not subtracted from saved from income."
          />
        </dl>
      </div>

      <dl className="grid gap-x-6 gap-y-5 border-t pt-4 sm:grid-cols-3">
        <SpendingFigure
          label="Saved from income"
          display={savingsFigureDisplay(figures.trackedSavingsFromIncome)}
          formatting={formatting}
          testId="spending-saved-from-income"
          note="What your income left in tracked accounts."
        />
        <SpendingFigure
          label="Personal savings"
          display={savingsFigureDisplay(figures.personalSavings)}
          formatting={formatting}
          testId="spending-personal-savings"
          note={
            countsAdditionalSpending
              ? 'Saved from income, less spending you paid from outside tracked accounts.'
              : 'Saved from income; your setting leaves spending from outside tracked accounts out.'
          }
        />
        <RateFigure
          label="Savings rate"
          display={savingsRateDisplay(figures.savingsRate)}
          locale={formatting.locale}
          testId="spending-savings-rate"
          note={countsAdditionalSpending ? 'Counts spending you paid from outside tracked accounts.' : 'Tracked accounts only.'}
        />
      </dl>

      <dl className="border-t pt-4">
        <SpendingFigure
          label="Paid by others · memo"
          display={spendingFigureDisplay(figures.thirdPartyPaid)}
          formatting={formatting}
          testId="spending-paid-by-others"
          note="Paid by someone else. Informational, and in no spending or savings figure."
        />
      </dl>
    </div>
  );
}

export function FocusSummary({
  focus,
  monthName,
  formatting,
  countsAdditionalSpending,
}: {
  readonly focus: SpendingFocusDto;
  readonly monthName: string;
  readonly formatting: Formatting;
  readonly countsAdditionalSpending: boolean;
}) {
  const state = stateOf(focus);
  const anchor = focusAnchorOf(focus);

  return (
    <div className="space-y-6" data-testid="spending-summary" data-state={state}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3" data-testid="spending-status">
          <Badge tone={MONTH_STATE_TONE[state]}>{MONTH_STATE_LABEL[state]}</Badge>
          {focus.shape === 'current' && focus.asOf !== null ? (
            <span data-testid="spending-as-of">
              Month to date through{' '}
              <time dateTime={focus.asOf} className="font-medium">
                {dayTitle(focus.asOf, formatting.locale)}
              </time>
              , the latest day every cash account shares.
            </span>
          ) : null}
        </div>
        <p className={META}>{monthStateMeaning(state, monthName)}</p>
        {focus.shape === 'current' && focus.asOf !== null && focus.newerBalances ? (
          <p className="text-[length:var(--text-meta)] text-[var(--color-warning)]" data-testid="spending-newer-balances">
            Some accounts have newer individual balances; update all accounts to move the
            month-to-date date forward.
          </p>
        ) : null}
        {'buckets' in focus ? <Problems buckets={focus.buckets} formatting={formatting} /> : null}
        {anchor === null ? null : (
          <p className="text-[length:var(--text-meta)]">
            <Link href={monthlyHref(focus.month, anchor)} className="underline" data-testid="spending-fix-link">
              {anchor === 'accounts' ? 'Enter the balances in Monthly' : 'Review the reconciliation in Monthly'}
            </Link>
          </p>
        )}
      </div>

      {focus.shape === 'current' && focus.asOf === null ? (
        <div className="space-y-2" data-testid="spending-source-only">
          <p className={META}>
            These two need no common date, so they run through{' '}
            <time dateTime={focus.sourceOnlyThrough}>{dayTitle(focus.sourceOnlyThrough, formatting.locale)}</time>. They
            are their own facts, not part of a month-to-date total.
          </p>
          <dl className="grid gap-6 sm:grid-cols-2">
            <SpendingFigure
              label="Additional spending through today"
              display={spendingFigureDisplay(focus.sourceOnly.additionalSpending)}
              formatting={formatting}
              testId="spending-additional"
              note="Paid by you from outside your tracked accounts."
            />
            <SpendingFigure
              label="Paid by others through today · memo"
              display={spendingFigureDisplay(focus.sourceOnly.thirdPartyPaid)}
              formatting={formatting}
              testId="spending-paid-by-others"
              note="Paid by someone else. Informational, and in no spending or savings figure."
            />
          </dl>
        </div>
      ) : (
        <TrackedFigures
          figures={focus.figures}
          formatting={formatting}
          countsAdditionalSpending={countsAdditionalSpending}
        />
      )}
    </div>
  );
}
