import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReportingAmountDto, SpendingHistoryRowDto, SpendingSpanDto } from '@vaultide/application';

const { spendingChartModel } = await import('@/features/spending/chart-model');
const { SpendingChart } = await import('@/components/charts/spending-chart');

/**
 * The Spending history chart (blueprint 15.2 "Spending", 16.2, 16.6; ADR 0008
 * §8, §9).
 *
 * What is pinned is what each month is drawn as — never more than its evidence:
 * a stack only for a full figure, a bound only as a line, a gap with a word for
 * everything else, additional spending beside the stack and paid-by-others as a
 * memo marker, and a combined period as a bracket with no height.
 */

const PROVENANCE = { estimatedConversion: false, approximate: false, exact: true };
const amount = (
  value: string,
  availability: ReportingAmountDto['availability'] = 'available',
): ReportingAmountDto => ({ value: { amount: value, currency: 'EUR' }, availability, missing: [], provenance: PROVENANCE });

function row(month: string, over: Partial<SpendingHistoryRowDto> = {}): SpendingHistoryRowDto {
  return {
    month,
    shape: 'completed',
    status: 'reliable',
    observed: true,
    asOf: null,
    rollingEligible: true,
    spans: [],
    tracked: amount('1000'),
    known: amount('400'),
    unclassified: amount('600'),
    additional: amount('0'),
    total: amount('1000'),
    thirdPartyPaid: amount('0'),
    savingsRate: null,
    ...over,
  };
}

const span: SpendingSpanDto = {
  key: 'EUR:2026-05-01',
  currency: 'EUR',
  from: '2026-05-01',
  to: '2026-06-30',
  months: ['2026-05', '2026-06'],
  status: 'reliable',
  totals: {
    externalInflows: { amount: '4200', currency: 'EUR' },
    nonIncomeInflows: { amount: '0', currency: 'EUR' },
    nonExpenseOutflows: { amount: '0', currency: 'EUR' },
    knownTrackedExpenses: { amount: '972', currency: 'EUR' },
    cashDelta: { amount: '2506', currency: 'EUR' },
  },
  trackedTotalSpending: { amount: '1694', currency: 'EUR' },
  unclassified: { amount: '722', currency: 'EUR' },
};

const history: SpendingHistoryRowDto[] = [
  row('2026-01'),
  row('2026-02', { status: 'estimated', rollingEligible: false }),
  row('2026-03', {
    status: 'unresolved',
    rollingEligible: false,
    tracked: amount('300', 'partial'),
    unclassified: amount('0', 'unavailable'),
    known: amount('300'),
  }),
  row('2026-04', { status: 'unavailable', rollingEligible: false, tracked: amount('0', 'partial'), unclassified: amount('0', 'unavailable') }),
  row('2026-05', { status: 'unavailable', rollingEligible: false, spans: ['EUR:2026-05-01'], tracked: amount('0', 'partial'), unclassified: amount('0', 'unavailable') }),
  row('2026-06', { status: 'unavailable', rollingEligible: false, spans: ['EUR:2026-05-01'], tracked: amount('0', 'partial'), unclassified: amount('0', 'unavailable') }),
  row('2026-07', { status: 'unavailable', observed: false, rollingEligible: false, tracked: amount('0', 'unavailable'), known: amount('0', 'unavailable'), unclassified: amount('0', 'unavailable') }),
  row('2026-08', { additional: amount('50'), thirdPartyPaid: amount('80'), tracked: amount('1000', 'partial'), known: amount('400', 'partial') }),
  row('2026-09', { shape: 'current', status: 'provisional', asOf: '2026-09-06', rollingEligible: false }),
];

const model = () =>
  spendingChartModel({
    history,
    spans: [span],
    focusMonth: '2026-01',
    reportingCurrency: 'EUR',
    locale: 'en-GB',
    minorUnitsByCurrency: { EUR: 2 },
  });

describe('what each month is drawn as', () => {
  it('draws a stack only for a full figure, and says what every other month is', () => {
    const marks = model().columns.map((column) => [column.key, column.mark.kind, column.caption]);
    expect(marks).toEqual([
      ['2026-01', 'stack', null],
      ['2026-02', 'stack', 'Estimated'],
      ['2026-03', 'lower_bound', 'At least'],
      ['2026-04', 'gap', 'Missing'],
      ['2026-05', 'gap', 'Missing'],
      ['2026-06', 'gap', 'Missing'],
      ['2026-07', 'gap', 'Not tracked'],
      // Reliable, but a rate is missing: not a total, so not a stack — and it says so.
      ['2026-08', 'gap', 'Partial'],
      ['2026-09', 'stack', 'So far'],
    ]);
  });

  it('marks estimated and provisional stacks so they never read as settled', () => {
    const columns = model().columns;
    expect(columns[1]?.mark).toMatchObject({ kind: 'stack', style: 'estimated' });
    expect(columns[8]?.mark).toMatchObject({ kind: 'stack', style: 'provisional' });
    expect(columns[0]?.mark).toMatchObject({ kind: 'stack', style: 'solid', known: '400', unclassified: '600' });
  });

  it('draws an unresolved month only at the known amount it is at least', () => {
    expect(model().columns[2]?.mark).toEqual({ kind: 'lower_bound', atLeast: '300' });
  });

  it('keeps additional spending beside the stack and paid-by-others as a memo, and neither when zero', () => {
    const august = model().columns[7];
    expect(august?.additional).toBe('50');
    expect(august?.memo).toBe('80');
    expect(model().columns[0]?.memo).toBeNull();
  });

  it('brackets a combined period across its months, in its own currency, with no height', () => {
    const { brackets } = model();
    expect(brackets).toEqual([
      { key: 'EUR:2026-05-01', start: 4, span: 2, label: 'Combined EUR period: €1,694.00 tracked' },
    ]);
  });

  it('summarises what is drawn and what is not, and points to the table', () => {
    const { summary } = model();
    expect(summary).toContain('3 of 9 months have a full figure');
    expect(summary).toContain('1 only a lower bound');
    expect(summary).toContain('1 combined period covers months without their own figure');
    expect(summary).toContain('The table below lists every figure.');
  });
});

describe('the chart', () => {
  const html = renderToStaticMarkup(createElement(SpendingChart, model()));

  it('is one image with a summary, scrolling inside its own container', () => {
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Tracked spending by month in EUR');
    expect(html).toMatch(/class="relative overflow-x-auto"/u);
  });

  it('draws parts only where the model says, and never a height for a combined period', () => {
    const column = (month: string) => {
      const start = html.indexOf(`data-month="${month}"`);
      return html.slice(start, html.indexOf('data-testid="spending-chart-column"', start + 1));
    };
    expect(column('2026-01')).toContain('data-part="known"');
    expect(column('2026-01')).not.toContain('data-part="hatch"');
    expect(column('2026-02')).toContain('data-part="hatch"');
    expect(column('2026-03')).toContain('data-part="lower-bound"');
    expect(column('2026-03')).not.toContain('data-part="known"');
    for (const month of ['2026-05', '2026-06']) {
      expect(column(month)).toContain('data-part="gap"');
      expect(column(month)).not.toContain('data-part="known"');
    }
    expect(column('2026-08')).toContain('data-part="additional"');
    expect(column('2026-08')).toContain('data-part="memo"');
    const at = html.indexOf('spending-chart-bracket');
    const bracket = html.slice(html.lastIndexOf('<div', at), html.indexOf('</div>', at));
    expect(bracket).toContain('grid-column:5 / span 2');
    expect(bracket).not.toContain('height');
    expect(html).not.toContain('847');
  });

  it('says in words what colour also shows', () => {
    expect(html).toContain('Paid by others (memo, not in any total)');
    expect(html).toContain('Estimated or provisional (hatched)');
    expect(html).toContain('At least (records contradict balances)');
  });
});
