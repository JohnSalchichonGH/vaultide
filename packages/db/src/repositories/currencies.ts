import { and, asc, eq, inArray } from 'drizzle-orm';
import { currencies } from '../schema/currencies';
import { withoutUser, type Database, type Transaction } from '../client';

/**
 * `currencies` reads (blueprint 6.2, 19 "repositories").
 *
 * A global reference table: no `user_id`, no RLS, and therefore read through
 * `withoutUser`. Writing is a migration's job — the runtime role's INSERT,
 * UPDATE and DELETE on this table are revoked (6.1).
 */

export interface CurrencyRecord {
  readonly code: string;
  readonly name: string;
  readonly minorUnits: number;
  readonly isFxSupported: boolean;
}

const CURRENCY_COLUMNS = {
  code: currencies.code,
  name: currencies.name,
  minorUnits: currencies.minorUnits,
  isFxSupported: currencies.isFxSupported,
};

export async function listCurrencyRecords(
  db: Database,
  options: { fxSupportedOnly?: boolean } = {},
): Promise<CurrencyRecord[]> {
  const rows = await withoutUser(db, async (tx) =>
    tx
      .select(CURRENCY_COLUMNS)
      .from(currencies)
      .where(
        options.fxSupportedOnly === true
          ? and(eq(currencies.isActive, true), eq(currencies.isFxSupported, true))
          : eq(currencies.isActive, true),
      )
      .orderBy(asc(currencies.code)),
  );

  // `char(3)` pads to its declared width in some drivers; codes are compared
  // and displayed everywhere, so they are trimmed once, here.
  return rows.map((row) => ({ ...row, code: row.code.trim() }));
}

/** Which of `codes` exist, are active and are FX-supported. */
export async function findUsableCurrencyCodes(
  db: Database,
  codes: readonly string[],
): Promise<string[]> {
  return withoutUser(db, async (tx) => findUsableCurrencyCodesIn(tx, codes));
}

/**
 * The same question inside a caller's transaction.
 *
 * A financial write validates its currency after taking the per-user write
 * mutex (ADR 0010 §5), so the check cannot open a scope of its own. The table
 * is global and carries no RLS policy, so reading it inside a user-scoped
 * transaction returns the whole active catalogue exactly as `withoutUser`
 * would; the user context simply does not apply to it.
 */
export async function findUsableCurrencyCodesIn(
  tx: Transaction,
  codes: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
  if (wanted.length === 0) return [];

  const rows = await tx
    .select({ code: currencies.code })
    .from(currencies)
    .where(
      and(
        inArray(currencies.code, wanted),
        eq(currencies.isActive, true),
        eq(currencies.isFxSupported, true),
      ),
    );

  return rows.map((row) => row.code.trim());
}
