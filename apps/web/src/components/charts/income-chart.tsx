import { ScrollRegion } from '@/components/ui/scroll-region';

/**
 * The Income year chart (blueprint 15.2 "Income", 16.2, 16.6; ADR 0012 D6).
 *
 * Hand-written, like the Spending and net-worth charts: no dependency, and the
 * richer chart layer 16.3 describes stays with Phase 8. It draws what the read
 * decided and nothing else — every amount arrives as an exact decimal string,
 * becomes a number here for a height and nowhere else (7.1.1 / R31), and is
 * read by a person from the table beside it, which is this chart's exact-data
 * alternative.
 *
 * What each month is drawn as:
 *
 *  - a **stack** of salary, bonus and other, bottom to top, each in its own
 *    categorical slot with a 2px gap between them; outlined and dashed while
 *    the month is still running;
 *  - a dashed **lower-bound** line, and no bar, when a rate is missing — a bar
 *    would present a bound as a total;
 *  - a **gap** when nothing above zero could be stated.
 *
 * Each column carries its figures as a tooltip; the table is the accessible
 * and exact way to read them.
 */

export type IncomeChartMark =
  | {
      readonly kind: 'stack';
      readonly salary: string;
      readonly bonus: string;
      readonly other: string;
      readonly total: string;
    }
  | { readonly kind: 'lower_bound'; readonly atLeast: string }
  | { readonly kind: 'gap' };

export interface IncomeChartColumn {
  /** `YYYY-MM`. */
  readonly key: string;
  /** Short month name under the column. */
  readonly label: string;
  /** A word under the label when the month is not simply drawn, e.g. "So far". */
  readonly caption: string | null;
  readonly mark: IncomeChartMark;
  readonly current: boolean;
  /** What a pointer over the column is told. */
  readonly title: string;
}

const HEIGHT = 160;

/** Salary, bonus and other, bottom to top, in the fixed categorical order. */
const SEGMENTS = [
  { part: 'salary', color: 'var(--color-chart-1)', label: 'Salary' },
  { part: 'bonus', color: 'var(--color-chart-2)', label: 'Bonus' },
  { part: 'other', color: 'var(--color-chart-3)', label: 'Other' },
] as const;

export function IncomeChart({
  columns,
  summary,
}: {
  readonly columns: readonly IncomeChartColumn[];
  readonly summary: string;
}) {
  const values: number[] = [];
  for (const column of columns) {
    if (column.mark.kind === 'stack') values.push(Number(column.mark.total));
    if (column.mark.kind === 'lower_bound') values.push(Number(column.mark.atLeast));
  }
  const max = Math.max(0, ...values);
  const px = (amount: string): number => (max > 0 ? Math.max(0, (Number(amount) / max) * HEIGHT) : 0);
  const grid = { gridTemplateColumns: `repeat(${String(Math.max(columns.length, 1))}, minmax(2.25rem, 1fr))` };

  return (
    <figure className="space-y-2" data-testid="income-chart">
      <ScrollRegion label="Chart of income by month" className="relative overflow-x-auto" data-testid="income-chart-scroll">
        <div role="img" aria-label={summary} className="w-max min-w-full">
          <div className="grid items-end gap-x-1 border-b" style={{ ...grid, height: `${String(HEIGHT + 8)}px` }} aria-hidden="true">
            {columns.map((column) => (
              <div
                key={column.key}
                title={column.title}
                className="relative flex h-full items-end justify-center px-0.5"
                data-testid="income-chart-column"
                data-month={column.key}
                data-mark={column.mark.kind}
              >
                {column.mark.kind === 'stack' ? (
                  <div
                    className={`flex w-3/5 max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] ${column.current ? 'outline-dashed outline-1 outline-offset-1 outline-[var(--color-border-strong)]' : ''}`}
                    data-current={column.current ? 'true' : undefined}
                  >
                    {SEGMENTS.map(({ part, color }) => {
                      const height = px(column.mark.kind === 'stack' ? column.mark[part] : '0');
                      return height <= 0 ? null : (
                        <div key={part} style={{ height: `${height.toFixed(1)}px`, backgroundColor: color }} data-part={part} />
                      );
                    })}
                  </div>
                ) : null}
                {column.mark.kind === 'lower_bound' ? (
                  <div
                    className="absolute inset-x-1 border-t-2 border-dashed border-[var(--color-foreground)]"
                    style={{ bottom: `${px(column.mark.atLeast).toFixed(1)}px` }}
                    data-part="lower-bound"
                  />
                ) : null}
                {column.mark.kind === 'gap' ? (
                  <div className="h-2 w-3/5 border-t border-dashed border-[var(--color-unavailable)]" data-part="gap" />
                ) : null}
              </div>
            ))}
          </div>
          <div className="grid gap-x-1 pt-1 text-center text-[length:var(--text-meta)]" style={grid} aria-hidden="true">
            {columns.map((column) => (
              <div key={column.key} className="min-w-0">
                <span className={column.current ? 'font-semibold' : 'text-[var(--color-muted-foreground)]'}>{column.label}</span>
                {column.caption === null ? null : (
                  <span className="block truncate text-[var(--color-muted-foreground)]" data-testid="income-chart-caption">
                    {column.caption}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </ScrollRegion>
      <figcaption
        className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]"
        data-testid="income-chart-legend"
      >
        {SEGMENTS.map(({ part, color, label }) => (
          <span key={part}>
            <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-[2px]" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
        <span>
          <span aria-hidden="true" className="mr-1 inline-block size-2 outline-dashed outline-1 outline-[var(--color-border-strong)]" />
          So far (this month)
        </span>
        <span>
          <span aria-hidden="true" className="mr-1 inline-block w-3 border-t-2 border-dashed border-[var(--color-foreground)] align-middle" />
          At least (a rate is missing)
        </span>
      </figcaption>
    </figure>
  );
}
