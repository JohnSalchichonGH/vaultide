import { sql, type SQL } from 'drizzle-orm';
import { check, foreignKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PositionKind } from '@vaultide/validation';
import { positions } from './positions';

/**
 * Each kind as a literal SQL fragment.
 *
 * Written out rather than interpolated: a CHECK constraint needs a literal in
 * its expression, and interpolating a JavaScript string into a `sql` template
 * would produce a bound parameter instead. `sql.raw` would do it too and is
 * banned outside migrations for good reason, so the five constants are simply
 * spelled out — the compiler still requires every `PositionKind` to appear.
 */
const KIND_LITERAL: Readonly<Record<PositionKind, SQL>> = {
  cash: sql`'cash'`,
  investment: sql`'investment'`,
  property: sql`'property'`,
  other_asset: sql`'other_asset'`,
  liability: sql`'liability'`,
};

/**
 * The typed position reference of blueprint 6.1, for a **nullable** reference.
 *
 * A column that must point at a specific kind of position carries a companion
 * constant `<ref>_kind` column, and the foreign key is
 * `(<ref>_id, user_id, <ref>_kind) → positions (id, user_id, kind)`. Phase 2
 * used the pattern only where the reference was mandatory (`cash_accounts`);
 * Phase 3 introduces the first nullable ones, which need one more guard than
 * Phase 2 did.
 *
 * ## Why the both-or-neither CHECK is not optional
 *
 * A multi-column foreign key in PostgreSQL is `MATCH SIMPLE` by default, and
 * `MATCH SIMPLE` is satisfied whenever **any** referencing column is NULL. That
 * is exactly what makes a nullable typed reference work: a row with no cash
 * account passes without a matching position. But it also means a row with
 * `cash_position_id` set and `cash_position_kind` left NULL would satisfy the
 * foreign key **without the referenced position existing at all** — the id
 * would point wherever it liked, unchecked, and RLS would not catch it because
 * nothing would be joined.
 *
 * So each reference gets two constraints: the two columns are NULL together or
 * set together, and when set the kind is the constant. Together they say "no
 * reference, or a real reference to a position of this kind owned by this
 * user", which is what 6.1 means.
 *
 * The shape CHECK is phrased to stay boolean in every branch, because a CHECK
 * whose expression is NULL passes. See the comment on it below — an integration
 * test writes the exact row it guards against.
 */
export function typedPositionRefConstraints(options: {
  readonly name: string;
  readonly kind: PositionKind;
  readonly idColumn: AnyPgColumn;
  readonly kindColumn: AnyPgColumn;
  readonly userIdColumn: AnyPgColumn;
}) {
  const { name, kind, idColumn, kindColumn, userIdColumn } = options;
  const constant = KIND_LITERAL[kind];

  return [
    check(
      `${name}_shape`,
      // Written so the expression is never NULL. A CHECK **passes** on NULL, so
      // the obvious form — `(id IS NULL AND kind IS NULL) OR (id IS NOT NULL
      // AND kind = 'cash')` — silently admits the one row this constraint
      // exists to reject: an id with a NULL kind evaluates the comparison to
      // NULL, and `false OR NULL` is NULL, so the row is accepted and the
      // MATCH SIMPLE foreign key waves it through as well. Comparing two
      // `IS NULL` predicates instead keeps every branch boolean.
      sql`(${idColumn} IS NULL) = (${kindColumn} IS NULL) AND (${kindColumn} IS NULL OR ${kindColumn} = ${constant})`,
    ),
    foreignKey({
      name: `${name}_fk`,
      columns: [idColumn, userIdColumn, kindColumn],
      foreignColumns: [positions.id, positions.userId, positions.kind],
    }),
  ] as const;
}
