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
  /** The open review, or `null`. */
  readonly pending: PendingCorrection | null;
  /** Ask, then either save or open the review. */
  readonly attempt: (
    draft: CorrectionDraft,
    save: () => Promise<SaveOutcome>,
  ) => Promise<CorrectionOutcome>;
  /** Close the review without writing anything. */
  readonly dismiss: () => void;
}

export function useCorrection(): CorrectionFlow {
  const [pending, setPending] = useState<PendingCorrection | null>(null);

  return {
    pending,
    dismiss: () => {
      setPending(null);
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
        return { kind: 'review' };
      }
      return { kind: 'saved', result: await save() };
    },
  };
}
