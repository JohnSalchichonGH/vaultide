import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  CurrentMonthlyIncomeDto,
  EarlyReceiptCandidateDto,
  IncomeOccurrenceDto,
  MonthlyIncomeDto,
  MonthlyIncomeEntryDto,
  OccurrenceTermDto,
} from '@vaultide/application';

// The section calls server actions and the app router; neither exists outside
// Next, and neither is what the markup tests are about. The rules that decide
// what a row may offer are exercised below through the pure helpers.
vi.mock('@/server/actions/flows', () => ({
  createIncomeEntryAction: vi.fn(),
  deleteIncomeEntryAction: vi.fn(),
  updateIncomeEntryAction: vi.fn(),
}));
vi.mock('@/server/actions/recurring', () => ({
  acceptSuggestionAction: vi.fn(),
  createTemplateAction: vi.fn(),
  setTemplateTermAction: vi.fn(),
  skipSuggestionAction: vi.fn(),
  unskipSuggestionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const { IncomeSection } = await import('@/features/monthly/income-editor');
const {
  crossMonthNotice,
  directDateBounds,
  occurrenceAnchorId,
  occurrenceStateLabel,
  ownsEntry,
  settlementOptions,
  skipReasonOptions,
  startsInThePast,
} = await import('@/features/monthly/income-presentation');

/**
 * Monthly's Income section (blueprint 6.2, 7.4, 15.3 section 2, 16.6, 20.3).
 *
 * Every state here arrives from the server. These tests pin how each row reads,
 * which controls it offers and — more often the point — which it must never
 * offer: a control the services would refuse is a control the page should not
 * have shown. Nothing financial is computed in the browser, so nothing here
 * restates an engine.
 */

const eur = (amount: string) => ({ amount, currency: 'EUR' });
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } };

const ACCOUNTS = [
  { positionId: 'pos-bbva', name: 'BBVA', currency: 'EUR' },
  { positionId: 'pos-usd', name: 'Dollars', currency: 'USD' },
];

function term(over: Partial<OccurrenceTermDto> = {}): OccurrenceTermDto {
  return {
    net: eur('2100'),
    gross: eur('2700'),
    effectiveFrom: '2026-01-01',
    exact: { state: 'absent' },
    ...over,
  };
}

function entry(over: Partial<MonthlyIncomeEntryDto> = {}): MonthlyIncomeEntryDto {
  return {
    entryId: 'entry-1',
    version: 3,
    kind: 'employment',
    settlement: 'tracked_cash',
    receivedOn: '2026-09-25',
    receivedMonth: '2026-09',
    net: eur('2100'),
    gross: eur('2700'),
    currency: 'EUR',
    cashPositionId: 'pos-bbva',
    cashAccountName: 'BBVA',
    description: null,
    tags: [],
    isOneOff: false,
    occurrence: null,
    ...over,
  };
}

function occurrence(over: Partial<IncomeOccurrenceDto> = {}): IncomeOccurrenceDto {
  return {
    templateId: 'tpl-salary',
    templateName: 'Salary',
    counterparty: 'Acme',
    incomeKind: 'employment',
    currency: 'EUR',
    occurrenceDate: '2026-09-25',
    term: term(),
    defaultCashPositionId: 'pos-bbva',
    defaultCashAccountName: 'BBVA',
    sourceArchived: false,
    state: { kind: 'due' },
    ...over,
  };
}

function candidate(over: Partial<EarlyReceiptCandidateDto> = {}): EarlyReceiptCandidateDto {
  return {
    templateId: 'tpl-bonus',
    templateName: 'Annual bonus',
    incomeKind: 'bonus',
    currency: 'EUR',
    occurrenceDate: '2027-06-15',
    occurrenceMonth: '2027-06',
    term: term({ net: eur('5000'), gross: null }),
    defaultCashPositionId: null,
    defaultCashAccountName: null,
    ...over,
  };
}

function income(over: Partial<CurrentMonthlyIncomeDto> = {}): CurrentMonthlyIncomeDto {
  return {
    occurrences: [],
    otherRecurring: [],
    direct: [],
    cashAccounts: ACCOUNTS,
    earlyReceiptCandidates: [],
    ...over,
  };
}

function render(
  value: MonthlyIncomeDto | CurrentMonthlyIncomeDto,
  over: { month?: string; today?: string; monthEndsOn?: string } = {},
): string {
  return renderToStaticMarkup(
    createElement(IncomeSection, {
      income: value,
      month: over.month ?? '2026-09',
      monthName: 'September 2026',
      monthEndsOn: over.monthEndsOn ?? '2026-09-30',
      today: over.today ?? '2026-10-01',
      reportingCurrency: 'EUR',
      formatting,
    }),
  );
}

/** Every `data-testid="x"` occurrence in the markup. */
const count = (html: string, testId: string): number =>
  html.match(new RegExp(`data-testid="${testId}"`, 'gu'))?.length ?? 0;

const has = (html: string, testId: string): boolean => count(html, testId) > 0;

/* -------------------------------------------------------------------------- */
/* Scheduled occurrences                                                       */
/* -------------------------------------------------------------------------- */

describe('a scheduled occurrence', () => {
  it('offers recording, adjusting, a term change and a skip when it is due', () => {
    const html = render(income({ occurrences: [occurrence()] }));
    expect(has(html, 'occurrence-accept')).toBe(true);
    expect(has(html, 'occurrence-adjust')).toBe(true);
    expect(has(html, 'occurrence-skip')).toBe(true);
    expect(has(html, 'occurrence-term')).toBe(true);
    // Nothing has happened yet, so there is no financial row to correct and no
    // early-receipt path to offer.
    expect(has(html, 'occurrence-received-today')).toBe(false);
    expect(has(html, 'entry-net')).toBe(false);
    expect(html).toContain('Not recorded');
  });

  it('will not offer to record an occurrence its source has no amount for', () => {
    const html = render(
      income({
        occurrences: [
          occurrence({ term: term({ net: null, gross: null, effectiveFrom: null }) }),
        ],
      }),
    );
    // Unknown is never zero: one-click acceptance has nothing to write, so the
    // amount has to be stated through "adjust and record".
    expect(html).toContain('data-testid="occurrence-accept" class');
    expect(html).toMatch(/data-testid="occurrence-accept"[^>]*disabled/u);
    expect(has(html, 'occurrence-adjust')).toBe(true);
  });

  it('offers a future occurrence no way in but the one the server says is next', () => {
    const eligible = render(
      income({
        occurrences: [
          occurrence({ state: { kind: 'upcoming', receivedTodayEligible: true } }),
        ],
      }),
    );
    expect(has(eligible, 'occurrence-received-today')).toBe(true);
    expect(has(eligible, 'occurrence-accept')).toBe(false);
    expect(has(eligible, 'occurrence-adjust')).toBe(false);

    const ineligible = render(
      income({
        occurrences: [
          occurrence({ state: { kind: 'upcoming', receivedTodayEligible: false } }),
        ],
      }),
    );
    expect(has(ineligible, 'occurrence-received-today')).toBe(false);
    // Still skippable, and its future amount can still be set: neither is a
    // claim that money moved.
    expect(has(ineligible, 'occurrence-skip')).toBe(true);
    expect(has(ineligible, 'occurrence-term')).toBe(true);
  });

  it('shows an accepted occurrence with both dates and the fields a correction needs', () => {
    const html = render(
      income({
        occurrences: [
          occurrence({
            state: {
              kind: 'accepted',
              entry: entry({ occurrence: null, receivedOn: '2026-09-24' }),
            },
          }),
        ],
      }),
    );
    expect(html).toContain('Scheduled 25 Sept 2026');
    expect(html).toContain('Received 24 Sept 2026');
    expect(has(html, 'entry-net')).toBe(true);
    expect(has(html, 'entry-gross')).toBe(true);
    expect(has(html, 'entry-delete')).toBe(true);
    // Its identity is not up for editing, and a term change stays a separate act.
    expect(has(html, 'entry-received-on')).toBe(false);
    expect(has(html, 'occurrence-accept')).toBe(false);
    expect(has(html, 'occurrence-term')).toBe(true);
  });

  it('shows a skipped occurrence with its reason and note, and offers a restore', () => {
    const html = render(
      income({
        occurrences: [
          occurrence({
            state: {
              kind: 'skipped',
              skipId: 'skip-1',
              reason: 'vacant',
              note: 'Between tenants.',
            },
          }),
        ],
      }),
    );
    expect(html).toContain('Property was empty');
    expect(html).toContain('Between tenants.');
    expect(has(html, 'occurrence-restore')).toBe(true);
    expect(has(html, 'occurrence-accept')).toBe(false);
    expect(has(html, 'occurrence-skip')).toBe(false);
  });

  it('offers an archived source’s unresolved occurrence nothing at all', () => {
    const html = render(income({ occurrences: [occurrence({ sourceArchived: true })] }));
    expect(html).toContain('Not recorded');
    expect(html).toContain('Source archived');
    // The services refuse a new acceptance or skip on an archived source, and
    // reactivating a whole schedule is not a month's business either (§30.10).
    expect(has(html, 'occurrence-accept')).toBe(false);
    expect(has(html, 'occurrence-adjust')).toBe(false);
    expect(has(html, 'occurrence-skip')).toBe(false);
    expect(has(html, 'occurrence-term')).toBe(false);
    expect(html.toLowerCase()).not.toContain('unarchive');
  });

  it('anchors each row on the identity the missing-income issue names', () => {
    const html = render(income({ occurrences: [occurrence()] }));
    expect(html).toContain(`id="${occurrenceAnchorId('tpl-salary', '2026-09-25')}"`);
    expect(html).toContain('data-template-id="tpl-salary"');
    expect(html).toContain('data-occurrence-date="2026-09-25"');
  });

  it('formats money in the currency’s own scale, exactly', () => {
    const html = render(
      income({ occurrences: [occurrence({ term: term({ net: eur('2100.5'), gross: null }) })] }),
    );
    expect(html).toContain('2,100.50');
  });
});

/* -------------------------------------------------------------------------- */
/* Across a month boundary                                                     */
/* -------------------------------------------------------------------------- */

describe('a row whose money belongs to another month', () => {
  const acceptedElsewhere = occurrence({
    occurrenceDate: '2026-09-25',
    state: {
      kind: 'accepted',
      entry: entry({ receivedOn: '2026-10-02', receivedMonth: '2026-10' }),
    },
  });

  it('is read-only on the schedule’s page, with a link to the month that holds it', () => {
    const html = render(income({ occurrences: [acceptedElsewhere] }));
    expect(html).toContain('Scheduled 25 Sept 2026');
    expect(html).toContain('Received 2 Oct 2026');
    expect(has(html, 'entry-elsewhere')).toBe(true);
    expect(html).toContain('href="/monthly/2026-10#income"');
    // October's reconciliation is not September's to change.
    expect(has(html, 'entry-net')).toBe(false);
    expect(has(html, 'entry-delete')).toBe(false);
  });

  it('is editable on the page whose month holds the money', () => {
    const html = render(income({ occurrences: [acceptedElsewhere] }), {
      month: '2026-10',
      monthEndsOn: '2026-10-31',
      today: '2026-11-01',
    });
    expect(has(html, 'entry-net')).toBe(true);
    expect(has(html, 'entry-delete')).toBe(true);
    expect(has(html, 'entry-elsewhere')).toBe(false);
  });

  it('lists recurring money received here for another month’s occurrence, linked to it', () => {
    const html = render(
      income({
        otherRecurring: [
          entry({
            receivedOn: '2026-09-30',
            occurrence: {
              templateId: 'tpl-salary',
              templateName: 'Salary',
              occurrenceDate: '2026-10-01',
              occurrenceMonth: '2026-10',
            },
          }),
        ],
      }),
    );
    expect(has(html, 'income-other-recurring')).toBe(true);
    expect(html).toContain('For the occurrence scheduled 1 Oct 2026');
    expect(html).toContain('href="/monthly/2026-10#income"');
    // Received here, so this page owns it.
    expect(has(html, 'entry-net')).toBe(true);
  });

  it('renders one entry exactly once, whichever group it is in', () => {
    const shared = entry({ entryId: 'entry-shared' });
    const html = render(
      income({
        occurrences: [occurrence({ state: { kind: 'accepted', entry: shared } })],
        direct: [entry({ entryId: 'entry-other', kind: 'other', occurrence: null })],
      }),
    );
    expect(count(html, 'income-entry')).toBe(1);
    expect(html.match(/data-entry-id="entry-shared"/gu)).toBeNull();
    expect(count(html, 'income-occurrence')).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Early receipt beyond the month                                              */
/* -------------------------------------------------------------------------- */

describe('the early-receipt offer', () => {
  it('names the next occurrence and the month it belongs to, however far off', () => {
    const html = render(income({ earlyReceiptCandidates: [candidate()] }));
    expect(has(html, 'income-early-candidates')).toBe(true);
    expect(html).toContain('Next on 15 Jun 2027');
    expect(html).toContain('June 2027');
    expect(has(html, 'early-received-today')).toBe(true);
  });

  it('is absent entirely when no source has one', () => {
    expect(has(render(income({ occurrences: [occurrence()] })), 'income-early-candidates')).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Recorded rows                                                               */
/* -------------------------------------------------------------------------- */

describe('a recorded income row', () => {
  it('shows an unattributed tracked flow as awaiting an account, never as external', () => {
    const html = render(
      income({
        direct: [entry({ cashPositionId: null, cashAccountName: null, kind: 'other' })],
      }),
    );
    expect(html).toContain('Not attributed yet');
    expect(html).not.toContain('Outside my tracked accounts');
  });

  it('says how income received outside tracked accounts arrived', () => {
    const html = render(
      income({
        direct: [
          entry({ settlement: 'external', cashPositionId: null, cashAccountName: null }),
        ],
      }),
    );
    expect(html).toContain('Outside my tracked accounts');
    // There is no account to choose for a flow that never touched one.
    expect(has(html, 'entry-account')).toBe(false);
  });

  it('offers to remove a gross figure only where there is one', () => {
    expect(has(render(income({ direct: [entry()] })), 'entry-clear-gross')).toBe(true);
    expect(has(render(income({ direct: [entry({ gross: null })] })), 'entry-clear-gross')).toBe(
      false,
    );
  });

  it('keeps a direct row’s date inside the month on screen', () => {
    const html = render(income({ direct: [entry({ kind: 'other' })] }), {
      month: '2026-09',
      monthEndsOn: '2026-09-30',
      today: '2026-10-15',
    });
    expect(html).toContain('min="2026-09-01"');
    expect(html).toContain('max="2026-09-30"');
  });

  it('stops a current month’s date at today rather than at the month’s end', () => {
    const html = render(income({ direct: [entry({ receivedOn: '2026-09-04' })] }), {
      month: '2026-09',
      monthEndsOn: '2026-09-30',
      today: '2026-09-10',
    });
    expect(html).toContain('max="2026-09-10"');
  });

  it('offers only accounts that could hold the flow’s currency', () => {
    const html = render(income({ direct: [entry({ kind: 'other' })] }));
    expect(html).toContain('>BBVA<');
    // The USD account cannot hold a euro flow, and the service would refuse it.
    expect(html).not.toContain('>Dollars<');
  });
});

/* -------------------------------------------------------------------------- */
/* Empty states and the two forms                                              */
/* -------------------------------------------------------------------------- */

describe('the section’s shape', () => {
  it('says plainly when a month has no schedule and nothing recorded', () => {
    const html = render(income());
    expect(has(html, 'income-occurrences-empty')).toBe(true);
    expect(has(html, 'income-direct-empty')).toBe(true);
    expect(has(html, 'income-other-recurring')).toBe(false);
  });

  it('offers adding income and adding a source, and nothing that manages one', () => {
    const html = render(income());
    expect(has(html, 'income-add-toggle')).toBe(true);
    expect(has(html, 'source-add-toggle')).toBe(true);
    const lower = html.toLowerCase();
    expect(lower).not.toContain('archive');
    expect(lower).not.toContain('unarchive');
    expect(lower).not.toContain('delete source');
  });

  it('keeps a wide table, and everything inside it, in its own scroll container', () => {
    const html = render(income({ occurrences: [occurrence()] }));
    // A table that widens the page widens the phone viewport with it — and a
    // scroll container that is not positioned does not hold its absolutely
    // positioned descendants, so the visually hidden labels escape the clip and
    // widen the page from the right edge instead.
    expect(html).toContain('class="relative overflow-x-auto"');
    expect(html).not.toContain('min-w-');
  });

  it('labels every table for assistive technology', () => {
    const html = render(
      income({ occurrences: [occurrence()], direct: [entry({ kind: 'other' })] }),
    );
    expect(html).toContain('Recurring income scheduled in September 2026');
    expect(html).toContain('Income received in September 2026 that no source scheduled');
  });
});

/* -------------------------------------------------------------------------- */
/* The rules behind the controls                                               */
/* -------------------------------------------------------------------------- */

describe('what a control may offer', () => {
  it('offers occupancy reasons for a rental and for nothing else', () => {
    expect(skipReasonOptions('rental').map((option) => option.value)).toEqual([
      'skipped',
      'vacant',
      'non_payment',
      'other',
    ]);
    expect(skipReasonOptions('employment').map((option) => option.value)).toEqual([
      'skipped',
      'other',
    ]);
  });

  it('offers the settlements a kind may actually carry in this phase', () => {
    expect(settlementOptions('employment').map((option) => option.value)).toEqual([
      'tracked_cash',
      'external',
    ]);
    // 7.4 defines an external distribution only when it links an investment.
    expect(settlementOptions('dividend').map((option) => option.value)).toEqual(['tracked_cash']);
    expect(settlementOptions('adjustment').map((option) => option.value)).toEqual(['tracked_cash']);
  });

  it('names a completed month’s unresolved occurrence as the issue does', () => {
    expect(occurrenceStateLabel(occurrence())).toBe('Not recorded');
    expect(
      occurrenceStateLabel(
        occurrence({ state: { kind: 'upcoming', receivedTodayEligible: false } }),
      ),
    ).toBe('Upcoming');
    expect(
      occurrenceStateLabel(occurrence({ state: { kind: 'accepted', entry: entry() } })),
    ).toBe('Recorded');
  });

  it('gives editing to the month that holds the money', () => {
    expect(ownsEntry(entry({ receivedMonth: '2026-09' }), '2026-09')).toBe(true);
    expect(ownsEntry(entry({ receivedMonth: '2026-10' }), '2026-09')).toBe(false);
  });

  it('warns before an acceptance lands in another month, and stays quiet otherwise', () => {
    const name = (month: string) => (month === '2026-09' ? 'September' : 'October');
    expect(crossMonthNotice('2026-09-25', '2026-09', name)).toBeNull();
    expect(crossMonthNotice('2026-10-02', '2026-09', name)).toContain('October');
    expect(crossMonthNotice('2026-10-02', '2026-09', name)).toContain('September');
  });

  it('bounds a direct row by the month, and by today inside it', () => {
    expect(directDateBounds({ month: '2026-09', monthEndsOn: '2026-09-30', today: '2026-10-05' })).toEqual(
      { min: '2026-09-01', max: '2026-09-30' },
    );
    expect(directDateBounds({ month: '2026-09', monthEndsOn: '2026-09-30', today: '2026-09-08' })).toEqual(
      { min: '2026-09-01', max: '2026-09-08' },
    );
  });

  it('knows when a source’s start date reaches back into finished months', () => {
    expect(startsInThePast('2026-01-01', '2026-09-10')).toBe(true);
    expect(startsInThePast('2026-09-10', '2026-09-10')).toBe(false);
    expect(startsInThePast('2026-12-01', '2026-09-10')).toBe(false);
  });
});
