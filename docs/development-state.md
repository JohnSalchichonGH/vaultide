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

- **Blueprint:** v2.1.15.
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
  checkpoint: independently reviewed, production-verified, and frozen. Three
  **Monthly** slices are likewise accepted, frozen and production-verified, each
  independently reviewed:
  - **Monthly foundation** — `/monthly/[yyyy-mm]` for completed and current
    months, served by one composite Monthly read, with Overview,
    Reconciliation, the MonthReview reviewed state, and advisory
    dismiss/restore as presentation state;
  - **Monthly Accounts editing** — maintaining each cash account's balances for
    the month on screen;
  - **Monthly Income** — a month's recurring income occurrences and the money
    actually received in it.

  Together these are still not the complete Monthly editor: Known expenses and
  the later sections remain.
- **User-facing production:** Phases 0–2 remain the accepted/frozen user-facing
  foundation. Phase 3's Monthly page is in production with Overview, Income,
  Accounts and Reconciliation; the rest of Phase 3 remains in progress.
- **Database migrations:** repository migrations run through
  `0007_phase3_privileges_and_triggers.sql`; the production release workflow
  applies migrations before deploying application code.
- **Phase 3 ADR:** `docs/adr/0005-phase-3-implementation-decisions.md` is an
  accepted record of the decisions it contains, written for the slices 1–5
  baseline. It is not a complete roll-up of later Phase 3 work.

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
  requirements (participating non-dormant cash accounts and scheduled recurring
  occurrences), exposed through its own read model.

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
  snapshot as one, confirming a month unchanged, and updating balances today;
- **Income**: the recurring income occurrences a month expected and what became
  of each, recording or skipping them and restoring a skip, recording an
  occurrence received early, changing what a source is worth from an occurrence
  on, creating a recurring income source, and maintaining the direct income
  received in the month;
- MonthReview state: a completed month can be marked reviewed;
- advisory dismissal and restoration, applied only as presentation state.

Web surface of Phase 3:

- Monthly (`/monthly/[yyyy-mm]`) is a production route with Overview, Income,
  Accounts and Reconciliation. It consumes the existing reconciliation,
  reporting, completeness, month-to-date and recurring machinery through the
  Monthly composite read. Spans and rolling averages are not wired to any page
  yet. Future UI work should reuse these existing reads rather than build
  parallel ones.
- MonthReview has repository, application and action paths
  (`apps/web/src/server/actions/monthly.ts`), used by Monthly to mark a
  completed month reviewed and to dismiss or restore an advisory as
  presentation state. Month notes are not edited anywhere yet.
- `apps/web/src/server/actions/flows.ts` and `recurring.ts` declare the Phase 3
  financial mutations with `financialAction` (ADR 0003). Monthly's Income
  section is their main consumer; the expense and transfer mutations still have
  no page of their own, and Known expenses is the section that will use the
  expense ones.
- End-to-end coverage now also includes the Monthly journeys (`monthly`),
  alongside the Phase 0–2 journeys (`smoke`, `auth`, `accounts`).

## Next planned work

The next planned Phase 3 area is:

**Monthly Known expenses** — the remaining Monthly editor section, wiring the
existing expense and recurring actions into it.

After that, remaining Phase 3 work includes:

- the Spending and Income pages;
- bulk history entry and historical correction;
- remaining end-to-end journeys and Phase 3 hardening;
- a cold whole-Phase-3 review;
- Phase 3 acceptance, production verification, and freeze.

The exact scope, subdivision or order of this work, the next area included, may
be refined by a later reviewed task prompt. Do not infer that an item is
implemented merely because it appears in this remaining-work list.

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
