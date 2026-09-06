import type { Decimal } from '../decimal';

/** ISO 4217 alphabetic code, branded so a bare string cannot be used by mistake. */
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function currencyCode(code: string): CurrencyCode {
  if (!CURRENCY_PATTERN.test(code)) {
    throw new InvalidCurrencyCodeError(code);
  }
  return code as CurrencyCode;
}

export function isCurrencyCode(code: string): code is CurrencyCode {
  return CURRENCY_PATTERN.test(code);
}

/** An exact amount in one currency. Never a JavaScript number. */
export interface Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
}

/** The serializable representation crossing the server/client boundary (7.1). */
export interface MoneyDto {
  readonly amount: string;
  readonly currency: string;
}

/** Minor units of a currency (0 for JPY, 2 for EUR, 3 for KWD, 4 for CLF). */
export type MinorUnits = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`Cannot combine ${left} with ${right}: money of different currencies never mixes.`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidCurrencyCodeError extends Error {
  readonly code = 'INVALID_CURRENCY_CODE';
  constructor(readonly value: string) {
    super(`"${value}" is not an ISO 4217 alphabetic currency code.`);
    this.name = 'InvalidCurrencyCodeError';
  }
}

export class InvalidMinorUnitsError extends Error {
  readonly code = 'INVALID_MINOR_UNITS';
  constructor(readonly value: number) {
    super(`Minor units must be an integer between 0 and 8, received ${String(value)}.`);
    this.name = 'InvalidMinorUnitsError';
  }
}

export function assertMinorUnits(value: number): asserts value is MinorUnits {
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new InvalidMinorUnitsError(value);
  }
}
