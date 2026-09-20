import { z } from 'zod';
import { incomeKinds, phase3ExpenseSettlements, phase3IncomeSettlements } from '../enums';
import { currencyCode } from '../primitives/currency';
import { moneyString } from '../primitives/money';
import { plainDate, plainDateNotAfter } from '../primitives/date';
import { linkedFeeExpectation, transferFeeExpectation } from './flows';

/**
 * Historical Correction inputs (blueprint 20.1, 30.22; ADR 0010).
 *
 * A **draft is user intent, never trusted fact**. What arrives here is which
 * record the user is editing, the version they were looking at, and the values
 * they want it to have — nothing else. There is deliberately no `historical`,
 * no `confirmed`, no `bypassReview` and no impact: whether an operation is a
 * Historical Correction is a conclusion the server reaches from rows it reads
 * for itself, and an unknown key is stripped here before it could matter.
 *
 * A **prospective row has no id to send.** A fee a correction would add is
 * identified by its role in the aggregate, which the server derives; a browser
 * that invented a UUID for it would be describing a row that will never exist.
 *
 * Every schema carrying an **actual** record's date is a function of
 * `ctx.today`, exactly as the ordinary flow inputs are (M5, 20.1), so a
 * bypassed client is judged by the server's rule. `occurrence_date` is not,
 * because it is the schedule's identity rather than a financial fact
 * (§30.9 item 2).
 */

const expectedVersion = z.number().int().positive();
const description = z.string().trim().max(500, 'That description is too long.');
const tags = z.array(z.string().trim().min(1).max(60)).max(20, 'That is a lot of tags.');

/**
 * The user's explanation, for the audit rows (18.1; ADR 0010 §11).
 *
 * Deliberately **not** part of the draft, and therefore not part of what the
 * fingerprint is taken over: changing only the reason needs no new preview, and
 * a reason typed before an `impact_changed` survives it (§65).
 */
export const correctionReason = z.string().trim().max(500, 'That reason is too long.');

/**
 * The fingerprint of the preview the user reviewed.
 *
 * Shape-checked only. It is never authority: the server recomputes the whole
 * preview and compares, so a well-formed value that means nothing simply fails
 * equality (§53). Bounding its length keeps a malformed request from carrying a
 * megabyte of string into a hash comparison.
 */
export const correctionFingerprint = z
  .string()
  .regex(/^hc-v[0-9]+:[0-9a-f]{64}$/u, 'That is not a correction fingerprint.');

const datePrecision = z.enum(['exact', 'month_end']);

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

export function correctionDraft(today: string) {
  const financialDate = plainDateNotAfter(today);

  const transferFee = z.object({
    amount: moneyString({ positive: true }),
    cashPositionId: z.uuid(),
    incurredOn: financialDate,
  });

  return z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('valuation_create'),
      positionId: z.uuid(),
      valuedOn: financialDate,
      amount: moneyString(),
      datePrecision,
      note: description.optional(),
    }),
    z.object({
      kind: z.literal('valuation_update'),
      valuationId: z.uuid(),
      expectedVersion,
      valuedOn: financialDate,
      amount: moneyString(),
      datePrecision,
      note: description.nullable().optional(),
    }),
    z.object({
      kind: z.literal('valuation_delete'),
      valuationId: z.uuid(),
      expectedVersion,
    }),
    z.object({
      kind: z.literal('quick_update'),
      entries: z
        .array(
          z.object({
            positionId: z.uuid(),
            amount: moneyString(),
            expectedVersion: expectedVersion.optional(),
          }),
        )
        .min(1, 'Enter at least one balance.')
        .max(100, 'That is too many accounts.'),
    }),

    z.object({
      kind: z.literal('income_create'),
      incomeKind: z.enum(incomeKinds),
      receivedOn: financialDate,
      netAmount: moneyString({ nonNegative: true }),
      grossAmount: moneyString({ nonNegative: true }).optional(),
      currency: currencyCode,
      settlement: z.enum(phase3IncomeSettlements).default('tracked_cash'),
      cashPositionId: z.uuid().nullable().optional(),
      description: description.optional(),
      tags: tags.optional(),
      isOneOff: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('income_update'),
      entryId: z.uuid(),
      expectedVersion,
      incomeKind: z.enum(incomeKinds).optional(),
      receivedOn: financialDate.optional(),
      netAmount: moneyString({ nonNegative: true }).optional(),
      grossAmount: moneyString({ nonNegative: true }).nullable().optional(),
      settlement: z.enum(phase3IncomeSettlements).optional(),
      cashPositionId: z.uuid().nullable().optional(),
      description: description.nullable().optional(),
      tags: tags.optional(),
      isOneOff: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('income_delete'),
      entryId: z.uuid(),
      expectedVersion,
    }),

    z.object({
      kind: z.literal('expense_create'),
      categoryId: z.uuid(),
      incurredOn: financialDate,
      amount: moneyString({ positive: true }),
      currency: currencyCode,
      settlement: z.enum(phase3ExpenseSettlements).default('tracked_cash'),
      cashPositionId: z.uuid().nullable().optional(),
      description: description.optional(),
      tags: tags.optional(),
      isOneOff: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('expense_update'),
      entryId: z.uuid(),
      expectedVersion,
      categoryId: z.uuid().optional(),
      incurredOn: financialDate.optional(),
      amount: moneyString({ positive: true }).optional(),
      settlement: z.enum(phase3ExpenseSettlements).optional(),
      cashPositionId: z.uuid().nullable().optional(),
      description: description.nullable().optional(),
      tags: tags.optional(),
      isOneOff: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('expense_delete'),
      entryId: z.uuid(),
      expectedVersion,
    }),

    z.object({
      kind: z.literal('transfer_create'),
      occurredOn: financialDate,
      fromPositionId: z.uuid(),
      toPositionId: z.uuid(),
      fromAmount: moneyString({ positive: true }),
      toAmount: moneyString({ positive: true }),
      description: description.optional(),
      tags: tags.optional(),
      fee: transferFee.optional(),
    }),
    z.object({
      kind: z.literal('transfer_update'),
      transferId: z.uuid(),
      expectedVersion,
      occurredOn: financialDate,
      fromPositionId: z.uuid(),
      toPositionId: z.uuid(),
      fromAmount: moneyString({ positive: true }),
      toAmount: moneyString({ positive: true }),
      description: description.nullable(),
      tags: tags.optional(),
      fee: transferFee.nullable(),
      expectedFee: transferFeeExpectation,
    }),
    z.object({
      kind: z.literal('transfer_delete'),
      transferId: z.uuid(),
      expectedVersion,
      expectedFees: z.array(linkedFeeExpectation).max(100, 'That is too many linked fees.'),
    }),

    z.object({
      kind: z.literal('accept_suggestion'),
      templateId: z.uuid(),
      /** The schedule's identity, so deliberately not bound by today. */
      occurrenceDate: plainDate,
      financialDate: financialDate.optional(),
      receivedToday: z.boolean().optional(),
      amount: moneyString({ nonNegative: true }).optional(),
      grossAmount: moneyString({ nonNegative: true }).nullable().optional(),
      cashPositionId: z.uuid().nullable().optional(),
      description: description.optional(),
    }),

    z.object({
      kind: z.literal('cash_account_update'),
      positionId: z.uuid(),
      expectedVersion,
      name: z.string().trim().min(1).max(120).optional(),
      accountType: z.enum(['checking', 'savings', 'cash', 'other']).optional(),
      institution: z.string().trim().max(120).nullable().optional(),
      notes: description.nullable().optional(),
      isDormant: z.boolean().optional(),
    }),
  ]);
}

/** Ask what an operation would do, and whether it needs consent (§55). */
export function previewCorrectionInput(today: string) {
  return z.object({ draft: correctionDraft(today) });
}

/** Commit a reviewed correction: the same draft, the fingerprint, the reason. */
export function confirmCorrectionInput(today: string) {
  return z.object({
    draft: correctionDraft(today),
    fingerprint: correctionFingerprint,
    reason: correctionReason.optional(),
  });
}
