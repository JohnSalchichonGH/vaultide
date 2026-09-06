import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

/** Labels are always visible and always linked to their control (16.6). */
export function Label({ className, ...props }: ComponentPropsWithoutRef<'label'>) {
  return (
    <label
      className={cn(
        'block text-[length:var(--text-meta)] font-medium text-[var(--color-muted-foreground)]',
        className,
      )}
      {...props}
    />
  );
}
