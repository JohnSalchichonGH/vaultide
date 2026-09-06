import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

/** Surface primitive: 1px border, small radius, no shadow (blueprint 16.2). */
export function Card({ className, ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-surface)] border bg-[var(--color-surface)] text-[var(--color-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<'header'>) {
  return <header className={cn('border-b px-6 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<'h2'>) {
  return (
    <h2
      className={cn('text-[length:var(--text-section)] font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      className={cn(
        'mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('px-6 py-4', className)} {...props} />;
}
