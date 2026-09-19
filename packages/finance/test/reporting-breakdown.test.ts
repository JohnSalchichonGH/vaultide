import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey } from '../src/dates/plain-date';
import { createFxTable, type FxRateRecord, type FxTable } from '../src/fx/index';
import { currencyCode, type CurrencyCode } from '../src/money/index';
import { monthEnd, position, valuation } from './helpers/records';
import { CATEGORY_KINDS, type ExpenseFlow, type IncomeFlow } from '../src/flows/types';
import {
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type CashAccountInput,
  type CompletedMonthInput,
} from '../src/reconciliation/index';
import {
  bucketContributions,
  isTrackedKnown,
  knownSpendingItems,
  rankKnownSpending,
  reportCashFlow,
  sumKnownSpending,
  trackedKindOfCategory,
  untrackedContributions,
  type KnownSpendingItem,
  type ReportingCashFlow,
} from '../src/reporting/index';

/**
 * The rows behind known spending, and the order of the largest ones (blueprint
 * 15.2 "categories; largest known", 8.1, 12.5, v2.1.13 30.16 item 1).
 *
 * Each fixture drives the real reconciliation engine and then asks two things of
 * the same reconciled month: the reporting figures, as the reporting month builds
 * them, and the breakdown rows. The oracle is the reporting engine itself — the
 * rows must add back to the figures it states — never a second restatement of
 * which expense belongs where.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const SEPTEMBER: MonthKey = monthKeyOf(2026, 9);
const FROM = plainDate('2026-09-01');
const TO = plainDate('2026-09-30');
const A = 'account-a';
const B = 'account-b';
const D = 'account-d';

const rate = (quote: string, on: string, value: string): FxRateRecord => ({
  quote: currencyCode(quote),
  rateDate: plainDate(on),
  rate: new Decimal(value),
  source: 'ECB',
});

/** USD at 2.0 all September, so $500 is €250 — a face value the ranking must not use. */
const USD_RATES: FxRateRecord[] = ['01', '08', '15', '22', '29'].map((day) =>
  rate('USD', `2026-09-${day}`, '2.0'),
);
const fxWith = (rows: FxRateRecord[]): FxTable => createFxTable(rows, { today: plainDate('2026-10-01') });
const emptyFx = fxWith([]);

function account(
  id: string,
  name: string,
  valuations: CashAccountInput['valuations'],
  currency = 'EUR',
): CashAccountInput {
  return { position: position(name, { id, currency }), valuations, accountType: 'checking' };
}

let sequence = 0;
const nextId = (): string => `row-${String((sequence += 1)).padStart(4, '0')}`;

const income = (over: Partial<IncomeFlow> = {}): IncomeFlow => ({
  id: nextId(),
  kind: 'employment',
  receivedOn: plainDate('2026-09-25'),
  netAmount: new Decimal('100'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: A,
  ...over,
});

const expense = (over: Partial<ExpenseFlow> = {}): ExpenseFlow => ({
  id: nextId(),
  categoryKind: 'food',
  incurredOn: plainDate('2026-09-12'),
  amount: new Decimal('100'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: A,
  ...over,
});

const completed = (over: Partial<CompletedMonthInput> = {}): CompletedMonthInput => ({
  month: SEPTEMBER,
  today: plainDate('2026-10-01'),
  cashAccounts: [],
  income: [],
  expenses: [],
  transfers: [],
  templates: [],
  resolvedOccurrences: new Set<string>(),
  ...over,
});

/** The reporting month, as the application builds it from the same reconciliation. */
function report(input: CompletedMonthInput, fx: FxTable): ReportingCashFlow {
  const result = reconcileCompletedMonth(input);
  const contributions = [];
  const missing = [];
  const bucketCurrencies = new Set<string>();
  for (const bucket of result.buckets) {
    bucketCurrencies.add(bucket.currency);
    const built = bucketContributions({
      records: input,
      expenses: input.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month: SEPTEMBER,
      from: FROM,
      to: TO,
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
      ...(bucket.status === 'unresolved' || bucket.status === 'unavailable'
        ? { residualReason: 'not_applicable' as const, residualDetail: bucket.status }
        : {}),
    });
    contributions.push(...built.contributions);
    missing.push(...built.missing);
  }
  for (const code of new Set(input.expenses.map((row) => row.currency))) {
    if (bucketCurrencies.has(code)) continue;
    contributions.push(...untrackedContributions(input.expenses, code, FROM, TO));
  }
  return reportCashFlow({ reportingCurrency: EUR, fx, contributions, missing, countAdditionalSpending: true });
}

function items(input: CompletedMonthInput, fx: FxTable = emptyFx): KnownSpendingItem[] {
  const result = reconcileCompletedMonth(input);
  return knownSpendingItems({
    records: input,
    buckets: result.buckets,
    from: FROM,
    to: TO,
    reportingCurrency: EUR,
    fx,
  });
}

const value = (a: { value: { amount: Decimal } }): string => a.value.amount.toString();

/* -------------------------------------------------------------------------- */

describe('the rows of a reconciled month', () => {
  const month = () =>
    completed({
      cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '1200')])],
      income: [income({ netAmount: new Decimal('900') })],
      expenses: [
        expense({ categoryKind: 'food', amount: new Decimal('200') }),
        expense({ categoryKind: 'transfer_fee', amount: new Decimal('10') }),
        expense({ categoryKind: 'acquisition_cost', amount: new Decimal('15') }),
        expense({ categoryKind: 'external_outflow', amount: new Decimal('40') }),
        expense({ categoryKind: 'capital_improvement', amount: new Decimal('60') }),
        expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('30') }),
        expense({ settlement: 'third_party', cashPositionId: null, amount: new Decimal('70') }),
      ],
    });

  it('names every known expense by what it is, and leaves paid-by-others and capital out', () => {
    const rows = items(month());
    expect(rows.map((row) => [row.kind, value({ value: row.native })])).toEqual([
      ['consumption', '200'],
      ['cost', '10'],
      ['cost', '15'],
      ['money_out', '40'],
      ['additional', '30'],
    ]);
    // The capital improvement is `Nout` (7.4) and the partner's dinner a memo.
    expect(rows.some((row) => row.native.amount.equals(60))).toBe(false);
    expect(rows.some((row) => row.native.amount.equals(70))).toBe(false);
  });

  it('adds back to the reporting figures it explains, exactly', () => {
    const input = month();
    const rows = items(input);
    const figures = report(input, emptyFx);

    const tracked = sumKnownSpending(rows.filter(isTrackedKnown), EUR);
    expect(value(tracked)).toBe(value(figures.knownTrackedSpending));
    expect(tracked.availability).toBe('available');
    expect(value(sumKnownSpending(rows.filter((row) => row.kind === 'additional'), EUR))).toBe(
      value(figures.additionalSpending),
    );
    // And known tracked plus the residual is tracked spending.
    expect(
      tracked.value.amount.plus(figures.unclassified.value.amount).equals(figures.trackedTotalSpending.value.amount),
    ).toBe(true);
  });

  it('keeps an account excluded as first_balance out, exactly as the identity does', () => {
    // Savings has no August balance: it is first tracked in September, so its
    // own €500 expense is outside the month's scope.
    const input = completed({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '800')]),
        account(B, 'Savings', [monthEnd(B, '2026-09-30', '4000')]),
      ],
      expenses: [
        expense({ amount: new Decimal('150') }),
        expense({ amount: new Decimal('500'), cashPositionId: B }),
      ],
    });
    expect(reconcileCompletedMonth(input).monthStatus).toBe('estimated');

    const rows = items(input);
    expect(rows.map((row) => value({ value: row.native }))).toEqual(['150']);
    expect(value(sumKnownSpending(rows, EUR))).toBe(value(report(input, emptyFx).knownTrackedSpending));
  });

  it('has no tracked row when no bucket exists, and still the additional ones', () => {
    // No cash account: no bucket, no tracked scope (30.20). The self-paid row is real.
    const input = completed({
      expenses: [expense({ settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('25') })],
    });
    expect(reconcileCompletedMonth(input).buckets).toEqual([]);
    expect(items(input).map((row) => row.kind)).toEqual(['additional']);
  });

  it('converts each row at its own date, and marks one it cannot convert', () => {
    const input = completed({
      cashAccounts: [
        account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '800')]),
        account(D, 'Dollars', [monthEnd(D, '2026-08-31', '1000'), monthEnd(D, '2026-09-30', '400')], 'USD'),
      ],
      expenses: [
        expense({ amount: new Decimal('100') }),
        expense({ amount: new Decimal('500'), currency: USD, cashPositionId: D }),
      ],
    });

    const converted = items(input, fxWith(USD_RATES));
    expect(converted.map((row) => value(row.reporting))).toEqual(['100', '250']);

    const missing = items(input, emptyFx);
    expect(missing.map((row) => row.reporting.availability)).toEqual(['available', 'unavailable']);
    expect(sumKnownSpending(missing, EUR).availability).toBe('partial');
  });
});

describe('a month to date', () => {
  it('stops every row at D, additional ones included', () => {
    const input = {
      today: plainDate('2026-09-10'),
      cashAccounts: [
        account(A, 'BBVA', [
          monthEnd(A, '2026-08-31', '1000'),
          valuation(A, '2026-09-06', '900'),
        ]),
      ],
      income: [],
      expenses: [
        expense({ incurredOn: plainDate('2026-09-05'), amount: new Decimal('40') }),
        expense({ incurredOn: plainDate('2026-09-08'), amount: new Decimal('30') }),
        expense({ incurredOn: plainDate('2026-09-05'), settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('7') }),
        expense({ incurredOn: plainDate('2026-09-09'), settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('9') }),
      ],
      transfers: [],
    };
    const result = reconcileMonthToDate(input);
    if (result.asOf === null) throw new Error('expected a common date');
    expect(result.asOf).toBe(plainDate('2026-09-06'));

    const rows = knownSpendingItems({
      records: input,
      buckets: result.buckets,
      from: FROM,
      to: result.asOf,
      reportingCurrency: EUR,
      fx: emptyFx,
    });
    expect(rows.map((row) => [row.kind, value({ value: row.native })])).toEqual([
      ['consumption', '40'],
      ['additional', '7'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Largest known                                                               */
/* -------------------------------------------------------------------------- */

const row = (
  id: string,
  amount: string,
  currency: CurrencyCode,
  on: string,
  converted: string | null,
  kind: KnownSpendingItem['kind'] = 'consumption',
): KnownSpendingItem => ({
  sourceId: id,
  kind,
  field: kind === 'additional' ? 'additionalSpending' : 'knownConsumption',
  native: { amount: new Decimal(amount), currency },
  on: plainDate(on),
  reporting:
    converted === null
      ? {
          value: { amount: new Decimal(0), currency: EUR },
          availability: 'unavailable',
          missing: [{ currency, reason: 'fx_missing' }],
          statedCount: 0,
          provenance: { estimatedConversion: false, approximate: false, exact: true },
        }
      : {
          value: { amount: new Decimal(converted), currency: EUR },
          availability: 'available',
          missing: [],
          statedCount: 1,
          provenance: { estimatedConversion: false, approximate: false, exact: true },
        },
});

describe('the largest known rows', () => {
  it('ranks by reporting value when every row converted, never by face value', () => {
    const ranking = rankKnownSpending(
      [
        row('r1', '500', USD, '2026-09-10', '250'),
        row('r2', '480', EUR, '2026-09-11', '480'),
        row('r3', '30', EUR, '2026-09-12', '30', 'additional'),
      ],
      5,
    );
    expect(ranking.mode).toBe('reporting_currency');
    expect(ranking.groups).toHaveLength(1);
    expect(ranking.groups[0]?.currency).toBeNull();
    expect(ranking.groups[0]?.items.map((item) => item.sourceId)).toEqual(['r2', 'r1', 'r3']);
  });

  it('ranks each native currency on its own when any row could not be converted', () => {
    const ranking = rankKnownSpending(
      [
        row('r1', '500', USD, '2026-09-10', null),
        row('r2', '480', EUR, '2026-09-11', '480'),
        row('r3', '90', USD, '2026-09-12', null),
        row('r4', '600', EUR, '2026-09-13', '600'),
      ],
      5,
    );
    expect(ranking.mode).toBe('per_native_currency');
    expect(ranking.groups.map((group) => [group.currency, group.items.map((item) => item.sourceId)])).toEqual([
      [EUR, ['r4', 'r2']],
      [USD, ['r1', 'r3']],
    ]);
  });

  it('keeps the top rows only, per group', () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      row(`r${String(index)}`, String(10 + index), EUR, '2026-09-10', String(10 + index)),
    );
    const ranking = rankKnownSpending(rows, 5);
    expect(ranking.groups[0]?.items.map((item) => item.sourceId)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3']);
  });

  it('breaks a tie by the later date and then the id, whatever order the rows arrive in', () => {
    const rows = [
      row('b', '50', EUR, '2026-09-10', '50'),
      row('a', '50', EUR, '2026-09-10', '50'),
      row('c', '50', EUR, '2026-09-20', '50'),
    ];
    const expected = ['c', 'a', 'b'];
    fc.assert(
      fc.property(fc.shuffledSubarray(rows, { minLength: 3, maxLength: 3 }), (shuffled) => {
        const ranked = rankKnownSpending(shuffled, 5).groups[0]?.items.map((item) => item.sourceId);
        expect(ranked).toEqual(expected);
      }),
    );
  });

  it('has nothing to rank when there is nothing', () => {
    expect(rankKnownSpending([], 5)).toEqual({ mode: 'reporting_currency', groups: [{ currency: null, items: [] }] });
  });
});

/* -------------------------------------------------------------------------- */
/* The identity, over random months                                            */
/* -------------------------------------------------------------------------- */

describe('the rows add back to the figures for any month', () => {
  const kindArb = fc.constantFrom<ExpenseFlow['categoryKind']>(
    'food',
    'transport',
    'transfer_fee',
    'investment_fee',
    'acquisition_cost',
    'external_outflow',
    'capital_improvement',
  );
  const settlementArb = fc.constantFrom<ExpenseFlow['settlement']>('tracked_cash', 'untracked_self', 'third_party');
  const expenseArb = fc.record({
    kind: kindArb,
    settlement: settlementArb,
    cents: fc.integer({ min: 1, max: 500_000 }),
    day: fc.integer({ min: 1, max: 30 }),
    onSavings: fc.boolean(),
  });

  it('sums the tracked rows to known tracked spending and the rest to additional spending', () => {
    fc.assert(
      fc.property(
        fc.array(expenseArb, { maxLength: 12 }),
        fc.boolean(),
        (specs, savingsFirstTracked) => {
          const input = completed({
            cashAccounts: [
              account(A, 'BBVA', [monthEnd(A, '2026-08-31', '5000'), monthEnd(A, '2026-09-30', '4000')]),
              account(
                B,
                'Savings',
                savingsFirstTracked
                  ? [monthEnd(B, '2026-09-30', '100')]
                  : [monthEnd(B, '2026-08-31', '100'), monthEnd(B, '2026-09-30', '100')],
              ),
            ],
            expenses: specs.map((spec) =>
              expense({
                categoryKind: spec.kind,
                settlement: spec.settlement,
                cashPositionId: spec.settlement === 'tracked_cash' ? (spec.onSavings ? B : A) : null,
                amount: new Decimal(spec.cents).dividedBy(100),
                incurredOn: plainDate(`2026-09-${String(spec.day).padStart(2, '0')}`),
              }),
            ),
          });
          const rows = items(input);
          const figures = report(input, emptyFx);

          expect(value(sumKnownSpending(rows.filter(isTrackedKnown), EUR))).toBe(value(figures.knownTrackedSpending));
          expect(value(sumKnownSpending(rows.filter((r) => r.kind === 'additional'), EUR))).toBe(
            value(figures.additionalSpending),
          );
          if (figures.unclassified.availability === 'available') {
            expect(
              figures.knownTrackedSpending.value.amount
                .plus(figures.unclassified.value.amount)
                .equals(figures.trackedTotalSpending.value.amount),
            ).toBe(true);
          }
        },
      ),
    );
  });
});

describe('a category keeps the group its tracked rows are in', () => {
  it('names every kind the way the breakdown classifies a tracked expense filed under it', () => {
    for (const kind of CATEGORY_KINDS) {
      // A capital improvement is `Nout` (7.4): it never becomes a known row, so it
      // has no tracked row to agree with.
      if (kind === 'capital_improvement') continue;
      const input = completed({
        cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-08-31', '1000'), monthEnd(A, '2026-09-30', '800')])],
        expenses: [expense({ categoryKind: kind, amount: new Decimal('10') })],
      });
      const [only] = items(input);
      expect(only?.kind).toBe(trackedKindOfCategory(kind));
    }
  });
});

