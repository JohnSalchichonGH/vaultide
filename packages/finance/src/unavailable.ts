/**
 * `Unavailable` and partial aggregates (blueprint 7.6).
 *
 * A quantity that cannot be computed is never `0` and never `null`: it is an
 * explicit value carrying a reason, and an aggregation over a list that
 * contains one produces a partial result rather than a wrong total.
 */

export type UnavailableReason =
  | 'fx_missing'
  | 'no_valuation_in_period'
  | 'missing_month_end'
  | 'missing_opening'
  | 'mtd_no_common_date'
  | 'no_root'
  | 'insufficient_history'
  | 'not_applicable'
  | 'divide_by_zero';

export interface Unavailable {
  readonly kind: 'unavailable';
  readonly reason: UnavailableReason;
  readonly detail?: string;
}

export function unavailable(reason: UnavailableReason, detail?: string): Unavailable {
  return detail === undefined
    ? { kind: 'unavailable', reason }
    : { kind: 'unavailable', reason, detail };
}

export function isUnavailable(value: unknown): value is Unavailable {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'unavailable'
  );
}

/** A value that may be unavailable. */
export type Maybe<T> = T | Unavailable;

/**
 * The result of aggregating a list in which some elements were unavailable
 * (blueprint 7.6: `Partial<Money>`). Named `PartialValue` because `Partial` is
 * a TypeScript built-in.
 */
export interface PartialValue<T> {
  readonly kind: 'partial';
  readonly value: T;
  readonly missingCount: number;
  readonly reasons: readonly UnavailableReason[];
}

export function isPartial<T>(value: unknown): value is PartialValue<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'partial'
  );
}

export function partial<T>(
  value: T,
  missingCount: number,
  reasons: readonly UnavailableReason[],
): PartialValue<T> {
  return { kind: 'partial', value, missingCount, reasons };
}

/** An aggregate: either a complete value or a partial one. */
export type Aggregate<T> = T | PartialValue<T>;

/** The value carried by an aggregate, complete or partial. */
export function aggregateValue<T>(aggregate: Aggregate<T>): T {
  return isPartial<T>(aggregate) ? aggregate.value : aggregate;
}

/**
 * Fold a list of possibly-unavailable items into an aggregate: available items
 * are combined, unavailable ones are counted and their reasons collected.
 */
export function foldAvailable<T, A>(
  items: readonly Maybe<T>[],
  initial: A,
  combine: (accumulator: A, item: T) => A,
): Aggregate<A> {
  let accumulator = initial;
  let missingCount = 0;
  const reasons: UnavailableReason[] = [];

  for (const item of items) {
    if (isUnavailable(item)) {
      missingCount += 1;
      if (!reasons.includes(item.reason)) reasons.push(item.reason);
      continue;
    }
    accumulator = combine(accumulator, item);
  }

  return missingCount === 0 ? accumulator : partial(accumulator, missingCount, reasons);
}
