import type { IncomeGrossDto } from '@vaultide/application';
import type { MoneyDto } from '@vaultide/finance/client';
import { MoneyText } from '@/components/finance/money-text';
import { Amount, META, type Formatting } from '@/features/spending/figure';
import { incomeFigureDisplay, withoutGrossNote } from '@/features/income/presentation';

/**
 * Small pieces the Income tables share. Display only: every amount arrives
 * decided.
 */

/**
 * The native amounts behind a reporting figure, where they are in another
 * currency — exact and never converted (30.23 item 6). Nothing when the figure
 * is already in its own currency.
 */
export function NativeNote({
  native,
  reportingCurrency,
  formatting,
}: {
  readonly native: readonly MoneyDto[];
  readonly reportingCurrency: string;
  readonly formatting: Formatting;
}) {
  const foreign = native.filter((item) => item.currency !== reportingCurrency);
  if (foreign.length === 0) return null;
  return (
    <span className={`block ${META}`} data-testid="income-native">
      {foreign.map((item, index) => (
        <span key={item.currency}>
          {index === 0 ? null : ' + '}
          <MoneyText
            amount={item.amount}
            currency={item.currency}
            locale={formatting.locale}
            minorUnits={formatting.minorUnitsByCurrency[item.currency] ?? 2}
            className="whitespace-nowrap"
          />
        </span>
      ))}
    </span>
  );
}

/**
 * A gross cell (30.23 item 4; ADR 0012 D3): the recorded grosses' sum, with how
 * many payments it does not cover, or "No gross" — never a zero standing in for
 * one nobody stated.
 */
export function GrossCell({
  gross,
  formatting,
  className,
}: {
  readonly gross: IncomeGrossDto;
  readonly formatting: Formatting;
  readonly className: string;
}) {
  const note = withoutGrossNote(gross);
  return (
    <td className={className} data-testid="income-gross-cell">
      {gross.recorded === null ? (
        <span className={META}>No gross</span>
      ) : (
        <>
          <Amount display={incomeFigureDisplay(gross.recorded)} formatting={formatting} />
          {note === null ? null : <span className={`block ${META}`}>{note}</span>}
        </>
      )}
    </td>
  );
}
