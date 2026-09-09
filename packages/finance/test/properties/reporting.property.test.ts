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
   * Compared at the storage scale, and that is not a softened assertion.
   *
   * A reporting figure is a division, and a converted residual is usually a
   * non-terminating one held to forty significant digits. Subtracting the
   * additional spending changes the magnitude, so the result is re-rounded to
   * forty significant digits from a different exponent and the two paths can
   * differ in their last fractional digit — around 10⁻³⁴ of a unit. That is
   * arithmetic, not a defect: no rearrangement across a magnitude change is
   * exact at fixed significant digits.
   *
   * Every figure is still exact in itself; it is the algebraic identity between
   * two of them that is only exact to working precision. Eight decimal places is
   * the scale these amounts are stored and shown at (6.1, 7.2), so a real error
   * — a wrong term, a double subtraction — is orders of magnitude larger and
   * still caught here.
   */
  it('differs by the reporting additional spending, and leaves total spending alone', () => {
    fc.assert(
      fc.property(inputArb, (generated) => {
        const counted = run(generated, { counted: true });
        const trackedOnly = run(generated, { counted: false });

        const difference = trackedOnly.personalSavings.value.amount.minus(
          counted.personalSavings.value.amount,
        );
        expect(difference.toDecimalPlaces(8).toString()).toBe(
          counted.additionalSpending.value.amount.toDecimalPlaces(8).toString(),
        );
        // Total spending consumes the same components either way, with no
        // subtraction and no change of magnitude, so it is exactly equal.
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
