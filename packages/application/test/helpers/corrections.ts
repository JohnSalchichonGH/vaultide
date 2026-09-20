import { expect } from 'vitest';
import type { RequestContext } from '../../src/context';
import { updateCashAccount, type PositionDependencies } from '../../src/positions/service';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDependencies,
  type CorrectionDraft,
  type CorrectionPreview,
} from '../../src/corrections/index';

/**
 * Perform an operation the way the interface does (blueprint 30.22; ADR 0010).
 *
 * Every financial edit now asks the same question first: does this rewrite a
 * month that is already closed, or a dormant episode anchored in one? The
 * answer decides which path it takes.
 *
 * ```text
 * not_required     -> save normally
 * review_required  -> Review changes -> Confirm correction
 * ```
 *
 * The suites use this wherever a fixture's dates make an operation historical,
 * so they keep asserting the rule they were written for — what a dormant
 * episode is anchored to, what wakes it, what a correction leaves behind —
 * rather than being rewritten around the ceremony. The ordinary call is passed
 * in as a thunk and is what actually runs when no consent is needed, so a test
 * that stops being historical does not silently start exercising a different
 * code path.
 */
export async function saveOrCorrect<T>(
  corrections: CorrectionDependencies,
  ctx: RequestContext,
  draft: CorrectionDraft,
  ordinary: () => Promise<T>,
): Promise<{ readonly via: 'ordinary' | 'correction'; readonly preview: CorrectionPreview | null }> {
  const prepared = await previewHistoricalCorrection(corrections, ctx, { draft });
  if (prepared.status === 'not_required') {
    await ordinary();
    return { via: 'ordinary', preview: null };
  }

  const result = await confirmHistoricalCorrection(corrections, ctx, {
    draft,
    fingerprint: prepared.preview.fingerprint,
  });
  expect(result.status, 'the correction should commit on an unchanged world').toBe('committed');
  return { via: 'correction', preview: prepared.preview };
}

/** The preview of a draft that must need consent, for a test that asserts on it. */
export async function requirePreview(
  corrections: CorrectionDependencies,
  ctx: RequestContext,
  draft: CorrectionDraft,
): Promise<CorrectionPreview> {
  const prepared = await previewHistoricalCorrection(corrections, ctx, { draft });
  if (prepared.status !== 'review_required') {
    throw new Error('expected this draft to require Historical Correction review');
  }
  return prepared.preview;
}

/** Preview then confirm, asserting a commit. Returns the preview that was confirmed. */
export async function reviewAndConfirm(
  corrections: CorrectionDependencies,
  ctx: RequestContext,
  draft: CorrectionDraft,
  reason?: string,
): Promise<CorrectionPreview> {
  const preview = await requirePreview(corrections, ctx, draft);
  const result = await confirmHistoricalCorrection(corrections, ctx, {
    draft,
    fingerprint: preview.fingerprint,
    ...(reason === undefined ? {} : { reason }),
  });
  expect(result.status).toBe('committed');
  return preview;
}

/**
 * Set or clear an account's dormant flag the way the account form does.
 *
 * A fixture that anchors an episode on a zero balance from a month that has
 * closed is performing a Historical Correction, whatever else the save is
 * about (30.22 item 1; §10 of the slice prompt). Suites whose subject is
 * something else entirely — completeness, month-to-date, the Monthly read —
 * reach for this so their fixture keeps setting up the state it always set up.
 */
export async function setDormantFlag(
  deps: { readonly corrections: CorrectionDependencies; readonly positions: PositionDependencies },
  ctx: RequestContext,
  args: { readonly positionId: string; readonly expectedVersion: number; readonly isDormant: boolean },
): Promise<void> {
  await saveOrCorrect(
    deps.corrections,
    ctx,
    { kind: 'cash_account_update', ...args },
    () => updateCashAccount(deps.positions, ctx, args),
  );
}
