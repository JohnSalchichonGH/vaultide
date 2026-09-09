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
 * The one availability rule, applied wherever a figure is built or combined.
 *
 * Nothing missing is available — including a figure with no contributions at
 * all, whose exact sum is zero. That is an answer: no such record exists. Some
 * missing and something stated is partial. Some missing and nothing stated is
 * unavailable.
 */
function availabilityOf(statedCount: number, missingCount: number): ReportingAvailability {
  if (missingCount === 0) return 'available';
  return statedCount === 0 ? 'unavailable' : 'partial';
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

function combine(
  a: ReportingAmount,
  b: ReportingAmount,
  value: Money,
): ReportingAmount {
  const missing = mergeMissing(a.missing, b.missing);
  const statedCount = a.statedCount + b.statedCount;
  const quality = worseQuality(a.quality, b.quality);
  return {
    value,
    availability: availabilityOf(statedCount, missing.length),
    missing,
    statedCount,
    ...(quality === undefined ? {} : { quality }),
    provenance: mergeProvenance(a.provenance, b.provenance),
  };
}

/** `a + b`, carrying both sides' missing dependencies and provenance. */
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

/** Sum a list, left to right, so the same inputs give the same string. */
export function sumAmountsOf(
  parts: readonly ReportingAmount[],
  reporting: CurrencyCode,
): ReportingAmount {
  return parts.reduce(addAmounts, emptyAmount(reporting));
}
