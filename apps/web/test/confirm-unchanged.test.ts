import { describe, expect, it, vi } from 'vitest';
import type { CorrectionDraft, CorrectionPreview } from '@vaultide/application';
import type { SaveState } from '@/features/monthly/autosave';
import type { CorrectionFlow } from '@/features/corrections/use-correction';

// The two ordinary actions, observed: whether each is called, and with what.
const confirmUnchangedAction = vi.fn();
const confirmUnchangedBatchAction = vi.fn();
vi.mock('@/server/actions/positions', () => ({ confirmUnchangedAction, confirmUnchangedBatchAction }));
vi.mock('@/server/actions/corrections', () => ({
  previewHistoricalCorrectionAction: vi.fn(),
  confirmHistoricalCorrectionAction: vi.fn(),
}));

const { attemptCorrection, prepareReviewWith } = await import('@/features/corrections/use-correction');
const { attemptUnchanged, saveAllUnchanged, saveUnchanged } = await import('@/features/corrections/unchanged');

/**
 * "Unchanged this month" asks first, like every other balance (blueprint 8.8,
 * 30.20 item 6, 30.22; ADR 0010 §1).
 *
 * The Monthly row, "Confirm all untouched as unchanged" and the account page's
 * month-end section each confirm through these functions, with the editor's
 * own correction flow. What is pinned here is the interaction the server's
 * answer decides: `not_required` saves through the ordinary action exactly as
 * before; `review_required` opens the review and sends no ordinary request.
 */

const BBVA = '62626262-6262-4262-8262-626262626262';
const SAVINGS = '64646464-6464-4464-8464-646464646464';
const MONTH = '2026-09';

const PREVIEW = { fingerprint: 'hc-v1:test' } as unknown as CorrectionPreview;
const NOT_REQUIRED = { ok: true, data: { status: 'not_required' } } as const;
const REVIEW_REQUIRED = { ok: true, data: { status: 'review_required', preview: PREVIEW } } as const;

/** A flow running the real protocol against a server that gives one answer. */
function flowAnswering(answer: typeof NOT_REQUIRED | typeof REVIEW_REQUIRED) {
  const asked: CorrectionDraft[] = [];
  const opened: CorrectionDraft[] = [];
  const ports = {
    ask: (draft: CorrectionDraft) => {
      asked.push(draft);
      return Promise.resolve(answer);
    },
    open: (draft: CorrectionDraft) => {
      opened.push(draft);
    },
    forget: () => undefined,
  };
  const flow: CorrectionFlow = {
    pending: null,
    paused: false,
    pause: () => undefined,
    resume: () => undefined,
    clear: () => undefined,
    attempt: (draft, save) => attemptCorrection(ports, draft, save),
    prepareReview: (draft) => prepareReviewWith(ports, draft),
  };
  return { flow, asked, opened };
}

function reporter() {
  const states: SaveState['kind'][] = [];
  return { states, report: (state: SaveState) => states.push(state.kind) };
}

const fresh = () => {
  confirmUnchangedAction.mockReset().mockResolvedValue({ ok: true, data: { id: 'v', valuedOn: '2026-09-30' } });
  confirmUnchangedBatchAction.mockReset().mockResolvedValue({ ok: true, data: { confirmed: 2 } });
};

describe('one account, from the Monthly row', () => {
  it('saves through the ordinary action when no review is needed', async () => {
    fresh();
    const { flow, asked, opened } = flowAnswering(NOT_REQUIRED);
    const { states, report } = reporter();
    const refresh = vi.fn();

    expect(await saveUnchanged(flow, BBVA, MONTH, report, refresh)).toEqual({ kind: 'saved' });

    // The draft is the request: an account and a month, and no figure.
    expect(asked).toEqual([{ kind: 'confirm_unchanged', positionId: BBVA, month: MONTH }]);
    expect(confirmUnchangedAction).toHaveBeenCalledExactlyOnceWith({ positionId: BBVA, month: MONTH });
    expect(opened).toEqual([]);
    expect(states).toEqual(['saving', 'saved']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('opens the review instead, sending no ordinary request', async () => {
    fresh();
    const { flow, opened } = flowAnswering(REVIEW_REQUIRED);
    const { states, report } = reporter();
    const refresh = vi.fn();

    expect(await saveUnchanged(flow, SAVINGS, MONTH, report, refresh)).toEqual({ kind: 'idle' });

    expect(confirmUnchangedAction).not.toHaveBeenCalled();
    expect(opened).toEqual([{ kind: 'confirm_unchanged', positionId: SAVINGS, month: MONTH }]);
    expect(states).toEqual(['saving', 'idle']);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('every untouched account, from "Confirm all untouched as unchanged"', () => {
  it('saves the whole batch through the ordinary action when no review is needed', async () => {
    fresh();
    const { flow, asked } = flowAnswering(NOT_REQUIRED);
    const { states, report } = reporter();

    expect(await saveAllUnchanged(flow, MONTH, [BBVA, SAVINGS], report, vi.fn())).toEqual({ kind: 'saved' });

    expect(asked).toEqual([{ kind: 'confirm_unchanged_batch', month: MONTH, positionIds: [BBVA, SAVINGS] }]);
    expect(confirmUnchangedBatchAction).toHaveBeenCalledExactlyOnceWith({
      month: MONTH,
      positionIds: [BBVA, SAVINGS],
    });
    expect(states).toEqual(['saving', 'saved']);
  });

  it('opens one review for all of them, and saves none of them ordinarily', async () => {
    fresh();
    const { flow, opened } = flowAnswering(REVIEW_REQUIRED);
    const { states, report } = reporter();

    expect(await saveAllUnchanged(flow, MONTH, [BBVA, SAVINGS], report, vi.fn())).toEqual({ kind: 'idle' });

    expect(confirmUnchangedBatchAction).not.toHaveBeenCalled();
    expect(confirmUnchangedAction).not.toHaveBeenCalled();
    expect(opened).toEqual([{ kind: 'confirm_unchanged_batch', month: MONTH, positionIds: [BBVA, SAVINGS] }]);
    expect(states).toEqual(['saving', 'idle']);
  });
});

describe('one account, from the account page’s month-end section', () => {
  it('reports the ordinary save’s own answer when no review is needed', async () => {
    fresh();
    const refusal = { ok: false, error: { code: 'INCOMPLETE_DATA', message: 'No August statement.' } };
    confirmUnchangedAction.mockResolvedValueOnce(refusal);
    const { flow } = flowAnswering(NOT_REQUIRED);

    expect(await attemptUnchanged(flow, BBVA, MONTH)).toEqual({ kind: 'saved', result: refusal });
    expect(confirmUnchangedAction).toHaveBeenCalledExactlyOnceWith({ positionId: BBVA, month: MONTH });
  });

  it('opens the editor’s review instead, sending no ordinary request', async () => {
    fresh();
    const { flow, opened } = flowAnswering(REVIEW_REQUIRED);

    expect(await attemptUnchanged(flow, SAVINGS, MONTH)).toEqual({ kind: 'review' });
    expect(confirmUnchangedAction).not.toHaveBeenCalled();
    expect(opened).toEqual([{ kind: 'confirm_unchanged', positionId: SAVINGS, month: MONTH }]);
  });
});
