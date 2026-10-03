import { z } from 'zod';
import { endOfMonth, monthKey, plainDate } from '../primitives/date';
import { moneyString, type MoneyStringOptions } from '../primitives/money';

/**
 * The Bulk History draft (blueprint 15.3 "Bulk history", 18.1, 20.3; ADR 0011).
 *
 * One save of the history grid, as **intent**: which cells the user changed and
 * the values they typed, with the version of every stored row they changed or
 * cleared. Nothing the server owns travels here — no source, no precision, no
 * income kind, no currency, no settlement, no gross, no dormant state, no term,
 * and no "historical" or "bypass" flag. The operations are strict objects, so a
 * request that names one of those is refused rather than quietly stripped: a
 * browser built from the grid never sends them.
 *
 * Unchanged cells are omitted, and a cell appears **at most once**. A draft
 * naming a cell twice was not built from the grid, so it is refused — never
 * de-duplicated and never read as "the last one wins".
 */

/**
 * The most operations one Bulk History save may carry (ADR 0011 D2).
 *
 * A designed limit, measured rather than guessed, on the 23.1 worst case:
 * at this many operations the request body stays under 50 KB — well inside
 * Next's default one-megabyte server-action body limit — the preview's
 * response stays under 4 MB, and Confirm holds the per-user write mutex for
 * about the time its history window takes to derive, not much longer. ADR 0011
 * records the measurements. It bounds one save, never the history range or the
 * grid: the grid refuses an edit that would go past it, the user saves, and
 * continues.
 */
export const BULK_HISTORY_MAX_OPERATIONS = 250;

const expectedVersion = z.number().int().positive();

/**
 * An amount in its one canonical spelling: no leading zeros, no trailing
 * fractional zeros, no `-0`. The grid parses what was typed or pasted into
 * exactly this form, so `1.50` and `1.5` can never be two different requests
 * for the same cell.
 */
export function isCanonicalDecimal(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u.test(value) && value !== '-0';
}

function canonicalMoney(options: MoneyStringOptions = {}) {
  return moneyString(options).refine(isCanonicalDecimal, 'Send the amount in its canonical form.');
}

const valuationCell = { positionId: z.uuid(), month: monthKey };
const incomeCell = { templateId: z.uuid(), occurrenceDate: plainDate };

export const bulkHistoryOperation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('valuation_create'),
    ...valuationCell,
    amount: canonicalMoney(),
  }),
  z.strictObject({
    kind: z.literal('valuation_update'),
    ...valuationCell,
    valuationId: z.uuid(),
    expectedVersion,
    amount: canonicalMoney(),
  }),
  z.strictObject({
    kind: z.literal('valuation_clear'),
    ...valuationCell,
    valuationId: z.uuid(),
    expectedVersion,
  }),
  z.strictObject({
    kind: z.literal('income_create'),
    ...incomeCell,
    netAmount: canonicalMoney({ nonNegative: true }),
  }),
  z.strictObject({
    kind: z.literal('income_update'),
    ...incomeCell,
    entryId: z.uuid(),
    expectedVersion,
    netAmount: canonicalMoney({ nonNegative: true }),
  }),
  z.strictObject({
    kind: z.literal('income_clear'),
    ...incomeCell,
    entryId: z.uuid(),
    expectedVersion,
  }),
]);

export type BulkHistoryOperationInput = z.infer<typeof bulkHistoryOperation>;

/**
 * The semantic cell an operation is about: a balance at an account's month end,
 * or one scheduled occurrence of an income source. Two operations with the same
 * cell are one cell edited twice.
 */
export function bulkCellKey(operation: BulkHistoryOperationInput): string {
  return 'positionId' in operation
    ? `${operation.positionId}#${endOfMonth(`${operation.month}-01`)}`
    : `${operation.templateId}#${operation.occurrenceDate}`;
}

/** The month of the grid row an operation's cell sits in. */
export function bulkRowMonth(operation: BulkHistoryOperationInput): string {
  return 'month' in operation ? operation.month : operation.occurrenceDate.slice(0, 7);
}

/**
 * The whole draft, judged against `today` in the user's timezone.
 *
 * Every row a save may touch is a **completed** month at or after the grid's
 * first row: the current month's row is disabled (15.3) and nothing later
 * exists. An occurrence is held to its month in the same way, which also keeps
 * a future occurrence out.
 */
export function bulkHistoryDraft(today: string) {
  const currentMonth = today.slice(0, 7);

  return z
    .object({
      kind: z.literal('bulk_history'),
      /** The grid's first row, `YYYY-MM`. */
      startMonth: monthKey,
      operations: z
        .array(bulkHistoryOperation)
        .min(1, 'There is nothing to save.')
        .max(
          BULK_HISTORY_MAX_OPERATIONS,
          `One save can carry at most ${String(BULK_HISTORY_MAX_OPERATIONS)} changed cells. Save these, then continue.`,
        ),
    })
    .superRefine((draft, ctx) => {
      if (draft.startMonth >= currentMonth) {
        ctx.addIssue({
          code: 'custom',
          path: ['startMonth'],
          message: 'The first row has to be a month that has ended.',
        });
      }

      const seen = new Set<string>();
      draft.operations.forEach((operation, index) => {
        const month = bulkRowMonth(operation);
        if (month >= currentMonth) {
          ctx.addIssue({
            code: 'custom',
            path: ['operations', index],
            message: 'Only months that have ended can be edited here.',
          });
        }
        if (month < draft.startMonth) {
          ctx.addIssue({
            code: 'custom',
            path: ['operations', index],
            message: 'That cell is above the first row of this grid.',
          });
        }

        const cell = bulkCellKey(operation);
        if (seen.has(cell)) {
          ctx.addIssue({
            code: 'custom',
            path: ['operations', index],
            message: 'Each cell may appear only once in a save.',
          });
        }
        seen.add(cell);
      });
    });
}
