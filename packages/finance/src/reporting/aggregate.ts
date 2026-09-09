import { Decimal } from '../decimal';
import type { CurrencyCode, Money } from '../money/types';
import { add, money, sub } from '../money/money';
import type { UnavailableReason } from '../unavailable';
import type { ContributionQuality } from './contributions';

/**
 * A reporting-currency figure and what is known about it (7.6, 12.5, v2.1.13
 * 30.16 item 7).
 *
 * Availability is decided **per figure**, over the contributions that figure's
 * own formula consumes. That is the whole point: a missing rate for a memo
 * nobody adds up must not blank out the savings rate, and a missing rate for
 * additional spending must not blank out personal savings when the setting is
 * off, because that formula then subtracts nothing. A single month-level partial
 * bit cannot express any of that.
 *
 * Three things travel together and stay distinct. **Availability** is whether
 * the figure could be stated. **Quality** is the reconciliation status of the
 * native derived figures feeding it — a source sum has none, because it was
 * exact before any of this. **Provenance** is how the rates were found, which is
 * neither of the other two: an `estimatedConversion` says a residual used an
 * average rate, as every residual must, and never that data is missing.
 */

export type ReportingAvailability = 'available' | 'partial' | 'unavailable';

/** A contribution that is not inside the value, and which currency it came from. */
export interface MissingReportingContribution {
  /** The native currency whose contribution could not be stated. */
  readonly currency: CurrencyCode;
  readonly reason: UnavailableReason;
  readonly detail?: string;
}

/** How the rates behind a figure were found. Never an availability or a status. */
export interface FxProvenance {
  /** A residual converted at an average rate (8.11). */
  readonly estimatedConversion: boolean;
  /** Some lookup fell back rather than averaging, or fell back off its date. */
  readonly approximate: boolean;
  /** Every lookup landed exactly on the date asked for. */
  readonly exact: boolean;
}

export const EXACT_PROVENANCE: FxProvenance = {
  estimatedConversion: false,
  approximate: false,
  exact: true,
};

export interface ReportingAmount {
  /** The exact sum of the contributions that could be stated. */
  readonly value: Money;
  readonly availability: ReportingAvailability;
  readonly missing: readonly MissingReportingContribution[];
  /** How many contributions are inside `value`. */
  readonly statedCount: number;
  readonly quality?: ContributionQuality;
  readonly provenance: FxProvenance;
}

/** Worst-first, so a figure fed by an estimated bucket says estimated. */
const QUALITY_SEVERITY: Readonly<Record<ContributionQuality, number>> = {
  reliable: 0,
  estimated: 1,
  provisional: 2,
};

function worseQuality(
  a: ContributionQuality | undefined,
  b: ContributionQuality | undefined,
): ContributionQuality | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return QUALITY_SEVERITY[a] >= QUALITY_SEVERITY[b] ? a : b;
}

function mergeProvenance(a: FxProvenance, b: FxProvenance): FxProvenance {
  return {
    estimatedConversion: a.estimatedConversion || b.estimatedConversion,
    approximate: a.approximate || b.approximate,
    exact: a.exact && b.exact,
  };
}

/**
 * Deterministic, and de-duplicated per currency and reason.
 *
 * 30.16 item 10 asks only that the affected currency and the reason survive and
 * that the order is fixed. Repeating one currency once per unconvertible row
 * would make the diagnostic grow with the data without saying anything more.
 */
function mergeMissing(
  a: readonly MissingReportingContribution[],
  b: readonly MissingReportingContribution[],
): MissingReportingContribution[] {
  const seen = new Map<string, MissingReportingContribution>();
  for (const item of [...a, ...b]) {
    const key = `${item.currency}#${item.reason}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()].sort((x, y) =>
    x.currency === y.currency
      ? x.reason.localeCompare(y.reason)
      : x.currency.localeCompare(y.currency),
  );
}

/**
 * The rule for a **primitive** figure, summed from its own contributions.
 *
 * Nothing missing is available — including a figure with no contributions at
 * all, whose exact sum is zero. That is an answer: no such record exists. Some
 * missing and something stated is partial. Some missing and nothing stated is
 * unavailable: a primitive with no convertible row of its own has no value to
 * offer, only the reason it has none.
 */
function summedAvailability(statedCount: number, missingCount: number): ReportingAvailability {
  if (missingCount === 0) return 'available';
  return statedCount === 0 ? 'unavailable' : 'partial';
}

/**
 * The rule for a **formula** over figures that have already been evaluated.
 *
 * Here the question is about operands, not rows. An operand that says
 * `available` is a stated financial value even when it is an exact zero summed
 * from no contributions — "no such record exists" is knowledge — so a formula
 * with one known operand and one missing one knows something and is partial.
 *
 * Counting contributions instead would call that result unavailable and throw
 * away the half that was known. That is the difference between saying total
 * spending is at least the additional spending and could not be completed, and
 * saying nothing about it can be said at all.
 *
 * Nothing missing is available; something missing with any operand still
 * standing is partial; something missing with every operand unavailable is
 * unavailable.
 */
function composedAvailability(
  a: ReportingAmount,
  b: ReportingAmount,
  missingCount: number,
): ReportingAvailability {
  if (missingCount === 0) return 'available';
  const stated = a.availability !== 'unavailable' || b.availability !== 'unavailable';
  return stated ? 'partial' : 'unavailable';
}

/** An exact zero in the reporting currency: no activity, and nothing missing. */
export function emptyAmount(reporting: CurrencyCode): ReportingAmount {
  return {
    value: money(new Decimal(0), reporting),
    availability: 'available',
    missing: [],
    statedCount: 0,
    provenance: EXACT_PROVENANCE,
  };
}

export function statedAmount(
  value: Money,
  provenance: FxProvenance,
  quality?: ContributionQuality,
): ReportingAmount {
  return {
    value,
    availability: 'available',
    missing: [],
    statedCount: 1,
    ...(quality === undefined ? {} : { quality }),
    provenance,
  };
}

export function missingAmount(
  reporting: CurrencyCode,
  missing: MissingReportingContribution,
): ReportingAmount {
  return {
    value: money(new Decimal(0), reporting),
    availability: 'unavailable',
    missing: [missing],
    statedCount: 0,
    provenance: EXACT_PROVENANCE,
  };
}

/**
 * Everything two aggregates know between them, apart from the value and the
 * availability: missing dependencies union, contribution counts add, the worse
 * quality wins, the provenances merge.
 *
 * `statedCount` keeps meaning exactly what it has always meant — how many
 * primitive monetary contributions are inside `value` — and is never nudged to
 * steer an availability. How many rows a figure is made of and whether a
 * formula's operand is stated are two different questions, which is why the two
 * rules above are two functions.
 */
function mergeEvidence(
  a: ReportingAmount,
  b: ReportingAmount,
): Omit<ReportingAmount, 'value' | 'availability'> {
  const quality = worseQuality(a.quality, b.quality);
  return {
    missing: mergeMissing(a.missing, b.missing),
    statedCount: a.statedCount + b.statedCount,
    ...(quality === undefined ? {} : { quality }),
    provenance: mergeProvenance(a.provenance, b.provenance),
  };
}

/** One step of a 12.5 formula, over two figures that were already evaluated. */
function combine(
  a: ReportingAmount,
  b: ReportingAmount,
  value: Money,
): ReportingAmount {
  const evidence = mergeEvidence(a, b);
  return {
    value,
    availability: composedAvailability(a, b, evidence.missing.length),
    ...evidence,
  };
}

/** One more contribution inside a primitive figure's own sum. */
function addContribution(a: ReportingAmount, b: ReportingAmount): ReportingAmount {
  const evidence = mergeEvidence(a, b);
  return {
    value: add(a.value, b.value),
    availability: summedAvailability(evidence.statedCount, evidence.missing.length),
    ...evidence,
  };
}

/** `a + b` as a 12.5 formula, carrying both sides' missing dependencies. */
export function addAmounts(a: ReportingAmount, b: ReportingAmount): ReportingAmount {
  return combine(a, b, add(a.value, b.value));
}

/**
 * `a − b`.
 *
 * The subtrahend's missing dependencies are the difference's too: a figure
 * cannot be complete while something it subtracts is unknown.
 */
export function subtractAmounts(a: ReportingAmount, b: ReportingAmount): ReportingAmount {
  return combine(a, b, sub(a.value, b.value));
}

/**
 * Sum one primitive figure's contributions, left to right, so the same inputs
 * give the same string.
 *
 * Deliberately not `addAmounts`: the seed is an empty sum, not a stated operand.
 * A figure whose only contribution could not be converted is therefore
 * unavailable rather than partial at zero — it has nothing of its own to state,
 * where a formula built on it still has whatever its other operands said.
 */
export function sumAmountsOf(
  parts: readonly ReportingAmount[],
  reporting: CurrencyCode,
): ReportingAmount {
  return parts.reduce(addContribution, emptyAmount(reporting));
}
