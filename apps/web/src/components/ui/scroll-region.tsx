import type { ComponentPropsWithoutRef } from 'react';

/**
 * The scroll box around a table or chart that holds nothing focusable
 * (blueprint 16.4 "horizontal scroll container on narrow screens", 16.6).
 *
 * A keyboard scrolls a box only through something focused inside it, so a
 * read-only table wider than a phone would be out of its reach. This box is a
 * Tab stop of its own, where the arrow keys scroll it, and a region named by
 * `label`, so a screen reader says what has focus. It takes its overflow class
 * from the caller, like the plain box it replaces. A box whose content has
 * controls of its own is reached through them and stays a plain `div`.
 */
export function ScrollRegion({
  label,
  ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'role' | 'tabIndex' | 'aria-label'> & { readonly label: string }) {
  return <div role="region" aria-label={label} tabIndex={0} {...props} />;
}
