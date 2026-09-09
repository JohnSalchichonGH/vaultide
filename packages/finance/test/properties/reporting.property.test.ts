import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { monthKeyOf, plainDate } from '../../src/dates/plain-date';
import { createFxTable, type FxRateRecord } from '../../src/fx/index';
import { currencyCode, money } from '../../src/money/index';
import { isUnavailable } from '../../src/unavailable';
import {
  reportCashFlow,
  residualContribution,
  untrackedContribution,
  type ReportingContribution,
} from '../../src/reporting/index';

/**
 * Invariants of reporting-currency cash flow (12.5, 8.11, v2.1.13 30.16).
 *
 * The statements that must hold for any amounts and any rates: an identity
 * conversion changes nothing, the cost partition survives conversion, the
 * setting moves only what it is in, a memo moves nothing, and a rate exists
 * exactly when both its aggregates do.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const SEPTEMBER = monthKeyOf(2026, 9);
const TODAY = plainDate('2026-10-05');
const DAYS = ['2026-09-01', '2026-09-10', '2026-09-15', '2026-09-20', '2026-09-30'] as const;

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => new Decimal(`${String(whole)}.${String(fraction).padStart(8, '0')}`));

/** Rates far apart on purpose, so no two conventions can agree by luck. */
const rateArb = fc
  .integer({ min: 1, max: 40 })
  .map((n) => new Decimal(n).dividedBy(4));

const ratesArb = fc
  .array(rateArb, { minLength: DAYS.length, maxLength: DAYS.length })
  .map((values): FxRateRecord[] =>
    DAYS.map((day, index) => ({
      quote: USD,
      rateDate: plainDate(day),
      rate: values[index] ?? new Decimal(1),
      source: 'ECB',
    })),
  );

/**
 * Rates whose reciprocal terminates in base 10.
 *
 * A USD amount reaches EUR by `amount × (1 / rate)` (10.1: stored rows are
 * `EUR -> quote`), so the conversion is exact only when `1 / rate` is a finite
 * decimal — which it is exactly when the rate is of the form 2^a · 5^b · 10^k.
 * Each of these divides into 1 exactly: 5, 4, 2.5, 2, 1.25, 1, 0.8, 0.625, 0.5,
 * 0.4, 0.25, 0.2, 0.125, 0.1.
 */
const TERMINATING_RATES = [
  '0.2', '0.25', '0.4', '0.5', '0.8', '1', '1.25', '1.6', '2', '2.5', '4', '5', '8', '10',
] as const;

/**
 * One terminating rate held constant across the month.
 *
 * Constant so the monthly average is that same rate exactly — the mean of five
 * equal terminating values is one division that also terminates — which puts the
 * residual on the same exact footing as the dated rows. That makes every figure
 * a finite decimal of at most twenty or so significant digits, well inside the
 * forty the engine works at, so an algebraic identity between two of them holds
 * with no tolerance at all.
 */
const constantRatesArb = fc
  .constantFrom(...TERMINATING_RATES)
  .map((value): FxRateRecord[] =>
    DAYS.map((day) => ({
      quote: USD,
      rateDate: plainDate(day),
      rate: new Decimal(value),
      source: 'ECB',
    })),
  );

const dayArb = fc.constantFrom(...DAYS);

const costFields = [
  'knownConsumption',
  'propertyOperatingCosts',
  'interestAndFees',
  'transactionCosts',
  'externalOutflows',
] as const;

const contributionArb = fc
  .tuple(
    fc.constantFrom('externalIncome' as const, ...costFields),
    amountArb,
    dayArb,
    fc.boolean(),
  )
  .map(([field, amount, on, foreign]): ReportingContribution => ({
    field,
    amount: money(amount, foreign ? USD : EUR),
    basis: { kind: 'dated', on: plainDate(on) },
  }));

const inputArb = fc.record({
  contributions: fc.array(contributionArb, { maxLength: 8 }),
  residual: fc.option(fc.tuple(amountArb, fc.boolean()), { nil: undefined }),
  additional: amountArb,
  thirdParty: amountArb,
  rates: ratesArb,
  counted: fc.boolean(),
});

/** The same generator, on rates every conversion can represent exactly. */
const exactInputArb = fc.record({
  contributions: fc.array(contributionArb, { maxLength: 8 }),
  residual: fc.option(fc.tuple(amountArb, fc.boolean()), { nil: undefined }),
  additional: amountArb,
  thirdParty: amountArb,
  rates: constantRatesArb,
  counted: fc.boolean(),
});

type Generated = ReturnType<typeof inputArb.generate> extends never ? never : {
  contributions: ReportingContribution[];
  residual?: [Decimal, boolean] | undefined;
  additional: Decimal;
  thirdParty: Decimal;
  rates: FxRateRecord[];
  counted: boolean;
};

function run(generated: Generated, over: Partial<{ counted: boolean; foreignMemo: boolean }> = {}) {
  const contributions: ReportingContribution[] = [...generated.contributions];
  if (generated.residual !== undefined) {
    const [amount, foreign] = generated.residual;
    contributions.push(
      residualContribution(amount, foreign ? USD : EUR, SEPTEMBER, 'reliable'),
    );
  }
  contributions.push(
    untrackedContribution('additionalSpending', generated.additional, EUR, plainDate('2026-09-20'), 'a'),
  );
  contributions.push(
    untrackedContribution(
      'thirdPartyPaid',
      generated.thirdParty,
      over.foreignMemo === true ? USD : EUR,
      plainDate('2026-09-20'),
      't',
    ),
  );

  return reportCashFlow({
    reportingCurrency: EUR,
    fx: createFxTable(generated.rates, { today: TODAY }),
    contributions,
    missing: [],
    countAdditionalSpending: over.counted ?? generated.counted,
  });
}

describe('property: an identity conversion changes nothing', () => {
  it('reports native EUR amounts exactly, with no rate at all', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        // Every contribution in the reporting currency, and an empty rate table.
        const eurOnly: Generated = {
          ...generated,
          contributions: generated.contributions.map((c) => ({
            ...c,
            amount: money(c.amount.amount, EUR),
          })),
          residual:
            generated.residual === undefined
              ? undefined
              : [generated.residual[0], false],
          rates: [],
        };
        const result = run(eurOnly);

        const expected = eurOnly.contributions
          .filter((c) => c.field === 'externalIncome')
          .reduce((total, c) => total.plus(c.amount.amount), new Decimal(0));
        expect(result.externalIncome.value.amount.equals(expected)).toBe(true);
        expect(result.externalIncome.availability).toBe('available');
        expect(result.unclassified.provenance.estimatedConversion).toBe(false);
      }),
    );
  });
});

describe('property: the cost partition survives conversion', () => {
  it('sums the five spending buckets to tracked total spending, exactly', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        const result = run(generated);
        const parts = result.consumption.value.amount
          .plus(result.propertyOperatingCosts.value.amount)
          .plus(result.interestAndFees.value.amount)
          .plus(result.transactionCosts.value.amount)
          .plus(result.externalOutflows.value.amount);
        expect(parts.equals(result.trackedTotalSpending.value.amount)).toBe(true);
      }),
    );
  });

  it('keeps known consumption plus the residual equal to consumption', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        const result = run(generated);
        expect(
          result.knownConsumption.value.amount
            .plus(result.unclassified.value.amount)
            .equals(result.consumption.value.amount),
        ).toBe(true);
      }),
    );
  });
});

describe('property: the setting moves the savings and not the spending', () => {
  /**
   * Exact, over rates on which every conversion is representable.
   *
   * The identity being asserted — that turning the setting off adds back exactly
   * the additional spending — is a rearrangement across a change of magnitude,
   * and no such rearrangement is exact at a fixed number of significant digits.
   * The honest way to state it is therefore to generate conditions in which the
   * conversions themselves terminate, and then to demand equality with no
   * tolerance whatever.
   *
   * The alternative — comparing at eight decimal places — would have quietly
   * cited the wrong contract: `NUMERIC(24,8)` is the scale money is *persisted*
   * at, and 5.3 persists none of these figures. What a non-terminating rate
   * actually does to the same statement is pinned separately below.
   */
  it('differs by the reporting additional spending, and leaves total spending alone', () => {
    fc.assert(
      fc.property(exactInputArb, (generated) => {
        const counted = run(generated, { counted: true });
        const trackedOnly = run(generated, { counted: false });

        const difference = trackedOnly.personalSavings.value.amount.minus(
          counted.personalSavings.value.amount,
        );
        expect(difference.equals(counted.additionalSpending.value.amount)).toBe(true);
        // Total spending consumes the same components either way, with no
        // subtraction and no change of magnitude, so it is exactly equal — and
        // that one holds on any rates at all.
        expect(
          counted.totalSpending.value.amount.equals(trackedOnly.totalSpending.value.amount),
        ).toBe(true);
      }),
    );
  });

  it('leaves total spending alone on any rates, terminating or not', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        const counted = run(generated, { counted: true });
        const trackedOnly = run(generated, { counted: false });
        expect(
          counted.totalSpending.value.amount.equals(trackedOnly.totalSpending.value.amount),
        ).toBe(true);
      }),
    );
  });

  it('subtracts additional spending from the tracked savings, and nothing else does', () => {
    // The exact half of the same statement: with the setting off the figure is
    // the tracked savings itself, and with it on the subtraction is the only
    // difference in how it was built.
    fc.assert(
      fc.property(inputArb, (generated) => {
        const trackedOnly = run(generated, { counted: false });
        expect(
          trackedOnly.personalSavings.value.amount.equals(
            trackedOnly.trackedSavingsFromIncome.value.amount,
          ),
        ).toBe(true);
      }),
    );
  });
});

describe('property: a memo changes no total', () => {
  it('leaves every spending and savings figure untouched', () => {
    fc.assert(
      fc.property(inputArb, amountArb, (generated, other) => {
        const before = run(generated);
        const after = run({ ...generated, thirdParty: other });

        for (const key of [
          'trackedTotalSpending',
          'trackedSavingsFromIncome',
          'personalSavings',
          'totalSpending',
        ] as const) {
          expect(after[key].value.amount.equals(before[key].value.amount)).toBe(true);
          expect(after[key].availability).toBe(before[key].availability);
        }
      }),
    );
  });

  it('does not block the savings rate when its own conversion fails', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        // A memo in a currency with no rates at all.
        const withoutRates: Generated = { ...generated, rates: [] };
        const eurOnly: Generated = {
          ...withoutRates,
          contributions: withoutRates.contributions.map((c) => ({
            ...c,
            amount: money(c.amount.amount, EUR),
          })),
          residual:
            withoutRates.residual === undefined
              ? undefined
              : [withoutRates.residual[0], false],
        };
        const result = run(eurOnly, { foreignMemo: true });

        expect(result.thirdPartyPaid.availability).toBe('unavailable');
        expect(result.personalSavings.availability).toBe('available');
        if (result.externalIncome.value.amount.equals(0)) {
          expect(isUnavailable(result.savingsRate)).toBe(true);
        } else {
          expect(isUnavailable(result.savingsRate)).toBe(false);
        }
      }),
    );
  });
});

describe('property: the rate exists exactly when both aggregates do', () => {
  it('is the exact quotient, or unavailable, and never partial', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        const result = run(generated);
        const rate = result.savingsRate;

        const both =
          result.personalSavings.availability === 'available' &&
          result.externalIncome.availability === 'available';
        const zero = result.externalIncome.value.amount.equals(0);

        if (both && !zero) {
          if (isUnavailable(rate)) throw new Error('expected a rate');
          expect(
            rate.equals(
              result.personalSavings.value.amount.dividedBy(
                result.externalIncome.value.amount,
              ),
            ),
          ).toBe(true);
        } else {
          expect(isUnavailable(rate)).toBe(true);
        }
      }),
    );
  });
});

describe('a rate that does not terminate', () => {
  /**
   * The distinction the property above must not blur: finite-precision algebra
   * is not financial rounding.
   *
   * 8451 USD at an average rate of 1.3 is 6500.769230…, non-terminating, held to
   * forty significant digits. Subtracting 3500 pushes the value past 10 000, so
   * the sum needs a forty-first digit it does not have and loses the last one.
   * The difference between the two settings is then 3499.999…9 rather than 3500
   * — off by 10⁻³⁴ of a euro, and entirely a consequence of working at a fixed
   * number of significant digits.
   *
   * Production rounds nothing on the way: every digit it computed is still
   * there, and would still be there in the serialized string. A rounding rule
   * would have produced 3500.00000000 and hidden both facts.
   */
  const nonTerminating = (): Generated => ({
    contributions: [],
    residual: [new Decimal('8451'), true],
    additional: new Decimal('3500'),
    thirdParty: new Decimal('0'),
    rates: DAYS.map((day) => ({
      quote: USD,
      rateDate: plainDate(day),
      rate: new Decimal('1.3'),
      source: 'ECB',
    })),
    counted: true,
  });

  it('keeps all forty significant digits, and rounds at no scale', () => {
    const counted = run(nonTerminating(), { counted: true });
    const trackedOnly = run(nonTerminating(), { counted: false });

    expect(trackedOnly.personalSavings.value.amount.toString()).toBe(
      '-6500.769230769230769230769230769230769231',
    );
    expect(counted.personalSavings.value.amount.toString()).toBe(
      '-10000.76923076923076923076923076923076923',
    );
    // Thirty-six decimal places, not eight, and not two.
    expect(
      trackedOnly.personalSavings.value.amount.toString().split('.')[1]?.length,
    ).toBe(36);
  });

  it('is exact to the working precision, and says so rather than rounding', () => {
    const counted = run(nonTerminating(), { counted: true });
    const trackedOnly = run(nonTerminating(), { counted: false });

    const difference = trackedOnly.personalSavings.value.amount.minus(
      counted.personalSavings.value.amount,
    );
    expect(difference.toString()).toBe('3499.999999999999999999999999999999999999');
    expect(difference.equals(new Decimal('3500'))).toBe(false);
    // A ten-thousandth of a trillionth of a trillionth of a euro: the identity
    // is intact, the arithmetic is finite, and neither is quietly corrected.
    expect(difference.minus(3500).abs().lessThan(new Decimal('1e-30'))).toBe(true);
  });

  it('is deterministic: the same rows give the same digits every time', () => {
    const first = run(nonTerminating());
    const second = run(nonTerminating());
    expect(second.personalSavings.value.amount.toString()).toBe(
      first.personalSavings.value.amount.toString(),
    );
    expect(second.unclassified.value.amount.toString()).toBe(
      first.unclassified.value.amount.toString(),
    );
  });
});
