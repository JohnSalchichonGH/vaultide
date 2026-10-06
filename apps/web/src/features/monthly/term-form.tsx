import type { OccurrenceTermDto } from '@vaultide/application';
import { outcomeState, type SaveOutcome } from '@/features/monthly/autosave';

/**
 * What the two "Change future amount" forms share — Income's and Known
 * expenses' (§30.9 item 4, 20.3) — about the term a save claims.
 *
 * `setTemplateTerm` replaces the whole term at the occurrence's date, so a save
 * states what it expects to find there: no term yet, or that exact row's
 * version. A server action's response can bring a fresh page while the form is
 * open, so the form keeps the term it opened with as its own copy — the base —
 * and every save claims the base, never whatever term the page holds by then. A
 * newer term is taken in only while nothing holds the form: nothing typed, no
 * save refused, none running. Otherwise only Reload moves the base, and a
 * conflict is shown as the server worded it; the save is never re-aimed at the
 * newer version by itself.
 */

type ExactTerm = OccurrenceTermDto['exact'];

/** What a term save expects at its date (`setTemplateTerm`'s `expected`). */
export type TermExpectation =
  | { readonly state: 'absent' }
  | { readonly state: 'version'; readonly version: number };

/** The expectation a save claims: the base's, which is the term the form opened with or last took in. */
export const termExpectation = (base: ExactTerm): TermExpectation =>
  base.state === 'absent' ? { state: 'absent' } : { state: 'version', version: base.version };

const termKeyOf = (exact: ExactTerm): string =>
  exact.state === 'absent' ? 'absent' : `${exact.termId}@${String(exact.version)}`;

/**
 * Whether an open term form takes in a newer copy of the term at its date.
 *
 * Only while the user has changed nothing since the form opened or last took
 * one in, no save has been refused and none is running. Otherwise what was
 * typed stays, and so does what a save claims, until the user chooses Reload.
 */
export function adoptsNewerTerm(args: {
  readonly base: ExactTerm;
  readonly latest: ExactTerm;
  readonly edited: boolean;
  readonly refused: boolean;
  readonly saving: boolean;
}): boolean {
  return termKeyOf(args.latest) !== termKeyOf(args.base) && !args.edited && !args.refused && !args.saving;
}

/** A refused term save, or one that met a newer term: the server's message, as it came. */
export interface TermProblem {
  readonly kind: 'refused' | 'conflict';
  readonly message: string;
}

/**
 * `CONFLICT_VERSION` (the term changed) and `CONFLICT_DUPLICATE` (a term now
 * starts there) both mean the server holds something newer; only they offer
 * Reload.
 */
export function termProblemOf(outcome: Extract<SaveOutcome, { readonly ok: false }>): TermProblem {
  const state = outcomeState(outcome);
  return { kind: state.kind === 'conflict' ? 'conflict' : 'refused', message: outcome.error.message };
}

const NEGATIVE = 'text-[length:var(--text-meta)] text-[var(--color-negative)]';
const ACTION =
  'min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';

/** A term form's problem: the message, and Reload where the server holds a newer term. */
export function TermProblemText({
  problem,
  testId,
  onReload,
}: {
  readonly problem: TermProblem | null;
  readonly testId: string;
  readonly onReload: () => void;
}) {
  if (problem === null) return null;
  return (
    <div role="alert" className="space-y-2" data-testid={testId} data-kind={problem.kind}>
      <p className={NEGATIVE}>{problem.message}</p>
      {problem.kind === 'conflict' ? (
        <button type="button" className={ACTION} data-testid={`${testId}-reload`} onClick={onReload}>
          Reload
        </button>
      ) : null}
    </div>
  );
}
