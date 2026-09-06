import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status chip (blueprint 16.2, 16.6). Every variant carries text as well as
 * colour: colour is reinforcement, never the only carrier of state.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border px-2 py-0.5 text-[length:var(--text-meta)] font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
        positive: 'border-[var(--color-positive)] text-[var(--color-positive)]',
        negative: 'border-[var(--color-negative)] text-[var(--color-negative)]',
        warning: 'border-[var(--color-warning)] text-[var(--color-warning)]',
        info: 'border-[var(--color-info)] text-[var(--color-info)]',
        unavailable: 'border-dashed border-[var(--color-unavailable)] text-[var(--color-unavailable)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = ComponentPropsWithoutRef<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
