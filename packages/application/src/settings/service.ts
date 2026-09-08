import {
  findUserSettings,
  mergeUserPreferences,
  updateUserSettings,
  type Database,
  type UserSettingsPatch,
  type UserSettingsRecord,
} from '@vaultide/db';
import { usableCurrencyCodes } from '../currencies/service';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import type { UserSettings } from './types';

/**
 * User settings (blueprint 6.2, 15.2 Settings, 20.3).
 *
 * Every read and every write goes through `withUser`, so the database enforces
 * ownership as well as this code: a query that somehow carried another user's
 * id would return nothing and an insert would fail the policy's `WITH CHECK`.
 * No function here accepts a caller-supplied `userId` — it comes from the
 * authenticated context (17.2).
 */

export interface SettingsDependencies {
  readonly db: Database;
  /**
   * Called with any currency the user has just started using, so its history
   * can be fetched once, globally (10.4). Failure is not the user's problem:
   * the callback swallows provider errors and conversions stay `Unavailable`
   * until the next cron.
   */
  /**
   * Make the chosen currencies convertible now (10.4).
   *
   * Deliberately not "fetch their history": choosing a base, reporting or
   * favourite currency asks for nothing dated, and in Phase 1 there is no
   * dated financial data to convert. History is fetched when a conversion
   * first needs it. See `FxService.ensureHistory` and ADR 0002 decision 17.
   */
  readonly ensureCurrentRates?: (currencies: readonly string[]) => Promise<void>;
}

function toDto(row: UserSettingsRecord): UserSettings {
  return {
    userId: row.userId,
    baseCurrency: row.baseCurrency.trim(),
    reportingCurrency: row.reportingCurrency.trim(),
    timezone: row.timezone,
    locale: row.locale,
    favoriteCurrencies: row.favoriteCurrencies.map((code) => code.trim()),
    staleInvestmentMonths: row.staleInvestmentMonths,
    stalePropertyMonths: row.stalePropertyMonths,
    countAdditionalSpending: row.countAdditionalSpending,
    onboardingCompleted:
      (row.preferences as { onboardingCompleted?: unknown } | null)?.onboardingCompleted === true,
    version: row.version,
  };
}

/** The onboarding key inside `preferences` (6.1: UI state only). */
export const ONBOARDING_COMPLETED_KEY = 'onboardingCompleted';

/**
 * Mark onboarding as done. Not versioned: finishing a wizard is UI state, and
 * making it bump `version` would invalidate any settings form left open.
 */
export async function markOnboardingCompleted(
  db: Database,
  userId: string,
): Promise<UserSettings> {
  await mergeUserPreferences(db, userId, { [ONBOARDING_COMPLETED_KEY]: true });
  return readSettings(db, userId);
}

export async function readSettings(db: Database, userId: string): Promise<UserSettings> {
  const row = await findUserSettings(db, userId);
  // Absent settings mean an un-provisioned account, which `ensureProvisioned`
  // repairs before this is ever called on a real request.
  if (row === undefined) throw new NotFoundError('Settings have not been created yet.');
  return toDto(row);
}

export async function findSettings(
  db: Database,
  userId: string,
): Promise<UserSettings | undefined> {
  const row = await findUserSettings(db, userId);
  return row === undefined ? undefined : toDto(row);
}

/**
 * The fields an update may carry. Each is optional and explicitly allows
 * `undefined`, so a caller can spread a partially-filled form straight in
 * under `exactOptionalPropertyTypes`; only defined fields are written.
 */
export interface UpdateSettingsFields {
  readonly baseCurrency?: string | undefined;
  readonly reportingCurrency?: string | undefined;
  readonly timezone?: string | undefined;
  readonly locale?: string | undefined;
  readonly favoriteCurrencies?: readonly string[] | undefined;
  readonly staleInvestmentMonths?: number | undefined;
  readonly stalePropertyMonths?: number | undefined;
}

/*
 * `countAdditionalSpending` is deliberately absent above.
 *
 * It lives on `user_settings` like a preference and behaves like a financial
 * input: it decides whether spending paid from outside tracked accounts reduces
 * personal savings (12.5), so flipping it re-interprets every historical
 * `PersonalSavings` and `SavingsRate`. `setCountAdditionalSpending` below is its
 * only writer, and the action that calls it validates the session against the
 * store rather than the five-minute cookie cache (ADR 0003).
 */

/**
 * Update settings under an optimistic version check (20.3).
 *
 * Currency codes are checked against the catalogue, not merely against a
 * pattern: a code must exist, be active and be FX-supported. That single check
 * is what keeps crypto out (it is not in `currencies` at all, R28) and what
 * stops a user pinning their reporting currency to something no rate can ever
 * value (10.5).
 */
export async function updateSettings(
  deps: SettingsDependencies,
  userId: string,
  expectedVersion: number,
  fields: UpdateSettingsFields,
): Promise<UserSettings> {
  const { db } = deps;

  const requestedCurrencies = [
    ...(fields.baseCurrency === undefined ? [] : [fields.baseCurrency]),
    ...(fields.reportingCurrency === undefined ? [] : [fields.reportingCurrency]),
    ...(fields.favoriteCurrencies ?? []),
  ].map((code) => code.trim().toUpperCase());

  if (requestedCurrencies.length > 0) {
    const usable = await usableCurrencyCodes(db, requestedCurrencies);
    const rejected = [...new Set(requestedCurrencies)].filter((code) => !usable.has(code));
    if (rejected.length > 0) {
      // The message names the codes because they are the user's own input, not
      // anybody's financial data (18.2).
      throw new ValidationError(
        `These currencies are not supported: ${rejected.join(', ')}. Vaultide supports the official currencies its approved rate sources publish daily reference rates for; crypto is tracked as an investment, not as a currency.`,
        { currency: rejected },
      );
    }
  }

  const patch: UserSettingsPatch = {};
  if (fields.baseCurrency !== undefined) patch.baseCurrency = fields.baseCurrency.toUpperCase();
  if (fields.reportingCurrency !== undefined) {
    patch.reportingCurrency = fields.reportingCurrency.toUpperCase();
  }
  if (fields.timezone !== undefined) patch.timezone = fields.timezone;
  if (fields.locale !== undefined) patch.locale = fields.locale;
  if (fields.favoriteCurrencies !== undefined) {
    patch.favoriteCurrencies = fields.favoriteCurrencies.map((code) => code.toUpperCase());
  }
  if (fields.staleInvestmentMonths !== undefined) {
    patch.staleInvestmentMonths = fields.staleInvestmentMonths;
  }
  if (fields.stalePropertyMonths !== undefined) {
    patch.stalePropertyMonths = fields.stalePropertyMonths;
  }

  const updated = await updateUserSettings(db, userId, expectedVersion, patch);

  if (updated === undefined) {
    // Either the row moved on under us, or it does not exist. Both are told
    // apart by a second read, so a stale form gets the right message.
    const current = await findSettings(db, userId);
    if (current === undefined) throw new NotFoundError('Settings have not been created yet.');
    throw new VersionConflictError();
  }

  const dto = toDto(updated);

  // The settings row is already committed above: a rate publisher being slow
  // or down can no longer undo what the user just saved (10.5).
  if (requestedCurrencies.length > 0 && deps.ensureCurrentRates !== undefined) {
    await deps.ensureCurrentRates([...new Set(requestedCurrencies)]);
  }

  return dto;
}

/** The shell's reporting-currency selector (15.1) — one field, same rules. */
export async function setReportingCurrency(
  deps: SettingsDependencies,
  userId: string,
  expectedVersion: number,
  reportingCurrency: string,
): Promise<UserSettings> {
  return updateSettings(deps, userId, expectedVersion, { reportingCurrency });
}

/**
 * The one financial preference on `user_settings` (6.2, 12.5).
 *
 * "Count spending I paid from outside my tracked accounts in my savings rate."
 * Default on, so that `TotalSpending` (tracked + additional) and `SavingsRate`
 * agree with each other; turning it off makes the rate tracked-only, and the
 * interface says which one it is showing.
 *
 * It has its own service, its own input and its own action for one reason:
 * changing it changes what **every** past month's `PersonalSavings` and
 * `SavingsRate` mean. That is a financial write, so ADR 0003 applies and the
 * action behind it revalidates the session against the store — unlike the
 * timezone, locale and favourite currencies, which are cheap, reversible
 * display preferences and deliberately stay on the cached path.
 *
 * Optimistic version and audit behaviour are the ordinary `user_settings` ones.
 */
export async function setCountAdditionalSpending(
  deps: SettingsDependencies,
  userId: string,
  expectedVersion: number,
  countAdditionalSpending: boolean,
): Promise<UserSettings> {
  const updated = await updateUserSettings(deps.db, userId, expectedVersion, {
    countAdditionalSpending,
  });

  if (updated === undefined) {
    const current = await findSettings(deps.db, userId);
    if (current === undefined) throw new NotFoundError('Settings have not been created yet.');
    throw new VersionConflictError();
  }

  return toDto(updated);
}
