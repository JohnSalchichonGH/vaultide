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

- **Blueprint:** v2.1.14.
- **Current phase:** Phase 3.
- **Phase 3 status:** in progress; the phase as a whole is **not accepted or
  frozen**.
- **Accepted/frozen phases:** Phases 0, 1, and 2 are accepted, frozen, and
  production-verified.
- **Phase 3 checkpoint:** backend slices through **10d
  (`possible_missing_conversion`)** have been reviewed under the review process
  in force at the time, production-verified, and frozen as completed slice
  checkpoints.
- **User-facing production:** Phase 0–2 functionality is exposed. Phase 3 has no
  user interface yet.
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
- `possible_missing_conversion` diagnostics and advisory output.

Historical missing-occurrence detection already exists and feeds reconciliation
issues: `packages/finance/src/reconciliation/completeness.ts`, the application
loaders' bounded recurring-resolution and term reads, and the
`suggested_income_missing` issue path. The full completed-month completeness
report/read model is still unfinished; do not rebuild the existing
recurring-completeness foundation as if it did not exist.

Web surface of the Phase 3 backend:

- `apps/web/src/server/actions/flows.ts` and `recurring.ts` already declare the
  Phase 3 mutations with `financialAction` (ADR 0003). The only page-level
  consumer so far is the additional-spending setting in the settings form.
- No Phase 3 read model (reconciliation, spans, savings, reporting, rolling) is
  wired to any page or route yet; current direct consumers are tests. Future UI
  work should inspect and reuse these existing backend reads, while additional
  read-model work remains as scoped below.
- `month_reviews`, including `dismissed_issues`, exists in schema only; no read
  path applies dismissals yet. Applying them belongs to the review/dismissal
  workflow item below.
- End-to-end coverage currently covers Phase 0–2 journeys only (`smoke`, `auth`,
  `accounts`).

## Next planned work

The next substantive financial slice is:

**Blueprint §12.6 — completed-month completeness report and the remaining
read-model work needed around it.**

After that, remaining Phase 3 work includes:

- the remaining actions and advisory review/dismissal workflow;
- the Monthly editor;
- the Spending and Income pages;
- bulk history entry and historical correction;
- remaining end-to-end journeys and Phase 3 hardening;
- a cold whole-Phase-3 review;
- Phase 3 acceptance, production verification, and freeze.

The exact subdivision or order of work after the next slice may be refined by a
later reviewed task prompt. Do not infer that an item is implemented merely
because it appears in this remaining-work list.

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
