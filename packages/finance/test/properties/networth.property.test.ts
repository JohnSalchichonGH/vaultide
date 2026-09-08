import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { plainDate, type PlainDate } from '../../src/dates/plain-date';
import { serialize } from '../../src/money/money';
import { isUnavailable } from '../../src/unavailable';
import { netWorthAt, netWorthSign, valueAt, type PositionWithValuations } from '../../src/index';
import { entry, fxTable, position, rate, valuation } from '../helpers/records';

/**
 * Net-worth invariants (blueprint 21.2, in particular #5 and #20).
 *
 * These are the statements that must hold for *any* balance sheet, not just for
 * the fixtures — which is exactly where a "one more special case" implementation
 * of the two metrics would come apart.
 */

/** Amounts as exact decimal strings. Never generated as floats. */
const amountArb = fc
  .tuple(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => {
    const sign = whole < 0 ? '-' : '';
    return `${sign}${String(Math.abs(whole))}.${String(fraction).padStart(8, '0')}`;
  });

const kindArb = fc.constantFrom('cash' as const, 'other_asset' as const, 'liability' as const);
const currencyArb = fc.constantFrom('EUR', 'USD', 'GBP');
const dateArb = fc.constantFrom(
  '2026-05-31',
  '2026-06-30',
  '2026-07-31',
  '2026-08-31',
);

const AS_OF = plainDate('2026-08-31');

interface Generated {
  readonly entries: PositionWithValuations[];
}

/** A random small balance sheet: kinds, currencies, dates and inclusion flags. */
const balanceSheetArb = fc
  .array(
    fc.record({
      kind: kindArb,
      currency: currencyArb,
      include: fc.boolean(),
      valuations: fc.array(fc.tuple(dateArb, amountArb), { maxLength: 4 }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs): Generated => ({
    entries: specs.map((spec, index) => {
      const id = `p${String(index)}`;
      const record = position(`Position ${String(index)}`, {
        id,
        kind: spec.kind,
        currency: spec.currency,
        ...(spec.kind === 'other_asset' ? { includeInFinancialNetWorth: spec.include } : {}),
      });
      // One valuation per position per date (M1): keep the first per date.
      const seen = new Set<string>();
      const rows = spec.valuations
        .filter(([date]) => (seen.has(date) ? false : (seen.add(date), true)))
        .map(([date, amount]) => valuation(id, date, amount));
      return entry(record, rows);
    }),
  }));

/** Rates for every currency the generator can produce, on every date it uses. */
const RATES = [
  rate('USD', '2026-05-31', '1.1490'),
  rate('USD', '2026-06-30', '1.1522'),
  rate('USD', '2026-07-31', '1.1571'),
  rate('USD', '2026-08-31', '1.1596'),
  rate('GBP', '2026-05-31', '0.85310'),
  rate('GBP', '2026-06-30', '0.85480'),
  rate('GBP', '2026-07-31', '0.85720'),
  rate('GBP', '2026-08-31', '0.85648'),
];

const fx = fxTable(RATES, '2026-09-06');
const fxEmpty = fxTable([], '2026-09-06');

const run = (entries: readonly PositionWithValuations[], asOf: PlainDate = AS_OF) =>
  netWorthAt({ positions: entries, asOf, reportingCurrency: 'EUR', fx });

describe('property 20: financial net worth is total net worth minus the excluded other assets', () => {
  it('holds exactly when no conversion is involved', () => {
    fc.assert(
      fc.property(balanceSheetArb, dateArb, ({ entries }, date) => {
        // Every position already in the reporting currency, so every figure is
        // a sum of exact decimals and the identity is exact to the last digit.
        const inEur = entries.filter((item) => item.position.currency === 'EUR');
        const result = run(inEur, plainDate(date));

        fc.pre(result.totalNetWorth.availability === 'available');

        const derived = result.totalNetWorth.value.amount.minus(
          result.components.otherAssetsExcluded.value.amount,
        );
        expect(result.financialNetWorth.value.amount.toFixed()).toBe(derived.toFixed());
      }),
      { numRuns: 300 },
    );
  });

  it('holds far beyond any displayable precision once rates are involved', () => {
    // A conversion is a division, and `USD 3,000 / 1.1596` does not terminate:
    // it is held to 40 significant digits (7.1). Summing a set and summing a
    // subset therefore need not agree in the fortieth digit — decimal
    // arithmetic stops being associative the moment a value is rounded at all.
    //
    // So the identity is asserted where it is true rather than where it is
    // convenient: exactly, above, when no division happened; and here to 10⁻²⁵
    // of a unit, which is twenty-three orders of magnitude below the smallest
    // amount the database can even store (NUMERIC(24,8)) and twenty-five below
    // a cent. Nothing a person or a ledger can observe rides on the difference.
    const tolerance = new Decimal('1e-25');

    fc.assert(
      fc.property(balanceSheetArb, dateArb, ({ entries }, date) => {
        const result = run(entries, plainDate(date));

        fc.pre(result.totalNetWorth.availability === 'available');
        fc.pre(result.components.otherAssetsExcluded.availability === 'available');

        const derived = result.totalNetWorth.value.amount.minus(
          result.components.otherAssetsExcluded.value.amount,
        );
        const drift = result.financialNetWorth.value.amount.minus(derived).absoluteValue();
        expect(drift.lessThanOrEqualTo(tolerance)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('never lets an excluded other asset into financial net worth', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const result = run(entries);
        const excludedIds = new Set(
          entries
            .filter(
              (item) =>
                item.position.kind === 'other_asset' &&
                item.position.includeInFinancialNetWorth !== true,
            )
            .map((item) => item.position.id),
        );

        for (const contribution of result.positions) {
          if (excludedIds.has(contribution.value.position.id)) {
            expect(contribution.inFinancialNetWorth).toBe(false);
          }
        }

        // …and no liability ever carries the preference: it is in both metrics.
        for (const contribution of result.positions) {
          if (contribution.value.position.kind === 'liability') {
            expect(contribution.inFinancialNetWorth).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('the reported total is the sum of what it says it contains', () => {
  it('equals the sum of the contributing positions, exactly', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const result = run(entries);

        let expected = new Decimal(0);
        for (const contribution of result.positions) {
          if (contribution.reporting === undefined) continue;
          expected = expected.plus(contribution.reporting.amount);
        }

        expect(result.totalNetWorth.value.amount.toFixed()).toBe(expected.toFixed());
        expect(result.totalNetWorth.contributingCount).toBe(
          result.positions.filter((item) => item.reporting !== undefined).length,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('signs liabilities negative and everything else positive', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const result = run(entries);
        for (const contribution of result.positions) {
          expect(contribution.sign).toBe(netWorthSign(contribution.value.position.kind));
          const native = contribution.value.native;
          if (contribution.reporting === undefined || isUnavailable(native)) continue;
          // The signed reporting value never disagrees with the native sign.
          const nativeSign = native.amount.isZero() ? 0 : native.amount.isNegative() ? -1 : 1;
          const reportingSign = contribution.reporting.amount.isZero()
            ? 0
            : contribution.reporting.amount.isNegative()
              ? -1
              : 1;
          expect(reportingSign).toBe(nativeSign === 0 ? 0 : nativeSign * contribution.sign);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('results do not depend on input order', () => {
  it('reordering positions changes nothing', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const forwards = run(entries);
        const backwards = run([...entries].reverse());

        expect(backwards.totalNetWorth.value.amount.toFixed()).toBe(
          forwards.totalNetWorth.value.amount.toFixed(),
        );
        expect(backwards.financialNetWorth.value.amount.toFixed()).toBe(
          forwards.financialNetWorth.value.amount.toFixed(),
        );
        expect(backwards.totalNetWorth.availability).toBe(forwards.totalNetWorth.availability);
        expect(backwards.totalNetWorth.native.map(serialize)).toEqual(
          forwards.totalNetWorth.native.map(serialize),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('reordering a position’s valuations changes nothing', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const shuffled = entries.map((item) =>
          entry(item.position, [...item.valuations].reverse()),
        );
        expect(run(shuffled).totalNetWorth.value.amount.toFixed()).toBe(
          run(entries).totalNetWorth.value.amount.toFixed(),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('property 5: changing the reporting currency changes no source record', () => {
  it('leaves every native amount and its currency untouched', () => {
    fc.assert(
      fc.property(balanceSheetArb, currencyArb, ({ entries }, reporting) => {
        const nativeOf = (currency: string) =>
          netWorthAt({
            positions: entries,
            asOf: AS_OF,
            reportingCurrency: currency,
            fx,
          }).positions.map((item) =>
            isUnavailable(item.value.native) ? null : serialize(item.value.native),
          );

        expect(nativeOf(reporting)).toEqual(nativeOf('EUR'));

        // And the engine's own view of a position is independent of reporting.
        for (const item of entries) {
          const value = valueAt(item.position, item.valuations, AS_OF);
          if (isUnavailable(value.native)) continue;
          expect(serialize(value.native).currency).toBe(item.position.currency);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('a missing rate is partial, never zero', () => {
  it('reports what could be established and names the rest', () => {
    fc.assert(
      fc.property(balanceSheetArb, ({ entries }) => {
        const result = netWorthAt({
          positions: entries,
          asOf: AS_OF,
          reportingCurrency: 'EUR',
          fx: fxEmpty,
        });

        const foreign = result.positions.filter(
          (item) =>
            item.value.contributes &&
            item.value.position.currency !== 'EUR' &&
            !isUnavailable(item.value.native),
        );

        if (foreign.length === 0) return;

        expect(result.totalNetWorth.availability).not.toBe('available');
        // Every foreign position is named as missing, with its native amount.
        const missingIds = new Set(result.totalNetWorth.missing.map((item) => item.positionId));
        for (const item of foreign) {
          expect(missingIds.has(item.value.position.id)).toBe(true);
        }
        // …and none of them was quietly counted as nothing.
        const eurOnly = entries.filter((item) => item.position.currency === 'EUR');
        const expected = netWorthAt({
          positions: eurOnly,
          asOf: AS_OF,
          reportingCurrency: 'EUR',
          fx: fxEmpty,
        });
        expect(result.totalNetWorth.value.amount.toFixed()).toBe(
          expected.totalNetWorth.value.amount.toFixed(),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('arithmetic stays exact', () => {
  it('does not lose a digit at any magnitude the schema allows', () => {
    const big = '12345678901234567.89';
    const small = '0.00000001';
    const account = position('Vault', { id: 'x1' });
    const pocket = position('Pocket', { id: 'x2' });

    const result = run([
      entry(account, [valuation('x1', '2026-08-31', big)]),
      entry(pocket, [valuation('x2', '2026-08-31', small)]),
    ]);

    expect(result.totalNetWorth.value.amount.toFixed()).toBe('12345678901234567.89000001');
  });

  it('adds a hundred amounts with no drift', () => {
    fc.assert(
      fc.property(fc.array(amountArb, { minLength: 1, maxLength: 100 }), (amounts) => {
        const entries = amounts.map((amount, index) =>
          entry(position(`P${String(index)}`, { id: `q${String(index)}` }), [
            valuation(`q${String(index)}`, '2026-08-31', amount),
          ]),
        );

        let expected = new Decimal(0);
        for (const amount of amounts) expected = expected.plus(new Decimal(amount));

        expect(run(entries).totalNetWorth.value.amount.toFixed()).toBe(expected.toFixed());
      }),
      { numRuns: 100 },
    );
  });
});
