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
 *
 * A dialog can open inside another: Review changes over the editor that asked
 * for it, inside a corrective action's dialog. `cancel` and `close` do not
 * bubble in the DOM, but React hands them to every ancestor's handler, so each
 * handler acts only on its own dialog's events. Otherwise stepping back out of
 * the review with Escape would close the dialog underneath it too, and the
 * draft the review was about would go with it.
 *
 * Focus goes back to whatever had it when the dialog opened (16.6: "dialogs
 * trap and restore focus"). Escape closes the dialog natively, and the browser
 * gives focus back itself. Back, Cancel and a confirmed save close it by
 * unmounting it instead, and a modal dialog taken off the page leaves focus
 * on the body. So when the dialog leaves and nothing has focus, focus goes
 * back to the element that opened it, if that is still on the page. The inner
 * of two dialogs hands it back inside the outer one, which stays open.
 *
 * That element is not always what has focus as the dialog opens. A control
 * that starts what the dialog waits for is often disabled until the answer
 * comes — Add income while its review is prepared — and a disabled control
 * drops focus to the body. The dialog then opens onto nothing, and the browser
 * has nothing to give back even on Escape. So the page's last focus is
 * remembered, and a dialog that opens onto nothing takes that as its opener.
 */

/** The element that last took focus on the page. */
let lastFocused: Element | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof Element) lastFocused = event.target;
    },
    true,
  );
}

/** Whether nothing on the page has focus: what had it was disabled, or taken away. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

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
  const opener = useRef<Element | null>(null);
  const headingId = useId();

  useEffect(() => {
    const element = ref.current;
    if (element !== null && !element.open) {
      opener.current = focusIsLost() ? lastFocused : document.activeElement;
      element.showModal();
    }
    const back = opener.current;
    return () => {
      if (focusIsLost() && back instanceof HTMLElement && back.isConnected) back.focus();
    };
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
        if (event.target !== event.currentTarget) return;
        if (busy) event.preventDefault();
      }}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
