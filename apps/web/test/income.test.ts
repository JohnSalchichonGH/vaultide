import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  CorrectionDraft,
  CorrectionPreview,
  IncomeMissingFlagDto,
  IncomeMonthDto,
  IncomePageDto,
  IncomeTotalDto,
  ReportingAmountDto,
} from '@vaultide/application';
import type { CorrectionFlow } from '@/features/corrections/use-correction';

// The one ordinary action the payment form sends, observed.
const createIncomeEntryAction = vi.fn();
vi.mock('@/server/actions/flows', () => ({
  createIncomeEntryAction,
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
const previewHistoricalCorrectionAction = vi.fn();
vi.mock('@/server/actions/corrections', () => ({
  previewHistoricalCorrectionAction,
  confirmHistoricalCorrectionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const { attemptCorrection, prepareReviewWith } = await import('@/features/corrections/use-correction');
const { AddIncomeForm, AddIncomeSourceForm, AddIncomeWithReview, saveNewIncome } = await import(
  '@/features/monthly/income-editor'
);
const { addsToClosedMonth } = await import('@/features/corrections/delete-confirm');
const { EARLIEST_CORRECTABLE_DATE, dateBoundsMessage, ownedEntryDateBounds } = await import(
  '@/features/monthly/income-presentation'
);
const presentation = await import('@/features/income/presentation');
const { incomeChartModel } = await import('@/features/income/chart-model');
const { MissingPayments, SourcesTable, IncomeSummary, MonthsTable } = await import('@/features/income/year-view');

/**
 * The Income year view in the browser's terms (blueprint 15.2 "Income",
 * v2.1.20 30.23; ADR 0012 D1–D3, D5, D6).
 *
 * Every figure arrives decided, so nothing here restates a calculation. What is
 * pinned is what this page decides: its words, which figures and columns it
 * shows, where each line links and where it must not, and how the one form two
 * pages share differs between them — the kinds, the dates and the save.
 */

const FORMATTING = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2, USD: 2 } };

function amount(value: string, availability: ReportingAmountDto['availability'] = 'available', currency = 'EUR'): ReportingAmountDto {
  return {
    value: { amount: value, currency: 'EUR' },
    availability,
    missing: availability === 'available' ? [] : [{ currency, reason: 'fx_missing' }],
    provenance: { estimatedConversion: false, approximate: false, exact: true },
  };
}

function total(net: string, over: Partial<IncomeTotalDto> = {}): IncomeTotalDto {
  return {
    net: amount(net),
    gross: { recorded: null, withoutGross: 1 },
    native: [{ amount: net, currency: 'EUR' }],
    count: 1,
    ...over,
  };
}

function month(key: string, net: string, over: Partial<IncomeMonthDto> = {}): IncomeMonthDto {
  return { month: key, current: false, total: total(net), salary: amount(net), bonus: amount('0'), other: amount('0'), ...over };
}

function flag(over: Partial<IncomeMissingFlagDto> = {}): IncomeMissingFlagDto {
  return { templateId: 'tpl-salary', name: 'Salary', archived: false, occurrences: ['2026-08-25', '2026-09-25'], ...over };
}

function pageDto(over: Partial<IncomePageDto['view']> = {}, rest: Partial<IncomePageDto> = {}): IncomePageDto {
  return {
    year: 2026,
    currentYear: 2026,
    today: '2026-10-04',
    reportingCurrency: 'EUR',
    minorUnitsByCurrency: FORMATTING.minorUnitsByCurrency,
    selectableCurrencyCodes: ['EUR', 'USD'],
    empty: false,
    navigation: { previous: 2025, next: null },
    view: {
      year: 2026,
      current: true,
      months: [month('2026-09', '2000.00')],
      total: total('2000.00'),
      tracked: total('2000.00'),
      outside: total('0'),
      sourceOrder: 'amount',
      sources: [{ templateId: 'tpl-salary', name: 'Salary', archived: false, currency: 'EUR', total: total('2000.00') }],
      oneOff: null,
      missing: [],
      ...over,
    },
    years: [{ year: 2026, current: true, total: total('2000.00') }],
    lastTwelveMonths: { from: '2025-11', to: '2026-10', total: total('2000.00') },
    forms: { paymentKinds: ['employment', 'bonus', 'freelance', 'rental', 'dividend', 'interest', 'other'], cashAccounts: [] },
    ...rest,
  };
}

const render = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(element);

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

describe('the labels that keep this page’s figures apart from Monthly’s', () => {
  it('calls this page’s figure income recorded, split into tracked and outside', () => {
    expect(presentation.INCOME_RECORDED).toBe('Income recorded');
    expect(presentation.TRACKED_LABEL).toBe('Into tracked accounts');
    expect(presentation.OUTSIDE_LABEL).toBe('Outside tracked accounts');
  });

  it('names Monthly’s figure and the four places the two can differ', () => {
    const text = presentation.DIFFERS_FROM_MONTHLY;
    expect(text).toContain('“Tracked income”');
    for (const place of [
      'outside tracked accounts',
      'first tracked month',
      'a month or currency with no tracked account',
      'current month',
    ]) {
      expect(text).toContain(place);
    }
  });

  it('shows the summary under those labels, with the year so far and the last twelve months', () => {
    const html = render(createElement(IncomeSummary, { page: pageDto(), formatting: FORMATTING }));
    expect(html).toContain('Income recorded in 2026 (so far)');
    expect(html).toContain('Into tracked accounts');
    expect(html).toContain('Outside tracked accounts');
    expect(html).toContain('Last 12 months (so far)');
    expect(html).toContain('November 2025 – October 2026');
    expect(html).not.toContain('>Income<');
  });
});

/* -------------------------------------------------------------------------- */
/* Figures                                                                     */
/* -------------------------------------------------------------------------- */

describe('an income figure', () => {
  it('reads as itself when complete', () => {
    expect(presentation.incomeFigureDisplay(amount('12.50'))).toEqual({ kind: 'value', amount: '12.50', currency: 'EUR' });
  });

  it('reads as a lower bound when partial, naming what it leaves out', () => {
    expect(presentation.incomeFigureDisplay(amount('2000', 'partial', 'USD'))).toEqual({
      kind: 'at_least',
      amount: '2000',
      currency: 'EUR',
      reason: 'Not included: USD (no exchange rate).',
    });
  });

  it('reads as nothing when nothing above zero could be stated', () => {
    expect(presentation.incomeFigureDisplay(amount('0', 'partial')).kind).toBe('none');
    expect(presentation.incomeFigureDisplay(amount('0', 'unavailable')).kind).toBe('none');
  });

  it('marks a partial figure on the page, never as a clean number', () => {
    const html = render(
      createElement(IncomeSummary, {
        page: pageDto({ total: total('2000', { net: amount('2000', 'partial', 'USD') }) }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('data-bound="at-least"');
    expect(html).toContain('Not included: USD (no exchange rate).');
  });
});

describe('a gross', () => {
  const withGross = (recorded: string, withoutGross: number): IncomeTotalDto =>
    total('2000', { gross: { recorded: amount(recorded), withoutGross }, count: 3 });

  it('is a column only when some payment in view recorded one', () => {
    expect(presentation.showsGross([total('1'), total('2')])).toBe(false);
    expect(presentation.showsGross([total('1'), withGross('2800', 0)])).toBe(true);
    expect(render(createElement(SourcesTable, { page: pageDto(), formatting: FORMATTING }))).not.toContain('Gross');
    expect(render(createElement(MonthsTable, { months: [month('2026-09', '2')], formatting: FORMATTING }))).not.toContain('Gross');
  });

  it('says how many payments it does not cover', () => {
    expect(presentation.withoutGrossNote({ recorded: amount('1'), withoutGross: 0 })).toBeNull();
    expect(presentation.withoutGrossNote({ recorded: amount('1'), withoutGross: 2 })).toBe('2 without gross');
    const html = render(
      createElement(SourcesTable, {
        page: pageDto({
          sources: [
            { templateId: 'a', name: 'Salary', archived: false, currency: 'EUR', total: withGross('2800', 1) },
            { templateId: 'b', name: 'Interest', archived: false, currency: 'EUR', total: total('3') },
          ],
        }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('Gross (EUR)');
    expect(html).toContain('1 without gross');
    // A source with none says so; it is never a zero.
    expect(html).toContain('No gross');
  });

  it('appears in the summary with what it covers, and not at all when nobody recorded one', () => {
    const covered = render(
      createElement(IncomeSummary, { page: pageDto({ total: withGross('5600', 1) }), formatting: FORMATTING }),
    );
    expect(covered).toContain('Gross in 2026 (so far)');
    expect(covered).toContain('Covers 2 of 3 payments; 1 without gross.');
    expect(render(createElement(IncomeSummary, { page: pageDto(), formatting: FORMATTING }))).not.toContain('Gross');
  });
});

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

describe('the sources table', () => {
  it('labels an archived source, and links each source’s name to its own page', () => {
    const html = render(
      createElement(SourcesTable, {
        page: pageDto({
          sources: [{ templateId: 'old', name: 'Old job', archived: true, currency: 'EUR', total: total('4500') }],
        }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('data-testid="income-source-archived"');
    expect(html).toContain('href="/income/sources/old"');
    expect(html).toMatch(/<a href="\/income\/sources\/old"[^>]*>Old job<\/a>/u);
  });

  it('says why it is ordered by name when a rate is missing', () => {
    expect(presentation.sourceOrderNote('amount', 'EUR')).toBeNull();
    const html = render(
      createElement(SourcesTable, { page: pageDto({ sourceOrder: 'name' }), formatting: FORMATTING }),
    );
    expect(html).toContain('Ordered by name: some amounts could not be converted to EUR');
  });

  it('shows a foreign source’s own currency beside its converted net', () => {
    const html = render(
      createElement(SourcesTable, {
        page: pageDto({
          sources: [
            {
              templateId: 'r',
              name: 'Royalties',
              archived: false,
              currency: 'USD',
              total: total('160', { native: [{ amount: '200', currency: 'USD' }] }),
            },
          ],
        }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('US$200.00');
  });

  it('closes with the one-off row, which opens on the payments that link to their Monthly month', () => {
    const html = render(
      createElement(SourcesTable, {
        page: pageDto({
          oneOff: {
            total: total('450'),
            kinds: [
              {
                kind: 'freelance',
                total: total('450'),
                payments: [
                  {
                    entryId: 'e1',
                    kind: 'freelance',
                    receivedOn: '2026-09-10',
                    settlement: 'external',
                    description: 'Logo',
                    net: { amount: '450', currency: 'EUR' },
                    gross: null,
                    reporting: amount('450'),
                    reportingGross: null,
                  },
                ],
              },
            ],
          },
        }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('One-off payments');
    expect(html).toContain('aria-expanded="false"');
    // Closed until asked, but there: the toggle names a body that exists, hidden.
    const controls = /aria-controls="([^"]+)"/u.exec(html)?.[1];
    expect(controls).toBeDefined();
    const body = new RegExp(`<tbody id="${String(controls)}"([^>]*)>`, 'u').exec(html)?.[1] ?? '';
    expect(body).toContain('hidden=""');
    expect(body).toContain('data-testid="income-one-off-payments"');
    // Each payment links to its own row in the month that holds it.
    expect(html).toContain('href="/monthly/2026-09#income-e1"');
    expect(presentation.paymentHref('e1', '2026-09-10')).toBe('/monthly/2026-09#income-e1');
  });
});

/* -------------------------------------------------------------------------- */
/* Missing payments                                                            */
/* -------------------------------------------------------------------------- */

describe('a missing-payment line', () => {
  const monthName = (value: string): string => `month ${value}`;

  it('sends one missing payment to its own occurrence in Monthly', () => {
    expect(presentation.missingFlagLink(flag({ occurrences: ['2026-07-15'] }), monthName)).toEqual({
      kind: 'monthly',
      href: '/monthly/2026-07#occurrence-tpl-salary-2026-07-15',
      label: 'Open month 2026-07 in Monthly',
    });
  });

  it('sends several to Bulk History, opened on the first missing month', () => {
    expect(presentation.missingFlagLink(flag(), monthName)).toEqual({
      kind: 'history',
      href: '/monthly/2026-08/history',
      label: 'Fill them in Bulk History, from month 2026-08',
    });
  });

  it('sends an archived source, which neither Monthly nor Bulk History can resolve, to its own page', () => {
    expect(presentation.missingFlagLink(flag({ archived: true, name: 'Old job', occurrences: ['2025-03-01', '2025-04-01'] }), monthName)).toEqual({
      kind: 'source',
      href: '/income/sources/tpl-salary?year=2025',
      label: 'Open Old job’s page',
    });
    const html = render(
      createElement(MissingPayments, {
        page: pageDto({ missing: [flag({ archived: true, name: 'Old job' })] }),
        formatting: FORMATTING,
      }),
    );
    expect(html).toContain('href="/income/sources/tpl-salary?year=2026"');
    expect(html).not.toContain('/monthly/');
    // The year view's line keeps its own wording; only the source page links inside it.
    expect(presentation.ARCHIVED_MISSING_HELP).toBe(
      'This source is archived, so its payments cannot be recorded or skipped. Unarchive the source, or, if it really ended, give it an end date before the missing payment.',
    );
    expect(html).toContain(presentation.ARCHIVED_MISSING_HELP);
  });

  it('is one line per source and year', () => {
    expect(presentation.missingFlagText(flag(), 2026, (date) => date.slice(5, 7))).toBe(
      'Salary: 2 payments missing in 2026 (08, 09).',
    );
    const html = render(
      createElement(MissingPayments, { page: pageDto({ missing: [flag()] }), formatting: FORMATTING }),
    );
    expect(html).toContain('Salary: 2 payments missing in 2026 (August, September).');
    expect(html).toContain('href="/monthly/2026-08/history"');
  });

  it('says so when nothing is missing, or when no month of the year has ended', () => {
    expect(render(createElement(MissingPayments, { page: pageDto(), formatting: FORMATTING }))).toContain(
      'No scheduled payment is missing from 2026’s completed months.',
    );
    expect(
      render(createElement(MissingPayments, { page: pageDto({}, { today: '2026-01-20' }), formatting: FORMATTING })),
    ).toContain('No month of 2026 has ended yet.');
  });
});

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

describe('the addresses', () => {
  it('puts the year in the address', () => {
    expect(presentation.incomeYearHref(2025)).toBe('/income?year=2025');
  });

  it('gives a source its own page, at a year when one is given', () => {
    expect(presentation.incomeSourceHref('tpl-salary')).toBe('/income/sources/tpl-salary');
    expect(presentation.incomeSourceHref('tpl-salary', 2025)).toBe('/income/sources/tpl-salary?year=2025');
  });

  it('builds an occurrence’s Monthly address in one place, for the missing line and the source page alike', () => {
    expect(presentation.occurrenceHref('tpl-salary', '2026-07-15')).toBe('/monthly/2026-07#occurrence-tpl-salary-2026-07-15');
    expect(presentation.missingFlagLink(flag({ occurrences: ['2026-07-15'] }), (month) => month)?.href).toBe(
      presentation.occurrenceHref('tpl-salary', '2026-07-15'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The chart                                                                   */
/* -------------------------------------------------------------------------- */

describe('the chart model', () => {
  const model = (months: IncomeMonthDto[]) =>
    incomeChartModel({ months, year: 2026, reportingCurrency: 'EUR', locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } });

  it('stacks a complete month, and marks the current one so far', () => {
    const { columns } = model([
      month('2026-09', '2500', { salary: amount('2000'), bonus: amount('500') }),
      month('2026-10', '0', { current: true }),
    ]);
    expect(columns[0]?.mark).toEqual({ kind: 'stack', salary: '2000', bonus: '500', other: '0', total: '2500' });
    expect(columns[0]?.caption).toBeNull();
    expect(columns[1]?.caption).toBe('So far');
  });

  it('draws a month missing a rate as the amount it is at least, or as a gap', () => {
    const { columns, summary } = model([
      month('2026-04', '2000', { total: total('2000', { net: amount('2000', 'partial') }), other: amount('0', 'unavailable') }),
      month('2026-05', '0', { total: total('0', { net: amount('0', 'unavailable') }), salary: amount('0', 'unavailable') }),
    ]);
    expect(columns.map((column) => [column.mark.kind, column.caption])).toEqual([
      ['lower_bound', 'At least'],
      ['gap', 'No rate'],
    ]);
    expect(summary).toContain('2 months are incomplete because a rate is missing.');
  });
});

/* -------------------------------------------------------------------------- */
/* The shared forms                                                            */
/* -------------------------------------------------------------------------- */

const ACCOUNTS = [{ positionId: 'pos-bbva', name: 'BBVA', currency: 'EUR' }];
const SEVEN = ['employment', 'bonus', 'freelance', 'rental', 'dividend', 'interest', 'other'];

const kindOptions = (html: string): string[] => {
  const select = /data-testid="income-kind"[^>]*>([\s\S]*?)<\/select>/u.exec(html)?.[1] ?? '';
  return [...select.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1] as string);
};

describe('Add a payment on the Income page and Add income on Monthly', () => {
  // Monthly's mount, which brings its own correction flow and review host.
  const monthly = () =>
    render(
      createElement(AddIncomeWithReview, {
        accounts: ACCOUNTS,
        currencies: ['EUR'],
        minorUnitsByCurrency: { EUR: 2 },
        bounds: ownedEntryDateBounds({ month: '2026-09', monthEndsOn: '2026-09-30', today: '2026-10-04' }),
        today: '2026-10-04',
        defaultCurrency: 'EUR',
        locale: 'en-GB',
      }),
    );
  const income = (receivedOn?: string) =>
    render(
      createElement(AddIncomeForm, {
        accounts: ACCOUNTS,
        currencies: ['EUR'],
        minorUnitsByCurrency: { EUR: 2 },
        bounds: presentation.paymentDateBounds('2026-10-04'),
        today: '2026-10-04',
        defaultCurrency: 'EUR',
        kinds: SEVEN,
        correction: flowAnswering(NOT_REQUIRED).flow,
        ...(receivedOn === undefined ? {} : { initial: { receivedOn } }),
      }),
    );

  it('offers Monthly all nine kinds, and the Income page only the seven it counts', () => {
    expect(kindOptions(monthly())).toEqual([
      'employment', 'freelance', 'bonus', 'rental', 'other', 'interest', 'dividend', 'external_inflow', 'adjustment',
    ]);
    expect(kindOptions(income())).toEqual(['employment', 'freelance', 'bonus', 'rental', 'other', 'interest', 'dividend']);
  });

  it('bounds Monthly to its own month, and the Income page to any day up to today', () => {
    expect(monthly()).toContain('min="2026-09-01"');
    expect(monthly()).toContain('max="2026-09-30"');
    expect(income()).toContain(`min="${EARLIEST_CORRECTABLE_DATE}"`);
    expect(income()).toContain('max="2026-10-04"');
    expect(dateBoundsMessage(presentation.paymentDateBounds('2026-10-04'))).toBe('Choose a day no later than 2026-10-04.');
    expect(dateBoundsMessage({ min: '2026-09-01', max: '2026-09-30' })).toBe('Choose a day from 2026-09-01 to 2026-09-30.');
  });

  it('says a payment adds to a closed month by its month on Monthly, and by the day chosen on Income', () => {
    // Monthly: the month on screen decides, exactly as before.
    expect(addsToClosedMonth({ min: '2026-09-01', max: '2026-09-30' }, '', '2026-10-04')).toBe(true);
    expect(addsToClosedMonth({ min: '2026-10-01', max: '2026-10-04' }, '2026-10-02', '2026-10-04')).toBe(false);
    expect(monthly()).toContain('data-testid="add-income-historical-note"');
    // Income: the day chosen decides.
    const bounds = presentation.paymentDateBounds('2026-10-04');
    expect(addsToClosedMonth(bounds, '2026-09-30', '2026-10-04')).toBe(true);
    expect(addsToClosedMonth(bounds, '2026-10-01', '2026-10-04')).toBe(false);
    expect(addsToClosedMonth(bounds, '', '2026-10-04')).toBe(false);
    expect(income()).not.toContain('add-income-historical-note');
    expect(income('2026-03-31')).toContain('data-testid="add-income-historical-note"');
  });

  it('shares the source form unchanged', () => {
    const html = render(
      createElement(AddIncomeSourceForm, {
        accounts: ACCOUNTS,
        currencies: ['EUR'],
        minorUnitsByCurrency: { EUR: 2 },
        defaultCurrency: 'EUR',
        today: '2026-10-04',
        locale: 'en-GB',
      }),
    );
    expect(html).toContain('data-testid="add-income-source"');
  });
});

/* -------------------------------------------------------------------------- */
/* The save path                                                               */
/* -------------------------------------------------------------------------- */

const PREVIEW = { fingerprint: 'hc-v1:test' } as unknown as CorrectionPreview;
const NOT_REQUIRED = { ok: true, data: { status: 'not_required' } } as const;
const REVIEW_REQUIRED = { ok: true, data: { status: 'review_required', preview: PREVIEW } } as const;
const GUARD = { ok: false, error: { code: 'HISTORICAL_REVIEW_REQUIRED', message: 'This has to be reviewed before it is saved. Nothing was saved.' } } as const;

/** A flow running the real protocol against a server that answers in turn. */
function flowAnswering(...answers: (typeof NOT_REQUIRED | typeof REVIEW_REQUIRED)[]) {
  const asked: CorrectionDraft[] = [];
  const opened: CorrectionDraft[] = [];
  const ports = {
    ask: (draft: CorrectionDraft) => {
      asked.push(draft);
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)] as typeof NOT_REQUIRED);
    },
    open: (draft: CorrectionDraft) => {
      opened.push(draft);
    },
    forget: () => undefined,
  };
  const flow: CorrectionFlow = {
    pending: null,
    paused: false,
    pause: () => undefined,
    resume: () => undefined,
    clear: () => undefined,
    attempt: (draft, save) => attemptCorrection(ports, draft, save),
    prepareReview: (draft) => prepareReviewWith(ports, draft),
  };
  return { flow, asked, opened };
}

const INPUT = {
  kind: 'employment',
  receivedOn: '2026-10-02',
  netAmount: '80.00',
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-savings',
} as const;

describe('Add income asks the server first, on the Income page and in Monthly alike', () => {
  it('opens the review when the server requires it, and sends no ordinary save', async () => {
    createIncomeEntryAction.mockReset();
    const { flow, asked, opened } = flowAnswering(REVIEW_REQUIRED);
    expect(await saveNewIncome(INPUT, flow)).toEqual({ kind: 'review' });
    expect(createIncomeEntryAction).not.toHaveBeenCalled();
    expect(asked).toEqual([
      {
        kind: 'income_create',
        incomeKind: 'employment',
        receivedOn: '2026-10-02',
        netAmount: '80.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: 'pos-savings',
      },
    ]);
    expect(opened).toHaveLength(1);
  });

  it('saves directly when no review is needed', async () => {
    createIncomeEntryAction.mockReset().mockResolvedValue({ ok: true, data: { id: 'e' } });
    const { flow, opened } = flowAnswering(NOT_REQUIRED);
    expect(await saveNewIncome(INPUT, flow)).toEqual({ kind: 'saved' });
    expect(createIncomeEntryAction).toHaveBeenCalledWith(INPUT);
    expect(opened).toEqual([]);
  });

  it('asks once more when the save meets the guard after a race, and opens the review', async () => {
    createIncomeEntryAction.mockReset().mockResolvedValue(GUARD);
    const { flow, asked, opened } = flowAnswering(NOT_REQUIRED, REVIEW_REQUIRED);
    expect(await saveNewIncome(INPUT, flow)).toEqual({ kind: 'review' });
    expect(asked).toHaveLength(2);
    expect(opened).toHaveLength(1);
  });

  it('shows a refusal as the server worded it', async () => {
    createIncomeEntryAction.mockReset().mockResolvedValue({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Nope.' } });
    const { flow } = flowAnswering(NOT_REQUIRED);
    expect(await saveNewIncome(INPUT, flow)).toEqual({ kind: 'error', message: 'Nope.' });
  });
});
