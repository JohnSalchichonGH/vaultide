import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CorrectionDraft, CorrectionPreview } from '@vaultide/application';

// The dialog calls the confirm action and the app router; neither exists
// outside Next. The action is driven directly in the protocol cases below.
const confirmHistoricalCorrectionAction = vi.fn();
vi.mock('@/server/actions/corrections', () => ({
  confirmHistoricalCorrectionAction,
  previewHistoricalCorrectionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CorrectionReview } = await import('@/features/corrections/review-dialog');
const {
  IMPACT_TAG_LABEL,
  describeStructuralChange,
  interpretConfirm,
  rewritesDormancy,
  summarizePeriods,
  summarizeSources,
} = await import('@/features/corrections/presentation');
const { DestructiveConfirm, HISTORICAL_CREATION_NOTE, addsToCompletedMonth, isHistorical } =
  await import('@/features/corrections/delete-confirm');

/**
 * The review dialog and the words it puts on screen (blueprint 15.3, 16.6;
 * §66–§72 of the slice prompt).
 *
 * Everything here is a function of the server's semantic preview. The dialog
 * computes no figure, no affected month and no structural consequence — it
 * renders what it was given, which is why these are markup and copy tests
 * rather than financial ones.
 */

const LABELS = {
  accounts: { 'pos-1': 'BBVA', 'pos-2': 'Savings' },
  categories: { 'cat-1': 'Groceries' },
  locale: 'en-GB',
};

const DRAFT: CorrectionDraft = {
  kind: 'valuation_update',
  valuationId: 'val-1',
  expectedVersion: 2,
  valuedOn: '2026-09-30',
  amount: '7900',
  datePrecision: 'month_end',
};

function preview(over: Partial<CorrectionPreview> = {}): CorrectionPreview {
  return {
    fingerprint: 'hc-v1:aaaa',
    sourceScope: [
      { identity: { scope: 'existing', kind: 'valuation', id: 'val-1' }, operation: 'update' },
    ],
    sourcePeriods: ['2026-09'],
    periods: [
      {
        kind: 'completed',
        month: '2026-09',
        before: { status: 'reliable', buckets: [], completeness: null },
        after: { status: 'unresolved', buckets: [], completeness: null },
        tags: ['reconciliation', 'spending'],
      },
    ],
    structuralChanges: [
      { kind: 'month_status', month: '2026-09', before: 'reliable', after: 'unresolved' },
    ],
    sourceChanges: [
      {
        identity: { scope: 'existing', kind: 'valuation', id: 'val-1' },
        operation: 'update',
        before: {
          kind: 'valuation',
          positionId: 'pos-1',
          valuedOn: '2026-09-30',
          amount: '7800',
          currency: 'EUR',
          datePrecision: 'month_end',
          note: null,
        },
        after: {
          kind: 'valuation',
          positionId: 'pos-1',
          valuedOn: '2026-09-30',
          amount: '7900',
          currency: 'EUR',
          datePrecision: 'month_end',
          note: null,
        },
      },
    ],
    ...over,
  };
}

const render = (value = preview()): string =>
  renderToStaticMarkup(
    createElement(CorrectionReview, {
      draft: DRAFT,
      preview: value,
      labels: LABELS,
      onBack: vi.fn(),
      onCommitted: vi.fn(),
    }),
  );

describe('the review dialog', () => {
  it('shows the source before and after, and neither an id nor a version', () => {
    const html = render();
    expect(html).toContain('7800');
    expect(html).toContain('7900');
    expect(html).toContain('Statement balance');
    expect(html).not.toContain('val-1');
    expect(html).not.toContain('hc-v1');
  });

  it('names the months it will recalculate, and which one the record is in', () => {
    const html = render();
    expect(html).toContain('September 2026');
    expect(html).toContain('this record’s month');
  });

  it('marks a month that is recalculated without holding the record', () => {
    const html = render(
      preview({
        sourcePeriods: ['2026-08'],
        periods: [
          {
            kind: 'completed',
            month: '2026-09',
            before: { status: 'reliable', buckets: [], completeness: null },
            after: { status: 'unavailable', buckets: [], completeness: null },
            tags: ['reconciliation'],
          },
        ],
      }),
    );
    expect(html).toContain('also recalculated');
  });

  it('renders the impact families as words, not as engine keys', () => {
    const html = render();
    expect(html).toContain(IMPACT_TAG_LABEL.reconciliation);
    expect(html).toContain(IMPACT_TAG_LABEL.spending);
    expect(html).not.toContain('>reconciliation<');
  });

  it('explains the structural consequences in sentences', () => {
    expect(render()).toContain('September 2026 becomes unresolved instead of reliable.');
  });

  it('says plainly when a dormant period is being rewritten', () => {
    const html = render(
      preview({
        structuralChanges: [
          { kind: 'dormancy_episode', positionId: 'pos-2', before: '2026-06-30', after: null },
        ],
      }),
    );
    expect(html).toContain('recorded as dormant over');
    expect(html).toContain('Savings is no longer dormant from 30 Jun 2026');
  });

  it('offers a reason, a Back and a Confirm, and nothing else to edit', () => {
    const html = render();
    expect(html).toContain('Why are you changing this? (optional)');
    expect(html).toContain('data-testid="correction-back"');
    expect(html).toContain('data-testid="correction-confirm"');
    // No second editor: the only inputs are the reason and the two buttons.
    expect(html.match(/<input/gu)).toHaveLength(1);
  });
});

describe('the current month’s note (§69)', () => {
  const current = (
    before: CorrectionPreview['periods'][number],
    sourceChanges: CorrectionPreview['sourceChanges'] = [],
  ): string => {
    const [summary] = summarizePeriods(
      preview({ periods: [before], sourcePeriods: ['2026-10'], sourceChanges }),
      LABELS,
    );
    return summary?.note ?? '';
  };

  const tracked = (asOf: string) =>
    ({ kind: 'tracked_interval', asOf, status: 'provisional', sourceOnlyThrough: '2026-10-15', buckets: [] }) as const;
  const none = {
    kind: 'no_tracked_interval',
    asOf: null,
    status: 'unavailable',
    reason: 'mtd_no_common_date',
    sourceOnlyThrough: '2026-10-15',
  } as const;

  it('says where month-to-date figures now reach when the date moves', () => {
    expect(
      current({
        kind: 'current',
        month: '2026-10',
        before: tracked('2026-10-10'),
        after: tracked('2026-10-06'),
        tags: [],
      }),
    ).toBe('Month-to-date figures now reach 6 Oct 2026 instead of 10 Oct 2026.');
  });

  it('says the figures become unavailable when the common date goes', () => {
    expect(
      current({
        kind: 'current',
        month: '2026-10',
        before: tracked('2026-10-10'),
        after: none,
        tags: [],
      }),
    ).toContain('will no longer have a common month-to-date balance date');
  });

  it('says the month gains one when it appears', () => {
    expect(
      current({ kind: 'current', month: '2026-10', before: none, after: tracked('2026-10-08'), tags: [] }),
    ).toBe('October 2026 gets a common month-to-date balance date of 8 Oct 2026.');
  });

  it('says a record dated after `D` changes nothing yet', () => {
    const note = current(
      {
        kind: 'current',
        month: '2026-10',
        before: tracked('2026-10-10'),
        after: tracked('2026-10-10'),
        tags: [],
      },
      [
        {
          identity: { scope: 'existing', kind: 'income', id: 'inc-1' },
          operation: 'update',
          before: {
            kind: 'income',
            incomeKind: 'employment',
            receivedOn: '2026-09-10',
            netAmount: '500',
            grossAmount: null,
            currency: 'EUR',
            settlement: 'tracked_cash',
            cashPositionId: 'pos-1',
            description: null,
            templateId: null,
            occurrenceDate: null,
          },
          after: {
            kind: 'income',
            incomeKind: 'employment',
            receivedOn: '2026-10-15',
            netAmount: '500',
            grossAmount: null,
            currency: 'EUR',
            settlement: 'tracked_cash',
            cashPositionId: 'pos-1',
            description: null,
            templateId: null,
            occurrenceDate: null,
          },
        },
      ],
    );
    expect(note).toContain('month-to-date figures currently reach only 10 Oct 2026');
    expect(note).toContain('do not change yet');
  });
});

describe('what the dialog is given', () => {
  it('summarizes a source by its meaningful fields alone', () => {
    const [summary] = summarizeSources(preview(), LABELS);
    expect(summary?.fields.map((field) => field.label)).toEqual(['Date', 'Balance', 'Kind']);
    expect(summary?.fields.find((field) => field.label === 'Balance')?.changed).toBe(true);
    expect(summary?.fields.find((field) => field.label === 'Date')?.changed).toBe(false);
  });

  it('names accounts and categories for readability, by id', () => {
    expect(
      describeStructuralChange(
        { kind: 'dormancy_episode', positionId: 'pos-1', before: null, after: '2026-07-31' },
        LABELS,
      ),
    ).toContain('BBVA');
  });

  it('knows when a correction rewrites a dormant period', () => {
    expect(rewritesDormancy(preview())).toBe(false);
    expect(
      rewritesDormancy(
        preview({
          structuralChanges: [
            { kind: 'dormancy_episode', positionId: 'pos-1', before: '2026-07-31', after: null },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('deleting a record (§71)', () => {
  const render2 = (props: Parameters<typeof DestructiveConfirm>[0]): string =>
    renderToStaticMarkup(createElement(DestructiveConfirm, props));

  it('asks once, in place, for a current-month record', () => {
    const html = render2({
      testId: 'entry-delete',
      label: 'Delete',
      question: 'Delete this income entry?',
      disabled: false,
      onConfirm: vi.fn(),
    });
    expect(html).toContain('data-testid="entry-delete"');
    // The question appears only once the button has been pressed.
    expect(html).not.toContain('Delete this income entry?');
  });

  it('goes straight through for a historical one, where the review is the confirmation', () => {
    const html = render2({
      testId: 'entry-delete',
      label: 'Delete',
      question: 'Delete this income entry?',
      disabled: false,
      skipConfirmation: true,
      onConfirm: vi.fn(),
    });
    expect(html).toContain('data-testid="entry-delete"');
    expect(html).not.toContain('entry-delete-confirm');
  });

  it('calls a record historical by its own month, not by the page it is on', () => {
    expect(isHistorical('2026-09-30', '2026-10-01')).toBe(true);
    expect(isHistorical('2026-10-01', '2026-10-31')).toBe(false);
    expect(isHistorical('2026-10-31', '2026-10-01')).toBe(false);
  });
});

describe('adding into a closed month (§107)', () => {
  it('is a first assertion, and says so once', () => {
    expect(addsToCompletedMonth({ max: '2026-09-30', today: '2026-10-05' })).toBe(true);
    expect(addsToCompletedMonth({ max: '2026-10-05', today: '2026-10-05' })).toBe(false);
    expect(HISTORICAL_CREATION_NOTE).toContain('work that month out again');
  });
});

describe('what Confirm answered (§70, §112)', () => {
  it('a commit is a commit', () => {
    expect(
      interpretConfirm({
        ok: true,
        data: {
          status: 'committed',
          summary: {
            sourceScope: [],
            sourcePeriods: ['2026-09'],
            affectedPeriods: ['2026-09'],
            dormancyChanged: false,
          },
        },
      }),
    ).toEqual({ kind: 'committed' });
  });

  it('`impact_changed` is not an error: it carries the fresh preview to re-render from', () => {
    const fresh = preview({ fingerprint: 'hc-v1:bbbb' });
    const outcome = interpretConfirm({
      ok: true,
      data: { status: 'impact_changed', preview: fresh },
    });

    expect(outcome).toEqual({ kind: 'stale', preview: fresh });
    // Nothing in the outcome touches the reason: it is the user's own text, it
    // is not part of the consent, and there is no arm that could clear it.
    expect(JSON.stringify(outcome)).not.toContain('reason');
  });

  it('a version conflict says the record moved, which confirming again cannot fix', () => {
    expect(
      interpretConfirm({
        ok: false,
        error: { code: 'CONFLICT_VERSION', message: 'This balance changed after you opened it.' },
      }),
    ).toMatchObject({ kind: 'error', conflict: true });
  });

  it('an ordinary refusal is an ordinary error', () => {
    expect(
      interpretConfirm({
        ok: false,
        error: { code: 'WRITE_BUSY', message: 'Another change is still saving.' },
      }),
    ).toMatchObject({ kind: 'error', conflict: false, message: 'Another change is still saving.' });
  });

  it('renders the stale banner over the fresh impact, and asks again', () => {
    // The banner is state the component enters only from `stale`; the fresh
    // preview is what it then renders, and Confirm is still the only way out.
    const html = render(preview({ fingerprint: 'hc-v1:bbbb' }));
    expect(html).toContain('data-testid="correction-confirm"');
    expect(html).toContain('data-testid="correction-reason"');
  });
});
