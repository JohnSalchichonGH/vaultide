# ADR 0010 — Historical correction and financial write coordination

**Status:** accepted · **Date:** 2026-09-20 · **Phase:** 3 (historical correction)

Historical correction is the next Phase 3 feature. Four read-only design passes
settled what it is, what it may show, and what it needs underneath before a line
of it is written. This record freezes those decisions, and records the one
prerequisite implemented now: **financial write coordination** — every mutation
of Vaultide's mutable financial evidence is one atomic per-user transaction that
takes the same write mutex before its first authoritative read.

Freezing a decision here is not shipping it. At this record's date Historical
correction itself is **not implemented**: there is no correction preview, no
correction draft, no impact DTO and no correction dialog. Sections 1–4 and 12–14
describe the contract a later slice is held to; sections 5–11 describe what this
prerequisite slice actually builds.

The blueprint (`docs/implementation-blueprint.md`, v2.1.19) is the semantic
authority; §30.22 is the product-level ruling this record reasons from. ADR
0003, 0004, 0005, 0006, 0007, 0008 and 0009 stand. No identity, status rule,
issue trigger, availability rule, rounding boundary or schema changes here, and
**no migration**: the write mutex is ephemeral PostgreSQL state, and the
versions, audit before/after images, audit reasons and request ids the design
relies on already exist.

---

## 1. What Historical correction is

**Decision.** A future Historical correction is either:

- an **update or delete of a source financial fact whose financial period is
  completed on either its before or its after side** — so moving a record out of
  a completed month, into one, or between two is a correction whichever
  direction it goes; or
- a **dormancy transition whose dated episode reaches completed history** —
  `cash_accounts.dormant_from` is the `valued_on` of a zero balance (ADR 0007
  §2), so starting an episode can reinterpret months that are already closed.

A single historical **creation** is deliberately outside the correction
ceremony.

**Why a creation is different.** Not because it has no historical consequence —
it plainly does; recording a September expense in October changes September's
decomposition. It is different because it is a **first assertion** rather than a
**revision**: there is no before-image to show, nothing the user previously
stated is being replaced, and the before → after confirmation 15.3 asks for
would have an empty left-hand side. The corrective actions of ADR 0009 already
create records inside a completed month for exactly this reason and were
accepted without the ceremony.

**Bulk history is not exempt by the same argument.** The later Bulk-history grid
edits many months at once and mixes creates, updates and clears in one save; it
will use the correction preview machinery regardless of the create/update/delete
mix, because the thing the user needs to see there is the aggregate effect of
the batch, not the provenance of each cell.

None of this is implemented now.

## 2. The impact contract, for a later slice

**Decision.** Historical correction will distinguish three things and keep them
distinct in its result shape:

- **source scope** — which records the correction touches;
- **`PeriodImpact`** — what each affected financial period says before and
  after;
- **structural changes** — effects that are not a figure moving: a
  reconciliation span appearing or disappearing, a month's status or
  completeness changing, an issue arriving or clearing.

The native-currency engines are authoritative for every figure in that result;
reporting-currency values stay derived, with their own per-figure availability
(blueprint 8.11, 12.5, 30.16).

**Current and completed months carry different shapes.** A completed month has
`end(M)` and the completed-month engine; the current month has `D` or no `D` at
all and the month-to-date engine. They are not one shape with optional fields:
30.13 and 30.21 item 7 already rule that a current-month figure is through `D`
and that a correction offered there is bounded by `[start(M), D]`.

Not implemented now.

## 3. The coordination contract this slice implements

**Decision.**

> Every mutation of mutable financial evidence must acquire one per-user,
> transaction-scoped advisory write mutex before its first authoritative read,
> and must perform its validation, its domain decisions, its writes and its
> audit inside that same transaction.

This is the prerequisite. A future Historical Confirm depends on it: Confirm
re-derives the impact it is about to commit against, and a fingerprint check
inside the transaction is only meaningful if no other participating financial
writer of the same user can commit between the check and the write.

**No `SERIALIZABLE`.** No serializable snapshot isolation, and no
predicate-locking design. The mutex is what provides stability; see §6.

## 4. Mutable financial evidence versus reference dependencies

Two kinds of mutable state matter, and conflating them would put ordinary
account housekeeping on the financial mutex.

**Mutable financial evidence** is user-owned source state whose content can
change a financial or completeness output. Its current membership is:

```
positions
cash_accounts
other_assets
position_valuations
income_entries
expense_entries
transfers
recurring_templates
recurring_template_terms
recurring_template_skips
user_settings.count_additional_spending
```

Every mutation of these participates in the per-user financial write mutex.

`user_settings.count_additional_spending` is a financial input despite its
address: 12.5 makes it decide whether spending paid outside tracked accounts
reduces personal savings, so flipping it re-interprets every past month's
`PersonalSavings` and `SavingsRate`. Its neighbours on the same row — timezone,
locale, favourite currencies, the reporting currency, the stale-months
thresholds, the `preferences` JSONB — are **not** financial evidence and are
deliberately not serialized against financial writes.

**Reference dependencies** are mutable eligibility state that decides whether a
proposed financial write is *allowed*, without reinterpreting existing history.
The current member is:

```
categories.archived_at
```

A reference dependency is protected by a **targeted row lock inside the
financial transaction**, not by putting its administration on the per-user
mutex. See §9.

## 5. `withUserWrite`, and why it is not `withUser`

**Decision.** `@vaultide/db` gains `withUserWrite(db, { userId }, fn)`. In this
order, and the order is the contract:

```
BEGIN ISOLATION LEVEL READ COMMITTED
set_config('app.current_user_id', <session userId>, true)   -- RLS, fail-closed
set_config('lock_timeout', '<n>ms', true)                   -- transaction-local
SELECT pg_advisory_xact_lock(<per-user key>)

-- only now:
authoritative reads · reference-dependency locks · row FOR UPDATE locks ·
version checks · domain validation · derived decisions · writes · audit

COMMIT
```

The lock key derives **only** from the authoritative server-session `userId`.
Neither a `userId` nor a lock key is ever accepted from the browser for this
purpose; `financialAction` (ADR 0003) is what establishes that identity, and
this primitive is what serializes the work done under it. The two answer
different questions and both remain mandatory: authorization is
`financialAction`, write coordination is `withUserWrite`.

**Why "before the first authoritative read" and not "before the write".** A
mutation that read an existing row, decided something from it, and only then
took the mutex would be deciding against a snapshot another writer was free to
replace. Locking the write alone serializes the SQL and leaves the decision
racy, which is the failure the valuation family already had (§8).

## 6. `READ COMMITTED`, deliberately

**Decision.** The write transaction runs at `READ COMMITTED`. Not `REPEATABLE
READ`, not `SERIALIZABLE`.

**Why.** After waiting for the mutex, the first authoritative read must see the
newest committed state left by whichever writer held the mutex before us. Under
`REPEATABLE READ` the transaction snapshot is taken at the first statement —
which is the GUC set-up, before the wait — so the reads that follow would be
taken against a world that predates the writer we just queued behind, and the
transaction would then fail with a serialization error on write rather than
simply see the truth. Under `READ COMMITTED` each statement takes a fresh
snapshot, so every read after the wait sees the committed result.

The usual objection to `READ COMMITTED` — that two statements in one transaction
can disagree — does not apply to the state that matters here, because no
participating financial writer of this user can commit while we hold the mutex.
The relevant financial world is stable for the whole transaction despite being
read statement by statement. Non-participating writers (category administration,
FX rows, month-review presentation state) can still commit underneath us; those
are exactly the states that get their own row lock (§9) or are not financial
evidence at all.

## 7. `pg_advisory_xact_lock`, the key, the timeout and one retry

**Decision.** `pg_advisory_xact_lock`, never `pg_advisory_lock`. A
transaction-scoped advisory lock is released by `COMMIT`, by `ROLLBACK` and by
an error, with no `finally` to forget and nothing for a pooled connection to
carry into the next request. A session-scoped lock leaked onto a pooled
connection would deadlock a user out of their own account until the connection
was recycled.

**The key** is a deterministic 64-bit value derived from the user's UUID alone:
parse its 128 bits, XOR-fold the two 64-bit halves, XOR with a fixed
Vaultide namespace constant, and narrow with `BigInt.asIntN(64, …)` so the value
is a valid signed PostgreSQL `bigint`. No runtime randomness, no client input,
and deliberately **not** `hashtext(user_id)` — that is a PostgreSQL
implementation detail whose value is not contractually stable across versions,
and the key has to mean the same thing on every deployment and in every test.
The namespace constant is the ASCII of the product name rather than an
unexplained random number, so a reader can see where it came from.

A 64-bit collision between two users would serialize two unrelated people's
writes. That is a liveness cost, not a correctness one, and it is not worth a
cryptographic construction.

**The timeout** is a transaction-local `lock_timeout`, set through `set_config`
before the lock is taken — never by interpolating a number into SQL text. The
reviewed default is **1500 ms**, and it is the default in code, so deploying
this needs no production environment change. An environment override exists for
operations and for the tests that have to provoke the timeout deterministically.

**The retry** is exactly one. A PostgreSQL `55P03` (`lock_not_available`) from
the mutex wait or from a reference-dependency lock retries the whole write
transaction once after a small bounded jittered delay; nothing was written, so a
retry repeats no side effect. A second failure surfaces as the application error
`WRITE_BUSY`. Nothing else is retried: a version conflict, a duplicate, a
validation failure and a domain refusal are answers, not contention, and turning
one of them into `WRITE_BUSY` would invite a client to retry a write that will
never succeed.

`WRITE_BUSY` is classified as a benign retryable conflict rather than an
internal failure. It writes nothing, it leaks no SQLSTATE, and it produces no
internal-error reference id for what is ordinary contention. Its message says
that another change is still saving and that nothing was saved.

**Layering.** `@vaultide/db` may not import application error classes, so it
raises its own `WriteLockUnavailableError` and `@vaultide/application` maps that
to `WRITE_BUSY` in exactly one place — the application's own `withUserWrite`
wrapper, which is the only `withUserWrite` a mutation service is allowed to
import.

## 8. `withUserRead`, for the later preview

**Decision.** `@vaultide/db` also gains `withUserRead(db, { userId }, fn)`:
`REPEATABLE READ`, `READ ONLY`, RLS user context, **no** advisory write lock.

It exists because a future correction **preview** must answer several questions
about one coherent state of the world — the impact on each affected period, the
spans that appear or disappear, the statuses that move — and answering them from
several `READ COMMITTED` statements could compose figures from two different
worlds. A preview computes, shows and commits nothing, so it takes no write
mutex and blocks no writer.

Adding it does not migrate the ordinary reads. Monthly's and Spending's
composite loaders legitimately use ordinary user-scoped read transactions and
are unchanged; the rule this slice enforces is about **mutations**, not reads.

## 9. The category reference dependency: `FOR SHARE`

**Decision.** When a financial mutation chooses a category **afresh**, it reads
that category inside its own transaction under `SELECT … FOR SHARE` and refuses
a missing or archived one. The lock is held until the financial transaction
ends.

**Why `FOR SHARE` and not `FOR KEY SHARE`.** Archiving a category is an
`UPDATE` of `archived_at`, which takes `FOR NO KEY UPDATE`. `FOR KEY SHARE`
does not conflict with `FOR NO KEY UPDATE` and would let the archive commit
while the financial transaction believed the category live. `FOR SHARE`
conflicts with both `FOR NO KEY UPDATE` and `FOR UPDATE`, which gives exactly
the guarantee needed: **once a financial transaction has accepted a category as
live, it cannot become archived until that transaction ends.** A stronger lock
would be `FOR UPDATE`, which would needlessly serialize two financial writes
that merely file against the same category.

**Which paths lock a live category.** Creating an expense entry; correcting one
where the category is being selected; creating a recurring template whose
contract requires the selected category to be live; and a transfer's fee, whose
`transfer_fee` category this product looks up rather than accepting (ADR 0006
§6) and which is locked too, even though no application path can archive a
system category today — the lock states the dependency rather than relying on
the absence of a feature.

**Which paths must not start requiring it.** Correcting an expense without
changing its category; `acceptSuggestion` materializing an occurrence of a
template whose category was chosen when it was live; and every reconciliation,
reporting and spending read of existing expenses. Archiving a category after a
template was created does not change what its historical occurrences are, and a
**historical row keeps being classified by its archived category's immutable
`kind`** (7.4, R12). Requiring liveness to carry history would make tidying up a
category rewrite the past — the exact failure this product exists to prevent.

**Category administration stays off the financial mutex.** `createCategory`,
`archiveCategory` and renaming a category remain reference administration on the
ordinary action path. PostgreSQL's row locks give the correct behaviour in both
orderings:

- *financial transaction first* — it holds the category `FOR SHARE`; the
  archive's `UPDATE` waits; the financial mutation commits; the archive then
  proceeds. The expense that was accepted against a live category is recorded.
- *archive first* — the archive holds the row; the financial transaction's
  locking read waits; the archive commits; under `READ COMMITTED` the locking
  read then re-reads and sees the archived row, and the mutation is refused with
  `VALIDATION_ERROR`. Nothing is written.

No new lock cycle is introduced: the financial transaction takes the per-user
mutex, then the category row; the archive takes only the category row.

## 10. Version protection stays

**Decision.** The mutex does **not** replace `expectedVersion`. They close
different gaps:

- the **mutex** stops two concurrent participating writers of the same user from
  interleaving *within* a request;
- **`expectedVersion`** protects the think-time between the state a user was
  shown and the request they send minutes later.

No existing version check is removed, and financial deletes gain one.

## 11. Financial deletes are version-aware

**Decision.** Deleting a valuation, an income entry, an expense entry or a
transfer carries the version the client actually rendered, and a stale version
is `CONFLICT_VERSION` with nothing deleted and nothing audited. A transfer
delete additionally carries `expectedFee` in the shape a transfer *update*
already uses — `absent`, or `{ feeId, version }` (ADR 0006 §2) — because a
transfer is one aggregate and a fee that appeared, changed or vanished since the
user looked is a conflict rather than something to sweep up. A transfer's fees
keep being deleted explicitly with their own before-image; the `ON DELETE
CASCADE` stays for account deletion and is not the ordinary path (ADR 0006).

This is a safety change, not a ceremony change. A one-click delete stays one
click; the current-month delete confirmation that product review accepted
belongs with the Historical-correction UX slice.

An optional audit **reason** is accepted on the valuation correction and delete
paths as well, so the later slice can expose it without redesigning persistence.
An absent, empty or whitespace-only reason is normalized centrally to `null`, so
an audit row never stores a meaningless string.

## 12. Historical Confirm, for a later slice

**Decision.** A future Confirm runs at `READ COMMITTED` inside the per-user
mutex — the same primitive every other financial mutation uses. Freshness comes
from the statement snapshots taken *after* the mutex is acquired; stability
comes from the mutex. Preview runs in one coherent `REPEATABLE READ READ ONLY`
transaction (§8).

Confirm's result is a **typed protocol result**, `committed | impact_changed`,
not an error code. `IMPACT_CHANGED` is deliberately **not** added to
`ErrorCode`: "the world moved while you were reading the preview" is a normal
outcome of a two-step ceremony that the caller re-renders from, not a failure to
log and count alongside validation errors. Neither the result type nor the
fingerprint it compares is implemented now.

## 13. The current-month impact model, for a later slice

**Decision.** A current-month impact preserves the month-to-date engine's own
distinction between **a tracked interval** and **no tracked interval**, as a
union rather than as optional fields. With no `D` there is no interval, no
month-to-date total and no bucket: the impact says so, and never invents a zero
bucket. This restates 30.13 items 3 and 4 and 30.21 item 6 at the impact layer.

No current-period DTO is implemented now.

## 14. What is still out of scope after this slice

- The **History drawer**, **undo** and **restore** remain later work. 21.5's
  end-to-end expectation of a historical-correction *restore* belonged to that
  later phase and is removed from 21.5 rather than left as a claim about a
  journey nothing can run.
- `positions.opened_on` correction, and reopening or correcting a close, remain
  separate known gaps: both change which months an account participates in, and
  neither has a stated rule yet.
- **Bulk history** remains the multi-month grid after Historical correction.

## 15. What this slice retires

ADR 0009 §9 recorded a residual window on the adjustment path: the
authoritative discrepancy was recomputed before the write's transaction, so a
concurrent financial write of the same user could land between the check and the
insert. The recompute and the insert now happen inside one mutex-owned
transaction, so that window is closed. The stale-view precondition itself is
unchanged — it still refuses when the issue has gone or its amount has moved —
and no database constraint was invented for it, exactly as §9 decided.

The four valuation paths whose financial write and dormancy consequence could
be split across transactions — record, correct, remove and quick update — are
likewise one transaction each now.

## 16. How the boundary is enforced

**Decision.** The invariant is enforced mechanically, by an architectural test
over the TypeScript AST rather than by review or by grep.

`packages/application/test/unit/financial-write-boundary.test.ts` holds an
explicit registry of every financial mutation entry point and, for each one,
proves that:

1. no awaited or otherwise stateful call happens before the `withUserWrite`
   boundary — pure synchronous normalization and validation before it is fine;
2. no `Database` capability is touched before the boundary;
3. exactly one `withUserWrite` owns the mutation, and it is imported from the
   application's own coordination module rather than from `@vaultide/db`;
4. the transaction-internal implementation receives a `Transaction`, a context
   and its arguments — never a `Database`, and never a dependency bundle that
   contains one;
5. there is no ambient `getServices()` / `getDatabase()` escape hatch and no
   nested `withUser` / `db.transaction` boundary inside a mutation;
6. only an explicit, small allow-list of non-authoritative post-commit effects
   runs after the boundary — today that is FX history warming, which may refresh
   support data but may never decide whether the write should have happened;
7. the registry is non-vacuous: a renamed or removed entry point fails the test
   rather than silently stopping being checked.

The checker itself is tested against fixtures, including the specific shape that
looks correct and is not:

```ts
const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);
return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) => …);
```

That code contains a mutex and is still wrong, because the authoritative read
happened first. A test that searched the source for `withUserWrite(` would pass
it.

`apps/web/test/financial-actions.test.ts` is untouched and still proves the
other invariant: every state-changing financial action authorizes against the
session store (ADR 0003). The two are not merged, because they answer different
questions.
