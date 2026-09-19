/**
 * The Spending history chart (blueprint 15.2 "Spending", 16.2, 16.3, 16.6; ADR
 * 0008 §8, §9).
 *
 * Hand-written, like the net-worth chart: no dependency, and the richer chart
 * layer 16.3 describes stays with Phase 8. It draws what the read decided and
 * nothing else — every amount arrives as an exact decimal string, becomes a
 * number here for a height and nowhere else (7.1.1 / R31), and is read by a
 * person from the table beneath, which is this chart's exact-data alternative.
 *
 * What each month is drawn as:
 *
 *  - a **stack** of known (solid) and unclassified (tint) tracked spending,
 *    when tracked spending is fully stated; hatched when the month is
 *    estimated, outlined and hatched when it is provisional;
 *  - a dashed **lower-bound** line at the known amount, and no bar, when the
 *    records contradict the balances — a bar would present a bound as a total;
 *  - a separate narrow bar for **additional** spending, never stacked on top;
 *  - a hollow grey **memo** marker for paid-by-others, outside every bar;
 *  - a **gap** otherwise, with a caption that tells missing evidence from a
 *    month nobody tracked.
 *
 * A combined period is a **bracket** under the months it covers, labelled in its
 * own currency. It has no height: its amount is not on this chart's scale, and
 * drawing it as one would divide it into months.
 */

export type SpendingChartMark =
  | { readonly kind: 'stack'; readonly known: string; readonly unclassified: string; readonly tracked: string; readonly style: 'solid' | 'estimated' | 'provisional' }
  | { readonly kind: 'lower_bound'; readonly atLeast: string }
  | { readonly kind: 'gap' };

export interface SpendingChartColumn {
  readonly key: string;
  /** Short month name under the column. */
  readonly label: string;
  /** A word under the label when the month is not simply drawn, e.g. "Missing". */
  readonly caption: string | null;
  readonly mark: SpendingChartMark;
  readonly additional: string | null;
  readonly memo: string | null;
  readonly focus: boolean;
}

export interface SpendingChartBracket {
  readonly key: string;
  /** Index of the first covered column. */
  readonly start: number;
  /** How many columns it covers. */
  readonly span: number;
  readonly label: string;
}

const HEIGHT = 160;

const HATCH = 'repeating-linear-gradient(135deg, transparent 0 4px, var(--color-surface) 4px 6px)';

export function SpendingChart({
  columns,
  brackets,
  summary,
}: {
  readonly columns: readonly SpendingChartColumn[];
  readonly brackets: readonly SpendingChartBracket[];
  readonly summary: string;
}) {
  const values: number[] = [];
  for (const column of columns) {
    if (column.mark.kind === 'stack') values.push(Number(column.mark.tracked));
    if (column.mark.kind === 'lower_bound') values.push(Number(column.mark.atLeast));
    if (column.additional !== null) values.push(Number(column.additional));
    if (column.memo !== null) values.push(Number(column.memo));
  }
  const max = Math.max(0, ...values);
  const px = (amount: string): number => (max > 0 ? Math.max(0, (Number(amount) / max) * HEIGHT) : 0);
  const grid = { gridTemplateColumns: `repeat(${String(columns.length)}, minmax(2.75rem, 1fr))` };

  return (
    <figure className="space-y-2" data-testid="spending-chart">
      <div className="relative overflow-x-auto" data-testid="spending-chart-scroll">
        <div role="img" aria-label={summary} className="w-max min-w-full">
          <div className="grid items-end gap-x-1 border-b" style={{ ...grid, height: `${String(HEIGHT + 8)}px` }} aria-hidden="true">
            {columns.map((column) => (
              <div
                key={column.key}
                className={`relative flex h-full items-end justify-center gap-0.5 px-0.5 ${column.focus ? 'bg-[var(--color-surface-muted)]' : ''}`}
                data-testid="spending-chart-column"
                data-month={column.key}
                data-mark={column.mark.kind}
              >
                {column.mark.kind === 'stack' ? (
                  <div
                    className={`relative flex w-3/5 flex-col-reverse ${column.mark.style === 'provisional' ? 'rounded-t-sm outline-dashed outline-1 outline-[var(--color-accent)]' : ''}`}
                    data-style={column.mark.style}
                  >
                    <div className="bg-[var(--color-accent)]" style={{ height: `${px(column.mark.known).toFixed(1)}px` }} data-part="known" />
                    <div
                      className="rounded-t-sm bg-[color-mix(in_oklab,var(--color-accent)_40%,transparent)]"
                      style={{ height: `${px(column.mark.unclassified).toFixed(1)}px` }}
                      data-part="unclassified"
                    />
                    {column.mark.style === 'solid' ? null : (
                      <div className="absolute inset-0" style={{ backgroundImage: HATCH }} data-part="hatch" />
                    )}
                  </div>
                ) : null}
                {column.mark.kind === 'lower_bound' ? (
                  <div
                    className="absolute inset-x-1 border-t-2 border-dashed border-[var(--color-negative)]"
                    style={{ bottom: `${px(column.mark.atLeast).toFixed(1)}px` }}
                    data-part="lower-bound"
                  />
                ) : null}
                {column.mark.kind === 'gap' ? (
                  <div className="h-2 w-3/5 border-t border-dashed border-[var(--color-unavailable)]" data-part="gap" />
                ) : null}
                {column.additional === null ? null : (
                  <div
                    className="w-1/5 rounded-t-sm bg-[var(--color-info)]"
                    style={{ height: `${px(column.additional).toFixed(1)}px` }}
                    data-part="additional"
                  />
                )}
                {column.memo === null ? null : (
                  <div
                    className="absolute right-0.5 size-2 -translate-y-1/2 rounded-full border-2 border-[var(--color-unavailable)] bg-[var(--color-surface)]"
                    style={{ bottom: `${px(column.memo).toFixed(1)}px` }}
                    data-part="memo"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="grid gap-x-1 pt-1 text-center text-[length:var(--text-meta)]" style={grid} aria-hidden="true">
            {columns.map((column) => (
              <div key={column.key} className="min-w-0">
                <span className={column.focus ? 'font-semibold' : 'text-[var(--color-muted-foreground)]'}>{column.label}</span>
                {column.caption === null ? null : (
                  <span className="block truncate text-[var(--color-muted-foreground)]" data-testid="spending-chart-caption">
                    {column.caption}
                  </span>
                )}
              </div>
            ))}
          </div>
          {brackets.length === 0 ? null : (
            <div className="grid gap-x-1 pt-2" style={grid} aria-hidden="true">
              {brackets.map((bracket) => (
                <div
                  key={bracket.key}
                  className="rounded-b-sm border-x border-b border-[var(--color-border-strong)] px-1 pb-1 text-center text-[length:var(--text-meta)]"
                  style={{ gridColumn: `${String(bracket.start + 1)} / span ${String(bracket.span)}` }}
                  data-testid="spending-chart-bracket"
                >
                  {bracket.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]" data-testid="spending-chart-legend">
        <span><span aria-hidden="true" className="mr-1 inline-block size-2 bg-[var(--color-accent)]" />Known</span>
        <span><span aria-hidden="true" className="mr-1 inline-block size-2 bg-[color-mix(in_oklab,var(--color-accent)_40%,transparent)]" />Unclassified</span>
        <span><span aria-hidden="true" className="mr-1 inline-block size-2" style={{ backgroundImage: HATCH, backgroundColor: 'var(--color-accent)' }} />Estimated or provisional (hatched)</span>
        <span><span aria-hidden="true" className="mr-1 inline-block size-2 bg-[var(--color-info)]" />Additional (separate)</span>
        <span><span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full border-2 border-[var(--color-unavailable)]" />Paid by others (memo, not in any total)</span>
        <span><span aria-hidden="true" className="mr-1 inline-block w-3 border-t-2 border-dashed border-[var(--color-negative)] align-middle" />At least (records contradict balances)</span>
      </figcaption>
    </figure>
  );
}
