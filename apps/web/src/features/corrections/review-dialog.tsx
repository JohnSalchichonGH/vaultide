'use client';

import { useId, useState } from 'react';
import type { CorrectionDraft, CorrectionPreview } from '@vaultide/application';
import { confirmHistoricalCorrectionAction } from '@/server/actions/corrections';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import {
  IMPACT_TAG_LABEL,
  describeStructuralChange,
  interpretConfirm,
  rewritesDormancy,
  summarizeBulk,
  summarizePeriods,
  reviewAccountNames,
  summarizeSources,
  type CorrectionLabels,
  type PeriodSummary,
  type ReviewOutcome,
} from './presentation';

/**
 * Review changes → Confirm correction (blueprint 15.3, 16.5, 16.6; ADR 0010).
 *
 * The dialog is **read-only except for three things**: the optional reason,
 * Back, and Confirm. It is not a second editor — the user edited in the editor
 * they already know, and Back returns them to it with their draft exactly as
 * they left it (§66, §67).
 *
 * What it shows is what the server derived: the source before → after, the
 * months that will be recalculated, the structural consequences, and the coarse
 * families of figure that move. It predicts no totals, because it was never
 * given any (§35).
 *
 * `impact_changed` is handled here rather than surfaced as an error. The world
 * moved while the user was reading; nothing was written; the dialog re-renders
 * from the fresh preview, keeps the reason they typed, and asks again (§70).
 */

const SECTION = 'border-t px-4 py-3 sm:px-6';
const HEADING = 'text-[length:var(--text-meta)] font-medium text-[var(--color-muted-foreground)]';
const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';

export interface CorrectionReviewProps {
  readonly draft: CorrectionDraft;
  readonly preview: CorrectionPreview;
  readonly labels: CorrectionLabels;
  /** Return to the editor with the draft untouched. */
  readonly onBack: () => void;
  readonly onCommitted: () => void;
  /**
   * Told when a Confirm wrote nothing — the impact moved, or the save was
   * refused — so an editor that holds many unsaved cells can take in the
   * newer state behind the dialog (ADR 0011 D9). Optional: a single-record
   * editor has nothing to rebase.
   */
  readonly onSettled?: ((outcome: Exclude<ReviewOutcome, { kind: 'committed' }>) => void) | undefined;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'error'; readonly message: string; readonly conflict: boolean };

export function CorrectionReview({
  draft,
  preview: initial,
  labels,
  onBack,
  onCommitted,
  onSettled,
}: CorrectionReviewProps) {
  const [preview, setPreview] = useState(initial);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const reasonId = useId();
  const statusId = useId();

  const bulk = draft.kind === 'bulk_history';
  const sources = bulk ? [] : summarizeSources(preview, labels);
  const names = reviewAccountNames(preview, labels);
  const periods = summarizePeriods(preview, labels);
  const busy = state.kind === 'saving';

  const confirm = async (): Promise<void> => {
    setState({ kind: 'saving' });
    const result = await confirmHistoricalCorrectionAction({
      draft,
      fingerprint: preview.fingerprint,
      ...(reason.trim() === '' ? {} : { reason }),
    });

    const outcome = interpretConfirm(result);
    if (outcome.kind === 'error') {
      setState({ kind: 'error', message: outcome.message, conflict: outcome.conflict });
      onSettled?.(outcome);
      return;
    }
    if (outcome.kind === 'stale') {
      // Nothing was written. Show the fresh impact and ask again; the reason
      // they typed is theirs, is not part of the consent, and survives.
      setPreview(outcome.preview);
      setState({ kind: 'stale' });
      onSettled?.(outcome);
      return;
    }
    setState({ kind: 'idle' });
    onCommitted();
  };

  return (
    <Modal title="Review changes" busy={busy} testId="correction-review" onClose={onBack}>
      <div data-testid="correction-review-body">
        {state.kind === 'stale' ? (
          <p
            className={cn(SECTION, 'text-[var(--color-warning-foreground)]')}
            role="status"
            data-testid="correction-stale"
          >
            Financial data changed since you reviewed this correction. Review the updated impact
            before confirming again.
          </p>
        ) : null}

        <p className={cn(SECTION, META)} data-testid="correction-intro">
          {bulk
            ? 'Every Bulk history save is reviewed before anything is written. Vaultide will recalculate the months these changes reach once you confirm.'
            : rewritesDormancy(preview)
              ? 'This changes a period an account was recorded as dormant over. Vaultide will recalculate that history once you confirm.'
              : 'This changes a month that is already closed. Vaultide will recalculate that history once you confirm.'}
        </p>

        {bulk ? <BulkSummary preview={preview} labels={labels} names={names} /> : null}

        {/* --- the source, before and after ------------------------------- */}
        {sources.map((source, index) => (
          <section className={SECTION} key={`${source.title}-${String(index)}`}>
            <h4 className={HEADING}>
              {source.title}
              {source.operation === 'delete' ? ' · removed' : ''}
              {source.operation === 'create' ? ' · added' : ''}
            </h4>
            <dl className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-[length:var(--text-table)]">
              <span className={META} aria-hidden="true" />
              <span className={META}>Before</span>
              <span className={META}>After</span>
              {source.fields.map((field) => (
                <div
                  key={field.label}
                  className="contents"
                  data-testid="correction-field"
                  data-field={field.label}
                  data-changed={field.changed ? 'true' : 'false'}
                >
                  <dt className={META}>{field.label}</dt>
                  <dd
                    className={cn(
                      'tabular',
                      field.changed && 'text-[var(--color-muted-foreground)] line-through',
                    )}
                    data-testid="correction-before"
                  >
                    {field.before ?? '—'}
                  </dd>
                  <dd
                    className={cn('tabular', field.changed && 'font-medium')}
                    data-testid="correction-after"
                  >
                    {field.after ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        {/* --- the months it recalculates --------------------------------- */}
        {bulk ? (
          <details className={SECTION} data-testid="correction-periods-group">
            <summary className={cn(HEADING, 'cursor-pointer')}>
              Months Vaultide will recalculate ({String(periods.length)})
            </summary>
            <PeriodList periods={periods} />
          </details>
        ) : (
          <section className={SECTION}>
            <h4 className={HEADING}>Months Vaultide will recalculate</h4>
            <PeriodList periods={periods} />
          </section>
        )}

        {/* --- what changes that is not a figure -------------------------- */}
        {!bulk && preview.structuralChanges.length > 0 ? (
          <section className={SECTION}>
            <h4 className={HEADING}>What else changes</h4>
            <ul className="mt-2 flex flex-col gap-1" data-testid="correction-structural">
              {preview.structuralChanges.map((change, index) => (
                <li key={`${change.kind}-${String(index)}`} className="text-[length:var(--text-table)]">
                  {describeStructuralChange(change, labels, names)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- the reason ------------------------------------------------- */}
        <section className={SECTION}>
          <label htmlFor={reasonId} className={HEADING}>
            Why are you changing this? (optional)
          </label>
          <input
            id={reasonId}
            data-testid="correction-reason"
            value={reason}
            maxLength={500}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-[length:var(--text-table)]"
          />
        </section>

        <p
          id={statusId}
          role="status"
          aria-live="polite"
          data-testid="correction-error"
          className={cn(
            'px-4 sm:px-6',
            state.kind === 'error' ? 'text-[var(--color-negative)]' : 'sr-only',
          )}
        >
          {state.kind === 'error'
            ? state.conflict
              ? bulk
                ? 'A cell in this save changed after you opened the grid, so nothing was saved. Go back to see which.'
                : 'This record changed after you opened it. Close this and reload to see what it says now.'
              : state.message
            : ''}
        </p>

        <div className="flex justify-end gap-2 border-t px-4 py-3 sm:px-6">
          <button
            type="button"
            data-testid="correction-back"
            disabled={busy}
            onClick={onBack}
            className="min-h-9 rounded-[var(--radius-control)] border px-3 text-[length:var(--text-table)] disabled:opacity-60"
          >
            Back
          </button>
          <button
            type="button"
            data-testid="correction-confirm"
            disabled={busy}
            aria-describedby={statusId}
            onClick={() => {
              void confirm();
            }}
            className="min-h-9 rounded-[var(--radius-control)] border bg-[var(--color-foreground)] px-3 text-[length:var(--text-table)] font-medium text-[var(--color-surface)] disabled:opacity-60"
          >
            {busy ? 'Confirming…' : 'Confirm correction'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The months a correction recalculates, one line each. */
function PeriodList({ periods }: { readonly periods: readonly PeriodSummary[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-2" data-testid="correction-periods">
      {periods.map((period) => (
        <li key={period.month} data-testid="correction-period" data-month={period.month}>
          <span className="font-medium">{period.title}</span>
          <span className={cn('ml-2', META)}>
            {period.isSource ? 'this record’s month' : 'also recalculated'}
          </span>
          {period.tags.length > 0 ? (
            <span className={cn('ml-2', META)} data-testid="correction-tags">
              {period.tags.map((tag) => IMPACT_TAG_LABEL[tag]).join(' · ')}
            </span>
          ) : null}
          {period.note === null ? null : (
            <span className={cn('mt-0.5 block', META)} data-testid="correction-period-note">
              {period.note}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A Bulk History save at a glance (ADR 0011 D10): the counts and the months it
 * spans, then one line per account and per income source that opens onto every
 * record it holds. Nothing is truncated — a group closed is a group folded, not
 * a group cut short.
 */
function BulkSummary({
  preview,
  labels,
  names,
}: {
  readonly preview: CorrectionReviewProps['preview'];
  readonly labels: CorrectionLabels;
  readonly names: ReadonlyMap<string, string>;
}) {
  const summary = summarizeBulk(preview, labels, names);
  return (
    <section className={SECTION} data-testid="bulk-review-summary">
      <h4 className={HEADING}>What this save changes</h4>
      <p className="mt-1 text-[length:var(--text-table)] font-medium" data-testid="bulk-review-headline">
        {summary.headline}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {summary.groups.map((group) => (
          <li key={group.key}>
            <details data-testid="bulk-review-group" data-group={group.key}>
              <summary className="cursor-pointer text-[length:var(--text-table)]">
                <span className="font-medium">{group.title}</span>
                <span className={cn('ml-2', META)}>{group.line}</span>
              </summary>
              <ul className="mt-1 ml-4 flex flex-col gap-0.5" data-testid="bulk-review-entries">
                {group.entries.map((entry, index) => (
                  <li key={`${group.key}-${String(index)}`} className={cn('tabular', META)}>
                    {entry}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      {summary.otherChanges.length > 0 ? (
        <details className="mt-2" data-testid="bulk-review-other">
          <summary className={cn(HEADING, 'cursor-pointer')}>
            Other consequences ({String(summary.otherChanges.length)})
          </summary>
          <ul className="mt-1 ml-4 flex flex-col gap-0.5" data-testid="correction-structural">
            {summary.otherChanges.map((change, index) => (
              <li key={`${change.kind}-${String(index)}`} className="text-[length:var(--text-table)]">
                {describeStructuralChange(change, labels, names)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
