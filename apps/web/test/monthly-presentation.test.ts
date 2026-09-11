import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReconciliationIssueDto, ReportingAmountDto } from '@vaultide/application';

// The review controls call server actions and the app router; neither exists
// outside Next, and neither is what these tests are about.
vi.mock('@/server/actions/monthly', () => ({
  markMonthReviewedAction: vi.fn(),
  dismissMonthAdvisoryAction: vi.fn(),
  restoreMonthAdvisoryAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const {
  completenessMeaning,
  dayTitle,
  isEditableTarget,
  isOpenableMonth,
  issueSummary,
  issueTitle,
  missingReason,
  missingSummary,
  monthTitle,
  presentIssues,
  savingsRateReason,
} = await import('@/features/monthly/presentation');
const { IssuesPanel } = await import('@/features/monthly/issues');
const { ReportingFigure } = await import('@/features/monthly/reporting-figure');

/**
 * The Monthly page's presentation (blueprint 8.5, 12.6, 15.3; 6.2 for why a
 * dismissal is a key).
 *
 * What is decided here is only how things read and where they sit: which
 * issues share a control, which may be hidden at all, where a hidden one goes,
 * and how an incomplete figure says so. Nothing is computed, so nothing here
 * restates an engine.
 */

function issue(over: Partial<ReconciliationIssueDto> & Pick<ReconciliationIssueDto, 'key' | 'class'>): ReconciliationIssueDto {
  return {
    currency: 'EUR',
    positionId: null,
    positionName: null,
    amount: null,
    variant: null,
    templateId: null,
    templateName: null,
    occurrenceDate: null,
    expectedAmount: null,
    ...over,
  };
}

const missingEnd = issue({ key: 'missing_month_end', class: 'blocking', positionId: 'p1', positionName: 'BBVA' });
const firstBalance = issue({ key: 'first_balance', class: 'info', positionId: 'p2', positionName: 'Savings' });
const interest = issue({
  key: 'possible_missing_interest',
  class: 'advisory',
  positionId: 'p2',
  positionName: 'Savings',
  amount: { amount: '10', currency: 'EUR' },
});
const salary = (date: string, templateId: string) =>
  issue({
    key: 'suggested_income_missing',
    class: 'advisory',
    templateId,
    templateName: templateId === 't1' ? 'Salary' : 'Freelance',
    occurrenceDate: date,
    expectedAmount: { amount: '2100', currency: 'EUR' },
  });

describe('grouping the month’s issues', () => {
  it('puts every instance of a key in one group, blocking first, and keeps each class’s order', () => {
    const presentation = presentIssues(
      [interest, salary('2026-09-01', 't1'), firstBalance, missingEnd, salary('2026-09-25', 't2')],
      [],
    );

    expect(presentation.active.map((group) => [group.key, group.issueClass, group.instances.length])).toEqual([
      ['missing_month_end', 'blocking', 1],
      ['possible_missing_interest', 'advisory', 1],
      ['suggested_income_missing', 'advisory', 2],
      ['first_balance', 'info', 1],
    ]);
    expect(presentation.dismissed).toEqual([]);
  });

  it('lets only an advisory be hidden', () => {
    const presentation = presentIssues([missingEnd, firstBalance, interest], []);
    const dismissable = Object.fromEntries(presentation.active.map((group) => [group.key, group.dismissable]));
    expect(dismissable).toEqual({
      missing_month_end: false,
      first_balance: false,
      possible_missing_interest: true,
    });
  });

  it('moves a dismissed advisory key aside with every instance of it, and back when restored', () => {
    const issues = [missingEnd, salary('2026-09-01', 't1'), salary('2026-09-25', 't2')];

    const hidden = presentIssues(issues, ['suggested_income_missing']);
    expect(hidden.active.map((group) => group.key)).toEqual(['missing_month_end']);
    expect(hidden.dismissed.map((group) => [group.key, group.instances.length])).toEqual([
      ['suggested_income_missing', 2],
    ]);

    const restored = presentIssues(issues, []);
    expect(restored.active.map((group) => group.key)).toEqual(['missing_month_end', 'suggested_income_missing']);
    expect(restored.dismissed).toEqual([]);
  });

  it('never hides a blocking or informational issue, whatever is stored', () => {
    const presentation = presentIssues([missingEnd, firstBalance], ['missing_month_end', 'first_balance']);
    expect(presentation.active.map((group) => group.key)).toEqual(['missing_month_end', 'first_balance']);
    expect(presentation.dismissed).toEqual([]);
  });

  it('shows nothing for a stored key the month did not raise', () => {
    const presentation = presentIssues([missingEnd], ['possible_missing_interest', 'stale_property']);
    expect(presentation.active.map((group) => group.key)).toEqual(['missing_month_end']);
    expect(presentation.dismissed).toEqual([]);
  });
});

describe('the words for each issue', () => {
  it('names every key Phase 3 can raise, and both unexplained-inflow readings apart', () => {
    const keys = [
      'missing_month_end',
      'first_balance',
      'flow_without_cash_account',
      'possible_missing_conversion',
      'possible_missing_interest',
      'suggested_income_missing',
      'large_unclassified',
      'mtd_no_common_date',
      'mtd_newer_balances',
    ];
    const titles = keys.map((key) => issueTitle({ key, variant: null }));
    expect(new Set(titles).size).toBe(keys.length);
    for (const title of titles) expect(title).not.toMatch(/_/u);

    expect(issueTitle({ key: 'unexplained_inflow', variant: 'a' })).toBe('Cash grew more than your records explain');
    expect(issueTitle({ key: 'unexplained_inflow', variant: 'b' })).toBe('Known expenses exceed the cash that left');
    expect(issueSummary({ key: 'unexplained_inflow', variant: 'b' })).toContain('paid from outside');
  });

  it('says a hidden income advisory is not a skip', () => {
    expect(issueSummary({ key: 'suggested_income_missing', variant: null })).toMatch(
      /does not skip the income or record it/u,
    );
  });

  it('falls back to readable words for a key it does not know', () => {
    expect(issueTitle({ key: 'stale_property', variant: null })).toBe('Stale property');
  });
});

describe('what an incomplete figure says', () => {
  it('names each missing contribution once, in words', () => {
    expect(
      missingSummary([
        { currency: 'USD', reason: 'fx_missing' },
        { currency: 'USD', reason: 'fx_missing' },
        { currency: 'GBP', reason: 'not_applicable', detail: 'unresolved' },
      ]),
    ).toBe('USD (no exchange rate), GBP (the records contradict the balances)');
    expect(missingReason({ reason: 'missing_month_end' })).toBe('a month-end balance is missing');
    expect(missingReason({ reason: 'not_applicable', detail: 'reconciliation_unavailable' })).toBe(
      'spending could not be inferred',
    );
  });

  it('explains an unavailable savings rate by its own cause', () => {
    expect(savingsRateReason('divide_by_zero', 'External income is zero.')).toMatch(/no income/u);
    expect(savingsRateReason('not_applicable', 'personal savings could not be stated in full')).toBe(
      'Personal savings could not be stated in full.',
    );
  });

  const amount = (over: Partial<ReportingAmountDto>): ReportingAmountDto => ({
    value: { amount: '0', currency: 'EUR' },
    availability: 'available',
    missing: [],
    provenance: { estimatedConversion: false, approximate: false, exact: true },
    ...over,
  });
  const render = (value: ReportingAmountDto) =>
    renderToStaticMarkup(
      createElement(ReportingFigure, { label: 'Tracked spending', amount: value, locale: 'en-GB', minorUnits: 2, testId: 'figure' }),
    );

  it('shows an unavailable figure as a dash with its reason, never as the zero it holds', () => {
    const html = render(amount({ availability: 'unavailable', missing: [{ currency: 'EUR', reason: 'missing_month_end' }] }));
    expect(html).toContain('Unavailable');
    expect(html).toContain('a month-end balance is missing');
    expect(html).not.toContain('0.00');
  });

  it('shows a partial figure with its amount and what is not inside it', () => {
    const html = render(
      amount({ value: { amount: '410.5', currency: 'EUR' }, availability: 'partial', missing: [{ currency: 'USD', reason: 'fx_missing' }] }),
    );
    expect(html).toContain('410.50');
    expect(html).toContain('Partial');
    expect(html).toContain('Not included: USD (no exchange rate)');
  });

  it('marks an average-rate conversion without calling the figure partial', () => {
    const html = render(
      amount({
        value: { amount: '12', currency: 'EUR' },
        provenance: { estimatedConversion: true, approximate: false, exact: false },
      }),
    );
    expect(html).toContain('average rate');
    expect(html).not.toContain('Partial');
  });
});

describe('the issues panel', () => {
  const panel = (issues: readonly ReconciliationIssueDto[], dismissed: readonly string[]) =>
    renderToStaticMarkup(
      createElement(IssuesPanel, {
        presentation: presentIssues(issues, dismissed),
        month: '2026-09',
        monthName: 'September 2026',
        context: { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 }, names: new Map([['p1', 'BBVA']]) },
      }),
    );

  it('gives blocking and informational issues no control, and one advisory key one control', () => {
    const html = panel([missingEnd, firstBalance, salary('2026-09-01', 't1'), salary('2026-09-25', 't2')], []);
    expect(html).not.toContain('data-testid="dismiss-missing_month_end"');
    expect(html).not.toContain('data-testid="dismiss-first_balance"');
    expect(html.match(/data-testid="dismiss-suggested_income_missing"/gu)).toHaveLength(1);
    expect(html).toContain('all 2 of them');
    expect(html).not.toContain('dismissed-advisories');
  });

  it('lists a hidden advisory in the collapsed area, with a control to show it again', () => {
    const html = panel([missingEnd, interest], ['possible_missing_interest']);
    expect(html).toContain('data-testid="dismissed-advisories"');
    expect(html).toContain('data-testid="restore-possible_missing_interest"');
    expect(html).not.toContain('data-testid="dismiss-possible_missing_interest"');
    expect(html).toContain('Hidden advisories (1)');
  });
});

describe('months and keys', () => {
  it('titles months and days in the user’s locale without drifting across a timezone', () => {
    expect(monthTitle('2026-09', 'en-GB')).toBe('September 2026');
    expect(monthTitle('2026-01', 'en-GB')).toBe('January 2026');
    // ICU spells September's short form "Sep" or "Sept" depending on its version.
    expect(dayTitle('2026-09-06', 'en-GB')).toMatch(/^6 Sept? 2026$/u);
    expect(dayTitle('2026-12-31', 'en-GB')).toMatch(/^31 Dec 2026$/u);
  });

  it('opens only a well-formed month no later than the current one', () => {
    expect(isOpenableMonth('2026-09', '2026-10')).toBe(true);
    expect(isOpenableMonth('2026-10', '2026-10')).toBe(true);
    expect(isOpenableMonth('2026-11', '2026-10')).toBe(false);
    expect(isOpenableMonth('2026-13', '2027-01')).toBe(false);
    expect(isOpenableMonth('2026-00', '2027-01')).toBe(false);
    expect(isOpenableMonth('Sept', '2026-10')).toBe(false);
  });

  it('leaves keys alone in anything that takes text', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'SPAN', closest: () => ({}) })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON', closest: () => null })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('describes a month with nothing required without a ratio', () => {
    expect(completenessMeaning('sufficient', 0)).toBe('Nothing was required this month.');
    expect(completenessMeaning('stale', 0)).toMatch(/No balance was recorded/u);
  });
});
