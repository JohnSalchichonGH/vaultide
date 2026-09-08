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

/**
 * Recurring template kinds (6.2 `recurring_templates.kind`).
 *
 * `contribution` exists because 6.2's enum is a closed set and Phase 4 owns the
 * workflow; Phase 3 creates no contribution template and materializes none.
 */
export const templateKinds = ['income', 'expense', 'contribution'] as const;
export type TemplateKind = (typeof templateKinds)[number];

/**
 * Income kinds (6.2 `income_entries.kind`, `recurring_templates.income_kind`).
 *
 * The first seven are ordinary income. `external_inflow` explains money that
 * entered the tracked balance sheet without being income, and `adjustment` is
 * what "Accept as adjustment" writes against an unexplained inflow (8.5).
 * Neither may be a template (6.2 CHECK).
 */
export const ordinaryIncomeKinds = [
  'employment',
  'rental',
  'interest',
  'dividend',
  'freelance',
  'bonus',
  'other',
] as const;
export const specialIncomeKinds = ['external_inflow', 'adjustment'] as const;
export const incomeKinds = [...ordinaryIncomeKinds, ...specialIncomeKinds] as const;
export type OrdinaryIncomeKind = (typeof ordinaryIncomeKinds)[number];
export type IncomeKind = (typeof incomeKinds)[number];

/** 6.2 `recurring_templates.frequency`. */
export const recurrenceFrequencies = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

/** 6.2 `income_entries.settlement` (7.4, F5). */
export const incomeSettlements = ['tracked_cash', 'reinvested', 'external'] as const;
export type IncomeSettlement = (typeof incomeSettlements)[number];

/** 6.2 `expense_entries.settlement` (7.4, R24). */
export const expenseSettlements = [
  'tracked_cash',
  'untracked_self',
  'third_party',
  'deducted_from_asset',
] as const;
export type ExpenseSettlement = (typeof expenseSettlements)[number];

/** 6.2 `recurring_template_skips.reason` (F18, 11.2). */
export const skipReasons = ['skipped', 'vacant', 'non_payment', 'other'] as const;
export type SkipReason = (typeof skipReasons)[number];

/** Only a rental template can record an occupancy fact (6.2, F18). */
export const rentalOnlySkipReasons = ['vacant', 'non_payment'] as const;

export function isRentalOnlySkipReason(value: string): boolean {
  return (rentalOnlySkipReasons as readonly string[]).includes(value);
}

/** 6.2 `transfers.kind` (7.5). Phase 3 services accept `cash_transfer` only. */
export const transferKinds = [
  'cash_transfer',
  'contribution',
  'withdrawal',
  'investment_switch',
  'loan_proceeds',
  'financed_purchase',
  'asset_purchase',
  'asset_sale',
] as const;
export type TransferKind = (typeof transferKinds)[number];

/**
 * What Phase 3 may actually write, as opposed to what the closed sets contain
 * (v2.1.6 §30.9, blueprint 7.4 and §25 Phase 3).
 *
 * These are **phase** restrictions over unchanged enums, so the phase that owns
 * the missing workflow lifts one by widening a list here — never by a
 * migration. Each is enforced in `validation` and again in the domain service.
 */

/** `reinvested` needs an investment position, which Phase 3 has not got. */
export const phase3IncomeSettlements = ['tracked_cash', 'external'] as const;

/**
 * `external` is accepted only for the five ordinary kinds 7.4 actually covers.
 *
 * 7.4 defines `external` twice, and neither row fits a Phase 3 dividend or
 * interest: ordinary external income names employment, freelance, bonus, rental
 * and other, while an externally paid *distribution* is defined only when it is
 * linked to an investment, where it keeps the investment-performance credit and
 * pairs with an equal external outflow. Phase 3 has no investment positions, so
 * every `dividend`/`interest` row it could write with `settlement = external`
 * would be the case the matrix does not cover. Phase 4 lifts this together with
 * the link that gives such a row meaning.
 */
export const phase3ExternalIncomeKinds = [
  'employment',
  'freelance',
  'bonus',
  'rental',
  'other',
] as const;

/** `deducted_from_asset` needs an investment position (Phase 4). */
export const phase3ExpenseSettlements = ['tracked_cash', 'untracked_self', 'third_party'] as const;

/** Phase 3 application behaviour exposes exactly one transfer kind (§25). */
export const phase3TransferKinds = ['cash_transfer'] as const;

/**
 * `external_inflow` and `adjustment` exist to explain **tracked** cash, so an
 * external one could not affect the discrepancy it was created for.
 */
export function allowedIncomeSettlements(kind: IncomeKind): readonly IncomeSettlement[] {
  if ((specialIncomeKinds as readonly string[]).includes(kind)) return ['tracked_cash'];
  return (phase3ExternalIncomeKinds as readonly string[]).includes(kind)
    ? ['tracked_cash', 'external']
    : ['tracked_cash'];
}
