import { z } from 'zod';
import { cashAccountTypes, otherAssetTypes } from '../enums';
import { currencyCode } from '../primitives/currency';
import { moneyString } from '../primitives/money';
import { monthKey, plainDate, plainDateNotAfter, valuationDateSchema } from '../primitives/date';

/**
 * Position and valuation inputs (blueprint 6.2, 15.2, 20.1, M5, R15, R17).
 *
 * Every schema that carries the date of an **actual** record is built from
 * `ctx.today` — the user's local today, computed once per request — so the
 * server judges a bypassed client by its own rule rather than by anything the
 * browser sent (20.1). Nothing here accepts a `userId`: identity comes from the
 * session (17.2).
 *
 * Money is a string throughout (7.1). `minorUnits` comes from the `currencies`
 * table, so a EUR field rejects three decimals and a CLF field accepts four.
 */

export const positionName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(120, 'That name is too long.');

export const institutionName = z.string().trim().max(120, 'That name is too long.');

export const positionNotes = z.string().trim().max(2_000, 'That note is too long.');

const expectedVersion = z.number().int().positive();

/**
 * "New account, started empty on <date>" versus "existing account I am starting
 * to track" (6.2 `positions.opened_on`).
 *
 * The distinction is financial, not cosmetic: an account opened inside a month
 * opens that month at zero (`opened_zero`), while a pre-existing account whose
 * first balance lands in the month is **excluded** from that month's
 * reconciliation and marked `first_balance` (8.1). Storing NULL is how the
 * second case is recorded, so the engines can tell them apart later.
 */
export function cashAccountOriginSchema(today: string) {
  return z.discriminatedUnion('origin', [
    z.object({ origin: z.literal('new'), openedOn: plainDateNotAfter(today) }),
    z.object({ origin: z.literal('existing') }),
  ]);
}

/**
 * Creating a cash account, optionally with its first balance.
 *
 * The balance is an ordinary valuation dated on or before today with `exact`
 * precision — onboarding balances are dated today (15.2). A month-end balance
 * is never written here: it can only exist once its month has ended (R15).
 */
export function createCashAccountInput(today: string) {
  return z
    .object({
      name: positionName,
      currency: currencyCode,
      accountType: z.enum(cashAccountTypes),
      institution: institutionName.optional(),
      notes: positionNotes.optional(),
      /** Amount as an exact decimal string; scale is re-checked against the currency. */
      openingBalance: moneyString().optional(),
      openingBalanceOn: plainDateNotAfter(today).optional(),
    })
    .and(cashAccountOriginSchema(today))
    .refine(
      (value) => value.openingBalance === undefined || value.openingBalanceOn !== undefined,
      { message: 'Choose the date this balance was true.', path: ['openingBalanceOn'] },
    );
}

export function createOtherAssetInput(today: string) {
  return z
    .object({
      name: positionName,
      currency: currencyCode,
      assetType: z.enum(otherAssetTypes),
      notes: positionNotes.optional(),
      acquisitionDate: plainDateNotAfter(today).optional(),
      acquisitionValue: moneyString({ nonNegative: true }).optional(),
      /**
       * The only inclusion preference in the whole schema (M15, R18). It
       * decides whether the asset counts in **financial** net worth; it can
       * never remove it from **total** net worth.
       */
      includeInFinancialNetWorth: z.boolean().default(false),
      currentValue: moneyString().optional(),
      currentValueOn: plainDateNotAfter(today).optional(),
    })
    .refine((value) => value.currentValue === undefined || value.currentValueOn !== undefined, {
      message: 'Choose the date this value was true.',
      path: ['currentValueOn'],
    });
}

/** Editing the metadata of a cash account. Currency is deliberately absent. */
export const updateCashAccountInput = z.object({
  positionId: z.uuid(),
  expectedVersion,
  name: positionName.optional(),
  accountType: z.enum(cashAccountTypes).optional(),
  institution: institutionName.nullable().optional(),
  notes: positionNotes.nullable().optional(),
  /** Only settable while the account's latest balance is exactly zero (6.2). */
  isDormant: z.boolean().optional(),
});

export const updateOtherAssetInput = z.object({
  positionId: z.uuid(),
  expectedVersion,
  name: positionName.optional(),
  assetType: z.enum(otherAssetTypes).optional(),
  notes: positionNotes.nullable().optional(),
  acquisitionDate: plainDate.nullable().optional(),
  acquisitionValue: moneyString({ nonNegative: true }).nullable().optional(),
  includeInFinancialNetWorth: z.boolean().optional(),
});

/**
 * Closing a position (M6): a cash account or other asset closes with a final
 * valuation of zero on the closing date. The service refuses a close that would
 * leave a non-zero balance, and says where the money has to go instead.
 */
export function closePositionInput(today: string) {
  return z.object({
    positionId: z.uuid(),
    expectedVersion,
    closedOn: plainDateNotAfter(today),
  });
}

export const deletePositionInput = z.object({ positionId: z.uuid() });

/**
 * Writing a valuation (6.2, R15, M5).
 *
 * `valuationDateSchema` carries both frozen date rules: never after today, and
 * `month_end` only when the month has actually ended and the date is its last
 * day. On 30 September a September month-end balance is refused; on 1 October
 * it is accepted.
 */
export function createValuationInput(today: string) {
  return z
    .object({
      positionId: z.uuid(),
      amount: moneyString(),
      note: z.string().trim().max(500).optional(),
    })
    .and(valuationDateSchema(today));
}

export function updateValuationInput(today: string) {
  return z
    .object({
      valuationId: z.uuid(),
      expectedVersion,
      amount: moneyString(),
      note: z.string().trim().max(500).nullable().optional(),
    })
    .and(valuationDateSchema(today));
}

export const deleteValuationInput = z.object({ valuationId: z.uuid() });

/**
 * Confirming an existing exact snapshot dated the last day of a month as that
 * month's statement balance (8.1, R15). It upgrades the row's precision and is
 * audited; the amount is untouched.
 */
export const confirmMonthEndInput = z.object({
  valuationId: z.uuid(),
  expectedVersion,
});

/**
 * "Confirm unchanged for this month" (R22): writes a `month_end` valuation
 * equal to the previous month-end balance. Available only once the month has
 * ended, which the service checks against `ctx.today`.
 */
export const confirmUnchangedInput = z.object({
  positionId: z.uuid(),
  /** The month being closed, as `YYYY-MM`. */
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Enter a month as YYYY-MM.'),
});

/**
 * "Confirm all untouched as unchanged" (15.3): the same act as
 * `confirmUnchangedInput`, for several accounts of one month in one
 * transaction. It carries no amount — each is the account's own previous
 * statement balance, read by the server — and the service re-checks every
 * account's eligibility, so a stale or crafted list fails as a whole.
 */
export const confirmUnchangedBatchInput = z.object({
  month: monthKey,
  positionIds: z
    .array(z.uuid())
    .min(1, 'Choose at least one account.')
    .max(100, 'Confirm at most 100 accounts at once.')
    .refine((ids) => new Set(ids).size === ids.length, 'Each account may appear only once.'),
});

/**
 * Quick update (15.3): one balance per position, all dated **today** with
 * `exact` precision — no other date is offered (M5). Blank entries are simply
 * not sent, and keep the position's older snapshot.
 *
 * The whole submission is one transaction: it either lands completely or not at
 * all, which is the bulk-save rule of 20.3 applied to the same shape of write.
 */
export const quickUpdateInput = z.object({
  entries: z
    .array(
      z.object({
        positionId: z.uuid(),
        amount: moneyString(),
        /** The version of today's existing valuation, when correcting one. */
        expectedVersion: expectedVersion.optional(),
      }),
    )
    .min(1, 'Enter at least one balance.')
    .max(100, 'Update at most 100 positions at once.')
    .refine(
      (entries) => new Set(entries.map((entry) => entry.positionId)).size === entries.length,
      'Each position may appear only once.',
    ),
});

export type UpdateCashAccountInput = z.infer<typeof updateCashAccountInput>;
export type UpdateOtherAssetInput = z.infer<typeof updateOtherAssetInput>;
export type QuickUpdateInput = z.infer<typeof quickUpdateInput>;
