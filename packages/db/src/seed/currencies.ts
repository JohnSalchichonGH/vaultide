/**
 * Currency seed (blueprint 6.2, Phase 0).
 *
 * Fiat / official ISO 4217 currencies only — no crypto (R28, D35). Every row
 * carries the currency's real minor units, which drive input validation and
 * exact display: 0 for JPY and ISK, 2 for most, 3 for the Gulf dinars, and 4
 * for CLF and UYW. Nothing here assumes "fiat means at most three decimals".
 *
 * `isFxSupported` marks the currencies the FX provider publishes reference
 * rates for (the ECB set exposed by Frankfurter). The remaining rows exist so
 * amounts in those currencies are still validated and formatted correctly;
 * Phase 1 reconciles the flag with the provider's own list at refresh time.
 */
export interface CurrencySeedRow {
  readonly code: string;
  readonly name: string;
  readonly minorUnits: number;
  readonly isFxSupported: boolean;
}

/** Currencies with daily ECB reference rates through the FX provider. */
const FX_SUPPORTED: readonly [string, string, number][] = [
  ['EUR', 'Euro', 2],
  ['AUD', 'Australian Dollar', 2],
  ['BGN', 'Bulgarian Lev', 2],
  ['BRL', 'Brazilian Real', 2],
  ['CAD', 'Canadian Dollar', 2],
  ['CHF', 'Swiss Franc', 2],
  ['CNY', 'Chinese Yuan Renminbi', 2],
  ['CZK', 'Czech Koruna', 2],
  ['DKK', 'Danish Krone', 2],
  ['GBP', 'Pound Sterling', 2],
  ['HKD', 'Hong Kong Dollar', 2],
  ['HUF', 'Hungarian Forint', 2],
  ['IDR', 'Indonesian Rupiah', 2],
  ['ILS', 'Israeli New Shekel', 2],
  ['INR', 'Indian Rupee', 2],
  ['ISK', 'Icelandic Krona', 0],
  ['JPY', 'Japanese Yen', 0],
  ['KRW', 'South Korean Won', 0],
  ['MXN', 'Mexican Peso', 2],
  ['MYR', 'Malaysian Ringgit', 2],
  ['NOK', 'Norwegian Krone', 2],
  ['NZD', 'New Zealand Dollar', 2],
  ['PHP', 'Philippine Peso', 2],
  ['PLN', 'Polish Zloty', 2],
  ['RON', 'Romanian Leu', 2],
  ['SEK', 'Swedish Krona', 2],
  ['SGD', 'Singapore Dollar', 2],
  ['THB', 'Thai Baht', 2],
  ['TRY', 'Turkish Lira', 2],
  ['USD', 'US Dollar', 2],
  ['ZAR', 'South African Rand', 2],
];

/**
 * Further official currencies, kept for correct validation and formatting.
 * The four-decimal units (CLF, UYW) and the three-decimal dinars are the
 * reason the schema allows 0..8 minor units rather than 0..3.
 */
const OTHER_OFFICIAL: readonly [string, string, number][] = [
  ['AED', 'UAE Dirham', 2],
  ['ARS', 'Argentine Peso', 2],
  ['BHD', 'Bahraini Dinar', 3],
  ['BIF', 'Burundi Franc', 0],
  ['CLF', 'Chilean Unidad de Fomento', 4],
  ['CLP', 'Chilean Peso', 0],
  ['COP', 'Colombian Peso', 2],
  ['CRC', 'Costa Rican Colon', 2],
  ['DJF', 'Djibouti Franc', 0],
  ['DOP', 'Dominican Peso', 2],
  ['EGP', 'Egyptian Pound', 2],
  ['GEL', 'Georgian Lari', 2],
  ['GNF', 'Guinean Franc', 0],
  ['IQD', 'Iraqi Dinar', 3],
  ['JOD', 'Jordanian Dinar', 3],
  ['KES', 'Kenyan Shilling', 2],
  ['KMF', 'Comorian Franc', 0],
  ['KWD', 'Kuwaiti Dinar', 3],
  ['LYD', 'Libyan Dinar', 3],
  ['MAD', 'Moroccan Dirham', 2],
  ['NGN', 'Nigerian Naira', 2],
  ['OMR', 'Rial Omani', 3],
  ['PEN', 'Peruvian Sol', 2],
  ['PYG', 'Paraguayan Guarani', 0],
  ['QAR', 'Qatari Rial', 2],
  ['RSD', 'Serbian Dinar', 2],
  ['RWF', 'Rwanda Franc', 0],
  ['SAR', 'Saudi Riyal', 2],
  ['TND', 'Tunisian Dinar', 3],
  ['TWD', 'New Taiwan Dollar', 2],
  ['UAH', 'Ukrainian Hryvnia', 2],
  ['UGX', 'Uganda Shilling', 0],
  ['UYU', 'Uruguayan Peso', 2],
  ['UYW', 'Uruguayan Unidad Previsional', 4],
  ['VND', 'Vietnamese Dong', 0],
  ['VUV', 'Vanuatu Vatu', 0],
  ['XAF', 'CFA Franc BEAC', 0],
  ['XOF', 'CFA Franc BCEAO', 0],
  ['XPF', 'CFP Franc', 0],
];

export const currencySeed: readonly CurrencySeedRow[] = [
  ...FX_SUPPORTED.map(([code, name, minorUnits]) => ({
    code,
    name,
    minorUnits,
    isFxSupported: true,
  })),
  ...OTHER_OFFICIAL.map(([code, name, minorUnits]) => ({
    code,
    name,
    minorUnits,
    isFxSupported: false,
  })),
].sort((a, b) => a.code.localeCompare(b.code));
