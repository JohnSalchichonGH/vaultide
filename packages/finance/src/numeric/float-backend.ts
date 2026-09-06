import type { Numeric } from './backend';

/**
 * IEEE-754 backend for Monte Carlo paths (blueprint 13.1). Never used for
 * authoritative money: its results are distributions, and the deterministic run
 * shown beside them always comes from `DecimalBackend`.
 */
export const FloatBackend: Numeric<number> = {
  id: 'float',
  from: (input) => (typeof input === 'number' ? input : Number.parseFloat(input)),
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  pow: (base, exponent) => Math.pow(base, exponent),
  cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  round: (value, decimals) => {
    // Half-up away from zero, applied on the scaled value.
    const factor = Math.pow(10, decimals);
    const scaled = value * factor;
    const rounded = value < 0 ? -Math.round(-scaled) : Math.round(scaled);
    return rounded / factor;
  },
  toDecimalString: (value) => {
    if (!Number.isFinite(value)) return String(value);
    // 15 significant digits is the most a double can claim honestly.
    return Number.parseFloat(value.toPrecision(15)).toString();
  },
};
