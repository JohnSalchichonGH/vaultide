'use server';

import { revalidatePath } from 'next/cache';
import {
  createCashTransfer,
  createExpenseEntry,
  createIncomeEntry,
  deleteCashTransfer,
  deleteExpenseEntry,
  deleteIncomeEntry,
  getServices,
  updateCashTransfer,
  updateExpenseEntry,
  updateIncomeEntry,
} from '@vaultide/application';
import { flowInput } from '@vaultide/validation';
import { financialAction } from './define';

/**
 * Income, expense and cash-transfer mutations (blueprint 6.2, 7.4, 15.3).
 *
 * **Every action in this file is declared with `financialAction`.** Each one
 * changes what a month's reconciliation, spending and savings will say, so the
 * session is validated against the session store rather than the five-minute
 * signed cookie cache: a revoked session loses the ability to write a flow
 * immediately, not eventually (ADR 0003).
 *
 * `financial-actions.test.ts` enumerates this directory and fails if an
 * exported action uses the ordinary wrapper without being on the explicit
 * non-financial list, so the rule is checked rather than merely observed.
 *
 * The schemas are functions of the context because the frozen rule "no actual
 * record may be dated after today" (M5) depends on the user's local today. A
 * request that bypasses the browser is judged by it, and then by the same rule
 * again in the domain services.
 */

function refreshFlowViews(): void {
  revalidatePath('/dashboard');
  revalidatePath('/accounts');
  revalidatePath('/', 'layout');
}

/* ------------------------------------------------------------------------- */
/* Income                                                                     */
/* ------------------------------------------------------------------------- */

export const createIncomeEntryAction = financialAction({
  name: 'flows.createIncomeEntry',
  input: (ctx) => flowInput.createIncomeEntryInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await createIncomeEntry(getServices().flows, ctx, {
      kind: input.kind,
      receivedOn: input.receivedOn,
      netAmount: input.netAmount,
      grossAmount: input.grossAmount,
      currency: input.currency,
      settlement: input.settlement,
      cashPositionId: input.cashPositionId ?? null,
      description: input.description,
      tags: input.tags,
      isOneOff: input.isOneOff,
    });
    refreshFlowViews();
    return { id: created.id };
  },
});

export const updateIncomeEntryAction = financialAction({
  name: 'flows.updateIncomeEntry',
  input: (ctx) => flowInput.updateIncomeEntryInput(ctx.today),
  async handler({ input, ctx }) {
    const updated = await updateIncomeEntry(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: updated.id, version: updated.version };
  },
});

export const deleteIncomeEntryAction = financialAction({
  name: 'flows.deleteIncomeEntry',
  input: flowInput.deleteIncomeEntryInput,
  async handler({ input, ctx }) {
    const removed = await deleteIncomeEntry(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: removed.id };
  },
});

/* ------------------------------------------------------------------------- */
/* Expenses                                                                   */
/* ------------------------------------------------------------------------- */

export const createExpenseEntryAction = financialAction({
  name: 'flows.createExpenseEntry',
  input: (ctx) => flowInput.createExpenseEntryInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await createExpenseEntry(getServices().flows, ctx, {
      categoryId: input.categoryId,
      incurredOn: input.incurredOn,
      amount: input.amount,
      currency: input.currency,
      settlement: input.settlement,
      cashPositionId: input.cashPositionId ?? null,
      description: input.description,
      tags: input.tags,
      isOneOff: input.isOneOff,
    });
    refreshFlowViews();
    return { id: created.id };
  },
});

export const updateExpenseEntryAction = financialAction({
  name: 'flows.updateExpenseEntry',
  input: (ctx) => flowInput.updateExpenseEntryInput(ctx.today),
  async handler({ input, ctx }) {
    const updated = await updateExpenseEntry(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: updated.id, version: updated.version };
  },
});

export const deleteExpenseEntryAction = financialAction({
  name: 'flows.deleteExpenseEntry',
  input: flowInput.deleteExpenseEntryInput,
  async handler({ input, ctx }) {
    const removed = await deleteExpenseEntry(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: removed.id };
  },
});

/* ------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* ------------------------------------------------------------------------- */

export const createTransferAction = financialAction({
  name: 'flows.createTransfer',
  input: (ctx) => flowInput.createTransferInput(ctx.today),
  async handler({ input, ctx }) {
    const created = await createCashTransfer(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: created.transfer.id, feeId: created.fee?.id ?? null };
  },
});

export const updateTransferAction = financialAction({
  name: 'flows.updateTransfer',
  input: (ctx) => flowInput.updateTransferInput(ctx.today),
  async handler({ input, ctx }) {
    const updated = await updateCashTransfer(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: updated.transfer.id, version: updated.transfer.version };
  },
});

export const deleteTransferAction = financialAction({
  name: 'flows.deleteTransfer',
  input: flowInput.deleteTransferInput,
  async handler({ input, ctx }) {
    const removed = await deleteCashTransfer(getServices().flows, ctx, input);
    refreshFlowViews();
    return { id: removed.transfer.id, feesRemoved: removed.fees.length };
  },
});
