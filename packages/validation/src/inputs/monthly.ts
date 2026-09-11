import { z } from 'zod';

/**
 * Monthly page inputs (blueprint 15.3, 20.1).
 *
 * The shape is validated here and nothing more. Whether a month is over, or has
 * begun, depends on the user's local today, and whether a key is an advisory is
 * the issue catalogue's to say — both are answered by the review service, never
 * by a request (8.5, M5).
 */

/** A month as the route and the actions name it: `YYYY-MM`. */
export const monthParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Expected a month as YYYY-MM.');

/**
 * An issue key, as an opaque token. Lower-case words joined by underscores,
 * which is the shape every 8.5 key has; the catalogue decides what it means.
 */
export const issueKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u, 'Expected an issue key.');

export const markMonthReviewedInput = z.object({ month: monthParam });

export const monthAdvisoryInput = z.object({ month: monthParam, key: issueKey });

export type MarkMonthReviewedInput = z.infer<typeof markMonthReviewedInput>;
export type MonthAdvisoryInput = z.infer<typeof monthAdvisoryInput>;
