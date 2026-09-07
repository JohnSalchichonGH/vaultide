/**
 * Time-zone and locale choices for the settings and onboarding forms
 * (blueprint 15.2, 16.6, 29.2 "localization beyond English deferred").
 *
 * The full IANA database is about 400 zones and the full BCP 47 space is
 * unbounded; a select with either is unusable. These are shortlists, with the
 * user's own current value always included so a value set elsewhere — or
 * carried over from a previous choice — is never silently dropped by a form
 * that could not render it.
 *
 * The runtime is asked for the full list where it can supply one, so a zone
 * added by a future tzdata update becomes selectable without a release.
 */

const COMMON_ZONES = [
  'UTC',
  'Europe/Madrid',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Dublin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'America/Toronto',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Africa/Johannesburg',
] as const;

/**
 * Every zone the runtime knows, where it exposes them (Node 22 and current
 * browsers do), otherwise the shortlist. The user's current zone is always
 * present and the list is sorted, with UTC first.
 */
export function suggestedTimeZones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [...COMMON_ZONES];

  const zones = new Set<string>([...supported, ...COMMON_ZONES, current]);
  zones.delete('UTC');
  return ['UTC', ...[...zones].sort((a, b) => a.localeCompare(b))];
}

/**
 * Locales the interface is formatted with. English only for now (29.3 defers
 * localization), plus the European locales whose number formatting differs
 * enough to matter — a Spanish user reading `1.234,56` is the case 7.1.1 and
 * 16.6 exist for.
 */
export const SUGGESTED_LOCALES = [
  'en-GB',
  'en-US',
  'es-ES',
  'de-DE',
  'fr-FR',
  'it-IT',
  'nl-NL',
  'pt-PT',
  'sv-SE',
  'pl-PL',
  'ja-JP',
] as const;

export function suggestedLocales(current: string): string[] {
  return [...new Set<string>([...SUGGESTED_LOCALES, current])];
}
