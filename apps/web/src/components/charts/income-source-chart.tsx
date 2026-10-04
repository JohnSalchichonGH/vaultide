import { Fragment } from 'react';

/**
 * One income source's amount history (blueprint 15.2 "Income source", 16.2,
 * 16.6; v2.1.20 30.23 item 7; ADR 0012 D4, D6).
 *
 * Hand-written, like the Income, Spending and net-worth charts: no dependency,
 * and the richer chart layer 16.3 describes stays with Phase 8. It draws what
 * the model decided and nothing else. Dates and amounts become numbers here for
 * a position and nowhere else (7.1.1 / R31); a person reads the figures from the
 * table beside it, which is this chart's exact-data alternative.
 *
 * What it draws:
 *
 *  - the amount the source was set to as a **step line**: flat while a term
 *    holds, rising or falling where the next one starts;
 *  - each payment as a **point** at its occurrence's scheduled date, so one that
 *    differed from its term sits off the line;
 *  - gross, when the model asks for it, dashed and hollow, and only where it
 *    was recorded.
 *
 * The line is stretched to the card's width — `preserveAspectRatio="none"` —
 * so its stroke opts out of scaling, and the points are drawn over it in the
 * page's own coordinates, where a dot stays round (as the net-worth chart does).
 */

export interface SourceStep {
  /** The term's effective date. */
  readonly from: string;
  /** The next term's effective date, or the end of the axis. */
  readonly to: string;
  readonly net: string;
  /** `null` where no gross was recorded, or gross is not drawn. */
  readonly gross: string | null;
}

export interface SourcePoint {
  /** The occurrence's scheduled date. */
  readonly date: string;
  readonly net: string;
  /** `null` where no gross was recorded, or gross is not drawn. */
  readonly gross: string | null;
  /** What a pointer over the point is told. */
  readonly title: string;
}

export interface IncomeSourceChartProps {
  /** The axis, `YYYY-MM-DD` to `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly steps: readonly SourceStep[];
  readonly points: readonly SourcePoint[];
  /** Whether gross is drawn at all. */
  readonly gross: boolean;
  readonly summary: string;
}

const WIDTH = 720;
const HEIGHT = 180;
const PADDING = { top: 12, right: 8, bottom: 12, left: 8 };

/** Days since the epoch: a position on the axis, never a figure. */
function dayNumber(date: string): number {
  return (
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000
  );
}

/** A step line through the steps, broken wherever one has no value. */
function stepPath(
  steps: readonly SourceStep[],
  value: (step: SourceStep) => string | null,
  x: (date: string) => number,
  y: (amount: string) => number,
): string {
  let path = '';
  let open = false;
  for (const step of steps) {
    const amount = value(step);
    if (amount === null) {
      open = false;
      continue;
    }
    const left = x(step.from).toFixed(1);
    const right = x(step.to).toFixed(1);
    const level = y(amount).toFixed(1);
    // Joined to the previous step by a riser; a fresh start after a gap.
    path += open ? ` V${level} H${right}` : `${path === '' ? '' : ' '}M${left} ${level} H${right}`;
    open = true;
  }
  return path;
}

export function IncomeSourceChart({ from, to, steps, points, gross, summary }: IncomeSourceChartProps) {
  const amounts: number[] = [];
  for (const step of steps) {
    amounts.push(Number(step.net));
    if (step.gross !== null) amounts.push(Number(step.gross));
  }
  for (const point of points) {
    amounts.push(Number(point.net));
    if (point.gross !== null) amounts.push(Number(point.gross));
  }
  const max = Math.max(0, ...amounts) || 1;
  const start = dayNumber(from);
  const span = dayNumber(to) - start || 1;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (date: string): number => PADDING.left + ((dayNumber(date) - start) / span) * innerWidth;
  const y = (amount: string): number => PADDING.top + innerHeight - (Number(amount) / max) * innerHeight;
  const at = (date: string, amount: string) => ({
    left: `${String((x(date) / WIDTH) * 100)}%`,
    top: `${String((y(amount) / HEIGHT) * 100)}%`,
  });

  const net = stepPath(steps, (step) => step.net, x, y);
  const grossPath = gross ? stepPath(steps, (step) => step.gross, x, y) : '';

  return (
    <figure className="space-y-2" data-testid="income-source-chart">
      <div className="relative h-44 w-full">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          className="h-full w-full"
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
            vectorEffect="non-scaling-stroke"
          />
          {net === '' ? null : (
            <path
              d={net}
              fill="none"
              stroke="var(--color-chart-1)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              data-testid="income-source-chart-net"
            />
          )}
          {grossPath === '' ? null : (
            <path
              d={grossPath}
              fill="none"
              stroke="var(--color-chart-2)"
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
              data-testid="income-source-chart-gross"
            />
          )}
        </svg>
        {points.map((point) => (
          <Fragment key={point.date}>
            <span
              aria-hidden="true"
              title={point.title}
              data-testid="income-source-chart-point"
              className="absolute block size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-background)] bg-[var(--color-foreground)]"
              style={at(point.date, point.net)}
            />
            {point.gross === null ? null : (
              <span
                aria-hidden="true"
                title={point.title}
                data-testid="income-source-chart-gross-point"
                className="absolute block size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-chart-2)] bg-[var(--color-background)]"
                style={at(point.date, point.gross)}
              />
            )}
          </Fragment>
        ))}
      </div>
      <figcaption
        className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
        data-testid="income-source-chart-legend"
      >
        <span>
          <span aria-hidden="true" className="mr-1 inline-block w-3 border-t-2 border-[var(--color-chart-1)] align-middle" />
          Amount set (net)
        </span>
        <span>
          <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full bg-[var(--color-foreground)]" />
          Received (net)
        </span>
        {gross ? (
          <>
            <span>
              <span aria-hidden="true" className="mr-1 inline-block w-3 border-t-2 border-dashed border-[var(--color-chart-2)] align-middle" />
              Gross set
            </span>
            <span>
              <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full border-2 border-[var(--color-chart-2)]" />
              Gross received
            </span>
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}
