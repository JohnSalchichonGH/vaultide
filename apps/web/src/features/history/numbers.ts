/**
 * Numbers as a person types or pastes them, in their own locale (blueprint
 * 15.3 "paste from a spreadsheet (TSV, locale-aware numbers)"; ADR 0011 D4).
 *
 * The result is one **canonical decimal string** — no leading zeros, no
 * trailing fractional zeros, no `-0` — built from the characters themselves.
 * Nothing here ever passes through a JavaScript number, so a nineteen-digit
 * balance survives exactly as typed.
 *
 * The locale decides which character is the decimal separator and which groups
 * thousands, read from `Intl.NumberFormat(locale).formatToParts`. Grouping is
 * accepted only where the locale puts it, so `1,5` is refused in en-US rather
 * than read as fifteen, and `1.234` means 1234 in de-DE and 1.234 in en-US.
 * Whitespace groups digits in any locale — a space, a no-break space or a
 * narrow no-break space, which is what French spreadsheets export.
 *
 * Deliberately not `normalizeMoneyInput`, which reads any comma as a decimal
 * separator and so turns an en-US `1,234.56` into `1.234.56`. The ordinary form
 * fields keep that parser; the grid uses this one.
 */

export interface LocaleNumberFormat {
  readonly decimal: string;
  readonly group: string;
  /** Digits in the last group before the decimal separator (3 almost everywhere). */
  readonly primary: number;
  /** Digits in each earlier group (2 in en-IN's 12,34,567). */
  readonly secondary: number;
}

const cache = new Map<string, LocaleNumberFormat>();

/** The separators and group sizes a locale writes numbers with. */
export function localeNumberFormat(locale: string): LocaleNumberFormat {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;

  let format: LocaleNumberFormat = { decimal: '.', group: ',', primary: 3, secondary: 3 };
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(123456789.5);
    const integers = parts.filter((part) => part.type === 'integer').map((part) => part.value.length);
    const last = integers.at(-1) ?? 3;
    const before = integers.length > 2 ? (integers.at(-2) ?? last) : last;
    format = {
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      primary: last,
      secondary: before,
    };
  } catch {
    // An unknown locale keeps the plain dot-decimal default.
  }
  cache.set(locale, format);
  return format;
}

export type NumberParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

const WHITESPACE_GROUPS = /[ \u00a0\u202f\u2009]/u;
const MINUS = /^[-\u2212]/u;

const fail = (message: string): NumberParse => ({ ok: false, message });

/** Canonical spelling of digits already split at the decimal point. */
export function canonicalOf(negative: boolean, integer: string, fraction: string): string {
  const whole = integer.replace(/^0+(?=\d)/u, '') || '0';
  const decimals = fraction.replace(/0+$/u, '');
  const body = decimals === '' ? whole : `${whole}.${decimals}`;
  return body === '0' || !negative ? body : `-${body}`;
}

/**
 * Whether grouped integer digits are grouped the way the locale groups them:
 * `1,234,567` or `12,34,567`, never `1,2345` or `12,3`.
 */
function groupedCorrectly(groups: readonly string[], format: LocaleNumberFormat): boolean {
  if (groups.some((group) => !/^\d+$/u.test(group))) return false;
  if (groups.length === 1) return true;
  const last = groups[groups.length - 1] as string;
  const first = groups[0] as string;
  const middle = groups.slice(1, -1);
  return (
    last.length === format.primary &&
    middle.every((group) => group.length === format.secondary) &&
    first.length >= 1 &&
    first.length <= (groups.length === 2 ? format.primary : format.secondary)
  );
}

/**
 * Parse one typed or pasted amount in `locale`.
 *
 * Accepts an optional minus sign, digits, the locale's decimal separator once,
 * its grouping separator where it groups, and grouping whitespace. Refuses a
 * currency symbol, a percent sign or an accounting-style `(12.00)` with a
 * message that says what to do instead. A blank string is not a number; the
 * caller decides what blank means.
 */
export function parseLocaleNumber(raw: string, locale: string): NumberParse {
  const text = raw.trim();
  if (text === '') return fail('Enter an amount.');
  if (/^\(.*\)$/u.test(text)) return fail('Write a negative amount with a minus sign, not in brackets.');
  if (text.includes('%')) return fail('Enter an amount, not a percentage.');
  if (/\p{Sc}/u.test(text) || /\p{L}/u.test(text)) {
    return fail('Enter the amount only, without a currency or other text.');
  }

  const format = localeNumberFormat(locale);
  const negative = MINUS.test(text);
  const unsigned = negative ? text.slice(1).trimStart() : text;

  const decimalAt = unsigned.indexOf(format.decimal);
  if (decimalAt !== -1 && unsigned.indexOf(format.decimal, decimalAt + 1) !== -1) {
    return fail(`Use the decimal separator “${format.decimal}” only once.`);
  }
  const integerText = decimalAt === -1 ? unsigned : unsigned.slice(0, decimalAt);
  const fraction = decimalAt === -1 ? '' : unsigned.slice(decimalAt + 1);

  if (decimalAt !== -1 && !/^\d+$/u.test(fraction)) {
    return fail('Use only digits after the decimal separator.');
  }

  // Grouping: the locale's own separator, or whitespace, between digits only.
  const groupChars = new Set([format.group]);
  const splitter = new RegExp(
    `[${[...groupChars].map((char) => char.replace(/[\\\]^-]/gu, '\\$&')).join('')}]|${WHITESPACE_GROUPS.source}`,
    'u',
  );
  const integerOnly = integerText === '' && fraction !== '' ? '0' : integerText;
  const groups = integerOnly.split(splitter);
  if (!groupedCorrectly(groups, format)) {
    return fail(
      format.decimal === '.'
        ? 'Use digits, with “.” for decimals.'
        : `Use digits, with “${format.decimal}” for decimals.`,
    );
  }

  const integer = groups.join('');
  if (integer.replace(/^0+(?=\d)/u, '').length > 16) {
    return fail('Amounts may have at most 16 digits before the decimal separator.');
  }
  return { ok: true, value: canonicalOf(negative, integer, fraction) };
}

/** Decimals written in a canonical decimal string. */
export const scaleOf = (canonical: string): number => canonical.split('.')[1]?.length ?? 0;

/**
 * An exact amount as an editable field shows it in `locale`: the locale's
 * decimal separator, padded to the currency's minor units, and no grouping, so
 * the text a person edits is the text this module parses back exactly.
 */
export function editableText(canonical: string, locale: string, minorUnits: number): string {
  const negative = canonical.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? canonical.slice(1) : canonical).split('.');
  const padded = minorUnits > fraction.length ? fraction.padEnd(minorUnits, '0') : fraction;
  const body = padded === '' ? integer : `${integer}${localeNumberFormat(locale).decimal}${padded}`;
  return negative ? `-${body}` : body;
}
