'use client';

import { useState } from 'react';
import type {
  CorrectionDraft,
  CorrectionPreparation,
  CorrectionPreview,
} from '@vaultide/application';
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
 *
 * ## The gap between asking and saving
 *
 * Preview and the ordinary save are two round trips, and another writer can
 * commit in between — a second tab, a phone, a recurring acceptance. So this
 * sequence is reachable and always will be:
 *
 * ```text
 * preview  -> not_required
 *            (somebody else moves the authoritative state)
 * save     -> HISTORICAL_REVIEW_REQUIRED
 * ```
 *
 * The server is safe: the guard refuses **before** a row moves, so nothing was
 * written. What was wrong was the interface stopping there and showing the
 * guard's refusal as a failure, when the whole point of asking first was to
 * turn that refusal into the review. So the flow finishes the protocol: it asks
 * once more, for the same unchanged draft, and opens the review on the fresh
 * answer.
 *
 * Exactly once. If the second preview says `not_required` again — the other
 * writer having moved the state back, or a narrow interleaving between the two
 * trips — the attempt is **refused** with the guard's own message rather than
 * saved again. A loop that kept alternating would be an interface that never
 * settles, and a save issued on the strength of a stale answer is the thing the
 * guard exists to stop. `CONFLICT_VERSION` and `CONFLICT_DUPLICATE` are never
 * retried at all: they mean the server holds something newer, which re-asking
 * cannot change.
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

/** The guard's own code, raised by an ordinary write that needs the ceremony. */
export const REVIEW_REQUIRED = 'HISTORICAL_REVIEW_REQUIRED';

const refusedBy = (outcome: SaveOutcome): boolean =>
  !outcome.ok && outcome.error.code === REVIEW_REQUIRED;

/** What one attempt needs from the world: the server, and somewhere to put the answer. */
export interface AttemptPorts {
  /** Ask the server whether this draft needs the ceremony. */
  readonly ask: (draft: CorrectionDraft) => Promise<PreparationOutcome>;
  /** Hold a correction for consent and open the review on it. */
  readonly open: (draft: CorrectionDraft, preview: CorrectionPreview) => void;
  /** Forget whatever was waiting for consent. */
  readonly forget: () => void;
}

type PreparationOutcome =
  | { readonly ok: true; readonly data: CorrectionPreparation }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/**
 * One attempt, as a function of its ports.
 *
 * The protocol, without React: ask, save, and — only for the guard's own
 * refusal — ask exactly once more. Separated from the hook because the race it
 * recovers from is a sequence of server answers, and a test of it should be
 * able to state that sequence rather than drive a renderer.
 */
export async function attemptCorrection(
  ports: AttemptPorts,
  draft: CorrectionDraft,
  save: () => Promise<SaveOutcome>,
): Promise<CorrectionOutcome> {
  const prepared = await ports.ask(draft);

  if (!prepared.ok) {
    // A refusal while resolving — a stale version, a domain rule — is the same
    // refusal the save itself would have given, and is the editor's to render.
    return { kind: 'refused', result: prepared };
  }
  if (prepared.data.status === 'review_required') {
    ports.open(draft, prepared.data.preview);
    return { kind: 'review' };
  }

  ports.forget();
  const saved = await save();
  if (!refusedBy(saved)) return { kind: 'saved', result: saved };

  // The authoritative state moved between asking and saving. Nothing was
  // written; ask once more and open the review on the fresh answer.
  const again = await ports.ask(draft);
  if (!again.ok) return { kind: 'refused', result: again };
  if (again.data.status === 'review_required') {
    ports.open(draft, again.data.preview);
    return { kind: 'review' };
  }
  // Still `not_required` after the guard refused: the two answers cannot both
  // be acted on, so the draft is kept and the guard's own message stands.
  return { kind: 'refused', result: saved };
}

export function useCorrection(): CorrectionFlow {
  const [pending, setPending] = useState<PendingCorrection | null>(null);
  const [paused, setPaused] = useState(false);

  const ports: AttemptPorts = {
    ask: (draft) => previewHistoricalCorrectionAction({ draft }),
    open: (draft, preview) => {
      setPending({ draft, preview });
      setPaused(false);
    },
    forget: () => {
      // Anything the user goes on to save replaces whatever was waiting for
      // consent.
      setPending(null);
      setPaused(false);
    },
  };

  return {
    pending,
    paused,
    pause: () => {
      setPaused(true);
    },
    resume: () => {
      setPaused(false);
    },
    clear: ports.forget,
    attempt: (draft, save) => attemptCorrection(ports, draft, save),
  };
}
