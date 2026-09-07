import { hasUserSettings, provisionAccount, type Database } from '@vaultide/db';
import { defaultCategories, defaultTags } from './default-categories';

/**
 * User provisioning (blueprint Phase 1, 6.2, D25).
 *
 * When an account is created it must immediately have everything the rest of
 * the application assumes exists: a `user_settings` row, one category per
 * system kind, the starter consumption categories, and the initial tag list.
 *
 * Two properties matter, and both are tested:
 *
 *  1. **All or nothing.** The whole set is written in one transaction, so a
 *     failure half-way leaves no partial state to reason about.
 *  2. **Idempotent, and therefore self-healing.** Every write is
 *     `ON CONFLICT DO NOTHING`, so running it twice is a no-op. That is what
 *     makes the first property safe against the one thing a transaction cannot
 *     cover: Better Auth commits the `user` row through its own adapter and
 *     calls the provisioning hook afterwards. If the process dies in between,
 *     the account exists un-provisioned — so `requireSession` calls this again
 *     on the next authenticated request and the account repairs itself rather
 *     than staying broken. Sign-in is verification-gated, so there is no window
 *     in which the user can act on an un-provisioned account.
 */

export interface ProvisionUserInput {
  readonly userId: string;
  /**
   * Starting settings. Sign-up does not know the user's timezone or currency —
   * onboarding steps 1 and 2 ask for them — so these are the neutral defaults:
   * UTC, `en-GB`, and EUR, the FX pivot, which is the one currency that is
   * always convertible without a stored rate (10.1).
   */
  readonly baseCurrency?: string;
  readonly reportingCurrency?: string;
  readonly timezone?: string;
  readonly locale?: string;
}

export interface ProvisionResult {
  /** `true` when this call created the settings row (a first provisioning). */
  readonly created: boolean;
  readonly categoriesCreated: number;
}

export const DEFAULT_BASE_CURRENCY = 'EUR';
export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_LOCALE = 'en-GB';

export async function provisionUser(
  db: Database,
  input: ProvisionUserInput,
): Promise<ProvisionResult> {
  const baseCurrency = input.baseCurrency ?? DEFAULT_BASE_CURRENCY;

  const outcome = await provisionAccount(db, {
    userId: input.userId,
    settings: {
      baseCurrency,
      reportingCurrency: input.reportingCurrency ?? baseCurrency,
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      locale: input.locale ?? DEFAULT_LOCALE,
    },
    categories: defaultCategories,
    tags: defaultTags,
  });

  return { created: outcome.settingsCreated, categoriesCreated: outcome.categoriesCreated };
}

/**
 * Cheap guard used on every authenticated request: provision only when the
 * settings row is absent. The common case is a single indexed primary-key read.
 */
export async function ensureProvisioned(db: Database, userId: string): Promise<void> {
  if (await hasUserSettings(db, userId)) return;
  await provisionUser(db, { userId });
}
