import { isCalendarDate } from '@vaultide/validation';

/**
 * Client-side validation for a date on an **actual** financial record
 * (blueprint M5, R17, 20.1).
 *
 * This is the immediate-feedback copy of the rule; the authority is the same
 * rule applied again in the server action's schema, so bypassing the control
 * changes nothing. `today` always comes from the request context.
 */
export function validateRecordDate(
  candidate: string,
  today: string,
  options: { required?: boolean } = {},
): string | null {
  if (candidate === '') return options.required === true ? 'Enter a date.' : null;
  if (!isCalendarDate(candidate)) return 'Enter a real calendar date.';
  if (candidate > today) {
    return 'This date is in the future. Records can only be dated up to today.';
  }
  return null;
}
