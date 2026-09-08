import { Decimal } from '../decimal';
import {
  compareDates,
  daysBetween,
  monthsBetween,
  type PlainDate,
} from '../dates/plain-date';
import { money, zero } from '../money/money';
import type { Money } from '../money/types';
import { unavailable, type Unavailable } from '../unavailable';
import type { PositionRecord, ValuationRecord } from './types';

/**
 * A position's value at a date, and how well that value is known
 * (blueprint 12.1, 8.1, 9.1, 2.6).
 *
 * The whole point of this module is the distinction the specification kept
 * blurring: **unknown is not zero**. A car whose worth nobody has entered is
 * not worth nothing, and an aggregate containing it is not complete. Every
 * state below is a different fact, and the aggregation layer treats them
 * differently.
 *
 * Cash and other-asset values are the latest valuation on or before the date,
 * never flow-adjusted (12.1). Investments are flow-adjusted and properties are
 * not (R10) — both arrive with their phases and reuse this selection step.
 */

export type PositionValueState =
  /** A valuation dated exactly the as-of date. */
  | 'exact'
  /** An older valuation carried forward. Truthful, and labelled with its age. */
  | 'carried'
  /**
   * The position opened empty on a known date, and nothing has been valued
   * since. Zero because the user said so at creation — not because nothing is
   * known (8.1 `opened_zero`).
   */
  | 'opened_zero'
  /** Closed on or before the date: it contributes nothing afterwards (12.1). */
  | 'closed'
  /**
   * The position did not exist yet, or tracking had not started. It is not part
   * of the balance sheet at that date and is left out of totals entirely —
   * which is what keeps a historical series from being "partial" for every
   * month before an account was added (12.3 `t_start`).
   */
  | 'not_yet_tracked'
  /**
   * The position is tracked and has **no** value on record at all. Never zero:
   * it makes every aggregate containing it partial, and says which position and
   * why.
   */
  | 'missing';

export interface PositionValue {
  readonly position: PositionRecord;
  readonly asOf: PlainDate;
  readonly state: PositionValueState;
  /** Native, exact — or `Unavailable` when the state is `missing`. */
  readonly native: Money | Unavailable;
  /** The date of the valuation this value came from, when there is one. */
  readonly valuedOn?: PlainDate;
  /** How old that valuation is at the as-of date. */
  readonly ageDays?: number;
  readonly ageMonths?: number;
  /** `true` when the value came from a statement month-end balance (R15). */
  readonly fromMonthEnd?: boolean;
  /** `true` while the position is part of the balance sheet at `asOf`. */
  readonly contributes: boolean;
}

/** Valuations for one position, oldest first. Copies rather than sorts in place. */
export function sortValuations(
  valuations: readonly ValuationRecord[],
): readonly ValuationRecord[] {
  return [...valuations].sort((a, b) => {
    const byDate = compareDates(a.valuedOn, b.valuedOn);
    // One valuation per position per date (M1), so ties can only be two
    // positions' rows mixed together by a caller. Ordering by id keeps the
    // result deterministic rather than dependent on input order.
    return byDate === 0 ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : byDate;
  });
}

/** The latest valuation dated on or before `date`, or `undefined`. */
export function latestOnOrBefore(
  valuations: readonly ValuationRecord[],
  date: PlainDate,
): ValuationRecord | undefined {
  let best: ValuationRecord | undefined;
  for (const valuation of valuations) {
    if (valuation.valuedOn > date) continue;
    if (best === undefined || compareDates(valuation.valuedOn, best.valuedOn) > 0) {
      best = valuation;
    }
  }
  return best;
}

/** The valuation dated exactly `date`, if there is one. */
export function valuationOn(
  valuations: readonly ValuationRecord[],
  date: PlainDate,
): ValuationRecord | undefined {
  return valuations.find((valuation) => valuation.valuedOn === date);
}

export function firstValuation(
  valuations: readonly ValuationRecord[],
): ValuationRecord | undefined {
  let best: ValuationRecord | undefined;
  for (const valuation of valuations) {
    if (best === undefined || compareDates(valuation.valuedOn, best.valuedOn) < 0) {
      best = valuation;
    }
  }
  return best;
}

/**
 * When a position becomes part of the balance sheet (12.3).
 *
 * Its `opened_on` if it has one — the position existed from that day, empty.
 * Otherwise its first valuation: a pre-existing account only enters the picture
 * on the day the user first says what it held. Before that date there is
 * nothing honest to report, which is different from "unknown".
 */
export function trackingStartsOn(
  position: PositionRecord,
  valuations: readonly ValuationRecord[],
): PlainDate | undefined {
  if (position.openedOn !== null) return position.openedOn;
  return firstValuation(valuations)?.valuedOn;
}

/**
 * The position's value at `asOf`, with the evidence for it.
 *
 * Never returns zero to stand in for an unknown, and never returns a value for
 * a date the position was not tracked at.
 */
export function valueAt(
  position: PositionRecord,
  valuations: readonly ValuationRecord[],
  asOf: PlainDate,
): PositionValue {
  const base = { position, asOf } as const;

  // Closed positions contribute nothing after their closing date (12.1). The
  // close flow also writes a final zero valuation (M6), so this agrees with the
  // records; it is stated explicitly so an archived-without-closing position
  // cannot slip through as a carried value.
  if (position.closedOn !== null && position.closedOn <= asOf) {
    return {
      ...base,
      state: 'closed',
      native: zero(position.currency),
      valuedOn: position.closedOn,
      contributes: true,
    };
  }

  const startsOn = trackingStartsOn(position, valuations);

  if (startsOn === undefined) {
    // Tracked, but nothing has ever been said about its value. Unknown, and
    // that is what the aggregate will report.
    return {
      ...base,
      state: 'missing',
      native: unavailable('no_valuation', `no value recorded for ${position.name}`),
      contributes: true,
    };
  }

  if (asOf < startsOn) {
    return { ...base, state: 'not_yet_tracked', native: zero(position.currency), contributes: false };
  }

  const latest = latestOnOrBefore(valuations, asOf);

  if (latest === undefined) {
    // Reachable only when `opened_on` is set and no valuation exists yet: the
    // position opened empty and has not moved. Zero is a fact here, stated by
    // the user at creation, not a stand-in for an unknown (8.1 `opened_zero`).
    return {
      ...base,
      state: 'opened_zero',
      native: money(new Decimal(0), position.currency),
      valuedOn: startsOn,
      ageDays: daysBetween(startsOn, asOf),
      ageMonths: monthsBetween(startsOn, asOf),
      contributes: true,
    };
  }

  return {
    ...base,
    state: latest.valuedOn === asOf ? 'exact' : 'carried',
    native: money(latest.amount, position.currency),
    valuedOn: latest.valuedOn,
    ageDays: daysBetween(latest.valuedOn, asOf),
    ageMonths: monthsBetween(latest.valuedOn, asOf),
    fromMonthEnd: latest.datePrecision === 'month_end',
    contributes: true,
  };
}
