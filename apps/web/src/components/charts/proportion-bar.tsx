/**
 * A horizontal bar whose length is one amount's share of the largest in a set
 * (blueprint 16.3: "allocation as horizontal … bars"; 7.1.1 / R31).
 *
 * Geometry only. The amounts arrive as exact decimal strings, pass through a
 * number here for a width and nowhere else, and the figure a person reads beside
 * the bar is formatted from the exact string by its caller. Decorative: the
 * amount is always printed next to it, so the bar is hidden from assistive tech.
 */
export function ProportionBar({
  amount,
  among,
  testId,
}: {
  readonly amount: string;
  /** Every amount the bars are compared across, the largest setting full width. */
  readonly among: readonly string[];
  readonly testId?: string;
}) {
  const largest = Math.max(0, ...among.map((value) => Number(value)));
  const share = largest > 0 ? Math.max(0, Math.min(1, Number(amount) / largest)) : 0;
  return (
    <div className="h-2 w-full rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true" data-testid={testId}>
      <div
        className="h-2 rounded-full bg-[var(--color-accent)]"
        style={{ width: `${(share * 100).toFixed(2)}%` }}
      />
    </div>
  );
}
