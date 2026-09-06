import DecimalJs from 'decimal.js';
import type { Numeric } from './backend';

/**
 * Deterministic backend: decimal.js at 28 significant digits (blueprint 13.1),
 * cloned so the projection engine's configuration is independent of the domain
 * layer's 40-digit Decimal and of any third-party change.
 */
const ProjectionDecimal = DecimalJs.clone({
  precision: 28,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export type ProjectionDecimal = InstanceType<typeof ProjectionDecimal>;

export const DecimalBackend: Numeric<ProjectionDecimal> = {
  id: 'decimal',
  from: (value) => new ProjectionDecimal(value),
  add: (a, b) => a.plus(b),
  sub: (a, b) => a.minus(b),
  mul: (a, b) => a.times(b),
  div: (a, b) => a.dividedBy(b),
  pow: (base, exponent) => base.pow(exponent),
  cmp: (a, b) => a.comparedTo(b) as -1 | 0 | 1,
  min: (a, b) => (a.lessThanOrEqualTo(b) ? a : b),
  max: (a, b) => (a.greaterThanOrEqualTo(b) ? a : b),
  round: (value, decimals) => value.toDecimalPlaces(decimals, DecimalJs.ROUND_HALF_UP),
  toDecimalString: (value) => value.toFixed(),
};
