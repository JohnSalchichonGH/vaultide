/**
 * Position kinds and the net-worth sign (blueprint 7.8).
 *
 * `finance` is pure and may not import `@vaultide/validation` (section 19), so
 * the kind literals are declared here; a consistency test in
 * `@vaultide/application` — the one package allowed to see both — asserts that
 * this list and the validation/database enum stay identical.
 */

export const POSITION_KINDS = [
  'cash',
  'investment',
  'property',
  'other_asset',
  'liability',
] as const;

export type PositionKind = (typeof POSITION_KINDS)[number];

export function isPositionKind(value: string): value is PositionKind {
  return (POSITION_KINDS as readonly string[]).includes(value);
}

/**
 * Assets count `+1`, liabilities `−1`. Every generic aggregation and
 * decomposition multiplies by this, which is what makes loan proceeds and
 * principal repayments provably net-worth neutral (7.8) rather than a
 * special case someone has to remember.
 */
export const netWorthSign = (kind: PositionKind): 1 | -1 => (kind === 'liability' ? -1 : 1);
