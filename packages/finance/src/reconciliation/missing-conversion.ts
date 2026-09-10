import { Decimal } from '../decimal';
import { endOfMonthKey, type MonthKey } from '../dates/plain-date';
import { convert } from '../fx/convert';
import type { FxTable } from '../fx/types';
import { money } from '../money/money';
import type { CurrencyCode } from '../money/types';
import { isUnavailable } from '../unavailable';
import { DuplicateBucketObservationError } from './diagnostics';
import {
  ISSUE_CLASS,
  type BucketResult,
  type ConversionCandidate,
  type Issue,
  type MonthReconciliation,
  type ReconciliationStatus,
} from './types';

/**
 * `possible_missing_conversion` (blueprint 8.5, v2.1.12 30.15 items 6–9,
 * v2.1.14 30.17 item 7).
 *
 * An unrecorded cross-currency transfer leaves one algebraic signature in a
 * completed month. Cash arrived in the destination currency with no `Nin`
 * recorded, so that bucket's `unclassified` went negative and it raised
 * `unexplained_inflow` with `X = −unclassified`; and cash left the source
 * currency with no `Nout` recorded, so that bucket's `unclassified` — the
 * spending spike — went positive. When `X` valued at the month's average rate
 * lands just under the spike, the two residuals look like one transfer.
 *
 * Destination: a bucket with a computed `unclassified < 0` — exactly the
 * condition the engine raises `unexplained_inflow` on, so `X` is that issue's
 * own amount. Source: every *other* bucket of the same month whose own status
 * is `reliable` or `estimated` and whose computed `unclassified > 0`; an
 * `unavailable` or `unresolved` bucket has no positive computed residual and
 * cannot qualify. `X` is converted C1 → C2 at M's monthly-average cross rate
 * (10.2) over in-month observations only: one observation is an average, none
 * is `Unavailable`, and an unavailable lookup removes that source rather than
 * borrowing a rate from outside the month (30.17). The match is
 * `X2 ≤ U2 ≤ 1.05 × X2` on exact Decimals — a floor at `X2` and five per cent
 * of headroom, never a symmetric band: a real conversion's outflow is at least
 * the inflow valued at the market average, with spread and friction above it.
 *
 * One advisory per destination bucket, carrying every qualifying source once,
 * ordered by source currency code ascending, under the single stable key that
 * `month_reviews.dismissed_issues` stores. Advisory metadata only: it changes
 * no status, total or residual, and the transfer it may prefill uses `U2` and
 * `X` — never `X2`, which is evidence for the suggestion and not a claim about
 * the bank's rate.
 */

/** 30.15 item 7: `U2` may exceed `X2` by five per cent and no more. */
export const MISSING_CONVERSION_HEADROOM = new Decimal('1.05');

/**
 * One bucket of the month, as the diagnostic sees it.
 *
 * Its currency, its own status, and its computed residual when it has one.
 * No account, no issue, no rate: the month's average is looked up from the
 * table the caller supplies, and nothing else about the bucket can reach the
 * decision.
 */
export interface MissingConversionObservation {
  readonly currency: CurrencyCode;
  /** The bucket's own status — never the month's worst-across-buckets one. */
  readonly status: ReconciliationStatus;
  /** Absent exactly when the bucket never reached the identity (30.12). */
  readonly unclassified?: Decimal | undefined;
}

type WithResidual = MissingConversionObservation & { readonly unclassified: Decimal };

/**
 * May this bucket be a destination? A computed residual below zero — the
 * engine's own `unexplained_inflow` condition (8.5), compared against zero
 * rather than by sign bit so that a negative zero is a bucket that reconciled.
 */
export function isMissingConversionDestination(
  observation: MissingConversionObservation,
): observation is WithResidual {
  return observation.unclassified !== undefined && observation.unclassified.lessThan(0);
}

/**
 * May this bucket be a source (30.15 item 6)? `reliable` or `estimated`, with
 * a computed residual above zero. The status test is not redundant with the
 * sign: it keeps a provisional bucket out even if something handed one in with
 * a positive residual attached, and says in code what the blueprint says in
 * prose about `unavailable` and `unresolved`.
 */
export function isMissingConversionSource(
  observation: MissingConversionObservation,
): observation is WithResidual {
  return (
    (observation.status === 'reliable' || observation.status === 'estimated') &&
    observation.unclassified !== undefined &&
    observation.unclassified.greaterThan(0)
  );
}

/** `X2 ≤ U2 ≤ 1.05 × X2`, inclusive at both ends, on exact Decimals (30.15 item 7). */
export function isWithinConversionBand(sourceAmount: Decimal, comparisonAmount: Decimal): boolean {
  return (
    !sourceAmount.lessThan(comparisonAmount) &&
    !sourceAmount.greaterThan(comparisonAmount.times(MISSING_CONVERSION_HEADROOM))
  );
}

function observe(bucket: BucketResult): MissingConversionObservation {
  return {
    currency: bucket.currency,
    status: bucket.status,
    ...(bucket.totals.unclassified === undefined ? {} : { unclassified: bucket.totals.unclassified }),
  };
}

/**
 * The observations one reconciled month contributes — one per native bucket.
 *
 * Takes a `MonthReconciliation` and nothing else, which is what keeps a span
 * or a month-to-date result out by construction rather than by a filter.
 */
export function conversionObservations(
  reconciliation: MonthReconciliation,
): MissingConversionObservation[] {
  return reconciliation.buckets.map(observe);
}

/**
 * The advisory for one destination bucket, or nothing.
 *
 * `peers` are the month's other buckets, in any order. One in the destination's
 * own currency is not another bucket and is ignored; a currency given twice is
 * an error rather than a double candidate. The rate is the completed month's
 * average from `table`, which must have been built for a month that is over:
 * asked about the current month, 10.2 has no average without a cut-off, the
 * lookup is `Unavailable`, and nothing qualifies.
 */
export function possibleMissingConversionIssue(
  month: MonthKey,
  destination: MissingConversionObservation,
  peers: readonly MissingConversionObservation[],
  table: FxTable,
): Issue | undefined {
  if (!isMissingConversionDestination(destination)) return undefined;

  const destinationAmount = destination.unclassified.negated();
  const valuedOn = endOfMonthKey(month);
  const seen = new Set<CurrencyCode>();
  const candidates: ConversionCandidate[] = [];

  for (const peer of peers) {
    if (seen.has(peer.currency)) throw new DuplicateBucketObservationError(month, peer.currency);
    seen.add(peer.currency);
    if (peer.currency === destination.currency || !isMissingConversionSource(peer)) continue;

    // `X` valued in `C2` at M's average: `monthly_average` with no `through`,
    // the completed month's whole-month rule (10.2, 30.17).
    const converted = convert(
      money(destinationAmount, destination.currency),
      peer.currency,
      valuedOn,
      table,
      { mode: 'monthly_average' },
    );
    if (isUnavailable(converted)) continue;

    const comparisonAmount = converted.amount.amount;
    if (!isWithinConversionBand(peer.unclassified, comparisonAmount)) continue;

    candidates.push({
      sourceCurrency: peer.currency,
      destinationCurrency: destination.currency,
      sourceAmount: peer.unclassified,
      destinationAmount,
      comparisonAmount,
      rate: converted.rate,
      rateDate: converted.rateDate,
      rateSource: converted.source,
    });
  }

  if (candidates.length === 0) return undefined;
  // Currency codes are distinct here — a repeat threw above — so the order is
  // total and the same whatever order the peers arrived in.
  candidates.sort((a, b) => (a.sourceCurrency < b.sourceCurrency ? -1 : 1));

  return {
    key: 'possible_missing_conversion',
    class: ISSUE_CLASS.possible_missing_conversion,
    currency: destination.currency,
    amount: destinationAmount,
    candidates,
  };
}

/**
 * The same month, with the advisory added to each destination bucket that
 * earns one.
 *
 * Advisory only: statuses, totals, accounts and every other issue are the
 * engine's own and are returned untouched, and the advisory is appended after
 * them. A bucket that already carries it is left alone, so running this twice
 * raises it once. Several destination buckets may each hold their own, with
 * their own candidate lists (30.15 item 9).
 */
export function withPossibleMissingConversion(
  reconciliation: MonthReconciliation,
  table: FxTable,
): MonthReconciliation {
  const observations = conversionObservations(reconciliation);
  const buckets = reconciliation.buckets.map((bucket) => {
    if (bucket.issues.some((issue) => issue.key === 'possible_missing_conversion')) return bucket;
    const issue = possibleMissingConversionIssue(
      reconciliation.month,
      observe(bucket),
      observations.filter((other) => other.currency !== bucket.currency),
      table,
    );
    return issue === undefined ? bucket : { ...bucket, issues: [...bucket.issues, issue] };
  });
  return { ...reconciliation, buckets };
}
