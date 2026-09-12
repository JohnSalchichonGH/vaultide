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
  /**
   * Whether Vaultide's **approved** FX source chain publishes a current
   * reference rate for it (10.4) — for Phase 1, the ECB then Banca d'Italia.
   * `false` does not mean no rate exists anywhere; it means this product has
   * no source it is willing to convert the currency with.
   */
  readonly isFxSupported: boolean;
}

export interface ListCurrenciesOptions {
  /**
   * Only currencies the approved FX chain covers. This is what every picker
   * uses: a currency we hold no rates for cannot be a base, reporting or
   * position currency, because there would be no honest way to convert it
   * (10.5).
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

/**
 * The two things a page needs from the catalogue, from **one** read.
 *
 * A page formats every amount it shows and offers a currency for every amount
 * it takes, and those are different questions over the same rows: minor units
 * are needed for *any* currency a record already carries, while a picker may
 * only offer one this product is willing to convert (`fxSupportedOnly`, 10.5).
 *
 * Reading the catalogue twice to answer them would be two scopes for one table
 * that is global, tiny and already in hand — so the FX-supported filter is
 * applied here, over rows the single read returned, rather than by a second
 * query with a `WHERE` clause.
 */
export interface CurrencyCatalogue {
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /** Active and FX-supported, ascending — what a picker may offer (10.5). */
  readonly selectableCurrencyCodes: readonly string[];
}

export async function currencyCatalogue(db: Database): Promise<CurrencyCatalogue> {
  const rows = await listCurrencyRecords(db);
  return {
    minorUnitsByCurrency: Object.fromEntries(rows.map((row) => [row.code, row.minorUnits])),
    selectableCurrencyCodes: rows.filter((row) => row.isFxSupported).map((row) => row.code),
  };
}
