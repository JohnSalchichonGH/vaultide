import type { SpendingHistoryRowDto, SpendingSpanDto } from '@vaultide/application';
import type {
  SpendingChartBracket,
  SpendingChartColumn,
  SpendingChartMark,
} from '@/components/charts/spending-chart';
import { formatMoney } from '@/lib/format';
import { monthTitle } from '@/features/monthly/presentation';
import { monthStateOf, type SpendingMonthState } from '@/features/spending/presentation';

/**
 * What the Spending chart draws for each month, decided from the read (ADR 0008
 * §9). Pure and without arithmetic: which mark a month gets, which strings its
 * parts are, and how a combined period is labelled — the chart only scales them.
 *
 * A stack needs all three of tracked, known and unclassified **stated in full**;
 * anything less is not a total, and drawing its parts as one would present a
 * bound as a figure. An unresolved month is drawn only as the known amount it is
 * at least; every other month without a full figure is a gap with a caption.
 */

const CAPTION: Readonly<Record<SpendingMonthState, string | null>> = {
  reliable: null,
  estimated: 'Estimated',
  provisional: 'So far',
  unresolved: 'At least',
  unavailable: 'Missing',
  not_observed: 'Not tracked',
  no_common_date: 'No date',
};

const shortMonth = (month: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

/**
 * The word under a month. A month whose status would draw but whose figure is
 * not complete — a rate is missing — is a gap that says "Partial", never a
 * silent one.
 */
function captionOf(mark: SpendingChartMark, state: SpendingMonthState): string | null {
  if (mark.kind === 'stack') return state === 'reliable' ? null : CAPTION[state];
  if (state === 'reliable' || state === 'estimated' || state === 'provisional') return 'Partial';
  return CAPTION[state];
}

function markOf(row: SpendingHistoryRowDto, state: SpendingMonthState): SpendingChartMark {
  const { tracked, known, unclassified } = row;
  if (
    (state === 'reliable' || state === 'estimated' || state === 'provisional') &&
    tracked?.availability === 'available' &&
    known?.availability === 'available' &&
    unclassified?.availability === 'available'
  ) {
    return {
      kind: 'stack',
      tracked: tracked.value.amount,
      known: known.value.amount,
      unclassified: unclassified.value.amount,
      style: state === 'reliable' ? 'solid' : state,
    };
  }
  if (state === 'unresolved' && known?.availability === 'available') {
    return { kind: 'lower_bound', atLeast: known.value.amount };
  }
  return { kind: 'gap' };
}

export interface SpendingChartModel {
  readonly columns: readonly SpendingChartColumn[];
  readonly brackets: readonly SpendingChartBracket[];
  readonly summary: string;
}

export function spendingChartModel(args: {
  readonly history: readonly SpendingHistoryRowDto[];
  readonly spans: readonly SpendingSpanDto[];
  readonly focusMonth: string;
  readonly reportingCurrency: string;
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}): SpendingChartModel {
  const { history, locale } = args;

  const columns: SpendingChartColumn[] = history.map((row) => {
    const state = monthStateOf(row);
    const mark = markOf(row, state);
    return {
      key: row.month,
      label: shortMonth(row.month, locale),
      caption: captionOf(mark, state),
      mark,
      additional: row.additional.availability === 'available' ? row.additional.value.amount : null,
      memo:
        row.thirdPartyPaid.availability === 'available' && !/^0(\.0+)?$/u.test(row.thirdPartyPaid.value.amount)
          ? row.thirdPartyPaid.value.amount
          : null,
      focus: row.month === args.focusMonth,
    };
  });

  const index = new Map(history.map((row, position) => [row.month, position]));
  const brackets: SpendingChartBracket[] = [];
  for (const span of args.spans) {
    const covered = span.months
      .map((month) => index.get(month))
      .filter((position): position is number => position !== undefined);
    const [first] = covered;
    if (first === undefined) continue;
    const tracked =
      span.status === 'reliable'
        ? formatMoney({
            amount: span.trackedTotalSpending.amount,
            currency: span.currency,
            locale,
            minorUnits: args.minorUnitsByCurrency[span.currency] ?? 2,
          })
        : null;
    brackets.push({
      key: span.key,
      start: first,
      span: covered.length,
      label:
        tracked === null
          ? `Combined ${span.currency} period · unresolved`
          : `Combined ${span.currency} period: ${tracked} tracked`,
    });
  }

  const drawn = columns.filter((column) => column.mark.kind === 'stack').length;
  const bounded = columns.filter((column) => column.mark.kind === 'lower_bound').length;
  const first = history[0];
  const last = history.at(-1);
  const summary = [
    `Tracked spending by month in ${args.reportingCurrency}`,
    first === undefined || last === undefined
      ? ''
      : ` from ${monthTitle(first.month, locale)} to ${monthTitle(last.month, locale)}`,
    `: ${String(drawn)} of ${String(columns.length)} months have a full figure`,
    bounded === 0 ? '' : `, ${String(bounded)} only a lower bound`,
    brackets.length === 0 ? '' : `, and ${String(brackets.length)} combined ${brackets.length === 1 ? 'period covers' : 'periods cover'} months without their own figure`,
    '. Additional spending is drawn separately and paid-by-others as a memo outside every total. The table below lists every figure.',
  ].join('');

  return { columns, brackets, summary };
}
