/**
 * Numeric backends (blueprint 13.1).
 *
 * The projection engine is written against this ten-method arithmetic surface
 * so one engine serves both runs: `DecimalBackend` (exact, deterministic runs)
 * and `FloatBackend` (IEEE-754, fast enough for Monte Carlo paths). A golden
 * agreement test runs deterministic fixtures on both backends and asserts
 * month-by-month agreement within 0.01 units.
 *
 * Money never uses `FloatBackend` for authoritative values; it exists only for
 * stochastic path generation, whose results are percentiles, not ledger
 * entries.
 */
export interface NumericBackend<N> {
  readonly id: string;

  from(value: string | number): N;
  add(a: N, b: N): N;
  sub(a: N, b: N): N;
  mul(a: N, b: N): N;
  div(a: N, b: N): N;
  pow(base: N, exponent: N): N;
  cmp(a: N, b: N): -1 | 0 | 1;
  min(a: N, b: N): N;
  max(a: N, b: N): N;
  round(value: N, decimals: number): N;
}

/**
 * Reading a backend value back out as an exact decimal string. Kept separate
 * from the ten arithmetic methods above so the engine's arithmetic surface
 * stays exactly the one the blueprint specifies.
 */
export interface NumericCodec<N> {
  toDecimalString(value: N): string;
}

export type Numeric<N> = NumericBackend<N> & NumericCodec<N>;
