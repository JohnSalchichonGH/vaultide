'use client';

import type { CorrectionDraft } from '@vaultide/application';
import { outcomeState, type SaveOutcome, type SaveState } from '@/features/monthly/autosave';
import type { CorrectionFlow } from './use-correction';

/**
 * One save that might be a correction (§25, §66).
 *
 * The same shape as `runSave`, and it reports the same states, so an editor
 * keeps the autosave behaviour it already has. The one difference is the middle
 * outcome: when the server says the edit rewrites completed history, the review
 * dialog opens and the field goes back to **idle** rather than to saved.
 *
 * That is deliberate. The field's draft is still the only place the user's
 * value exists — nothing has been written — so leaving it uncommitted is what
 * makes Back return them to exactly what they typed (§67).
 */

const UNREACHABLE =
  'That could not be saved — the server did not answer. Check your connection and try again.';

export async function runCorrectableSave(
  flow: CorrectionFlow,
  draft: CorrectionDraft,
  send: () => Promise<SaveOutcome>,
  report: (state: SaveState) => void,
  refresh: () => void,
): Promise<SaveState> {
  report({ kind: 'saving' });

  let final: SaveState;
  try {
    const outcome = await flow.attempt(draft, send);
    final =
      outcome.kind === 'review'
        ? { kind: 'idle' }
        : outcomeState(outcome.result);
  } catch {
    final = { kind: 'error', message: UNREACHABLE };
  }

  report(final);
  if (final.kind === 'saved') refresh();
  return final;
}
