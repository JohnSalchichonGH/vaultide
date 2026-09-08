import type { Decimal } from '../decimal';
import type { PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';

/**
 * The flow records the Phase 3 engines take (blueprint 6.2, 7.4).
 *
 * Pure data, already loaded and already in **native** currency. `finance` does
 * not know a database exists; the application layer maps rows onto these
 * shapes. Nothing here carries a reporting-currency value, because a reporting
 * value is derived at read time and never stored (M10, T8).
 *
 * `finance` may not import `@vaultide/validation` (section 19), so the closed
 * sets are declared here and a consistency test in `@vaultide/application` —
 * the one package allowed to see both — asserts they stay identical.
 */

export const INCOME_KINDS = [
  'employment',
  'rental',
  'interest',
  'dividend',
  'freelance',
  'bonus',
  'other',
  'external_inflow',
  'adjustment',
] as const;
export type IncomeKind = (typeof INCOME_KINDS)[number];

export const INCOME_SETTLEMENTS = ['tracked_cash', 'reinvested', 'external'] as const;
export type IncomeSettlement = (typeof INCOME_SETTLEMENTS)[number];

export const EXPENSE_SETTLEMENTS = [
  'tracked_cash',
  'untracked_self',
  'third_party',
  'deducted_from_asset',
] as const;
export type ExpenseSettlement = (typeof EXPENSE_SETTLEMENTS)[number];

export const TRANSFER_KINDS = [
  'cash_transfer',
  'contribution',
  'withdrawal',
  'investment_switch',
  'loan_proceeds',
  'financed_purchase',
  'asset_purchase',
  'asset_sale',
] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * The category kinds whose accounting meaning differs from ordinary
 * consumption (7.4). The kind, not the name, is what decides the bucket.
 */
export const CONSUMPTION_CATEGORY_KINDS = [
  'general',
  'housing',
  'transport',
  'food',
  'travel',
  'health',
  'insurance',
  'tax',
  'subscriptions',
  'maintenance',
  'major_purchase',
  'custom',
] as const;
export const SYSTEM_CATEGORY_KINDS = [
  'property_operating',
  'investment_fee',
  'transfer_fee',
  'acquisition_cost',
  'disposal_cost',
  'capital_improvement',
  'external_outflow',
] as const;
export const CATEGORY_KINDS = [
  ...CONSUMPTION_CATEGORY_KINDS,
  ...SYSTEM_CATEGORY_KINDS,
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface IncomeFlow {
  readonly id: string;
  readonly kind: IncomeKind;
  /** The financial date — when the money arrived. */
  readonly receivedOn: PlainDate;
  readonly netAmount: Decimal;
  readonly currency: CurrencyCode;
  readonly settlement: IncomeSettlement;
  /** `null` is a tracked flow awaiting attribution, never an untracked one (8.1). */
  readonly cashPositionId: string | null;
  readonly investmentPositionId?: string | null;
}

export interface ExpenseFlow {
  readonly id: string;
  readonly categoryKind: CategoryKind;
  /** The financial date — when the money left. */
  readonly incurredOn: PlainDate;
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  readonly settlement: ExpenseSettlement;
  readonly cashPositionId: string | null;
  /** Set on the one expense row that represents a transfer's fee (M14). */
  readonly transferId?: string | null;
}

export interface TransferFlow {
  readonly id: string;
  readonly kind: TransferKind;
  readonly occurredOn: PlainDate;
  readonly fromPositionId: string | null;
  readonly fromCurrency: CurrencyCode;
  readonly fromAmount: Decimal;
  readonly toPositionId: string | null;
  readonly toCurrency: CurrencyCode;
  readonly toAmount: Decimal;
}
