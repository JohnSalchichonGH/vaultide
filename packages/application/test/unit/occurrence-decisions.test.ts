import { describe, expect, it } from 'vitest';
import { plainDate } from '@vaultide/finance';
import type {
  RecurringTemplateRow,
  RecurringTemplateSkipRow,
  RecurringTemplateTermRow,
} from '@vaultide/db';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
} from '../../src/errors';
import {
  assertClaimableOccurrence,
  assertEarliestUnresolvedOccurrence,
  assertNotMaterialized,
  assertNotSkipped,
  decideAcceptance,
  decideAcceptedAmounts,
} from '../../src/recurring/suggestions';

/**
 * The recurring-occurrence rules, as the pure decisions they now are
 * (blueprint 6.2, 15.3, 20.3, 30.10; §30.9 items 3 and 4).
 *
 * Claiming an occurrence — to accept it or to skip it — and accepting one read
 * the template, its terms, the occurrence's skip, whether a flow carries it,
 * and for a future occurrence what the template has resolved; these functions
 * judge what was read. The ordinary services, the correction preview and
 * Historical Confirm reach them through the same resolver and the same claim;
 * their reads are pinned in `resolution-query-shape.test.ts`, and the services
 * in `flows.test.ts` and the Historical Correction suites.
 *
 * `today` is 5 October 2026.
 */

const TODAY = plainDate('2026-10-05');
const CREATED = new Date('2026-01-01T00:00:00Z');

const template = (overrides: Partial<RecurringTemplateRow> = {}): RecurringTemplateRow => ({
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
  startDate: '2026-01-25',
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
  ...overrides,
});

const term = (effectiveFrom: string, amount: string, grossAmount: string | null = null): RecurringTemplateTermRow => ({
  id: `term-${effectiveFrom}`,
  userId: 'user-1',
  templateId: 'tpl-1',
  effectiveFrom,
  amount,
  grossAmount,
  note: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 1,
});

const skip = (occurrenceDate: string): RecurringTemplateSkipRow => ({
  id: 'skip-1',
  userId: 'user-1',
  templateId: 'tpl-1',
  occurrenceDate,
  reason: 'skipped',
  note: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  version: 1,
});

const accept = (occurrenceDate: string, overrides: Record<string, unknown> = {}) => ({
  templateId: 'tpl-1',
  occurrenceDate,
  ...overrides,
});

describe('claiming an occurrence', () => {
  it('claims a scheduled occurrence of a live template', () => {
    const live = template();
    expect(assertClaimableOccurrence(live, '2026-08-25')).toBe(live);
  });

  it('answers not found for a template that is gone', () => {
    expect(() => assertClaimableOccurrence(undefined, '2026-08-25')).toThrow(NotFoundError);
  });

  it('refuses an archived template, whatever its schedule held', () => {
    const archived = template({ archivedAt: new Date('2026-09-01T00:00:00Z') });
    expect(() => assertClaimableOccurrence(archived, '2026-08-25')).toThrow(ImpossibleOperationError);
  });

  it('refuses a date the schedule does not contain, before its start or after its end', () => {
    expect(() => assertClaimableOccurrence(template(), '2026-08-24')).toThrow(ValidationError);
    expect(() => assertClaimableOccurrence(template(), '2025-12-25')).toThrow(ValidationError);
    const ended = template({ endDate: '2026-06-30' });
    expect(() => assertClaimableOccurrence(ended, '2026-07-25')).toThrow(ValidationError);
    expect(() => assertClaimableOccurrence(ended, '2026-06-25')).not.toThrow();
  });

  it('lets a future occurrence be claimed early only while it is the next one unresolved', () => {
    const resolved = new Set(['2026-09-25']);
    expect(() =>
      assertEarliestUnresolvedOccurrence(template(), '2026-10-25', TODAY, resolved),
    ).not.toThrow();
    expect(() =>
      assertEarliestUnresolvedOccurrence(template(), '2026-11-25', TODAY, resolved),
    ).toThrow(/The next one still to record is 2026-10-25/u);
    expect(() =>
      assertEarliestUnresolvedOccurrence(template(), '2026-11-25', TODAY, new Set(['2026-10-25'])),
    ).not.toThrow();
  });

  it('says so when a source has no upcoming date left to record early', () => {
    const ending = template({ endDate: '2026-09-30' });
    expect(() =>
      assertEarliestUnresolvedOccurrence(ending, '2026-10-25', TODAY, new Set()),
    ).toThrow(/no upcoming date left/u);
  });

  it('refuses an occurrence already skipped, and one already materialized', () => {
    expect(() => assertNotSkipped(undefined)).not.toThrow();
    expect(() => assertNotSkipped(skip('2026-08-25'))).toThrow(DuplicateConflictError);
    expect(() => assertNotSkipped(skip('2026-08-25'))).toThrow(/Un-skip it first/u);
    expect(() => assertNotMaterialized(false)).not.toThrow();
    expect(() => assertNotMaterialized(true)).toThrow(/already been recorded/u);
  });
});

describe('accepting an occurrence', () => {
  it('dates a due occurrence on its own date, or on a date the caller gives up to today', () => {
    expect(decideAcceptance(TODAY, template(), accept('2026-08-25'))).toEqual({
      financialDate: '2026-08-25',
    });
    expect(
      decideAcceptance(TODAY, template(), accept('2026-08-25', { financialDate: '2026-08-31' })),
    ).toEqual({ financialDate: '2026-08-31' });
    expect(() =>
      decideAcceptance(TODAY, template(), accept('2026-08-25', { financialDate: '2026-10-06' })),
    ).toThrow(/has not happened yet/u);
  });

  it('dates an early one today, and only through the explicit mode', () => {
    expect(() => decideAcceptance(TODAY, template(), accept('2026-10-25'))).toThrow(
      /has not happened yet/u,
    );
    expect(
      decideAcceptance(TODAY, template(), accept('2026-10-25', { receivedToday: true })),
    ).toEqual({ financialDate: '2026-10-05' });
    expect(() =>
      decideAcceptance(
        TODAY,
        template(),
        accept('2026-10-25', { receivedToday: true, financialDate: '2026-10-04' }),
      ),
    ).toThrow(/recorded as arriving today/u);
  });

  it('records a gross amount only for income', () => {
    const expense = template({ kind: 'expense', incomeKind: null, categoryId: 'cat-1' });
    expect(() =>
      decideAcceptance(TODAY, expense, accept('2026-08-25', { grossAmount: '10.00' })),
    ).toThrow(/Only income records a gross amount/u);
    expect(() =>
      decideAcceptance(TODAY, template(), accept('2026-08-25', { grossAmount: '10.00' })),
    ).not.toThrow();
  });

  it('takes the term the scheduled occurrence falls under, not the newest one', () => {
    const terms = [term('2026-01-25', '2100.00', '3000.00'), term('2026-09-25', '2200.00', '3100.00')];
    expect(decideAcceptedAmounts(template(), terms, accept('2026-08-25'))).toEqual({
      amount: '2100',
      grossAmount: '3000',
      cashPositionId: 'pos-cash',
    });
    expect(decideAcceptedAmounts(template(), terms, accept('2026-09-25'))).toMatchObject({
      amount: '2200',
      grossAmount: '3100',
    });
  });

  it('lets the caller state this occurrence’s own amount, gross and account', () => {
    const terms = [term('2026-01-25', '2100.00', '3000.00')];
    expect(
      decideAcceptedAmounts(
        template(),
        terms,
        accept('2026-08-25', { amount: '2150.00', grossAmount: null, cashPositionId: null }),
      ),
    ).toEqual({ amount: '2150.00', grossAmount: null, cashPositionId: null });
    expect(
      decideAcceptedAmounts(template(), terms, accept('2026-08-25', { grossAmount: '3050.00' })),
    ).toMatchObject({ grossAmount: '3050.00' });
  });

  it('inherits an absent term gross as absent', () => {
    expect(
      decideAcceptedAmounts(template(), [term('2026-01-25', '2100.00')], accept('2026-08-25')),
    ).toMatchObject({ grossAmount: null });
  });

  it('asks for the amount when no term covers the occurrence', () => {
    expect(() =>
      decideAcceptedAmounts(template(), [term('2026-09-25', '2200.00')], accept('2026-08-25')),
    ).toThrow(/no amount for that date yet/u);
  });

  it('refuses a zero expense and keeps a zero income', () => {
    const expense = template({ kind: 'expense', incomeKind: null, categoryId: 'cat-1' });
    expect(() =>
      decideAcceptedAmounts(expense, [term('2026-01-25', '0.00')], accept('2026-08-25')),
    ).toThrow(/more than zero/u);
    expect(
      decideAcceptedAmounts(template(), [term('2026-01-25', '0.00')], accept('2026-08-25')),
    ).toMatchObject({ amount: '0' });
  });
});
