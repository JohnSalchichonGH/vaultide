'use server';

import { revalidatePath } from 'next/cache';
import {
  archiveUserCategory,
  createCategory,
  createTag,
  getServices,
  markOnboardingCompleted,
  removeTag,
  updateSettings,
  type UserSettings,
} from '@vaultide/application';
import { settingsInput } from '@vaultide/validation';
import { z } from 'zod';
import { action } from './define';

/**
 * Settings, category and tag mutations (blueprint 15.2, 6.2, 20.1).
 *
 * Every one of them takes the user from the session, never from its input: the
 * schemas below have no `userId` field, and the service functions are handed
 * `ctx.userId`. A client that invented one would find nowhere to put it.
 *
 * Paths are revalidated after a write so the server components re-render with
 * the new values rather than showing the version the form was rendered from
 * (4.2: navigation and `revalidatePath` handle freshness).
 */

function refreshSettingsViews(): void {
  revalidatePath('/settings', 'layout');
  revalidatePath('/', 'layout');
}

export const updateSettingsAction = action({
  name: 'settings.update',
  input: settingsInput.updateSettingsInput,
  async handler({ input, ctx }): Promise<UserSettings> {
    const { expectedVersion, ...fields } = input;
    const settings = await updateSettings(
      getServices().settings,
      ctx.userId,
      expectedVersion,
      fields,
    );
    refreshSettingsViews();
    return settings;
  },
});

export const setReportingCurrencyAction = action({
  name: 'settings.setReportingCurrency',
  input: settingsInput.setReportingCurrencyInput.extend({
    expectedVersion: z.number().int().positive(),
  }),
  async handler({ input, ctx }): Promise<UserSettings> {
    const settings = await updateSettings(
      getServices().settings,
      ctx.userId,
      input.expectedVersion,
      { reportingCurrency: input.reportingCurrency },
    );
    refreshSettingsViews();
    return settings;
  },
});

export const createCategoryAction = action({
  name: 'categories.create',
  input: z.object({
    kind: z.enum(settingsInput.CATEGORY_KINDS_FOR_USERS),
    name: settingsInput.categoryName,
    groupName: z.string().trim().max(80).optional(),
  }),
  async handler({ input, ctx }) {
    const category = await createCategory(getServices().db, ctx.userId, {
      kind: input.kind,
      name: input.name,
      groupName: input.groupName ?? null,
    });
    revalidatePath('/settings/categories');
    return category;
  },
});

export const archiveCategoryAction = action({
  name: 'categories.archive',
  input: z.object({ categoryId: z.uuid() }),
  async handler({ input, ctx }) {
    const category = await archiveUserCategory(getServices().db, ctx.userId, input.categoryId);
    revalidatePath('/settings/categories');
    return category;
  },
});

export const createTagAction = action({
  name: 'tags.create',
  input: z.object({ name: settingsInput.tagName }),
  async handler({ input, ctx }) {
    const tag = await createTag(getServices().db, ctx.userId, input.name);
    revalidatePath('/settings/categories');
    return tag;
  },
});

export const deleteTagAction = action({
  name: 'tags.delete',
  input: z.object({ tagId: z.uuid() }),
  async handler({ input, ctx }) {
    await removeTag(getServices().db, ctx.userId, input.tagId);
    revalidatePath('/settings/categories');
    return { deleted: true } as const;
  },
});

/** Onboarding steps 1-3 (Phase 1 scope); step 4 is Phase 2, steps 5-10 later. */
export const completeOnboardingStepAction = action({
  name: 'onboarding.completeStep',
  input: z.discriminatedUnion('step', [
    z.object({
      step: z.literal(1),
      expectedVersion: z.number().int().positive(),
      ...settingsInput.onboardingIdentityInput.shape,
    }),
    z.object({
      step: z.literal(2),
      expectedVersion: z.number().int().positive(),
      ...settingsInput.onboardingCurrencyInput.shape,
    }),
    z.object({
      step: z.literal(3),
      expectedVersion: z.number().int().positive(),
      ...settingsInput.onboardingFavoritesInput.shape,
    }),
  ]),
  async handler({ input, ctx }): Promise<UserSettings> {
    const services = getServices();
    const { step, expectedVersion } = input;

    const fields =
      step === 1
        ? { timezone: input.timezone, locale: input.locale }
        : step === 2
          ? { baseCurrency: input.baseCurrency, reportingCurrency: input.reportingCurrency }
          : { favoriteCurrencies: input.favoriteCurrencies };

    const settings = await updateSettings(services.settings, ctx.userId, expectedVersion, fields);

    // The last Phase 1 step is what closes the wizard; the flag is UI state and
    // is not versioned, so it cannot invalidate a form somebody left open.
    const final = step === 3 ? await markOnboardingCompleted(services.db, ctx.userId) : settings;

    refreshSettingsViews();
    revalidatePath('/onboarding', 'layout');
    return final;
  },
});
