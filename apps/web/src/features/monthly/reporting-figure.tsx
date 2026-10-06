import type { ReportingAmountDto } from '@vaultide/application';
import { Badge } from '@/components/ui/badge';
import { FigureStatement, META, type Formatting } from '@/features/spending/figure';
import type { FigureDisplay } from '@/features/spending/presentation';

/**
 * One reporting-currency figure with the truth about it (blueprint 7.6, 8.11,
 * 12.5, 16.2, v2.1.13 30.16; ADR 0008 §5 and its addendum).
 *
 * The figure's availability is its own, and `rule` decides how it reads,
 * exactly as Spending reads the same figure: `spendingFigureDisplay` for a sum
 * of non-negative contributions, whose partial value is a lower bound, and
 * `savingsFigureDisplay` for a savings figure, whose partial value is no bound
 * at all. So an exact figure prints its amount; a partial spending or
 * income figure prints `≥` and the amount, with what is not inside it; and
 * anything that cannot be stated prints `—` and why — never the zero the value
 * field holds. How the rates were found is a separate fact, shown beside it and
 * never mistaken for either.
 */

export interface ReportingFigureProps {
  readonly label: string;
  readonly amount: ReportingAmountDto;
  readonly rule: (amount: ReportingAmountDto) => FigureDisplay;
  readonly formatting: Formatting;
  readonly testId: string;
  /** A short line under the label, e.g. "Informational — in no total". */
  readonly note?: string;
  readonly emphasis?: boolean;
}

export function ReportingFigure({
  label,
  amount,
  rule,
  formatting,
  testId,
  note,
  emphasis = false,
}: ReportingFigureProps) {
  const display = rule(amount);

  return (
    <div
      className="space-y-1"
      data-testid={testId}
      data-availability={amount.availability}
      data-display={display.kind}
    >
      <dt className={META}>{label}</dt>
      <dd className="space-y-1">
        <FigureStatement display={display} formatting={formatting} emphasis={emphasis} />
        {amount.quality === 'estimated' ? <Badge tone="info">Estimated</Badge> : null}
        {amount.provenance.estimatedConversion ? (
          <p className={META}>Includes unclassified spending converted at the month’s average rate.</p>
        ) : null}
        {amount.provenance.approximate ? (
          <p className={META}>Some rates come from an earlier day than the flow’s own.</p>
        ) : null}
        {note === undefined ? null : <p className={META}>{note}</p>}
      </dd>
    </div>
  );
}
