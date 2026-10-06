import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  IncomeSourceDto,
  IncomeSourceOccurrenceDto,
  IncomeSourcePageDto,
  OccurrenceTermDto,
} from '@vaultide/application';

// The editors call server actions and the app router; neither exists outside
// Next. What a save sends is pinned through the pure helpers below.
vi.mock('@/server/actions/flows', () => ({
  createIncomeEntryAction: vi.fn(),
  deleteIncomeEntryAction: vi.fn(),
  updateIncomeEntryAction: vi.fn(),
}));
vi.mock('@/server/actions/recurring', () => ({
  acceptSuggestionAction: vi.fn(),
  archiveTemplateAction: vi.fn(),
  createTemplateAction: vi.fn(),
  setTemplateTermAction: vi.fn(),
  skipSuggestionAction: vi.fn(),
  unarchiveTemplateAction: vi.fn(),
  unskipSuggestionAction: vi.fn(),
  updateTemplateAction: vi.fn(),
}));
vi.mock('@/server/actions/corrections', () => ({
  previewHistoricalCorrectionAction: vi.fn(),
  confirmHistoricalCorrectionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const presentation = await import('@/features/income/source-presentation');
const { ARCHIVED_MISSING_HELP } = await import('@/features/income/presentation');
const { sourceChartModel } = await import('@/features/income/source-chart-model');
const { AmountHistory, SourceDetails, SourceOccurrences } = await import('@/features/income/source-view');
const { SourceArchive, SourceEndDate, SourceNameAndPayer } = await import('@/features/income/source-editor');
const { ChangeFutureAmount } = await import('@/features/monthly/income-editor');
const { endDateChangeOf, endDateChangeSummary } = await import('@/features/monthly/expenses-presentation');
const { IncomeSourceChart } = await import('@/components/charts/income-source-chart');

/**
 * The Income source page in the browser's terms (blueprint 15.2 "Income
 * source", v2.1.20 30.23; ADR 0012 D2–D4, D6).
 *
 * Every occurrence arrives with its state decided and every amount as it was
 * recorded or set, so nothing here restates a calculation. What is pinned is
 * what this page decides: where each row leads and where it must not, which
 * controls an archived source loses, when gross appears, what the step line
 * draws, what a save claims, and that the forms it borrows from Monthly and
 * Known expenses are those forms.
 */

const FORMATTING = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } };
const eur = (amount: string) => ({ amount, currency: 'EUR' });

function term(over: Partial<OccurrenceTermDto> = {}): OccurrenceTermDto {
  return { net: eur('2000'), gross: null, effectiveFrom: '2025-07-01', exact: { state: 'absent' }, ...over };
}

function source(over: Partial<IncomeSourceDto> = {}): IncomeSourceDto {
  return {
    templateId: 'tpl-salary',
    version: 3,
    name: 'Salary',
    counterparty: 'Acme',
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: '2025-07-01',
    endDate: null,
    archived: false,
    account: { positionId: 'acc-bbva', name: 'BBVA' },
    completedOccurrenceDates: ['2026-07-25', '2026-08-25', '2026-09-25'],
    ...over,
  };
}

const received = (date: string, receivedOn = date, gross: string | null = null): IncomeSourceOccurrenceDto => ({
  occurrenceDate: date,
  term: term(),
  state: {
    kind: 'received',
    payment: { entryId: `entry-${date}`, occurrenceDate: date, receivedOn, net: eur('2000'), gross: gross === null ? null : eur(gross) },
  },
});
const skipped = (date: string): IncomeSourceOccurrenceDto => ({
  occurrenceDate: date,
  term: term(),
  state: { kind: 'skipped', reason: 'other', note: 'Unpaid leave' },
});
const missing = (date: string, over: Partial<OccurrenceTermDto> = {}): IncomeSourceOccurrenceDto => ({
  occurrenceDate: date,
  term: term(over),
  state: { kind: 'missing' },
});
const notYetDue = (date: string): IncomeSourceOccurrenceDto => ({ occurrenceDate: date, term: term(), state: { kind: 'not_yet_due' } });

function pageDto(over: Partial<IncomeSourcePageDto> = {}, sourceOver: Partial<IncomeSourceDto> = {}): IncomeSourcePageDto {
  return {
    today: '2026-10-04',
    year: 2026,
    currentYear: 2026,
    minorUnitsByCurrency: FORMATTING.minorUnitsByCurrency,
    navigation: { previous: 2025, next: null },
    source: source(sourceOver),
    terms: [
      { effectiveFrom: '2025-07-01', net: eur('2000'), gross: null, note: null },
      { effectiveFrom: '2026-04-25', net: eur('2100'), gross: null, note: 'Raise' },
    ],
    arrivals: [
      { payment: { entryId: 'e1', occurrenceDate: '2026-03-25', receivedOn: '2026-04-02', net: eur('2000'), gross: null }, term: term() },
      {
        payment: { entryId: 'e2', occurrenceDate: '2026-04-25', receivedOn: '2026-04-25', net: eur('2050'), gross: null },
        term: term({ net: eur('2100'), effectiveFrom: '2026-04-25' }),
      },
    ],
    occurrences: [
      received('2026-03-25', '2026-04-02'),
      skipped('2026-05-25'),
      missing('2026-07-25'),
      missing('2026-08-25'),
      notYetDue('2026-10-25'),
    ],
    ...over,
  };
}

const render = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(element);
const monthName = (month: string): string => `month ${month}`;
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

describe('an occurrence’s row', () => {
  const page = pageDto();
  const flag = presentation.sourceMissingFlag(page);

  it('sends a received payment to the month it arrived in, which stays its editor', () => {
    expect(presentation.occurrenceLink(received('2026-03-25', '2026-04-02'), 'tpl-salary', flag, monthName)).toEqual({
      kind: 'payment',
      href: '/monthly/2026-04#income-entry-2026-03-25',
      label: 'Open month 2026-04 in Monthly',
    });
  });

  it('sends a skipped one to its own occurrence in Monthly, where it can be restored', () => {
    expect(presentation.occurrenceLink(skipped('2026-05-25'), 'tpl-salary', flag, monthName)).toEqual({
      kind: 'occurrence',
      href: '/monthly/2026-05#occurrence-tpl-salary-2026-05-25',
      label: 'Open month 2026-05 in Monthly',
    });
  });

  it('sends missing ones where the year view’s line does: Bulk History for several, Monthly for one', () => {
    expect(presentation.occurrenceLink(missing('2026-07-25'), 'tpl-salary', flag, monthName)).toEqual({
      kind: 'history',
      href: '/monthly/2026-07/history',
      label: 'Fill them in Bulk History, from month 2026-07',
    });
    const one = presentation.sourceMissingFlag(pageDto({ occurrences: [missing('2026-08-25')] }));
    expect(presentation.occurrenceLink(missing('2026-08-25'), 'tpl-salary', one, monthName)).toEqual({
      kind: 'monthly',
      href: '/monthly/2026-08#occurrence-tpl-salary-2026-08-25',
      label: 'Open month 2026-08 in Monthly',
    });
  });

  it('sends one not yet due nowhere', () => {
    expect(presentation.occurrenceLink(notYetDue('2026-10-25'), 'tpl-salary', flag, monthName)).toBeNull();
  });

  it('says when a payment arrived on another day, and why one was skipped', () => {
    const html = render(createElement(SourceOccurrences, { page, formatting: FORMATTING }));
    expect(html).toContain('Arrived 2 Apr 2026');
    expect(html).toContain('Another reason — Unpaid leave');
    expect(count(html, 'source-occurrence')).toBe(5);
    expect(html).toContain('data-state="not_yet_due"');
    expect(html).toContain('Not yet due');
    // An unresolved one shows what it is expected to be.
    expect(html).toContain('Expected');
  });

  it('lists the year’s missing payments in one line, linked as the year view links them', () => {
    expect(flag).toEqual({ templateId: 'tpl-salary', name: 'Salary', archived: false, occurrences: ['2026-07-25', '2026-08-25'] });
    const html = render(createElement(SourceOccurrences, { page, formatting: FORMATTING }));
    expect(html).toContain('Salary: 2 payments missing in 2026 (July, August).');
    expect(html).toContain('data-testid="source-missing-link"');
    expect(html).toContain('href="/monthly/2026-07/history"');
  });

  it('offers "Change the amount from…" on every row of an active source, past or upcoming', () => {
    const html = render(createElement(SourceOccurrences, { page, formatting: FORMATTING }));
    expect(count(html, 'source-change-amount')).toBe(5);
    expect(html).toContain('aria-label="Change the amount from 25 Jul 2026"');
  });

  it('says the schedule places nothing in a year that has no occurrence', () => {
    const html = render(createElement(SourceOccurrences, { page: pageDto({ occurrences: [] }), formatting: FORMATTING }));
    expect(html).toContain('The schedule places no payment in 2026.');
  });
});

describe('an archived source', () => {
  const page = pageDto({}, { archived: true });

  it('offers no change of amount, as Monthly offers none', () => {
    expect(presentation.canChangeAmount(page.source)).toBe(false);
    const html = render(createElement(SourceOccurrences, { page, formatting: FORMATTING }));
    expect(html).not.toContain('source-change-amount');
  });

  it('points its missing line at this page’s own Unarchive and end-date controls, and links nowhere else for it', () => {
    const flag = presentation.sourceMissingFlag(page);
    expect(presentation.occurrenceLink(missing('2026-07-25'), 'tpl-salary', flag, monthName)).toBeNull();
    const html = render(createElement(SourceOccurrences, { page, formatting: FORMATTING }));
    // The guidance is said once, with the two controls as links inside it.
    const line = /data-testid="source-missing-archived"[^>]*>([\s\S]*?)<\/p>/u.exec(html)?.[1] ?? '';
    expect(line.replaceAll(/<[^>]+>/gu, '')).toBe(
      'This source is archived, so its payments cannot be recorded or skipped. Unarchive it, or, if it really ended, set an end date before the missing payment.',
    );
    expect(line).toContain('href="#archive" class="underline" data-testid="source-missing-unarchive">Unarchive it</a>');
    expect(line).toContain('href="#end-date" class="underline" data-testid="source-missing-end-date">set an end date</a>');
    // Not the year view's wording as well: that line has no links to give.
    expect(html).not.toContain(ARCHIVED_MISSING_HELP);
    expect(html).not.toContain('Unarchive the source');
    expect(html).not.toContain('/history');
    expect(html).not.toContain('source-missing-link');
    // Its recorded and skipped rows still lead to Monthly.
    expect(html).toContain('href="/monthly/2026-04#income-entry-2026-03-25"');
  });

  it('says what unarchiving does, and offers it in one step', () => {
    const html = render(createElement(SourceArchive, { source: page.source }));
    expect(html).toContain('data-testid="source-unarchive"');
    expect(html).toContain(presentation.UNARCHIVE_NOTE);
  });
});

describe('archiving', () => {
  it('is offered first as a question, and says what it does before it applies', () => {
    const html = render(createElement(SourceArchive, { source: source() }));
    expect(html).toContain('data-testid="source-archive-start"');
    expect(html).not.toContain('source-archive-confirm');
    expect(presentation.ARCHIVE_CONSEQUENCES).toEqual([
      'No new payments are suggested for it.',
      'Past missing payments cannot be recorded or skipped until it is unarchived.',
      'Every payment and skip already recorded stays.',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Gross (ADR 0012 D3)                                                         */
/* -------------------------------------------------------------------------- */

describe('a gross', () => {
  it('is a column only when some term or payment in view records one', () => {
    const none = render(createElement(SourceOccurrences, { page: pageDto(), formatting: FORMATTING }));
    expect(none).not.toContain('source-gross-cell');
    expect(none).not.toContain('>Gross<');

    const fromTerm = render(
      createElement(SourceOccurrences, {
        page: pageDto({ occurrences: [received('2026-06-25'), missing('2026-07-25', { gross: eur('2800') })] }),
        formatting: FORMATTING,
      }),
    );
    expect(fromTerm).toContain('>Gross<');
    // One payment in view has none; a term with none is not counted.
    expect(fromTerm).toContain('Gross: 1 without gross.');
  });

  it('counts only payments as without gross, and shows a term’s missing gross as none', () => {
    expect(presentation.grossInView({ terms: [null, eur('2800')], payments: [eur('2900'), null, null] })).toEqual({
      show: true,
      withoutGross: 2,
    });
    expect(presentation.grossInView({ terms: [null], payments: [null] })).toEqual({ show: false, withoutGross: 1 });

    const html = render(
      createElement(AmountHistory, {
        page: pageDto({
          terms: [
            { effectiveFrom: '2025-07-01', net: eur('2000'), gross: eur('2800'), note: null },
            { effectiveFrom: '2026-04-25', net: eur('2100'), gross: null, note: null },
          ],
        }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('No gross');
    expect(html).toContain('Gross: 2 without gross.');
  });
});

/* -------------------------------------------------------------------------- */
/* The step line                                                               */
/* -------------------------------------------------------------------------- */

describe('the amount history', () => {
  it('draws each term as a step until the next one starts, and the last until today', () => {
    const model = sourceChartModel(pageDto(), 'en-GB');
    expect(model.from).toBe('2025-07-01');
    expect(model.to).toBe('2026-10-04');
    expect(model.steps).toEqual([
      { from: '2025-07-01', to: '2026-04-25', net: '2000', gross: null },
      { from: '2026-04-25', to: '2026-10-04', net: '2100', gross: null },
    ]);
    expect(model.gross).toBe(false);
  });

  it('draws what arrived at its scheduled date, and says what it was set at', () => {
    const model = sourceChartModel(pageDto(), 'en-GB');
    expect(model.points.map((point) => [point.date, point.net])).toEqual([
      ['2026-03-25', '2000'],
      ['2026-04-25', '2050'],
    ]);
    expect(model.points[0]?.title).toBe('25 Mar 2026: received €2,000.00, arrived 2 Apr 2026; set at €2,000.00');
    expect(model.points[1]?.title).toBe('25 Apr 2026: received €2,050.00; set at €2,100.00');
    expect(model.summary).toBe(
      'Salary’s amount in EUR from 1 Jul 2025 to 4 Oct 2026: 2 amounts set, as a step line, and 2 payments received, as points. The table has the exact figures.',
    );
  });

  it('stops at the end date of a source that ended, and reaches an amount set ahead', () => {
    expect(sourceChartModel(pageDto({}, { endDate: '2026-06-30' }), 'en-GB').to).toBe('2026-06-30');
    const ahead = sourceChartModel(
      pageDto({
        terms: [
          { effectiveFrom: '2025-07-01', net: eur('2000'), gross: null, note: null },
          { effectiveFrom: '2026-11-25', net: eur('2300'), gross: null, note: null },
        ],
      }),
      'en-GB',
    );
    expect(ahead.to).toBe('2026-11-25');
  });

  it('draws gross only when some term or payment records one, and only where it does', () => {
    const page = pageDto({
      terms: [
        { effectiveFrom: '2025-07-01', net: eur('2000'), gross: eur('2800'), note: null },
        { effectiveFrom: '2026-04-25', net: eur('2100'), gross: null, note: null },
      ],
    });
    const model = sourceChartModel(page, 'en-GB');
    expect(model.gross).toBe(true);
    expect(model.steps.map((step) => step.gross)).toEqual(['2800', null]);
    expect(model.points.map((point) => point.gross)).toEqual([null, null]);
    const html = render(createElement(IncomeSourceChart, model));
    expect(html).toContain('data-testid="income-source-chart-net"');
    expect(html).toContain('data-testid="income-source-chart-gross"');
    expect(count(html, 'income-source-chart-point')).toBe(2);
    expect(html).toContain('Gross set');

    const plain = render(createElement(IncomeSourceChart, sourceChartModel(pageDto(), 'en-GB')));
    expect(plain).not.toContain('income-source-chart-gross');
    expect(plain).not.toContain('Gross set');
  });

  it('has a table with every amount set and every payment against its own', () => {
    const html = render(createElement(AmountHistory, { page: pageDto(), formatting: FORMATTING }));
    expect(html).toContain('View as table');
    expect(count(html, 'source-term')).toBe(2);
    expect(html).toContain('Raise');
    expect(count(html, 'source-arrival')).toBe(2);
    // The April payment arrived at 2,050 against the 2,100 it was set at.
    expect(html).toMatch(/data-occurrence-date="2026-04-25".*€2,050\.00.*€2,100\.00/su);
  });

  it('says nothing has arrived yet rather than drawing an empty table', () => {
    const html = render(createElement(AmountHistory, { page: pageDto({ arrivals: [] }), formatting: FORMATTING }));
    expect(html).toContain('Nothing has been received from this source yet.');
  });
});

/* -------------------------------------------------------------------------- */
/* Details                                                                     */
/* -------------------------------------------------------------------------- */

describe('the details', () => {
  it('state the schedule, and the account it pays into', () => {
    const html = render(createElement(SourceDetails, { page: pageDto(), locale: 'en-GB' }));
    expect(html).toContain('Every month, on day 25');
    expect(html).toContain('BBVA');
    expect(html).toContain('No end date');
    expect(presentation.scheduleText({ frequency: 'quarterly', dayOfMonth: null, startDate: '2026-01-31' })).toBe(
      'Every three months, on day 31, or the last day of a shorter month',
    );
  });

  it('say a source with no account is tracked cash awaiting attribution, never outside tracked accounts', () => {
    const html = render(createElement(SourceDetails, { page: pageDto({}, { account: null }), locale: 'en-GB' }));
    expect(html).toContain(presentation.NO_ACCOUNT);
    expect(presentation.NO_ACCOUNT).toContain('waiting to be given an account');
    expect(presentation.NO_ACCOUNT).not.toMatch(/^Outside/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Saves (20.3)                                                                */
/* -------------------------------------------------------------------------- */

describe('a save', () => {
  it('claims the stored source the form opened with', () => {
    const opened = source({ version: 3 });
    expect(presentation.detailsPayload(opened, { name: ' Salary (Acme) ', payer: '  ' })).toEqual({
      templateId: 'tpl-salary',
      expectedVersion: 3,
      name: 'Salary (Acme)',
      counterparty: null,
    });
  });

  it('takes in a newer copy only while nothing holds the form', () => {
    const base = source({ version: 3 });
    const latest = source({ version: 4 });
    expect(presentation.adoptsNewerSource({ base, latest, held: false })).toBe(true);
    expect(presentation.adoptsNewerSource({ base, latest, held: true })).toBe(false);
    expect(presentation.adoptsNewerSource({ base, latest: base, held: false })).toBe(false);
  });

  it('shows a conflict as the server worded it, with a reload, and a refusal as it came', () => {
    expect(presentation.editProblemOf({ code: 'CONFLICT_VERSION', message: 'This source changed while you were editing it.' })).toEqual({
      kind: 'conflict',
      message: 'This source changed while you were editing it.',
    });
    expect(
      presentation.editProblemOf({
        code: 'VALIDATION_ERROR',
        message: 'This would end the schedule before 2026-06-25, which you have already recorded or skipped. Choose a later date.',
      }),
    ).toEqual({
      kind: 'refused',
      message: 'This would end the schedule before 2026-06-25, which you have already recorded or skipped. Choose a later date.',
    });
  });

  it('knows an unchanged name and payer, a cleared payer included', () => {
    expect(presentation.detailsUnchanged(source(), presentation.detailsFormOf(source()))).toBe(true);
    expect(presentation.detailsUnchanged(source({ counterparty: null }), { name: 'Salary', payer: '  ' })).toBe(true);
    expect(presentation.detailsUnchanged(source(), { name: 'Salary', payer: '' })).toBe(false);
  });

  it('starts the forms from the stored source', () => {
    const html = render(createElement(SourceNameAndPayer, { source: source() }));
    expect(html).toContain('value="Salary"');
    expect(html).toContain('value="Acme"');
    const end = render(createElement(SourceEndDate, { source: source({ endDate: '2027-01-31' }), locale: 'en-GB' }));
    expect(end).toContain('It ends on 31 Jan 2027.');
    expect(end).toContain('min="2025-07-01"');
    expect(end).toContain('data-testid="source-end-clear"');
  });
});

describe('an end-date change, through the helpers Known expenses uses', () => {
  const words = { source: 'Salary', day: (date: string) => date, month: (month: string) => month };

  it('says which completed months stop expecting a payment', () => {
    const change = endDateChangeOf(source(), '2026-07-31');
    expect(change).toMatchObject({ kind: 'ends', previous: null, next: '2026-07-31' });
    if (change.kind === 'unchanged') throw new Error('Expected a change.');
    expect(endDateChangeSummary(change, words)).toEqual([
      'Salary will end on 2026-07-31.',
      'Occurrences after that date that are not recorded or skipped stop being expected.',
      'Completed months whose expected occurrences change: 2026-08 – 2026-09.',
    ]);
  });

  it('says which may be expected again when it is removed', () => {
    const change = endDateChangeOf(source({ endDate: '2026-07-31' }), null);
    if (change.kind === 'unchanged') throw new Error('Expected a change.');
    expect(endDateChangeSummary(change, words)).toEqual([
      'Salary will no longer have an end date.',
      'Occurrences after 2026-07-31 may become expected again.',
      'Completed months whose expected occurrences change: 2026-08 – 2026-09.',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The shared amount form                                                      */
/* -------------------------------------------------------------------------- */

describe('"Change future amount", shared with Monthly', () => {
  it('still starts from the occurrence’s term, keeping a note only where a term starts there', () => {
    const at = render(
      createElement(ChangeFutureAmount, {
        templateId: 'tpl-salary',
        occurrenceDate: '2026-04-25',
        currency: 'EUR',
        term: term({ net: eur('2100'), gross: eur('2900'), exact: { state: 'version', termId: 't2', version: 2, note: 'Raise' } }),
        formatting: FORMATTING,
        onDone: () => undefined,
      }),
    );
    expect(at).toContain('Amount from 25 Apr 2026 on');
    expect(at).toContain('value="2100"');
    expect(at).toContain('value="2900"');
    expect(at).toContain('value="Raise"');
    expect(at).toContain('It does not change anything already');

    const later = render(
      createElement(ChangeFutureAmount, {
        templateId: 'tpl-salary',
        occurrenceDate: '2026-07-25',
        currency: 'EUR',
        term: term({ net: eur('2100') }),
        formatting: FORMATTING,
        onDone: () => undefined,
      }),
    );
    expect(later).toContain('value="2100"');
    expect(later).not.toContain('value="Raise"');
  });
});
