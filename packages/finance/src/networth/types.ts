import type { PlainDate } from '../dates/plain-date';
import type { CurrencyCode, Money } from '../money/types';
import type { UnavailableReason } from '../unavailable';
import type { PositionValue } from '../positions/valuation';
import type { PositionKind } from '../positions/sign';

/**
 * The net-worth result model (blueprint 12.1, 7.6, 16.2).
 *
 * Designed so the interface never has to guess. Every figure arrives with its
 * availability, the exact list of what is missing and why, and the native
 * amounts behind it — so a page can render "€12,400 + $3,000 not converted"
 * rather than a confident number that quietly dropped the dollars.
 */

/**
 * How complete a figure is (7.6, 10.5).
 *
 *  - `available` — every contributing position was valued and converted.
 *  - `partial` — some were, some were not. The value is the sum of what could
 *    be established; `missing` says what is not in it.
 *  - `unavailable` — nothing could be established. The value is not shown at
 *    all; the interface renders `—`, never `0` (16.2).
 */
export type Availability = 'available' | 'partial' | 'unavailable';

export interface MissingContribution {
  readonly positionId: string;
  readonly positionName: string;
  readonly kind: PositionKind;
  readonly reason: UnavailableReason;
  readonly detail?: string;
  /** The native amount, when it is known and only the conversion failed. */
  readonly native?: Money;
}

/**
 * A converted aggregate. `value` is exact and unrounded; rounding happens at
 * display (7.3).
 */
export interface MoneyAggregate {
  readonly value: Money;
  readonly availability: Availability;
  /** Positions whose contribution is not inside `value`, and why. */
  readonly missing: readonly MissingContribution[];
  /** How many positions did contribute. */
  readonly contributingCount: number;
  /** Exact native totals per currency, before any conversion. */
  readonly native: readonly Money[];
}

/** One position, valued natively and converted into the reporting currency. */
export interface PositionContribution {
  readonly value: PositionValue;
  /** Assets `+1`, liabilities `−1` (7.8, R25). */
  readonly sign: 1 | -1;
  /**
   * Signed value in the reporting currency, or `undefined` when it could not be
   * produced. Never a zero standing in for a failed conversion.
   */
  readonly reporting?: Money;
  /** The rate used, its date and its publisher — the evidence for the number. */
  readonly rate?: { readonly rate: string; readonly rateDate: PlainDate; readonly source: string; readonly exact: boolean };
  /** `false` for an other asset excluded from financial net worth (M15, R18). */
  readonly inFinancialNetWorth: boolean;
  readonly unavailableReason?: UnavailableReason;
  readonly unavailableDetail?: string;
}

export interface NetWorthComponents {
  /** Σ cash positions (12.1 "Cash & savings"). */
  readonly cash: MoneyAggregate;
  /** Σ other assets the user includes in financial net worth. */
  readonly otherAssetsIncluded: MoneyAggregate;
  /** Σ other assets the user excludes — a memo line, still in total net worth. */
  readonly otherAssetsExcluded: MoneyAggregate;
}

export interface NetWorthResult {
  readonly asOf: PlainDate;
  readonly reportingCurrency: CurrencyCode;
  readonly positions: readonly PositionContribution[];
  readonly components: NetWorthComponents;
  /**
   * All tracked assets − all tracked liabilities (R18). No preference can
   * remove anything from this figure.
   */
  readonly totalNetWorth: MoneyAggregate;
  /**
   * The headline: total net worth minus the other assets the user excludes
   * (12.1). Liabilities are never excludable.
   */
  readonly financialNetWorth: MoneyAggregate;
  /** `true` when the two metrics differ, so the UI knows to show both (15.4). */
  readonly metricsDiffer: boolean;
}

export interface NetWorthSeriesPoint {
  readonly asOf: PlainDate;
  /** `true` for the current month's point, which is not a month end (15.4). */
  readonly provisional: boolean;
  readonly totalNetWorth: MoneyAggregate;
  readonly financialNetWorth: MoneyAggregate;
}
