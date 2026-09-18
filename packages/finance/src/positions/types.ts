import type { Decimal } from '../decimal';
import type { PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import type { PositionKind } from './sign';

/**
 * The records the position engines take (blueprint 6.2, 12.1).
 *
 * Pure data, already loaded. `finance` performs no IO and does not know a
 * database exists; the application layer maps rows onto these shapes and hands
 * them in. Amounts are `Decimal` in the position's own **native** currency —
 * the authoritative representation. Nothing here holds a reporting-currency
 * value, because a reporting value is derived at read time and is never stored
 * (M10, T8).
 */

export type PositionStatus = 'active' | 'closed' | 'archived';

export type ValuationSource =
  | 'entered'
  | 'confirmed_unchanged'
  | 'accepted_expected'
  | 'purchase'
  | 'imported'
  | 'bulk_entered';

/**
 * `exact` — a snapshot on that day. `month_end` — the balance at the end of
 * that month, as read from a statement (T3, R15). Only a `month_end` valuation
 * closes a month for reconciliation; an ordinary snapshot dated the last day of
 * the month does not (8.8).
 */
export type DatePrecision = 'exact' | 'month_end';

export interface ValuationRecord {
  readonly id: string;
  readonly positionId: string;
  readonly valuedOn: PlainDate;
  /** Native currency, exact. The currency is the position's (R4). */
  readonly amount: Decimal;
  readonly source: ValuationSource;
  readonly datePrecision: DatePrecision;
}

export interface PositionRecord {
  readonly id: string;
  readonly kind: PositionKind;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly status: PositionStatus;
  /**
   * When the position opened, if known. NULL means "it already existed and I am
   * starting to track it now" — a different fact, and the engines treat them
   * differently (8.1, 12.3).
   */
  readonly openedOn: PlainDate | null;
  readonly closedOn: PlainDate | null;
  /**
   * Cash only: the account is dormant **now** (R22, 8.8). Present-tense, and
   * therefore not evidence about any earlier date; the engines read
   * `dormantFrom` for that.
   */
  readonly isDormant?: boolean;
  /**
   * Cash only: where the current dormant episode starts — the date of the zero
   * balance that justified it, absent when the account is not dormant (8.8,
   * v2.1.17 30.20). A structural zero is permitted only on or after it.
   */
  readonly dormantFrom?: PlainDate;
  /**
   * Other assets only, and **the only inclusion preference that exists**
   * (M15, R18). It moves an asset in and out of *financial* net worth. It can
   * never remove it from *total* net worth, and it exists on no other kind.
   */
  readonly includeInFinancialNetWorth?: boolean;
}

/** Positions plus their valuations, as the engines consume them. */
export interface PositionWithValuations {
  readonly position: PositionRecord;
  /** Any order: every engine sorts what it needs (order-independence is tested). */
  readonly valuations: readonly ValuationRecord[];
}
