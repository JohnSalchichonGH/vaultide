# ADR 0005 — Phase 3 implementation decisions

**Status:** accepted · **Date:** 2026-09-08 · **Phase:** 3 (slices 1–5)

Two decisions taken while building the Phase 3 schema and flow services that
the frozen blueprint (`docs/implementation-blueprint.md`, v2.1.6) does not
settle, that a later phase could plausibly get wrong, and whose reasoning is not
obvious from the code alone.

Everything else in Phase 3 follows v2.1.6 as written, including every decision
recorded in §30.8 and §30.9.

---

## 1. A nullable typed position reference needs a CHECK that is never NULL

**Decision.** The shape constraint of a nullable typed position reference (6.1)
is written as

```sql
(ref_id IS NULL) = (ref_kind IS NULL) AND (ref_kind IS NULL OR ref_kind = '<kind>')
```

and **not** as the more natural

```sql
(ref_id IS NULL AND ref_kind IS NULL) OR (ref_id IS NOT NULL AND ref_kind = '<kind>')
```

`packages/db/src/schema/typed-position-ref.ts` is the only place either is
written, and every Phase 3 nullable reference goes through it.

**Why.** Blueprint 6.1 specifies the pattern — a companion `<ref>_kind` column
pinned by a CHECK, with the foreign key on `(ref_id, user_id, ref_kind)` — and
notes that it is `MATCH SIMPLE`, so "a NULL reference passes and a non-NULL
reference must be a position of that kind". Phase 2 used the pattern only where
the reference was mandatory (`cash_accounts.position_id` is the primary key), so
the nullable case arrives with Phase 3 and brings a trap with it.

`MATCH SIMPLE` is satisfied whenever **any** referencing column is NULL. That is
exactly what makes a nullable reference work — a row with no cash account passes
without a matching position — and it also means a row with `cash_position_id`
set and `cash_position_kind` left NULL satisfies the foreign key **without the
referenced position existing at all**. The id points wherever it likes,
unchecked, and RLS does not catch it because nothing is joined. The shape CHECK
is the only thing standing between that row and the table.

And the natural phrasing does not stand there. A CHECK constraint **passes when
its expression is NULL**, and for `cash_position_id = <uuid>, cash_position_kind
= NULL` the expression evaluates:

- `(id IS NULL AND kind IS NULL)` → `false`
- `(id IS NOT NULL AND kind = 'cash')` → `true AND NULL` → `NULL`
- `false OR NULL` → `NULL` → **accepted**

The form above keeps every branch boolean: `(false) = (true)` is `false`, and
the row is rejected.

This was found by a test, not by reading. `phase3-rls.test.ts` writes the exact
row — "refuses an id with no kind, which MATCH SIMPLE would otherwise wave
through" — and it passed against the first phrasing, which is what sent us
looking.

**Consequences.** Phase 4, 5 and 6 add many more nullable typed references —
investments, properties, liabilities, other assets — and each must use
`typedPositionRefConstraints` rather than hand-writing a constraint. A future
session that writes the natural form by hand will produce a schema that admits
dangling references with no type checker, no foreign key and no RLS policy
objecting. The generated SQL is worth reading once in
`migrations/0006_phase3_flows.sql` to see what the helper actually emits.

The wider rule is worth keeping in mind beyond this pattern: **a three-valued
expression in a CHECK is a constraint that does not constrain.** Any new CHECK
over nullable columns should be written so that it cannot evaluate to NULL, and
should have a test that writes the row it is meant to reject.

---

## 2. Dormancy is cleared inside the flow's own transaction, by a repository
function that takes the transaction

**Decision.** `updateCashDormantFlag` gained an `…In(tx, …)` variant, and the
flow services call that one. Recording a flow attributed to a dormant cash
account clears `is_dormant` in the **same** transaction as the flow insert, is
audited, and does not consume the position's optimistic version.

**Why.** 8.8 says an attributed flow clears dormancy, and v2.1.6 §30.9 item 9
settles which flows and in which direction. What neither says is *where* the
clear runs, and the two obvious readings differ in a way that matters.

Clearing it after the flow commits — the shape Phase 2 used for a balance, where
the valuation and the clear were separate statements in separate transactions —
leaves a window in which the flow exists and the account is still flagged
dormant. A reconciliation running in that window carries the account at zero
against evidence that it moved, and reports the month as `dormant_zero` when it
should be demanding a month-end balance. The window is short and the failure is
silent, which is the worst combination.

So the clear is part of the flow's transaction: either both facts exist or
neither does.

Two properties of the Phase 2 implementation are deliberately preserved. The
clear does **not** bump `positions.version`, because it is a consequence rather
than a user edit and must not invalidate an account form somebody has open. And
it writes its own `audit_entries` row against `cash_accounts`, so the change is
explicable later — "why did this stop being dormant?" has an answer with a
request id attached.

**Consequences.** Phase 4 and 5 add flows that attribute to cash accounts
(contributions, withdrawals, liability payments). Each must call
`clearDormancyForFlowIn` from inside its own transaction rather than reaching
for the standalone `updateCashDormantFlag`, which exists for the Phase 2
valuation path and opens a transaction of its own. There is one dormant state
machine and it stays that way.

A null cash leg attributes to no account and clears nothing — that is not an
oversight, it is 8.1's "I have not said which account" rather than "this was not
tracked".
