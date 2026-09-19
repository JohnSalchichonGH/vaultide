'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import {
  activeMobileTab,
  mobileTabsOf,
  moreGroupsOf,
  sectionOwning,
  type ResolvedNavigationGroup,
  type ResolvedNavigationItem,
} from '@/components/shell/navigation';

/**
 * The signed-in shell's navigation below the desktop breakpoint (blueprint
 * 15.1: "Mobile: bottom tabs Dashboard · Monthly · Investments · Analytics ·
 * More").
 *
 * The one client boundary of the navigation, for the two things only the
 * browser knows: which page is open, and whether More is. Everything it shows
 * arrives resolved from the server — the same groups the desktop sidebar
 * renders, with Monthly already pointing at the session's current month — so a
 * section's route and phase are never decided here.
 *
 * A section that has not been built yet is text with the phase that brings it,
 * never a link, on the tabs and in More alike.
 *
 * More is a native modal `<dialog>`, as Quick update and the transfer editor
 * are: the browser makes the rest of the page inert, moves focus into it and
 * closes it on Escape; focus goes back to the More button when it closes.
 */

const TAB =
  'relative flex h-14 w-full flex-col items-center justify-center gap-0.5 px-0.5 text-center text-[length:var(--text-meta)] leading-4';

/** The accent bar above the current tab: position and weight say it too, not only colour. */
const CURRENT = 'font-semibold text-[var(--color-foreground)] before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-full before:bg-[var(--color-accent)]';

function PhaseNote({ phase }: { readonly phase: number }) {
  return (
    <>
      <span aria-hidden="true" className="text-[length:var(--text-meta)] font-normal">
        {`Phase ${String(phase)}`}
      </span>
      <span className="sr-only">{`, arrives in Phase ${String(phase)}`}</span>
    </>
  );
}

function Tab({ item, current }: { readonly item: ResolvedNavigationItem; readonly current: boolean }) {
  if (item.href === null) {
    return (
      <span className={cn(TAB, 'text-[var(--color-unavailable)]')} data-testid={`mobile-tab-${item.key}`}>
        <span className="whitespace-nowrap">{item.label}</span>
        <PhaseNote phase={item.phase} />
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      data-testid={`mobile-tab-${item.key}`}
      className={cn(TAB, current ? CURRENT : 'text-[var(--color-muted-foreground)]')}
    >
      <span className="whitespace-nowrap">{item.label}</span>
    </Link>
  );
}

export function MobileNavigation({ groups }: { readonly groups: readonly ResolvedNavigationGroup[] }) {
  const pathname = usePathname();
  const hydrated = useHydrated();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const headingId = useId();

  const active = activeMobileTab(pathname, groups);
  const owner = sectionOwning(pathname, groups);
  const tabs = mobileTabsOf(groups);
  const more = moreGroupsOf(groups);

  // Arriving on another page — through a link in More, or Back — leaves More closed.
  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  const close = () => {
    dialogRef.current?.close();
  };

  return (
    <>
      <nav
        aria-label="Sections"
        data-testid="mobile-navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {tabs.map((item) => (
            <li key={item.key} className="relative min-w-0">
              <Tab item={item} current={active === item.key} />
            </li>
          ))}
          <li className="relative min-w-0">
            <button
              ref={triggerRef}
              type="button"
              data-testid="mobile-tab-more"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={dialogId}
              // More is the current tab when the page belongs to a section inside it.
              aria-current={active === 'more' ? 'true' : undefined}
              disabled={!hydrated}
              className={cn(TAB, active === 'more' ? CURRENT : 'text-[var(--color-muted-foreground)]')}
              onClick={() => {
                dialogRef.current?.showModal();
                setOpen(true);
              }}
            >
              <span className="whitespace-nowrap">More</span>
            </button>
          </li>
        </ul>
      </nav>

      <dialog
        ref={dialogRef}
        id={dialogId}
        aria-labelledby={headingId}
        data-testid="more-navigation"
        // A bottom sheet: Tailwind's preflight zeroes the user agent's `margin:
        // auto`, and `mt-auto` puts the modal back — against the bottom edge,
        // full width, and never taller than most of the screen.
        className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-[var(--radius-surface)] border-t bg-[var(--color-surface)] p-0 pb-[env(safe-area-inset-bottom)] text-[var(--color-foreground)] backdrop:bg-black/40"
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={(event) => {
          // A tap on the backdrop lands on the dialog itself, outside its content.
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <h2 id={headingId} className="text-[length:var(--text-section)] font-semibold">
            More
          </h2>
          <button
            type="button"
            data-testid="more-navigation-close"
            className="min-h-11 rounded-[var(--radius-control)] border px-3 text-[length:var(--text-meta)]"
            onClick={close}
          >
            Close
          </button>
        </div>
        <nav aria-label="More sections" className="px-4 py-3">
          <ul className="space-y-4">
            {more.map((group) => (
              <li key={group.label}>
                <p className="mb-1 text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  {group.label}
                </p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.key} className="relative">
                      {item.href === null ? (
                        <span
                          data-testid={`more-item-${item.key}`}
                          className="flex min-h-11 items-center justify-between gap-3 text-[var(--color-unavailable)]"
                        >
                          <span className="min-w-0">{item.label}</span>
                          <PhaseNote phase={item.phase} />
                        </span>
                      ) : (
                        <Link
                          href={item.href}
                          data-testid={`more-item-${item.key}`}
                          aria-current={owner?.key === item.key ? 'page' : undefined}
                          className={cn(
                            'flex min-h-11 items-center underline',
                            owner?.key === item.key && 'font-semibold',
                          )}
                          onClick={close}
                        >
                          {item.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
      </dialog>
    </>
  );
}
