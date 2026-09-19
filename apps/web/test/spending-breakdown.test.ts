import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ReportingAmountDto,
  SpendingCategoriesDto,
  SpendingCategoryRowDto,
  SpendingLargestKnownDto,
  SpendingLargestRowDto,
} from '@vaultide/application';

const { Categories, LargestKnown } = await import('@/features/spending/breakdown');

/**
 * Categories and the largest known rows on the Spending page (blueprint 15.2
 * "categories; largest known"; ADR 0008 §6, §7).
 *
 * The read decides which rows exist, what they total and in which order; these
 * pin how that reads — groups that never call a cost or money out consumption,
 * unclassified shown apart from every category, no bars and no amount order
 * when a total is incomplete, and a note whenever amounts in different
 * currencies could not be compared.
 */

const PROVENANCE = { estimatedConversion: false, approximate: false, exact: true };
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2, USD: 2 } };

const amount = (
  value: string,
  availability: ReportingAmountDto['availability'] = 'available',
  missing: ReportingAmountDto['missing'] = [],
): ReportingAmountDto => ({ value: { amount: value, currency: 'EUR' }, availability, missing, provenance: PROVENANCE });

const category = (over: Partial<SpendingCategoryRowDto> & Pick<SpendingCategoryRowDto, 'name'>): SpendingCategoryRowDto => ({
  categoryId: `cat-${over.name}`,
  archived: false,
  group: 'consumption',
  trackedKnown: null,
  additional: null,
  total: amount('0'),
  ...over,
});

function categories(over: Partial<SpendingCategoriesDto> = {}): SpendingCategoriesDto {
  return {
    trackedInterval: { from: '2026-08-01', to: '2026-08-31' },
    additionalInterval: { from: '2026-08-01', to: '2026-08-31' },
    order: 'amount',
    rows: [
      category({ name: 'Groceries', trackedKnown: amount('320'), total: amount('320') }),
      category({ name: 'Eating out', trackedKnown: amount('80'), additional: amount('25'), total: amount('105') }),
      category({ name: 'Transfer fees', group: 'cost', trackedKnown: amount('4'), total: amount('4') }),
      category({ name: 'Money out of tracked accounts', group: 'money_out', trackedKnown: amount('60'), total: amount('60') }),
    ],
    knownTrackedSpending: amount('464'),
    unclassified: amount('935'),
    additionalSpending: amount('25'),
    missing: [],
    ...over,
  };
}

const render = (dto: SpendingCategoriesDto): string =>
  renderToStaticMarkup(createElement(Categories, { categories: dto, formatting }));

describe('categories', () => {
  it('groups consumption, costs and money out apart, tracked known beside additional', () => {
    const html = render(categories());
    const consumption = html.slice(html.indexOf('spending-group-consumption'), html.indexOf('spending-group-cost'));
    const costs = html.slice(html.indexOf('spending-group-cost'), html.indexOf('spending-group-money_out'));
    const moneyOut = html.slice(html.indexOf('spending-group-money_out'));
    expect(consumption).toContain('Groceries');
    expect(consumption).toContain('Eating out');
    expect(consumption).not.toContain('Transfer fees');
    expect(costs).toContain('Costs and fees');
    expect(costs).toContain('Transfer fees');
    expect(moneyOut).toContain('Money out of tracked accounts · not consumption');

    const eatingOut = html.slice(html.indexOf('data-category="Eating out"'), html.indexOf('data-category="Transfer fees"'));
    expect(eatingOut).toContain('Tracked known');
    expect(eatingOut).toContain('€80.00');
    expect(eatingOut).toContain('Additional');
    expect(eatingOut).toContain('€25.00');
    expect(eatingOut).toContain('€105.00');
  });

  it('shows unclassified apart from every category, never as one', () => {
    const html = render(categories());
    const unclassified = html.slice(html.indexOf('spending-categories-unclassified'));
    expect(unclassified).toContain('€935.00');
    expect(unclassified).toContain('not a category');
    expect(html).not.toContain('data-category="Unclassified"');
    expect(html).not.toContain('data-category="Other"');
  });

  it('draws bars only when every total is complete', () => {
    expect(render(categories())).toContain('spending-category-bar');
    const incomplete = render(
      categories({
        order: 'category',
        rows: [
          category({ name: 'Groceries', trackedKnown: amount('320'), total: amount('320') }),
          category({
            name: 'Eating out',
            trackedKnown: amount('20', 'partial', [{ currency: 'USD', reason: 'fx_missing' }]),
            total: amount('20', 'partial', [{ currency: 'USD', reason: 'fx_missing' }]),
          }),
        ],
        missing: [{ currency: 'USD', reason: 'fx_missing' }],
      }),
    );
    expect(incomplete).not.toContain('spending-category-bar');
    expect(incomplete).toContain('listed in your own order rather than by amount');
    expect(incomplete).toContain('USD (no exchange rate)');
    // The incomplete total reads as a lower bound, never as the whole.
    const eatingOut = incomplete.slice(incomplete.indexOf('data-category="Eating out"'));
    expect(eatingOut).toMatch(/≥ .*€20\.00/su);
  });

  it('says when no tracked interval exists, and still lists additional spending', () => {
    const html = render(
      categories({
        trackedInterval: null,
        knownTrackedSpending: null,
        unclassified: null,
        rows: [category({ name: 'Eating out', additional: amount('9'), total: amount('9') })],
      }),
    );
    expect(html).toContain('Tracked spending cannot be calculated for this period');
    expect(html).toContain('€9.00');
    expect(html).not.toContain('Tracked known');
    expect(html).not.toContain('spending-categories-unclassified');
  });
});

const largestRow = (over: Partial<SpendingLargestRowDto> & Pick<SpendingLargestRowDto, 'entryId'>): SpendingLargestRowDto => ({
  kind: 'consumption',
  categoryName: 'Groceries',
  description: null,
  incurredOn: '2026-08-12',
  cashAccountName: 'BBVA',
  native: { amount: '150', currency: 'EUR' },
  reporting: amount('150'),
  ...over,
});

const largest = (over: Partial<SpendingLargestKnownDto> = {}): SpendingLargestKnownDto => ({
  interval: { from: '2026-08-01', to: '2026-08-31' },
  mode: 'reporting_currency',
  perNativeCurrency: false,
  groups: [
    {
      currency: null,
      rows: [
        largestRow({ entryId: 'e1', description: 'Weekly shop' }),
        largestRow({ entryId: 'e2', kind: 'money_out', categoryName: 'Money out of tracked accounts', native: { amount: '60', currency: 'EUR' }, reporting: amount('60') }),
        largestRow({ entryId: 'e3', kind: 'cost', categoryName: 'Transfer fees', native: { amount: '4', currency: 'EUR' }, reporting: amount('4') }),
        largestRow({ entryId: 'e4', kind: 'additional', categoryName: 'Eating out', cashAccountName: null, native: { amount: '25', currency: 'EUR' }, reporting: amount('25') }),
      ],
    },
  ],
  missing: [],
  ...over,
});

describe('the largest known rows', () => {
  const renderLargest = (dto: SpendingLargestKnownDto) =>
    renderToStaticMarkup(createElement(LargestKnown, { largest: dto, formatting }));

  it('tags every row by what it is, so money out never reads as a purchase', () => {
    const html = renderLargest(largest());
    expect(html).toContain('Weekly shop');
    expect(html).toContain('>Consumption<');
    expect(html).toContain('Money out of tracked accounts · not consumption');
    expect(html).toContain('Fee / cost');
    expect(html).toContain('Additional spending');
    expect(html).not.toContain('spending-largest-note');
  });

  it('ranks each currency on its own, and says why, when a rate is missing', () => {
    const html = renderLargest(
      largest({
        mode: 'per_native_currency',
        perNativeCurrency: true,
        groups: [
          { currency: 'EUR', rows: [largestRow({ entryId: 'e1' })] },
          {
            currency: 'USD',
            rows: [
              largestRow({
                entryId: 'e9',
                native: { amount: '500', currency: 'USD' },
                reporting: amount('0', 'unavailable', [{ currency: 'USD', reason: 'fx_missing' }]),
              }),
            ],
          },
        ],
        missing: [{ currency: 'USD', reason: 'fx_missing' }],
      }),
    );
    expect(html).toContain('In EUR');
    expect(html).toContain('In USD');
    expect(html).toContain('US$500.00');
    expect(html).toContain('cannot be compared');
  });

  it('lists additional spending through today on its own when there is no tracked interval', () => {
    const html = renderLargest(
      largest({ mode: 'source_only', groups: [{ currency: null, rows: [largestRow({ entryId: 'e4', kind: 'additional' })] }] }),
    );
    expect(html).toContain('data-mode="source_only"');
    expect(html).toContain('only spending you paid from outside your tracked accounts is listed');
  });

  it('says so when nothing was recorded', () => {
    expect(renderLargest(largest({ mode: 'none', groups: [] }))).toContain('No known expense or additional spending');
  });
});
