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
