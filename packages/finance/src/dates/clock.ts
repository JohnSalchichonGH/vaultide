import { plainDate, type PlainDate } from './plain-date';

/**
 * "Today" (blueprint 7.7): computed once per request in the user's timezone and
 * passed into every engine. Engines never read the clock themselves, which is
 * what makes month-boundary behavior testable.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at an instant — used by tests and by the TEST_CLOCK override. */
export function fixedClock(instant: Date | string): Clock {
  const value = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`Invalid clock instant: ${String(instant)}`);
  }
  return { now: () => new Date(value.getTime()) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export class InvalidTimeZoneError extends Error {
  readonly code = 'INVALID_TIME_ZONE';
  constructor(readonly value: string) {
    super(`"${value}" is not a valid IANA time zone.`);
    this.name = 'InvalidTimeZoneError';
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date in `timeZone` at the clock's instant. `en-CA` formats as
 * `YYYY-MM-DD`, so the parts come out in ISO order without manual assembly.
 */
export function todayIn(timeZone: string, clock: Clock = systemClock): PlainDate {
  if (!isValidTimeZone(timeZone)) throw new InvalidTimeZoneError(timeZone);
  return plainDate(formatterFor(timeZone).format(clock.now()));
}
