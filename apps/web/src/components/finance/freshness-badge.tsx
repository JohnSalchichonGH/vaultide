import { Badge } from '@/components/ui/badge';
import type { PositionValueDto } from '@vaultide/application';

/**
 * `FreshnessBadge` (blueprint 16.2, 12.1, 8.1).
 *
 * How well a number is known, said in words. Colour reinforces; it never
 * carries the meaning on its own (16.6), and an unknown value is never dressed
 * as a zero.
 *
 * The states come from the domain result, not from arithmetic on a timestamp:
 * the page is told "carried, 6 days old, from a statement balance" and renders
 * it, which is what keeps the interface and the engines saying the same thing.
 */

function ageText(value: PositionValueDto): string {
  if (value.ageDays === null || value.ageDays === 0) return '';
  if (value.ageDays < 45) return `${String(value.ageDays)} days old`;
  const months = value.ageMonths ?? 0;
  return months <= 1 ? 'over a month old' : `${String(months)} months old`;
}

export function FreshnessBadge({ value }: { value: PositionValueDto }) {
  switch (value.state) {
    case 'exact':
      return (
        <Badge tone="positive" title={`Valued on ${value.valuedOn ?? ''}`}>
          {value.fromMonthEnd ? 'Statement balance' : 'Up to date'}
        </Badge>
      );
    case 'carried':
      return (
        <Badge tone="warning" title={`Last valued on ${value.valuedOn ?? ''}`}>
          Carried · {ageText(value) || 'since earlier'}
        </Badge>
      );
    case 'opened_zero':
      return (
        <Badge tone="neutral" title="Opened empty; nothing recorded since.">
          Opened empty
        </Badge>
      );
    case 'closed':
      return (
        <Badge tone="neutral" title={`Closed on ${value.valuedOn ?? ''}`}>
          Closed
        </Badge>
      );
    case 'not_yet_tracked':
      return <Badge tone="neutral">Not tracked yet</Badge>;
    case 'missing':
      return (
        <Badge tone="unavailable" title={value.unavailableDetail ?? 'No value recorded'}>
          No value recorded
        </Badge>
      );
  }
}

/**
 * The state of a cash account's last completed month (8.1).
 *
 * "No statement balance for August" is a different, and more actionable, fact
 * than "the balance is old": it is what stops Phase 3 from inferring that
 * month's spending, and Phase 2 is where the user is first told about it.
 *
 * Two facts, side by side rather than one hiding the other. A pre-existing
 * account whose first statement balance lands in this month is **both** closed
 * for the month and excluded from it (8.1) — a person needs to know the
 * statement is in, and needs to know the month before it is unknown. Showing
 * only one of the two loses whichever it drops.
 */
export function MonthEndBadge({
  month,
  hasStatement,
  firstBalance,
}: {
  month: string;
  hasStatement: boolean;
  firstBalance: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {hasStatement ? (
        <Badge tone="positive">{month} closed</Badge>
      ) : (
        <Badge tone="warning">No month-end balance for {month}</Badge>
      )}
      {firstBalance ? (
        <Badge
          tone="info"
          title="This account existed before you started tracking it, so what moved through it earlier is not known — and that month is not read as a month of activity."
        >
          First balance
        </Badge>
      ) : null}
    </span>
  );
}
