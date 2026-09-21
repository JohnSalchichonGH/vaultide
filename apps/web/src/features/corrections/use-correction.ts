'use client';

import { useState } from 'react';
import type { CorrectionDraft, CorrectionPreview } from '@vaultide/application';
import { previewHistoricalCorrectionAction } from '@/server/actions/corrections';
import type { SaveOutcome } from '@/features/monthly/autosave';

/**
 * One decision, in one place: save it, or review it first (§25, §55).
 *
 * Every financial edit asks the server the same question before it writes —
 * does this rewrite a month that is already closed, or a dormant period
 * anchored in one? The answer decides the interaction:
 *
 * ```text
 * not_required     -> the ordinary save the editor already does
 * review_required  -> Review changes -> Confirm correction
 * ```
 *
 * It exists because the interface cannot always tell. An edit to a completed
 * month is obvious and the editor could route it itself; a balance recorded
 * today that happens to wake an account out of a dormant period that began in
 * June is not, and a save that hit the server guard instead would surface as a
 * refusal the user had no way to anticipate. Asking first turns that into the
 * review it should have been.
 *
 * The ordinary save is passed in as a thunk, so an editor keeps exactly the
 * save it had, and the preview costs one read only where a correction might
 * actually be needed.
 */

export type CorrectionOutcome =
  /** Nothing was needed; the ordinary save ran and this is its result. */
  | { readonly kind: 'saved'; readonly result: SaveOutcome }
  /** The review dialog is now open. Nothing has been written. */
  | { readonly kind: 'review' }
  /** The preview itself was refused — a stale version, a domain rule. */
  | { readonly kind: 'refused'; readonly result: SaveOutcome };

export interface PendingCorrection {
  readonly draft: CorrectionDraft;
  readonly preview: CorrectionPreview;
}

export interface CorrectionFlow {
  /** The correction awaiting consent, or `null`. */
  readonly pending: PendingCorrection | null;
  /**
   * Whether the user has stepped **Back** out of the review.
   *
   * The correction is still pending — nothing was written, and the draft is
   * exactly as it was typed — so the editor offers its way back in rather than
   * leaving the user with an unsaved edit and no control to finish it (§67).
   */
  readonly paused: boolean;
  /** Ask, then either save or open the review. */
  readonly attempt: (
    draft: CorrectionDraft,
    save: () => Promise<SaveOutcome>,
  ) => Promise<CorrectionOutcome>;
  /** Step back to the editor, keeping the correction. */
  readonly pause: () => void;
  /** Open the review again, on the correction that was already prepared. */
  readonly resume: () => void;
  /** Forget it: after a commit, or when the user starts something else. */
  readonly clear: () => void;
}

export function useCorrection(): CorrectionFlow {
  const [pending, setPending] = useState<PendingCorrection | null>(null);
  const [paused, setPaused] = useState(false);

  return {
    pending,
    paused,
    pause: () => {
      setPaused(true);
    },
    resume: () => {
      setPaused(false);
    },
    clear: () => {
      setPending(null);
      setPaused(false);
    },
    attempt: async (draft, save) => {
      const prepared = await previewHistoricalCorrectionAction({ draft });

      if (!prepared.ok) {
        // A refusal while resolving — a stale version, a domain rule — is the
        // same refusal the save itself would have given, and is the editor's
        // to render.
        return { kind: 'refused', result: prepared };
      }
      if (prepared.data.status === 'review_required') {
        setPending({ draft, preview: prepared.data.preview });
        setPaused(false);
        return { kind: 'review' };
      }
      // Anything the user goes on to save successfully replaces whatever was
      // waiting for consent.
      setPending(null);
      setPaused(false);
      return { kind: 'saved', result: await save() };
    },
  };
}
