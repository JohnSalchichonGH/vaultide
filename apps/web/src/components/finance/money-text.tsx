import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';

/**
 * `MoneyText` (blueprint 16.2, 7.1.1).
 *
 * Renders an exact decimal string. It never receives a number, never converts
 * one, and never rounds beyond the currency's minor units. Direction is carried
 * by the sign and, optionally, an arrow — colour only reinforces it. An
 * unavailable value renders as `—` with its reason, never as `0`.
 *
 * The reason is the mouse's tooltip, and it is text a screen reader reads in
 * place of the dash (16.6): a label on a plain `<span>` names nothing, and many
 * screen readers skipped it and read only the dash. The text is visually
 * hidden, which positions it absolutely, so this element is positioned too and
 * holds it. Otherwise it would be placed against some ancestor outside a scroll
 * box that is not itself positioned, escape that box, and widen the whole page
 * on a phone (16.4).
 */
export interface MoneyTextProps {
  /** Exact decimal string, e.g. `"12345678901234567.89"`. */
  readonly amount: string | null;
  /**
   * Each optional prop explicitly admits `undefined` so a caller can spread a
   * value straight from a DTO under `exactOptionalPropertyTypes` — a converted
   * amount that could not be produced is genuinely absent, and pretending
   * otherwise at the type level would push the check into every call site.
   */
  readonly currency?: string | undefined;
  readonly locale?: string | undefined;
  readonly minorUnits?: number | undefined;
  /** Render `+` for positive values, as change figures do. */
  readonly signed?: boolean;
  /** Tint by direction, in addition to the always-rendered sign. */
  readonly colored?: boolean;
  /** Shown in place of the amount when the value cannot be computed. */
  readonly unavailableReason?: string | undefined;
  readonly className?: string | undefined;
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
    const reason = unavailableReason ?? 'Not available';
    return (
      <span
        className={cn('tabular relative text-[var(--color-unavailable)]', className)}
        title={reason}
        data-testid="money-text-unavailable"
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{reason}</span>
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
