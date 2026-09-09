import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey, type PlainDate } from '../src/dates/plain-date';
import { createFxTable, type FxRateRecord } from '../src/fx/index';
import { money, currencyCode, type CurrencyCode } from '../src/money/index';
import { isUnavailable } from '../src/unavailable';
import {
  addAmounts,
  emptyAmount,
  missingAmount,
  reportCashFlow,
  reportSourceOnly,
  residualContribution,
  statedAmount,
  subtractAmounts,
  sumAmountsOf,
  untrackedContribution,
  EXACT_PROVENANCE,
  type MissingReportingContribution,
  type ReportingAmount,
  type ReportingContribution,
  type ReportingCashFlow,
  type MissingContributionInput,
} from '../src/reporting/index';

/**
 * Reporting-currency cash flow and savings (blueprint 12.3, 12.5, 8.11,
 * v2.1.13 30.16).
 *
 * The rates below are deliberately absurd — 2.0, 0.5, 2.5, 5.0, 10.0 — so that
 * converting a component at its own date and converting a composite at one rate
 * cannot accidentally agree. A test that passes on realistic rates because two
 * conventions happen to be close proves nothing.
 *
 * Stored rows are `EUR -> quote`, so a USD amount converts to EUR by dividing.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const GBP = currencyCode('GBP');
const SEPTEMBER: MonthKey = monthKeyOf(2026, 9);

const rate = (quote: string, on: string, value: string): FxRateRecord => ({
  quote: currencyCode(quote),
  rateDate: plainDate(on),
  rate: new Decimal(value),
  source: 'ECB',
});

/** The §27 rate set: five September observations whose mean is exactly 4.0. */
const USD_RATES: FxRateRecord[] = [
  rate('USD', '2026-09-01', '2.0'),
  rate('USD', '2026-09-10', '0.5'),
  rate('USD', '2026-09-15', '2.5'),
  rate('USD', '2026-09-20', '5.0'),
  rate('USD', '2026-09-30', '10.0'),
];

const OCTOBER_TODAY = plainDate('2026-10-05');
const table = (rows: FxRateRecord[] = USD_RATES, today = OCTOBER_TODAY) =>
  createFxTable(rows, { today });

const dated = (
  field: ReportingContribution['field'],
  amount: string,
  currency: CurrencyCode,
  on: string,
): ReportingContribution => ({
  field,
  amount: money(new Decimal(amount), currency),
  basis: { kind: 'dated', on: plainDate(on) },
});

function flow(
  contributions: readonly ReportingContribution[],
  options: {
    countAdditionalSpending?: boolean;
    missing?: readonly MissingContributionInput[];
    rows?: FxRateRecord[];
    today?: PlainDate;
  } = {},
): ReportingCashFlow {
  return reportCashFlow({
    reportingCurrency: EUR,
    fx: table(options.rows ?? USD_RATES, options.today ?? OCTOBER_TODAY),
    contributions,
    missing: options.missing ?? [],
    countAdditionalSpending: options.countAdditionalSpending ?? true,
  });
}

const amount = (a: { value: { amount: Decimal } }): string => a.value.amount.toString();

/* -------------------------------------------------------------------------- */
/* Native currency == reporting currency                                      */
/* -------------------------------------------------------------------------- */

describe('when the native currency is the reporting currency', () => {
  it('states every figure exactly, with no rate and no estimated marker', () => {
    // An empty FX table: if any conversion needed a stored rate, this fails.
    const result = flow(
      [
        dated('externalIncome', '2131', EUR, '2026-09-25'),
        dated('knownConsumption', '300', EUR, '2026-09-12'),
        dated('interestAndFees', '111', EUR, '2026-09-12'),
        residualContribution(new Decimal('429'), EUR, SEPTEMBER, 'reliable'),
        untrackedContribution('additionalSpending', new Decimal('50'), EUR, plainDate('2026-09-13'), 'e1'),
        untrackedContribution('thirdPartyPaid', new Decimal('80'), EUR, plainDate('2026-09-14'), 'e2'),
      ],
      { rows: [] },
    );

    // The §12.7 savings golden, restated in the reporting currency.
    expect(amount(result.externalIncome)).toBe('2131');
    expect(amount(result.knownConsumption)).toBe('300');
    expect(amount(result.interestAndFees)).toBe('111');
    expect(amount(result.unclassified)).toBe('429');
    expect(amount(result.consumption)).toBe('729');
    expect(amount(result.trackedTotalSpending)).toBe('840');
    expect(amount(result.trackedSavingsFromIncome)).toBe('1291');
    expect(amount(result.personalSavings)).toBe('1241');
    expect(amount(result.totalSpending)).toBe('890');
    expect(amount(result.thirdPartyPaid)).toBe('80');

    for (const figure of [
      result.externalIncome,
      result.unclassified,
      result.consumption,
      result.trackedTotalSpending,
      result.personalSavings,
      result.totalSpending,
    ]) {
      expect(figure.availability).toBe('available');
      // No conversion happened, so nothing is estimated and nothing is approximate.
      expect(figure.provenance.estimatedConversion).toBe(false);
      expect(figure.provenance.approximate).toBe(false);
    }

    const rate_ = result.savingsRate;
    if (isUnavailable(rate_)) throw new Error('expected a rate');
    expect(rate_.toString()).toBe(new Decimal('1241').dividedBy(2131).toString());
    expect(rate_.times(100).toDecimalPlaces(2).toString()).toBe('58.24');
  });
});

/* -------------------------------------------------------------------------- */
/* One foreign bucket                                                         */
/* -------------------------------------------------------------------------- */

describe('one foreign bucket, with deliberately different rates', () => {
  const usdMonth = (): ReportingContribution[] => [
    dated('externalIncome', '100', USD, '2026-09-01'),
    dated('knownConsumption', '50', USD, '2026-09-15'),
    residualContribution(new Decimal('20'), USD, SEPTEMBER, 'reliable'),
    untrackedContribution('additionalSpending', new Decimal('10'), USD, plainDate('2026-09-20'), 'e1'),
  ];

  it('converts each component at its own basis', () => {
    const result = flow(usdMonth());

    // 100 / 2.0, 50 / 2.5, 20 / 4.0 (the month's mean), 10 / 5.0.
    expect(amount(result.externalIncome)).toBe('50');
    expect(amount(result.knownConsumption)).toBe('20');
    expect(amount(result.unclassified)).toBe('5');
    expect(amount(result.additionalSpending)).toBe('2');

    expect(amount(result.consumption)).toBe('25');
    expect(amount(result.trackedTotalSpending)).toBe('25');
    expect(amount(result.trackedSavingsFromIncome)).toBe('25');
    expect(amount(result.personalSavings)).toBe('23');
    expect(amount(result.totalSpending)).toBe('27');

    const rate_ = result.savingsRate;
    if (isUnavailable(rate_)) throw new Error('expected a rate');
    expect(rate_.toString()).toBe('0.46');
  });

  it('marks only the residual as an estimated conversion', () => {
    const result = flow(usdMonth());
    expect(result.externalIncome.provenance.estimatedConversion).toBe(false);
    expect(result.unclassified.provenance.estimatedConversion).toBe(true);
    // The month has five stored observations, so the average is a real average.
    expect(result.unclassified.provenance.approximate).toBe(false);
    // And the figures that contain it say so.
    expect(result.consumption.provenance.estimatedConversion).toBe(true);
    expect(result.trackedTotalSpending.provenance.estimatedConversion).toBe(true);
  });

  it('does not agree with converting the native composite at the month-end rate', () => {
    // The proof that the rule is doing work rather than coinciding. Natively
    // this month is income 100, consumption 70, tracked spending 70 and savings
    // 30; at the 30 September rate of 10.0 those would be 10, 7, 7 and 3.
    const result = flow(usdMonth());
    const wholesale = {
      externalIncome: new Decimal('100').dividedBy('10.0'),
      trackedTotalSpending: new Decimal('70').dividedBy('10.0'),
      trackedSavingsFromIncome: new Decimal('30').dividedBy('10.0'),
    };
    expect(amount(result.externalIncome)).not.toBe(wholesale.externalIncome.toString());
    expect(amount(result.trackedTotalSpending)).not.toBe(
      wholesale.trackedTotalSpending.toString(),
    );
    expect(amount(result.trackedSavingsFromIncome)).not.toBe(
      wholesale.trackedSavingsFromIncome.toString(),
    );
  });

  it('moves the savings and the rate, and nothing else, when the setting is off', () => {
    const result = flow(usdMonth(), { countAdditionalSpending: false });
    expect(amount(result.personalSavings)).toBe('25');
    expect(amount(result.totalSpending)).toBe('27');
    expect(amount(result.additionalSpending)).toBe('2');
    const rate_ = result.savingsRate;
    if (isUnavailable(rate_)) throw new Error('expected a rate');
    expect(rate_.toString()).toBe('0.5');
    expect(result.countsAdditionalSpending).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Two currencies                                                             */
/* -------------------------------------------------------------------------- */

describe('two currencies', () => {
  it('aggregates the components and takes one ratio over the totals', () => {
    const result = flow([
      // EUR bucket: income 50, known consumption 10, residual 5.
      dated('externalIncome', '50', EUR, '2026-09-02'),
      dated('knownConsumption', '10', EUR, '2026-09-03'),
      residualContribution(new Decimal('5'), EUR, SEPTEMBER, 'reliable'),
      // USD bucket: the fixture above.
      dated('externalIncome', '100', USD, '2026-09-01'),
      dated('knownConsumption', '50', USD, '2026-09-15'),
      residualContribution(new Decimal('20'), USD, SEPTEMBER, 'reliable'),
      untrackedContribution('additionalSpending', new Decimal('10'), USD, plainDate('2026-09-20'), 'e1'),
    ]);

    expect(amount(result.externalIncome)).toBe('100');
    expect(amount(result.trackedTotalSpending)).toBe('40');
    expect(amount(result.additionalSpending)).toBe('2');
    expect(amount(result.totalSpending)).toBe('42');
    expect(amount(result.trackedSavingsFromIncome)).toBe('60');
    expect(amount(result.personalSavings)).toBe('58');

    const rate_ = result.savingsRate;
    if (isUnavailable(rate_)) throw new Error('expected a rate');
    // One ratio over the aggregates — never a mean of 0.7 and 0.46.
    expect(rate_.toString()).toBe('0.58');
  });
});

/* -------------------------------------------------------------------------- */
/* Dependency cases                                                           */
/* -------------------------------------------------------------------------- */

/** A rate table with USD but not GBP, so a GBP row cannot convert. */
const noGbp = USD_RATES;

describe('a missing conversion reaches only the figures that consume it', () => {
  const base = (): ReportingContribution[] => [
    dated('externalIncome', '100', USD, '2026-09-01'),
    dated('knownConsumption', '50', USD, '2026-09-15'),
    residualContribution(new Decimal('20'), USD, SEPTEMBER, 'reliable'),
  ];

  it('A — additional spending unconvertible with the setting on', () => {
    const result = flow(
      [
        ...base(),
        untrackedContribution('additionalSpending', new Decimal('10'), GBP, plainDate('2026-09-20'), 'e1'),
      ],
      { rows: noGbp },
    );

    expect(result.additionalSpending.availability).toBe('unavailable');
    expect(result.additionalSpending.missing[0]?.currency).toBe('GBP');
    expect(result.personalSavings.availability).toBe('partial');
    expect(result.totalSpending.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
    // The untouched side stays whole.
    expect(result.externalIncome.availability).toBe('available');
    expect(result.trackedSavingsFromIncome.availability).toBe('available');
  });

  it('B — the same, with the setting off, leaves savings and the rate alone', () => {
    const result = flow(
      [
        ...base(),
        untrackedContribution('additionalSpending', new Decimal('10'), GBP, plainDate('2026-09-20'), 'e1'),
      ],
      { rows: noGbp, countAdditionalSpending: false },
    );

    expect(result.additionalSpending.availability).toBe('unavailable');
    expect(result.totalSpending.availability).toBe('partial');
    // The formula subtracts nothing, so nothing is missing from it.
    expect(result.personalSavings.availability).toBe('available');
    expect(amount(result.personalSavings)).toBe('25');
    const rate_ = result.savingsRate;
    if (isUnavailable(rate_)) throw new Error('expected a rate');
    expect(rate_.toString()).toBe('0.5');
  });

  it('C — an unconvertible memo touches nothing but itself', () => {
    const result = flow(
      [
        ...base(),
        untrackedContribution('thirdPartyPaid', new Decimal('80'), GBP, plainDate('2026-09-21'), 'e2'),
      ],
      { rows: noGbp },
    );

    expect(result.thirdPartyPaid.availability).toBe('unavailable');
    for (const figure of [
      result.trackedTotalSpending,
      result.trackedSavingsFromIncome,
      result.personalSavings,
      result.totalSpending,
    ]) {
      expect(figure.availability).toBe('available');
    }
    expect(isUnavailable(result.savingsRate)).toBe(false);
  });

  it('D — an unconvertible external outflow spares the savings', () => {
    const result = flow([...base(), dated('externalOutflows', '30', GBP, '2026-09-22')], {
      rows: noGbp,
    });

    expect(result.externalOutflows.availability).toBe('unavailable');
    expect(result.trackedTotalSpending.availability).toBe('partial');
    expect(result.totalSpending.availability).toBe('partial');
    // 12.5 does not subtract external outflows, so these never depended on it.
    expect(result.trackedSavingsFromIncome.availability).toBe('available');
    expect(result.personalSavings.availability).toBe('available');
    expect(isUnavailable(result.savingsRate)).toBe(false);
  });

  it('E — an unconvertible transaction cost reaches both sides', () => {
    const result = flow([...base(), dated('transactionCosts', '30', GBP, '2026-09-22')], {
      rows: noGbp,
    });

    expect(result.transactionCosts.availability).toBe('unavailable');
    expect(result.trackedTotalSpending.availability).toBe('partial');
    expect(result.trackedSavingsFromIncome.availability).toBe('partial');
    expect(result.personalSavings.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
  });

  it('F — unconvertible income takes the income side and the rate', () => {
    const result = flow([...base(), dated('externalIncome', '40', GBP, '2026-09-02')], {
      rows: noGbp,
    });

    expect(result.externalIncome.availability).toBe('partial');
    expect(amount(result.externalIncome)).toBe('50');
    expect(result.trackedSavingsFromIncome.availability).toBe('partial');
    expect(result.personalSavings.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
    // Spending never consumed it.
    expect(result.trackedTotalSpending.availability).toBe('available');
  });

  it('G — an unconvertible residual reaches consumption and everything past it', () => {
    const result = flow(
      [...base(), residualContribution(new Decimal('7'), GBP, SEPTEMBER, 'reliable')],
      { rows: noGbp },
    );

    expect(result.unclassified.availability).toBe('partial');
    expect(result.consumption.availability).toBe('partial');
    expect(result.trackedTotalSpending.availability).toBe('partial');
    expect(result.trackedSavingsFromIncome.availability).toBe('partial');
    expect(result.personalSavings.availability).toBe('partial');
    expect(result.totalSpending.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
    // And the untouched ones.
    expect(result.externalIncome.availability).toBe('available');
    expect(result.thirdPartyPaid.availability).toBe('available');
  });

  it('distinguishes partial from unavailable by whether anything could be stated', () => {
    const partial = flow(
      [
        dated('externalIncome', '100', USD, '2026-09-01'),
        dated('externalIncome', '40', GBP, '2026-09-02'),
      ],
      { rows: noGbp },
    );
    const nothing = flow([dated('externalIncome', '40', GBP, '2026-09-02')], { rows: noGbp });

    expect(partial.externalIncome.availability).toBe('partial');
    expect(amount(partial.externalIncome)).toBe('50');
    expect(nothing.externalIncome.availability).toBe('unavailable');
    expect(amount(nothing.externalIncome)).toBe('0');
  });

  it('calls an empty figure available at exactly zero', () => {
    const result = flow([dated('externalIncome', '100', USD, '2026-09-01')]);
    expect(result.thirdPartyPaid.availability).toBe('available');
    expect(amount(result.thirdPartyPaid)).toBe('0');
    expect(result.thirdPartyPaid.statedCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* A residual nobody could state                                              */
/* -------------------------------------------------------------------------- */

describe('a bucket whose residual is not a spending figure', () => {
  const missingResidual: MissingContributionInput[] = [
    {
      field: 'unclassified',
      currency: USD,
      reason: 'not_applicable',
      detail: 'unresolved',
    },
  ];

  it('keeps the source classifications and withholds what depends on the residual', () => {
    const result = flow(
      [
        dated('externalIncome', '100', USD, '2026-09-01'),
        dated('knownConsumption', '50', USD, '2026-09-15'),
      ],
      { missing: missingResidual },
    );

    // The records still say what they say (30.16 item 8).
    expect(result.externalIncome.availability).toBe('available');
    expect(amount(result.externalIncome)).toBe('50');
    expect(result.knownConsumption.availability).toBe('available');
    expect(amount(result.knownConsumption)).toBe('20');

    // And the derived figures say they could not be completed.
    expect(result.unclassified.availability).toBe('unavailable');
    expect(result.consumption.availability).toBe('partial');
    expect(result.trackedSavingsFromIncome.availability).toBe('partial');
    expect(isUnavailable(result.savingsRate)).toBe(true);
    expect(result.unclassified.missing[0]?.detail).toBe('unresolved');
  });
});

/* -------------------------------------------------------------------------- */
/* Quality and the current month                                              */
/* -------------------------------------------------------------------------- */

describe('calculation quality travels beside availability, not inside it', () => {
  it('carries an estimated bucket’s quality into what it feeds, and no further', () => {
    const result = flow([
      dated('externalIncome', '100', USD, '2026-09-01'),
      residualContribution(new Decimal('20'), USD, SEPTEMBER, 'estimated'),
    ]);

    // A source sum is exact whatever the balances did.
    expect(result.externalIncome.quality).toBeUndefined();
    expect(result.unclassified.quality).toBe('estimated');
    expect(result.consumption.quality).toBe('estimated');
    expect(result.trackedSavingsFromIncome.quality).toBe('estimated');
    // Availability is a separate axis and is untouched.
    expect(result.consumption.availability).toBe('available');
  });

  it('states a month-to-date residual through D, and never from a later rate', () => {
    // today = 10 Sep, D = 6 Sep, and rates exist on the 8th and 9th that would
    // change the answer if they were allowed to reach it.
    const rows = [
      rate('USD', '2026-09-01', '2.0'),
      rate('USD', '2026-09-02', '2.0'),
      rate('USD', '2026-09-03', '2.0'),
      rate('USD', '2026-09-04', '2.0'),
      rate('USD', '2026-09-05', '2.0'),
      rate('USD', '2026-09-08', '100.0'),
      rate('USD', '2026-09-09', '100.0'),
    ];
    const through = plainDate('2026-09-06');
    const result = reportCashFlow({
      reportingCurrency: EUR,
      fx: createFxTable(rows, { today: plainDate('2026-09-10') }),
      contributions: [
        residualContribution(new Decimal('20'), USD, SEPTEMBER, 'provisional', through),
      ],
      missing: [],
      countAdditionalSpending: true,
    });

    // Five eligible observations, all 2.0, so 20 / 2.0 = 10 — not 20 / 30.
    expect(amount(result.unclassified)).toBe('10');
    expect(result.unclassified.quality).toBe('provisional');
    expect(result.unclassified.provenance.estimatedConversion).toBe(true);
    expect(result.unclassified.provenance.approximate).toBe(false);
  });

  it('is unchanged when only the rates after D change', () => {
    const before = [
      rate('USD', '2026-09-01', '2.0'),
      rate('USD', '2026-09-02', '2.0'),
      rate('USD', '2026-09-03', '2.0'),
      rate('USD', '2026-09-04', '2.0'),
      rate('USD', '2026-09-05', '2.0'),
      rate('USD', '2026-09-08', '100.0'),
    ];
    const after = [...before.slice(0, 5), rate('USD', '2026-09-08', '0.001')];
    const run = (rows: FxRateRecord[]): string =>
      amount(
        reportCashFlow({
          reportingCurrency: EUR,
          fx: createFxTable(rows, { today: plainDate('2026-09-10') }),
          contributions: [
            residualContribution(
              new Decimal('20'),
              USD,
              SEPTEMBER,
              'provisional',
              plainDate('2026-09-06'),
            ),
          ],
          missing: [],
          countAdditionalSpending: true,
        }).unclassified,
      );

    expect(run(after)).toBe(run(before));
  });
});

/* -------------------------------------------------------------------------- */
/* Conservation                                                               */
/* -------------------------------------------------------------------------- */

describe('two buckets meeting in one figure', () => {
  it('takes the worse calculation quality of the residuals feeding it', () => {
    const result = flow([
      residualContribution(new Decimal('20'), USD, SEPTEMBER, 'reliable'),
      residualContribution(new Decimal('10'), EUR, SEPTEMBER, 'estimated'),
    ]);
    // One bucket estimated is enough to make the figure it feeds estimated.
    expect(result.unclassified.quality).toBe('estimated');
    expect(result.consumption.quality).toBe('estimated');
  });

  it('records one missing contribution per currency and reason, not per row', () => {
    const result = flow(
      [
        untrackedContribution('additionalSpending', new Decimal('10'), GBP, plainDate('2026-09-20'), 'e1'),
        untrackedContribution('additionalSpending', new Decimal('20'), GBP, plainDate('2026-09-21'), 'e2'),
        untrackedContribution('additionalSpending', new Decimal('30'), GBP, plainDate('2026-09-22'), 'e3'),
      ],
      { rows: noGbp },
    );

    // Three unconvertible rows, one currency, one reason: saying it three times
    // would make the diagnostic grow with the data without saying more.
    expect(result.additionalSpending.availability).toBe('unavailable');
    expect(result.additionalSpending.missing).toHaveLength(1);
    expect(result.additionalSpending.missing[0]?.currency).toBe('GBP');
  });
});

/* -------------------------------------------------------------------------- */
/* The algebra of a 12.5 formula                                              */
/* -------------------------------------------------------------------------- */

/**
 * Availability, over operands rather than over rows (v2.1.13 30.16 item 7).
 *
 * These are stated directly on the aggregates instead of through a fixture,
 * because the rule belongs to the arithmetic and not to any one month. The
 * distinction they pin: an operand that says `available` is a stated financial
 * value — "no such record exists" is knowledge — even when it is an exact zero
 * summed from no contributions at all, and a formula with one known operand and
 * one missing one still knows something.
 */
describe('composing two already-evaluated figures', () => {
  const gap = (currency = USD): MissingReportingContribution => ({
    currency,
    reason: 'fx_missing',
  });

  /** An exact zero: nothing to sum, nothing missing, no contributions in it. */
  const availableZero = (): ReportingAmount => emptyAmount(EUR);
  const unavailable = (currency = USD): ReportingAmount => missingAmount(EUR, gap(currency));

  it('Z1 — an available zero plus an unavailable operand is partial at zero', () => {
    // `TrackedTotalSpending` known to be zero, `AdditionalSpending` unconvertible.
    const total = addAmounts(availableZero(), unavailable());

    expect(total.availability).toBe('partial');
    expect(total.value.amount.toString()).toBe('0');
    expect(total.missing).toHaveLength(1);
    // The zero really did come from nothing, and was not padded to look stated.
    expect(total.statedCount).toBe(0);
  });

  it('Z2 — the same in a subtraction, so a savings formula degrades the same way', () => {
    const savings = subtractAmounts(availableZero(), unavailable());

    expect(savings.availability).toBe('partial');
    expect(savings.value.amount.toString()).toBe('0');
    expect(savings.statedCount).toBe(0);
  });

  it('Z3 — a contribution that is genuinely zero counts the same as any other', () => {
    const zeroRow = statedAmount(money(new Decimal('0'), EUR), EXACT_PROVENANCE);
    const summed = sumAmountsOf([zeroRow, unavailable()], EUR);

    expect(summed.availability).toBe('partial');
    expect(summed.value.amount.toString()).toBe('0');
    expect(summed.statedCount).toBe(1);
    expect(addAmounts(summed, availableZero()).availability).toBe('partial');
  });

  it('keeps a partial operand partial when something else is missing', () => {
    const partial = sumAmountsOf(
      [statedAmount(money(new Decimal('40'), EUR), EXACT_PROVENANCE), unavailable()],
      EUR,
    );
    const combined = addAmounts(partial, unavailable(GBP));

    expect(combined.availability).toBe('partial');
    expect(combined.value.amount.toString()).toBe('40');
    // One entry per currency and reason, in a fixed order (30.16 item 10).
    expect(combined.missing.map((m) => m.currency)).toEqual(['GBP', 'USD']);
  });

  it('is unavailable only when every operand is', () => {
    const combined = addAmounts(unavailable(), unavailable(GBP));

    expect(combined.availability).toBe('unavailable');
    expect(combined.value.amount.toString()).toBe('0');
    expect(combined.statedCount).toBe(0);
  });

  it('is available when neither side is missing anything, at exactly zero', () => {
    const combined = addAmounts(availableZero(), availableZero());

    expect(combined.availability).toBe('available');
    expect(combined.value.amount.toString()).toBe('0');
    expect(combined.missing).toEqual([]);
  });

  it('leaves a primitive with no convertible row unavailable, not partial at zero', () => {
    // The other half of the rule, and the reason there are two of them: a sum
    // of contributions has no operands, only rows, and a figure whose only row
    // could not be converted has nothing of its own to state.
    expect(sumAmountsOf([unavailable()], EUR).availability).toBe('unavailable');
    expect(sumAmountsOf([], EUR).availability).toBe('available');
  });
});

/* -------------------------------------------------------------------------- */
/* A month with nothing in it, and a month with no interval at all            */
/* -------------------------------------------------------------------------- */

describe('an empty interval and no interval are different answers', () => {
  it('a valid interval with no activity states an exact zero everywhere', () => {
    // Balances that agree, no income, no costs, a residual of exactly zero.
    const result = flow([residualContribution(new Decimal('0'), EUR, SEPTEMBER, 'reliable')]);

    for (const figure of [
      result.externalIncome,
      result.knownConsumption,
      result.propertyOperatingCosts,
      result.interestAndFees,
      result.transactionCosts,
      result.externalOutflows,
      result.unclassified,
      result.additionalSpending,
      result.thirdPartyPaid,
      result.consumption,
      result.trackedTotalSpending,
      result.trackedSavingsFromIncome,
      result.personalSavings,
      result.totalSpending,
    ]) {
      expect(figure.availability).toBe('available');
      expect(figure.value.amount.toString()).toBe('0');
      expect(figure.missing).toEqual([]);
    }
    // A measured zero income is a denominator, and it is zero.
    expect(isUnavailable(result.savingsRate)).toBe(true);
    if (!isUnavailable(result.savingsRate)) throw new Error('expected no rate');
    expect(result.savingsRate.reason).toBe('divide_by_zero');
  });

  it('no interval states two figures and has no others to state', () => {
    const result = reportSourceOnly({
      reportingCurrency: EUR,
      fx: table(),
      contributions: [
        untrackedContribution('additionalSpending', new Decimal('50'), EUR, plainDate('2026-09-08'), 'e1'),
        untrackedContribution('thirdPartyPaid', new Decimal('80'), EUR, plainDate('2026-09-09'), 'e2'),
      ],
    });

    expect(amount(result.additionalSpending)).toBe('50');
    expect(result.additionalSpending.availability).toBe('available');
    expect(amount(result.thirdPartyPaid)).toBe('80');
    // There is no total spending here to be equal to the additional spending,
    // and no savings to be its negation. Only these two keys exist.
    expect(Object.keys(result).sort()).toEqual([
      'additionalSpending',
      'reportingCurrency',
      'thirdPartyPaid',
    ]);
  });

  it('reports a source-only figure as unavailable when its own rate is missing', () => {
    const result = reportSourceOnly({
      reportingCurrency: EUR,
      fx: table(noGbp),
      contributions: [
        untrackedContribution('additionalSpending', new Decimal('50'), GBP, plainDate('2026-09-08'), 'e1'),
        untrackedContribution('thirdPartyPaid', new Decimal('80'), EUR, plainDate('2026-09-09'), 'e2'),
      ],
    });

    expect(result.additionalSpending.availability).toBe('unavailable');
    expect(result.additionalSpending.missing[0]?.currency).toBe('GBP');
    expect(result.thirdPartyPaid.availability).toBe('available');
    expect(amount(result.thirdPartyPaid)).toBe('80');
  });
});

/* -------------------------------------------------------------------------- */
/* What the savings rate says when it cannot be taken                         */
/* -------------------------------------------------------------------------- */

/**
 * `not_applicable` on the rate is the repository's generic fallback for a
 * derived result whose prerequisite aggregate is incomplete — the same use as
 * `networth`'s `?? 'not_applicable'` — and never a claim that the savings
 * concept does not apply. These tests pin what a caller can still find out: the
 * authoritative cause, with its currency and its own reason, is on the input
 * aggregate it was observed on.
 */
describe('the rate names the side, and the inputs name the cause', () => {
  it('an unconvertible cost leaves its reason on the numerator', () => {
    const result = flow(
      [
        dated('externalIncome', '100', USD, '2026-09-01'),
        dated('transactionCosts', '40', GBP, '2026-09-02'),
      ],
      { rows: noGbp },
    );

    expect(isUnavailable(result.savingsRate)).toBe(true);
    if (!isUnavailable(result.savingsRate)) throw new Error('expected no rate');
    expect(result.savingsRate.reason).toBe('not_applicable');
    expect(result.savingsRate.detail).toBe('personal savings could not be stated in full');

    // Which is where a caller looks next, and finds the real reason.
    expect(result.personalSavings.availability).toBe('partial');
    expect(result.personalSavings.missing).toEqual([
      { currency: 'GBP', reason: 'fx_missing', detail: 'no stored rates for GBP' },
    ]);
    expect(result.transactionCosts.missing[0]?.reason).toBe('fx_missing');
    // The denominator was fine, and says so.
    expect(result.externalIncome.availability).toBe('available');
    expect(result.externalIncome.missing).toEqual([]);
  });

  it('an unconvertible income leaves its reason on the denominator too', () => {
    const result = flow(
      [
        dated('externalIncome', '100', USD, '2026-09-01'),
        dated('externalIncome', '40', GBP, '2026-09-02'),
      ],
      { rows: noGbp },
    );

    expect(isUnavailable(result.savingsRate)).toBe(true);
    if (!isUnavailable(result.savingsRate)) throw new Error('expected no rate');
    expect(result.savingsRate.reason).toBe('not_applicable');

    expect(result.externalIncome.availability).toBe('partial');
    expect(result.externalIncome.missing[0]).toEqual({
      currency: 'GBP',
      reason: 'fx_missing',
      detail: 'no stored rates for GBP',
    });
    // 12.5 derives the savings from the income, so the same gap is on both. The
    // rate names the numerator because that is the operand it read first; the
    // cause is on the aggregate where it happened, not promoted onto the ratio.
    expect(result.personalSavings.missing).toEqual(result.externalIncome.missing);
  });

  it('a missing reconciliation dependency reaches the rate the same way', () => {
    const result = flow([dated('externalIncome', '100', USD, '2026-09-01')], {
      missing: [
        { field: 'unclassified', currency: USD, reason: 'no_valuation', detail: 'reconciliation_unavailable' },
      ],
    });

    expect(isUnavailable(result.savingsRate)).toBe(true);
    if (!isUnavailable(result.savingsRate)) throw new Error('expected no rate');
    expect(result.savingsRate.reason).toBe('not_applicable');
    expect(result.personalSavings.missing).toEqual([
      { currency: 'USD', reason: 'no_valuation', detail: 'reconciliation_unavailable' },
    ]);
  });

  it('a complete but zero denominator is its own reason, not the fallback', () => {
    const result = flow([dated('knownConsumption', '50', USD, '2026-09-15')]);

    expect(result.externalIncome.availability).toBe('available');
    expect(amount(result.externalIncome)).toBe('0');
    expect(isUnavailable(result.savingsRate)).toBe(true);
    if (!isUnavailable(result.savingsRate)) throw new Error('expected no rate');
    expect(result.savingsRate.reason).toBe('divide_by_zero');
  });
});

/* -------------------------------------------------------------------------- */
/* The reporting cost partition                                               */
/* -------------------------------------------------------------------------- */

describe('the reporting cost partition holds exactly', () => {
  it('sums the five spending buckets back to tracked total spending', () => {
    const result = flow([
      dated('knownConsumption', '50', USD, '2026-09-15'),
      dated('propertyOperatingCosts', '10', EUR, '2026-09-16'),
      dated('interestAndFees', '20', USD, '2026-09-15'),
      dated('transactionCosts', '5', EUR, '2026-09-17'),
      dated('externalOutflows', '15', USD, '2026-09-20'),
      residualContribution(new Decimal('20'), USD, SEPTEMBER, 'reliable'),
      untrackedContribution('thirdPartyPaid', new Decimal('80'), EUR, plainDate('2026-09-21'), 'e2'),
    ]);

    const parts = result.consumption.value.amount
      .plus(result.propertyOperatingCosts.value.amount)
      .plus(result.interestAndFees.value.amount)
      .plus(result.transactionCosts.value.amount)
      .plus(result.externalOutflows.value.amount);
    expect(parts.equals(result.trackedTotalSpending.value.amount)).toBe(true);

    // Built from per-flow conversions, not from the engine's own sum:
    // 50/2.5 + 10 + 20/2.5 + 5 + 15/5.0 + 20/4.0 = 20 + 10 + 8 + 5 + 3 + 5.
    expect(amount(result.trackedTotalSpending)).toBe('51');
    // And the memo is outside it.
    expect(amount(result.thirdPartyPaid)).toBe('80');
    expect(amount(result.totalSpending)).toBe('51');
  });
});
