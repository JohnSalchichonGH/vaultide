import type { MoneyDto } from '@vaultide/finance';

/**
 * Phase 2 DTOs (blueprint 4.2, 7.1).
 *
 * Plain, serializable objects: strings, numbers, booleans. Money crosses the
 * server/client boundary as `{ amount: "8055.00", currency: "EUR" }` — an exact
 * decimal string, never a JavaScript number and never a `Decimal`.
 *
 * The interface consumes these; it does not reconstruct financial meaning from
 * them. Freshness, availability, what is missing and why are all decided by the
 * domain and carried here, so a page never has to infer "is this stale?" from a
 * timestamp or "is this complete?" from a count.
 */

export type PositionKindDto = 'cash' | 'investment' | 'property' | 'other_asset' | 'liability';
export type PositionStatusDto = 'active' | 'closed' | 'archived';
export type DatePrecisionDto = 'exact' | 'month_end';

export type ValueStateDto =
  | 'exact'
  | 'carried'
  | 'opened_zero'
  | 'closed'
  | 'not_yet_tracked'
  | 'missing';

export type AvailabilityDto = 'available' | 'partial' | 'unavailable';

export interface RateEvidenceDto {
  readonly rate: string;
  readonly rateDate: string;
  readonly source: string;
  /** `false` when the rate is the nearest earlier one — a weekend, say (10.2). */
  readonly exact: boolean;
}

/** What a position was worth at the as-of date, and how well that is known. */
export interface PositionValueDto {
  readonly state: ValueStateDto;
  /** Native and authoritative. `null` only when the state is `missing`. */
  readonly native: MoneyDto | null;
  readonly valuedOn: string | null;
  readonly ageDays: number | null;
  readonly ageMonths: number | null;
  /** Whether the value came from a statement month-end balance (R15). */
  readonly fromMonthEnd: boolean;
  /** In the reporting currency. `null` when no rate could value it (10.5). */
  readonly reporting: MoneyDto | null;
  readonly rate: RateEvidenceDto | null;
  readonly unavailableReason: string | null;
  readonly unavailableDetail: string | null;
}

/** The cash-account states of 8.1 for one month. */
export interface CashMonthStateDto {
  readonly month: string;
  readonly open: string;
  readonly close: string;
  readonly included: boolean;
  /** Pre-existing account first tracked in this month (8.1, R5). */
  readonly firstBalance: boolean;
  /** The month's statement balance, when one exists. */
  readonly monthEnd: { readonly valuationId: string; readonly amount: MoneyDto } | null;
  /**
   * An ordinary snapshot dated the month's last day, which can be confirmed as
   * the statement balance now that the month has ended (8.1, R15).
   */
  readonly confirmable: { readonly valuationId: string; readonly amount: MoneyDto; readonly version: number } | null;
}

export interface PositionDto {
  readonly id: string;
  readonly kind: PositionKindDto;
  readonly name: string;
  readonly currency: string;
  readonly minorUnits: number;
  readonly status: PositionStatusDto;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly notes: string | null;
  readonly version: number;
  /** Cash accounts. */
  readonly accountType: string | null;
  readonly institution: string | null;
  readonly isDormant: boolean | null;
  /** Other assets. */
  readonly assetType: string | null;
  readonly acquisitionDate: string | null;
  readonly acquisitionValue: MoneyDto | null;
  /** The only inclusion preference there is (M15, R18). `null` for other kinds. */
  readonly includeInFinancialNetWorth: boolean | null;
  readonly value: PositionValueDto;
  /** Present for cash accounts: the state of the last completed month. */
  readonly lastCompletedMonth: CashMonthStateDto | null;
  /** How many valuations exist — whether the position may still be deleted (6.3). */
  readonly valuationCount: number;
}

export interface MissingContributionDto {
  readonly positionId: string;
  readonly positionName: string;
  readonly kind: PositionKindDto;
  readonly reason: string;
  readonly detail: string | null;
  readonly native: MoneyDto | null;
}

export interface AggregateDto {
  /** `null` when nothing could be established: the UI renders `—`, never `0`. */
  readonly value: MoneyDto | null;
  readonly availability: AvailabilityDto;
  readonly missing: readonly MissingContributionDto[];
  readonly contributingCount: number;
  /** Exact native totals per currency, before any conversion. */
  readonly native: readonly MoneyDto[];
}

export interface NetWorthPointDto {
  readonly asOf: string;
  readonly provisional: boolean;
  readonly totalNetWorth: AggregateDto;
  readonly financialNetWorth: AggregateDto;
}

export interface NetWorthDto {
  readonly asOf: string;
  readonly reportingCurrency: string;
  readonly minorUnits: number;
  /**
   * Minor units per currency code, so a native breakdown formats JPY with no
   * decimals and CLF with four — the exact formatter needs the currency's own
   * scale, not the reporting currency's (7.2, 7.1.1).
   */
  readonly minorUnitsByCurrency: Record<string, number>;
  readonly totalNetWorth: AggregateDto;
  readonly financialNetWorth: AggregateDto;
  /** `true` when the two metrics differ, so the UI shows both (15.4). */
  readonly metricsDiffer: boolean;
  readonly components: {
    readonly cash: AggregateDto;
    readonly otherAssetsIncluded: AggregateDto;
    readonly otherAssetsExcluded: AggregateDto;
  };
  readonly positions: readonly PositionDto[];
  readonly series: readonly NetWorthPointDto[];
  /**
   * Change since the previous completed month end, per metric. `null` when
   * either end is not fully available: a delta between two partial numbers is
   * not a delta.
   */
  readonly changeSinceLastMonthEnd: {
    readonly from: string;
    readonly total: MoneyDto | null;
    readonly financial: MoneyDto | null;
  } | null;
  /** How many cash accounts have a valuation dated inside the current month. */
  readonly currentMonth: {
    readonly month: string;
    readonly updatedAccounts: number;
    readonly totalAccounts: number;
    readonly endsOn: string;
  };
}

export interface ValuationDto {
  readonly id: string;
  readonly positionId: string;
  readonly valuedOn: string;
  readonly amount: MoneyDto;
  readonly source: string;
  readonly datePrecision: DatePrecisionDto;
  readonly note: string | null;
  readonly version: number;
  /** The reporting value at the valuation's own date, for the history table. */
  readonly reporting: MoneyDto | null;
}

export interface PositionDetailDto {
  readonly position: PositionDto;
  readonly valuations: readonly ValuationDto[];
  readonly reportingCurrency: string;
  readonly reportingMinorUnits: number;
  readonly minorUnitsByCurrency: Record<string, number>;
  /** Months that could be closed but have no statement balance yet (8.1). */
  readonly monthsAwaitingStatement: readonly CashMonthStateDto[];
}
