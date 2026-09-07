import { sql } from 'drizzle-orm';
import { categories } from '../schema/categories';
import { tags } from '../schema/tags';
import { userSettings } from '../schema/user-settings';
import { withUser, type Database } from '../client';
import type { CategoryKind } from '@vaultide/validation';

/**
 * Account provisioning, as one transaction (blueprint Phase 1, D25).
 *
 * The whole starting state of an account — settings, the default categories
 * including every system kind, and the initial tags — is written together or
 * not at all. Every statement is `ON CONFLICT DO NOTHING`, so re-running it is
 * a no-op and a retry after a partial failure completes the account rather than
 * duplicating half of it.
 *
 * It runs inside `withUser`, so RLS validates the ownership of every row on the
 * way in: a bug that provisioned somebody else's account would be rejected by
 * the policy, not merely by this code.
 */

export interface ProvisionCategoryInput {
  readonly kind: CategoryKind;
  readonly name: string;
  readonly groupName: string | null;
  readonly sortOrder: number;
}

export interface ProvisionSettingsInput {
  readonly baseCurrency: string;
  readonly reportingCurrency: string;
  readonly timezone: string;
  readonly locale: string;
}

export interface ProvisionInput {
  readonly userId: string;
  readonly settings: ProvisionSettingsInput;
  readonly categories: readonly ProvisionCategoryInput[];
  readonly tags: readonly string[];
}

export interface ProvisionOutcome {
  /** `true` when this call created the settings row (a first provisioning). */
  readonly settingsCreated: boolean;
  readonly categoriesCreated: number;
  readonly tagsCreated: number;
}

export async function provisionAccount(
  db: Database,
  input: ProvisionInput,
): Promise<ProvisionOutcome> {
  return withUser(db, { userId: input.userId }, async (tx) => {
    const settings = await tx
      .insert(userSettings)
      .values({
        userId: input.userId,
        baseCurrency: input.settings.baseCurrency,
        reportingCurrency: input.settings.reportingCurrency,
        timezone: input.settings.timezone,
        locale: input.settings.locale,
        favoriteCurrencies: [],
      })
      .onConflictDoNothing({ target: userSettings.userId })
      .returning({ userId: userSettings.userId });

    const insertedCategories =
      input.categories.length === 0
        ? []
        : await tx
            .insert(categories)
            .values(
              input.categories.map((category) => ({
                userId: input.userId,
                kind: category.kind,
                name: category.name,
                groupName: category.groupName,
                isDefault: true,
                sortOrder: category.sortOrder,
              })),
            )
            // Live-name uniqueness is a partial index, so the conflict clause
            // repeats its predicate for PostgreSQL to recognise the target.
            .onConflictDoNothing({
              target: [categories.userId, categories.name],
              where: sql`archived_at IS NULL`,
            })
            .returning({ id: categories.id });

    const insertedTags =
      input.tags.length === 0
        ? []
        : await tx
            .insert(tags)
            .values(input.tags.map((name) => ({ userId: input.userId, name })))
            .onConflictDoNothing({ target: [tags.userId, tags.name] })
            .returning({ id: tags.id });

    return {
      settingsCreated: settings.length > 0,
      categoriesCreated: insertedCategories.length,
      tagsCreated: insertedTags.length,
    };
  });
}

/** Does this account have its settings row? The cheap provisioning guard. */
export async function hasUserSettings(db: Database, userId: string): Promise<boolean> {
  const rows = await withUser(db, { userId }, async (tx) =>
    tx.select({ userId: userSettings.userId }).from(userSettings).limit(1),
  );
  return rows.length > 0;
}
