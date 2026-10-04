import type { IncomeMonthDto } from '@vaultide/application';
import type { IncomeChartColumn, IncomeChartMark } from '@/components/charts/income-chart';
import { formatMoney } from '@/lib/format';
import { monthTitle } from '@/features/monthly/presentation';
import { GROUP_LABEL } from '@/features/income/presentation';

/**
 * What the Income chart draws for each month (ADR 0012 D6). Pure and without
 * arithmetic: which mark a month gets and what its parts are — the chart only
 * scales them.
 *
 * A stack needs the month's total and all three of its parts stated in full.
 * A month missing a rate is not a total, and drawing its parts as one would
 * present a bound as a figure (ADR 0008 §9): it is drawn as the amount it is at
 * least, or as a gap when nothing above zero could be stated.
 */

const shortMonth = (month: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

function markOf(month: IncomeMonthDto): IncomeChartMark {
  const { total, salary, bonus, other } = month;
  if ([total.net, salary, bonus, other].every((amount) => amount.availability === 'available')) {
    return {
      kind: 'stack',
      salary: salary.value.amount,
      bonus: bonus.value.amount,
      other: other.value.amount,
      total: total.net.value.amount,
    };
  }
  return total.net.availability === 'partial' && !/^0(\.0+)?$/u.test(total.net.value.amount)
    ? { kind: 'lower_bound', atLeast: total.net.value.amount }
    : { kind: 'gap' };
}

function captionOf(mark: IncomeChartMark, current: boolean): string | null {
  if (mark.kind === 'lower_bound') return 'At least';
  if (mark.kind === 'gap') return 'No rate';
  return current ? 'So far' : null;
}

export function incomeChartModel(args: {
  readonly months: readonly IncomeMonthDto[];
  readonly year: number;
  readonly reportingCurrency: string;
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}): { readonly columns: IncomeChartColumn[]; readonly summary: string } {
  const minorUnits = args.minorUnitsByCurrency[args.reportingCurrency] ?? 2;
  const money = (amount: string): string =>
    formatMoney({ amount, currency: args.reportingCurrency, locale: args.locale, minorUnits });

  const columns = args.months.map((month): IncomeChartColumn => {
    const mark = markOf(month);
    const name = monthTitle(month.month, args.locale);
    const title =
      mark.kind === 'stack'
        ? `${name}${month.current ? ' (so far)' : ''}: ${money(mark.total)} — ${GROUP_LABEL.salary} ${money(mark.salary)}, ${GROUP_LABEL.bonus} ${money(mark.bonus)}, ${GROUP_LABEL.other} ${money(mark.other)}`
        : mark.kind === 'lower_bound'
          ? `${name}: at least ${money(mark.atLeast)} — a rate is missing`
          : `${name}: not available — a rate is missing`;
    return {
      key: month.month,
      label: shortMonth(month.month, args.locale),
      caption: captionOf(mark, month.current),
      mark,
      current: month.current,
      title,
    };
  });

  const incomplete = columns.filter((column) => column.mark.kind !== 'stack').length;
  const summary =
    `Income recorded each month of ${String(args.year)}, in ${args.reportingCurrency}, as salary, bonus and other.` +
    (incomplete === 0
      ? ''
      : ` ${String(incomplete)} ${incomplete === 1 ? 'month is' : 'months are'} incomplete because a rate is missing.`) +
    ' The table has the exact figures.';
  return { columns, summary };
}
