import { auditEntries } from '../schema/audit';
import type { Transaction } from '../client';

/**
 * Audited writes (blueprint 18.1, R12, T7).
 *
 * Every insert, update and delete of a source row is paired with an
 * `audit_entries` row **in the same transaction**. That is what makes the
 * blueprint's delete policy safe: financial rows are hard-deleted rather than
 * soft-flagged, and the before-image here is what remains — the record of what
 * the row said, what changed, who changed it and which request it belonged to.
 *
 * `app_user` holds INSERT and SELECT on `audit_entries` and nothing else
 * (migration 0005), so the role that performs a deletion cannot afterwards
 * remove the evidence of it.
 */

/** Who is writing, and which request it belongs to. */
export interface AuditContext {
  readonly userId: string;
  readonly requestId?: string;
  /** The user's own explanation of a correction, when they gave one. */
  readonly reason?: string;
}

export type AuditImage = Record<string, unknown>;

/**
 * The columns that changed between two images.
 *
 * Compared by their JSON form, so a `NUMERIC` that arrives as the string
 * `"8055.00000000"` both times is not reported as a change — and a genuine
 * change of `8055.00` to `8055.01` is.
 */
export function changedFields(
  before: AuditImage | undefined,
  after: AuditImage | undefined,
): string[] {
  if (before === undefined || after === undefined) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    // `updated_at` always changes and says nothing; leaving it out keeps the
    // list to the fields a person would want to read.
    if (key === 'updatedAt' || key === 'updated_at') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed.sort();
}

/** Values as JSON: `Decimal`-bearing columns already arrive as exact strings. */
function toImage(row: AuditImage | undefined): AuditImage | null {
  if (row === undefined) return null;
  return JSON.parse(JSON.stringify(row, (_key, value: unknown) =>
    value instanceof Date ? value.toISOString() : value,
  )) as AuditImage;
}

export interface AuditRecordInput {
  readonly entityTable: string;
  readonly entityId: string;
  readonly action: 'insert' | 'update' | 'delete';
  readonly before?: AuditImage;
  readonly after?: AuditImage;
}

/**
 * Write one audit row. Called by the repositories, inside the caller's
 * transaction — never by a service directly, so a mutation and its record
 * cannot come apart.
 */
export async function recordAudit(
  tx: Transaction,
  ctx: AuditContext,
  input: AuditRecordInput,
): Promise<void> {
  await tx.insert(auditEntries).values({
    userId: ctx.userId,
    actorUserId: ctx.userId,
    entityTable: input.entityTable,
    entityId: input.entityId,
    action: input.action,
    before: toImage(input.before),
    after: toImage(input.after),
    changedFields: changedFields(input.before, input.after),
    reason: ctx.reason ?? null,
    requestId: ctx.requestId ?? null,
  });
}
