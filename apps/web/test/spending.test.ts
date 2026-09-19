import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ReportingAmountDto,
  ReportingCashFlowFiguresDto,
  SpendingFocusDto,
  SpendingHistoryRowDto,
  SpendingPageDto,
  SpendingRollingDto,
  SpendingSpanDto,
} from '@vaultide/application';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const {
  MONTH_STATE_LABEL,
  bucketProblem,
  focusAnchorOf,
  hasTrackedEvidence,
  monthStateOf,
  monthlyHref,
  rankingNote,
  rollingCount,
  savingsFigureDisplay,
  savingsRateDisplay,
  spendingFigureDisplay,
  spendingHref,
} = await import('@/features/spending/presentation');
const { FocusSummary } = await import('@/features/spending/summary');
const { CombinedPeriods, HistoryTable, RollingCards } = await import('@/features/spending/history');

/**
 * The Spending page's presentation (blueprint 15.2 "Spending", 16.2; ADR 0008).
 *
 * Nothing here computes a figure. What is pinned is how the read's figures read:
 * a partial spending figure as a lower bound, a partial savings figure not at
 * all, a month with no bucket as not tracked rather than missing evidence, and
 * a combined period as one figure that no month inherits.
 */

const PROVENANCE = { estimatedConversion: false, approximate: false, exact: true };
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2, USD: 2 } };

function amount(
  value: string,
  availability: ReportingAmountDto['availability'] = 'available',
  missing: ReportingAmountDto['missing'] = [],
): ReportingAmountDto {
  return { value: { amount: value, currency: 'EUR' }, availability, missing, provenance: PROVENANCE };
}

const MISSING_END = [{ currency: 'EUR', reason: 'missing_month_end', detail: 'reconciliation_unavailable' }];
const UNRESOLVED = [{ currency: 'EUR', reason: 'not_applicable', detail: 'unresolved' }];
const NO_RATE = [{ currency: 'USD', reason: 'fx_missing' }];

function figures(over: Partial<ReportingCashFlowFiguresDto> = {}): ReportingCashFlowFiguresDto {
  return {
    reportingCurrency: 'EUR',
    externalIncome: amount('2600'),
    knownConsumption: amount('1085'),
    propertyOperatingCosts: amount('0'),
    interestAndFees: amount('20'),
    transactionCosts: amount('0'),
    externalOutflows: amount('40'),
    unclassified: amount('935'),
    consumption: amount('2020'),
    trackedTotalSpending: amount('2080'),
    knownTrackedSpending: amount('1145'),
    additionalSpending: amount('50'),
    thirdPartyPaid: amount('80'),
    trackedSavingsFromIncome: amount('520'),
    personalSavings: amount('470'),
    totalSpending: amount('2130'),
    savingsRate: { kind: 'ratio', value: '0.1807692307692307692307692307692307692308' },
    countsAdditionalSpending: true,
    ...over,
  };
}

function completedFocus(over: Partial<Extract<SpendingFocusDto, { shape: 'completed' }>> = {}): SpendingFocusDto {
  return {
    shape: 'completed',
    month: '2026-08',
    status: 'reliable',
    observed: true,
    interval: { from: '2026-08-01', to: '2026-08-31' },
    figures: figures(),
    buckets: [
      {
        currency: 'EUR',
        status: 'reliable',
        cause: null,
        accountsMissingEvidence: [],
        firstBalanceAccounts: [],
        unexplainedInflow: null,
      },
    ],
    ...over,
  };
}

const summary = (focus: SpendingFocusDto): string =>
  renderToStaticMarkup(
    createElement(FocusSummary, { focus, monthName: 'August 2026', formatting, countsAdditionalSpending: true }),
  );

/** The rendered markup of one test id, up to the next element of the same kind. */
function block(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error(`No element with the test id ${testId}`);
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('</dd>', at) + 5);
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                     */
/* -------------------------------------------------------------------------- */

describe('how a figure reads', () => {
  it('states an available spending figure as itself', () => {
    expect(spendingFigureDisplay(amount('2130'))).toEqual({ kind: 'value', amount: '2130', currency: 'EUR' });
  });

  it('states a partial spending figure as a lower bound, with what is not inside it', () => {
    const display = spendingFigureDisplay(amount('300', 'partial', UNRESOLVED));
    expect(display).toMatchObject({ kind: 'at_least', amount: '300' });
    expect(display.kind === 'at_least' && display.reason).toContain('EUR (the records contradict the balances)');
  });

  it('never states "at least zero": a partial spending figure with nothing above zero is not available', () => {
    expect(spendingFigureDisplay(amount('0', 'partial', MISSING_END))).toMatchObject({ kind: 'none' });
    expect(spendingFigureDisplay(amount('0.00', 'partial', MISSING_END))).toMatchObject({ kind: 'none' });
  });

  it('says why an unavailable figure is missing, and that a month with no bucket has nothing to state', () => {
    expect(spendingFigureDisplay(amount('0', 'unavailable', MISSING_END))).toEqual({
      kind: 'none',
      reason: 'Not included: EUR (a month-end balance is missing).',
    });
    expect(spendingFigureDisplay(amount('0', 'unavailable', []))).toEqual({
      kind: 'none',
      reason: 'No cash account took part in this month.',
    });
  });

  it('withholds a partial savings figure whatever caused it, and says so', () => {
    for (const missing of [UNRESOLVED, NO_RATE]) {
      const display = savingsFigureDisplay(amount('-411', 'partial', missing));
      expect(display.kind).toBe('none');
      expect(display.kind === 'none' && display.reason).toContain('not a lower bound');
    }
    expect(savingsFigureDisplay(amount('520'))).toEqual({ kind: 'value', amount: '520', currency: 'EUR' });
  });

  it('shows a savings rate as a ratio or not at all', () => {
    expect(savingsRateDisplay({ kind: 'ratio', value: '0.5824' })).toEqual({ kind: 'value', ratio: '0.5824' });
    expect(savingsRateDisplay({ kind: 'unavailable', reason: 'divide_by_zero' })).toMatchObject({ kind: 'none' });
    expect(savingsRateDisplay(null)).toMatchObject({ kind: 'none' });
  });
});

describe('the focus summary', () => {
  it('leads with total spending and keeps paid-by-others a memo outside it', () => {
    const html = summary(completedFocus());
    expect(block(html, 'spending-total')).toContain('€2,130.00');
    expect(block(html, 'spending-tracked')).toContain('€2,080.00');
    expect(block(html, 'spending-known')).toContain('€1,145.00');
    expect(block(html, 'spending-unclassified')).toContain('€935.00');
    expect(block(html, 'spending-additional')).toContain('€50.00');
    expect(block(html, 'spending-saved-from-income')).toContain('€520.00');
    expect(block(html, 'spending-personal-savings')).toContain('€470.00');
    expect(block(html, 'spending-savings-rate')).toContain('18.08');
    expect(block(html, 'spending-paid-by-others')).toContain('€80.00');
    expect(block(html, 'spending-paid-by-others')).toContain('in no spending or savings figure');
    expect(html).toContain('>Reliable<');
  });

  it('shows an unresolved month as at least the known amount, the unexplained inflow, and no savings number', () => {
    const html = summary(
      completedFocus({
        status: 'unresolved',
        figures: figures({
          trackedTotalSpending: amount('300', 'partial', UNRESOLVED),
          unclassified: amount('0', 'unavailable', UNRESOLVED),
          consumption: amount('300', 'partial', UNRESOLVED),
          totalSpending: amount('350', 'partial', UNRESOLVED),
          knownTrackedSpending: amount('300'),
          trackedSavingsFromIncome: amount('-300', 'partial', UNRESOLVED),
          personalSavings: amount('-350', 'partial', UNRESOLVED),
          savingsRate: { kind: 'unavailable', reason: 'not_applicable', detail: 'personal savings could not be stated in full' },
        }),
        buckets: [
          {
            currency: 'EUR',
            status: 'unresolved',
            cause: null,
            accountsMissingEvidence: [],
            firstBalanceAccounts: [],
            unexplainedInflow: { amount: { amount: '200', currency: 'EUR' }, variant: 'b' },
          },
        ],
      }),
    );
    expect(block(html, 'spending-total')).toMatch(/≥ .*€350\.00/su);
    expect(block(html, 'spending-total')).toContain('at least');
    expect(block(html, 'spending-tracked')).toMatch(/≥ .*€300\.00/su);
    // "known" appears only on the figure that is known tracked spending.
    expect(block(html, 'spending-tracked')).not.toContain('(known)');
    expect(block(html, 'spending-known')).toContain('€300.00');
    expect(block(html, 'spending-unclassified')).toContain('—');
    // Partial savings are never printed as a number.
    for (const id of ['spending-saved-from-income', 'spending-personal-savings']) {
      expect(block(html, id)).not.toContain('€');
      expect(block(html, id)).toContain('not a lower bound');
    }
    expect(html).toContain('Your known expenses exceed the cash that left by');
    expect(html).toContain('€200.00');
    expect(html).toMatch(/href="\/monthly\/2026-08#reconciliation"/u);
  });

  it('names the missing evidence and points to Monthly’s Accounts', () => {
    const focus = completedFocus({
      status: 'unavailable',
      figures: figures({
        trackedTotalSpending: amount('0', 'partial', MISSING_END),
        unclassified: amount('0', 'unavailable', MISSING_END),
        totalSpending: amount('50', 'partial', MISSING_END),
      }),
      buckets: [
        {
          currency: 'EUR',
          status: 'unavailable',
          cause: 'missing_month_end',
          accountsMissingEvidence: ['BBVA'],
          firstBalanceAccounts: [],
          unexplainedInflow: null,
        },
      ],
    });
    const html = summary(focus);
    expect(html).toContain('EUR: missing month-end balance for BBVA.');
    expect(block(html, 'spending-tracked')).toContain('—');
    expect(block(html, 'spending-total')).toMatch(/≥ .*€50\.00/su);
    expect(focusAnchorOf(focus)).toBe('accounts');
    expect(html).toMatch(/href="\/monthly\/2026-08#accounts"/u);
  });

  it('says a month no cash account took part in is not tracked, with nothing to fix', () => {
    const html = summary(
      completedFocus({
        status: 'unavailable',
        observed: false,
        buckets: [],
        figures: figures({
          trackedTotalSpending: amount('0', 'unavailable'),
          knownTrackedSpending: amount('0', 'unavailable'),
          unclassified: amount('0', 'unavailable'),
          totalSpending: amount('0', 'unavailable'),
        }),
      }),
    );
    expect(html).toContain('>Not tracked<');
    expect(html).toContain('nothing to fix');
    expect(html).not.toContain('missing');
    expect(html).not.toContain('spending-fix-link');
  });

  it('labels a current month through its common date, and notes newer balances', () => {
    const html = summary({
      shape: 'current',
      month: '2026-10',
      status: 'provisional',
      observed: true,
      asOf: '2026-10-06',
      interval: { from: '2026-10-01', to: '2026-10-06' },
      figures: figures(),
      buckets: [],
      newerBalances: true,
    });
    expect(html).toContain('>Provisional<');
    expect(html).toContain('Month to date through');
    expect(html).toContain('6 Oct 2026');
    expect(html).toContain('newer individual balances');
  });

  it('keeps a current month with no common date to its two source-only facts', () => {
    const focus: SpendingFocusDto = {
      shape: 'current',
      month: '2026-10',
      status: 'unavailable',
      observed: false,
      asOf: null,
      reason: 'mtd_no_common_date',
      sourceOnly: { reportingCurrency: 'EUR', additionalSpending: amount('9'), thirdPartyPaid: amount('30') },
      sourceOnlyThrough: '2026-10-10',
    };
    const html = summary(focus);
    expect(html).toContain('>No common date<');
    expect(html).toContain('Additional spending through today');
    expect(html).toContain('€9.00');
    expect(html).toContain('€30.00');
    expect(html).not.toContain('data-testid="spending-total"');
    expect(html).not.toContain('data-testid="spending-tracked"');
    expect(focusAnchorOf(focus)).toBe('accounts');
  });
});

/* -------------------------------------------------------------------------- */
/* Months, rolling and spans                                                   */
/* -------------------------------------------------------------------------- */

function historyRow(over: Partial<SpendingHistoryRowDto> = {}): SpendingHistoryRowDto {
  return {
    month: '2026-08',
    shape: 'completed',
    status: 'reliable',
    observed: true,
    asOf: null,
    rollingEligible: true,
    spans: [],
    tracked: amount('2080'),
    known: amount('1145'),
    unclassified: amount('935'),
    additional: amount('50'),
    total: amount('2130'),
    thirdPartyPaid: amount('80'),
    savingsRate: { kind: 'ratio', value: '0.18' },
    ...over,
  };
}

describe('a month’s state', () => {
  it('keeps missing evidence and no bucket apart, and names the current month with no common date', () => {
    expect(monthStateOf(historyRow({ status: 'unavailable' }))).toBe('unavailable');
    expect(monthStateOf(historyRow({ status: 'unavailable', observed: false }))).toBe('not_observed');
    expect(monthStateOf(historyRow({ shape: 'current', status: 'unavailable', observed: false, asOf: null }))).toBe(
      'no_common_date',
    );
    expect(monthStateOf(historyRow({ shape: 'current', status: 'provisional', asOf: '2026-10-06' }))).toBe('provisional');
    expect(MONTH_STATE_LABEL.unavailable).toBe('Unavailable');
    expect(MONTH_STATE_LABEL.not_observed).toBe('Not tracked');
  });

  it('says what would fix a bucket, and nothing when nothing is wrong', () => {
    expect(
      bucketProblem({
        currency: 'EUR',
        status: 'unavailable',
        cause: 'first_balance',
        accountsMissingEvidence: [],
        firstBalanceAccounts: ['BBVA'],
        unexplainedInflow: null,
      }),
    ).toBe('EUR: every account was first tracked this month (BBVA), so there is nothing to reconcile yet.');
    expect(
      bucketProblem({
        currency: 'EUR',
        status: 'reliable',
        cause: null,
        accountsMissingEvidence: [],
        firstBalanceAccounts: [],
        unexplainedInflow: null,
      }),
    ).toBeNull();
  });

  it('addresses months on both pages', () => {
    expect(spendingHref('2026-08')).toBe('/expenses?month=2026-08');
    expect(monthlyHref('2026-08')).toBe('/monthly/2026-08');
    expect(monthlyHref('2026-08', 'known-expenses')).toBe('/monthly/2026-08#known-expenses');
  });
});

describe('the history table', () => {
  const render = (history: SpendingHistoryRowDto[]) =>
    renderToStaticMarkup(createElement(HistoryTable, { history, focusMonth: '2026-08', formatting }));

  it('scrolls inside its own container with a sticky month column, and opens each month in Monthly', () => {
    const html = render([historyRow()]);
    expect(html).toMatch(/class="relative overflow-x-auto"/u);
    expect(html).toContain('sticky left-0');
    expect(html).toContain('href="/monthly/2026-08"');
    expect(html).toContain('href="/expenses?month=2026-08"');
    expect(html).toContain('aria-current="true"');
  });

  it('never shows an unavailable month as zero, and marks what rolling counts', () => {
    const html = render([
      historyRow({ month: '2026-06', status: 'reliable', tracked: amount('0'), known: amount('0'), unclassified: amount('0') }),
      historyRow({
        month: '2026-07',
        status: 'unavailable',
        rollingEligible: false,
        tracked: amount('0', 'partial', MISSING_END),
        unclassified: amount('0', 'unavailable', MISSING_END),
        total: amount('0', 'partial', MISSING_END),
        savingsRate: { kind: 'unavailable', reason: 'not_applicable' },
      }),
    ]);
    const june = html.slice(html.indexOf('data-month="2026-06"'), html.indexOf('data-month="2026-07"'));
    const july = html.slice(html.indexOf('data-month="2026-07"'));
    // A reliable zero is a zero.
    expect(june).toContain('€0.00');
    expect(june).toContain('>Counts<');
    // Missing evidence is not.
    expect(july.slice(july.indexOf('history-tracked'), july.indexOf('history-known'))).not.toContain('€0.00');
    expect(july).toContain('Does not count');
    expect(july).toContain('>Unavailable<');
  });

  it('points a month inside a combined period to that period', () => {
    const html = render([historyRow({ status: 'unavailable', spans: ['EUR:2026-09-01'] })]);
    expect(html).toContain('href="#span-EUR:2026-09-01"');
    expect(html).toContain('In a combined period');
  });

  it('marks the current month with its common date and never as a rolling observation', () => {
    const html = render([historyRow({ month: '2026-10', shape: 'current', status: 'provisional', asOf: '2026-10-06', rollingEligible: false })]);
    expect(html).toContain('through 6 Oct 2026');
    expect(html).toContain('Does not count');
  });
});

describe('rolling', () => {
  const rolling = (over: Partial<SpendingRollingDto> = {}): SpendingRollingDto => ({
    displayMonth: '2026-09',
    endsBeforeFocus: false,
    windows: [
      { months: 3, from: '2026-07', to: '2026-09', average: { value: { amount: '1940', currency: 'EUR' }, count: 3 } },
      { months: 6, from: '2026-04', to: '2026-09', average: null },
      { months: 12, from: '2025-10', to: '2026-09', average: { value: { amount: '1810', currency: 'EUR' }, count: 9 } },
    ],
    ...over,
  });

  it('says tracked spending, how many months qualified, and nothing for a window with none', () => {
    const html = renderToStaticMarkup(createElement(RollingCards, { rolling: rolling(), formatting }));
    expect(html).toContain('3-month average tracked spending');
    expect(html).toContain('3 of 3 months qualified');
    expect(html).toContain('9 of 12 months qualified');
    expect(html).toContain('No month in these 6 qualified');
    expect(html).not.toContain('through September');
    expect(rollingCount(null, 6)).toBe('No month in these 6 qualified');
  });

  it('says so when the windows end before a current focus month', () => {
    const html = renderToStaticMarkup(createElement(RollingCards, { rolling: rolling({ endsBeforeFocus: true }), formatting }));
    expect(html).toContain(' · through September 2026');
    expect(html).toContain('These windows end at September 2026, the last completed month.');
  });
});

describe('combined periods', () => {
  const span: SpendingSpanDto = {
    key: 'EUR:2026-09-01',
    currency: 'EUR',
    from: '2026-09-01',
    to: '2026-10-31',
    months: ['2026-09', '2026-10'],
    status: 'reliable',
    totals: {
      externalInflows: { amount: '4200', currency: 'EUR' },
      nonIncomeInflows: { amount: '400', currency: 'EUR' },
      nonExpenseOutflows: { amount: '2870', currency: 'EUR' },
      knownTrackedExpenses: { amount: '972', currency: 'EUR' },
      cashDelta: { amount: '36', currency: 'EUR' },
    },
    trackedTotalSpending: { amount: '1694', currency: 'EUR' },
    unclassified: { amount: '722', currency: 'EUR' },
  };

  it('states the golden period as one figure in its own currency, and never a month’s share of it', () => {
    const html = renderToStaticMarkup(createElement(CombinedPeriods, { spans: [span], formatting }));
    expect(html).toContain('Combined period · 1 Sept 2026 – 31 Oct 2026');
    expect(html).toContain('id="span-EUR:2026-09-01"');
    expect(html).toContain('€1,694.00');
    expect(html).toContain('€972.00');
    expect(html).toContain('€722.00');
    expect(html).toContain('never divided into months');
    // No per-month figure: 1,694 / 2 and 722 / 2 appear nowhere.
    expect(html).not.toContain('847');
    expect(html).not.toContain('361');
  });

  it('withholds an unresolved period’s tracked and unclassified figures', () => {
    const html = renderToStaticMarkup(
      createElement(CombinedPeriods, { spans: [{ ...span, status: 'unresolved', unclassified: { amount: '-50', currency: 'EUR' } }], formatting }),
    );
    expect(html).toContain('>Unresolved<');
    expect(html).not.toContain('-€50.00');
    expect(html).not.toContain('€1,694.00');
  });
});

describe('the page as a whole', () => {
  it('has evidence once any month states tracked spending, or a combined period exists', () => {
    const empty: Pick<SpendingPageDto, 'history' | 'spans'> = {
      history: [historyRow({ tracked: amount('0', 'partial', MISSING_END) }), historyRow({ tracked: null })],
      spans: [],
    };
    expect(hasTrackedEvidence(empty)).toBe(false);
    expect(hasTrackedEvidence({ ...empty, history: [historyRow()] })).toBe(true);
    expect(hasTrackedEvidence({ ...empty, spans: [{} as SpendingSpanDto] })).toBe(true);
  });

  it('explains a ranking that could not be made in one currency', () => {
    expect(rankingNote('reporting_currency', false)).toBeNull();
    expect(rankingNote('per_native_currency', true)).toContain('Each currency is ranked on its own');
    expect(rankingNote('source_only', false)).toContain('only spending you paid from outside');
  });
});
