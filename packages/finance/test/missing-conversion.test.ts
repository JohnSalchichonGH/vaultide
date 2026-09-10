import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate } from '../src/dates/plain-date';
import type { FxRateRecord } from '../src/fx/index';
import { currencyCode, type CurrencyCode } from '../src/money/types';
import { fxTable, monthEnd, position, rate } from './helpers/records';
import {
  conversionObservations,
  DuplicateBucketObservationError,
  ISSUE_CLASS,
  isMissingConversionDestination,
  isMissingConversionSource,
  isWithinConversionBand,
  MISSING_CONVERSION_HEADROOM,
  possibleMissingConversionIssue,
  reconcileCompletedMonth,
  withPossibleMissingConversion,
  type CashAccountInput,
  type ConversionCandidate,
  type Issue,
  type MissingConversionObservation,
  type MonthReconciliation,
  type ReconciliationStatus,
} from '../src/reconciliation/index';

/**
 * `possible_missing_conversion` (blueprint 8.5, 30.15 items 6–9, 30.17 item 7).
 *
 * The goldens are the blueprint's sentences as numbers: a negative residual is
 * the destination and its `X` is the engine's own `unexplained_inflow` amount;
 * a reliable or estimated bucket with a positive residual is a source and no
 * other status is; the band is `X2 ≤ U2 ≤ 1.05 × X2` on exact Decimals with a
 * floor and five per cent of headroom; the rate is the completed month's
 * average — one observation is an average, none is unavailable, and nothing
 * outside the month stands in; candidates are ordered by currency code; and
 * the advisory is metadata beside the figures, never a change to them.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const GBP = currencyCode('GBP');
const CHF = currencyCode('CHF');
const NOVEMBER = monthKeyOf(2026, 11);
const TODAY = '2026-12-01';
const END = '2026-11-30';

const observe = (
  currency: CurrencyCode,
  status: ReconciliationStatus,
  unclassified?: string,
): MissingConversionObservation => ({
  currency,
  status,
  ...(unclassified === undefined ? {} : { unclassified: new Decimal(unclassified) }),
});

/** A destination: the engine gives a negative residual the `unresolved` status. */
const destination = (unclassified: string, currency = EUR) => observe(currency, 'unresolved', unclassified);
const source = (currency: CurrencyCode, unclassified: string, status: ReconciliationStatus = 'reliable') =>
  observe(currency, status, unclassified);

/** EUR → USD 1.08 on the 10th and 1.10 on the 20th: November's average is 1.09. */
const NOVEMBER_USD: FxRateRecord[] = [rate('USD', '2026-11-10', '1.08'), rate('USD', '2026-11-20', '1.10')];
/** One observation each: GBP 0.85, CHF 0.95. */
const NOVEMBER_OTHERS: FxRateRecord[] = [rate('GBP', '2026-11-16', '0.85'), rate('CHF', '2026-11-16', '0.95')];

const issueFor = (
  target: MissingConversionObservation,
  peers: readonly MissingConversionObservation[],
  rows: readonly FxRateRecord[] = NOVEMBER_USD,
): Issue | undefined => possibleMissingConversionIssue(NOVEMBER, target, peers, fxTable(rows, TODAY));

/** A candidate with its Decimals as plain strings, for whole-object comparison. */
const plain = (candidate: ConversionCandidate) => ({
  sourceCurrency: candidate.sourceCurrency,
  destinationCurrency: candidate.destinationCurrency,
  sourceAmount: candidate.sourceAmount.toFixed(),
  destinationAmount: candidate.destinationAmount.toFixed(),
  comparisonAmount: candidate.comparisonAmount.toFixed(),
  rate: candidate.rate.toFixed(),
  rateDate: candidate.rateDate,
  rateSource: candidate.rateSource,
});

const codesOf = (issue: Issue | undefined): string[] =>
  (issue?.candidates ?? []).map((candidate) => candidate.sourceCurrency);

const STATUSES: ReconciliationStatus[] = ['reliable', 'estimated', 'unresolved', 'unavailable', 'provisional'];

describe('eligibility', () => {
  it('makes a destination of an unresolved bucket with a computed residual below zero, and of nothing else', () => {
    for (const status of STATUSES) {
      // A negative residual is `unexplained_inflow`, and that blocking issue is
      // what makes a completed bucket `unresolved`: any other status beside a
      // negative residual is a fabricated observation, not a destination.
      expect(isMissingConversionDestination(observe(EUR, status, '-0.01'))).toBe(status === 'unresolved');
      expect(isMissingConversionDestination(observe(EUR, status, '0'))).toBe(false);
      expect(isMissingConversionDestination(observe(EUR, status, '5'))).toBe(false);
      expect(isMissingConversionDestination(observe(EUR, status))).toBe(false);
    }
    // A negative zero is a bucket that reconciled, not one that gained cash.
    expect(isMissingConversionDestination(observe(EUR, 'unresolved', '-0'))).toBe(false);
  });

  it('makes a source of a reliable or estimated bucket with a residual above zero, and of nothing else', () => {
    for (const status of STATUSES) {
      const may = status === 'reliable' || status === 'estimated';
      expect(isMissingConversionSource(observe(USD, status, '0.01'))).toBe(may);
      expect(isMissingConversionSource(observe(USD, status, '0'))).toBe(false);
      expect(isMissingConversionSource(observe(USD, status, '-5'))).toBe(false);
      expect(isMissingConversionSource(observe(USD, status))).toBe(false);
    }
  });

  it('bounds the band at X2 below and 1.05 × X2 above, both inclusive, on exact Decimals', () => {
    const x2 = new Decimal('1090');
    expect(MISSING_CONVERSION_HEADROOM.toFixed()).toBe('1.05');
    expect(isWithinConversionBand(new Decimal('1090'), x2)).toBe(true);
    expect(isWithinConversionBand(new Decimal('1089.99999999'), x2)).toBe(false);
    expect(isWithinConversionBand(new Decimal('1144.5'), x2)).toBe(true);
    expect(isWithinConversionBand(new Decimal('1144.50000001'), x2)).toBe(false);
    // Beyond cents: the comparison is on the amounts as they are.
    const fine = new Decimal('0.0109');
    expect(isWithinConversionBand(new Decimal('0.0109'), fine)).toBe(true);
    expect(isWithinConversionBand(new Decimal('0.01089999'), fine)).toBe(false);
    expect(isWithinConversionBand(new Decimal('0.011445'), fine)).toBe(true);
    expect(isWithinConversionBand(new Decimal('0.01144501'), fine)).toBe(false);
  });
});

describe('G1 — the signature', () => {
  it('names the destination, its inflow and one candidate with the figures a transfer needs', () => {
    const issue = issueFor(destination('-1000'), [source(USD, '1100')]);
    expect(issue).toBeDefined();
    expect(issue?.key).toBe('possible_missing_conversion');
    expect(issue?.class).toBe('advisory');
    expect(ISSUE_CLASS.possible_missing_conversion).toBe('advisory');
    expect(issue?.currency).toBe('EUR');
    // `X = −unclassified`, the unexplained inflow itself.
    expect(issue?.amount?.toFixed()).toBe('1000');
    expect(issue?.candidates?.map(plain)).toEqual([
      {
        sourceCurrency: 'USD',
        destinationCurrency: 'EUR',
        sourceAmount: '1100',
        destinationAmount: '1000',
        comparisonAmount: '1090',
        rate: '1.09',
        rateDate: END,
        rateSource: 'ecb',
      },
    ]);
  });

  it('carries exactly those fields on a candidate — and no approximate flag (30.17 item 7)', () => {
    const [candidate] = issueFor(destination('-1000'), [source(USD, '1100')])?.candidates ?? [];
    expect(Object.keys(candidate ?? {}).sort()).toEqual([
      'comparisonAmount',
      'destinationAmount',
      'destinationCurrency',
      'rate',
      'rateDate',
      'rateSource',
      'sourceAmount',
      'sourceCurrency',
    ]);
  });
});

describe('G2 — the band, exactly', () => {
  const at = (sourceAmount: string) => issueFor(destination('-1000'), [source(USD, sourceAmount)]);

  it('admits U2 = X2 and refuses one hundred-millionth below', () => {
    expect(codesOf(at('1090'))).toEqual(['USD']);
    expect(at('1089.99999999')).toBeUndefined();
  });

  it('admits U2 = 1.05 × X2 and refuses one hundred-millionth above', () => {
    expect(codesOf(at('1144.5'))).toEqual(['USD']);
    expect(at('1144.50000001')).toBeUndefined();
  });

  it('is a floor with headroom, not a symmetric band: 5 % below X2 never qualifies', () => {
    expect(at('1035.5')).toBeUndefined();
    expect(at('1089')).toBeUndefined();
  });

  it('compares at the residuals’ own precision, not the currency’s', () => {
    // X = 0.01 at 1.09 is X2 = 0.0109, which no cent can state.
    const tiny = (sourceAmount: string) => issueFor(destination('-0.01'), [source(USD, sourceAmount)]);
    expect(tiny('0.0109')?.candidates?.[0]?.comparisonAmount.toFixed()).toBe('0.0109');
    expect(tiny('0.01089999')).toBeUndefined();
    expect(tiny('0.011445')).toBeDefined();
    expect(tiny('0.01144501')).toBeUndefined();
  });
});

describe('G3 — the month’s average, not a dated rate', () => {
  it('values X at the mean of the month’s observations even when the month-end rate says otherwise', () => {
    // 1.00 on the 3rd and 1.20 on the 27th: the average is 1.10, the rate a
    // dated lookup at the month end would find is 1.20. At 1.20, X2 would be
    // 1200 and a U2 of 1100 would sit below the floor.
    const rows = [rate('USD', '2026-11-03', '1.00'), rate('USD', '2026-11-27', '1.20')];
    const issue = issueFor(destination('-1000'), [source(USD, '1100')], rows);
    expect(issue?.candidates?.map(plain)).toEqual([
      expect.objectContaining({ comparisonAmount: '1100', rate: '1.1', rateDate: END }),
    ]);
  });
});

describe('G4 — one observation is an average; none is unavailable (30.17)', () => {
  it('averages a single in-month observation, on whichever day it falls', () => {
    for (const day of ['2026-11-01', '2026-11-16', '2026-11-30']) {
      const issue = issueFor(destination('-1000'), [source(USD, '1100')], [rate('USD', day, '1.09')]);
      expect(issue?.candidates?.map(plain)).toEqual([
        expect.objectContaining({ comparisonAmount: '1090', rate: '1.09', rateDate: END }),
      ]);
    }
  });

  it('lets no rate from outside the month stand in, however close', () => {
    // The day before and the day after November, at a rate that would qualify.
    const outside = [rate('USD', '2026-10-31', '1.09'), rate('USD', '2026-12-01', '1.09')];
    expect(issueFor(destination('-1000'), [source(USD, '1100')], outside)).toBeUndefined();
    expect(issueFor(destination('-1000'), [source(USD, '1100')], [])).toBeUndefined();
  });

  it('removes only the source whose rate is unavailable', () => {
    // USD has November evidence, GBP has none: one candidate, not zero.
    const issue = issueFor(destination('-1000'), [source(GBP, '860'), source(USD, '1100')]);
    expect(codesOf(issue)).toEqual(['USD']);
  });
});

describe('G5 — two foreign legs', () => {
  it('derives the cross rate through the pivot and values X in the source currency', () => {
    // USD → GBP at 0.85 / 1.09; X = 1000 USD is X2 = 779.816… GBP, and a GBP
    // residual of 800 sits inside [X2, 1.05 × X2].
    const rows = [...NOVEMBER_USD, ...NOVEMBER_OTHERS];
    const issue = issueFor(destination('-1000', USD), [source(GBP, '800')], rows);
    const crossRate = new Decimal('0.85').dividedBy('1.09');
    const [candidate] = issue?.candidates ?? [];
    expect(candidate?.sourceCurrency).toBe('GBP');
    expect(candidate?.destinationCurrency).toBe('USD');
    expect(candidate?.rate.equals(crossRate)).toBe(true);
    expect(candidate?.comparisonAmount.equals(new Decimal('1000').times(crossRate))).toBe(true);
    expect(candidate?.sourceAmount.toFixed()).toBe('800');
    expect(candidate?.destinationAmount.toFixed()).toBe('1000');
    expect(candidate?.rateDate).toBe(END);
    expect(candidate?.rateSource).toBe('ecb');
  });
});

describe('G6 — several sources, in currency-code order', () => {
  const rows = [...NOVEMBER_USD, ...NOVEMBER_OTHERS];
  // X2: USD 1090, GBP 850, CHF 950. Residuals inside each band.
  const qualifying = [source(USD, '1100'), source(GBP, '860'), source(CHF, '990')];

  it('lists every qualifying source once, ascending by code, whatever order they came in', () => {
    const forward = issueFor(destination('-1000'), qualifying, rows);
    const backward = issueFor(destination('-1000'), [...qualifying].reverse(), rows);
    expect(codesOf(forward)).toEqual(['CHF', 'GBP', 'USD']);
    expect(backward?.candidates?.map(plain)).toEqual(forward?.candidates?.map(plain));
  });

  it('drops a source outside its own band and keeps the others', () => {
    const peers = [source(USD, '1100'), source(GBP, '900'), source(CHF, '990')];
    expect(codesOf(issueFor(destination('-1000'), peers, rows))).toEqual(['CHF', 'USD']);
  });
});

describe('G7 — sources that cannot qualify', () => {
  it('ignores a bucket in the destination’s own currency', () => {
    expect(issueFor(destination('-1000'), [source(EUR, '1000')])).toBeUndefined();
    expect(codesOf(issueFor(destination('-1000'), [source(EUR, '1000'), source(USD, '1100')]))).toEqual(['USD']);
  });

  it('admits an estimated source on the same terms as a reliable one', () => {
    const reliable = issueFor(destination('-1000'), [source(USD, '1100', 'reliable')]);
    const estimated = issueFor(destination('-1000'), [source(USD, '1100', 'estimated')]);
    expect(estimated?.candidates?.map(plain)).toEqual(reliable?.candidates?.map(plain));
  });

  it('never reads an unresolved, unavailable or provisional bucket, whatever number it carries', () => {
    for (const status of ['unresolved', 'unavailable', 'provisional'] as const) {
      expect(issueFor(destination('-1000'), [source(USD, '1100', status)])).toBeUndefined();
    }
  });

  it('never reads a source with a residual of zero or below', () => {
    expect(issueFor(destination('-1000'), [source(USD, '0')])).toBeUndefined();
    expect(issueFor(destination('-1000'), [source(USD, '-1100')])).toBeUndefined();
    expect(issueFor(destination('-1000'), [observe(USD, 'reliable')])).toBeUndefined();
  });
});

describe('G8 — no candidate, no advisory', () => {
  it('raises nothing when no source lands in its band', () => {
    expect(issueFor(destination('-1000'), [source(USD, '2000'), source(GBP, '5')], [...NOVEMBER_USD, ...NOVEMBER_OTHERS])).toBeUndefined();
  });

  it('raises nothing for a bucket that is not a destination, however perfect the sources', () => {
    for (const target of [observe(EUR, 'reliable', '0'), observe(EUR, 'reliable', '1000'), observe(EUR, 'unavailable')]) {
      expect(issueFor(target, [source(USD, '1100')])).toBeUndefined();
    }
  });
});

describe('G9 — input contract', () => {
  it('refuses two peers in one currency', () => {
    expect(() => issueFor(destination('-1000'), [source(USD, '1100'), source(USD, '5')])).toThrow(
      DuplicateBucketObservationError,
    );
  });

  it('does not depend on the order peers arrive in', () => {
    const peers = [source(USD, '1100'), source(GBP, '860'), observe(CHF, 'unavailable'), source(EUR, '3')];
    const rows = [...NOVEMBER_USD, ...NOVEMBER_OTHERS];
    const forward = issueFor(destination('-1000'), peers, rows);
    const backward = issueFor(destination('-1000'), [...peers].reverse(), rows);
    expect(backward?.candidates?.map(plain)).toEqual(forward?.candidates?.map(plain));
    expect(codesOf(forward)).toEqual(['GBP', 'USD']);
  });
});

/* -------------------------------------------------------------------------- */
/* Real reconciled months                                                     */
/* -------------------------------------------------------------------------- */

const account = (id: string, currency: string, opening: string, closing: string): CashAccountInput => ({
  position: position(id, { id, currency }),
  valuations: [monthEnd(id, '2026-10-31', opening), monthEnd(id, END, closing)],
  accountType: 'checking',
});

const november = (accounts: readonly CashAccountInput[]): MonthReconciliation =>
  reconcileCompletedMonth({
    month: NOVEMBER,
    today: plainDate(TODAY),
    cashAccounts: accounts,
    income: [],
    expenses: [],
    transfers: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
  });

const bucketOf = (reconciliation: MonthReconciliation, currency: string) => {
  const bucket = reconciliation.buckets.find((b) => b.currency === currency);
  if (bucket === undefined) throw new Error(`no ${currency} bucket`);
  return bucket;
};

describe('G10 — several destination buckets, each with its own advisory', () => {
  it('evaluates every destination against every other bucket independently', () => {
    // EUR gained 1000 and GBP gained 500 unexplained; USD lost 1100 and CHF
    // 570. At USD 1.09, GBP 0.85, CHF 0.95: EUR → USD is 1090 (USD's 1100
    // qualifies), EUR → CHF is 950 (CHF's 570 does not); GBP → CHF is 558.82…
    // (CHF's 570 qualifies), GBP → USD is 641.17… (USD's 1100 does not).
    const month = november([
      account('eur', 'EUR', '1000', '2000'),
      account('gbp', 'GBP', '1000', '1500'),
      account('usd', 'USD', '10000', '8900'),
      account('chf', 'CHF', '5000', '4430'),
    ]);
    const enriched = withPossibleMissingConversion(month, fxTable([...NOVEMBER_USD, ...NOVEMBER_OTHERS], TODAY));

    const advisory = (currency: string) =>
      bucketOf(enriched, currency).issues.find((issue) => issue.key === 'possible_missing_conversion');
    expect(codesOf(advisory('EUR'))).toEqual(['USD']);
    expect(codesOf(advisory('GBP'))).toEqual(['CHF']);
    expect(advisory('USD')).toBeUndefined();
    expect(advisory('CHF')).toBeUndefined();
    expect(advisory('GBP')?.amount?.toFixed()).toBe('500');
  });
});

describe('enriching a reconciled month', () => {
  const signature = () => november([account('eur', 'EUR', '1000', '2000'), account('usd', 'USD', '10000', '8900')]);
  const table = () => fxTable(NOVEMBER_USD, TODAY);

  it('appends the advisory after the engine’s own issues, with X as the unexplained inflow, and changes nothing else', () => {
    const before = signature();
    const after = withPossibleMissingConversion(before, table());

    const eur = bucketOf(after, 'EUR');
    const original = bucketOf(before, 'EUR');
    expect(eur.issues.map((issue) => issue.key)).toEqual(['unexplained_inflow', 'possible_missing_conversion']);
    const [inflow, advisory] = eur.issues;
    expect(advisory?.amount?.equals(inflow?.amount ?? new Decimal(-1))).toBe(true);
    expect(advisory?.candidates?.map(plain)).toEqual([
      expect.objectContaining({ sourceAmount: '1100', destinationAmount: '1000', comparisonAmount: '1090' }),
    ]);

    // Everything but the appended issue is the engine's, unchanged; and the
    // source bucket is exactly what it was.
    expect({ ...eur, issues: eur.issues.slice(0, -1) }).toEqual(original);
    expect(bucketOf(after, 'USD')).toEqual(bucketOf(before, 'USD'));
    expect(after.monthStatus).toBe(before.monthStatus);
    expect(after.monthStatus).toBe('unresolved');
    expect(eur.status).toBe('unresolved');
    expect(eur.totals.unclassified?.toFixed()).toBe('-1000');
  });

  it('raises it once, however many times the month passes through', () => {
    const twice = withPossibleMissingConversion(withPossibleMissingConversion(signature(), table()), table());
    expect(bucketOf(twice, 'EUR').issues.filter((issue) => issue.key === 'possible_missing_conversion')).toHaveLength(1);
  });

  it('leaves a month alone when no source lands in the band', () => {
    const before = november([account('eur', 'EUR', '1000', '2000'), account('usd', 'USD', '10000', '8000')]);
    expect(withPossibleMissingConversion(before, table())).toEqual(before);
    expect(bucketOf(before, 'EUR').issues.map((issue) => issue.key)).toEqual(['unexplained_inflow']);
  });

  it('leaves a month alone when the month has no rate observation', () => {
    const before = signature();
    expect(withPossibleMissingConversion(before, fxTable([], TODAY))).toEqual(before);
  });

  it('reads the month’s own buckets as observations', () => {
    expect(conversionObservations(signature())).toEqual([
      { currency: 'EUR', status: 'unresolved', unclassified: new Decimal('-1000') },
      { currency: 'USD', status: 'reliable', unclassified: new Decimal('1100') },
    ]);
  });

  it('reads a bucket that never reached the identity as one with no residual, and never as a candidate', () => {
    // Pounds with no November statement: the GBP bucket is unavailable and
    // has no residual to be a destination or a source with (30.12).
    const pounds: CashAccountInput = {
      position: position('gbp', { id: 'gbp', currency: 'GBP' }),
      valuations: [monthEnd('gbp', '2026-10-31', '1000')],
      accountType: 'checking',
    };
    const before = november([account('eur', 'EUR', '1000', '2000'), account('usd', 'USD', '10000', '8900'), pounds]);
    expect(conversionObservations(before)).toEqual([
      { currency: 'EUR', status: 'unresolved', unclassified: new Decimal('-1000') },
      { currency: 'GBP', status: 'unavailable' },
      { currency: 'USD', status: 'reliable', unclassified: new Decimal('1100') },
    ]);

    const after = withPossibleMissingConversion(before, fxTable([...NOVEMBER_USD, ...NOVEMBER_OTHERS], TODAY));
    expect(codesOf(bucketOf(after, 'EUR').issues.find((issue) => issue.key === 'possible_missing_conversion'))).toEqual(['USD']);
    expect(bucketOf(after, 'GBP')).toEqual(bucketOf(before, 'GBP'));
    expect(after.monthStatus).toBe('unavailable');
  });
});
