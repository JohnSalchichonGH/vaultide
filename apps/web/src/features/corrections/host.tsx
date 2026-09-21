'use client';

import { CorrectionReview } from './review-dialog';
import type { CorrectionLabels } from './presentation';
import type { CorrectionFlow } from './use-correction';

/**
 * The review dialog, wherever an editor can open one (16.5).
 *
 * One line per editor rather than a copy of the dialog's wiring in each. It
 * renders nothing until a save has actually been told that consent is needed,
 * so an editor that never produces a correction pays nothing for it.
 */
export function CorrectionHost({
  flow,
  labels,
  onCommitted,
}: {
  readonly flow: CorrectionFlow;
  readonly labels: CorrectionLabels;
  readonly onCommitted: () => void;
}) {
  const pending = flow.pending;
  if (pending === null) return null;

  // Stepped back: the edit is still unsaved and still needs consent, so the
  // way back in stays on screen rather than leaving a dead draft (§67).
  if (flow.paused) {
    return (
      <button
        type="button"
        data-testid="correction-reopen"
        className="min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium"
        onClick={flow.resume}
      >
        Review changes
      </button>
    );
  }

  return (
    <CorrectionReview
      draft={pending.draft}
      preview={pending.preview}
      labels={labels}
      onBack={flow.pause}
      onCommitted={() => {
        flow.clear();
        onCommitted();
      }}
    />
  );
}
