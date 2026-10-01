'use client';

import type { CorrectionDraft } from '@vaultide/application';
import { confirmUnchangedAction, confirmUnchangedBatchAction } from '@/server/actions/positions';
import type { SaveState } from '@/features/monthly/autosave';
import { runCorrectableSave } from './save';
import type { CorrectionFlow, CorrectionOutcome } from './use-correction';

/**
 * "Unchanged this month", for one account or for the month's untouched ones,
 * asked the way every other balance is asked (blueprint 8.8, 30.20 item 6,
 * 30.22; ADR 0010 §1).
 *
 * Confirming a month unchanged writes a real balance — the previous statement,
 * carried to `end(M)` — and a non-zero balance wakes a dormant account. So it
 * is usually an ordinary save, and becomes Review → Confirm exactly when the
 * period it ends began in a month that has closed. The interface cannot tell
 * which; the server's preview can, so these ask first, like any other balance.
 *
 * The draft is the request itself: the account or accounts and the month. The
 * figure is the server's to read, so nothing here carries one.
 */

const single = (positionId: string, month: string): CorrectionDraft => ({
  kind: 'confirm_unchanged',
  positionId,
  month,
});

const batch = (month: string, positionIds: readonly string[]): CorrectionDraft => ({
  kind: 'confirm_unchanged_batch',
  month,
  positionIds,
});

/** One account, for an editor that renders its own outcome. */
export function attemptUnchanged(
  flow: CorrectionFlow,
  positionId: string,
  month: string,
): Promise<CorrectionOutcome> {
  return flow.attempt(single(positionId, month), () => confirmUnchangedAction({ positionId, month }));
}

/** One account, reported as an autosave field reports a save. */
export function saveUnchanged(
  flow: CorrectionFlow,
  positionId: string,
  month: string,
  report: (state: SaveState) => void,
  refresh: () => void,
): Promise<SaveState> {
  return runCorrectableSave(
    flow,
    single(positionId, month),
    () => confirmUnchangedAction({ positionId, month }),
    report,
    refresh,
  );
}

/**
 * Several accounts as one act: all of them or none, and — when any one of them
 * ends a dormant period anchored in a closed month — one review for all of them.
 */
export function saveAllUnchanged(
  flow: CorrectionFlow,
  month: string,
  positionIds: readonly string[],
  report: (state: SaveState) => void,
  refresh: () => void,
): Promise<SaveState> {
  return runCorrectableSave(
    flow,
    batch(month, positionIds),
    () => confirmUnchangedBatchAction({ month, positionIds: [...positionIds] }),
    report,
    refresh,
  );
}
