import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bulkHistoryInput,
  correctionInput,
  endOfMonth,
  flowInput,
  isMonthEnd,
  plainDateNotAfter,
  positionInput,
  valuationDateSchema,
} from '../src/index';

/**
 * Property 17, the validator half (blueprint 21.2 item 17, M5, R15; 25 Phase 3
 * "Testing"): "every validator rejects future-dated actuals and refuses
 * `month_end` precision unless `today > end(M)`".
 *
 * Every run draws a `today` between 2020 and 2030 and dates up to two years
 * either side of it, and asks each input schema that carries the date of an
 * **actual** record whether it accepts that date. The schemas are listed below
 * from a search of `src/inputs` for `plainDateNotAfter`, `valuationDateSchema`
 * and `plainDate`, so the list is every date field an input accepts:
 *
 *  - balances: a valuation recorded or corrected, a new account's opening
 *    balance, an other asset's current value, and the balance a correction
 *    draft records or corrects;
 *  - income: an entry created or corrected, an accepted occurrence's financial
 *    date, and the same three in a correction draft;
 *  - expenses: an entry created or corrected, and both in a correction draft;
 *  - transfers and their fees: created or corrected, the fee's own date
 *    included, and both in a correction draft;
 *  - Bulk History: every cell lies in a month that has ended;
 *  - the position facts that are actual too: the day an account opened or
 *    closed, and an other asset's acquisition date when it is created.
 *
 * Not actuals, and deliberately unbounded by today (30.9 item 2, 6.2): a
 * recurring schedule's start and end, a term's effective date, and an
 * occurrence date, which is the schedule's identity — accepting October's
 * salary "received today" on 30 September needs it.
 *
 * Two rules sit in the services instead, which check every date again
 * ("neither layer trusts the other", `src/inputs/flows.ts`): a correction
 * draft's balance is judged on `month_end` by the resolver every balance write
 * goes through, and an other asset's acquisition date on update by the
 * positions service. The application suite proves the first exhaustively in
 * `test/unit/no-future-dates.test.ts`.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const RUNS = { numRuns: 300 };

/** ISO dates by day number, so every run reaches any day without a calendar library. */
const dayOf = (n: number): string => new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const dayAfter = (date: string): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const todayArb = fc.integer({ min: 0, max: 3_652 });
/** A day up to two years either side of today, the day itself and the month ends included. */
const scenarioArb = fc
  .tuple(todayArb, fc.integer({ min: -730, max: 730 }), fc.boolean())
  .map(([today, offset, snapToMonthEnd]) => {
    const date = dayOf(today + offset);
    return { today: dayOf(today), date: snapToMonthEnd ? endOfMonth(date) : date };
  });

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

/** A schema built from `today`, and an otherwise valid request whose one actual date is `date`. */
interface DatedInput {
  readonly name: string;
  readonly accepts: (today: string, date: string) => boolean;
}

const fee = (date: string) => ({ amount: '1.50', cashPositionId: ID, incurredOn: date });

const ACTUAL_DATES: readonly DatedInput[] = [
  // Balances.
  {
    name: 'createValuationInput, an exact balance',
    accepts: (today, date) =>
      accepts(positionInput.createValuationInput(today), {
        positionId: ID,
        amount: '10.00',
        valuedOn: date,
        datePrecision: 'exact',
      }),
  },
  {
    name: 'updateValuationInput, an exact balance',
    accepts: (today, date) =>
      accepts(positionInput.updateValuationInput(today), {
        valuationId: ID,
        expectedVersion: 1,
        amount: '10.00',
        valuedOn: date,
        datePrecision: 'exact',
      }),
  },
  {
    name: 'createCashAccountInput, the opening balance',
    accepts: (today, date) =>
      accepts(positionInput.createCashAccountInput(today), {
        name: 'BBVA',
        currency: 'EUR',
        accountType: 'checking',
        openingBalance: '10.00',
        openingBalanceOn: date,
        origin: 'existing',
      }),
  },
  {
    name: 'createOtherAssetInput, the current value',
    accepts: (today, date) =>
      accepts(positionInput.createOtherAssetInput(today), {
        name: 'Car',
        currency: 'EUR',
        assetType: 'vehicle',
        currentValue: '10.00',
        currentValueOn: date,
      }),
  },
  {
    name: 'correctionDraft valuation_create',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'valuation_create',
        positionId: ID,
        valuedOn: date,
        amount: '10.00',
        datePrecision: 'exact',
      }),
  },
  {
    name: 'correctionDraft valuation_update',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'valuation_update',
        valuationId: ID,
        expectedVersion: 1,
        valuedOn: date,
        amount: '10.00',
        datePrecision: 'exact',
      }),
  },

  // Income.
  {
    name: 'createIncomeEntryInput',
    accepts: (today, date) =>
      accepts(flowInput.createIncomeEntryInput(today), {
        kind: 'employment',
        receivedOn: date,
        netAmount: '10.00',
        currency: 'EUR',
      }),
  },
  {
    name: 'updateIncomeEntryInput',
    accepts: (today, date) =>
      accepts(flowInput.updateIncomeEntryInput(today), { entryId: ID, expectedVersion: 1, receivedOn: date }),
  },
  {
    name: 'acceptSuggestionInput, the financial date',
    accepts: (today, date) =>
      accepts(flowInput.acceptSuggestionInput(today), {
        templateId: ID,
        occurrenceDate: today,
        financialDate: date,
      }),
  },
  {
    name: 'correctionDraft income_create',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'income_create',
        incomeKind: 'employment',
        receivedOn: date,
        netAmount: '10.00',
        currency: 'EUR',
      }),
  },
  {
    name: 'correctionDraft income_update',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'income_update',
        entryId: ID,
        expectedVersion: 1,
        receivedOn: date,
      }),
  },
  {
    name: 'correctionDraft accept_suggestion, the financial date',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'accept_suggestion',
        templateId: ID,
        occurrenceDate: today,
        financialDate: date,
      }),
  },

  // Expenses.
  {
    name: 'createExpenseEntryInput',
    accepts: (today, date) =>
      accepts(flowInput.createExpenseEntryInput(today), {
        categoryId: ID,
        incurredOn: date,
        amount: '10.00',
        currency: 'EUR',
      }),
  },
  {
    name: 'updateExpenseEntryInput',
    accepts: (today, date) =>
      accepts(flowInput.updateExpenseEntryInput(today), { entryId: ID, expectedVersion: 1, incurredOn: date }),
  },
  {
    name: 'correctionDraft expense_create',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'expense_create',
        categoryId: ID,
        incurredOn: date,
        amount: '10.00',
        currency: 'EUR',
      }),
  },
  {
    name: 'correctionDraft expense_update',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'expense_update',
        entryId: ID,
        expectedVersion: 1,
        incurredOn: date,
      }),
  },

  // Transfers and their fees.
  {
    name: 'createTransferInput, the transfer',
    accepts: (today, date) =>
      accepts(flowInput.createTransferInput(today), {
        occurredOn: date,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
      }),
  },
  {
    name: 'createTransferInput, its fee',
    accepts: (today, date) =>
      accepts(flowInput.createTransferInput(today), {
        occurredOn: today,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        fee: fee(date),
      }),
  },
  {
    name: 'updateTransferInput, the transfer',
    accepts: (today, date) =>
      accepts(flowInput.updateTransferInput(today), {
        transferId: ID,
        expectedVersion: 1,
        occurredOn: date,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        description: null,
        fee: null,
        expectedFee: { state: 'absent' },
      }),
  },
  {
    name: 'updateTransferInput, its fee',
    accepts: (today, date) =>
      accepts(flowInput.updateTransferInput(today), {
        transferId: ID,
        expectedVersion: 1,
        occurredOn: today,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        description: null,
        fee: fee(date),
        expectedFee: { state: 'absent' },
      }),
  },
  {
    name: 'correctionDraft transfer_create, the transfer',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'transfer_create',
        occurredOn: date,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
      }),
  },
  {
    name: 'correctionDraft transfer_create, its fee',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'transfer_create',
        occurredOn: today,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        fee: fee(date),
      }),
  },
  {
    name: 'correctionDraft transfer_update, the transfer',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'transfer_update',
        transferId: ID,
        expectedVersion: 1,
        occurredOn: date,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        description: null,
        fee: null,
        expectedFee: { state: 'absent' },
      }),
  },
  {
    name: 'correctionDraft transfer_update, its fee',
    accepts: (today, date) =>
      accepts(correctionInput.correctionDraft(today), {
        kind: 'transfer_update',
        transferId: ID,
        expectedVersion: 1,
        occurredOn: today,
        fromPositionId: ID,
        toPositionId: OTHER_ID,
        fromAmount: '10.00',
        toAmount: '10.00',
        description: null,
        fee: fee(date),
        expectedFee: { state: 'absent' },
      }),
  },

  // The position facts that are actual too.
  {
    name: 'createCashAccountInput, the day a new account opened',
    accepts: (today, date) =>
      accepts(positionInput.createCashAccountInput(today), {
        name: 'BBVA',
        currency: 'EUR',
        accountType: 'checking',
        origin: 'new',
        openedOn: date,
      }),
  },
  {
    name: 'createOtherAssetInput, the acquisition date',
    accepts: (today, date) =>
      accepts(positionInput.createOtherAssetInput(today), {
        name: 'Car',
        currency: 'EUR',
        assetType: 'vehicle',
        acquisitionDate: date,
      }),
  },
  {
    name: 'closePositionInput, the closing day',
    accepts: (today, date) =>
      accepts(positionInput.closePositionInput(today), { positionId: ID, expectedVersion: 1, closedOn: date }),
  },
];

describe('property 17: every validator rejects a future-dated actual', () => {
  it('plainDateNotAfter, the rule every actual date is built from', () => {
    fc.assert(
      fc.property(scenarioArb, ({ today, date }) => {
        expect(accepts(plainDateNotAfter(today), date)).toBe(date <= today);
      }),
      RUNS,
    );
  });

  it.each(ACTUAL_DATES.map((input) => [input.name, input] as const))('%s', (_, input) => {
    fc.assert(
      fc.property(scenarioArb, ({ today, date }) => {
        // Today itself is allowed; the day after it never is.
        expect(input.accepts(today, date), `today ${today}, date ${date}`).toBe(date <= today);
      }),
      RUNS,
    );
  });
});

describe('property 17: month_end precision only once the month has ended', () => {
  /** R15, M5: never after today, the month's last day, and `today > end(M)`. */
  const allowed = (today: string, date: string, precision: 'exact' | 'month_end'): boolean =>
    date <= today && (precision === 'exact' || (isMonthEnd(date) && today > date));

  const precisionArb = fc.constantFrom('exact' as const, 'month_end' as const);

  it('valuationDateSchema', () => {
    fc.assert(
      fc.property(scenarioArb, precisionArb, ({ today, date }, precision) => {
        expect(accepts(valuationDateSchema(today), { valuedOn: date, datePrecision: precision })).toBe(
          allowed(today, date, precision),
        );
      }),
      RUNS,
    );
  });

  it('createValuationInput and updateValuationInput', () => {
    fc.assert(
      fc.property(scenarioArb, precisionArb, ({ today, date }, precision) => {
        const expected = allowed(today, date, precision);
        expect(
          accepts(positionInput.createValuationInput(today), {
            positionId: ID,
            amount: '10.00',
            valuedOn: date,
            datePrecision: precision,
          }),
        ).toBe(expected);
        expect(
          accepts(positionInput.updateValuationInput(today), {
            valuationId: ID,
            expectedVersion: 1,
            amount: '10.00',
            valuedOn: date,
            datePrecision: precision,
          }),
        ).toBe(expected);
      }),
      RUNS,
    );
  });

  it('refuses a statement on the month’s own last day, and takes it from the next day on', () => {
    // The boundary 21.1 names: on 30 September a September statement is refused,
    // on 1 October it is accepted. Here for every month of every year drawn.
    fc.assert(
      fc.property(todayArb, (n) => {
        const lastDay = endOfMonth(dayOf(n));
        const nextDay = dayAfter(lastDay);
        const statement = { valuedOn: lastDay, datePrecision: 'month_end' };
        expect(accepts(valuationDateSchema(lastDay), statement)).toBe(false);
        expect(accepts(valuationDateSchema(nextDay), statement)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('property 17: Bulk History edits only months that have ended', () => {
  const monthArb = fc.tuple(todayArb, fc.integer({ min: -30, max: 30 })).map(([today, monthsOffset]) => {
    const base = new Date(Date.UTC(2020, 0, 1) + today * 86_400_000);
    const cell = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthsOffset, 1));
    return { today: dayOf(today), month: cell.toISOString().slice(0, 7) };
  });

  it('accepts a balance cell exactly when its month is over, so its month end is before today', () => {
    fc.assert(
      fc.property(monthArb, ({ today, month }) => {
        const accepted = accepts(bulkHistoryInput.bulkHistoryDraft(today), {
          kind: 'bulk_history',
          startMonth: month,
          operations: [{ kind: 'valuation_create', positionId: ID, month, amount: '10' }],
        });
        expect(accepted).toBe(month < today.slice(0, 7));
        // The balance it would write is that month's statement, dated its last day.
        if (accepted) expect(endOfMonth(`${month}-01`) < today).toBe(true);
      }),
      RUNS,
    );
  });

  it('accepts an income cell exactly when its occurrence’s month is over', () => {
    fc.assert(
      fc.property(monthArb, fc.integer({ min: 1, max: 28 }), ({ today, month }, day) => {
        const occurrenceDate = `${month}-${String(day).padStart(2, '0')}`;
        const accepted = accepts(bulkHistoryInput.bulkHistoryDraft(today), {
          kind: 'bulk_history',
          startMonth: month,
          operations: [{ kind: 'income_create', templateId: ID, occurrenceDate, netAmount: '10' }],
        });
        expect(accepted).toBe(month < today.slice(0, 7));
        if (accepted) expect(occurrenceDate < today).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('property 17: a schedule’s identity is not an actual', () => {
  it('lets an occurrence date lie after today while its money may not', () => {
    // 30.9 item 2: "received today" on 30 September records the 1 October
    // occurrence. The occurrence date is the schedule's identity; only the
    // financial date is a fact about money, and only it is bound by today.
    fc.assert(
      fc.property(scenarioArb, ({ today, date }) => {
        const input = flowInput.acceptSuggestionInput(today);
        expect(accepts(input, { templateId: ID, occurrenceDate: date, receivedToday: true })).toBe(true);
        expect(accepts(input, { templateId: ID, occurrenceDate: date, financialDate: date })).toBe(date <= today);
      }),
      RUNS,
    );
  });
});
