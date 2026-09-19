'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal dialog (blueprint 16.5, 16.6).
 *
 * The native `<dialog>` element opened with `showModal()`, so the browser gives
 * the focus trap, the inert background and the Escape handling rather than a
 * re-implementation of all three. The transfer editor's own dialog was the
 * first of these; corrective actions open the same shape, so it lives here.
 *
 * `busy` refuses the Escape key while a save is in flight: a dialog that
 * vanishes mid-request takes its own error message with it.
 */
export function Modal({
  title,
  busy,
  testId,
  onClose,
  children,
}: {
  readonly title: string;
  readonly busy: boolean;
  readonly testId: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const element = ref.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      data-testid={testId}
      // `m-auto` centres the modal again after Tailwind's preflight resets the
      // user agent's `margin: auto`, as in Quick update.
      className="m-auto w-[min(40rem,92vw)] rounded-[var(--radius-surface)] border bg-[var(--color-surface)] p-0 text-[var(--color-foreground)] backdrop:bg-black/40"
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="border-b px-4 py-3 sm:px-6">
        <h3 id={headingId} className="text-[length:var(--text-section)] font-semibold">
          {title}
        </h3>
      </div>
      {children}
    </dialog>
  );
}
