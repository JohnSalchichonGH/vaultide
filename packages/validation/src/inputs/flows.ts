import { z } from 'zod';
import {
  incomeKinds,
  phase3ExpenseSettlements,
  phase3IncomeSettlements,
  recurrenceFrequencies,
  skipReasons,
} from '../enums';
import { currencyCode } from '../primitives/currency';
import { moneyString } from '../primitives/money';
import { plainDate, plainDateNotAfter } from '../primitives/date';

/**
 * Phase 3 flow inputs (blueprint 6.2, 7.4, 20.1, M5, v2.1.6 §30.9).
 *
 * Every schema carrying an **actual** record's date is a function of `ctx.today`
 * — the user's local today, resolved once per request — so a bypassed client is
 * judged by the server's rule and not by anything the browser sent. The domain
 * services check the same rules again; neither layer trusts the other.
 *
 * `occurrence_date` is deliberately **not** bound by today. It is the schedule's
 * identity rather than a financial fact, and binding it would break the case it
 * exists for: accepting an occurrence scheduled for 1 October with "received
 * today" on 30 September (§30.9 item 2).
 *
 * The settlement enums here are the **Phase 3** subsets, not the full closed
 * sets: `reinvested` and `deducted_from_asset` need an investment position, and
 * `external` on a dividend or interest is the case 7.4 only defines when the row
 * links an investment. A later phase widens the list; no migration is involved.
 */

const expectedVersion = z.number().int().positive();
const description = z.string().trim().max(500, 'That description is too long.');
const tags = z.array(z.string().trim().min(1).max(60)).max(20, 'That is a lot of tags.');
const reason = z.string().trim().max(500, 'That reason is too long.');

/* ------------------------------------------------------------------------- */
/* Income                                                                     */
/* ------------------------------------------------------------------------- */

export function createIncomeEntryInput(today: string) {
  return z.object({
    kind: z.enum(incomeKinds),
    receivedOn: plainDateNotAfter(today),
    netAmount: moneyString({ nonNegative: true }),
    grossAmount: moneyString({ nonNegative: true }).optional(),
    currency: currencyCode,
    settlement: z.enum(phase3IncomeSettlements).default('tracked_cash'),
    /** `null` is a tracked flow awaiting attribution, never an untracked one (8.1). */
    cashPositionId: z.uuid().nullable().optional(),
    description: description.optional(),
    tags: tags.optional(),
    isOneOff: z.boolean().optional(),
  });
}

export function updateIncomeEntryInput(today: string) {
  return z.object({
    entryId: z.uuid(),
    expectedVersion,
    kind: z.enum(incomeKinds).optional(),
    receivedOn: plainDateNotAfter(today).optional(),
    netAmount: moneyString({ nonNegative: true }).optional(),
    grossAmount: moneyString({ nonNegative: true }).nullable().optional(),
    settlement: z.enum(phase3IncomeSettlements).optional(),
    cashPositionId: z.uuid().nullable().optional(),
    description: description.nullable().optional(),
    tags: tags.optional(),
    isOneOff: z.boolean().optional(),
    reason: reason.optional(),
  });
}

export const deleteIncomeEntryInput = z.object({
  entryId: z.uuid(),
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Expenses                                                                   */
/* ------------------------------------------------------------------------- */

export function createExpenseEntryInput(today: string) {
  return z.object({
    categoryId: z.uuid(),
    incurredOn: plainDateNotAfter(today),
    amount: moneyString({ positive: true }),
    currency: currencyCode,
    settlement: z.enum(phase3ExpenseSettlements).default('tracked_cash'),
    cashPositionId: z.uuid().nullable().optional(),
    description: description.optional(),
    tags: tags.optional(),
    isOneOff: z.boolean().optional(),
  });
}

export function updateExpenseEntryInput(today: string) {
  return z.object({
    entryId: z.uuid(),
    expectedVersion,
    categoryId: z.uuid().optional(),
    incurredOn: plainDateNotAfter(today).optional(),
    amount: moneyString({ positive: true }).optional(),
    settlement: z.enum(phase3ExpenseSettlements).optional(),
    cashPositionId: z.uuid().nullable().optional(),
    description: description.nullable().optional(),
    tags: tags.optional(),
    isOneOff: z.boolean().optional(),
    reason: reason.optional(),
  });
}

export const deleteExpenseEntryInput = z.object({
  entryId: z.uuid(),
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A cash transfer, optionally with its fee (7.5, M13, M14).
 *
 * `kind` is not an input: Phase 3 writes `cash_transfer` and nothing else, so
 * offering the field would be offering seven values the services refuse.
 * `template_id` and `occurrence_date` are likewise absent — Phase 3 materializes
 * no recurring transfer occurrence, so both are always NULL.
 */
export function createTransferInput(today: string) {
  return z.object({
    occurredOn: plainDateNotAfter(today),
    fromPositionId: z.uuid(),
    toPositionId: z.uuid(),
    fromAmount: moneyString({ positive: true }),
    toAmount: moneyString({ positive: true }),
    description: description.optional(),
    tags: tags.optional(),
    fee: z
      .object({
        amount: moneyString({ positive: true }),
        categoryId: z.uuid(),
        cashPositionId: z.uuid(),
        currency: currencyCode,
        description: description.optional(),
      })
      .optional(),
  });
}

export function updateTransferInput(today: string) {
  return z.object({
    transferId: z.uuid(),
    expectedVersion,
    occurredOn: plainDateNotAfter(today).optional(),
    fromAmount: moneyString({ positive: true }).optional(),
    toAmount: moneyString({ positive: true }).optional(),
    description: description.nullable().optional(),
    tags: tags.optional(),
    /**
     * Present only when the edit changes the fee too. Absent means "leave the
     * fee alone", and an edit that would leave it incompatible is refused
     * rather than silently rewriting a source financial record (M14).
     */
    fee: z
      .object({
        expectedVersion,
        amount: moneyString({ positive: true }).optional(),
        incurredOn: plainDateNotAfter(today).optional(),
      })
      .optional(),
    reason: reason.optional(),
  });
}

export const deleteTransferInput = z.object({
  transferId: z.uuid(),
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Recurring templates                                                        */
/* ------------------------------------------------------------------------- */

export const templateName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(120, 'That name is too long.');

/**
 * Creating a template. `kind` is `income` or `expense`: `contribution` needs an
 * investment position and arrives with Phase 4.
 *
 * `start_date` may be in the past or the future — it is a schedule, not an
 * observation — but nothing it suggests becomes real without acceptance, and an
 * acceptance is bound by today.
 */
export const createTemplateInput = z
  .object({
    kind: z.enum(['income', 'expense']),
    name: templateName,
    counterparty: z.string().trim().max(120).optional(),
    incomeKind: z.enum(incomeKinds).optional(),
    categoryId: z.uuid().optional(),
    currency: currencyCode,
    frequency: z.enum(recurrenceFrequencies),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    startDate: plainDate,
    endDate: plainDate.optional(),
    cashPositionId: z.uuid().optional(),
    amount: moneyString({ nonNegative: true }),
    grossAmount: moneyString({ nonNegative: true }).optional(),
  })
  .refine((value) => value.kind !== 'income' || value.incomeKind !== undefined, {
    message: 'Choose what kind of income this is.',
    path: ['incomeKind'],
  })
  .refine((value) => value.kind !== 'expense' || value.categoryId !== undefined, {
    message: 'Choose a category for this expense.',
    path: ['categoryId'],
  });

/**
 * Editing a template.
 *
 * Only `name`, `counterparty` and `endDate` are here, and that is the whole
 * rule: every other field decides what the template's historical occurrences
 * were, so once an occurrence has been materialized or skipped it is frozen
 * (§30.9). A real schedule change is a new template. `sort_order` and `notes`
 * are absent because `recurring_templates` has no such columns.
 */
export const updateTemplateInput = z.object({
  templateId: z.uuid(),
  expectedVersion,
  name: templateName.optional(),
  counterparty: z.string().trim().max(120).nullable().optional(),
  endDate: plainDate.nullable().optional(),
});

export const archiveTemplateInput = z.object({
  templateId: z.uuid(),
  expectedVersion,
});

/**
 * "From this month on" (§30.9 item 4): a term effective at the **occurrence's**
 * scheduled date, never at the financial date the money happened to move on.
 */
export const setTemplateTermInput = z.object({
  templateId: z.uuid(),
  effectiveFrom: plainDate,
  amount: moneyString({ nonNegative: true }),
  grossAmount: moneyString({ nonNegative: true }).optional(),
  note: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Accepting an occurrence.
 *
 * `occurrenceDate` is the schedule's identity and is **not** bound by today —
 * an occurrence scheduled for 1 October is a real occurrence on 30 September.
 * `financialDate` is when the money actually moved and is bound by today, which
 * is exactly the split that makes "received today" safe (§30.9 item 2).
 */
export function acceptSuggestionInput(today: string) {
  return z.object({
    templateId: z.uuid(),
    occurrenceDate: plainDate,
    financialDate: plainDateNotAfter(today).optional(),
    /** "This month only": overrides the term for this occurrence alone. */
    amount: moneyString({ nonNegative: true }).optional(),
    cashPositionId: z.uuid().nullable().optional(),
    description: description.optional(),
  });
}

export const skipSuggestionInput = z.object({
  templateId: z.uuid(),
  occurrenceDate: plainDate,
  /** `vacant` and `non_payment` are occupancy facts, and only a rental has them. */
  reason: z.enum(skipReasons),
  note: z.string().trim().max(500).optional(),
});

export const unskipSuggestionInput = z.object({
  skipId: z.uuid(),
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Financial preferences                                                      */
/* ------------------------------------------------------------------------- */

/**
 * "Count spending I paid from outside my tracked accounts in my savings rate"
 * (6.2, 12.5).
 *
 * Its own input, and its own action, because changing it changes the
 * interpretation of **every** historical `PersonalSavings` and `SavingsRate` —
 * which is a financial write, not a display preference.
 */
export const setCountAdditionalSpendingInput = z.object({
  countAdditionalSpending: z.boolean(),
  expectedVersion,
});
