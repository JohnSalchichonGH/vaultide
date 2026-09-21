# Vaultide — development state

This file is the compact implementation-progress ledger for Vaultide. It exists
so a fresh development or review session can establish the current project
checkpoint without reconstructing it from conversation history or Git history.

It is **not** a semantic specification, acceptance record, changelog, or release
proof.

- Product and financial semantics live in `docs/implementation-blueprint.md`.
- Durable implementation decisions live in `docs/adr/`.
- Accepted/frozen phase evidence lives in `docs/phase-N-acceptance.md`.
- Exact commits, CI results, deployments, and live release identity are Git and
  release-system evidence.
- `README.md` describes the product and broad repository status.

Do not copy detailed formulas, edge cases, commit SHAs, CI run IDs, or deployment
logs into this file.

## Current checkpoint

- **Blueprint:** v2.1.19.
- **Current phase:** Phase 3.
- **Phase 3 status:** in progress; the phase as a whole is **not accepted or
  frozen**.
- **Accepted/frozen phases:** Phases 0, 1, and 2 are accepted, frozen, and
  production-verified.
- **Phase 3 checkpoint:** backend slices through **10d
  (`possible_missing_conversion`)** have been reviewed under the review process
  in force at the time, production-verified, and frozen as completed slice
  checkpoints. The Phase-3-reachable completed-month completeness report and
  read model (blueprint §12.6, §30.18) is also an accepted/frozen slice
  checkpoint: independently reviewed, production-verified, and frozen. Five
  **Monthly** slices are likewise accepted, frozen and production-verified, each
  independently reviewed:
  - **Monthly foundation** — `/monthly/[yyyy-mm]` for completed and current
    months, served by one composite Monthly read, with Overview,
    Reconciliation, the MonthReview reviewed state, and advisory
    dismiss/restore as presentation state;
  - **Monthly Accounts editing** — maintaining each cash account's balances for
    the month on screen;
  - **Monthly Income** — a month's recurring income occurrences and the money
    actually received in it;
  - **Monthly Known expenses** — a month's recurring expense occurrences and the
    known expenses that financially belong to it;
  - **Monthly cash transfers** — maintaining transfers between the user's own
    cash accounts from Monthly → Accounts, including same- and cross-currency
    transfers and the linked transfer fee.

  Together these slices make up the Monthly sections Phase 3 has built so far.
  Cash transfers live inside Accounts and add no Monthly section of their own;
  later-phase Monthly sections remain outside this Phase 3 checkpoint.

  The **pre-Spending reconciliation-evidence correction** (blueprint §30.20,
  ADR 0007) is likewise independently reviewed, production-verified and frozen
  as a completed correction checkpoint. It corrects engines already delivered
  and is not a user-facing Phase 3 feature slice:
  - cash-account dormancy is dated to the evidenced current dormant episode, so
    an account being dormant today cannot rewrite its earlier history;
  - a completed month with no tracked-cash observation is unavailable rather
    than a reliable zero, so it never becomes a rolling observation.

  It reopens no accepted phase and rewrites no historical acceptance record.

  The **standalone Spending page** is likewise an independently reviewed,
  production-verified and frozen completed Phase 3 slice checkpoint:
  - `/expenses` is the cross-month Spending view. It opens on the last
    completed month, and the current month stays selectable;
  - it shows tracked, known, unclassified, additional and total spending only as
    far as the evidence supports, and every status and availability is the
    existing engines' own;
  - the fixed 3-, 6- and 12-month tracked-spending rolling windows, and
    reconciliation spans as combined periods, are user-facing here;
  - the focus month's category breakdown and largest known expenses explain the
    known part;
  - Add known expense is Monthly's own, reused.

  **Reconciliation issue corrective actions** are likewise an independently
  reviewed, production-verified and frozen completed Phase 3 slice checkpoint:
  - a reconciliation issue is actionable rather than a diagnosis to read.
    Monthly takes the user to the record or the row that would resolve it, or
    opens a focused corrective interaction beside the issue itself;
  - the corrections are the existing Income, Known expenses, Transfers,
    Accounts and Quick update workflows, opened with what the issue already
    knows. No editor was duplicated and ordinary use of each is unchanged;
  - an unexplained inflow the user cannot trace can be accepted as an explicit
    **reconciliation adjustment**: the residual recorded as what it is, so the
    month's cash records add up without claiming a cause. It is not counted as
    economic income when savings are worked out;
  - a suggested missing conversion opens a prefilled transfer, and suggested
    interest a prefilled income entry. Both remain suggestions: Vaultide fills
    in what it has evidence for, invents no financial fact, and writes nothing
    until the user confirms it;
  - a missing month-end or first balance sends the user to the exact account row
    that holds it, and a flow with no cash account names the record it is about;
  - a correction offered for the current month is bounded by the date its
    month-to-date reconciliation reaches, because nothing dated later is in the
    figure being corrected.

  A blocking issue clears because the source records changed and the server
  recomputed the month. There is no stored resolved-issue state, and advisory
  dismissal stays separate and never automatic. This slice creates records
  inside the issue's own month; general historical correction remains later
  work.
- **User-facing production:** Phases 0–2 remain the accepted/frozen user-facing
  foundation. Phase 3's Monthly page is in production with Overview, Income,
  Known expenses, Accounts (including cash transfers) and Reconciliation —
  whose issues now carry corrective actions — and so is the standalone Spending
  page; the rest of Phase 3 remains in progress.
- **Database migrations:** repository migrations run through
  `0008_dormant_anchor.sql`; the production release workflow
  applies migrations before deploying application code.
- **Phase 3 ADRs:** `docs/adr/0005-phase-3-implementation-decisions.md` is an
  accepted record of the decisions it contains, written for the slices 1–5
  baseline. It is not a complete roll-up of later Phase 3 work.
  `docs/adr/0006-phase-3-monthly-transfers.md` is the accepted record of the
  Monthly cash-transfer design decisions.
  `docs/adr/0007-dormant-anchor.md` is the accepted record of the pre-Spending
  dormant-anchor correction.
  `docs/adr/0008-standalone-spending.md` is the accepted record of the
  standalone Spending implementation decisions.
  `docs/adr/0009-reconciliation-corrective-actions.md` is the accepted record of
  the corrective-action decisions.
  `docs/adr/0010-historical-correction.md` freezes the historical-correction
  design and records the financial write-coordination prerequisite. A short
  implementation-status note is appended to it; the decision record itself is
  unchanged.

Freezing completed Phase 3 slices does not imply acceptance or freeze of Phase 3
as a whole.

## Phase 3 implemented so far

The backend currently includes:

- income, expense, transfer, and linked transfer-fee facts;
- recurring templates, terms, occurrences, accept/skip resolution, and the
  historical recurring-completeness foundation;
- completed-month reconciliation per native currency;
- month-to-date reconciliation;
- multi-month reconciliation spans;
- native-currency spending and savings decomposition;
- reporting-currency figures with per-figure availability;
- rolling 3-, 6-, and 12-month tracked-spending averages;
- `large_unclassified` diagnostics and advisory output;
- `possible_missing_conversion` diagnostics and advisory output;
- global completed-month completeness: state and counts over the Phase 3
  requirements (participating cash accounts not dormant at the month's end, and
  scheduled recurring occurrences), exposed through its own read model;
- dated dormant-episode evidence for cash accounts: a structural zero applies
  only from the evidenced start of the account's current dormant episode, so a
  present dormant flag never supplies one to earlier history;
- completed months with no reconciliation bucket reported as unavailable
  tracked observations rather than zeros, so the rolling tracked-spending
  windows count only months that actually qualified.

The recurring missing-income machinery remains part of the backend and shares
its occurrence schedule with completeness: `scheduledOccurrences` in
`packages/finance/src/reconciliation/completeness.ts` feeds both the
completeness count (`packages/finance/src/completeness/`, read through
`getMonthCompleteness`) and the income-only `suggested_income_missing` issue,
both over the application loaders' bounded template and recurring-resolution
reads. Extend that shared path rather than building a second occurrence reader.

Monthly adds, on top of that backend:

- one composite Monthly read (`getMonthlyPage`, in
  `packages/application/src/monthly/`) over the existing authoritative
  completed-month and month-to-date models;
- **Overview** and **Reconciliation** for completed and current months;
- **Accounts**: maintaining each cash account's balance for the month on
  screen — entering or correcting a statement balance, confirming a last-day
  snapshot as one, confirming a month unchanged, and updating balances today —
  and the month's cash transfers between the user's own accounts: recording,
  correcting or deleting a transfer within one currency or across two, with its
  optional linked fee;
- **Income**: the recurring income occurrences a month expected and what became
  of each, recording or skipping them and restoring a skip, recording an
  occurrence received early, changing what a source is worth from an occurrence
  on, creating a recurring income source, and maintaining the direct income
  received in the month;
- **Known expenses**: the recurring expense occurrences a month expected and
  what became of each, recording or skipping them and restoring a skip,
  recording an upcoming occurrence early, changing what a source costs from an
  occurrence on or when it ends, creating a recurring expense source, and
  maintaining the month's direct known expenses;
- **Reconciliation corrective actions**: one pure model mapping each issue the
  engines can raise to what it offers
  (`apps/web/src/features/monthly/issue-actions.ts`), rendered by one dialog
  host over the editors above. Its one new write is the reconciliation
  adjustment (`packages/application/src/flows/adjustments.ts`), whose server
  recomputes the month and derives the record from the discrepancy rather than
  trusting the browser's figure;
- MonthReview state: a completed month can be marked reviewed;
- advisory dismissal and restoration, applied only as presentation state.

Spending adds, on top of the same backend:

- one composite Spending read (`getSpendingPage`, in
  `packages/application/src/spending/`) over the existing authoritative
  completed-month, month-to-date, reporting, rolling and span models;
- `/expenses`, focused on the last completed month or any month through the
  current one, with the surrounding completed months and each month's status;
- the rolling 3-, 6- and 12-month tracked-spending windows;
- reconciliation spans as combined periods in their native currency;
- the focus month's categories and largest known expenses, from a pure
  breakdown of the reporting figures' own contributions;
- Monthly's Add known expense, reused;
- Spending in the desktop and mobile navigation.

Web surface of Phase 3:

- Monthly (`/monthly/[yyyy-mm]`) is a production route with Overview, Income,
  Known expenses, Accounts and Reconciliation. It consumes the existing
  reconciliation, reporting, completeness, month-to-date and recurring
  machinery through the Monthly composite read.
- Spending (`/expenses`) is a production route and the user-facing consumer of
  spans and rolling averages, through the Spending composite read over the same
  engines. Future UI work should keep reusing these existing reads rather than
  build parallel reads or parallel finance logic.
- MonthReview has repository, application and action paths
  (`apps/web/src/server/actions/monthly.ts`), used by Monthly to mark a
  completed month reviewed and to dismiss or restore an advisory as
  presentation state. Month notes are not edited anywhere yet.
- `apps/web/src/server/actions/flows.ts` and `recurring.ts` declare the Phase 3
  financial mutations with `financialAction` (ADR 0003). Monthly's Income and
  Known expenses sections are their consumers, as is Spending's reused Add known
  expense, and Monthly Accounts is the user-facing consumer of the transfer flow
  path.
- End-to-end coverage now also includes the Monthly, Spending and
  corrective-action journeys (`monthly`, `spending`, `corrective-actions`),
  alongside the Phase 0–2 journeys (`smoke`, `auth`, `accounts`).

## Financial write coordination

One invariant now holds across the whole backend, and is enforced
mechanically rather than by convention (blueprint 20.3, §30.22; ADR 0010):

> Every ordinary mutation of Vaultide's mutable financial evidence, during an
> account's active lifetime, is one atomic per-user transaction that acquires
> the same transaction-scoped advisory write mutex before its first
> authoritative read, performs all validation, domain decisions, writes and
> audit inside that transaction, and commits or rolls back as one unit.

Account bootstrap (provisioning) and account teardown (the delete cascade and
its sweep) are lifecycle operations with their own contracts, outside that
editing mutex; ADR 0010 §3 and §4.1 say why.

- `withUserWrite` (in `@vaultide/db`, reached through the application's
  `coordination` module) opens that transaction: read committed, the RLS
  context, a transaction-local lock timeout, then `pg_advisory_xact_lock` on a
  key derived from the session's user id alone. A lock timeout retries the
  whole transaction once and then answers `WRITE_BUSY`.
- `withUserRead` — repeatable read, read only, no write mutex — is the
  coherent-read primitive the later correction preview needs. Ordinary page
  reads are unchanged and stay on `withUser`.
- `categories.archived_at` is a **reference dependency**: a financial write
  that chooses a category afresh holds it `FOR SHARE` until it commits, and
  category administration stays an ordinary non-financial write.
- Financial deletes carry the version the client rendered; a transfer delete
  carries every linked fee row the caller saw, by id and version, so the
  malformed several-fee aggregate can still be repaired but only exactly as it
  was rendered.
- The four valuation paths whose dormancy consequence could commit separately —
  record, correct, remove and quick update — are one transaction each, and the
  adjustment path's residual check/write window (ADR 0009 §9) is closed.
- `packages/application/test/unit/financial-write-boundary.test.ts` enforces the
  boundary over the TypeScript AST, and is itself tested against fixtures that
  are deliberately wrong. It also derives the exposed financial surface from
  the web app's own `financialAction` declarations and cross-checks it against
  the mutation registry, so a new financial action whose mutation nobody
  registered fails CI instead of escaping the boundary rules. It is separate
  from `apps/web/test/financial-actions.test.ts`, which enforces authorization.

No migration: the mutex is ephemeral PostgreSQL state, and the versions, audit
images, reasons and request ids it relies on already exist.

## Historical correction

Implemented on the review branch `feat/historical-correction`, and **awaiting
independent review**: it is not accepted, not frozen and not
production-verified (blueprint 15.3, 30.22; ADR 0010).

Every ordinary mutation of mutable financial evidence now **resolves** before it
applies. A resolver reads what the operation is about, applies every domain
rule, and produces a plan — which source facts change, before and after, and
what happens to the dormant episodes those facts touch. The write then applies
that plan, and the correction ceremony previews it instead:

```
ordinary   resolve -> guard -> apply
preview    resolve -> overlay -> impact -> fingerprint
confirm    resolve -> impact -> fingerprint -> compare -> apply
```

Preview and Confirm call the same resolvers and the same apply functions the
ordinary mutations call, so no rule has a second statement. The only difference
between the read side and the write side is whether the resolving reads take
their row locks, which a `read only` transaction cannot do at all.

- **What a correction is** has one statement, in
  `packages/application/src/corrections/classify.ts`: a revision — an update or
  a delete — of a source fact whose financial period is completed on either
  side, or a dormancy transition whose dated episode reaches completed history.
  A single historical creation stays a first assertion; its dormancy
  consequence is judged on its own terms. A transfer aggregate is judged on
  every date it carries, the fee's own `incurred_on` included.
- **The guard is a server boundary, not a flag.** An ordinary write that
  resolves into a historical revision refuses with
  `HISTORICAL_REVIEW_REQUIRED` before a row moves. Confirm does not bypass it:
  it never calls the ordinary entry point, it verifies consent and applies the
  same plan.
- **Preview** is one `withUserRead` transaction — repeatable read, read only,
  no mutex, no provider call — and writes nothing at all. It loads a window
  bounded by the correction's own reach, derives BEFORE, overlays the resolved
  change in memory, derives AFTER through the same engines, and hashes the
  semantic difference. A row that does not exist yet carries a deterministic
  semantic identity, never a fabricated database id. One window value decides
  both what is read and what is judged: the flow reads are bounded on **both**
  sides by it, so a 2021 correction reads 2021 and a balance or dormant episode
  that genuinely reaches the current month says so. Valuations keep their
  no-lower-bound rule, because a month's opening may be carried from years
  earlier.
- **The impact tags are derived, not assumed.** Each of the six families is
  projected onto the figures it is actually derived from, over the interval that
  family's own contract uses, and a tag appears exactly when its projection
  moves. So a description-only correction reports only `memo`; a corrected
  balance that moves the residual without moving a status still reports
  spending and savings; and a record dated after `D` claims no effect on the
  current month's `D`-bounded figures. The projections hold native amounts and
  never leave the derivation — the preview and its fingerprint carry the
  six-tag conclusion and no monetary total.
- **Confirm** is a financial mutation like any other, registered in the
  write-boundary AST check. Its outcome is a typed protocol result —
  committed, or the impact changed — and `impact_changed` writes nothing.
- **The interface** keeps its editors. Each save asks the server first; an
  ordinary one saves as before, and a historical one goes through Review
  changes → Confirm correction. A current-month delete asks once in place; a
  historical one goes straight to the review. Adding into a closed month says
  once that the month will be worked out again. A recorded row's financial date
  may now be corrected into another month, in the editor, bounded only by M5.

No migration: nothing about a preview, a draft, an impact or a fingerprint is
persisted.

Still out of scope, and still separate known gaps: bulk history, the history
drawer, undo, restore, `positions.opened_on` correction, and reopening or
correcting a close.

## Next planned work

Phase 3 remains **in progress**. Once historical correction has been
independently reviewed, released and verified live, the next planned Phase 3
area is **bulk history entry**, which has **not started**.

Remaining Phase 3 work, in the agreed order:

1. historical correction (implemented on its review branch; awaiting review);
2. bulk history entry;
3. the standalone Income pages;
4. the remaining end-to-end journeys and Phase 3 hardening, including the
   server/domain enforcement of each currency's minor-unit scale for Phase 3
   flows that acceptance still requires;
5. a cold whole-Phase-3 review;
6. Phase 3 acceptance, production verification, and freeze.

The exact scope and subdivision of this work may still be refined by a later
reviewed task prompt. Do not infer that an item is implemented merely because it
appears in this remaining-work list.

## Maintenance rule

Update this file when a meaningful implementation checkpoint is independently
accepted and production-verified, when a phase changes acceptance/freeze state,
or when the agreed next work materially changes.

Keep updates concise and state-oriented. Do not turn this into a per-commit diary
or duplicate semantic rules from the blueprint.

When a slice is implemented but still awaiting independent review, CI,
deployment, or production verification, do **not** advance the completed
checkpoint here prematurely.

If a fresh session repeatedly needs a durable project-state fact that is missing
here, add it only if it belongs in this ledger rather than one of the authorities
above.
