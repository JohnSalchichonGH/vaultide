'use server';

import { revalidatePath } from 'next/cache';
import {
  acceptSuggestion,
  archiveTemplate,
  createTemplate,
  getServices,
  setCountAdditionalSpending,
  setTemplateTerm,
  skipSuggestion,
  unarchiveTemplate,
  unskipSuggestion,
  updateTemplateDetails,
} from '@vaultide/application';
import { flowInput } from '@vaultide/validation';
import { financialAction } from './define';

/**
 * Recurring templates, their terms, the accept/skip services, and the one
 * financial preference on `user_settings` (blueprint 6.2, 12.5, 15.3, 20.3).
 *
 * **Every action here is `financialAction`.** Templates decide which
 * occurrences a month is missing (8.5) and what completeness counts (12.6);
 * skips are the only occupancy fact the product records (11.2); a term decides
 * what every future suggestion is worth. None of them is a display preference,
 * and none may be authorized by a five-minute cookie cache (ADR 0003).
 *
 * There is deliberately **no** template hard-delete action. 6.3 permits
 * deleting an unreferenced template, but its terms and skips cascade, and a
 * skip can carry an occupancy fact whose removal has to be audited like any
 * other record. Retirement is archiving, which stops the suggestions and keeps
 * every row; a phase that wants deletion must define the child-row behaviour
 * first.
 */

function refreshRecurringViews(): void {
  revalidatePath('/dashboard');
  revalidatePath('/settings');
  revalidatePath('/', 'layout');
}

export const createTemplateAction = financialAction({
  name: 'recurring.createTemplate',
  input: flowInput.createTemplateInput,
  async handler({ input, ctx }) {
    const created = await createTemplate(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: created.template.id, termId: created.term.id };
  },
});

/**
 * Edit a template's harmless fields.
 *
 * `name`, `counterparty` and `endDate` only. Every other field decides what the
 * template's historical occurrences were, so once one has been materialized or
 * skipped it is frozen (v2.1.6 §30.9); the input schema does not carry them,
 * and `endDate` is refused if it would erase an occurrence that already has
 * history.
 */
export const updateTemplateAction = financialAction({
  name: 'recurring.updateTemplate',
  input: flowInput.updateTemplateInput,
  async handler({ input, ctx }) {
    const updated = await updateTemplateDetails(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: updated.id, version: updated.version };
  },
});

export const archiveTemplateAction = financialAction({
  name: 'recurring.archiveTemplate',
  input: flowInput.archiveTemplateInput,
  async handler({ input, ctx }) {
    const updated = await archiveTemplate(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: updated.id, version: updated.version };
  },
});

export const unarchiveTemplateAction = financialAction({
  name: 'recurring.unarchiveTemplate',
  input: flowInput.archiveTemplateInput,
  async handler({ input, ctx }) {
    const updated = await unarchiveTemplate(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: updated.id, version: updated.version };
  },
});

/** "From this month on": a term effective at the occurrence's scheduled date. */
export const setTemplateTermAction = financialAction({
  name: 'recurring.setTemplateTerm',
  input: flowInput.setTemplateTermInput,
  async handler({ input, ctx }) {
    const term = await setTemplateTerm(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: term.id, effectiveFrom: term.effectiveFrom };
  },
});

export const acceptSuggestionAction = financialAction({
  name: 'recurring.acceptSuggestion',
  input: (ctx) => flowInput.acceptSuggestionInput(ctx.today),
  async handler({ input, ctx }) {
    const accepted = await acceptSuggestion(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { kind: accepted.kind, id: accepted.entry.id };
  },
});

export const skipSuggestionAction = financialAction({
  name: 'recurring.skipSuggestion',
  input: flowInput.skipSuggestionInput,
  async handler({ input, ctx }) {
    const skip = await skipSuggestion(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: skip.id };
  },
});

export const unskipSuggestionAction = financialAction({
  name: 'recurring.unskipSuggestion',
  input: flowInput.unskipSuggestionInput,
  async handler({ input, ctx }) {
    const removed = await unskipSuggestion(getServices().flows, ctx, input);
    refreshRecurringViews();
    return { id: removed.id };
  },
});

/**
 * The savings-rate preference (12.5).
 *
 * Financial, not cosmetic: it decides whether spending paid from outside
 * tracked accounts reduces personal savings, so flipping it re-interprets every
 * past month's `PersonalSavings` and `SavingsRate`. It moved off
 * `updateSettingsAction` — which stays on the cached path for timezone, locale
 * and favourite currencies — for exactly that reason, and there is one control
 * for it so the setting has a single source of truth.
 */
export const setCountAdditionalSpendingAction = financialAction({
  name: 'settings.setCountAdditionalSpending',
  input: flowInput.setCountAdditionalSpendingInput,
  async handler({ input, ctx }) {
    const settings = await setCountAdditionalSpending(
      getServices().settings,
      ctx.userId,
      input.expectedVersion,
      input.countAdditionalSpending,
    );
    revalidatePath('/settings');
    revalidatePath('/', 'layout');
    return settings;
  },
});
