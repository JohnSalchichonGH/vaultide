import type { ReportingAmountDto } from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { missingSummary } from '@/features/monthly/presentation';
import { cn } from '@/lib/utils';

/**
 * One reporting-currency figure with the truth about it (blueprint 7.6, 8.11,
 * 12.5, v2.1.13 30.16).
 *
 * The figure's availability is its own and is shown as written: `available`
 * renders the amount; `partial` renders the amount **and** a Partial badge with
 * what is not inside it; `unavailable` renders `—` and says why — never the
 * zero the value field holds when nothing could be stated. How the rates were
 * found is a third fact, shown beside it and never mistaken for either.
 */

export interface ReportingFigureProps {
  readonly label: string;
  readonly amount: ReportingAmountDto;
  readonly locale: string;
  readonly minorUnits: number;
  readonly testId: string;
  /** A short line under the label, e.g. "Informational — in no total". */
  readonly note?: string;
  readonly emphasis?: boolean;
}

export function ReportingFigure({
  label,
  amount,
  locale,
  minorUnits,
  testId,
  note,
  emphasis = false,
}: ReportingFigureProps) {
  const unavailable = amount.availability === 'unavailable';
  const missing = missingSummary(amount.missing);

  return (
    <div className="space-y-1" data-testid={testId} data-availability={amount.availability}>
      <dt className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="space-y-1">
        <div className={cn('tabular', emphasis && 'text-[length:var(--text-page)] font-semibold')}>
          <MoneyText
            amount={unavailable ? null : amount.value.amount}
            currency={amount.value.currency}
            locale={locale}
            minorUnits={minorUnits}
            unavailableReason={
              unavailable ? `Not available: ${missing === '' ? 'nothing to state' : missing}.` : undefined
            }
            className="whitespace-nowrap"
          />
        </div>
        {amount.availability === 'available' ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={unavailable ? 'unavailable' : 'warning'}>
              {unavailable ? 'Unavailable' : 'Partial'}
            </Badge>
            {missing === '' ? null : (
              <span className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                {unavailable ? 'Why: ' : 'Not included: '}
                {missing}
              </span>
            )}
          </div>
        )}
        {amount.quality === 'estimated' ? <Badge tone="info">Estimated</Badge> : null}
        {amount.provenance.estimatedConversion ? (
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Includes unclassified spending converted at the month’s average rate.
          </p>
        ) : null}
        {amount.provenance.approximate ? (
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Some rates come from an earlier day than the flow’s own.
          </p>
        ) : null}
        {note === undefined ? null : (
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">{note}</p>
        )}
      </dd>
    </div>
  );
}
