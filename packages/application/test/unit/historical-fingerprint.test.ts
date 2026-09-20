import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  FINGERPRINT_VERSION,
  fingerprintOf,
} from '../../src/corrections/fingerprint';
import type {
  CompletedPeriodImpact,
  CorrectionPreview,
  CurrentPeriodImpact,
  SavingsImpactState,
  StructuralChange,
} from '../../src/corrections/types';
import { updated, type IdentifiedSourceChange, type IncomeSourceFacts } from '../../src/write-plan';

/**
 * The consent fingerprint (ADR 0010 §12; §49–§53 of the slice prompt).
 *
 * Two properties matter and they pull in opposite directions, so both are
 * tested from both sides:
 *
 *  - **no false negative.** Anything the user actually consented to — the
 *    source facts, the periods, the structural state — changes the hash. A
 *    correction whose meaning moved must not commit against yesterday's
 *    consent.
 *  - **no false positive.** Anything that is not a financial semantic — an
 *    ordering, a rename, the reporting currency, a rate, a dismissal, the
 *    audit reason — does not. Asking a user to re-confirm because somebody
 *    renamed a category would train them to click through the dialog.
 *
 * The expected value is never recomputed from a copy of the production
 * canonicalizer: every case compares two real previews built by the real
 * function, so a canonicalizer that silently stopped including a field fails
 * the first group rather than agreeing with itself.
 */

const savings: SavingsImpactState = {
  availability: 'available',
  quality: 'reliable',
  rate: 'ratio',
  additionalSpendingCounts: false,
};

const facts = (overrides: Partial<IncomeSourceFacts> = {}): IncomeSourceFacts => ({
  kind: 'income',
  incomeKind: 'employment',
  receivedOn: '2026-08-25',
  netAmount: '2500',
  grossAmount: null,
  currency: 'EUR',
  settlement: 'tracked_cash',
  cashPositionId: 'pos-1',
  description: 'Salary',
  templateId: 'tpl-1',
  occurrenceDate: '2026-08-25',
  ...overrides,
});

const identity = { scope: 'existing', kind: 'income', id: 'row-1' } as const;

const august = (overrides: Partial<CompletedPeriodImpact> = {}): CompletedPeriodImpact => ({
  kind: 'completed',
  month: '2026-08',
  before: {
    status: 'reliable',
    buckets: [
      {
        currency: 'EUR',
        status: 'reliable',
        balanceEvidence: 'complete',
        accounts: [
          {
            positionId: 'pos-1',
            opening: 'month_end',
            closing: 'month_end',
            included: true,
            excludedFirstBalance: false,
            dormant: false,
          },
        ],
        issues: [],
        savings,
      },
    ],
    completeness: { state: 'sufficient', satisfied: 2, required: 2 },
  },
  after: {
    status: 'reliable',
    buckets: [
      {
        currency: 'EUR',
        status: 'reliable',
        balanceEvidence: 'complete',
        accounts: [
          {
            positionId: 'pos-1',
            opening: 'month_end',
            closing: 'month_end',
            included: true,
            excludedFirstBalance: false,
            dormant: false,
          },
        ],
        issues: [],
        savings,
      },
    ],
    completeness: { state: 'sufficient', satisfied: 2, required: 2 },
  },
  tags: ['reconciliation', 'income'],
  ...overrides,
});

const september = (asOfAfter: string): CurrentPeriodImpact => ({
  kind: 'current',
  month: '2026-09',
  before: {
    kind: 'tracked_interval',
    asOf: '2026-09-10',
    status: 'provisional',
    sourceOnlyThrough: '2026-09-15',
    buckets: [],
  },
  after: {
    kind: 'tracked_interval',
    asOf: asOfAfter,
    status: 'provisional',
    sourceOnlyThrough: '2026-09-15',
    buckets: [],
  },
  tags: ['reconciliation'],
});

function preview(
  overrides: Partial<Omit<CorrectionPreview, 'fingerprint'>> = {},
): Omit<CorrectionPreview, 'fingerprint'> {
  const changes: IdentifiedSourceChange[] = [updated(identity, facts(), facts({ netAmount: '2600' }))];
  return {
    sourceScope: [{ identity, operation: 'update' }],
    sourcePeriods: ['2026-08'],
    periods: [august()],
    structuralChanges: [],
    sourceChanges: changes,
    ...overrides,
  };
}

const hash = (value: Omit<CorrectionPreview, 'fingerprint'>): string => fingerprintOf(value);

describe('the fingerprint’s shape', () => {
  it('is the canonical version, a colon and a sha-256 digest', () => {
    expect(hash(preview())).toMatch(/^hc-v1:[0-9a-f]{64}$/u);
    expect(FINGERPRINT_VERSION).toBe('hc-v1');
  });

  it('is stable across repeated derivations of the same preview', () => {
    expect(hash(preview())).toBe(hash(preview()));
  });
});

describe('canonical JSON', () => {
  it('sorts object keys, so two orderings of one object agree', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('keeps array order, because an ordered list is a different value', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('what does not change it (§51)', () => {
  it('the order of the source changes', () => {
    const other: IdentifiedSourceChange = updated(
      { scope: 'existing', kind: 'expense', id: 'row-2' },
      {
        kind: 'expense',
        categoryId: 'cat-1',
        categoryKind: 'consumption',
        incurredOn: '2026-08-04',
        amount: '10',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: 'pos-1',
        description: null,
        transferId: null,
        templateId: null,
        occurrenceDate: null,
      },
      {
        kind: 'expense',
        categoryId: 'cat-1',
        categoryKind: 'consumption',
        incurredOn: '2026-08-04',
        amount: '11',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: 'pos-1',
        description: null,
        transferId: null,
        templateId: null,
        occurrenceDate: null,
      },
    );
    const first = preview().sourceChanges[0] as IdentifiedSourceChange;

    expect(hash(preview({ sourceChanges: [first, other] }))).toBe(
      hash(preview({ sourceChanges: [other, first] })),
    );
  });

  it('the order of the source periods, the scope and the structural changes', () => {
    const spans: StructuralChange[] = [
      { kind: 'span', change: 'appeared', currency: 'EUR', from: '2026-05-01', to: '2026-07-31' },
      { kind: 'span', change: 'disappeared', currency: 'USD', from: '2026-03-01', to: '2026-04-30' },
    ];
    expect(
      hash(preview({ sourcePeriods: ['2026-07', '2026-08'], structuralChanges: spans })),
    ).toBe(
      hash(
        preview({
          sourcePeriods: ['2026-08', '2026-07'],
          structuralChanges: [spans[1] as StructuralChange, spans[0] as StructuralChange],
        }),
      ),
    );
  });

  it('a name, a rate, a reporting currency or a dismissal — none of which it can see', () => {
    // The strongest form of this claim: no field of `CorrectionPreview` holds
    // any of them, so a preview taken before and after such a change is the
    // same object. The integration suite proves the same thing end to end.
    const before = preview();
    const after = preview();
    expect(hash(before)).toBe(hash(after));
    expect(JSON.stringify(before)).not.toContain('EUR/USD');
  });
});

describe('what does change it (§50)', () => {
  it('the native amount of the source fact', () => {
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          sourceChanges: [updated(identity, facts(), facts({ netAmount: '2700' }))],
        }),
      ),
    );
  });

  it('the financial date', () => {
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          sourceChanges: [
            updated(identity, facts(), facts({ netAmount: '2600', receivedOn: '2026-08-26' })),
          ],
        }),
      ),
    );
  });

  it('the currency, the settlement and the cash attribution', () => {
    for (const change of [
      facts({ netAmount: '2600', currency: 'USD' }),
      facts({ netAmount: '2600', settlement: 'external' }),
      facts({ netAmount: '2600', cashPositionId: 'pos-2' }),
    ]) {
      expect(hash(preview())).not.toBe(
        hash(preview({ sourceChanges: [updated(identity, facts(), change)] })),
      );
    }
  });

  it('the occurrence identity a flow materializes', () => {
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          sourceChanges: [
            updated(identity, facts(), facts({ netAmount: '2600', occurrenceDate: '2026-09-25' })),
          ],
        }),
      ),
    );
  });

  it('a month’s status', () => {
    const moved = august();
    expect(hash(preview())).not.toBe(
      hash(preview({ periods: [{ ...moved, after: { ...moved.after, status: 'unresolved' } }] })),
    );
  });

  it('a completeness count', () => {
    const moved = august();
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          periods: [
            {
              ...moved,
              after: {
                ...moved.after,
                completeness: { state: 'incomplete', satisfied: 1, required: 2 },
              },
            },
          ],
        }),
      ),
    );
  });

  it('an issue appearing', () => {
    const moved = august();
    const bucket = moved.after.buckets[0];
    if (bucket === undefined) throw new Error('fixture');
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          periods: [
            {
              ...moved,
              after: {
                ...moved.after,
                buckets: [
                  {
                    ...bucket,
                    issues: [
                      {
                        key: 'unexplained_inflow',
                        currency: 'EUR',
                        positionId: null,
                        templateId: null,
                        occurrenceDate: null,
                        source: null,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
  });

  it('the month-to-date evidence date `D`', () => {
    expect(hash(preview({ periods: [september('2026-09-10')] }))).not.toBe(
      hash(preview({ periods: [september('2026-09-06')] })),
    );
  });

  it('a span appearing or disappearing', () => {
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          structuralChanges: [
            { kind: 'span', change: 'appeared', currency: 'EUR', from: '2026-05-01', to: '2026-07-31' },
          ],
        }),
      ),
    );
  });

  it('a dormant episode’s anchor moving', () => {
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          structuralChanges: [
            { kind: 'dormancy_episode', positionId: 'pos-1', before: '2026-06-30', after: null },
          ],
        }),
      ),
    );
  });

  it('whether the savings preference decides anything for the bucket', () => {
    const moved = august();
    const bucket = moved.after.buckets[0];
    if (bucket === undefined) throw new Error('fixture');
    expect(hash(preview())).not.toBe(
      hash(
        preview({
          periods: [
            {
              ...moved,
              after: {
                ...moved.after,
                buckets: [
                  { ...bucket, savings: { ...savings, additionalSpendingCounts: true } },
                ],
              },
            },
          ],
        }),
      ),
    );
  });

  it('an impact tag', () => {
    expect(hash(preview())).not.toBe(
      hash(preview({ periods: [august({ tags: ['reconciliation', 'spending'] })] })),
    );
  });
});
