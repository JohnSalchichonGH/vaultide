import { describe, expect, it } from 'vitest';
import { plainDate } from '@vaultide/finance';
import {
  classifyHistorical,
  financialDateOf,
  periodOf,
  sourcePeriodsOf,
} from '../../src/corrections/classify';
import {
  created,
  deleted,
  dormancyChange,
  updated,
  type DormancyEffect,
  type ExpenseSourceFacts,
  type IdentifiedSourceChange,
  type IncomeSourceFacts,
  type ResolvedWrite,
  type TransferSourceFacts,
  type ValuationSourceFacts,
} from '../../src/write-plan';

/**
 * What a Historical Correction is (blueprint 30.22 items 1 and 2; ADR 0010 §1).
 *
 * The rule is pure — it judges a resolved write, and nothing else — so it is
 * tested as the pure function it is, over every combination the product can
 * produce. The same function is what the server guard calls before an ordinary
 * write and what Preview calls to decide whether a ceremony is needed, so a
 * case proved here is proved for both.
 *
 * `today` is 15 September 2026 throughout: August and earlier are completed,
 * September is current, and nothing may be dated later.
 */

const TODAY = plainDate('2026-09-15');

const income = (receivedOn: string, overrides: Partial<IncomeSourceFacts> = {}): IncomeSourceFacts => ({
  kind: 'income',
  incomeKind: 'employment',
  receivedOn,
  netAmount: '1000',
  grossAmount: null,
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-1',
  description: null,
  templateId: null,
  occurrenceDate: null,
  ...overrides,
});

const expense = (incurredOn: string, overrides: Partial<ExpenseSourceFacts> = {}): ExpenseSourceFacts => ({
  kind: 'expense',
  categoryId: 'cat-1',
  categoryKind: 'consumption',
  incurredOn,
  amount: '25',
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-1',
  description: null,
  transferId: null,
  templateId: null,
  occurrenceDate: null,
  ...overrides,
});

const transfer = (occurredOn: string): TransferSourceFacts => ({
  kind: 'transfer',
  occurredOn,
  fromPositionId: 'pos-1',
  fromCurrency: 'EUR',
  fromAmount: '200',
  toPositionId: 'pos-2',
  toCurrency: 'EUR',
  toAmount: '200',
  description: null,
});

const valuation = (valuedOn: string): ValuationSourceFacts => ({
  kind: 'valuation',
  positionId: 'pos-1',
  valuedOn,
  amount: '500',
  currency: 'EUR',
  datePrecision: 'month_end',
  note: null,
});

const entryIdentity = { scope: 'existing', kind: 'income', id: 'row-1' } as const;
const expenseIdentity = { scope: 'existing', kind: 'expense', id: 'row-2' } as const;
const transferIdentity = { scope: 'existing', kind: 'transfer', id: 'row-3' } as const;
const valuationIdentity = { scope: 'existing', kind: 'valuation', id: 'row-4' } as const;
const prospectiveFee = {
  scope: 'prospective',
  kind: 'expense',
  role: 'transfer_fee',
  owner: 'row-3',
} as const;

function write(
  revision: boolean,
  changes: readonly IdentifiedSourceChange[],
  dormancy: readonly DormancyEffect[] = [],
): ResolvedWrite {
  return { revision, changes, dormancy, support: [] };
}

const dormant = (
  before: { isDormant: boolean; dormantFrom: string | null },
  after: { isDormant: boolean; dormantFrom: string | null },
  via: DormancyEffect['via'] = 'clear',
): DormancyEffect => ({ positionId: 'pos-1', before, after, via });

const AWAKE = { isDormant: false, dormantFrom: null };

describe('a revision of a source fact (30.22 item 1)', () => {
  it.each([
    ['completed -> completed', '2026-08-10', '2026-08-20', true],
    ['completed -> current', '2026-08-10', '2026-09-05', true],
    ['current -> completed', '2026-09-05', '2026-08-10', true],
    ['current -> current', '2026-09-05', '2026-09-09', false],
  ])('%s is a correction: %s', (_label, before, after, expected) => {
    const result = classifyHistorical(
      write(true, [updated(entryIdentity, income(before), income(after))]),
      TODAY,
    );
    expect(result.required).toBe(expected);
    if (expected) expect(result.reasons).toEqual(['completed_source_revision']);
  });

  it('a delete out of a completed month is a correction, and out of the current one is not', () => {
    expect(
      classifyHistorical(write(true, [deleted(entryIdentity, income('2026-08-10'))]), TODAY).required,
    ).toBe(true);
    expect(
      classifyHistorical(write(true, [deleted(entryIdentity, income('2026-09-10'))]), TODAY).required,
    ).toBe(false);
  });

  it('names the completed periods it found, once each and in order', () => {
    const result = classifyHistorical(
      write(true, [
        updated(entryIdentity, income('2026-07-01'), income('2026-08-01')),
        deleted(expenseIdentity, expense('2026-07-20')),
      ]),
      TODAY,
    );
    expect(result.completedPeriods).toEqual(['2026-07', '2026-08']);
  });
});

describe('a single historical creation (30.22 item 2)', () => {
  it('is a first assertion, whatever month it lands in', () => {
    const result = classifyHistorical(
      write(false, [created(entryIdentity, income('2026-03-04'))]),
      TODAY,
    );
    expect(result.required).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('is still a first assertion when it materializes a scheduled occurrence', () => {
    const facts = income('2026-08-25', { templateId: 'tpl-1', occurrenceDate: '2026-08-25' });
    expect(classifyHistorical(write(false, [created(entryIdentity, facts)]), TODAY).required).toBe(
      false,
    );
  });
});

describe('a dormancy transition (30.22 item 1)', () => {
  it('reaching completed history is a correction whatever else the write was doing', () => {
    // A creation: a first assertion by rule 1, and a rewrite of somebody's
    // earlier dormancy assertion by rule 2.
    const effect = dormant({ isDormant: true, dormantFrom: '2026-06-30' }, AWAKE);
    const result = classifyHistorical(
      write(false, [created(entryIdentity, income('2026-09-10')), dormancyChange(effect)], [effect]),
      TODAY,
    );
    expect(result.required).toBe(true);
    expect(result.reasons).toEqual(['historical_dormancy']);
    expect(result.completedPeriods).toEqual(['2026-06']);
  });

  it('anchored in the current month is ordinary', () => {
    const effect = dormant(AWAKE, { isDormant: true, dormantFrom: '2026-09-08' }, 'account_update');
    expect(
      classifyHistorical(write(false, [dormancyChange(effect)], [effect]), TODAY).required,
    ).toBe(false);
  });

  it('starting an episode in completed history is a correction', () => {
    const effect = dormant(AWAKE, { isDormant: true, dormantFrom: '2026-07-31' }, 'account_update');
    expect(
      classifyHistorical(write(false, [dormancyChange(effect)], [effect]), TODAY).required,
    ).toBe(true);
  });

  it('moving a completed-history anchor is a correction', () => {
    const effect = dormant(
      { isDormant: true, dormantFrom: '2026-06-30' },
      { isDormant: true, dormantFrom: '2026-07-31' },
      'account_update',
    );
    expect(
      classifyHistorical(write(false, [dormancyChange(effect)], [effect]), TODAY).required,
    ).toBe(true);
  });

  it('is ignored when nothing actually moves — the account form resends the checkbox', () => {
    const effect = dormant(
      { isDormant: true, dormantFrom: '2026-06-30' },
      { isDormant: true, dormantFrom: '2026-06-30' },
      'account_update',
    );
    expect(classifyHistorical(write(false, [], [effect]), TODAY).required).toBe(false);
  });

  it('reports both reasons when a historical revision also wakes a historical episode', () => {
    const effect = dormant({ isDormant: true, dormantFrom: '2026-06-30' }, AWAKE);
    const result = classifyHistorical(
      write(
        true,
        [updated(entryIdentity, income('2026-08-01'), income('2026-08-02')), dormancyChange(effect)],
        [effect],
      ),
      TODAY,
    );
    expect(result.reasons).toEqual(['completed_source_revision', 'historical_dormancy']);
    expect(result.completedPeriods).toEqual(['2026-06', '2026-08']);
  });
});

describe('a transfer aggregate is judged on every date it carries (§14)', () => {
  it('is a correction when the transfer is current and its fee is not', () => {
    const result = classifyHistorical(
      write(true, [
        updated(transferIdentity, transfer('2026-09-02'), transfer('2026-09-02')),
        updated(
          expenseIdentity,
          expense('2026-08-31', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
          expense('2026-08-31', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
        ),
      ]),
      TODAY,
    );
    expect(result.required).toBe(true);
    expect(result.completedPeriods).toEqual(['2026-08']);
  });

  it('is a correction when the transfer is historical and its fee is current', () => {
    const result = classifyHistorical(
      write(true, [
        updated(transferIdentity, transfer('2026-08-15'), transfer('2026-08-15')),
        updated(
          expenseIdentity,
          expense('2026-09-01', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
          expense('2026-09-01', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
        ),
      ]),
      TODAY,
    );
    expect(result.required).toBe(true);
    expect(result.completedPeriods).toEqual(['2026-08']);
  });

  it('counts a fee the correction would add, which has no row yet', () => {
    const result = classifyHistorical(
      write(true, [
        updated(transferIdentity, transfer('2026-09-02'), transfer('2026-09-02')),
        created(
          prospectiveFee,
          expense('2026-08-31', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
        ),
      ]),
      TODAY,
    );
    expect(result.required).toBe(true);
  });

  it('is ordinary when every date the aggregate carries is in the current month', () => {
    const result = classifyHistorical(
      write(true, [
        updated(transferIdentity, transfer('2026-09-02'), transfer('2026-09-03')),
        updated(
          expenseIdentity,
          expense('2026-09-02', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
          expense('2026-09-03', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
        ),
      ]),
      TODAY,
    );
    expect(result.required).toBe(false);
  });
});

describe('source periods (§31)', () => {
  it('come from each fact’s own financial date, both sides, deduplicated and ordered', () => {
    const periods = sourcePeriodsOf(
      write(true, [
        updated(transferIdentity, transfer('2026-09-02'), transfer('2026-09-02')),
        updated(
          expenseIdentity,
          expense('2026-08-31', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
          expense('2026-10-01', { categoryKind: 'transfer_fee', transferId: 'row-3' }),
        ),
      ]),
    );
    expect(periods).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('reads the financial date of each kind, and a dormant episode’s anchor', () => {
    expect(financialDateOf(income('2026-08-01'))).toBe('2026-08-01');
    expect(financialDateOf(expense('2026-08-02'))).toBe('2026-08-02');
    expect(financialDateOf(transfer('2026-08-03'))).toBe('2026-08-03');
    expect(financialDateOf(valuation('2026-08-31'))).toBe('2026-08-31');
    expect(
      financialDateOf({
        kind: 'cash_dormancy',
        positionId: 'pos-1',
        isDormant: true,
        dormantFrom: '2026-08-31',
      }),
    ).toBe('2026-08-31');
    expect(
      financialDateOf({
        kind: 'cash_dormancy',
        positionId: 'pos-1',
        isDormant: false,
        dormantFrom: null,
      }),
    ).toBeNull();
  });

  it('is not the scheduled occurrence date of a materialized flow (§30.9 item 2)', () => {
    // The salary was received on 27 August against the occurrence scheduled for
    // 25 August. The period is the money's date; the occurrence is identity.
    const facts = income('2026-08-27', { templateId: 'tpl-1', occurrenceDate: '2026-08-25' });
    expect(financialDateOf(facts)).toBe('2026-08-27');
  });

  it('a valuation revision is judged on the balance’s own date', () => {
    expect(
      classifyHistorical(
        write(true, [updated(valuationIdentity, valuation('2026-08-31'), valuation('2026-08-31'))]),
        TODAY,
      ).required,
    ).toBe(true);
  });

  it('periodOf takes a date to its month', () => {
    expect(periodOf('2026-08-31')).toBe('2026-08');
    expect(periodOf('2026-01-01')).toBe('2026-01');
  });
});
