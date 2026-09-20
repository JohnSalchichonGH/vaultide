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

  return (
    <CorrectionReview
      draft={pending.draft}
      preview={pending.preview}
      labels={labels}
      onBack={flow.dismiss}
      onCommitted={() => {
        flow.dismiss();
        onCommitted();
      }}
    />
  );
}
