import type { IncomeSourcePageDto } from '@vaultide/application';
import type { IncomeSourceChartProps, SourcePoint, SourceStep } from '@/components/charts/income-source-chart';
import { formatMoney } from '@/lib/format';
import { dayTitle } from '@/features/monthly/presentation';
import { historyGross } from '@/features/income/source-presentation';

/**
 * What a source's amount-history chart draws (blueprint 15.2 "Income source",
 * v2.1.20 30.23 item 7; ADR 0012 D4, D6). Pure, and without arithmetic on an
 * amount: which steps and points there are, between which dates, and what each
 * says — the chart only scales them.
 *
 * The term history is a **step line**: each amount holds from its effective
 * date until the next one starts. What arrived is a **point** at its
 * occurrence's scheduled date, the date its term is keyed to (§30.9 item 4),
 * so a payment that differed from its term sits off the line. Gross is drawn
 * only when some term or payment records one (ADR 0012 D3), and only where it
 * was recorded.
 */

const earliest = (dates: readonly string[]): string => dates.reduce((a, b) => (b < a ? b : a));
const latest = (dates: readonly string[]): string => dates.reduce((a, b) => (b > a ? b : a));

export function sourceChartModel(
  page: Pick<IncomeSourcePageDto, 'source' | 'terms' | 'arrivals' | 'today' | 'minorUnitsByCurrency'>,
  locale: string,
): IncomeSourceChartProps {
  const { source, terms, arrivals } = page;
  const money = (amount: string): string =>
    formatMoney({
      amount,
      currency: source.currency,
      locale,
      minorUnits: page.minorUnitsByCurrency[source.currency] ?? 2,
    });
  const day = (date: string): string => dayTitle(date, locale);

  // From the start to today — or to the end date, for a source that ended —
  // stretched to reach any amount set ahead and any payment recorded early.
  const until = source.endDate !== null && source.endDate < page.today ? source.endDate : page.today;
  const from = earliest([source.startDate, ...terms.map((row) => row.effectiveFrom), ...arrivals.map((row) => row.payment.occurrenceDate)]);
  const to = latest([from, until, ...terms.map((row) => row.effectiveFrom), ...arrivals.map((row) => row.payment.occurrenceDate)]);
  const { show: gross } = historyGross(page);

  const steps = terms.map((term, index): SourceStep => ({
    from: term.effectiveFrom,
    to: terms[index + 1]?.effectiveFrom ?? to,
    net: term.net.amount,
    gross: gross && term.gross !== null ? term.gross.amount : null,
  }));

  const points = arrivals.map(({ payment, term }): SourcePoint => {
    const set = term.net === null ? 'no amount was set for it' : `set at ${money(term.net.amount)}`;
    const arrived = payment.receivedOn === payment.occurrenceDate ? '' : `, arrived ${day(payment.receivedOn)}`;
    const recordedGross = payment.gross === null ? '' : ` (gross ${money(payment.gross.amount)})`;
    return {
      date: payment.occurrenceDate,
      net: payment.net.amount,
      gross: gross && payment.gross !== null ? payment.gross.amount : null,
      title: `${day(payment.occurrenceDate)}: received ${money(payment.net.amount)}${recordedGross}${arrived}; ${set}`,
    };
  });

  const amounts = `${String(terms.length)} ${terms.length === 1 ? 'amount' : 'amounts'}`;
  const payments = `${String(arrivals.length)} ${arrivals.length === 1 ? 'payment' : 'payments'} received`;
  const summary = `${source.name}’s amount in ${source.currency} from ${day(from)} to ${day(to)}: ${amounts} set, as a step line, and ${payments}, as points. The table has the exact figures.`;

  return { from, to, steps, points, gross, summary };
}
