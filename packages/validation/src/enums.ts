/**
 * Closed sets shared by the database enums, the Zod schemas and the UI
 * (blueprint 6.1, D48). Every value here becomes a PostgreSQL enum value; new
 * values are added additively and never renamed in place.
 *
 * Phase 0 declares only the sets Phase 0 uses. Later phases extend this file as
 * their tables land.
 */

/** Position kinds (6.2 `positions.kind`). Mirrored in @vaultide/finance, which
 *  is pure and may not import this package; a consistency test in
 *  @vaultide/application asserts the two lists stay identical. */
export const positionKinds = ['cash', 'investment', 'property', 'other_asset', 'liability'] as const;
export type PositionKind = (typeof positionKinds)[number];

/** Valuation date precision (6.2 `position_valuations.date_precision`, R15). */
export const datePrecisions = ['exact', 'month_end'] as const;
export type DatePrecision = (typeof datePrecisions)[number];

/**
 * Category kinds (6.2 `categories.kind`). The kind fixes the accounting
 * semantics of every expense filed under a category; the name is the user's own
 * organization (T5, D25).
 */
export const consumptionCategoryKinds = [
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

/**
 * The seven system kinds (6.2). Each is non-consumption: it is a cost, a
 * capital movement or an outflow that leaves the tracked system, and each is
 * counted in exactly one bucket of the decomposition (7.4, R2). Exactly one
 * category of each kind is created per user at sign-up and none can be
 * archived — the engines rely on them existing.
 */
export const systemCategoryKinds = [
  'property_operating',
  'investment_fee',
  'transfer_fee',
  'acquisition_cost',
  'disposal_cost',
  'capital_improvement',
  'external_outflow',
] as const;

export const categoryKinds = [...consumptionCategoryKinds, ...systemCategoryKinds] as const;

export type ConsumptionCategoryKind = (typeof consumptionCategoryKinds)[number];
export type SystemCategoryKind = (typeof systemCategoryKinds)[number];
export type CategoryKind = (typeof categoryKinds)[number];

export function isSystemCategoryKind(value: string): value is SystemCategoryKind {
  return (systemCategoryKinds as readonly string[]).includes(value);
}

/**
 * Position lifecycle (6.2 `positions.status`). A position is `archived` or
 * `closed`, never deleted once it has history (R12, 6.3).
 */
export const positionStatuses = ['active', 'closed', 'archived'] as const;
export type PositionStatus = (typeof positionStatuses)[number];

/** 6.2 `cash_accounts.account_type`. `brokerage_cash` is a cash account too. */
export const cashAccountTypes = ['checking', 'savings', 'cash', 'brokerage_cash', 'other'] as const;
export type CashAccountType = (typeof cashAccountTypes)[number];

/** 6.2 `other_assets.asset_type`. */
export const otherAssetTypes = [
  'vehicle',
  'collectible',
  'private_equity',
  'equipment',
  'receivable',
  'custom',
] as const;
export type OtherAssetType = (typeof otherAssetTypes)[number];

/**
 * 6.2 `position_valuations.source` — how a valuation came to exist.
 *
 * The distinction is not decoration: `confirmed_unchanged` is the explicit
 * per-month confirmation of R22, `accepted_expected` marks a liability balance
 * taken from a schedule rather than a statement (R9, Phase 5), and `purchase`
 * is the valuation written with an asset purchase (11.1, Phase 6). Phase 2
 * writes `entered`, `confirmed_unchanged` and `bulk_entered`.
 */
export const valuationSources = [
  'entered',
  'confirmed_unchanged',
  'accepted_expected',
  'purchase',
  'imported',
  'bulk_entered',
] as const;
export type ValuationSource = (typeof valuationSources)[number];

/** 6.2 `audit_entries.action` (18.1). */
export const auditActions = ['insert', 'update', 'delete'] as const;
export type AuditAction = (typeof auditActions)[number];
