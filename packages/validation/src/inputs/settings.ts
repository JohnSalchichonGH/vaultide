import { z } from 'zod';
import { consumptionCategoryKinds } from '../enums';
import { currencyCode } from '../primitives/currency';
import { locale, timeZone } from '../primitives/date';

/**
 * User settings inputs (blueprint 6.2 `user_settings`, 15.2 Settings).
 *
 * The shape is validated here; whether a currency is *supported* is a database
 * question (`currencies.is_fx_supported`) answered by the settings service,
 * because the supported set is reconciled with the FX provider and changes
 * without a code release (10.4). That is also where crypto is excluded: it
 * is not in `currencies` at all (R28, D35).
 */

/** Favourites are a shortlist for the currency pickers, not a permission. */
export const MAX_FAVORITE_CURRENCIES = 12;

export const favoriteCurrencies = z
  .array(currencyCode)
  .max(
    MAX_FAVORITE_CURRENCIES,
    `Keep at most ${String(MAX_FAVORITE_CURRENCIES)} favourite currencies.`,
  )
  .transform((codes) => [...new Set(codes)]);

/** 6.2: `stale_investment_months` default 2, `stale_property_months` default 12. */
export const staleMonths = z.number().int().min(1).max(120);

export const updateSettingsInput = z
  .object({
    baseCurrency: currencyCode.optional(),
    reportingCurrency: currencyCode.optional(),
    timezone: timeZone.optional(),
    locale: locale.optional(),
    favoriteCurrencies: favoriteCurrencies.optional(),
    staleInvestmentMonths: staleMonths.optional(),
    stalePropertyMonths: staleMonths.optional(),
    countAdditionalSpending: z.boolean().optional(),
    /** Optimistic concurrency (20.3): the version the form was rendered from. */
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (value) =>
      Object.entries(value).some(([key, field]) => key !== 'expectedVersion' && field !== undefined),
    'Nothing to change.',
  );

/** The reporting-currency selector in the shell (15.1) changes one field. */
export const setReportingCurrencyInput = z.object({
  reportingCurrency: currencyCode,
});

/**
 * Onboarding steps 1–3 (Phase 1 scope; §90 steps 4–10 arrive with their
 * phases): who you are, how you count, and which currencies you care about.
 */
export const onboardingIdentityInput = z.object({
  timezone: timeZone,
  locale: locale,
});

export const onboardingCurrencyInput = z.object({
  baseCurrency: currencyCode,
  reportingCurrency: currencyCode,
});

export const onboardingFavoritesInput = z.object({
  favoriteCurrencies,
});

/**
 * The kinds a user may choose when creating a category.
 *
 * The seven system kinds are absent: one of each is created at sign-up and
 * carries accounting meaning the engines depend on, so a second would make
 * "the investment-fee category" ambiguous (6.2, 7.4).
 */
export const CATEGORY_KINDS_FOR_USERS = consumptionCategoryKinds;

export const categoryName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(80, 'That name is too long.');

export const tagName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(60, 'That name is too long.');

export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;
export type OnboardingIdentityInput = z.infer<typeof onboardingIdentityInput>;
export type OnboardingCurrencyInput = z.infer<typeof onboardingCurrencyInput>;
export type OnboardingFavoritesInput = z.infer<typeof onboardingFavoritesInput>;
