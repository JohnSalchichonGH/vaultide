import type { AggregateDto } from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { cn } from '@/lib/utils';

/**
 * A total, with the truth about how complete it is (blueprint 7.6, 10.5, 16.2).
 *
 * This component exists because the single most damaging thing a finance app
 * can do is show a clean number that is quietly missing something. So:
 *
 *  - `available` renders the figure;
 *  - `partial` renders the figure **and** says what is not inside it;
 *  - `unavailable` renders `—`, never `0`.
 *
 * The interface does not work any of that out. The domain result carries the
 * availability and the list of what is missing, and this renders it.
 */

export interface AggregateFigureProps {
  readonly aggregate: AggregateDto;
  readonly locale: string;
  readonly minorUnits: number;
  readonly size?: 'headline' | 'section' | 'inline';
  readonly signed?: boolean;
  readonly className?: string;
  /** Show the per-currency native breakdown under the figure. */
  readonly showNative?: boolean;
  /** Minor units per currency, so each native total formats in its own scale. */
  readonly minorUnitsByCurrency?: Record<string, number>;
}

const SIZE_CLASS = {
  headline: 'text-[length:var(--text-headline-lg)] font-semibold tracking-tight',
  section: 'text-[length:var(--text-page)] font-semibold',
  inline: '',
} as const;

function reasonText(reason: string): string {
  switch (reason) {
    case 'fx_missing':
      return 'no exchange rate yet';
    case 'no_valuation':
      return 'no value recorded';
    default:
      return reason.replaceAll('_', ' ');
  }
}

export function AggregateFigure({
  aggregate,
  locale,
  minorUnits,
  size = 'inline',
  signed = false,
  className,
  showNative = false,
  minorUnitsByCurrency,
}: AggregateFigureProps) {
  const unavailable = aggregate.value === null;

  return (
    <div className={cn('space-y-1', className)}>
      <div className={cn('tabular', SIZE_CLASS[size])}>
        <MoneyText
          amount={aggregate.value?.amount ?? null}
          currency={aggregate.value?.currency}
          locale={locale}
          minorUnits={minorUnits}
          signed={signed}
          unavailableReason={
            unavailable ? 'Nothing here could be valued yet.' : undefined
          }
        />
      </div>

      {aggregate.availability !== 'available' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={unavailable ? 'unavailable' : 'warning'}>
            {unavailable ? 'Unavailable' : 'Partial'}
          </Badge>
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            {unavailable ? 'Not in this figure: ' : 'Not included: '}
            {aggregate.missing
              .map((item) => `${item.positionName} (${reasonText(item.reason)})`)
              .join(', ')}
          </p>
        </div>
      ) : null}

      {showNative && aggregate.native.length > 1 ? (
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Held as{' '}
          {aggregate.native.map((item, index) => (
            <span key={item.currency}>
              {index > 0 ? ' · ' : ''}
              <MoneyText
                amount={item.amount}
                currency={item.currency}
                locale={locale}
                minorUnits={minorUnitsByCurrency?.[item.currency] ?? minorUnits}
              />
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
