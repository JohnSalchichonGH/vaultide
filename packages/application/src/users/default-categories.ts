import { systemCategoryKinds, type CategoryKind } from '@vaultide/validation';

/**
 * The categories every account starts with (blueprint 6.2, T5, D25).
 *
 * Categories are **copied per user at sign-up**, not shared globally: RLS then
 * covers them like everything else, and a user may rename or archive their own
 * without touching anybody else's. The cost is that changing this list does not
 * propagate to existing accounts, which is the intended trade (D25).
 *
 * Two groups:
 *
 *  - **consumption** categories are ordinary spending, and exist only so the
 *    first expense a user records has somewhere sensible to go. They can be
 *    renamed, archived and added to freely.
 *  - the seven **system** categories carry non-consumption accounting semantics
 *    (7.4): a property operating cost, an investment fee, a transfer fee, an
 *    acquisition or disposal cost, a capital improvement and an outflow that
 *    leaves the tracked system each land in exactly one bucket of the
 *    decomposition. Exactly one of each is created, and none can be archived —
 *    the engines from Phase 3 onward rely on them existing.
 */

export interface DefaultCategory {
  readonly kind: CategoryKind;
  readonly name: string;
  readonly groupName: string | null;
  readonly sortOrder: number;
}

const CONSUMPTION: readonly [CategoryKind, string, string][] = [
  ['housing', 'Rent & mortgage costs', 'Home'],
  ['housing', 'Utilities', 'Home'],
  ['maintenance', 'Home maintenance', 'Home'],
  ['food', 'Groceries', 'Everyday'],
  ['food', 'Eating out', 'Everyday'],
  ['transport', 'Transport', 'Everyday'],
  ['subscriptions', 'Subscriptions', 'Everyday'],
  ['general', 'Shopping', 'Everyday'],
  ['health', 'Health', 'Wellbeing'],
  ['insurance', 'Insurance', 'Wellbeing'],
  ['travel', 'Travel', 'Discretionary'],
  ['major_purchase', 'Major purchase', 'Discretionary'],
  ['tax', 'Tax paid', 'Obligations'],
  ['general', 'Other', 'Other'],
];

/**
 * One per system kind. The names are the user-facing labels of 7.4 and 15.2,
 * chosen to say what the category *means* for the accounting rather than to
 * name the mechanism.
 */
const SYSTEM: Readonly<Record<(typeof systemCategoryKinds)[number], string>> = {
  property_operating: 'Property operating costs',
  investment_fee: 'Investment fees',
  transfer_fee: 'Transfer fees',
  acquisition_cost: 'Acquisition costs',
  disposal_cost: 'Disposal costs',
  capital_improvement: 'Capital improvements',
  external_outflow: 'Money out of tracked accounts',
};

export const defaultCategories: readonly DefaultCategory[] = [
  ...CONSUMPTION.map(([kind, name, groupName], index) => ({
    kind,
    name,
    groupName,
    sortOrder: index * 10,
  })),
  ...systemCategoryKinds.map((kind, index) => ({
    kind,
    name: SYSTEM[kind],
    groupName: 'System',
    sortOrder: 1000 + index * 10,
  })),
];

/** The tag list a new account starts with: empty. Tags are the user's own words. */
export const defaultTags: readonly string[] = [];

/** Every system category a provisioned account must have (asserted in tests). */
export const requiredSystemCategoryKinds = systemCategoryKinds;
