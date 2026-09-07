/**
 * Currency seed (blueprint 6.2, 10.1, 10.4).
 *
 * Fiat / official ISO 4217 currencies only — no crypto and no commodities
 * (R28, D35). Every row carries the currency's **ISO 4217** minor units, which
 * drive input validation and exact display: 0 for JPY and ISK, 2 for most, 3
 * for the Gulf dinars and the Iraqi dinar, and 4 for CLF and UYW. Nothing here
 * assumes "fiat means at most two decimals".
 *
 * ## What `isFxSupported` means
 *
 * **Convertible automatically by Vaultide's approved FX source chain** — not
 * "exists somewhere in Frankfurter v2". The two are different sets, and the
 * flag is about the narrower one.
 *
 * Rates come from Frankfurter **v2** (`api.frankfurter.dev/v2`; `/v1` is
 * frozen and unused), which aggregates 84 central banks and 165 current
 * currencies. Vaultide's Phase 1 policy draws from an explicit, approved chain
 * of two of them — **ECB first, Banca d'Italia second**, both EUR-pivoted and
 * both daily since 1999 — so every stored rate names the bank that published
 * it (10.1: "`source` records which central bank published each rate").
 *
 * 150 codes are convertible under that policy. Three groups are outside it:
 *
 *  - **not money.** XAU, XAG, XPT and XPD are metals and XDR is the IMF's unit
 *    of account. ISO 4217 lists all five and v2 quotes them, but nobody holds a
 *    bank account denominated in gold — the same judgement R28 makes about
 *    crypto, applied consistently.
 *  - **not ISO 4217.** v2 also quotes CNH, GGP, IMP and JEP; none has an ISO
 *    numeric code. They are a market variant of CNY and three local sterling
 *    issues, not currencies of their own.
 *  - **no current rate from the approved chain.** ANG, BYN, IRR, KPW, MRO and
 *    RUB. Frankfurter v2 *does* have current rates for several of these from
 *    other official providers — the CBR for RUB, the NBRB for BYN, among
 *    others — but those banks are not in Vaultide's approved chain, and the
 *    ECB's and Banca d'Italia's own series for these codes have ended (RUB and
 *    BYN in early 2022, ANG, IRR and KPW during 2025, MRO in 2017). So the
 *    claim is about *our* sources, never about the API's coverage.
 *
 * A current ISO 4217 currency can therefore sit in this catalogue with
 * `isFxSupported: false`. Those rows exist so amounts in them are still
 * validated and formatted correctly, but they can never be a base, reporting
 * or position currency: with no rate from a source this product trusts, there
 * is no honest conversion to offer (10.5).
 *
 * The set is **verified, not assumed**: `pnpm db:verify-currencies` compares
 * this list with what the approved chain publishes today — the policy, not
 * every Frankfurter provider — and fails on any divergence in either
 * direction. It reports; it never repairs. Adding or removing a currency, or
 * widening the chain, is a migration and a decision.
 */
export interface CurrencySeedRow {
  readonly code: string;
  readonly name: string;
  readonly minorUnits: number;
  readonly isFxSupported: boolean;
}

/**
 * Currencies the **approved chain** publishes a current rate for, verified
 * against `GET /v2/rates?base=EUR&providers=ECB` and `…&providers=BDI` on
 * 2026-09-07. Other Frankfurter providers cover more; this is the policy set.
 */
const FX_SUPPORTED: readonly [string, string, number][] = [
  ['AED', 'United Arab Emirates Dirham', 2],
  ['AFN', 'Afghan Afghani', 2],
  ['ALL', 'Albanian Lek', 2],
  ['AMD', 'Armenian Dram', 2],
  ['AOA', 'Angolan Kwanza', 2],
  ['ARS', 'Argentine Peso', 2],
  ['AUD', 'Australian Dollar', 2],
  ['AWG', 'Aruban Florin', 2],
  ['AZN', 'Azerbaijani Manat', 2],
  ['BAM', 'Bosnia and Herzegovina Convertible Mark', 2],
  ['BBD', 'Barbadian Dollar', 2],
  ['BDT', 'Bangladeshi Taka', 2],
  ['BHD', 'Bahraini Dinar', 3],
  ['BIF', 'Burundian Franc', 0],
  ['BMD', 'Bermudian Dollar', 2],
  ['BND', 'Brunei Dollar', 2],
  ['BOB', 'Bolivian Boliviano', 2],
  ['BRL', 'Brazilian Real', 2],
  ['BSD', 'Bahamian Dollar', 2],
  ['BTN', 'Bhutanese Ngultrum', 2],
  ['BWP', 'Botswana Pula', 2],
  ['BZD', 'Belize Dollar', 2],
  ['CAD', 'Canadian Dollar', 2],
  ['CDF', 'Congolese Franc', 2],
  ['CHF', 'Swiss Franc', 2],
  ['CLP', 'Chilean Peso', 0],
  ['CNY', 'Chinese Renminbi Yuan', 2],
  ['COP', 'Colombian Peso', 2],
  ['CRC', 'Costa Rican Colón', 2],
  ['CUP', 'Cuban Peso', 2],
  ['CVE', 'Cape Verdean Escudo', 2],
  ['CZK', 'Czech Koruna', 2],
  ['DJF', 'Djiboutian Franc', 0],
  ['DKK', 'Danish Krone', 2],
  ['DOP', 'Dominican Peso', 2],
  ['DZD', 'Algerian Dinar', 2],
  ['EGP', 'Egyptian Pound', 2],
  ['ERN', 'Eritrean Nakfa', 2],
  ['ETB', 'Ethiopian Birr', 2],
  ['EUR', 'Euro', 2],
  ['FJD', 'Fijian Dollar', 2],
  ['FKP', 'Falkland Pound', 2],
  ['GBP', 'British Pound', 2],
  ['GEL', 'Georgian Lari', 2],
  ['GHS', 'Ghanaian Cedi', 2],
  ['GIP', 'Gibraltar Pound', 2],
  ['GMD', 'Gambian Dalasi', 2],
  ['GNF', 'Guinean Franc', 0],
  ['GTQ', 'Guatemalan Quetzal', 2],
  ['GYD', 'Guyanese Dollar', 2],
  ['HKD', 'Hong Kong Dollar', 2],
  ['HNL', 'Honduran Lempira', 2],
  ['HTG', 'Haitian Gourde', 2],
  ['HUF', 'Hungarian Forint', 2],
  ['IDR', 'Indonesian Rupiah', 2],
  ['ILS', 'Israeli New Shekel', 2],
  ['INR', 'Indian Rupee', 2],
  ['IQD', 'Iraqi Dinar', 3],
  ['ISK', 'Icelandic Króna', 0],
  ['JMD', 'Jamaican Dollar', 2],
  ['JOD', 'Jordanian Dinar', 3],
  ['JPY', 'Japanese Yen', 0],
  ['KES', 'Kenyan Shilling', 2],
  ['KGS', 'Kyrgyzstani Som', 2],
  ['KHR', 'Cambodian Riel', 2],
  ['KMF', 'Comorian Franc', 0],
  ['KRW', 'South Korean Won', 0],
  ['KWD', 'Kuwaiti Dinar', 3],
  ['KYD', 'Cayman Islands Dollar', 2],
  ['KZT', 'Kazakhstani Tenge', 2],
  ['LAK', 'Lao Kip', 2],
  ['LBP', 'Lebanese Pound', 2],
  ['LKR', 'Sri Lankan Rupee', 2],
  ['LRD', 'Liberian Dollar', 2],
  ['LSL', 'Lesotho Loti', 2],
  ['LYD', 'Libyan Dinar', 3],
  ['MAD', 'Moroccan Dirham', 2],
  ['MDL', 'Moldovan Leu', 2],
  ['MGA', 'Malagasy Ariary', 2],
  ['MKD', 'Macedonian Denar', 2],
  ['MMK', 'Myanmar Kyat', 2],
  ['MNT', 'Mongolian Tögrög', 2],
  ['MOP', 'Macanese Pataca', 2],
  ['MRU', 'Mauritanian Ouguiya', 2],
  ['MUR', 'Mauritian Rupee', 2],
  ['MVR', 'Maldivian Rufiyaa', 2],
  ['MWK', 'Malawian Kwacha', 2],
  ['MXN', 'Mexican Peso', 2],
  ['MYR', 'Malaysian Ringgit', 2],
  ['MZN', 'Mozambican Metical', 2],
  ['NAD', 'Namibian Dollar', 2],
  ['NGN', 'Nigerian Naira', 2],
  ['NIO', 'Nicaraguan Córdoba', 2],
  ['NOK', 'Norwegian Krone', 2],
  ['NPR', 'Nepalese Rupee', 2],
  ['NZD', 'New Zealand Dollar', 2],
  ['OMR', 'Omani Rial', 3],
  ['PAB', 'Panamanian Balboa', 2],
  ['PEN', 'Peruvian Sol', 2],
  ['PGK', 'Papua New Guinean Kina', 2],
  ['PHP', 'Philippine Peso', 2],
  ['PKR', 'Pakistani Rupee', 2],
  ['PLN', 'Polish Złoty', 2],
  ['PYG', 'Paraguayan Guaraní', 0],
  ['QAR', 'Qatari Riyal', 2],
  ['RON', 'Romanian Leu', 2],
  ['RSD', 'Serbian Dinar', 2],
  ['RWF', 'Rwandan Franc', 0],
  ['SAR', 'Saudi Riyal', 2],
  ['SBD', 'Solomon Islands Dollar', 2],
  ['SCR', 'Seychellois Rupee', 2],
  ['SDG', 'Sudanese Pound', 2],
  ['SEK', 'Swedish Krona', 2],
  ['SGD', 'Singapore Dollar', 2],
  ['SHP', 'Saint Helenian Pound', 2],
  ['SLE', 'New Leone', 2],
  ['SOS', 'Somali Shilling', 2],
  ['SRD', 'Surinamese Dollar', 2],
  ['SSP', 'South Sudanese Pound', 2],
  ['STN', 'São Tomé and Príncipe Second Dobra', 2],
  ['SVC', 'Salvadoran Colón', 2],
  ['SYP', 'Syrian Pound', 2],
  ['SZL', 'Swazi Lilangeni', 2],
  ['THB', 'Thai Baht', 2],
  ['TJS', 'Tajikistani Somoni', 2],
  ['TMT', 'Turkmenistani Manat', 2],
  ['TND', 'Tunisian Dinar', 3],
  ['TOP', 'Tongan Paʻanga', 2],
  ['TRY', 'Turkish Lira', 2],
  ['TTD', 'Trinidad and Tobago Dollar', 2],
  ['TWD', 'New Taiwan Dollar', 2],
  ['TZS', 'Tanzanian Shilling', 2],
  ['UAH', 'Ukrainian Hryvnia', 2],
  ['UGX', 'Ugandan Shilling', 0],
  ['USD', 'United States Dollar', 2],
  ['UYU', 'Uruguayan Peso', 2],
  ['UZS', 'Uzbekistan Som', 2],
  ['VES', 'Venezuelan Bolívar Soberano', 2],
  ['VND', 'Vietnamese Đồng', 0],
  ['VUV', 'Vanuatu Vatu', 0],
  ['WST', 'Samoan Tala', 2],
  ['XAF', 'Central African CFA Franc', 0],
  ['XCD', 'East Caribbean Dollar', 2],
  ['XCG', 'Caribbean Guilder', 2],
  ['XOF', 'West African CFA Franc', 0],
  ['XPF', 'CFP Franc', 0],
  ['YER', 'Yemeni Rial', 2],
  ['ZAR', 'South African Rand', 2],
  ['ZMW', 'Zambian Kwacha', 2],
  ['ZWG', 'Zimbabwe Gold', 2],
];

/**
 * Retained for validation, formatting and historical data, but **not
 * convertible by the approved chain**.
 *
 * BGN is the case that matters, and it is historical rather than current: v2
 * lists it only under `?scope=all`, Bulgaria adopted the euro on 2026-01-01,
 * and the ECB's EUR/BGN reference rate ended with 2025 — so amounts recorded
 * in lev before then must still format while the currency can no longer be
 * chosen. ANG and MRO were likewise
 * replaced, by XCG and MRU.
 *
 * RUB, BYN, IRR and KPW are a different case and the wording matters: they are
 * current ISO 4217 currencies, and Frankfurter v2 has current rates for
 * several of them from banks outside the approved chain. What ended is the
 * ECB's and Banca d'Italia's own publication, so Vaultide has no rate it is
 * willing to convert them with — not "no rate exists".
 *
 * CLF and UYW are Chilean and Uruguayan indexation units that v2 does not
 * carry at all — they are also the reason the schema allows four decimals
 * rather than three (6.2, 7.2).
 *
 * 6.2 says "no delete": a currency that has ever been seeded stays.
 */
const RETAINED_NOT_CONVERTIBLE: readonly [string, string, number][] = [
  ['ANG', 'Netherlands Antillean Guilder', 2],
  ['BGN', 'Bulgarian Lev', 2],
  ['BYN', 'Belarusian Ruble', 2],
  ['CLF', 'Chilean Unidad de Fomento', 4],
  ['IRR', 'Iranian Rial', 2],
  ['KPW', 'North Korean Won', 2],
  ['MRO', 'Mauritanian Ouguiya', 2],
  ['RUB', 'Russian Ruble', 2],
  ['UYW', 'Uruguayan Unidad Previsional', 4],
];

export const currencySeed: readonly CurrencySeedRow[] = [
  ...FX_SUPPORTED.map(([code, name, minorUnits]) => ({
    code,
    name,
    minorUnits,
    isFxSupported: true,
  })),
  ...RETAINED_NOT_CONVERTIBLE.map(([code, name, minorUnits]) => ({
    code,
    name,
    minorUnits,
    isFxSupported: false,
  })),
].sort((a, b) => a.code.localeCompare(b.code));
