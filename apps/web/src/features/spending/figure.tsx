import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FigureDisplay, RateDisplay } from '@/features/spending/presentation';

/**
 * One Spending figure as the page states it (blueprint 16.2; ADR 0008 §5).
 *
 * `value` prints the amount; `at_least` prints `≥` and the amount, with what is
 * not inside it; `none` prints `—` and why. Nothing here decides which one a
 * figure is — `spendingFigureDisplay` and `savingsFigureDisplay` did.
 */

export interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

export const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';

export function Amount({
  display,
  formatting,
  className,
}: {
  readonly display: FigureDisplay;
  readonly formatting: Formatting;
  readonly className?: string;
}) {
  if (display.kind === 'none') {
    return <MoneyText amount={null} unavailableReason={display.reason} className={className} />;
  }
  const money = (
    <MoneyText
      amount={display.amount}
      currency={display.currency}
      locale={formatting.locale}
      minorUnits={formatting.minorUnitsByCurrency[display.currency] ?? 2}
      className={cn('whitespace-nowrap', className)}
    />
  );
  return display.kind === 'value' ? (
    money
  ) : (
    <span className="whitespace-nowrap" data-bound="at-least">
      <span aria-hidden="true">≥ </span>
      <span className="sr-only">at least </span>
      {money}
    </span>
  );
}

export function SpendingFigure({
  label,
  display,
  formatting,
  testId,
  note,
  emphasis = false,
}: {
  readonly label: string;
  readonly display: FigureDisplay;
  readonly formatting: Formatting;
  readonly testId: string;
  readonly note?: ReactNode;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="space-y-1" data-testid={testId} data-display={display.kind}>
      <dt className={META}>{label}</dt>
      <dd className="space-y-1">
        <div className={cn('tabular', emphasis && 'text-[length:var(--text-page)] font-semibold')}>
          <Amount display={display} formatting={formatting} />
        </div>
        {display.kind === 'value' ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={display.kind === 'none' ? 'unavailable' : 'warning'}>
              {display.kind === 'none' ? 'Not available' : 'At least'}
            </Badge>
            <span className={META}>{display.reason}</span>
          </div>
        )}
        {note === undefined ? null : <p className={META}>{note}</p>}
      </dd>
    </div>
  );
}

export function RateFigure({
  label,
  display,
  locale,
  testId,
  note,
}: {
  readonly label: string;
  readonly display: RateDisplay;
  readonly locale: string;
  readonly testId: string;
  readonly note?: ReactNode;
}) {
  return (
    <div className="space-y-1" data-testid={testId} data-display={display.kind}>
      <dt className={META}>{label}</dt>
      <dd className="space-y-1">
        {display.kind === 'value' ? (
          <span className="tabular">{formatPercent(display.ratio, { locale })}</span>
        ) : (
          <>
            <span className="tabular text-[var(--color-unavailable)]" aria-label="Not available">
              —
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="unavailable">Not available</Badge>
              <span className={META}>{display.reason}</span>
            </div>
          </>
        )}
        {note === undefined ? null : <p className={META}>{note}</p>}
      </dd>
    </div>
  );
}
