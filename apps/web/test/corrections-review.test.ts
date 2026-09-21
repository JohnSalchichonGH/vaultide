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
  accountDisplayNames,
  compareField,
  describeStructuralChange,
  interpretConfirm,
  rewritesDormancy,
  summarizePeriods,
  summarizeSources,
} = await import('@/features/corrections/presentation');
const {
  DestructiveConfirm,
  HISTORICAL_CREATION_NOTE,
  HISTORICAL_FEE_CREATION_NOTE,
  addsToCompletedMonth,
  isHistorical,
  transferCreationNote,
} = await import('@/features/corrections/delete-confirm');
const { attemptCorrection } = await import('@/features/corrections/use-correction');

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
  accounts: {
    'pos-1': { name: 'BBVA', currency: 'EUR' },
    'pos-2': { name: 'Savings', currency: 'EUR' },
  },
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
    // A balance names its account: a review of several balances would
    // otherwise be a list of amounts belonging to nobody.
    expect(summary?.fields.map((field) => field.label)).toEqual(['Account', 'Date', 'Balance', 'Kind']);
    expect(summary?.fields.find((field) => field.label === 'Account')).toEqual({
      label: 'Account',
      before: 'BBVA',
      after: 'BBVA',
      changed: false,
    });
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

/* -------------------------------------------------------------------------- */
/* The gap between asking and saving                                           */
/* -------------------------------------------------------------------------- */

/**
 * Preview and the ordinary save are two round trips (§5).
 *
 * Another writer can commit in between, so `not_required` followed by
 * `HISTORICAL_REVIEW_REQUIRED` is reachable and always will be. The server is
 * safe — the guard refuses before a row moves — but the interface has a
 * protocol to finish: that refusal is exactly the answer the asking was for,
 * so it becomes the review rather than an error the user cannot act on.
 */
describe('a guard refusal after not_required becomes the review (§5)', () => {
  const ok = { ok: true } as const;
  const guardRefused = {
    ok: false,
    error: {
      code: 'HISTORICAL_REVIEW_REQUIRED',
      message: 'This changes a month that is already closed. Nothing was saved.',
    },
  } as const;

  const notRequired = { ok: true, data: { status: 'not_required' } } as const;
  const reviewRequired = (over = {}) =>
    ({ ok: true, data: { status: 'review_required', preview: preview(over) } }) as const;

  function ports(answers: readonly unknown[]) {
    const opened: { draft: CorrectionDraft; preview: CorrectionPreview }[] = [];
    const asked: CorrectionDraft[] = [];
    let forgotten = 0;
    let next = 0;
    return {
      opened,
      asked,
      get forgotten() {
        return forgotten;
      },
      ports: {
        ask: (draft: CorrectionDraft) => {
          asked.push(draft);
          const answer = answers[next];
          next += 1;
          return Promise.resolve(answer as never);
        },
        open: (draft: CorrectionDraft, shown: CorrectionPreview) => {
          opened.push({ draft, preview: shown });
        },
        forget: () => {
          forgotten += 1;
        },
      },
    };
  }

  it('asks once more and opens the review on the fresh preview', async () => {
    const fresh = reviewRequired({ fingerprint: 'hc-v1:fresh' });
    const harness = ports([notRequired, fresh]);
    const save = vi.fn().mockResolvedValue(guardRefused);

    const outcome = await attemptCorrection(harness.ports, DRAFT, save);

    expect(outcome).toEqual({ kind: 'review' });
    // Exactly one save attempt, and exactly two previews: no loop.
    expect(save).toHaveBeenCalledTimes(1);
    expect(harness.asked).toHaveLength(2);
    // The same draft both times: nothing the user typed was discarded.
    expect(harness.asked[0]).toBe(DRAFT);
    expect(harness.asked[1]).toBe(DRAFT);
    expect(harness.opened).toHaveLength(1);
    expect(harness.opened[0]?.draft).toBe(DRAFT);
    expect(harness.opened[0]?.preview.fingerprint).toBe('hc-v1:fresh');
  });

  it('refuses rather than looping when the second answer is not_required again', async () => {
    const harness = ports([notRequired, notRequired]);
    const save = vi.fn().mockResolvedValue(guardRefused);

    const outcome = await attemptCorrection(harness.ports, DRAFT, save);

    expect(outcome).toEqual({ kind: 'refused', result: guardRefused });
    expect(save).toHaveBeenCalledTimes(1);
    expect(harness.asked).toHaveLength(2);
    expect(harness.opened).toHaveLength(0);
  });

  it('leaves every other refusal exactly as it was', async () => {
    for (const code of ['CONFLICT_VERSION', 'CONFLICT_DUPLICATE', 'VALIDATION_ERROR', 'WRITE_BUSY']) {
      const refusal = { ok: false, error: { code, message: `${code} happened` } } as const;
      const harness = ports([notRequired]);
      const save = vi.fn().mockResolvedValue(refusal);

      const outcome = await attemptCorrection(harness.ports, DRAFT, save);

      // The save's own answer, reported once, with no second preview: a
      // version conflict is not something re-asking could resolve.
      expect(outcome).toEqual({ kind: 'saved', result: refusal });
      expect(harness.asked).toHaveLength(1);
      expect(harness.opened).toHaveLength(0);
    }
  });

  it('saves ordinarily when nothing moved, and reviews when the first answer already says so', async () => {
    const plain = ports([notRequired]);
    const saveOk = vi.fn().mockResolvedValue(ok);
    expect(await attemptCorrection(plain.ports, DRAFT, saveOk)).toEqual({ kind: 'saved', result: ok });
    expect(plain.asked).toHaveLength(1);
    expect(plain.forgotten).toBe(1);

    const historical = ports([reviewRequired()]);
    const never = vi.fn();
    expect(await attemptCorrection(historical.ports, DRAFT, never)).toEqual({ kind: 'review' });
    // Nothing was sent: the review comes before the write, never after it.
    expect(never).not.toHaveBeenCalled();
    expect(historical.opened).toHaveLength(1);
  });

  it('reports a refused preview without ever calling the save', async () => {
    const refusal = {
      ok: false,
      error: { code: 'CONFLICT_VERSION', message: 'Changed elsewhere — reload.' },
    } as const;
    const harness = ports([refusal]);
    const save = vi.fn();

    expect(await attemptCorrection(harness.ports, DRAFT, save)).toEqual({
      kind: 'refused',
      result: refusal,
    });
    expect(save).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Adding into a closed month                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A first assertion into a closed month saves ordinarily and says so once
 * (§7, 30.22 item 2).
 *
 * The transfer case is the one worth its own copy: the aggregate carries two
 * independent financial dates, and a fee may be dated in another month than
 * the transfer that owns it (ADR 0006 §5). Deciding from the page's month
 * alone would miss exactly that.
 */
describe('the historical first-assertion note (§7)', () => {
  it('names the transfer when the transfer itself is historical', () => {
    expect(
      transferCreationNote({
        occurredOn: '2026-09-20',
        feeIncurredOn: '2026-09-20',
        today: '2026-10-05',
      }),
    ).toBe(HISTORICAL_CREATION_NOTE);
  });

  it('names the fee when only the fee reaches back', () => {
    expect(
      transferCreationNote({
        occurredOn: '2026-10-02',
        feeIncurredOn: '2026-09-28',
        today: '2026-10-05',
      }),
    ).toBe(HISTORICAL_FEE_CREATION_NOTE);
  });

  it('says nothing when both dates are in the open month', () => {
    expect(
      transferCreationNote({
        occurredOn: '2026-10-02',
        feeIncurredOn: '2026-10-02',
        today: '2026-10-05',
      }),
    ).toBeNull();
    // A transfer with no fee at all is judged on its own date alone.
    expect(
      transferCreationNote({ occurredOn: '2026-10-02', feeIncurredOn: null, today: '2026-10-05' }),
    ).toBeNull();
    expect(
      transferCreationNote({ occurredOn: '2026-09-02', feeIncurredOn: null, today: '2026-10-05' }),
    ).toBe(HISTORICAL_CREATION_NOTE);
  });

  it('is the same judgement a recorded balance makes about its own date', () => {
    // The valuation editor asks exactly this of the date the user chose.
    expect(isHistorical('2026-09-30', '2026-10-05')).toBe(true);
    expect(isHistorical('2026-10-01', '2026-10-05')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Consent: every revisable fact is on the review                              */
/* -------------------------------------------------------------------------- */

/**
 * The review is the consent, so it has to show what is being corrected (§3 of
 * the final corrective pass).
 *
 * A historical salary whose only change is its gross amount is still a
 * revision of a closed month, and the server rightly asks for the review. If
 * the review then listed nothing as changed it would be asking the user to
 * agree to something it did not show them. These go through
 * `summarizeSources` and the dialog itself — the transformation that feeds
 * the screen — not through the raw facts.
 */
describe('the review shows every fact a person can revise', () => {
  const income = (over: Record<string, unknown> = {}) => ({
    kind: 'income' as const,
    incomeKind: 'employment',
    receivedOn: '2026-09-25',
    netAmount: '2100',
    grossAmount: '2600' as string | null,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: 'pos-1',
    description: null,
    templateId: null,
    occurrenceDate: null,
    ...over,
  });

  const incomePreview = (before: ReturnType<typeof income>, after: ReturnType<typeof income>) =>
    preview({
      sourceScope: [
        { identity: { scope: 'existing', kind: 'income', id: 'inc-1' }, operation: 'update' },
      ],
      // A gross amount feeds no figure the product computes, so the honest
      // impact is no family at all. The source section is what explains it.
      periods: [
        {
          kind: 'completed',
          month: '2026-09',
          before: { status: 'reliable', buckets: [], completeness: null },
          after: { status: 'reliable', buckets: [], completeness: null },
          tags: [],
        },
      ],
      structuralChanges: [],
      sourceChanges: [
        {
          identity: { scope: 'existing', kind: 'income', id: 'inc-1' },
          operation: 'update',
          before,
          after,
        },
      ],
    });

  const field = (value: CorrectionPreview, label: string) => {
    const summary = summarizeSources(value, LABELS)[0];
    return summary?.fields.find((item) => item.label === label);
  };

  it('shows a gross-only correction as Gross, with Net unchanged beside it', () => {
    const value = incomePreview(income(), income({ grossAmount: '2700' }));

    expect(field(value, 'Gross')).toEqual({
      label: 'Gross',
      before: '2600 EUR',
      after: '2700 EUR',
      changed: true,
    });
    expect(field(value, 'Net')).toEqual({
      label: 'Net',
      before: '2100 EUR',
      after: '2100 EUR',
      changed: false,
    });
    // Nothing is called "Amount" once there are two amounts to tell apart.
    expect(field(value, 'Amount')).toBeUndefined();

    // And the dialog marks exactly that row as the one that changed.
    const html = render(value);
    expect(html).toMatch(/data-field="Gross" data-changed="true"/u);
    expect(html).toMatch(/data-field="Net" data-changed="false"/u);
  });

  it('shows a gross amount added where there was none, and never as zero', () => {
    const value = incomePreview(income({ grossAmount: null }), income({ grossAmount: '2700' }));

    expect(field(value, 'Gross')).toEqual({
      label: 'Gross',
      before: null,
      after: '2700 EUR',
      changed: true,
    });
    // Absent is the dialog's own dash, on the before side — not a zero.
    expect(render(value)).toMatch(
      /data-field="Gross" data-changed="true"><dt[^>]*>Gross<\/dt><dd[^>]*>—<\/dd><dd[^>]*>2700 EUR<\/dd>/u,
    );
  });

  it('shows a gross amount removed, and never as zero', () => {
    const value = incomePreview(income({ grossAmount: '2700' }), income({ grossAmount: null }));

    expect(field(value, 'Gross')).toEqual({
      label: 'Gross',
      before: '2700 EUR',
      after: null,
      changed: true,
    });
    expect(render(value)).toMatch(
      /data-field="Gross" data-changed="true"><dt[^>]*>Gross<\/dt><dd[^>]*>2700 EUR<\/dd><dd[^>]*>—<\/dd>/u,
    );
  });

  it('shows a kind-only correction in words', () => {
    const value = incomePreview(income(), income({ incomeKind: 'bonus' }));

    expect(field(value, 'Kind')).toEqual({
      label: 'Kind',
      before: 'Salary',
      after: 'Bonus',
      changed: true,
    });
    const html = render(value);
    expect(html).toContain('Salary');
    expect(html).toContain('Bonus');
    expect(html).not.toContain('employment');
  });

  it('shows an expense whose only change is its one-off mark', () => {
    const expense = (isOneOff: boolean) => ({
      kind: 'expense' as const,
      categoryId: 'cat-1',
      categoryKind: 'food',
      incurredOn: '2026-09-12',
      amount: '40',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: 'pos-1',
      description: null,
      isOneOff,
      transferId: null,
      templateId: null,
      occurrenceDate: null,
    });
    const value = preview({
      sourceChanges: [
        {
          identity: { scope: 'existing', kind: 'expense', id: 'exp-1' },
          operation: 'update',
          before: expense(false),
          after: expense(true),
        },
      ],
    });

    expect(field(value, 'One-off')).toEqual({
      label: 'One-off',
      before: 'No',
      after: 'Yes',
      changed: true,
    });
    expect(field(value, 'Amount')?.changed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Identity is not a label                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Two different stored facts are never "unchanged" because their words match
 * (the final landing review's blocker).
 *
 * Account names are not unique, so a salary moved between two EUR accounts
 * both called Savings once reviewed as "Savings → Savings, unchanged" — a
 * closed month revised with nothing on the screen saying what. Whether a row
 * changed is now decided on the stored fact, and same-named accounts are told
 * apart in what the reader sees. Same currency on purpose throughout: currency
 * alone cannot tell these two apart, so a fix that leant on it would fail here.
 */
describe('a changed fact is never hidden behind an equal label', () => {
  const A = '6f1c2d3e-0000-4000-8000-00000000000a';
  const B = '9a8b7c6d-0000-4000-8000-00000000000b';
  const TWINS = {
    ...LABELS,
    accounts: {
      ...LABELS.accounts,
      [A]: { name: 'Savings', currency: 'EUR' },
      [B]: { name: 'Savings', currency: 'EUR' },
    },
  };

  const onlyChange = (
    before: CorrectionPreview['sourceChanges'][number]['before'],
    after: CorrectionPreview['sourceChanges'][number]['after'],
    kind: 'income' | 'expense' | 'transfer' | 'valuation' = 'income',
  ): CorrectionPreview =>
    preview({
      sourceChanges: [
        {
          identity: { scope: 'existing', kind, id: 'row-1' },
          operation: 'update',
          before,
          after,
        } as CorrectionPreview['sourceChanges'][number],
      ],
    });

  const fieldsOf = (value: CorrectionPreview, index = 0) =>
    summarizeSources(value, TWINS)[index]?.fields ?? [];
  const field = (value: CorrectionPreview, label: string, index = 0) =>
    fieldsOf(value, index).find((item) => item.label === label);
  const changedLabels = (value: CorrectionPreview, index = 0) =>
    fieldsOf(value, index)
      .filter((item) => item.changed)
      .map((item) => item.label);

  describe('the comparison itself', () => {
    it('reports a change when the facts differ and the words do not', () => {
      expect(
        compareField('Account', { value: A, display: 'Savings' }, { value: B, display: 'Savings' }),
      ).toEqual({ label: 'Account', before: 'Savings', after: 'Savings', changed: true });
    });

    it('reports no change when the facts are the same, whatever they are written as', () => {
      expect(
        compareField(
          'Net',
          { value: ['2100', 'EUR'], display: '2100 EUR' },
          { value: ['2100', 'EUR'], display: '2,100.00 EUR' },
        ).changed,
      ).toBe(false);
      expect(
        compareField('Account', { value: A, display: 'Savings' }, { value: A, display: 'Savings' })
          .changed,
      ).toBe(false);
    });

    it('never treats an absent fact as a zero, or a zero as absent', () => {
      expect(
        compareField('Gross', null, { value: ['0', 'EUR'], display: '0 EUR' }).changed,
      ).toBe(true);
      expect(
        compareField('Gross', { value: ['0', 'EUR'], display: '0 EUR' }, { value: null, display: null })
          .changed,
      ).toBe(true);
    });
  });

  describe('telling same-named accounts apart', () => {
    it('leaves a name that is its own alone', () => {
      const names = accountDisplayNames(LABELS, []);
      expect(names.get('pos-1')).toBe('BBVA');
      expect(names.get('pos-2')).toBe('Savings');
    });

    /** Whether a label shows an id whole, with or without its hyphens. */
    const showsWhole = (label: string, id: string): boolean =>
      label.includes(id) || label.replace(/[^0-9a-z]/giu, '').includes(id.replace(/-/gu, ''));

    it('tells a same-currency group apart without ever showing a whole id', () => {
      const names = accountDisplayNames(TWINS, []);
      const a = names.get(A) as string;
      const b = names.get(B) as string;
      const old = names.get('pos-2') as string;
      expect(new Set([a, b, old]).size).toBe(3);
      for (const label of [a, b, old]) expect(label.startsWith('Savings')).toBe(true);
      // Everything that shares the name is told apart, the old Savings included
      // — and its id is short enough that any prefix would be all of it.
      expect(old).not.toBe('Savings');
      for (const [label, id] of [
        [a, A],
        [b, B],
        [old, 'pos-2'],
      ] as const) {
        expect(showsWhole(label, id)).toBe(false);
      }
      // Deterministic: the same accounts are named the same way every time.
      expect(accountDisplayNames(TWINS, [])).toEqual(names);
    });

    it('uses a few leading digits of each id when those tell the pair apart', () => {
      const names = accountDisplayNames(
        {
          ...LABELS,
          accounts: {
            [A]: { name: 'Savings', currency: 'EUR' },
            [B]: { name: 'Savings', currency: 'EUR' },
          },
        },
        [],
      );
      expect(names.get(A)).toBe('Savings · #6f1c');
      expect(names.get(B)).toBe('Savings · #9a8b');
    });

    it('never shows a whole id, even for two that differ only in their last digit', () => {
      // The adversarial pair: every compact digit shared but the final one, so
      // no prefix short of the whole id can tell them apart.
      const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const second = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
      const labels = {
        ...LABELS,
        accounts: {
          [first]: { name: 'Savings', currency: 'EUR' },
          [second]: { name: 'Savings', currency: 'EUR' },
        },
      };
      const names = accountDisplayNames(labels, []);
      const one = names.get(first) as string;
      const two = names.get(second) as string;

      expect(one).not.toBe(two);
      for (const [label, id] of [
        [one, first],
        [two, second],
      ] as const) {
        expect(label.startsWith('Savings')).toBe(true);
        expect(label).not.toContain(id);
        expect(label).not.toContain(id.replace(/-/gu, ''));
        expect(showsWhole(label, id)).toBe(false);
        // Nor any long run of either id's digits.
        expect(label).not.toMatch(/[0-9a-f]{9,}/u);
      }
      expect(accountDisplayNames(labels, [])).toEqual(names);
      expect(accountDisplayNames(labels, []).get(first)).toBe(one);
    });

    it('uses the currency when that alone tells the group apart', () => {
      const names = accountDisplayNames(
        {
          ...LABELS,
          accounts: {
            [A]: { name: 'Savings', currency: 'EUR' },
            [B]: { name: 'Savings', currency: 'USD' },
          },
        },
        [],
      );
      expect(names.get(A)).toBe('Savings (EUR)');
      expect(names.get(B)).toBe('Savings (USD)');
    });

    it('tells apart two accounts the page never labelled', () => {
      const names = accountDisplayNames({ ...LABELS, accounts: {} }, [A, B]);
      expect(names.get(A)).not.toBe(names.get(B));
    });
  });

  const income = (cashPositionId: string) => ({
    kind: 'income' as const,
    incomeKind: 'employment',
    receivedOn: '2026-09-10',
    netAmount: '500',
    grossAmount: null,
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId,
    description: 'September salary',
    templateId: null,
    occurrenceDate: null,
  });

  const expense = (cashPositionId: string, transferId: string | null = null) => ({
    kind: 'expense' as const,
    categoryId: 'cat-1',
    categoryKind: 'food',
    incurredOn: '2026-09-12',
    amount: '40',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId,
    description: null,
    isOneOff: false,
    transferId,
    templateId: null,
    occurrenceDate: null,
  });

  const transfer = (fromPositionId: string, toPositionId: string) => ({
    kind: 'transfer' as const,
    occurredOn: '2026-09-20',
    fromPositionId,
    fromCurrency: 'EUR',
    fromAmount: '100',
    toPositionId,
    toCurrency: 'EUR',
    toAmount: '100',
    description: null,
  });

  it('shows an income moved between two Savings accounts as a change of account', () => {
    const value = onlyChange(income(A), income(B));
    const row = field(value, 'Account');
    expect(row?.changed).toBe(true);
    expect(row?.before).not.toBe(row?.after);
    expect(changedLabels(value)).toEqual(['Account']);

    // The dialog marks it, and prints two different names.
    const html = renderToStaticMarkup(
      createElement(CorrectionReview, {
        draft: DRAFT,
        preview: value,
        labels: TWINS,
        onBack: vi.fn(),
        onCommitted: vi.fn(),
      }),
    );
    expect(html).toMatch(/data-field="Account" data-changed="true"/u);
    expect(html).toContain(row?.before as string);
    expect(html).toContain(row?.after as string);
  });

  it('shows an expense paid from the other Savings account as a change of account', () => {
    const value = onlyChange(expense(A), expense(B), 'expense');
    expect(field(value, 'Account')?.changed).toBe(true);
    expect(field(value, 'Account')?.before).not.toBe(field(value, 'Account')?.after);
    expect(changedLabels(value)).toEqual(['Account']);
  });

  it('shows a transfer whose sending side moved between the two', () => {
    const value = onlyChange(transfer(A, 'pos-1'), transfer(B, 'pos-1'), 'transfer');
    expect(field(value, 'From')?.changed).toBe(true);
    expect(field(value, 'From')?.before).not.toBe(field(value, 'From')?.after);
    expect(changedLabels(value)).toEqual(['From']);
  });

  it('shows a transfer whose receiving side moved between the two', () => {
    const value = onlyChange(transfer('pos-1', A), transfer('pos-1', B), 'transfer');
    expect(field(value, 'To')?.changed).toBe(true);
    expect(field(value, 'To')?.before).not.toBe(field(value, 'To')?.after);
    expect(changedLabels(value)).toEqual(['To']);
  });

  it('shows a transfer fee now paid from the other Savings account', () => {
    const value = onlyChange(expense(A, 'tr-1'), expense(B, 'tr-1'), 'expense');
    expect(field(value, 'Account')?.changed).toBe(true);
    expect(field(value, 'Account')?.before).not.toBe(field(value, 'Account')?.after);
  });

  it('names the account of every balance, told apart when two share a name', () => {
    const balance = (positionId: string) => ({
      kind: 'valuation' as const,
      positionId,
      valuedOn: '2026-10-05',
      amount: '120',
      currency: 'EUR',
      datePrecision: 'exact' as const,
      note: null,
    });
    const value = preview({
      sourceChanges: [
        {
          identity: { scope: 'prospective', kind: 'valuation', role: 'valuation', owner: A },
          operation: 'create',
          before: null,
          after: balance(A),
        },
        {
          identity: { scope: 'prospective', kind: 'valuation', role: 'valuation', owner: B },
          operation: 'create',
          before: null,
          after: balance(B),
        },
      ],
    });

    const first = field(value, 'Account', 0)?.after;
    const second = field(value, 'Account', 1)?.after;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(first?.startsWith('Savings')).toBe(true);
  });

  it('decides a category change on the category, not on its name', () => {
    // Two categories the page did not label read the same way, and are still
    // two different categories.
    const value = onlyChange(
      { ...expense('pos-1'), categoryId: 'cat-archived-1' },
      { ...expense('pos-1'), categoryId: 'cat-archived-2' },
      'expense',
    );
    expect(field(value, 'Category')).toMatchObject({
      before: 'A category',
      after: 'A category',
      changed: true,
    });
  });
});
