import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate } from '../src/dates/plain-date';
import { createFxTable, type FxRateRecord, type FxTable } from '../src/fx/index';
import { INCOME_KINDS, INCOME_SETTLEMENTS, type IncomeKind, type IncomeSettlement } from '../src/flows/types';
import { money } from '../src/money/money';
import { currencyCode } from '../src/money/types';
import { missingIncomeOccurrences, occurrenceKey } from '../src/reconciliation/completeness';
import type { CompletenessTemplate } from '../src/reconciliation/types';
import { isExternalIncomeKind } from '../src/savings/classify';
import {
  INCOME_RECORDED_KINDS,
  incomeGroupOf,
  incomeItemsOf,
  incomeOverview,
  incomeTotalOf,
  isIncomeRecorded,
  missingIncomeInYear,
  type IncomeOverview,
  type IncomeOverviewInput,
  type RecordedIncomeEntry,
} from '../src/income/index';

/**
 * Income recorded (blueprint 15.2 "Income", v2.1.20 30.23; ADR 0012 D1–D3).
 *
 * The oracles are the rulings themselves — which kinds and settlements count,
 * which date places an entry, what base and bonus are, what a gross covers —
 * and, for the totals, conservation: every figure is a sum of the same
 * converted entries, so the parts of a total add back to it exactly. The
 * missing flags are compared with `missingIncomeOccurrences`, month by month,
 * rather than restated.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const SALARY = 'tpl-salary';

const rate = (quote: string, on: string, value: string): FxRateRecord => ({
  quote: currencyCode(quote),
  rateDate: plainDate(on),
  rate: new Decimal(value),
  source: 'ECB',
});

const fxOn = (today: string, rows: FxRateRecord[] = []): FxTable =>
  createFxTable(rows, { today: plainDate(today) });

let sequence = 0;
const nextId = (): string => `entry-${String((sequence += 1)).padStart(4, '0')}`;

function entry(over: Partial<Omit<RecordedIncomeEntry, 'net' | 'gross'>> & {
  readonly net?: string;
  readonly gross?: string | null;
  readonly currency?: string;
} = {}): RecordedIncomeEntry {
  const currency = over.currency ?? 'EUR';
  return {
    id: over.id ?? nextId(),
    kind: over.kind ?? 'employment',
    settlement: over.settlement ?? 'tracked_cash',
    receivedOn: over.receivedOn ?? plainDate('2026-09-25'),
    net: money(over.net ?? '100', currency),
    gross: over.gross === undefined || over.gross === null ? null : money(over.gross, currency),
    templateId: over.templateId ?? null,
  };
}

function template(over: Partial<CompletenessTemplate> & { start?: string; end?: string | null; day?: number }): CompletenessTemplate {
  return {
    templateId: over.templateId ?? SALARY,
    name: over.name ?? 'Salary',
    kind: over.kind ?? 'income',
    currency: over.currency ?? EUR,
    incomeKind: over.incomeKind ?? 'employment',
    schedule: over.schedule ?? {
      frequency: 'monthly',
      dayOfMonth: over.day ?? 25,
      startDate: plainDate(over.start ?? '2026-01-01'),
      endDate: over.end === undefined || over.end === null ? null : plainDate(over.end),
    },
  };
}

function overview(over: Partial<IncomeOverviewInput> = {}): IncomeOverview {
  const today = over.today ?? plainDate('2026-10-04');
  return incomeOverview({
    year: over.year ?? 2026,
    today,
    reportingCurrency: over.reportingCurrency ?? EUR,
    fx: over.fx ?? fxOn(today),
    entries: over.entries ?? [],
    templates: over.templates ?? [],
    resolvedOccurrences: over.resolvedOccurrences ?? new Set<string>(),
  });
}

const amountOf = (value: { value: { amount: Decimal } }): string => value.value.amount.toString();

/* -------------------------------------------------------------------------- */
/* What counts                                                                 */
/* -------------------------------------------------------------------------- */

describe('which entries are income recorded', () => {
  it('counts the seven earned kinds, settled into a tracked account or outside them', () => {
    const counted: string[] = [];
    for (const kind of INCOME_KINDS) {
      for (const settlement of INCOME_SETTLEMENTS) {
        if (isIncomeRecorded({ kind, settlement })) counted.push(`${kind}/${settlement}`);
      }
    }
    expect(counted.sort()).toEqual(
      ['employment', 'bonus', 'freelance', 'rental', 'dividend', 'interest', 'other']
        .flatMap((kind) => [`${kind}/tracked_cash`, `${kind}/external`])
        .sort(),
    );
  });

  it('never counts money in from outside or a reconciliation adjustment, however it was settled', () => {
    for (const kind of ['external_inflow', 'adjustment'] as const) {
      for (const settlement of INCOME_SETTLEMENTS) {
        expect(isIncomeRecorded({ kind, settlement })).toBe(false);
      }
    }
  });

  it('leaves reinvested income to Phase 4', () => {
    expect(isIncomeRecorded({ kind: 'dividend', settlement: 'reinvested' })).toBe(false);
  });

  it('lists the same seven kinds 12.5 counts as income', () => {
    expect([...INCOME_RECORDED_KINDS].sort()).toEqual(INCOME_KINDS.filter(isExternalIncomeKind).sort());
  });

  it('calls employment salary, bonus bonus, and every other counted kind other', () => {
    expect(INCOME_RECORDED_KINDS.map((kind) => [kind, incomeGroupOf(kind)])).toEqual([
      ['employment', 'salary'],
      ['bonus', 'bonus'],
      ['freelance', 'other'],
      ['rental', 'other'],
      ['dividend', 'other'],
      ['interest', 'other'],
      ['other', 'other'],
    ]);
  });

  it('drops what it does not count before anything is converted or summed', () => {
    const items = incomeItemsOf(
      [
        entry({ kind: 'employment', net: '100' }),
        entry({ kind: 'external_inflow', net: '900' }),
        entry({ kind: 'adjustment', net: '50' }),
        entry({ kind: 'other', settlement: 'external', net: '30' }),
      ],
      EUR,
      fxOn('2026-10-04'),
    );
    expect(items.map((item) => [item.kind, item.side])).toEqual([
      ['employment', 'tracked'],
      ['other', 'outside'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Tracked and outside                                                         */
/* -------------------------------------------------------------------------- */

describe('the year split into tracked and outside', () => {
  it('puts tracked cash on one side and external income on the other, adding back to the total', () => {
    const view = overview({
      entries: [
        entry({ net: '2000.00', receivedOn: plainDate('2026-09-25') }),
        entry({ kind: 'freelance', settlement: 'external', net: '450.00', receivedOn: plainDate('2026-09-10') }),
        entry({ kind: 'rental', settlement: 'external', net: '600.00', receivedOn: plainDate('2026-03-01') }),
      ],
    }).year;
    expect(amountOf(view.total.net)).toBe('3050');
    expect(amountOf(view.tracked.net)).toBe('2000');
    expect(amountOf(view.outside.net)).toBe('1050');
    expect(view.tracked.count + view.outside.count).toBe(view.total.count);
  });
});

/* -------------------------------------------------------------------------- */
/* Which month                                                                 */
/* -------------------------------------------------------------------------- */

describe('which month an entry belongs to', () => {
  it('places a salary scheduled for 1 October and received on 30 September in September', () => {
    const early = entry({
      templateId: SALARY,
      receivedOn: plainDate('2026-09-30'),
      net: '2100',
    });
    const view = overview({
      today: plainDate('2026-11-05'),
      entries: [early],
      templates: [template({ day: 1, start: '2026-10-01' })],
      // The October occurrence is resolved by the entry, under its scheduled date.
      resolvedOccurrences: new Set([occurrenceKey(SALARY, '2026-10-01')]),
    }).year;

    const september = view.months.find((month) => month.month === monthKeyOf(2026, 9));
    const october = view.months.find((month) => month.month === monthKeyOf(2026, 10));
    expect(september && amountOf(september.total.net)).toBe('2100');
    expect(october && amountOf(october.total.net)).toBe('0');
    // October expected it and got it, so nothing is missing.
    expect(view.missing).toEqual([]);
  });

  it('places an entry in the year of its financial date, whatever year its source belongs to', () => {
    const view = overview({
      entries: [entry({ templateId: SALARY, receivedOn: plainDate('2025-12-31'), net: '10' })],
      templates: [template({ start: '2026-01-01' })],
    });
    expect(amountOf(view.year.total.net)).toBe('0');
    expect(view.years.map((row) => row.year)).toEqual([2025]);
  });
});

/* -------------------------------------------------------------------------- */
/* Salary, bonus and other                                                     */
/* -------------------------------------------------------------------------- */

describe('a month split into salary, bonus and other', () => {
  it('sums each group from its own entries, and the groups add back to the month', () => {
    const view = overview({
      entries: [
        entry({ kind: 'employment', net: '2000', receivedOn: plainDate('2026-06-25') }),
        entry({ kind: 'bonus', net: '500', receivedOn: plainDate('2026-06-30') }),
        entry({ kind: 'interest', net: '3.10', receivedOn: plainDate('2026-06-01') }),
        entry({ kind: 'freelance', settlement: 'external', net: '300', receivedOn: plainDate('2026-06-15') }),
      ],
    }).year;
    const june = view.months[5];
    expect(june?.month).toBe(monthKeyOf(2026, 6));
    expect(june && amountOf(june.groups.salary)).toBe('2000');
    expect(june && amountOf(june.groups.bonus)).toBe('500');
    expect(june && amountOf(june.groups.other)).toBe('303.1');
    expect(june && amountOf(june.total.net)).toBe('2803.1');
  });
});

/* -------------------------------------------------------------------------- */
/* Sources and one-off payments                                                */
/* -------------------------------------------------------------------------- */

describe('the sources of a year', () => {
  it('shows a source with a payment in the year, or an occurrence scheduled in it, and no other', () => {
    const view = overview({
      entries: [
        entry({ templateId: 'tpl-paid', receivedOn: plainDate('2026-02-25') }),
      ],
      templates: [
        // Paid in the year, though its schedule starts later.
        template({ templateId: 'tpl-paid', name: 'Paid', start: '2026-03-01' }),
        // Scheduled in the year, nothing received yet.
        template({ templateId: 'tpl-scheduled', name: 'Scheduled', start: '2026-12-01' }),
        // Ended the year before.
        template({ templateId: 'tpl-ended', name: 'Ended', start: '2024-01-01', end: '2025-12-31' }),
        // Scheduled in the year, but not income.
        template({ templateId: 'tpl-rent-out', name: 'Rent paid', kind: 'expense', incomeKind: null }),
      ],
    }).year;
    expect(view.sources.map((row) => row.templateId).sort()).toEqual(['tpl-paid', 'tpl-scheduled']);
    const scheduled = view.sources.find((row) => row.templateId === 'tpl-scheduled');
    // A source with nothing received has an exact zero — no such record exists.
    expect(scheduled?.total.net.availability).toBe('available');
    expect(scheduled && amountOf(scheduled.total.net)).toBe('0');
  });

  it('keeps every entry without a source in one-off payments, by kind, whatever its flag would say', () => {
    const view = overview({
      entries: [
        entry({ kind: 'bonus', net: '300', receivedOn: plainDate('2026-07-01') }),
        entry({ kind: 'other', net: '20', receivedOn: plainDate('2026-02-01'), id: 'b' }),
        entry({ kind: 'other', net: '5', receivedOn: plainDate('2026-03-01'), id: 'c' }),
        entry({ kind: 'other', net: '25', receivedOn: plainDate('2026-02-01'), id: 'a' }),
        entry({ kind: 'employment', templateId: SALARY, net: '2000' }),
      ],
      templates: [template({})],
    }).year;
    expect(view.oneOff?.kinds.map((group) => [group.kind, amountOf(group.total.net)])).toEqual([
      ['bonus', '300'],
      ['other', '50'],
    ]);
    // By date, then id: never by the order the rows arrived in.
    expect(view.oneOff?.kinds[1]?.items.map((item) => item.entry.id)).toEqual(['a', 'b', 'c']);
    expect(view.oneOff && amountOf(view.oneOff.total.net)).toBe('350');
    expect(view.sources.map((row) => row.templateId)).toEqual([SALARY]);
  });

  it('keeps an entry naming a template the list does not hold under that template, by its id', () => {
    const view = overview({
      entries: [entry({ templateId: 'tpl-ghost', net: '1' }), entry({ templateId: SALARY, net: '1' })],
      templates: [template({ name: 'Salary' })],
    }).year;
    expect(view.sources.map((row) => row.templateId)).toEqual([SALARY, 'tpl-ghost']);
  });

  it('has no one-off row in a year without one', () => {
    expect(overview({ entries: [entry({ templateId: SALARY })], templates: [template({})] }).year.oneOff).toBeNull();
  });

  it('orders sources by their reporting net when every row is complete, largest first', () => {
    const view = overview({
      entries: [
        entry({ templateId: 'a', net: '10' }),
        entry({ templateId: 'b', net: '30' }),
        entry({ templateId: 'c', net: '30' }),
      ],
      templates: [
        template({ templateId: 'a', name: 'Alpha' }),
        template({ templateId: 'b', name: 'Zulu' }),
        template({ templateId: 'c', name: 'Bravo' }),
      ],
    }).year;
    expect(view.sourceOrder).toBe('amount');
    // Equal amounts fall back to the name.
    expect(view.sources.map((row) => row.templateId)).toEqual(['c', 'b', 'a']);
  });

  it('orders sources by name when a rate is missing anywhere, the one-off row included', () => {
    const today = plainDate('2026-10-04');
    const templates = [
      template({ templateId: 'a', name: 'alpha' }),
      template({ templateId: 'b', name: 'Bravo' }),
      template({ templateId: 'c', name: 'Bravo', currency: USD }),
    ];
    const byAmount = [
      entry({ templateId: 'a', net: '5' }),
      entry({ templateId: 'b', net: '50' }),
      entry({ templateId: 'c', net: '500', currency: 'USD' }),
    ];
    // No USD rate: the $500 cannot be ranked against €50.
    const partial = overview({ today, entries: byAmount, templates }).year;
    expect(partial.sourceOrder).toBe('name');
    expect(partial.sources.map((row) => row.templateId)).toEqual(['a', 'b', 'c']);

    // Every source complete, but a one-off in dollars has no rate either.
    const oneOff = overview({
      today,
      entries: [...byAmount.slice(0, 2), entry({ kind: 'other', net: '1', currency: 'USD' })],
      templates: templates.slice(0, 2),
    }).year;
    expect(oneOff.sourceOrder).toBe('name');
    expect(oneOff.sources.map((row) => row.templateId)).toEqual(['a', 'b']);
  });
});

/* -------------------------------------------------------------------------- */
/* Gross                                                                       */
/* -------------------------------------------------------------------------- */

describe('a gross', () => {
  it('covers only the entries that recorded one, and says how many did not', () => {
    const items = incomeItemsOf(
      [
        entry({ net: '2000', gross: '2800' }),
        entry({ net: '2000', gross: '2750.50' }),
        entry({ kind: 'interest', net: '3' }),
      ],
      EUR,
      fxOn('2026-10-04'),
    );
    const total = incomeTotalOf(items, EUR);
    expect(total.gross.recorded && amountOf(total.gross.recorded)).toBe('5550.5');
    expect(total.gross.withoutGross).toBe(1);
  });

  it('is absent, never zero, when no entry has one', () => {
    const total = incomeTotalOf(incomeItemsOf([entry({}), entry({})], EUR, fxOn('2026-10-04')), EUR);
    expect(total.gross.recorded).toBeNull();
    expect(total.gross.withoutGross).toBe(2);
  });

  it('keeps a recorded gross of zero, which is a stated fact', () => {
    const total = incomeTotalOf(incomeItemsOf([entry({ gross: '0' })], EUR, fxOn('2026-10-04')), EUR);
    expect(total.gross.recorded?.availability).toBe('available');
    expect(total.gross.withoutGross).toBe(0);
  });

  it('converts on the entry’s own date, and is partial with the net when the rate is missing', () => {
    const today = '2026-10-04';
    const items = incomeItemsOf(
      [entry({ net: '100', gross: '150', currency: 'USD', receivedOn: plainDate('2026-09-10') })],
      EUR,
      fxOn(today, [rate('USD', '2026-09-10', '2')]),
    );
    expect(items[0] && amountOf(items[0].net)).toBe('50');
    expect(items[0]?.gross && amountOf(items[0].gross)).toBe('75');

    const missing = incomeItemsOf(
      [entry({ net: '100', gross: '150', currency: 'USD', receivedOn: plainDate('2026-09-10') })],
      EUR,
      fxOn(today),
    );
    expect(missing[0]?.net.availability).toBe('unavailable');
    expect(missing[0]?.gross?.availability).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/* Missing rates                                                               */
/* -------------------------------------------------------------------------- */

describe('a missing rate', () => {
  it('makes the month, the year and the last twelve months partial, and names the currency', () => {
    const view = overview({
      today: plainDate('2026-10-04'),
      entries: [
        entry({ net: '2000', receivedOn: plainDate('2026-09-25') }),
        entry({ kind: 'dividend', net: '40', currency: 'USD', receivedOn: plainDate('2026-09-15') }),
      ],
      fx: fxOn('2026-10-04', [rate('USD', '2026-08-01', '1.1')]),
    });
    const september = view.year.months[8];
    for (const figure of [september?.total.net, view.year.total.net, view.lastTwelveMonths.total.net]) {
      expect(figure?.availability).toBe('partial');
      expect(figure && amountOf(figure)).toBe('2000');
      expect(figure?.missing).toEqual([expect.objectContaining({ currency: 'USD', reason: 'fx_missing' })]);
    }
    // Native figures stay native, and stay exact.
    expect(view.year.total.native.map((item) => [item.currency, item.amount.toString()])).toEqual([
      ['EUR', '2000'],
      ['USD', '40'],
    ]);
    // A group without the dividend is complete; the one with it is not stated at all.
    expect(september?.groups.salary.availability).toBe('available');
    expect(september?.groups.other.availability).toBe('unavailable');
    expect(view.years[0]?.total.net.availability).toBe('partial');
  });

  it('finds a rate up to ten days back from the entry’s date, as every dated flow does', () => {
    const view = overview({
      entries: [entry({ net: '30', currency: 'USD', receivedOn: plainDate('2026-09-13') })],
      fx: fxOn('2026-10-04', [rate('USD', '2026-09-04', '1.5')]),
    });
    expect(view.year.total.net.availability).toBe('available');
    expect(amountOf(view.year.total.net)).toBe('20');
  });
});

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

describe('the periods', () => {
  it('runs the last twelve months to the current month, across a year boundary', () => {
    const view = overview({
      year: 2025,
      today: plainDate('2027-02-10'),
      entries: [
        entry({ net: '1', receivedOn: plainDate('2026-02-28') }),
        entry({ net: '10', receivedOn: plainDate('2026-03-01') }),
        entry({ net: '100', receivedOn: plainDate('2026-12-31') }),
        entry({ net: '1000', receivedOn: plainDate('2027-02-10') }),
      ],
    });
    expect(view.lastTwelveMonths.from).toBe(monthKeyOf(2026, 3));
    expect(view.lastTwelveMonths.to).toBe(monthKeyOf(2027, 2));
    expect(amountOf(view.lastTwelveMonths.total.net)).toBe('1110');
    // The same window whichever year is shown.
    expect(view.year.year).toBe(2025);
  });

  it('marks the current year and month so far, and shows only the months that have begun', () => {
    const view = overview({ today: plainDate('2026-10-04'), entries: [entry({ receivedOn: plainDate('2026-10-01') })] });
    expect(view.year.current).toBe(true);
    expect(view.year.months).toHaveLength(10);
    expect(view.year.months.filter((month) => month.current).map((month) => month.month)).toEqual([
      monthKeyOf(2026, 10),
    ]);
    expect(view.years[0]).toMatchObject({ year: 2026, current: true });
  });

  it('shows all twelve months of a past year, none of them so far', () => {
    const view = overview({ year: 2025, today: plainDate('2026-10-04') }).year;
    expect(view.current).toBe(false);
    expect(view.months).toHaveLength(12);
    expect(view.months.some((month) => month.current)).toBe(false);
  });

  it('counts nothing dated after today, so no total holds what no month shows', () => {
    // The property below found it: a 1 December entry read on 30 November.
    const view = overview({
      today: plainDate('2026-11-30'),
      entries: [entry({ net: '0.01', receivedOn: plainDate('2026-12-01') })],
    });
    expect(amountOf(view.year.total.net)).toBe('0');
    expect(view.year.months.every((month) => month.total.count === 0)).toBe(true);
    expect(view.years).toEqual([]);
    expect(view.lastTwelveMonths.total.count).toBe(0);
  });

  it('has no month for a year that has not begun', () => {
    expect(overview({ year: 2027, today: plainDate('2026-10-04') }).year.months).toEqual([]);
  });

  it('lists every year with income, newest first, and no year without', () => {
    const view = overview({
      entries: [
        entry({ receivedOn: plainDate('2019-05-01'), net: '1' }),
        entry({ receivedOn: plainDate('2024-05-01'), net: '2' }),
        entry({ receivedOn: plainDate('2024-06-01'), net: '3' }),
        entry({ kind: 'adjustment', receivedOn: plainDate('2021-01-01'), net: '9' }),
      ],
    });
    expect(view.years.map((row) => [row.year, amountOf(row.total.net), row.current])).toEqual([
      [2024, '5', false],
      [2019, '1', false],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing occurrences                                                         */
/* -------------------------------------------------------------------------- */

describe('missing occurrences', () => {
  const salary = template({ start: '2026-01-01' });
  const rent = template({ templateId: 'tpl-rent', name: 'Flat', incomeKind: 'rental', day: 1, start: '2026-07-01' });

  it('is exactly missingIncomeOccurrences, month by month, over the completed months only', () => {
    const today = plainDate('2026-10-04');
    const resolved = new Set([
      occurrenceKey(SALARY, '2026-01-25'),
      occurrenceKey(SALARY, '2026-02-25'),
      occurrenceKey('tpl-rent', '2026-08-01'),
    ]);
    const flags = missingIncomeInYear([salary, rent], resolved, 2026, today);

    const expected = new Map<string, string[]>();
    for (let month = 1; month <= 9; month += 1) {
      for (const missing of missingIncomeOccurrences([salary, rent], resolved, monthKeyOf(2026, month))) {
        expected.set(missing.templateId, [...(expected.get(missing.templateId) ?? []), missing.occurrenceDate]);
      }
    }
    expect(new Map(flags.map((flag) => [flag.templateId, [...flag.occurrences]]))).toEqual(expected);
    // Nothing from October, the current month, though its salary is due on the 25th of it.
    expect(flags.flatMap((flag) => flag.occurrences).every((date) => date < '2026-10-01')).toBe(true);
    // One line per source, by name.
    expect(flags.map((flag) => flag.templateName)).toEqual(['Flat', 'Salary']);
    expect(flags.find((flag) => flag.templateName === 'Flat')?.occurrences).toEqual(['2026-07-01', '2026-09-01']);
  });

  it('flags nothing in a year that has not ended a month yet', () => {
    expect(missingIncomeInYear([salary], new Set(), 2027, plainDate('2027-01-20'))).toEqual([]);
  });

  it('counts a past year in full', () => {
    const flags = missingIncomeInYear([template({ start: '2025-01-01' })], new Set(), 2025, plainDate('2026-10-04'));
    expect(flags[0]?.occurrences).toHaveLength(12);
  });

  it('reaches the year view, which names the same occurrences', () => {
    const view = overview({ templates: [salary], today: plainDate('2026-04-02') });
    expect(view.year.missing.map((flag) => flag.occurrences)).toEqual([
      ['2026-01-25', '2026-02-25', '2026-03-25'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Conservation                                                                */
/* -------------------------------------------------------------------------- */

describe('every figure is one sum of the same entries', () => {
  const kinds = fc.constantFrom<IncomeKind>(...INCOME_KINDS);
  const settlements = fc.constantFrom<IncomeSettlement>('tracked_cash', 'external');
  const day = fc.integer({ min: 0, max: 700 }).map((offset) => {
    const date = new Date(Date.UTC(2025, 0, 1 + offset));
    return plainDate(date.toISOString().slice(0, 10));
  });
  const cents = fc.integer({ min: 0, max: 1_000_000 }).map((value) => (value / 100).toFixed(2));
  const entries = fc.array(
    fc.record({
      kind: kinds,
      settlement: settlements,
      receivedOn: day,
      net: cents,
      templateId: fc.constantFrom<string | null>(null, SALARY, 'tpl-other'),
    }),
    { maxLength: 40 },
  );

  it('adds months, sides, groups, sources and years back to their totals, exactly', () => {
    fc.assert(
      fc.property(entries, fc.constantFrom(2025, 2026), (rows, year) => {
        const today = plainDate('2026-11-30');
        const view = overview({
          year,
          today,
          entries: rows.map((row) => entry(row)),
          templates: [template({}), template({ templateId: 'tpl-other', name: 'Other' })],
        });
        const total = view.year.total.net.value.amount;
        const sum = (values: readonly Decimal[]): Decimal => values.reduce((a, b) => a.plus(b), new Decimal(0));

        expect(sum(view.year.months.map((month) => month.total.net.value.amount)).equals(total)).toBe(true);
        expect(view.year.tracked.net.value.amount.plus(view.year.outside.net.value.amount).equals(total)).toBe(true);
        for (const month of view.year.months) {
          const groups = sum(Object.values(month.groups).map((group) => group.value.amount));
          expect(groups.equals(month.total.net.value.amount)).toBe(true);
        }
        const rowsTotal = sum([
          ...view.year.sources.map((row) => row.total.net.value.amount),
          view.year.oneOff?.total.net.value.amount ?? new Decimal(0),
        ]);
        expect(rowsTotal.equals(total)).toBe(true);
        // Every counted entry up to today, once; a later one in no figure at all.
        const counted = rows.filter((row) => isIncomeRecorded(row) && row.receivedOn <= today);
        expect(sum(view.years.map((row) => row.total.net.value.amount)).equals(
          sum(counted.map((row) => new Decimal(row.net))),
        )).toBe(true);
        // Euros only: nothing is ever missing.
        expect(view.year.total.net.availability).toBe('available');
      }),
    );
  });

  it('keeps native sums exact per currency', () => {
    const items = incomeItemsOf(
      [entry({ net: '0.1' }), entry({ net: '0.2' }), entry({ net: '7', currency: 'USD' })],
      EUR,
      fxOn('2026-10-04'),
    );
    const native = incomeTotalOf(items, EUR).native;
    expect(native.map((item) => [item.currency, item.amount.toString()])).toEqual([
      ['EUR', '0.3'],
      ['USD', '7'],
    ]);
  });
});

