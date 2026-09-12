import { moneyString } from '@vaultide/validation';
import { normalizeMoneyInput } from '@/lib/money-input';

/**
 * Autosave for Monthly's amount fields (blueprint 15.3 "every field autosaves on
 * blur with optimistic UI and version checks", 16.6, 20.3).
 *
 * The rules, and nothing that needs a browser, so they are tested as rules:
 *
 *  - leaving a field saves it only when it holds a valid amount that differs
 *    from the server's — exactly, as decimal strings, never as numbers;
 *  - clearing a field saves nothing: an amount is corrected or entered here,
 *    never deleted;
 *  - a save reports `saving`, then `saved`, `conflict` or `error`. Only a saved
 *    one asks the server for the page again; a conflict keeps what was typed and
 *    offers a reload, so nothing written elsewhere is silently overwritten.
 *
 * No figure is recomputed here. The server's result replaces the page after a
 * save; this only decides whether one happens and how it is reported.
 */

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export const IDLE: SaveState = { kind: 'idle' };

/** `true` while the field's entry must be flagged to assistive technology (16.6). */
export function isProblem(state: SaveState): boolean {
  return state.kind === 'invalid' || state.kind === 'conflict' || state.kind === 'error';
}

/** A decimal string in one canonical spelling — for comparison only, never for display. */
export function canonicalDecimal(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return null;
  const integer = (match[2] as string).replace(/^0+(?=\d)/u, '');
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  const body = fraction === '' ? integer : `${integer}.${fraction}`;
  return body === '0' ? '0' : `${match[1] as string}${body}`;
}

/** Whether two decimal strings are the same amount, compared exactly. */
export function sameDecimal(a: string, b: string): boolean {
  const left = canonicalDecimal(a);
  return left !== null && left === canonicalDecimal(b);
}

/**
 * An exact amount as a field shows it: every digit kept, and padded with zeros
 * to the currency's minor units. It is never rounded — a field that rounded the
 * stored figure would save the rounding the moment it lost focus.
 */
export function fieldValueOf(amount: string, minorUnits: number): string {
  const match = /^(-?\d+)(?:\.(\d+))?$/u.exec(amount.trim());
  if (match === null || minorUnits <= 0) return amount;
  const fraction = match[2] ?? '';
  return `${match[1] as string}.${fraction.padEnd(minorUnits, '0')}`;
}

export type BlurDecision =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'save'; readonly amount: string };

/**
 * What leaving a field means.
 *
 * `saved` is the server's amount for the field, or `null` when there is none
 * yet. The amount is validated with the same schema the server uses, scaled to
 * the currency's minor units, and sent as the exact string that was typed.
 */
export function decideOnBlur(input: {
  readonly draft: string;
  readonly saved: string | null;
  readonly minorUnits: number;
}): BlurDecision {
  const amount = normalizeMoneyInput(input.draft);
  if (amount === '') return { kind: 'unchanged' };

  const parsed = moneyString({ minorUnits: input.minorUnits }).safeParse(amount);
  if (!parsed.success) {
    return { kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'Enter an amount.' };
  }
  if (input.saved !== null && sameDecimal(amount, input.saved)) return { kind: 'unchanged' };
  return { kind: 'save', amount };
}

/** A server action's result, as far as a save needs it. */
export type SaveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/**
 * The state a finished save leaves. A version conflict and a duplicate are the
 * two ways of learning the server holds something newer (20.2, 20.3): neither is
 * retried, and neither refreshes the page over what was typed.
 */
export function outcomeState(outcome: SaveOutcome): SaveState {
  if (outcome.ok) return { kind: 'saved' };
  const { code, message } = outcome.error;
  return code === 'CONFLICT_VERSION' || code === 'CONFLICT_DUPLICATE'
    ? { kind: 'conflict', message }
    : { kind: 'error', message };
}

const UNREACHABLE =
  'The balance could not be saved — the server did not answer. Check your connection and try again.';

/**
 * Run one save, reporting each state it passes through, and refresh the page
 * from the server once it has been written (15.3: "the server's result replaces
 * it after save").
 */
export async function runSave(
  send: () => Promise<SaveOutcome>,
  report: (state: SaveState) => void,
  refresh: () => void,
): Promise<SaveState> {
  report({ kind: 'saving' });
  let final: SaveState;
  try {
    final = outcomeState(await send());
  } catch {
    final = { kind: 'error', message: UNREACHABLE };
  }
  report(final);
  if (final.kind === 'saved') refresh();
  return final;
}

/** The words a field's state announces (16.6: `aria-live="polite"` for autosave). */
export function saveStateText(state: SaveState): string {
  switch (state.kind) {
    case 'idle':
      return '';
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved.';
    case 'invalid':
    case 'error':
      return state.message;
    case 'conflict':
      return `${state.message} Nothing was overwritten.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Row drafts (15.3, 20.3)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a row holds that the server has not accepted.
 *
 * A control whose value comes straight from the server prop has no way to show
 * a refused edit: the moment the save fails, the field re-renders as whatever
 * the server still says, and what the user chose is gone with no trace. So
 * every autosaved control reads `draft ?? server` instead, and these two
 * functions decide when a draft stops being the truth.
 */
export type FieldDrafts = Readonly<Record<string, unknown>>;

/** A row may not start a second write while one is in flight (20.3). */
export function canWrite(state: SaveState): boolean {
  return state.kind !== 'saving';
}

/**
 * The drafts a row keeps once a save has finished.
 *
 * Only a **success** hands its own fields back to the server — the row now
 * matches what was sent, so holding the draft would shadow the authoritative
 * value the refresh brings. A conflict or an error keeps every draft, including
 * the fields this write tried: nothing was stored, so the user's attempt is
 * still the only place those values exist, and discarding them would lose work
 * to a failure the user did not cause.
 *
 * Fields this write did not touch survive either way. A date refused a moment
 * ago is still unsaved after an unrelated amount saves.
 */
export function draftsAfterSave(
  drafts: FieldDrafts,
  savedFields: readonly string[],
  final: SaveState,
): FieldDrafts {
  if (final.kind !== 'saved') return drafts;
  const next: Record<string, unknown> = { ...drafts };
  for (const field of savedFields) delete next[field];
  return next;
}

/** Drop one draft without writing: what was typed is the server's value again. */
export function withoutDraft(drafts: FieldDrafts, field: string): FieldDrafts {
  const next: Record<string, unknown> = { ...drafts };
  delete next[field];
  return next;
}
