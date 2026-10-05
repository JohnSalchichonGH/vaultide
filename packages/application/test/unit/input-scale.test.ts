import { describe, expect, it } from 'vitest';
import { minorUnitsMessage, moneyString } from '@vaultide/validation';
import { inputScaleErrors, type StatedAmount } from '../../src/currencies/scale';

/**
 * Input scale, as the pure judgement the write paths share (blueprint 7.2).
 *
 * The integration suite proves each write path asks it inside its own
 * transaction and writes nothing when it refuses; this proves what it answers,
 * at the boundaries, against the browser's own schema as an independent oracle.
 */

const MINOR_UNITS = new Map([
  ['EUR', 2],
  ['JPY', 0],
  ['KWD', 3],
  ['CLF', 4],
]);

const judge = (amount: string, currency: string) =>
  inputScaleErrors([{ field: 'amount', amount, currency }], MINOR_UNITS);

describe('inputScaleErrors', () => {
  it('accepts an amount at its currency limit and refuses one decimal past it', () => {
    for (const [currency, units] of MINOR_UNITS) {
      const atLimit = units === 0 ? '12' : `12.${'3'.repeat(units)}`;
      const past = `12.${'3'.repeat(units + 1)}`;
      expect(judge(atLimit, currency), `${currency} ${atLimit}`).toEqual({});
      expect(judge(past, currency), `${currency} ${past}`).toEqual({
        amount: [minorUnitsMessage(units)],
      });
    }
  });

  it('says exactly what the browser says', () => {
    for (const [currency, units] of MINOR_UNITS) {
      const past = `1.${'5'.repeat(units + 1)}`;
      const browser = moneyString({ minorUnits: units })
        .safeParse(past)
        .error?.issues.map((issue) => issue.message);
      expect(judge(past, currency).amount).toEqual(browser);
    }
  });

  it('judges negative balances by the same rule', () => {
    expect(judge('-10.12', 'EUR')).toEqual({});
    expect(judge('-10.123', 'EUR')).toEqual({ amount: [minorUnitsMessage(2)] });
    expect(judge('-1.5', 'JPY')).toEqual({ amount: [minorUnitsMessage(0)] });
  });

  it('judges the value, not its spelling: trailing zeros are not decimals', () => {
    expect(judge('10.120', 'EUR')).toEqual({});
    expect(judge('2.000', 'JPY')).toEqual({});
  });

  it('skips what the request leaves out or clears, and keys each refusal to its own field', () => {
    const stated: StatedAmount[] = [
      { field: 'fromAmount', amount: '10.123', currency: 'EUR' },
      { field: 'toAmount', amount: '1500.5', currency: 'JPY' },
      { field: 'fee.amount', amount: '0.5', currency: 'EUR' },
      { field: 'grossAmount', amount: undefined, currency: 'EUR' },
      { field: 'netAmount', amount: null, currency: 'EUR' },
    ];
    expect(inputScaleErrors(stated, MINOR_UNITS)).toEqual({
      fromAmount: [minorUnitsMessage(2)],
      toAmount: [minorUnitsMessage(0)],
    });
  });

  it('refuses an amount whose currency has no minor units to judge it by', () => {
    expect(judge('10', 'ZZZ')).toEqual({ currency: ['That is not a currency Vaultide knows.'] });
  });
});
