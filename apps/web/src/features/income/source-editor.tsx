'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CorrectionDraft, IncomeSourceDto, OccurrenceTermDto } from '@vaultide/application';
import {
  archiveTemplateAction,
  unarchiveTemplateAction,
  updateTemplateAction,
} from '@/server/actions/recurring';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { CorrectionHost } from '@/features/corrections/host';
import { runCorrectableSave } from '@/features/corrections/save';
import { useCorrection } from '@/features/corrections/use-correction';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';
import {
  endDateChangeOf,
  endDateChangeSummary,
  reachesCompletedMonth,
} from '@/features/monthly/expenses-presentation';
import { ChangeFutureAmount } from '@/features/monthly/income-editor';
import {
  ARCHIVE_CONSEQUENCES,
  UNARCHIVE_NOTE,
  adoptsNewerSource,
  detailsFormOf,
  detailsPayload,
  detailsUnchanged,
  editProblemOf,
  type DetailsForm,
  type EditProblem,
} from '@/features/income/source-presentation';

/**
 * The Income source page's edits (blueprint 15.2 "Income source", v2.1.20
 * 30.23; ADR 0012 D4).
 *
 * Every one is an action that already exists, behind `financialAction` (ADR
 * 0003), and the server judges all of it again: `updateTemplateDetails` for the
 * name, payer and end date, `archiveTemplate` and `unarchiveTemplate`, and
 * `setTemplateTerm` through Monthly's own "Change future amount" form. The
 * schedule, kind, currency and account are not offered: they decide what the
 * source's past occurrences were (6.2's frozen identity).
 *
 * One edit here can be a Historical Correction: an end date that adds or
 * removes an expected occurrence in a finished month (ADR 0013 §2). The end
 * date therefore saves through the review, and the server judges it again. The
 * name, the payer, a term and archiving never are corrections.
 *
 * ## Drafts
 *
 * The page keys each editor on the source's id, never its version. Each keeps
 * the stored source it opened with, and its save claims that version (20.3). A
 * newer copy arriving with any action's response is taken in only while the
 * user has changed nothing, no save was refused and none is running; on a
 * conflict the form shows the server's message and a Reload, and the save is
 * never re-aimed at the newer version by itself.
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';
const ACTION =
  'min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';
const PRIMARY = cn(ACTION, 'border-transparent bg-[var(--color-accent)] text-[var(--color-accent-foreground)]');

/** The stored source a form opened with, and how it moves (see "Drafts" above). */
function useStoredSource(latest: IncomeSourceDto, held: boolean) {
  const [base, setBase] = useState(latest);
  const [problem, setProblem] = useState<EditProblem | null>(null);
  const adopt = adoptsNewerSource({ base, latest, held: held || problem !== null });
  if (adopt) setBase(latest);
  return {
    base: adopt ? latest : base,
    problem,
    setProblem,
    /** Typing or stepping back clears a refusal; a conflict stays until Reload. */
    clearRefusal: () => {
      setProblem((current) => (current?.kind === 'refused' ? null : current));
    },
    /** Reload: the newest copy this page holds, and whatever newer one the refresh brings. */
    rebase: () => {
      setBase(latest);
      setProblem(null);
    },
  };
}

function ProblemText({ problem, onReload, testId }: { readonly problem: EditProblem | null; readonly onReload: () => void; readonly testId: string }) {
  if (problem === null) return null;
  return (
    <div role="alert" className="space-y-2" data-testid={testId} data-kind={problem.kind}>
      <p className="text-[length:var(--text-meta)] text-[var(--color-negative)]">{problem.message}</p>
      {problem.kind === 'conflict' ? (
        <button type="button" className={ACTION} data-testid={`${testId}-reload`} onClick={onReload}>
          Reload
        </button>
      ) : null}
    </div>
  );
}

function Saved({ children, testId }: { readonly children: ReactNode; readonly testId: string }) {
  return (
    <p role="status" aria-live="polite" className={META} data-testid={testId}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Name and payer                                                              */
/* -------------------------------------------------------------------------- */

export function SourceNameAndPayer({ source }: { readonly source: IncomeSourceDto }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const ids = { name: useId(), payer: useId() };
  const [form, setForm] = useState<DetailsForm & { readonly edited: boolean }>(() => ({
    ...detailsFormOf(source),
    edited: false,
  }));
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const stored = useStoredSource(source, form.edited || pending);
  const { base } = stored;
  // Taking in a newer copy resets the fields to it; nothing typed is lost,
  // because a newer copy is only taken in while nothing was typed.
  const [shown, setShown] = useState(base.version);
  if (shown !== base.version) {
    setShown(base.version);
    setForm({ ...detailsFormOf(base), edited: false });
  }

  const unchanged = detailsUnchanged(base, form);
  const conflict = stored.problem?.kind === 'conflict';
  const change = (next: Partial<DetailsForm>): void => {
    setSaved(false);
    stored.clearRefusal();
    setForm((current) => ({ ...current, ...next, edited: true }));
  };

  return (
    <form
      className="space-y-3"
      data-testid="source-details-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (unchanged || pending || conflict) return;
        if (form.name.trim() === '') {
          stored.setProblem({ kind: 'refused', message: 'Enter a name.' });
          return;
        }
        stored.setProblem(null);
        const payload = detailsPayload(base, form);
        startTransition(async () => {
          const result = await updateTemplateAction(payload);
          if (!result.ok) {
            stored.setProblem(editProblemOf(result.error));
            return;
          }
          setForm((current) => ({ ...current, edited: false }));
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.name}>Name</Label>
          <Input
            id={ids.name}
            data-testid="source-edit-name"
            value={form.name}
            maxLength={120}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.payer}>Payer</Label>
          <Input
            id={ids.payer}
            data-testid="source-edit-payer"
            value={form.payer}
            maxLength={120}
            onChange={(event) => {
              change({ payer: event.target.value });
            }}
          />
        </div>
      </div>
      <ProblemText
        problem={stored.problem}
        testId="source-details-problem"
        onReload={() => {
          stored.rebase();
          setShown(source.version);
          setForm({ ...detailsFormOf(source), edited: false });
          router.refresh();
        }}
      />
      {saved ? <Saved testId="source-details-saved">Saved.</Saved> : null}
      <button type="submit" className={PRIMARY} data-testid="source-details-save" disabled={!hydrated || pending || unchanged || conflict}>
        {pending ? 'Saving…' : 'Save name and payer'}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* End date                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The source's end date, reviewed before it is written (6.2, §30.10).
 *
 * Known expenses' `EndsOn`, for an income source: the confirmation's sentences
 * come from the same helpers, measured against dates the read generated, and
 * the service's refusal — an end before an occurrence already recorded or
 * skipped — is shown as it was given.
 *
 * One confirmation per save, never two. A change that reaches a finished month
 * is a Historical Correction (ADR 0013 §2), so the review replaces this page's
 * own confirmation. Any other change keeps that confirmation, and its Confirm
 * still asks the server first: a month that has ended since the page loaded
 * opens the review then.
 */
export function SourceEndDate({ source, locale }: { readonly source: IncomeSourceDto; readonly locale: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const dateId = useId();
  const [date, setDate] = useState(source.endDate ?? '');
  const [edited, setEdited] = useState(false);
  const [proposal, setProposal] = useState<{ readonly endDate: string | null } | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const correction = useCorrection();
  const stored = useStoredSource(source, edited || proposal !== null || pending || correction.pending !== null);
  const { base } = stored;
  // A newer copy taken in resets the field to it; it is only taken in while
  // nothing was typed.
  const [shown, setShown] = useState(base.version);
  if (shown !== base.version) {
    setShown(base.version);
    setDate(base.endDate ?? '');
  }
  const day = (value: string): string => dayTitle(value, locale);
  const change = proposal === null ? null : endDateChangeOf(base, proposal.endDate);

  const settled = (endDate: string | null): void => {
    setProposal(null);
    setEdited(false);
    setDate(endDate ?? '');
    setSaved(true);
    router.refresh();
  };

  // Ask the server first, then save it or open the review (§25). The draft and
  // the save claim the same version, the one this form opened with.
  const save = (endDate: string | null): void => {
    stored.setProblem(null);
    const draft: CorrectionDraft = {
      kind: 'template_end_date',
      templateId: base.templateId,
      expectedVersion: base.version,
      endDate,
    };
    startTransition(async () => {
      const final = await runCorrectableSave(
        correction,
        draft,
        () => updateTemplateAction({ templateId: base.templateId, expectedVersion: base.version, endDate }),
        () => undefined,
        () => undefined,
      );
      if (final.kind === 'saved') {
        settled(endDate);
      } else if (final.kind === 'conflict' || final.kind === 'error') {
        stored.setProblem({ kind: final.kind === 'conflict' ? 'conflict' : 'refused', message: final.message });
      } else {
        // The review is open, and it is the one confirmation this save gets.
        setProposal(null);
      }
    });
  };

  // Straight to the review when the change reaches a finished month, so the
  // page's own confirmation is never shown in front of it.
  const propose = (endDate: string | null): void => {
    stored.clearRefusal();
    if (reachesCompletedMonth(endDateChangeOf(base, endDate))) {
      save(endDate);
      return;
    }
    setProposal({ endDate });
  };

  return (
    <div className="space-y-3" data-testid="source-end-date">
      <p className={META}>
        {base.endDate === null ? 'It has no end date, so it goes on.' : `It ends on ${day(base.endDate)}.`} An end date
        says the source genuinely stopped; archiving does not.
      </p>

      {proposal === null || change === null || change.kind === 'unchanged' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={dateId}>Ends on</Label>
            <Input
              id={dateId}
              data-testid="source-end-date-input"
              type="date"
              min={base.startDate}
              value={date}
              className="tabular sm:w-48"
              onChange={(event) => {
                setDate(event.target.value);
                setEdited(true);
                setSaved(false);
                stored.clearRefusal();
              }}
            />
          </div>
          <ProblemText
            problem={stored.problem}
            testId="source-end-problem"
            onReload={() => {
              stored.rebase();
              setEdited(false);
              setShown(source.version);
              setDate(source.endDate ?? '');
              router.refresh();
            }}
          />
          {saved ? <Saved testId="source-end-saved">End date saved.</Saved> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="source-end-review"
              className={PRIMARY}
              disabled={!hydrated || pending || date === '' || date === base.endDate}
              onClick={() => {
                propose(date);
              }}
            >
              {pending ? 'Saving…' : 'Review change'}
            </button>
            {base.endDate === null ? null : (
              <button
                type="button"
                data-testid="source-end-clear"
                className={ACTION}
                disabled={!hydrated || pending}
                onClick={() => {
                  propose(null);
                }}
              >
                Remove end date
              </button>
            )}
          </div>
        </>
      ) : (
        <div role="group" aria-label="Confirm the change" data-testid="source-end-confirmation" className="space-y-2">
          {endDateChangeSummary(change, {
            source: base.name,
            day,
            month: (value) => monthTitle(value, locale),
          }).map((sentence) => (
            <p key={sentence} className="text-[length:var(--text-meta)]">
              {sentence}
            </p>
          ))}
          <ProblemText
            problem={stored.problem}
            testId="source-end-problem"
            onReload={() => {
              stored.rebase();
              setProposal(null);
              setEdited(false);
              setShown(source.version);
              setDate(source.endDate ?? '');
              router.refresh();
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="source-end-confirm"
              className={PRIMARY}
              disabled={!hydrated || pending || stored.problem !== null}
              onClick={() => {
                save(proposal.endDate);
              }}
            >
              {pending ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              data-testid="source-end-back"
              className={ACTION}
              disabled={pending}
              onClick={() => {
                stored.clearRefusal();
                setProposal(null);
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}

      <CorrectionHost
        flow={correction}
        labels={{ accounts: {}, categories: {}, locale, templates: { [base.templateId]: base.name } }}
        onCommitted={() => {
          // The draft just confirmed holds the end date it wrote.
          const draft = correction.pending?.draft;
          settled(draft?.kind === 'template_end_date' ? draft.endDate : base.endDate);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Archive and unarchive                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Archive, after saying what it does; unarchive in one step (§30.10 item 2).
 *
 * Archiving is always allowed and keeps every row; it is not a delete, and
 * there is no delete here.
 */
export function SourceArchive({ source }: { readonly source: IncomeSourceDto }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const stored = useStoredSource(source, confirming || pending);
  const { base } = stored;

  const run = (action: typeof archiveTemplateAction): void => {
    stored.setProblem(null);
    const payload = { templateId: base.templateId, expectedVersion: base.version };
    startTransition(async () => {
      const result = await action(payload);
      if (!result.ok) {
        stored.setProblem(editProblemOf(result.error));
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  };
  const reload = (): void => {
    stored.rebase();
    setConfirming(false);
    router.refresh();
  };

  if (base.archived) {
    return (
      <div className="space-y-2" data-testid="source-archive" data-archived="true">
        <p className={META}>{UNARCHIVE_NOTE}</p>
        <ProblemText problem={stored.problem} testId="source-archive-problem" onReload={reload} />
        <button
          type="button"
          className={PRIMARY}
          data-testid="source-unarchive"
          disabled={!hydrated || pending || stored.problem?.kind === 'conflict'}
          onClick={() => {
            run(unarchiveTemplateAction);
          }}
        >
          {pending ? 'Unarchiving…' : 'Unarchive'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="source-archive" data-archived="false">
      {confirming ? (
        <div role="group" aria-label="Confirm archiving" className="space-y-2" data-testid="source-archive-confirmation">
          <p className="text-[length:var(--text-meta)] font-medium">Archiving {base.name}:</p>
          <ul className="list-disc space-y-1 pl-5 text-[length:var(--text-meta)]">
            {ARCHIVE_CONSEQUENCES.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
          <ProblemText problem={stored.problem} testId="source-archive-problem" onReload={reload} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={PRIMARY}
              data-testid="source-archive-confirm"
              disabled={!hydrated || pending || stored.problem !== null}
              onClick={() => {
                run(archiveTemplateAction);
              }}
            >
              {pending ? 'Archiving…' : 'Archive'}
            </button>
            <button
              type="button"
              className={ACTION}
              data-testid="source-archive-cancel"
              disabled={pending}
              onClick={() => {
                stored.clearRefusal();
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <ProblemText problem={stored.problem} testId="source-archive-problem" onReload={reload} />
          <button
            type="button"
            className={ACTION}
            data-testid="source-archive-start"
            disabled={!hydrated || stored.problem?.kind === 'conflict'}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Archive…
          </button>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Change the amount from…                                                     */
/* -------------------------------------------------------------------------- */

/**
 * "Change the amount from…" on one occurrence's row: Monthly's own form,
 * shared, so the new amount starts at this occurrence's scheduled date and
 * claims the term the row was read with (§30.9 item 4; ADR 0012 D4). Payments
 * already recorded keep their amounts.
 */
export function ChangeAmountFrom({
  templateId,
  occurrenceDate,
  currency,
  term,
  formatting,
}: {
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly currency: string;
  readonly term: OccurrenceTermDto;
  readonly formatting: Formatting;
}) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        data-testid="source-change-amount"
        className={ACTION}
        disabled={!hydrated}
        aria-expanded={open}
        aria-label={`Change the amount from ${dayTitle(occurrenceDate, formatting.locale)}`}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        Change the amount from here
      </button>
      {open ? (
        <ChangeFutureAmount
          templateId={templateId}
          occurrenceDate={occurrenceDate}
          currency={currency}
          term={term}
          formatting={formatting}
          onDone={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
