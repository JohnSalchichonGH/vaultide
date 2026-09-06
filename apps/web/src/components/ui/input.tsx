import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      className={cn(
        'h-[var(--spacing-field)] w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3',
        'text-[length:var(--text-body)] text-[var(--color-foreground)]',
        'placeholder:text-[var(--color-unavailable)]',
        'aria-[invalid=true]:border-[var(--color-negative)]',
        className,
      )}
      {...props}
    />
  );
}
