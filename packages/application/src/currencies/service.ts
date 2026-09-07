import { findUsableCurrencyCodes, listCurrencyRecords, type Database } from '@vaultide/db';

/**
 * The currency catalogue (blueprint 6.2 `currencies`, R28, D35).
 *
 * A global reference table with no `user_id` and no RLS. The repository reads
 * it without a user context, which documents at the call site that nothing
 * tenant-scoped is being touched.
 *
 * Crypto is absent by construction: the seed contains fiat and official
 * currencies only, so "is BTC offered as a currency?" is answered by the data
 * rather than by a filter someone could forget to apply (Phase 1 acceptance
 * item 7).
 */

export interface Currency {
  readonly code: string;
  readonly name: string;
  readonly minorUnits: number;
  /** Whether the FX provider publishes reference rates for it (10.4). */
  readonly isFxSupported: boolean;
}

export interface ListCurrenciesOptions {
  /**
   * Only currencies the FX provider covers. This is what every picker uses: a
   * currency with no rates cannot be a base, reporting or position currency,
   * because there would be no honest way to convert it (10.5).
   */
  readonly fxSupportedOnly?: boolean;
}

export async function listCurrencies(
  db: Database,
  options: ListCurrenciesOptions = {},
): Promise<Currency[]> {
  return listCurrencyRecords(db, options);
}

/** The codes the FX refresh maintains: the whole supported fiat set (10.4, R26). */
export async function supportedFxCurrencyCodes(db: Database): Promise<string[]> {
  const rows = await listCurrencyRecords(db, { fxSupportedOnly: true });
  return rows.map((row) => row.code);
}

/**
 * Which of `codes` are usable as a currency: present, active and FX-supported.
 * Returns the set that passed, so a caller can report exactly which failed.
 */
export async function usableCurrencyCodes(
  db: Database,
  codes: readonly string[],
): Promise<Set<string>> {
  return new Set(await findUsableCurrencyCodes(db, codes));
}

/** Minor units per code, for the exact formatter and the money validators (7.2). */
export async function minorUnitsByCurrency(db: Database): Promise<Record<string, number>> {
  const rows = await listCurrencyRecords(db);
  return Object.fromEntries(rows.map((row) => [row.code, row.minorUnits]));
}
