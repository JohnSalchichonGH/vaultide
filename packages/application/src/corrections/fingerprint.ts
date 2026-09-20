import { createHash } from 'node:crypto';
import { identityKey, type IdentifiedSourceChange } from '../write-plan';
import type { CorrectionPreview, PeriodImpact, SourceScopeItem, StructuralChange } from './types';

/**
 * The consent fingerprint (ADR 0010 §12; §49–§53 of the slice prompt).
 *
 * One deterministic hash of the **semantic** preview: the resolved source facts
 * before and after, their identities and periods, each affected period's
 * structural state, the structural consequences, and the impact tags. Confirm
 * recomputes the whole thing from the newest committed state and compares. If
 * the world moved in a way that changes what the user was shown, the equality
 * fails and the ceremony asks again.
 *
 * ## It is a comparison, never an authority
 *
 * The browser sends a fingerprint back; it does not send an impact. A modified
 * or invented fingerprint merely fails equality — there is no value it could
 * hold that authorizes a write, because the only thing it is ever compared
 * against is a preview the server has just derived for itself (§53).
 *
 * ## Why the version prefix
 *
 * `hc-v1:` names the canonical schema this hash was taken over. A later slice
 * that adds a structural consequence changes what a fingerprint means, and an
 * old fingerprint must then fail rather than be silently reinterpreted as
 * though the new field had always been absent.
 *
 * ## What it deliberately excludes
 *
 * Everything that is not in `CorrectionPreview` is excluded by construction,
 * and that is the point: no reporting currency, no exchange rate or its
 * provenance, no reporting-currency value, no derived monetary total, no
 * rolling average, no chart point, no `created_at`/`updated_at`, no localized
 * string, no account or category **name**, no MonthReview or dismissal state,
 * no audit reason, and no generated database id for a row that does not exist
 * yet. Renaming a category, switching reporting currency, refreshing a rate or
 * dismissing an advisory therefore cannot invalidate a correction somebody is
 * in the middle of confirming.
 */

export const FINGERPRINT_VERSION = 'hc-v1';

/**
 * Stable JSON: object keys in sorted order, arrays in the order given.
 *
 * `JSON.stringify` emits object keys in insertion order, so two structurally
 * identical previews built by two different code paths could hash differently.
 * Arrays are **not** sorted here — the canonical form below sorts each
 * unordered collection deliberately, where the right ordering key is known, so
 * that a genuinely ordered list could never be silently reordered.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedChanges(changes: readonly IdentifiedSourceChange[]): IdentifiedSourceChange[] {
  return [...changes].sort((a, b) => byText(identityKey(a.identity), identityKey(b.identity)));
}

function sortedScope(scope: readonly SourceScopeItem[]): SourceScopeItem[] {
  return [...scope].sort((a, b) => byText(identityKey(a.identity), identityKey(b.identity)));
}

function sortedPeriods(periods: readonly PeriodImpact[]): PeriodImpact[] {
  return [...periods].sort((a, b) => byText(a.month, b.month));
}

function sortedStructural(changes: readonly StructuralChange[]): StructuralChange[] {
  return [...changes].sort((a, b) => byText(canonicalJson(a), canonicalJson(b)));
}

/** The canonical semantic form a fingerprint is taken over. */
export function canonicalPreview(preview: Omit<CorrectionPreview, 'fingerprint'>): string {
  return canonicalJson({
    version: FINGERPRINT_VERSION,
    sourceChanges: sortedChanges(preview.sourceChanges),
    sourceScope: sortedScope(preview.sourceScope),
    sourcePeriods: [...preview.sourcePeriods].sort(byText),
    periods: sortedPeriods(preview.periods),
    structuralChanges: sortedStructural(preview.structuralChanges),
  });
}

export function fingerprintOf(preview: Omit<CorrectionPreview, 'fingerprint'>): string {
  const digest = createHash('sha256').update(canonicalPreview(preview), 'utf8').digest('hex');
  return `${FINGERPRINT_VERSION}:${digest}`;
}

/** A preview with its own fingerprint attached. */
export function withFingerprint(
  preview: Omit<CorrectionPreview, 'fingerprint'>,
): CorrectionPreview {
  return { fingerprint: fingerprintOf(preview), ...preview };
}
