import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  ReportingAmountDto,
  ReportingCashFlowFiguresDto,
} from '@vaultide/application';

// The review button calls a server action and the app router; neither exists
// outside Next, and neither is what these tests are about.
vi.mock('@/server/actions/monthly', () => ({
  markMonthReviewedAction: vi.fn(),
  dismissMonthAdvisoryAction: vi.fn(),
  restoreMonthAdvisoryAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CompletedOverview, CurrentOverview } = await import('@/features/monthly/overview');
const { presentIssues } = await import('@/features/monthly/presentation');

/**
 * How Monthly's Overview states its figures (blueprint 16.2; ADR 0008 §5 and
 * its addendum; cold review P3-01).
 *
 * Each figure is rendered in the four states the read can hand it — available,
 * partial above zero, partial at zero, unavailable — and must read the way the
 * Spending page reads the same figure: a spending or income figure that is
 * partial as `≥` its amount, or `—` when nothing above zero is stated; a
 * savings figure that is partial as `—`; nothing that cannot be stated as a
 * number, and never as a zero.
 */

const PROVENANCE = { estimatedConversion: false, approximate: false, exact: true };
const formattingLocale = 'en-GB';

function amount(
  value: string,
  availability: ReportingAmountDto['availability'] = 'available',
  missing: ReportingAmountDto['missing'] = [],
): ReportingAmountDto {
  return { value: { amount: value, currency: 'EUR' }, availability, missing, provenance: PROVENANCE };
}

const MISSING_END = [{ currency: 'EUR', reason: 'missing_month_end', detail: 'reconciliation_unavailable' }];
const NO_RATE = [{ currency: 'USD', reason: 'fx_missing' }];

const STATES = {
  available: amount('1234.5'),
  partialAboveZero: amount('300', 'partial', NO_RATE),
  partialAtZero: amount('0', 'partial', MISSING_END),
  unavailable: amount('0', 'unavailable', MISSING_END),
} as const;
type State = keyof typeof STATES;

/** Figures a sum of non-negative contributions makes: a partial one is a lower bound. */
const LOWER_BOUND = [
  ['externalIncome', 'Tracked income'],
  ['trackedTotalSpending', 'Tracked spending'],
  ['unclassified', 'Unclassified spending'],
  ['additionalSpending', 'Additional spending'],
  ['totalSpending', 'Total spending'],
  ['thirdPartyPaid', 'Paid by others'],
] as const;
/** Savings figures: a partial one is no bound at all. */
const SAVINGS = [
  ['trackedSavingsFromIncome', 'Saved from income'],
  ['personalSavings', 'Personal savings'],
] as const;

type AmountKey = (typeof LOWER_BOUND)[number][0] | (typeof SAVINGS)[number][0];

function figures(value: ReportingAmountDto): ReportingCashFlowFiguresDto {
  const every = Object.fromEntries(
    [...LOWER_BOUND, ...SAVINGS].map(([key]) => [key, value]),
  ) as Record<AmountKey, ReportingAmountDto>;
  return {
    reportingCurrency: 'EUR',
    knownConsumption: amount('0'),
    propertyOperatingCosts: amount('0'),
    interestAndFees: amount('0'),
    transactionCosts: amount('0'),
    externalOutflows: amount('0'),
    consumption: amount('0'),
    knownTrackedSpending: amount('0'),
    savingsRate: { kind: 'ratio', value: '0.25' },
    countsAdditionalSpending: true,
    ...every,
  };
}

const issues = presentIssues([], []);

/**
 * A completed month's page. The Overview reads its reporting, its
 * reconciliation status, completeness and review, and nothing else; the rest of
 * the page DTO belongs to the sections below it.
 */
function completed(
  reporting: ReportingCashFlowFiguresDto,
  reconciliation: Pick<CompletedMonthlyPageDto['reconciliation'], 'status' | 'buckets'> = {
    status: 'unavailable',
    buckets: [],
  },
): string {
  const page = {
    kind: 'completed',
    month: '2026-09',
    monthEndsOn: '2026-09-30',
    today: '2026-10-06',
    minorUnitsByCurrency: { EUR: 2, USD: 2 },
    review: { reviewedAt: null, dismissedIssueKeys: [] },
    reconciliation: { month: '2026-09', ...reconciliation },
    reporting: { ...reporting, month: '2026-09', monthStatus: reconciliation.status },
    completeness: {
      month: '2026-09',
      state: 'partial',
      satisfied: 0,
      required: 1,
      ratio: '0',
      cashAccounts: [],
      recurringOccurrences: [],
    },
  } as unknown as CompletedMonthlyPageDto;
  return renderToStaticMarkup(
    createElement(CompletedOverview, {
      page,
      locale: formattingLocale,
      timeZone: 'Europe/Madrid',
      monthName: 'September 2026',
      issues,
    }),
  );
}

/** The current month: with a common date `D`, or without one. */
function current(reporting: CurrentMonthlyPageDto['reporting']): string {
  const page = {
    kind: 'current',
    month: '2026-10',
    monthEndsOn: '2026-10-31',
    today: '2026-10-06',
    minorUnitsByCurrency: { EUR: 2, USD: 2 },
    monthToDate: { status: reporting.monthStatus },
    reporting,
  } as unknown as CurrentMonthlyPageDto;
  return renderToStaticMarkup(createElement(CurrentOverview, { page, locale: formattingLocale, issues }));
}

/** The rendered markup of one figure, from its own element to the end of its value. */
function block(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error(`No element with the test id ${testId}`);
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('</dd>', at) + 5);
}

/** What one figure in one state must read, by its rule. */
function expectReads(figure: string, state: State, rule: 'lower_bound' | 'savings'): void {
  expect(figure).toContain(`data-availability="${STATES[state].availability}"`);
  switch (state) {
    case 'available':
      expect(figure).toContain('data-display="value"');
      expect(figure).toContain('€1,234.50');
      expect(figure).not.toContain('≥');
      expect(figure).not.toContain('Not available');
      expect(figure).not.toContain('At least');
      return;
    case 'partialAboveZero':
      if (rule === 'lower_bound') {
        expect(figure).toContain('data-display="at_least"');
        expect(figure).toMatch(/≥ .*€300\.00/su);
        expect(figure).toContain('at least');
        expect(figure).toContain('At least');
        expect(figure).toContain('Not included: USD (no exchange rate).');
      } else {
        expect(figure).toContain('data-display="none"');
        expect(figure).not.toContain('€');
        expect(figure).toContain('—');
        expect(figure).toContain('Not available');
        expect(figure).toContain('not a lower bound');
        expect(figure).toContain('Not included: USD (no exchange rate).');
      }
      return;
    case 'partialAtZero':
    case 'unavailable':
      // `≥ €0.00` would say nothing and sit where a real zero sits; a savings
      // figure is not stated at all. Either way: a dash, its reason, no zero.
      expect(figure).toContain('data-display="none"');
      expect(figure).not.toContain('€');
      expect(figure).toContain('—');
      expect(figure).toContain('Not available');
      expect(figure).toContain('Not included: EUR (a month-end balance is missing).');
      if (rule === 'savings' && state === 'partialAtZero') expect(figure).toContain('not a lower bound');
      return;
  }
}

const STATE_NAMES = Object.keys(STATES) as State[];

describe('the completed month’s Overview', () => {
  for (const state of STATE_NAMES) {
    describe(`with every figure ${state}`, () => {
      const html = completed(figures(STATES[state]));

      it.each(LOWER_BOUND)('reads %s as a spending figure does, a lower bound when partial', (key, label) => {
        const figure = block(html, `figure-${key}`);
        expect(figure).toContain(label);
        expectReads(figure, state, 'lower_bound');
      });

      it.each(SAVINGS)('reads %s as a savings figure does, never a number when partial', (key, label) => {
        const figure = block(html, `figure-${key}`);
        expect(figure).toContain(label);
        expectReads(figure, state, 'savings');
      });

      it('never prints a figure beside a Partial badge', () => {
        for (const [key] of [...LOWER_BOUND, ...SAVINGS]) {
          expect(block(html, `figure-${key}`)).not.toContain('Partial');
        }
      });
    });
  }

  it('states an available zero as the zero it is', () => {
    const html = completed(figures(amount('0')));
    for (const [key] of [...LOWER_BOUND, ...SAVINGS]) {
      const figure = block(html, `figure-${key}`);
      expect(figure).toContain('€0.00');
      expect(figure).toContain('data-display="value"');
    }
  });

  it('says a month nobody observed has nothing to state, not what is missing from it', () => {
    const html = completed(figures(amount('0', 'unavailable', [])));
    for (const [key] of [...LOWER_BOUND, ...SAVINGS]) {
      const figure = block(html, `figure-${key}`);
      expect(figure).not.toContain('€');
      expect(figure).toContain('No cash account took part in this month.');
    }
  });

  it('shows the savings rate as a ratio, or as a dash with its own reason', () => {
    expect(block(completed(figures(STATES.available)), 'figure-savingsRate')).toContain('25');
    const html = completed({
      ...figures(STATES.partialAtZero),
      savingsRate: { kind: 'unavailable', reason: 'not_applicable', detail: 'personal savings could not be stated in full' },
    });
    const rate = block(html, 'figure-savingsRate');
    expect(rate).toContain('—');
    expect(rate).toContain('Not available');
    expect(rate).toContain('Personal savings could not be stated in full.');
    expect(rate).not.toContain('%');
  });

  it('keeps its provenance facts beside the statement', () => {
    const estimated: ReportingAmountDto = {
      ...amount('300', 'partial', NO_RATE),
      quality: 'estimated',
      provenance: { estimatedConversion: true, approximate: true, exact: false },
    };
    const figure = block(completed(figures(estimated)), 'figure-trackedTotalSpending');
    expect(figure).toMatch(/≥ .*€300\.00/su);
    expect(figure).toContain('Estimated');
    expect(figure).toContain('average rate');
    expect(figure).toContain('earlier day');
  });
});

describe('the completed month’s status line', () => {
  it('explains an estimated month in the words a user reads (§26 row 3)', () => {
    // A month with one bucket, estimated because an account was first tracked
    // in it. The line is the status line's own text, not a constant compared
    // with itself.
    const html = completed(figures(STATES.available), {
      status: 'estimated',
      buckets: [{ currency: 'EUR', status: 'estimated' }] as unknown as CompletedMonthlyPageDto['reconciliation']['buckets'],
    });
    const line = html.slice(
      html.indexOf('data-testid="reconciliation-status"'),
      html.indexOf('</div>', html.indexOf('data-testid="reconciliation-status"')),
    );
    expect(line).toContain('>Estimated<');
    expect(line).toContain(
      'An account started being tracked this month; its earlier movements are not included.',
    );
  });
});

describe('the current month’s Overview', () => {
  it('reads its month-to-date figures by the same rules', () => {
    for (const state of STATE_NAMES) {
      const html = current({
        ...figures(STATES[state]),
        kind: 'tracked_interval',
        month: '2026-10',
        asOf: '2026-10-06',
        monthStatus: 'provisional',
        sourceOnlyThrough: '2026-10-06',
      });
      for (const [key] of LOWER_BOUND) expectReads(block(html, `figure-${key}`), state, 'lower_bound');
      for (const [key] of SAVINGS) expectReads(block(html, `figure-${key}`), state, 'savings');
    }
  });

  it('reads its two facts with no common date as spending figures', () => {
    for (const state of STATE_NAMES) {
      const html = current({
        kind: 'no_tracked_interval',
        month: '2026-10',
        asOf: null,
        reason: 'mtd_no_common_date',
        monthStatus: 'unavailable',
        sourceOnlyThrough: '2026-10-06',
        reportingCurrency: 'EUR',
        additionalSpending: STATES[state],
        thirdPartyPaid: STATES[state],
      });
      expect(html).toContain('data-testid="mtd-no-common-date"');
      for (const key of ['additionalSpending', 'thirdPartyPaid']) {
        expectReads(block(html, `figure-${key}`), state, 'lower_bound');
      }
    }
  });
});
