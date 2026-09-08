import type { NetWorthPointDto } from '@vaultide/application';
import { MoneyText } from '@/components/finance/money-text';

/**
 * The twelve-month net-worth chart (blueprint 15.4, 16.3, 16.6).
 *
 * Phase 2 wants "a 12-month chart"; Phase 8 is where the charting layer
 * (Recharts wrappers with a table fallback under every chart) is actually
 * built. So this is a small, self-contained SVG: no dependency to pin, nothing
 * to migrate, and the accessibility contract 16.3 asks for is met here already
 * — `role="img"` with a summary sentence, plus the table alternative that
 * carries every figure exactly.
 *
 * Two things the picture must not hide (16.2):
 *
 *  - a **partial** month is drawn hollow and listed as partial in the table,
 *    because a point missing an account is not a point on the same line;
 *  - the last point is **provisional** — today, not a month end — and is drawn
 *    hollow with a dashed link, per 15.4.
 *
 * Coordinates are the one place a JavaScript number is allowed (7.1): they are
 * pixels. Every figure a person reads comes from the exact decimal string.
 */

export interface NetWorthChartProps {
  readonly points: readonly NetWorthPointDto[];
  readonly locale: string;
  readonly minorUnits: number;
  readonly metric: 'total' | 'financial';
  readonly label: string;
}

const WIDTH = 720;
const HEIGHT = 180;
const PADDING = { top: 12, right: 8, bottom: 24, left: 8 };

interface Plotted {
  readonly point: NetWorthPointDto;
  readonly x: number;
  readonly y: number | null;
  readonly amount: string | null;
}

function monthLabel(asOf: string): string {
  return asOf.slice(0, 7);
}

export function NetWorthChart({
  points,
  locale,
  minorUnits,
  metric,
  label,
}: NetWorthChartProps) {
  const aggregateOf = (point: NetWorthPointDto) =>
    metric === 'total' ? point.totalNetWorth : point.financialNetWorth;

  const values = points
    .map((point) => aggregateOf(point).value?.amount)
    .filter((amount): amount is string => amount !== undefined);

  if (values.length === 0) {
    return (
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        Nothing to chart yet. Record a balance and this fills in.
      </p>
    );
  }

  // Chart coordinates only — never a displayed figure (7.1, R31).
  const numeric = values.map((amount) => Number(amount));
  const max = Math.max(...numeric, 0);
  const min = Math.min(...numeric, 0);
  const span = max - min || 1;

  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  const plotted: Plotted[] = points.map((point, index) => {
    const amount = aggregateOf(point).value?.amount ?? null;
    return {
      point,
      x: PADDING.left + step * index,
      y:
        amount === null
          ? null
          : PADDING.top + innerHeight - ((Number(amount) - min) / span) * innerHeight,
      amount,
    };
  });

  const drawn = plotted.filter((item): item is Plotted & { y: number } => item.y !== null);
  const path = drawn.map((item, index) => `${index === 0 ? 'M' : 'L'}${String(item.x)} ${String(item.y)}`).join(' ');

  const first = points[0];
  const last = points.at(-1);
  const summary = `${label} from ${first === undefined ? '' : monthLabel(first.asOf)} to ${
    last === undefined ? '' : monthLabel(last.asOf)
  }, ${String(drawn.length)} of ${String(points.length)} months with a value.`;

  return (
    <figure className="space-y-3">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="h-44 w-full"
        role="img"
        aria-label={summary}
        preserveAspectRatio="none"
      >
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={PADDING.top + innerHeight}
          y2={PADDING.top + innerHeight}
          stroke="var(--color-border)"
        />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        {plotted.map((item) =>
          item.y === null ? null : (
            <circle
              key={item.point.asOf}
              cx={item.x}
              cy={item.y}
              r={3}
              // Hollow for provisional and for partial: both mean "this is not
              // a settled month-end figure" (15.4, 16.2).
              fill={
                item.point.provisional ||
                aggregateOf(item.point).availability !== 'available'
                  ? 'var(--color-background)'
                  : 'var(--color-accent)'
              }
              stroke="var(--color-accent)"
              strokeWidth={2}
            />
          ),
        )}
      </svg>

      <figcaption className="sr-only">{summary}</figcaption>

      <details>
        <summary className="cursor-pointer text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-[length:var(--text-table)]">
            <caption className="sr-only">{summary}</caption>
            <thead>
              <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  As of
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  {label}
                </th>
                <th scope="col" className="py-1.5 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => {
                const aggregate = aggregateOf(point);
                return (
                  <tr key={point.asOf} className="border-b last:border-0">
                    <td className="tabular py-1.5 pr-4">{point.asOf}</td>
                    <td className="py-1.5 pr-4 text-right">
                      <MoneyText
                        amount={aggregate.value?.amount ?? null}
                        currency={aggregate.value?.currency}
                        locale={locale}
                        minorUnits={minorUnits}
                        unavailableReason="Nothing here could be valued at this date."
                      />
                    </td>
                    <td className="py-1.5 text-[var(--color-muted-foreground)]">
                      {point.provisional ? 'Provisional (today)' : 'Month end'}
                      {aggregate.availability === 'available'
                        ? ''
                        : ` · ${aggregate.availability}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
