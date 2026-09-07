/**
 * The FX provider boundary (blueprint 10.1).
 *
 * `packages/finance` is pure and never performs IO; everything that talks to a
 * rate publisher lives here, behind one small interface. The integration suite
 * substitutes a stub for it, which is how gap filling, provider failure and
 * idempotence are tested without a network (21.3).
 */

/** One published reference rate: `1 EUR = rate <quote>` on `rateDate`. */
export interface ProviderRateRow {
  readonly quote: string;
  /** ISO `YYYY-MM-DD`. */
  readonly rateDate: string;
  /**
   * The rate as an exact decimal **string**, carrying the publisher's own
   * digits. Never a JavaScript number: `fx_rates.rate` is `NUMERIC(24,12)`, and
   * a float cannot be trusted to reproduce twelve decimals (7.1, R31).
   */
  readonly rate: string;
  /** Which publisher stands behind the row, e.g. `ecb`. */
  readonly source: string;
}

export interface FxProvider {
  readonly id: string;
  /** The currencies this provider publishes rates for, as ISO codes. */
  supportedCurrencies(): Promise<string[]>;
  /** Every rate for `quotes` in `[from, to]`, in one call. */
  fetchTimeSeries(
    base: 'EUR',
    quotes: readonly string[],
    from: string,
    to: string,
  ): Promise<ProviderRateRow[]>;
  /** The most recent published rates for `quotes`. */
  fetchLatest(base: 'EUR', quotes: readonly string[]): Promise<ProviderRateRow[]>;
}

export class FxProviderError extends Error {
  readonly code = 'FX_PROVIDER_FAILURE';
  constructor(
    readonly providerId: string,
    readonly status: number | undefined,
    detail?: string,
  ) {
    super(
      status === undefined
        ? `The ${providerId} rate provider could not be reached${detail === undefined ? '' : `: ${detail}`}.`
        : `The ${providerId} rate provider answered ${String(status)}.`,
    );
    this.name = 'FxProviderError';
  }
}
