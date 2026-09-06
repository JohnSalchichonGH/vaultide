import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';

/**
 * `MoneyText` (blueprint 16.2, 7.1.1).
 *
 * Renders an exact decimal string. It never receives a number, never converts
 * one, and never rounds beyond the currency's minor units. Direction is carried
 * by the sign and, optionally, an arrow — colour only reinforces it. An
 * unavailable value renders as `—` with its reason, never as `0`.
 */
export interface MoneyTextProps {
  /** Exact decimal string, e.g. `"12345678901234567.89"`. */
  readonly amount: string | null;
  readonly currency?: string;
  readonly locale?: string;
  readonly minorUnits?: number;
  /** Render `+` for positive values, as change figures do. */
  readonly signed?: boolean;
  /** Tint by direction, in addition to the always-rendered sign. */
  readonly colored?: boolean;
  /** Shown in place of the amount when the value cannot be computed. */
  readonly unavailableReason?: string;
  readonly className?: string;
}

export function MoneyText({
  amount,
  currency,
  locale,
  minorUnits,
  signed = false,
  colored = false,
  unavailableReason,
  className,
}: MoneyTextProps) {
  if (amount === null) {
    return (
      <span
        className={cn('tabular text-[var(--color-unavailable)]', className)}
        title={unavailableReason ?? 'Not available'}
        aria-label={unavailableReason ?? 'Not available'}
      >
        —
      </span>
    );
  }

  const negative = amount.trimStart().startsWith('-');
  const formatted = formatMoney({
    amount,
    ...(currency === undefined ? {} : { currency }),
    ...(locale === undefined ? {} : { locale }),
    ...(minorUnits === undefined ? {} : { minorUnits }),
    alwaysSign: signed,
  });

  return (
    <span
      className={cn(
        'tabular',
        colored && (negative ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'),
        className,
      )}
      data-testid="money-text"
    >
      {formatted}
    </span>
  );
}
