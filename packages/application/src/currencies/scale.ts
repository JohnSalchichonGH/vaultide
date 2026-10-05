import { findMinorUnitsIn, type Transaction } from '@vaultide/db';
import { fitsMinorUnits, money } from '@vaultide/finance';
import { minorUnitsMessage } from '@vaultide/validation';
import { ValidationError, type FieldErrors } from '../errors';

/**
 * Input scale (blueprint 7.2): an amount the user entered may not have more
 * decimals than its currency's minor units — EUR 2, JPY 0, KWD 3, CLF 4.
 *
 * The blueprint names the browser half `moneyInput(currency)`; in the code it
 * is `moneyString({ minorUnits })`, which the forms use. The server's input
 * schemas can only hold an amount to the storage scale of 8, because the
 * currency it is judged in is often not in the request at all: a correction
 * keeps its row's currency, each transfer leg is in its own account's, a
 * balance is in its position's and a term in its template's. So the domain
 * asks the rule again here, inside the write's own transaction, once the rows
 * that decide that currency have been read — and every caller of a write's
 * resolve step, the ordinary save, Preview and Confirm alike, is refused the
 * same amount in the same words.
 *
 * Only what the request states is judged. An amount a write carries forward
 * from a stored row, or one the server derives, was not typed by anybody in
 * this request, and refusing it would refuse a save over a value the user was
 * never shown as theirs to fix.
 */

/** One amount a request states, and the currency the write stores it in. */
export interface StatedAmount {
  /** The request field the amount arrived in. A refusal is keyed to it. */
  readonly field: string;
  /** `undefined` when the request leaves the field out, `null` when it clears it. */
  readonly amount: string | null | undefined;
  readonly currency: string;
}

const UNKNOWN_CURRENCY = 'That is not a currency Vaultide knows.';

/**
 * The amounts that do not fit their currency, keyed by field. Pure: the minor
 * units arrive already read, by currency code.
 *
 * A currency the catalogue does not hold has no minor units to judge by. That
 * is missing evidence rather than a reason to let the amount through, so it is
 * refused against the currency itself.
 */
export function inputScaleErrors(
  stated: readonly StatedAmount[],
  minorUnits: ReadonlyMap<string, number>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const { field, amount, currency } of stated) {
    if (amount === null || amount === undefined) continue;
    const code = currency.trim().toUpperCase();
    const units = minorUnits.get(code);
    if (units === undefined) {
      errors['currency'] = [UNKNOWN_CURRENCY];
      continue;
    }
    if (!fitsMinorUnits(money(amount, code), units)) {
      errors[field] = [minorUnitsMessage(units)];
    }
  }
  return errors;
}

/**
 * Refuse a write whose stated amounts have more decimals than their currencies
 * allow, before it has written anything.
 *
 * One statement for every currency involved, and none when the request states
 * no amount at all.
 */
export async function assertInputScaleIn(
  tx: Transaction,
  stated: readonly StatedAmount[],
): Promise<void> {
  const present = stated.filter((item) => item.amount !== null && item.amount !== undefined);
  if (present.length === 0) return;

  const rows = await findMinorUnitsIn(
    tx,
    present.map((item) => item.currency),
  );
  const errors = inputScaleErrors(present, new Map(rows.map((row) => [row.code, row.minorUnits])));
  const first = Object.values(errors)[0]?.[0];
  if (first !== undefined) throw new ValidationError(first, errors);
}
