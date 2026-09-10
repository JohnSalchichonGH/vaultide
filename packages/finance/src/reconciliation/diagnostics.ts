import type { Decimal } from '../decimal';
import { addMonths, monthKey, startOfMonthKey, type MonthKey } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import { sumAmounts } from './scope';
import {
  ISSUE_CLASS,
  type Issue,
  type MonthReconciliation,
  type ReconciliationStatus,
} from './types';

/**
 * `large_unclassified` (blueprint 8.5, 15.2, v2.1.12 30.15 item 4).
 *
 * A completed month's residual, judged against the same native bucket's own
 * recent history: an advisory that the month has more unexplained spending than
 * it usually does, and that adding known expenses would say where it went.
 *
 * One window and one median. For target month `M` and bucket `C` the baseline is
 * the six **calendar** months `M−6 … M−1` — never a search further back for six
 * observations, so a slot that does not qualify stays empty. Of those six, only
 * buckets of `C` whose status is exactly `reliable` contribute; `estimated`,
 * `unresolved`, `unavailable`, provisional months and spans do not. The target
 * itself need only have a computed `unclassified ≥ 0`, which admits `reliable`
 * and `estimated`: the trigger needs a number, the baseline must be trustworthy,
 * and the asymmetry is the blueprint's own. Fewer than three contributing months
 * and there is nothing to compare against.
 *
 * The median is over the exact `unclassified` Decimals — the middle value for an
 * odd count, the exact mean of the two middle values for an even one — and the
 * trigger is strictly `unclassified_M > 2 × median`. A median of zero is not a
 * special case and no floor is invented: three reliable months that explained
 * everything make any unexplained euro remarkable.
 *
 * Native currency only. A EUR history says nothing about a USD residual, no rate
 * is consulted, and nothing here reads reporting figures, spans or a
 * month-to-date result. This is advisory metadata: it never changes a status,
 * a total or a residual.
 */

/** `M−6 … M−1`. */
export const LARGE_UNCLASSIFIED_BASELINE_MONTHS = 6;
/** Below this many contributing baseline months there is no advisory. */
export const LARGE_UNCLASSIFIED_MIN_OBSERVATIONS = 3;

/**
 * One completed bucket, as the diagnostic sees it.
 *
 * The month it belongs to, the currency it is in, the bucket's own status, and
 * its computed residual when it has one. Nothing else: no reporting figure, no
 * rate, no span, no evidence date. A span has no single month and a
 * month-to-date result no completed status, so neither can be expressed here.
 */
export interface LargeUnclassifiedObservation {
  readonly month: MonthKey;
  readonly currency: CurrencyCode;
  /** The bucket's own status — never the month's worst-across-buckets one. */
  readonly status: ReconciliationStatus;
  /** Absent exactly when the bucket never reached the identity (30.12). */
  readonly unclassified?: Decimal | undefined;
}

/** Raised when two observations claim the same month and currency: neither may win. */
export class DuplicateBucketObservationError extends Error {
  readonly code = 'DUPLICATE_BUCKET_OBSERVATION';
  constructor(
    readonly month: MonthKey,
    readonly currency: CurrencyCode,
  ) {
    super(`Two ${currency} observations were given for ${month}; a month has one bucket per currency.`);
    this.name = 'DuplicateBucketObservationError';
  }
}

/**
 * The observations one completed month contributes — one per native bucket.
 *
 * Takes a `MonthReconciliation` and nothing else, which is what keeps a span
 * or a month-to-date result out of the history by construction rather than by
 * a filter somebody has to remember.
 */
export function bucketObservations(reconciliation: MonthReconciliation): LargeUnclassifiedObservation[] {
  return reconciliation.buckets.map((bucket) => ({
    month: reconciliation.month,
    currency: bucket.currency,
    status: bucket.status,
    ...(bucket.totals.unclassified === undefined ? {} : { unclassified: bucket.totals.unclassified }),
  }));
}

/**
 * May this bucket be judged at all (30.15 item 4)?
 *
 * A computed residual that is not negative. Requiring the residual, and not
 * merely a status, is what keeps a bucket from being judged on a number it does
 * not have; requiring `reliable` or `estimated` keeps a provisional month out even
 * if something handed one in with a residual attached.
 */
export function isLargeUnclassifiedTarget(
  observation: LargeUnclassifiedObservation,
): observation is LargeUnclassifiedObservation & { readonly unclassified: Decimal } {
  return (
    (observation.status === 'reliable' || observation.status === 'estimated') &&
    observation.unclassified !== undefined &&
    !observation.unclassified.lessThan(0)
  );
}

/** May this bucket be part of a baseline? Exactly `reliable`, with a residual. */
export function isLargeUnclassifiedBaseline(
  observation: LargeUnclassifiedObservation,
): observation is LargeUnclassifiedObservation & { readonly unclassified: Decimal } {
  return observation.status === 'reliable' && observation.unclassified !== undefined;
}

/** The six calendar months before `month`, oldest first. */
export function largeUnclassifiedWindow(month: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let back = LARGE_UNCLASSIFIED_BASELINE_MONTHS; back >= 1; back -= 1) {
    months.push(monthKey(addMonths(startOfMonthKey(month), -back)));
  }
  return months;
}

/**
 * The median of a non-empty list of exact Decimals.
 *
 * Sorted numerically, then the mean of the middle: one value for an odd count,
 * the two middle values for an even one — which is the exact arithmetic mean
 * 30.15 item 4 asks for. Dividing by one or by two terminates for every finite
 * decimal, so nothing here rounds. The caller has already required at least
 * three values, so the middle is never empty.
 */
function medianOf(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return sumAmounts(middle).dividedBy(middle.length);
}

/**
 * The advisory for one target bucket, or nothing.
 *
 * The window is selected here, from month-labelled observations, so a caller
 * cannot hand over "the last six observations it happened to have" and call
 * that a baseline. Observations outside `M−6 … M−1`, or in another currency,
 * are ignored whatever they say. Input order is irrelevant; a month and
 * currency given twice is an error rather than a double count.
 */
export function largeUnclassifiedIssue(
  target: LargeUnclassifiedObservation,
  history: readonly LargeUnclassifiedObservation[],
): Issue | undefined {
  if (!isLargeUnclassifiedTarget(target)) return undefined;

  const window = new Set<MonthKey>(largeUnclassifiedWindow(target.month));
  const seen = new Set<string>();
  const baseline: Decimal[] = [];
  for (const observation of history) {
    const key = `${observation.month}#${observation.currency}`;
    if (seen.has(key)) throw new DuplicateBucketObservationError(observation.month, observation.currency);
    seen.add(key);
    if (observation.currency !== target.currency || !window.has(observation.month)) continue;
    if (isLargeUnclassifiedBaseline(observation)) baseline.push(observation.unclassified);
  }

  if (baseline.length < LARGE_UNCLASSIFIED_MIN_OBSERVATIONS) return undefined;
  const median = medianOf(baseline);
  if (!target.unclassified.greaterThan(median.times(2))) return undefined;

  return {
    key: 'large_unclassified',
    class: ISSUE_CLASS.large_unclassified,
    currency: target.currency,
    amount: target.unclassified,
  };
}

/**
 * The same month, with the advisory added to each bucket that earns it.
 *
 * Advisory only: statuses, totals, accounts and every other issue are the
 * engine's own and are returned untouched. A bucket that already carries the
 * advisory is left alone, so running this twice raises it once.
 */
export function withLargeUnclassified(
  reconciliation: MonthReconciliation,
  history: readonly LargeUnclassifiedObservation[],
): MonthReconciliation {
  const buckets = reconciliation.buckets.map((bucket) => {
    if (bucket.issues.some((issue) => issue.key === 'large_unclassified')) return bucket;
    const issue = largeUnclassifiedIssue(
      {
        month: reconciliation.month,
        currency: bucket.currency,
        status: bucket.status,
        ...(bucket.totals.unclassified === undefined ? {} : { unclassified: bucket.totals.unclassified }),
      },
      history,
    );
    return issue === undefined ? bucket : { ...bucket, issues: [...bucket.issues, issue] };
  });
  return { ...reconciliation, buckets };
}
