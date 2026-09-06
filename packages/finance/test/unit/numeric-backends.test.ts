import { describe, expect, it } from 'vitest';
import { DecimalBackend, FloatBackend, netWorthSign, POSITION_KINDS } from '../../src/index';
import type { Numeric } from '../../src/numeric/backend';

/**
 * A deterministic fixture exercising every backend method the projection engine
 * uses: monthly compounding of an opening balance with contributions, a
 * geometric annual→monthly rate conversion, an amortization-style interest
 * split, and a floor/cap. Blueprint 13.1 requires both backends to agree
 * month by month within 0.01 units.
 */
function runFixture<N>(backend: Numeric<N>, months: number): string[] {
  const one = backend.from(1);
  const twelve = backend.from(12);
  const annualReturn = backend.from('0.06');
  const monthlyReturn = backend.sub(
    backend.pow(backend.add(one, annualReturn), backend.div(one, twelve)),
    one,
  );
  const loanMonthlyRate = backend.div(backend.from('0.03'), twelve);
  const contribution = backend.from('500');
  const reserve = backend.from('10000');

  let investments = backend.from('41870');
  let cash = backend.from('16564');
  let debt = backend.from('98500');
  const states: string[] = [];

  for (let month = 0; month < months; month += 1) {
    // Income, then obligations, then discretionary contributions (13.3 order).
    cash = backend.add(cash, backend.from('2100'));

    const interest = backend.mul(debt, loanMonthlyRate);
    const payment = backend.from('474.21');
    const principal = backend.sub(payment, interest);
    debt = backend.max(backend.sub(debt, principal), backend.from(0));
    cash = backend.sub(cash, payment);

    const capacity = backend.max(backend.sub(cash, reserve), backend.from(0));
    const invested = backend.min(contribution, capacity);
    cash = backend.sub(cash, invested);

    investments = backend.add(backend.mul(investments, backend.add(one, monthlyReturn)), invested);

    const netWorth = backend.sub(backend.add(investments, cash), debt);
    states.push(backend.toDecimalString(backend.round(netWorth, 2)));
  }

  return states;
}

describe('numeric backends', () => {
  it('agree month by month within 0.01 over a 120-month deterministic run', () => {
    const months = 120;
    const decimal = runFixture(DecimalBackend, months);
    const float = runFixture(FloatBackend, months);

    expect(float).toHaveLength(months);
    for (let month = 0; month < months; month += 1) {
      const a = Number.parseFloat(decimal[month] as string);
      const b = Number.parseFloat(float[month] as string);
      expect(Math.abs(a - b), `month ${String(month + 1)} diverged`).toBeLessThanOrEqual(0.01);
    }
  });

  it('are deterministic: the same inputs give byte-identical output', () => {
    expect(runFixture(DecimalBackend, 24)).toEqual(runFixture(DecimalBackend, 24));
    expect(runFixture(FloatBackend, 24)).toEqual(runFixture(FloatBackend, 24));
  });

  it('implement the same ten-method contract', () => {
    // Generic over the backend so each concrete arithmetic type is checked on
    // its own terms rather than through a union.
    function assertContract<N>(backend: Numeric<N>): void {
      const two = backend.from(2);
      const three = backend.from('3');
      expect(backend.toDecimalString(backend.add(two, three))).toBe('5');
      expect(backend.toDecimalString(backend.sub(three, two))).toBe('1');
      expect(backend.toDecimalString(backend.mul(two, three))).toBe('6');
      expect(backend.toDecimalString(backend.div(three, two))).toBe('1.5');
      expect(backend.toDecimalString(backend.pow(two, three))).toBe('8');
      expect(backend.cmp(two, three)).toBe(-1);
      expect(backend.cmp(three, two)).toBe(1);
      expect(backend.cmp(two, two)).toBe(0);
      expect(backend.toDecimalString(backend.min(two, three))).toBe('2');
      expect(backend.toDecimalString(backend.max(two, three))).toBe('3');
      // Both argument orders, so neither comparison branch goes unexercised.
      expect(backend.toDecimalString(backend.min(three, two))).toBe('2');
      expect(backend.toDecimalString(backend.max(three, two))).toBe('3');
      expect(backend.toDecimalString(backend.min(two, two))).toBe('2');
      expect(backend.toDecimalString(backend.round(backend.from('2.5'), 0))).toBe('3');
      expect(backend.toDecimalString(backend.round(backend.from('-2.5'), 0))).toBe('-3');
    }

    assertContract(DecimalBackend);
    assertContract(FloatBackend);
  });

  it('rounds half-up exactly only on the decimal backend', () => {
    expect(DecimalBackend.toDecimalString(DecimalBackend.round(DecimalBackend.from('2.345'), 2)))
      .toBe('2.35');
    expect(DecimalBackend.toDecimalString(DecimalBackend.round(DecimalBackend.from('-2.345'), 2)))
      .toBe('-2.35');
    // 1.005 is not representable as a double (it is held as 1.00499999999…),
    // so the float backend rounds down where exact half-up rounds up. This is
    // precisely why authoritative money never goes through FloatBackend.
    expect(DecimalBackend.toDecimalString(DecimalBackend.round(DecimalBackend.from('1.005'), 2)))
      .toBe('1.01');
    expect(FloatBackend.round(1.005, 2)).toBe(1);
  });

  it('only the decimal backend is exact — which is why money never uses the float one', () => {
    const decimalSum = DecimalBackend.add(DecimalBackend.from('0.1'), DecimalBackend.from('0.2'));
    expect(DecimalBackend.toDecimalString(decimalSum)).toBe('0.3');

    const floatSum = FloatBackend.add(FloatBackend.from('0.1'), FloatBackend.from('0.2'));
    expect(floatSum).not.toBe(0.3);
  });
});

describe('netWorthSign', () => {
  it('signs assets +1 and liabilities −1', () => {
    expect(netWorthSign('cash')).toBe(1);
    expect(netWorthSign('investment')).toBe(1);
    expect(netWorthSign('property')).toBe(1);
    expect(netWorthSign('other_asset')).toBe(1);
    expect(netWorthSign('liability')).toBe(-1);
  });

  it('makes loan proceeds and principal repayments net-worth neutral (7.8)', () => {
    const amount = 5000;
    // Loan proceeds: cash +X, liability balance +X.
    expect(netWorthSign('cash') * amount + netWorthSign('liability') * amount).toBe(0);
    // Principal repayment: cash −X, liability balance −X.
    expect(netWorthSign('cash') * -amount + netWorthSign('liability') * -amount).toBe(0);
    // Interest is a cost: cash −I with no liability movement.
    expect(netWorthSign('cash') * -111).toBe(-111);
  });

  it('covers every position kind', () => {
    expect(POSITION_KINDS).toHaveLength(5);
    for (const kind of POSITION_KINDS) {
      expect([1, -1]).toContain(netWorthSign(kind));
    }
  });
});
