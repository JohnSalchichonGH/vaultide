import { z } from 'zod';

/**
 * Currency codes (blueprint 6.2 `currencies`): fiat/official only, never
 * crypto (R28). The set of codes the deployment actually supports lives in the
 * database; this schema only enforces the shape.
 */
export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/u, 'Use a three-letter ISO 4217 currency code.');

/** Minor units of a currency: 0 (JPY) through 8; 4 for CLF and UYW (6.2). */
export const minorUnits = z.number().int().min(0).max(8);
