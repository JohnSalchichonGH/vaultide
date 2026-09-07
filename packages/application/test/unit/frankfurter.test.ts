import { describe, expect, it } from 'vitest';
import {
  createFrankfurterProvider,
  FRANKFURTER_BASE_URL,
  FRANKFURTER_PROVIDER_CHAIN,
  NON_MONETARY_ISO_CODES,
} from '../../src/fx/frankfurter';
import { FxProviderError } from '../../src/fx/provider';

/**
 * The Frankfurter **v2** adapter (blueprint 10.1, 10.5, 21.3).
 *
 * The bodies below are recorded from the live v2 API on 2026-09-07, trimmed to
 * the rows each case needs. Keeping them as fixtures is deliberate: what this
 * suite proves — how a response is attributed, which codes are eligible, which
 * rates are refused, and that digits survive — must hold identically on a
 * runner with no network. The live universe is checked separately, weekly, by
 * `pnpm db:verify-currencies`.
 */

/** `GET /v2/currencies`, trimmed. Shows all three exclusion cases. */
const CURRENCIES = JSON.stringify([
  { iso_code: 'EUR', iso_numeric: '978', name: 'Euro' },
  { iso_code: 'USD', iso_numeric: '840', name: 'United States Dollar' },
  { iso_code: 'AED', iso_numeric: '784', name: 'United Arab Emirates Dirham' },
  { iso_code: 'RUB', iso_numeric: '643', name: 'Russian Ruble' },
  // ISO 4217 lists these, and v2 quotes them, but they are not money.
  { iso_code: 'XAU', iso_numeric: '959', name: 'Gold (Troy Ounce)' },
  { iso_code: 'XDR', iso_numeric: '960', name: 'Special Drawing Rights' },
  // Local issues and a market variant, with no ISO numeric code at all.
  { iso_code: 'CNH', iso_numeric: '', name: 'Chinese Renminbi Yuan Offshore' },
  { iso_code: 'JEP', iso_numeric: '', name: 'Jersey Pound' },
]);

interface Recorded {
  readonly urls: string[];
  readonly fetchImpl: typeof fetch;
}

/** A fetch that answers from a URL-substring → body map and records every call. */
function recorded(routes: readonly [RegExp, string][]): Recorded {
  const urls: string[] = [];
  const fetchImpl = ((input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const match = routes.find(([pattern]) => pattern.test(url));
    if (match === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(match[1], { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  return { urls, fetchImpl };
}

const rates = (rows: { date: string; quote: string; rate: string }[]): string =>
  `[${rows.map((r) => `{"date":"${r.date}","base":"EUR","quote":"${r.quote}","rate":${r.rate}}`).join(',')}]`;

describe('it addresses v2, not the frozen v1 API', () => {
  it('defaults to the /v2 base path', () => {
    expect(FRANKFURTER_BASE_URL).toBe('https://api.frankfurter.dev/v2');
    expect(FRANKFURTER_BASE_URL).not.toContain('/v1');
  });

  it('identifies itself as the v2 adapter', () => {
    expect(createFrankfurterProvider().id).toBe('frankfurter-v2');
  });
});

describe('attribution', () => {
  it('asks each bank in the chain separately and never for a blend', async () => {
    const { urls, fetchImpl } = recorded([
      [/providers=ECB/u, rates([{ date: '2026-09-07', quote: 'USD', rate: '1.1622' }])],
      [/providers=BDI/u, rates([{ date: '2026-09-07', quote: 'USD', rate: '1.1624' }])],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl }).fetchTimeSeries(
      'EUR',
      ['USD'],
      '2026-09-01',
      '2026-09-07',
    );

    // One request per bank, and every one of them names its bank.
    expect(urls).toHaveLength(FRANKFURTER_PROVIDER_CHAIN.length);
    expect(urls.every((url) => /[?&]providers=/u.test(url))).toBe(true);
    // A request without `providers` would return v2's blended consensus, which
    // has no publisher — and 10.1 requires `source` to name one.
    expect(urls.some((url) => /\/rates\?(?!.*providers=)/u.test(url))).toBe(false);

    // Two banks, two rows, same pair and date, different source and rate.
    expect(rows).toEqual([
      { quote: 'USD', rateDate: '2026-09-07', rate: '1.1622', source: 'ecb' },
      { quote: 'USD', rateDate: '2026-09-07', rate: '1.1624', source: 'bdi' },
    ]);
  });

  it('names the bank, never the redistributor', async () => {
    const { fetchImpl } = recorded([
      [/providers=ECB/u, rates([{ date: '2026-09-07', quote: 'USD', rate: '1.1622' }])],
      [/providers=BDI/u, '[]'],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['USD']);

    expect(rows.map((row) => row.source)).toEqual(['ecb']);
    expect(rows.every((row) => row.source !== 'frankfurter')).toBe(true);
  });

  it('puts the chain in preference order, ECB first', () => {
    expect([...FRANKFURTER_PROVIDER_CHAIN]).toEqual(['ECB', 'BDI']);
  });

  it('honours a chain given explicitly', async () => {
    const { urls, fetchImpl } = recorded([
      [/providers=CNB/u, rates([{ date: '2026-09-07', quote: 'CZK', rate: '24.331' }])],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl, providers: ['CNB'] }).fetchLatest(
      'EUR',
      ['CZK'],
    );

    expect(urls).toHaveLength(1);
    expect(rows).toEqual([
      { quote: 'CZK', rateDate: '2026-09-07', rate: '24.331', source: 'cnb' },
    ]);
  });
});

describe('exact decimals', () => {
  it('keeps the publisher’s own digits, never a float', async () => {
    // Twelve decimals: `NUMERIC(24,12)` can hold this and a float64 cannot
    // reproduce it, so a `JSON.parse` that yielded a number would show here.
    const { fetchImpl } = recorded([
      [/providers=ECB/u, rates([{ date: '2026-09-07', quote: 'USD', rate: '1.162200000001' }])],
      [/providers=BDI/u, '[]'],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['USD']);

    expect(rows[0]?.rate).toBe('1.162200000001');
    expect(typeof rows[0]?.rate).toBe('string');
  });

  it('keeps a trailing zero the publisher wrote', async () => {
    const { fetchImpl } = recorded([
      [/providers=ECB/u, rates([{ date: '2026-09-07', quote: 'JPY', rate: '181.590' }])],
      [/providers=BDI/u, '[]'],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['JPY']);
    // `Number('181.590')` is 181.59; the literal says the publisher wrote three
    // decimals, and that is what a reproducible historical rate needs.
    expect(rows[0]?.rate).toBe('181.590');
  });
});

describe('what it refuses (10.5)', () => {
  it('rejects a non-positive or implausible rate, with a reason', async () => {
    const refused: string[] = [];
    const { fetchImpl } = recorded([
      [
        /providers=ECB/u,
        rates([
          { date: '2026-09-07', quote: 'USD', rate: '0' },
          { date: '2026-09-07', quote: 'GBP', rate: '99999999' },
          { date: '2026-09-07', quote: 'CHF', rate: '0.9312' },
        ]),
      ],
      [/providers=BDI/u, '[]'],
    ]);

    const rows = await createFrankfurterProvider({
      fetchImpl,
      onRejected: (reason) => refused.push(reason),
    }).fetchLatest('EUR', ['USD', 'GBP', 'CHF']);

    expect(rows.map((row) => row.quote)).toEqual(['CHF']);
    expect(refused).toHaveLength(2);
    expect(refused.join(' ')).toContain('not positive');
    expect(refused.join(' ')).toContain('above 1000000');
    // A reason names a currency and a date, never a rate (18.2).
    expect(refused.join(' ')).not.toContain('99999999');
  });

  it('never stores the pivot against itself', async () => {
    const { urls, fetchImpl } = recorded([
      [
        /providers=ECB/u,
        rates([
          { date: '2026-09-07', quote: 'EUR', rate: '1' },
          { date: '2026-09-07', quote: 'USD', rate: '1.1622' },
        ]),
      ],
      [/providers=BDI/u, '[]'],
    ]);

    const rows = await createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['EUR', 'USD']);

    expect(rows.map((row) => row.quote)).toEqual(['USD']);
    // Nor does it ask for it: EUR is 1 by definition (10.1).
    expect(urls.every((url) => !/quotes=[^&]*EUR/u.test(url))).toBe(true);
  });

  it('turns a provider error into an FxProviderError carrying the status', async () => {
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(new Response('nope', { status: 503 }))) as typeof fetch;

    await expect(
      createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['USD']),
    ).rejects.toBeInstanceOf(FxProviderError);
  });

  it('turns an unreachable provider into the same error, with no status', async () => {
    const fetchImpl = ((): Promise<Response> =>
      Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;

    await expect(
      createFrankfurterProvider({ fetchImpl }).fetchLatest('EUR', ['USD']),
    ).rejects.toMatchObject({ code: 'FX_PROVIDER_FAILURE', status: undefined });
  });
});

describe('the supported universe', () => {
  const catalogue: [RegExp, string][] = [
    [/\/currencies/u, CURRENCIES],
    [
      /providers=ECB/u,
      rates([{ date: '2026-09-07', quote: 'USD', rate: '1.1622' }]),
    ],
    [
      /providers=BDI/u,
      rates([
        { date: '2026-09-07', quote: 'USD', rate: '1.1624' },
        { date: '2026-09-07', quote: 'AED', rate: '4.2682' },
        // v2 quotes these; none of them is a currency somebody banks in.
        { date: '2026-09-07', quote: 'XAU', rate: '0.00028' },
        { date: '2026-09-07', quote: 'XDR', rate: '0.8501' },
        { date: '2026-09-07', quote: 'CNH', rate: '8.2716' },
        { date: '2026-09-07', quote: 'JEP', rate: '0.8589' },
      ]),
    ],
  ];

  it('is the union of what the chain publishes, restricted to money', async () => {
    const { fetchImpl } = recorded(catalogue);
    const codes = await createFrankfurterProvider({ fetchImpl }).supportedCurrencies();

    // EUR because it is the pivot, USD and AED because a bank published them.
    expect(codes).toEqual(['AED', 'EUR', 'USD']);
  });

  it('excludes the metals and the IMF unit of account', async () => {
    const { fetchImpl } = recorded(catalogue);
    const codes = await createFrankfurterProvider({ fetchImpl }).supportedCurrencies();

    for (const code of NON_MONETARY_ISO_CODES) expect(codes).not.toContain(code);
    expect([...NON_MONETARY_ISO_CODES].sort()).toEqual(['XAG', 'XAU', 'XDR', 'XPD', 'XPT']);
  });

  it('excludes codes with no ISO numeric, which are not currencies', async () => {
    const { fetchImpl } = recorded(catalogue);
    const codes = await createFrankfurterProvider({ fetchImpl }).supportedCurrencies();

    // A market variant of CNY and a local sterling issue. Both are quoted by
    // v2 and neither is a currency of its own.
    expect(codes).not.toContain('CNH');
    expect(codes).not.toContain('JEP');
  });

  it('excludes a currency with history but no current publication', async () => {
    const { fetchImpl } = recorded(catalogue);
    const codes = await createFrankfurterProvider({ fetchImpl }).supportedCurrencies();

    // RUB is in v2's current catalogue, and the chain publishes nothing for it.
    // A currency with no rate cannot be a reporting currency (10.5).
    expect(codes).not.toContain('RUB');
  });

  it('always contains the pivot, even if no bank answered', async () => {
    const { fetchImpl } = recorded([
      [/\/currencies/u, CURRENCIES],
      [/providers=/u, '[]'],
    ]);
    const codes = await createFrankfurterProvider({ fetchImpl }).supportedCurrencies();
    expect(codes).toEqual(['EUR']);
  });
});
