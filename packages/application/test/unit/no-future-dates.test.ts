import { describe, expect, it } from 'vitest';
import { addDays, endOfMonth, isMonthEnd, plainDate, type PlainDate } from '@vaultide/finance';
import type { PositionRecord as PositionRow, RecurringTemplateRow } from '@vaultide/db';
import { ValidationError } from '../../src/errors';
import { assertValuationAllowed } from '../../src/positions/valuations';
import { assertNotFuture } from '../../src/flows/shared';
import { decideAcceptance } from '../../src/recurring/suggestions';

/**
 * Property 17, the server's half (blueprint 21.2 item 17, 21.4, M5, R15): the
 * date rules the services apply again after the input schemas, swept
 * exhaustively rather than sampled.
 *
 * The schemas are only the first layer. The services check every actual's date
 * themselves, and one rule exists only here: a correction draft's balance is
 * judged on `month_end` by `assertValuationAllowed`, which every balance
 * resolver calls — the ordinary write, the correction preview and Historical
 * Confirm alike — so a statement for a month that has not ended is refused on
 * every path a balance can take. The schemas' half is the generative property
 * in `packages/validation/test/no-future-dates.property.test.ts`.
 *
 * Every `today` from December 2025 to February 2027 — fourteen month ends, a
 * year end and February — is paired with every date six weeks either side of
 * it. The oracle is the rule as R15 states it, written out independently of the
 * code under test.
 */

const FIRST_TODAY = plainDate('2025-12-01');
const LAST_TODAY = plainDate('2027-02-28');
const REACH = 42;
const CREATED = new Date('2025-01-01T00:00:00Z');

function* days(from: PlainDate, to: PlainDate): Generator<PlainDate> {
  for (let day = from; day <= to; day = addDays(day, 1)) yield day;
}

/** Every `(today, date)` pair the sweep visits. */
function* pairs(): Generator<{ readonly today: PlainDate; readonly date: PlainDate }> {
  for (const today of days(FIRST_TODAY, LAST_TODAY)) {
    for (const date of days(addDays(today, -REACH), addDays(today, REACH))) yield { today, date };
  }
}

/** True when `run` throws the service's own `ValidationError`, false when it returns. */
function refuses(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    if (error instanceof ValidationError) return true;
    throw error;
  }
}

const cash: PositionRow = {
  id: 'pos-cash',
  userId: 'user-1',
  kind: 'cash',
  name: 'BBVA',
  currency: 'EUR',
  status: 'active',
  openedOn: null,
  closedOn: null,
  notes: null,
  sortOrder: 0,
  version: 1,
  createdAt: CREATED,
  accountType: 'checking',
  institution: null,
  isDormant: false,
  dormantFrom: null,
};

const salary: RecurringTemplateRow = {
  id: 'tpl-1',
  userId: 'user-1',
  kind: 'income',
  name: 'Salary',
  counterparty: null,
  incomeKind: 'employment',
  categoryId: null,
  currency: 'EUR',
  frequency: 'monthly',
  dayOfMonth: 25,
  startDate: '2025-01-25',
  endDate: null,
  cashPositionId: 'pos-cash',
  cashPositionKind: 'cash',
  propertyPositionId: null,
  propertyPositionKind: null,
  targetInvestmentPositionId: null,
  targetInvestmentPositionKind: null,
  archivedAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 1,
};

describe('property 17, swept: the services refuse what the schemas would', () => {
  it('visits a statement-bearing day in both directions', () => {
    // The sweep is only worth its cost if it reaches the boundary 21.1 names:
    // a month's last day as today (refused) and the day after it (accepted).
    const visited = [...pairs()];
    expect(visited.some(({ today, date }) => date === today && isMonthEnd(date))).toBe(true);
    expect(visited.some(({ today, date }) => isMonthEnd(date) && addDays(date, 1) === today)).toBe(true);
    expect(visited.length).toBe(455 * (2 * REACH + 1));
  });

  it('refuses a balance after today, and a statement unless its month has ended', () => {
    let statementsAccepted = 0;
    for (const { today, date } of pairs()) {
      for (const datePrecision of ['exact', 'month_end'] as const) {
        // R15 and M5: never after today; a statement on its month's last day,
        // and only once `today > end(M)`.
        const allowed =
          date <= today && (datePrecision === 'exact' || (date === endOfMonth(date) && today > date));
        const refused = refuses(() => assertValuationAllowed(today, cash, { valuedOn: date, amount: '10', datePrecision }));
        expect(refused, `${datePrecision} ${date}, today ${today}`).toBe(!allowed);
        if (datePrecision === 'month_end' && !refused) statementsAccepted += 1;
      }
    }
    expect(statementsAccepted).toBeGreaterThan(0);
  });

  it('refuses an income, an expense, a transfer or a fee dated after today', () => {
    // The one check the income, expense and transfer services — the fee's own
    // date included — make of every financial date they write.
    for (const { today, date } of pairs()) {
      expect(refuses(() => { assertNotFuture({ today }, date, 'date'); }), `${date}, today ${today}`).toBe(date > today);
    }
  });

  it('accepts an occurrence only as money dated today or before', () => {
    for (const { today, date } of pairs()) {
      // Ordinary acceptance of an occurrence: its money is dated the
      // occurrence, or the day the user says, and neither may be after today.
      const ordinary = (): { financialDate: string } =>
        decideAcceptance(today, salary, { templateId: 'tpl-1', occurrenceDate: date });
      expect(refuses(ordinary), `occurrence ${date}, today ${today}`).toBe(date > today);
      if (date <= today) expect(ordinary().financialDate).toBe(date);

      // "Received today" (30.10): a future occurrence, recorded as money that
      // arrived today and on no other day.
      if (date > today) {
        expect(
          decideAcceptance(today, salary, { templateId: 'tpl-1', occurrenceDate: date, receivedToday: true })
            .financialDate,
        ).toBe(today);
        expect(
          refuses(() =>
            decideAcceptance(today, salary, {
              templateId: 'tpl-1',
              occurrenceDate: date,
              receivedToday: true,
              financialDate: addDays(today, -1),
            }),
          ),
        ).toBe(true);
      }

      // A financial date stated for a past occurrence is bound by today too.
      expect(
        refuses(() =>
          decideAcceptance(today, salary, { templateId: 'tpl-1', occurrenceDate: addDays(today, -REACH), financialDate: date }),
        ),
        `financial ${date}, today ${today}`,
      ).toBe(date > today);
    }
  });
});
