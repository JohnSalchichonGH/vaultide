import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { monthKeyOf, plainDate } from '../../src/dates/plain-date';
import type { FxRateRecord } from '../../src/fx/index';
import { currencyCode, type CurrencyCode } from '../../src/money/types';
import { fxTable, monthEnd, position, rate } from '../helpers/records';
import {
  isMissingConversionSource,
  possibleMissingConversionIssue,
  reconcileCompletedMonth,
  withPossibleMissingConversion,
  type CashAccountInput,
  type Issue,
  type MissingConversionObservation,
  type MonthReconciliation,
  type ReconciliationStatus,
} from '../../src/reconciliation/index';

/**
 * Invariants of `possible_missing_conversion` (30.15 items 6–9, 30.17).
 *
 * Six statements that hold for any month: peer order is irrelevant; candidates
 * are each source once, ascending by code; the band is exactly `[X2, 1.05 ×
 * X2]` against an independently computed `X2`; a bucket that cannot be a
 * source is never read; no rate observation outside the month is ever read —
 * with none inside it there is no candidate; and on a reconciled month the
 * enrichment is idempotent metadata whose `X` is the engine's own inflow.
 */

const EUR = currencyCode('EUR');
const FOREIGN = [currencyCode('USD'), currencyCode('GBP'), currencyCode('CHF'), currencyCode('JPY')];
const NOVEMBER = monthKeyOf(2026, 11);
const TODAY = '2026-12-01';
const STATUSES: ReconciliationStatus[] = ['reliable', 'estimated', 'unresolved', 'unavailable', 'provisional'];

/** Two decimals, strictly positive, bounded, exact. */
const amountArb = fc
  .tuple(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => new Decimal(`${String(whole)}.${String(cents).padStart(2, '0')}`));

/** A four-decimal rate between 0.5 and 2.0. */
const rateArb = fc.integer({ min: 5_000, max: 20_000 }).map((units) => new Decimal(units).dividedBy(10_000));

/**
 * One, two, four or five observations inside November, on distinct days, so
 * the month's average terminates and a reference `X2` is exact: a sum of
 * four-decimal rates divided by 1, 2, 4 or 5 has at most six decimals.
 */
const inMonthRowsArb = (quote: CurrencyCode): fc.Arbitrary<FxRateRecord[]> =>
  fc
    .tuple(fc.constantFrom(1, 2, 4, 5), fc.array(rateArb, { minLength: 5, maxLength: 5 }))
    .map(([count, values]) =>
      values.slice(0, count).map((value, index) => rate(quote, `2026-11-${String(index * 5 + 3).padStart(2, '0')}`, value.toFixed())),
    );

/** Observations dated in October or December — evidence about other months. */
const outsideRowsArb = (quote: CurrencyCode): fc.Arbitrary<FxRateRecord[]> =>
  fc.array(
    fc.tuple(fc.constantFrom('2026-10-21', '2026-10-31', '2026-12-01', '2026-12-10'), rateArb),
    { maxLength: 3 },
  ).map((rows) => rows.map(([day, value]) => rate(quote, day, value.toFixed())));

const observationArb = (currency: CurrencyCode): fc.Arbitrary<MissingConversionObservation> =>
  fc
    .record({
      status: fc.oneof(
        { weight: 2, arbitrary: fc.constant<ReconciliationStatus>('reliable') },
        { weight: 1, arbitrary: fc.constantFrom(...STATUSES) },
      ),
      unclassified: fc.option(
        fc.tuple(amountArb, fc.integer({ min: 0, max: 6 })).map(([amount, sign]) => (sign === 0 ? amount.negated() : amount)),
        { nil: undefined },
      ),
    })
    .map(({ status, unclassified }) => ({
      currency,
      status,
      ...(unclassified === undefined ? {} : { unclassified }),
    }));

/** One peer per foreign currency, plus one in the destination's own currency. */
const peersArb: fc.Arbitrary<MissingConversionObservation[]> = fc
  .tuple(fc.tuple(...FOREIGN.map((code) => observationArb(code))), observationArb(EUR))
  .map(([foreign, own]) => [...foreign, own]);

const rowsArb: fc.Arbitrary<FxRateRecord[]> = fc
  .tuple(...FOREIGN.map((code) => fc.oneof({ weight: 3, arbitrary: inMonthRowsArb(code) }, { weight: 1, arbitrary: fc.constant<FxRateRecord[]>([]) })))
  .map((lists) => lists.flat());

const destinationArb: fc.Arbitrary<MissingConversionObservation> = amountArb.map((amount) => ({
  currency: EUR,
  status: 'unresolved',
  unclassified: amount.negated(),
}));

const serialized = (issue: Issue | undefined): string =>
  issue === undefined
    ? 'absent'
    : JSON.stringify({
        key: issue.key,
        currency: issue.currency,
        amount: issue.amount?.toFixed(),
        candidates: issue.candidates?.map((candidate) => ({
          ...candidate,
          sourceAmount: candidate.sourceAmount.toFixed(),
          destinationAmount: candidate.destinationAmount.toFixed(),
          comparisonAmount: candidate.comparisonAmount.toFixed(),
          rate: candidate.rate.toFixed(),
        })),
      });

const issueFor = (
  destination: MissingConversionObservation,
  peers: readonly MissingConversionObservation[],
  rows: readonly FxRateRecord[],
): Issue | undefined => possibleMissingConversionIssue(NOVEMBER, destination, peers, fxTable(rows, TODAY));

/** The exact mean of a currency's in-month observations, or nothing. */
function referenceAverage(rows: readonly FxRateRecord[], quote: CurrencyCode): Decimal | undefined {
  const inMonth = rows.filter((row) => row.quote === quote && row.rateDate >= '2026-11-01' && row.rateDate <= '2026-11-30');
  if (inMonth.length === 0) return undefined;
  let total = new Decimal(0);
  for (const row of inMonth) total = total.plus(row.rate);
  return total.dividedBy(inMonth.length);
}

describe('property P1: peer order is irrelevant', () => {
  it('gives the same advisory for any permutation of the peers', () => {
    fc.assert(
      fc.property(destinationArb, peersArb, rowsArb, fc.array(fc.nat(), { minLength: 8, maxLength: 8 }), (destination, peers, rows, seeds) => {
        const before = serialized(issueFor(destination, peers, rows));
        const shuffled = [...peers];
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = (seeds[i % seeds.length] ?? 0) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as MissingConversionObservation, shuffled[i] as MissingConversionObservation];
        }
        expect(serialized(issueFor(destination, shuffled, rows))).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P2: each qualifying source once, ascending by code', () => {
  it('lists strictly increasing currency codes, none of them the destination’s', () => {
    fc.assert(
      fc.property(destinationArb, peersArb, rowsArb, (destination, peers, rows) => {
        const issue = issueFor(destination, peers, rows);
        if (issue === undefined) return;
        const codes = (issue.candidates ?? []).map((candidate) => candidate.sourceCurrency);
        expect(codes.length).toBeGreaterThan(0);
        for (let index = 1; index < codes.length; index += 1) {
          expect((codes[index - 1] as string) < (codes[index] as string)).toBe(true);
        }
        expect(codes).not.toContain('EUR');
        for (const candidate of issue.candidates ?? []) {
          expect(candidate.destinationCurrency).toBe('EUR');
          expect(candidate.destinationAmount.equals(issue.amount ?? new Decimal(-1))).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('property P3: the band is [X2, 1.05 × X2] against an exact reference', () => {
  it('admits a source exactly when U2 / X2 lies in [1, 1.05], and reports the reference X2', () => {
    const [USD] = FOREIGN;
    if (USD === undefined) throw new Error('unreachable');
    fc.assert(
      fc.property(amountArb, inMonthRowsArb(USD), (x, rows) => {
        const average = referenceAverage(rows, USD);
        if (average === undefined) throw new Error('rows are in-month by construction');
        const x2 = x.times(average);
        const destination: MissingConversionObservation = { currency: EUR, status: 'unresolved', unclassified: x.negated() };
        for (const factor of ['0.5', '0.99', '0.9999999', '1', '1.01', '1.05', '1.0500001', '1.2']) {
          const u2 = x2.times(factor);
          const issue = issueFor(destination, [{ currency: USD, status: 'reliable', unclassified: u2 }], rows);
          const inBand = !new Decimal(factor).lessThan(1) && !new Decimal(factor).greaterThan('1.05');
          expect(issue !== undefined).toBe(inBand);
          if (issue === undefined) continue;
          const [candidate] = issue.candidates ?? [];
          expect(candidate?.comparisonAmount.equals(x2)).toBe(true);
          expect(candidate?.rate.equals(average)).toBe(true);
          expect(candidate?.sourceAmount.equals(u2)).toBe(true);
          expect(candidate?.rateDate).toBe('2026-11-30');
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('property P4: a bucket that cannot be a source is never read', () => {
  it('is unchanged by any number on a peer excluded by status or by currency', () => {
    fc.assert(
      fc.property(destinationArb, peersArb, rowsArb, amountArb, (destination, peers, rows, amount) => {
        const before = serialized(issueFor(destination, peers, rows));
        peers.forEach((peer, index) => {
          const excludedByStatus = peer.status !== 'reliable' && peer.status !== 'estimated';
          if (!excludedByStatus && peer.currency !== EUR) return;
          for (const unclassified of [amount, amount.negated(), undefined]) {
            const changed = peers.map((p, position) =>
              position === index
                ? { currency: p.currency, status: p.status, ...(unclassified === undefined ? {} : { unclassified }) }
                : p,
            );
            expect(serialized(issueFor(destination, changed, rows))).toBe(before);
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P5: no rate observation outside the month is ever read', () => {
  it('is unchanged by any October or December rows, and with none inside the month has no candidate', () => {
    fc.assert(
      fc.property(
        destinationArb,
        peersArb,
        rowsArb,
        fc.tuple(...FOREIGN.map((code) => outsideRowsArb(code))).map((lists) => lists.flat()),
        (destination, peers, rows, outside) => {
          const before = serialized(issueFor(destination, peers, rows));
          expect(serialized(issueFor(destination, peers, [...rows, ...outside]))).toBe(before);
          expect(serialized(issueFor(destination, peers, [...outside, ...rows]))).toBe(before);
          // A source with no in-month evidence is never a candidate, whatever
          // sits just outside the month.
          const issue = issueFor(destination, peers, [...rows, ...outside]);
          for (const candidate of issue?.candidates ?? []) {
            expect(referenceAverage(rows, candidate.sourceCurrency)).toBeDefined();
          }
          expect(serialized(issueFor(destination, peers, outside))).toBe('absent');
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property P6: on a reconciled month the enrichment is idempotent metadata', () => {
  const [USD] = FOREIGN;
  if (USD === undefined) throw new Error('unreachable');

  const account = (id: string, currency: string, opening: Decimal, closing: Decimal): CashAccountInput => ({
    position: position(id, { id, currency }),
    valuations: [monthEnd(id, '2026-10-31', opening.toFixed()), monthEnd(id, '2026-11-30', closing.toFixed())],
    accountType: 'checking',
  });

  const monthArb: fc.Arbitrary<MonthReconciliation> = fc
    .tuple(amountArb, amountArb, amountArb, amountArb)
    .map(([eurOpen, eurClose, usdOpen, usdClose]) =>
      reconcileCompletedMonth({
        month: NOVEMBER,
        today: plainDate(TODAY),
        cashAccounts: [account('eur', 'EUR', eurOpen, eurClose), account('usd', 'USD', usdOpen, usdClose)],
        income: [],
        expenses: [],
        transfers: [],
        templates: [],
        resolvedOccurrences: new Set<string>(),
      }),
    );

  it('raises the advisory once, only on a destination, with X as the engine’s own inflow, and changes nothing else', () => {
    fc.assert(
      fc.property(monthArb, inMonthRowsArb(USD), (month, rows) => {
        const table = fxTable(rows, TODAY);
        const once = withPossibleMissingConversion(month, table);
        const twice = withPossibleMissingConversion(once, table);
        expect(twice).toEqual(once);
        expect(once.monthStatus).toBe(month.monthStatus);

        once.buckets.forEach((bucket, index) => {
          const original = month.buckets[index];
          if (original === undefined) throw new Error('a bucket cannot appear');
          const advisories = bucket.issues.filter((issue) => issue.key === 'possible_missing_conversion');
          expect(advisories.length).toBeLessThanOrEqual(1);
          const stripped = bucket.issues.filter((issue) => issue.key !== 'possible_missing_conversion');
          expect({ ...bucket, issues: stripped }).toEqual(original);

          const [advisory] = advisories;
          if (advisory === undefined) return;
          // Only a bucket that raised `unexplained_inflow` can carry it, and
          // the amount is that issue's.
          const inflow = original.issues.find((issue) => issue.key === 'unexplained_inflow');
          expect(inflow).toBeDefined();
          expect(advisory.amount?.equals(inflow?.amount ?? new Decimal(-1))).toBe(true);
          expect(original.totals.unclassified?.lessThan(0)).toBe(true);
          expect(bucket.issues[bucket.issues.length - 1]).toBe(advisory);
          // And every candidate is the other bucket, a source in its own right.
          for (const candidate of advisory.candidates ?? []) {
            const peer = month.buckets.find((b) => b.currency === candidate.sourceCurrency);
            expect(peer).toBeDefined();
            expect(isMissingConversionSource({ currency: peer?.currency ?? EUR, status: peer?.status ?? 'unavailable', unclassified: peer?.totals.unclassified })).toBe(true);
            expect(candidate.sourceAmount.equals(peer?.totals.unclassified ?? new Decimal(-1))).toBe(true);
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});
