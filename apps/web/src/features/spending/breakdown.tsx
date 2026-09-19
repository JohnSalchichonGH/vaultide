import type {
  SpendingCategoriesDto,
  SpendingCategoryRowDto,
  SpendingLargestKnownDto,
} from '@vaultide/application';
import { ProportionBar } from '@/components/charts/proportion-bar';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { dayTitle, missingSummary } from '@/features/monthly/presentation';
import { Amount, META, type Formatting } from '@/features/spending/figure';
import {
  CATEGORY_GROUP_LABEL,
  CATEGORY_GROUP_ORDER,
  LARGEST_KIND_LABEL,
  rankingNote,
  spendingFigureDisplay,
} from '@/features/spending/presentation';

/**
 * Where the focus month's known spending went (blueprint 15.2 "categories;
 * largest known"; ADR 0008 §6, §7).
 *
 * Every row is one the reporting figures already counted, and every total is the
 * read's. The bars are layout only, drawn by `ProportionBar` from the exact
 * totals, and only when every total is complete.
 */

function CategoryRow({
  row,
  among,
  formatting,
}: {
  readonly row: SpendingCategoryRowDto;
  /** Every category total, when all are complete; `null` draws no bars. */
  readonly among: readonly string[] | null;
  readonly formatting: Formatting;
}) {
  return (
    <li className="space-y-1" data-testid="spending-category" data-category={row.name}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {row.name}
          {row.archived ? <span className={META}> (archived)</span> : null}
        </span>
        <span className="tabular" data-testid="spending-category-total">
          <Amount display={spendingFigureDisplay(row.total)} formatting={formatting} />
        </span>
      </div>
      {among === null ? null : (
        <ProportionBar amount={row.total.value.amount} among={among} testId="spending-category-bar" />
      )}
      <dl className={`flex flex-wrap gap-x-4 ${META}`}>
        {row.trackedKnown === null ? null : (
          <div className="flex gap-1" data-testid="spending-category-tracked">
            <dt>Tracked known</dt>
            <dd className="tabular">
              <Amount display={spendingFigureDisplay(row.trackedKnown)} formatting={formatting} />
            </dd>
          </div>
        )}
        {row.additional === null ? null : (
          <div className="flex gap-1" data-testid="spending-category-additional">
            <dt>Additional</dt>
            <dd className="tabular">
              <Amount display={spendingFigureDisplay(row.additional)} formatting={formatting} />
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

export function Categories({
  categories,
  formatting,
}: {
  readonly categories: SpendingCategoriesDto;
  readonly formatting: Formatting;
}) {
  const complete = categories.order === 'amount';
  // Bars compare complete totals only: an incomplete one is not an amount to
  // draw against the others (ADR 0008 §7).
  const among = complete ? categories.rows.map((row) => row.total.value.amount) : null;

  return (
    <div className="space-y-4" data-testid="spending-categories" data-order={categories.order}>
      {categories.trackedInterval === null ? (
        <p className={META} data-testid="spending-categories-no-tracked">
          Tracked spending cannot be calculated for this period, so no tracked known spending is
          broken down here.
        </p>
      ) : null}
      {complete ? null : (
        <p className="text-[length:var(--text-meta)] text-[var(--color-warning)]" data-testid="spending-categories-fx-note">
          A rate to your reporting currency is missing ({missingSummary(categories.missing)}), so
          categories are listed in your own order rather than by amount.
        </p>
      )}
      {categories.rows.length === 0 ? (
        <p className={META} data-testid="spending-categories-empty">
          No known expense was recorded in this period.
        </p>
      ) : (
        CATEGORY_GROUP_ORDER.map((group) => {
          const rows = categories.rows.filter((row) => row.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} className="space-y-2" aria-label={CATEGORY_GROUP_LABEL[group]} data-testid={`spending-group-${group}`}>
              <h3 className="text-[length:var(--text-table)] font-semibold">{CATEGORY_GROUP_LABEL[group]}</h3>
              <ul className="space-y-3">
                {rows.map((row) => (
                  <CategoryRow key={row.categoryId} row={row} among={among} formatting={formatting} />
                ))}
              </ul>
            </section>
          );
        })
      )}
      {categories.unclassified === null ? null : (
        <div className="border-t pt-3" data-testid="spending-categories-unclassified">
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">Unclassified</span>
            <span className="tabular">
              <Amount display={spendingFigureDisplay(categories.unclassified)} formatting={formatting} />
            </span>
          </p>
          <p className={META}>
            Inferred from your balances, not a category: spending nobody recorded. Record a known
            expense to move some of it into a category.
          </p>
        </div>
      )}
    </div>
  );
}

export function LargestKnown({
  largest,
  formatting,
}: {
  readonly largest: SpendingLargestKnownDto;
  readonly formatting: Formatting;
}) {
  const note = rankingNote(largest.mode, largest.perNativeCurrency);
  if (largest.mode === 'none') {
    return (
      <p className={META} data-testid="spending-largest-empty">
        No known expense or additional spending was recorded in this period.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="spending-largest" data-mode={largest.mode}>
      {note === null ? null : (
        <p className="text-[length:var(--text-meta)] text-[var(--color-warning)]" data-testid="spending-largest-note">
          {note}
        </p>
      )}
      {largest.groups.map((group) => (
        <div key={group.currency ?? 'reporting'} className="space-y-1">
          {group.currency === null ? null : (
            <h3 className="text-[length:var(--text-table)] font-semibold">In {group.currency}</h3>
          )}
          <ol className="divide-y" data-testid="spending-largest-list">
            {group.rows.map((row) => (
              <li key={row.entryId} className="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid="spending-largest-row">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{row.description ?? row.categoryName}</p>
                  <p className={META}>
                    {row.description === null ? null : `${row.categoryName} · `}
                    {dayTitle(row.incurredOn, formatting.locale)}
                    {row.cashAccountName === null ? null : ` · ${row.cashAccountName}`}
                  </p>
                  <Badge tone={row.kind === 'money_out' || row.kind === 'cost' ? 'info' : 'neutral'} data-testid="spending-largest-kind">
                    {LARGEST_KIND_LABEL[row.kind]}
                  </Badge>
                </div>
                <div className="text-right">
                  <MoneyText
                    amount={row.native.amount}
                    currency={row.native.currency}
                    locale={formatting.locale}
                    minorUnits={formatting.minorUnitsByCurrency[row.native.currency] ?? 2}
                    className="tabular font-medium"
                  />
                  {row.reporting.value.currency === row.native.currency ? null : (
                    <p className={`tabular ${META}`}>
                      <Amount display={spendingFigureDisplay(row.reporting)} formatting={formatting} />
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
