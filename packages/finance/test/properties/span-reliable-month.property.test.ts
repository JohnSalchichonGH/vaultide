import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  endOfMonthKey,
  monthKey,
  monthKeyOf,
  plainDate,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import { monthEnd, position } from '../helpers/records';
import {
  findSpans,
  reconcileCompletedMonth,
  type CashAccountInput,
  type SpanResult,
} from '../../src/reconciliation/index';

/**
 * Property 14, second half — span topology (blueprint 21.2 property 14):
 *
 * > "a span never overlaps a reliable month"
 *
 * A span exists to bridge months whose own endpoints are missing (8.7), so the
 * months it covers are individually `unavailable` — that is the point of it.
 * What must never happen is a span reaching across a month that *did* reconcile
 * on its own evidence, because then the same cash movement would be reported
 * twice: once as that month's own figure and once inside the span's.
 *
 * The first half — that monthly totals partition the whole range — is temporal
 * and lives in `month-partition.property.test.ts`.
 *
 * Evidence topology only. Every balance is zero and there are no flows, so every
 * computable figure is exactly zero and no arithmetic accident can turn this
 * into a status test. Native currency, no FX.
 */

const CURRENCY = currencyCode('EUR');
const ACCOUNT = 'acct-only';

interface Timeline {
  /** The month before the span's opening anchor: complete, but with no opening. */
  readonly previous: MonthKey;
  /** The opening anchor. Reliable: it has both its endpoints. */
  readonly opening: MonthKey;
  /** The closing anchor. Not reliable: its own opening endpoint is missing. */
  readonly closing: MonthKey;
  /** The month after the closing anchor. Reliable again. */
  readonly following: MonthKey;
  /** Every completed month of the history, in order. */
  readonly months: readonly MonthKey[];
  readonly account: CashAccountInput;
  readonly today: PlainDate;
}

const plus = (month: MonthKey, count: number): MonthKey =>
  monthKey(addMonths(startOfMonthKey(month), count));

/**
 * A history with exactly one gap in its month ends (8.7).
 *
 *     end(previous)      complete
 *     end(opening)       complete
 *     end(opening + 1)   missing
 *     …                            `gap` of them
 *     end(closing − 1)   missing
 *     end(closing)       complete
 *     end(following)     complete
 *
 * `closing = opening + gap + 1` with `gap ≥ 1`, so `closing ≥ opening + 2` and
 * the pair is a span candidate. The two other consecutive pairs are one month
 * apart and are not, which is what makes exactly one span discoverable — and
 * why `opening` and `following` are ordinary reliable months sitting on either
 * side of it, pinning the inclusive boundary at both ends.
 */
function build(year: number, month: number, gap: number): Timeline {
  const previous = monthKeyOf(year, month);
  const opening = plus(previous, 1);
  const closing = plus(opening, gap + 1);
  const following = plus(closing, 1);

  const months: MonthKey[] = [];
  for (let m = previous; m <= following; m = plus(m, 1)) months.push(m);

  const completeEnds = [previous, opening, closing, following].map(endOfMonthKey);

  return {
    previous,
    opening,
    closing,
    following,
    months,
    account: {
      position: position('Only', { id: ACCOUNT, currency: 'EUR' }),
      // Zero everywhere: the topology is the subject, not the arithmetic.
      valuations: completeEnds.map((on) => monthEnd(ACCOUNT, on, '0')),
      accountType: 'checking',
    },
    today: addDays(endOfMonthKey(following), 1),
  };
}

const timelineArb: fc.Arbitrary<Timeline> = fc
  .tuple(
    fc.integer({ min: 2020, max: 2026 }),
    fc.integer({ min: 1, max: 12 }),
    // At least one missing month end, or there is no gap to bridge.
    fc.integer({ min: 1, max: 5 }),
  )
  .map(([year, month, gap]) => build(year, month, gap));

const spansOf = (timeline: Timeline): SpanResult[] =>
  findSpans({
    today: timeline.today,
    cashAccounts: [timeline.account],
    income: [],
    expenses: [],
    transfers: [],
  });

/** The months this history reconciles as `reliable` on their own evidence. */
function reliableMonths(timeline: Timeline): MonthKey[] {
  return timeline.months.filter((month) => {
    const bucket = reconcileCompletedMonth({
      month,
      today: timeline.today,
      cashAccounts: [timeline.account],
      income: [],
      expenses: [],
      transfers: [],
      templates: [],
      resolvedOccurrences: new Set<string>(),
    }).buckets[0];
    if (bucket === undefined) throw new Error(`no ${CURRENCY} bucket for ${month}`);
    return bucket.status === 'reliable';
  });
}

/**
 * Do a span's interval and a month's overlap?
 *
 * Both are inclusive at both ends — 8.1's same-day rule means a balance dated
 * `end(M)` already reflects a flow dated `end(M)`, so a half-open reading would
 * quietly let a span and a month share a day. Compared with the canonical date
 * helper rather than by month label.
 */
function overlaps(span: SpanResult, month: MonthKey): boolean {
  return (
    compareDates(span.from, endOfMonthKey(month)) <= 0 &&
    compareDates(startOfMonthKey(month), span.to) <= 0
  );
}

describe('property 14b: a span never overlaps a reliable month', () => {
  it('leaves every month that reconciled on its own evidence outside every span', () => {
    fc.assert(
      fc.property(timelineArb, (timeline) => {
        const spans = spansOf(timeline);
        // Non-vacuous by construction: the gap is real, so a span exists.
        expect(spans).toHaveLength(1);

        const reliable = reliableMonths(timeline);
        // The anchor month and the month after the span reconcile on their own
        // evidence; nothing else in the history does.
        expect(reliable).toEqual([timeline.opening, timeline.following]);

        for (const span of spans) {
          for (const month of reliable) {
            expect(overlaps(span, month)).toBe(false);
            // The same statement said the other way round, so a mistake in the
            // predicate cannot make both readings agree by accident.
            expect(
              compareDates(span.to, startOfMonthKey(month)) < 0 ||
                compareDates(endOfMonthKey(month), span.from) < 0,
            ).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('does overlap the months that could not reconcile, which is what it is for', () => {
    fc.assert(
      fc.property(timelineArb, (timeline) => {
        const [span] = spansOf(timeline);
        if (span === undefined) throw new Error('expected one span');

        // 8.7: the interval runs from the month after the opening anchor to the
        // end of the closing anchor's own month, inclusive.
        expect(span.from).toBe(startOfMonthKey(plus(timeline.opening, 1)));
        expect(span.to).toBe(endOfMonthKey(timeline.closing));

        // The closing anchor's month is inside the span and is not reliable —
        // its own opening endpoint is missing. Property 14 forbids overlapping a
        // reliable month, not overlapping an unavailable one, and this is the
        // difference.
        expect(overlaps(span, timeline.closing)).toBe(true);
        expect(reliableMonths(timeline)).not.toContain(timeline.closing);
        expect(span.months).toContain(timeline.closing);
        expect(span.months.length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 200 },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One timeline written out in full                                           */
/* -------------------------------------------------------------------------- */

describe('property 14b: the inclusive boundary, on a fixed timeline', () => {
  // May complete, June complete, July and August missing, September complete,
  // October complete.
  const timeline = build(2026, 5, 2);

  it('abuts the reliable months on both sides without touching either', () => {
    const [span] = spansOf(timeline);
    if (span === undefined) throw new Error('expected one span');

    expect(span.from).toBe(plainDate('2026-07-01'));
    expect(span.to).toBe(plainDate('2026-09-30'));
    expect(span.months.map((month) => String(month))).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);

    expect(reliableMonths(timeline).map((month) => String(month))).toEqual([
      '2026-06-01',
      '2026-10-01',
    ]);

    // June ends the day before the span begins; October begins the day after it
    // ends. One day either way, and no overlap.
    expect(span.from).toBe(addDays(plainDate('2026-06-30'), 1));
    expect(addDays(span.to, 1)).toBe(plainDate('2026-10-01'));
    expect(overlaps(span, monthKeyOf(2026, 6))).toBe(false);
    expect(overlaps(span, monthKeyOf(2026, 10))).toBe(false);

    // And every figure is exactly zero, so nothing here is an arithmetic test.
    expect(span.totals.cashDelta.toString()).toBe('0');
    expect(span.unclassified.toString()).toBe('0');
    expect(span.status).toBe('reliable');
  });
});
