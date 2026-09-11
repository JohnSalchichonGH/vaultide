'use server';

import { revalidatePath } from 'next/cache';
import {
  closePosition,
  confirmMonthEnd,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  createCashAccount,
  createOtherAsset,
  getServices,
  markOnboardingCompleted,
  quickUpdate,
  recordValuation,
  removePosition,
  removeValuation,
  updateCashAccount,
  updateOtherAsset,
} from '@vaultide/application';
import { positionInput } from '@vaultide/validation';
import { z } from 'zod';
import { financialAction } from './define';

/**
 * Position, valuation and quick-update mutations (blueprint 15.2, 15.3, 6.2).
 *
 * **Every action in this file is declared with `financialAction`**, and that is
 * the point of the file existing separately from `settings.ts`. Each of these
 * changes what somebody's net worth says, so the session is validated against
 * the session store rather than the five-minute signed cookie cache: a revoked
 * session loses the ability to write a balance immediately, not eventually
 * (ADR 0003, decision 14 of ADR 0002).
 *
 * `financial-actions.test.ts` enumerates this directory and fails if any
 * exported action is declared with the ordinary `action` wrapper without being
 * on the non-financial list — so the rule is checked, not merely observed.
 *
 * The schemas are **functions of the context** because two of the frozen rules
 * depend on the user's local today: no actual record may be dated in the future
 * (M5, R17), and a month-end balance may only be written once its month has
 * ended (R15). A request that bypasses the browser is judged by these, and then
 * by the same rules again in the domain services.
 */

function refreshFinancialViews(): void {
  revalidatePath('/dashboard');
  revalidatePath('/accounts');
  revalidatePath('/accounts', 'layout');
  revalidatePath('/', 'layout');
}

export const createCashAccountAction = financialAction({
  name: 'positions.createCashAccount',
  input: (ctx) => positionInput.createCashAccountInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await createCashAccount(getServices().positions, ctx, {
      name: input.name,
      currency: input.currency,
      accountType: input.accountType,
      institution: input.institution,
      notes: input.notes,
      openedOn: input.origin === 'new' ? input.openedOn : null,
      openingBalance: input.openingBalance,
      openingBalanceOn: input.openingBalanceOn,
    });
    refreshFinancialViews();
    return { id: created.id, name: created.name };
  },
});

export const createOtherAssetAction = financialAction({
  name: 'positions.createOtherAsset',
  input: (ctx) => positionInput.createOtherAssetInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await createOtherAsset(getServices().positions, ctx, {
      name: input.name,
      currency: input.currency,
      assetType: input.assetType,
      notes: input.notes,
      acquisitionDate: input.acquisitionDate,
      acquisitionValue: input.acquisitionValue,
      includeInFinancialNetWorth: input.includeInFinancialNetWorth,
      currentValue: input.currentValue,
      currentValueOn: input.currentValueOn,
    });
    refreshFinancialViews();
    return { id: created.id, name: created.name };
  },
});

export const updateCashAccountAction = financialAction({
  name: 'positions.updateCashAccount',
  input: positionInput.updateCashAccountInput,
  async handler({ input, ctx }) {
    const updated = await updateCashAccount(getServices().positions, ctx, input);
    refreshFinancialViews();
    return { id: updated.id, version: updated.version };
  },
});

/**
 * Editing an other asset, including its inclusion preference.
 *
 * The flag is financial: it decides whether the asset is inside the headline
 * metric, across all of history at once, and it is audited for that reason
 * (12.1, M15).
 */
export const updateOtherAssetAction = financialAction({
  name: 'positions.updateOtherAsset',
  input: positionInput.updateOtherAssetInput,
  async handler({ input, ctx }) {
    const updated = await updateOtherAsset(getServices().positions, ctx, input);
    refreshFinancialViews();
    return { id: updated.id, version: updated.version };
  },
});

export const closePositionAction = financialAction({
  name: 'positions.close',
  input: (ctx) => positionInput.closePositionInput(ctx.today),
  async handler({ input, ctx }) {
    const closed = await closePosition(getServices().positions, ctx, input);
    refreshFinancialViews();
    return { id: closed.id, version: closed.version };
  },
});

export const deletePositionAction = financialAction({
  name: 'positions.delete',
  input: positionInput.deletePositionInput,
  async handler({ input, ctx }) {
    await removePosition(getServices().positions, ctx, input.positionId);
    refreshFinancialViews();
    return { deleted: true } as const;
  },
});

export const recordValuationAction = financialAction({
  name: 'valuations.record',
  input: (ctx) => positionInput.createValuationInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await recordValuation(getServices().positions, ctx, {
      positionId: input.positionId,
      valuedOn: input.valuedOn,
      amount: input.amount,
      datePrecision: input.datePrecision,
      note: input.note,
    });
    refreshFinancialViews();
    return { id: created.id, valuedOn: created.valuedOn };
  },
});

export const correctValuationAction = financialAction({
  name: 'valuations.correct',
  input: (ctx) => positionInput.updateValuationInput(ctx.today),
  async handler({ input, ctx }) {
    const updated = await correctValuation(getServices().positions, ctx, {
      valuationId: input.valuationId,
      expectedVersion: input.expectedVersion,
      valuedOn: input.valuedOn,
      amount: input.amount,
      datePrecision: input.datePrecision,
      note: input.note,
    });
    refreshFinancialViews();
    return { id: updated.id, version: updated.version };
  },
});

export const deleteValuationAction = financialAction({
  name: 'valuations.delete',
  input: positionInput.deleteValuationInput,
  async handler({ input, ctx }) {
    await removeValuation(getServices().positions, ctx, input.valuationId);
    refreshFinancialViews();
    return { deleted: true } as const;
  },
});

/** Confirm a last-day snapshot as the month's statement balance (8.1, R15). */
export const confirmMonthEndAction = financialAction({
  name: 'valuations.confirmMonthEnd',
  input: positionInput.confirmMonthEndInput,
  async handler({ input, ctx }) {
    const updated = await confirmMonthEnd(getServices().positions, ctx, input);
    refreshFinancialViews();
    return { id: updated.id, version: updated.version };
  },
});

/** "Confirm unchanged for this month" (R22) — an explicit act, never a guess. */
export const confirmUnchangedAction = financialAction({
  name: 'valuations.confirmUnchanged',
  input: positionInput.confirmUnchangedInput,
  async handler({ input, ctx }) {
    const created = await confirmUnchanged(getServices().positions, ctx, input);
    refreshFinancialViews();
    return { id: created.id, valuedOn: created.valuedOn };
  },
});

/**
 * "Confirm all untouched as unchanged" (15.3, R22): the same act for several
 * accounts of one month, in one transaction — every one or none. The request
 * names accounts only; each amount is the account's previous statement, read
 * by the service, which judges every account's eligibility again.
 */
export const confirmUnchangedBatchAction = financialAction({
  name: 'valuations.confirmUnchangedBatch',
  input: positionInput.confirmUnchangedBatchInput,
  async handler({ input, ctx }) {
    const summary = await confirmUnchangedBatch(getServices().positions, ctx, input);
    refreshFinancialViews();
    return summary;
  },
});

/** Quick update (15.3): today's balances, one transaction, all or nothing. */
export const quickUpdateAction = financialAction({
  name: 'valuations.quickUpdate',
  input: positionInput.quickUpdateInput,
  async handler({ input, ctx }) {
    const summary = await quickUpdate(getServices().positions, ctx, { entries: input.entries });
    refreshFinancialViews();
    return summary;
  },
});

/**
 * Onboarding step 4 — the first cash account (spec §90; Phase 1 left steps 4
 * onwards to "the phases that give them something to ask about").
 *
 * It creates the account exactly as the accounts page does, then closes the
 * wizard. Balances entered during onboarding are dated **today** with `exact`
 * precision (15.2), which is why no month-end option appears here.
 */
export const onboardingFirstAccountAction = financialAction({
  name: 'onboarding.firstAccount',
  input: (ctx) =>
    z.object({
      account: positionInput.createCashAccountInput(ctx.today),
    }),
  async handler({ input, ctx }) {
    const services = getServices();
    const created = await createCashAccount(services.positions, ctx, {
      name: input.account.name,
      currency: input.account.currency,
      accountType: input.account.accountType,
      institution: input.account.institution,
      notes: input.account.notes,
      openedOn: input.account.origin === 'new' ? input.account.openedOn : null,
      openingBalance: input.account.openingBalance,
      openingBalanceOn: input.account.openingBalanceOn,
    });

    await markOnboardingCompleted(services.db, ctx.userId);
    refreshFinancialViews();
    revalidatePath('/onboarding', 'layout');
    return { id: created.id };
  },
});
