import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { plainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import {
  CATEGORY_KINDS,
  EXPENSE_SETTLEMENTS,
  INCOME_KINDS,
  INCOME_SETTLEMENTS,
  expenseLeg,
  expenseRole,
  incomeLeg,
  incomeRole,
  transferLegs,
  type CategoryKind,
  type FlowRole,
  type ExpenseFlow,
  type IncomeFlow,
  type TransferFlow,
} from '../src/flows/index';
import { isExternalIncomeKind } from '../src/savings/index';

/**
 * The role matrix of 7.4, pinned exhaustively.
 *
 * Every one of these assertions is a sentence from the blueprint turned into a
 * test, and the exhaustive loops exist so a value added to a closed set later
 * cannot slip through unclassified.
 */

const EUR = currencyCode('EUR');
const ON = plainDate('2026-09-15');

function income(over: Partial<IncomeFlow> = {}): IncomeFlow {
  return {
    id: 'i1',
    kind: 'employment',
    receivedOn: ON,
    netAmount: new Decimal('2100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: 'bbva',
    ...over,
  };
}

function expense(over: Partial<ExpenseFlow> = {}): ExpenseFlow {
  return {
    id: 'e1',
    categoryKind: 'insurance',
    incurredOn: ON,
    amount: new Decimal('300'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: 'bbva',
    ...over,
  };
}

describe('income roles', () => {
  it('makes ordinary tracked income the external inflow I', () => {
    for (const kind of ['employment', 'freelance', 'bonus', 'rental', 'other', 'dividend', 'interest'] as const) {
      expect(incomeRole(kind, 'tracked_cash'), kind).toBe('I');
    }
  });

  it('makes external_inflow and adjustment I as well, like every tracked-cash kind', () => {
    // 7.4 gives both their own row with the cash role `I`. They are cash that
    // arrived from outside the tracked system, and the identity needs them to
    // explain the balance — which is the whole reason `adjustment` exists.
    // Whether an arrival is *income* is 12.5's separate question, answered by
    // `isExternalIncomeKind`, which turns exactly these two away.
    expect(incomeRole('external_inflow', 'tracked_cash')).toBe('I');
    expect(incomeRole('adjustment', 'tracked_cash')).toBe('I');
    expect(isExternalIncomeKind('external_inflow')).toBe(false);
    expect(isExternalIncomeKind('adjustment')).toBe(false);
  });

  it('gives every tracked-cash income kind the same cash role', () => {
    for (const kind of INCOME_KINDS) {
      expect(incomeRole(kind, 'tracked_cash'), kind).toBe('I');
    }
  });

  it('gives income that never reached tracked cash no cash role', () => {
    for (const kind of INCOME_KINDS) {
      expect(incomeRole(kind, 'external'), kind).toBe('none');
      expect(incomeRole(kind, 'reinvested'), kind).toBe('none');
    }
  });

  it('classifies every kind and settlement combination', () => {
    for (const kind of INCOME_KINDS) {
      for (const settlement of INCOME_SETTLEMENTS) {
        expect(['I', 'Nin', 'none']).toContain(incomeRole(kind, settlement));
      }
    }
  });

  it('carries the amount, currency, account and date onto the leg', () => {
    const leg = incomeLeg(income());
    expect(leg).toMatchObject({ role: 'I', currency: 'EUR', cashPositionId: 'bbva', on: ON });
    expect(leg?.amount.toString()).toBe('2100');
  });

  it('emits no leg for income with no cash role', () => {
    expect(incomeLeg(income({ settlement: 'external', cashPositionId: null }))).toBeUndefined();
  });

  it('keeps a null cash leg on a tracked flow rather than dropping it', () => {
    // 8.1: a tracked flow with no account still belongs to its currency bucket.
    const leg = incomeLeg(income({ cashPositionId: null }));
    expect(leg?.role).toBe('I');
    expect(leg?.cashPositionId).toBeNull();
  });
});

describe('expense roles', () => {
  it('makes every ordinary tracked expense the known outflow K', () => {
    for (const categoryKind of CATEGORY_KINDS) {
      if (categoryKind === 'capital_improvement') continue;
      expect(expenseRole(categoryKind, 'tracked_cash'), categoryKind).toBe('K');
    }
  });

  it('makes a capital improvement Nout, because capex is not spending', () => {
    expect(expenseRole('capital_improvement', 'tracked_cash')).toBe('Nout');
  });

  it('gives untracked_self and third_party no role in tracked reconciliation', () => {
    for (const categoryKind of CATEGORY_KINDS) {
      expect(expenseRole(categoryKind, 'untracked_self'), categoryKind).toBe('none');
      expect(expenseRole(categoryKind, 'third_party'), categoryKind).toBe('none');
    }
  });

  it('classifies every category kind and settlement combination', () => {
    for (const categoryKind of CATEGORY_KINDS) {
      for (const settlement of EXPENSE_SETTLEMENTS) {
        expect(['K', 'Nout', 'none']).toContain(expenseRole(categoryKind, settlement));
      }
    }
  });

  it('gives every Phase 3 category kind the cash role 7.4 assigns it', () => {
    // Named one by one rather than only swept by the loop above, because these
    // are the branches that decide whether a cost lands in tracked spending.
    // 7.4 puts `external_outflow` in K — it is cash that left and which we can
    // name, and 12.5 then decomposes `TrackedTotalSpending` into
    // `Consumption + PropertyOperatingCosts + InterestAndFees +
    // TransactionCosts + ExternalOutflows`, so moving it to Nout would take it
    // out of tracked spending and break that identity. What keeps it out of
    // *consumption* is its bucket, not its cash role.
    const expected: [CategoryKind, FlowRole][] = [
      ['general', 'K'],
      ['food', 'K'],
      ['tax', 'K'],
      ['property_operating', 'K'],
      ['investment_fee', 'K'],
      ['transfer_fee', 'K'],
      ['acquisition_cost', 'K'],
      ['disposal_cost', 'K'],
      ['external_outflow', 'K'],
      ['capital_improvement', 'Nout'],
    ];
    for (const [categoryKind, role] of expected) {
      expect(expenseRole(categoryKind, 'tracked_cash'), categoryKind).toBe(role);
    }
  });

  it('treats a transfer fee as an ordinary known expense', () => {
    // M14: the fee has exactly one representation, this row. There is no second
    // fee value hidden on the transfer, so it cannot be counted twice.
    const leg = expenseLeg(expense({ categoryKind: 'transfer_fee', transferId: 't1', amount: new Decimal('12') }));
    expect(leg?.role).toBe('K');
    expect(leg?.amount.toString()).toBe('12');
  });
});

describe('transfer legs', () => {
  function transfer(over: Partial<TransferFlow> = {}): TransferFlow {
    return {
      id: 't1',
      kind: 'cash_transfer',
      occurredOn: ON,
      fromPositionId: 'bbva',
      fromCurrency: EUR,
      fromAmount: new Decimal('200'),
      toPositionId: 'savings',
      toCurrency: EUR,
      toAmount: new Decimal('200'),
      ...over,
    };
  }

  it('is Nout on the source and Nin on the destination, never income or spending', () => {
    const legs = transferLegs(transfer());
    expect(legs.map((leg) => leg.role)).toEqual(['Nout', 'Nin']);
    expect(legs.some((leg) => leg.role === 'I' || leg.role === 'K')).toBe(false);
  });

  it('cancels within one currency bucket', () => {
    const legs = transferLegs(transfer());
    const [out, into] = legs;
    expect(out?.currency).toBe(into?.currency);
    expect(out?.amount.toString()).toBe(into?.amount.toString());
  });

  it('keeps both native amounts across currencies', () => {
    // Each bucket reconciles on its own; neither sees an FX effect (8.8).
    const legs = transferLegs(
      transfer({
        toCurrency: currencyCode('USD'),
        toAmount: new Decimal('216.45'),
      }),
    );
    expect(legs[0]).toMatchObject({ role: 'Nout', currency: 'EUR' });
    expect(legs[0]?.amount.toString()).toBe('200');
    expect(legs[1]).toMatchObject({ role: 'Nin', currency: 'USD' });
    expect(legs[1]?.amount.toString()).toBe('216.45');
  });

  it('emits nothing when a transfer has no endpoint at all', () => {
    expect(transferLegs(transfer({ fromPositionId: null, toPositionId: null }))).toEqual([]);
  });

  it('keeps a null-legged side in its stated currency bucket', () => {
    const legs = transferLegs(transfer({ fromPositionId: null }));
    expect(legs[0]).toMatchObject({ role: 'Nout', cashPositionId: null, currency: 'EUR' });
  });
});

describe('the closed sets finance mirrors', () => {
  it('holds every category kind exactly once', () => {
    expect(new Set(CATEGORY_KINDS).size).toBe(CATEGORY_KINDS.length);
  });

  it('names the seven system kinds among them', () => {
    const system: CategoryKind[] = [
      'property_operating',
      'investment_fee',
      'transfer_fee',
      'acquisition_cost',
      'disposal_cost',
      'capital_improvement',
      'external_outflow',
    ];
    for (const kind of system) expect(CATEGORY_KINDS).toContain(kind);
  });
});
