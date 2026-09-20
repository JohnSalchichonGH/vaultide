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
import { monthParam } from './monthly';

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

/**
 * Deleting is version-aware (6.3, 20.3, 30.22 item 10).
 *
 * `expectedVersion` is the version the client rendered, so a row corrected
 * elsewhere refuses rather than being taken down by a request that was about
 * the version before it. It changes the safety contract, not the ceremony: the
 * control stays one click.
 */
export const deleteIncomeEntryInput = z.object({
  entryId: z.uuid(),
  expectedVersion,
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
  expectedVersion,
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A transfer's fee, as the user states it (7.4, M14; ADR 0006 §5, §6).
 *
 * Three facts and no more: the amount, the endpoint that paid it, and the day
 * it was charged — its own financial date, bound by today like any other. The
 * category, currency, settlement and description are not inputs. A fee is
 * tracked cash in its payer's currency, filed under the user's own
 * `transfer_fee` category, and the service decides that rather than trusting a
 * value it was sent; an unknown key is stripped here before it could matter.
 */
function transferFee(today: string) {
  return z.object({
    amount: moneyString({ positive: true }),
    cashPositionId: z.uuid(),
    incurredOn: plainDateNotAfter(today),
  });
}

/**
 * What the client saw of a transfer's fee when it began the edit (20.3).
 *
 * The same two states as `termExpectation`, for the same reason: whether the
 * save inserts, updates or deletes the fee is decided against what the user
 * looked at, never against a read the server takes for itself.
 *
 *  - `{ state: 'absent' }` — "there was no fee". A fee found now is a conflict.
 *  - `{ state: 'version', feeId, version }` — "there was this exact fee": that
 *    row, at that version. Another row, even at the same version, a different
 *    version, or no fee at all, is a conflict.
 *
 * A version alone cannot say which row it counts. Removing a fee and adding
 * another leaves the transfer's version where it was, and the new row starts
 * again at the version the removed one had.
 */
export const transferFeeExpectation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }),
  z.object({ state: z.literal('version'), feeId: z.uuid(), version: z.number().int().positive() }),
]);

/**
 * A cash transfer, optionally with its fee (7.5, M13, M14).
 *
 * `kind` is not an input: Phase 3 writes `cash_transfer` and nothing else, so
 * offering the field would be offering seven values the services refuse.
 * `template_id` and `occurrence_date` are likewise absent — Phase 3 materializes
 * no recurring transfer occurrence, so both are always NULL. Each leg's currency
 * is its account's, so neither is an input either.
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
    fee: transferFee(today).optional(),
  });
}

/**
 * Correcting a cash transfer: the whole aggregate, saved at once (ADR 0006 §2,
 * §3).
 *
 * Every editable fact is required, so a correction states the transfer it should
 * become rather than a patch whose gaps the server would fill: the date, both
 * endpoints, both amounts, the description (`null` clears it) and the fee
 * (`null` for none). The kind and the currency pair are fixed after creation,
 * and tags are not edited here, so none of them is an input.
 */
export function updateTransferInput(today: string) {
  return z.object({
    transferId: z.uuid(),
    expectedVersion,
    occurredOn: plainDateNotAfter(today),
    fromPositionId: z.uuid(),
    toPositionId: z.uuid(),
    fromAmount: moneyString({ positive: true }),
    toAmount: moneyString({ positive: true }),
    description: description.nullable(),
    fee: transferFee(today).nullable(),
    expectedFee: transferFeeExpectation,
    reason: reason.optional(),
  });
}

/**
 * One linked fee row as the client rendered it (20.3, 30.22 item 10).
 *
 * A delete states **every** one of them, so a second fee cannot change, appear
 * or vanish between the render and the delete without the caller having
 * confirmed the aggregate that is actually removed. A correction keeps the
 * single `transferFeeExpectation` above: it may only proceed over an aggregate
 * this product could have created, which has at most one fee.
 */
export const linkedFeeExpectation = z.object({
  feeId: z.uuid(),
  version: expectedVersion,
});

/**
 * Deleting a transfer takes the whole aggregate down, so it states the whole
 * aggregate it saw: the transfer's own version and every linked fee row, each
 * by id and version (ADR 0006 §2; 30.22 item 10).
 *
 * The list is bounded like every other array input (20.1). One fee is the only
 * shape this product creates and two is already a repair case, so a hundred is
 * far past anything real while still leaving the malformed-aggregate repair
 * reachable.
 */
export const deleteTransferInput = z.object({
  transferId: z.uuid(),
  expectedVersion,
  expectedFees: z.array(linkedFeeExpectation).max(100, 'That is too many linked fees.'),
  reason: reason.optional(),
});

/* ------------------------------------------------------------------------- */
/* Reconciliation adjustments                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Accepting an unexplained inflow as a reconciliation adjustment (8.5, 30.21).
 *
 * Deliberately the smallest input in this file. The row's kind, settlement,
 * amount, cash leg and financial date are **not** here: the service recomputes
 * the month's reconciliation and derives every one of them from the discrepancy
 * it finds, because an adjustment exists only for as long as that discrepancy
 * does. What the browser sends is which bucket it was looking at, the amount it
 * displayed — so a stale view can be refused rather than recorded — and an
 * optional note.
 */
export const acceptAdjustmentInput = z.object({
  month: monthParam,
  currency: currencyCode,
  /** The unexplained amount the user saw, compared against the server's own. */
  expectedAmount: moneyString({ positive: true }),
  note: z.string().trim().max(200, 'That note is too long.').optional(),
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
 *
 * `expected` is what the client believed about that effective date when it
 * rendered the form, and it is required rather than inferred. A term amount is
 * a source financial value, so the server must not decide "create or update"
 * from a read it takes itself: two people editing the same term from the same
 * starting version would then both succeed, and the later write would silently
 * erase the earlier one (20.3's optimistic concurrency, applied to the row the
 * user actually looked at).
 *
 *  - `{ state: 'absent' }` — "there was no amount starting this date". Insert;
 *    if one now exists, `CONFLICT_DUPLICATE`.
 *  - `{ state: 'version', version }` — "there was this exact row". Update it;
 *    a different version or a vanished row is a conflict, never an insert.
 */
export const termExpectation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }),
  z.object({ state: z.literal('version'), version: z.number().int().positive() }),
]);

export const setTemplateTermInput = z.object({
  templateId: z.uuid(),
  effectiveFrom: plainDate,
  amount: moneyString({ nonNegative: true }),
  grossAmount: moneyString({ nonNegative: true }).optional(),
  note: z.string().trim().max(500).optional(),
  expected: termExpectation,
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
    /**
     * The explicit early-materialization mode, and the only way to accept an
     * occurrence dated after today. The service additionally requires that
     * occurrence to be the next one nothing has resolved (30.10), and fixes its
     * financial date to today.
     */
    receivedToday: z.boolean().optional(),
    /** "This month only": overrides the term for this occurrence alone. */
    amount: moneyString({ nonNegative: true }).optional(),
    /**
     * The gross figure for this occurrence alone, in three deliberate states.
     *
     * Omitted inherits the term's gross, which is what every caller before this
     * field did; an amount states this occurrence's own gross; and `null` states
     * that it had none. The third state exists because inheriting a term's gross
     * beside an overridden net produces a pair the user never agreed to — the
     * same nullable shape `updateIncomeEntryInput` already uses, so a gross can
     * be stated once rather than corrected afterwards.
     *
     * Income templates only: `expense_entries` has no gross column, so the
     * service refuses an explicit gross on an expense source rather than
     * dropping a stated financial value.
     */
    grossAmount: moneyString({ nonNegative: true }).nullable().optional(),
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
