# Vaultide — Claude Code guidance

This is a small, durable operating contract for Claude Code in this repository. It governs **how to work**, not what Vaultide means.

If this file appears to conflict with the current blueprint, an accepted ADR, or deliberately enforced repository behavior, **stop and report the drift**. Do not change otherwise-correct product behavior merely to satisfy a stale `CLAUDE.md`.

## Authority and evidence

Use each source for the job it owns:

- The **current task prompt** defines scope and deliverables.
- `docs/implementation-blueprint.md` is the semantic authority for product, financial, temporal, FX, security, schema, and phase behavior.
- Accepted files in `docs/adr/` record implementation decisions where the blueprint leaves room.
- Code, tests, migrations, and Git history at the current `HEAD` show what exists on that ref; they do not by themselves prove semantic correctness, acceptance, deployment, or production state.
- `docs/phase-N-acceptance.md` files are evidence for accepted/frozen phases; they are not semantic specifications.
- `docs/development-state.md`, when present, is the compact progress ledger.
- `README.md` is orientation and broad status, not a specification.

If authoritative sources materially disagree, or the requested implementation would require guessing a financial/product rule, stop before editing.

A task may change semantics only when it explicitly scopes a blueprint/specification revision. Establish and review that correction before implementing behavior that depends on it.

## Before substantive edits

- Inspect the current branch, `HEAD`, `origin/main`, and working-tree state. Fetch when remote state matters.
- Confirm the task's expected baseline before changing anything.
- Read `docs/development-state.md` when present, then the relevant blueprint sections, applicable ADRs, nearby implementation, and tests.
- Prefer targeted reading over rereading the whole blueprint for a narrow task.
- Reuse existing abstractions and patterns before creating new ones.
- For a substantive slice, state a short implementation map before editing.
- Do not ask the user for facts the repository can answer.

A wrong baseline, unexpected dirty tree, unexpected remote movement, or material ambiguity is a stop condition. Never discard, hide, stash, or overwrite unrelated user work merely to obtain a clean tree.

## Scope discipline

- Make the smallest coherent change that satisfies the task.
- No opportunistic refactors, renames, dependency upgrades, schema churn, formatting sweeps, or unrelated cleanup.
- Do not reopen accepted/frozen work without concrete evidence of a defect or regression.
- If new work exposes a frozen defect, report it and isolate the repair instead of silently folding it into unrelated work.
- Never weaken a contract, validation rule, RLS policy, precision rule, availability state, or test merely to get green.
- Update comments/docs that the current change makes false. Report unrelated stale material instead of expanding scope.
- Do not add or upgrade dependencies unless the scoped change requires it. When dependencies legitimately change, update the lockfile through pnpm; never hand-edit it or bypass workspace supply-chain policy.

## Architecture and implementation guardrails

Treat the current dependency-cruiser configuration as an enforced architectural boundary. Do not relax it unless the task explicitly changes architecture.

In particular:

- `packages/finance` remains pure domain logic with no DB, network, filesystem, framework, environment, or clock IO.
- `apps/web` does not access the database directly; application services own orchestration.
- Avoid circular or unresolvable dependencies.

Preserve these cross-cutting invariants unless an explicit, reviewed architectural change supersedes them:

- Follow the numeric and rounding contract of the domain being changed. Ledger facts, valuations, reconciliation, and reporting calculations use the project's Decimal-based authoritative paths and no extra intermediate rounding beyond blueprint-defined working, persistence, or display boundaries. Projections and scenarios use their own blueprint-defined numeric backend, precision, and rounding; Monte Carlo and chart geometry may use explicitly permitted approximate mechanisms.
- Native-currency facts remain authoritative; reporting-currency values are derived.
- When introducing or changing a contract, make impossible states unrepresentable where practical; do not reshape accepted contracts for this alone. Missing/partial/unavailable is not zero, so represent missing evidence explicitly instead of inventing a fallback.
- Future-dated **actual** financial facts are prohibited. Planned, recurring, or scenario facts follow their own blueprint rules.
- Do not infer economic meaning from sign beyond sign semantics explicitly defined by the blueprint, or collapse transfers, income, spending, principal, fees, proceeds, or allocations into one another.
- Do not count the same economic contribution twice inside one identity or aggregate.
- `packages/finance` never performs provider IO. FX acquisition, lookup windows, and fallbacks are path-specific: follow the blueprint/ADR for the path being changed rather than generalizing from another read/write path. Never broaden a lookback, reach into future evidence, or invent a fallback merely to obtain a number.
- Time-dependent rules such as `today` do not belong in database `CHECK` constraints; validate them in the appropriate domain/application layer with injected time.

## Security, data, and schema

- Every state-changing financial request must authorize against the authoritative session store. In the current server-action architecture, use `financialAction` as required by ADR 0003; do not bypass it with cookie-cache authorization.
- User identity comes from request/session context, never from a client-supplied `userId`.
- Preserve fail-closed RLS, tenant isolation, privileges, audit behavior, optimistic concurrency, and established transaction boundaries.
- Treat deployed migrations as immutable. Required schema evolution gets a new migration.
- Where an accepted ADR establishes a helper, constraint shape, or transaction pattern, reuse it rather than hand-rolling an equivalent.
- A schema change that adds tenant-owned tables, closed-set enums, privileged objects, or other security-sensitive schema must update the corresponding verifier/integration-test inventories in the same slice.
- Never print, commit, or include secret values in reports. Do not dump `.env` contents for diagnosis.
- As an operator/debugger, do not directly inspect production tenant-owned financial rows unless the task explicitly authorizes a necessary investigation.
- Never use the owner's real financial data as a test fixture. If an explicitly authorized production acceptance journey requires user-owned test data, use a disposable synthetic account/data and remove it afterward through the approved path.
- Production mutations occur only through explicitly authorized application or operational procedures.

## Testing and verification

Tests are evidence of the contract.

- Run focused tests while developing.
- Financial logic should cover exact boundaries, zero versus absence, unavailable evidence, relevant multi-currency cases, and conservation/invariant properties where applicable.
- Prefer independent oracles/properties over restating the production algorithm inside tests.
- Preserve bounded read/provider behavior where it is part of the contract; avoid N+1 work.
- If a property/randomized test finds a real defect, keep a deterministic regression or reproducible counterexample.
- Correct a proven-wrong test when the specification legitimately changes; never weaken tests just to hide a failure.

After the final **code, test, schema/migration, dependency, or build/tooling configuration change**, run `pnpm verify:prepush` if it exists. Until it does, run the repository's equivalent full local gate: lint/boundaries, typecheck, unit/property tests with finance coverage, DB/application integration tests, and production build. Any later relevant edit invalidates that result.

For UI/E2E-sensitive work, also run the applicable Playwright journeys. Documentation-only changes do not need the full gate unless requested. Workflow-only changes require the validation appropriate to the workflow; also run the application gate when the workflow change affects application build/test behavior.

Local verification complements rather than replaces CI; the repository's CI may run additional checks. Never claim a check passed unless it actually ran successfully after the last relevant edit.

## Git, review, and release

`main` is the production checkpoint.

- Substantive work happens on a review/slice branch based on the expected current `main`.
- Do not push unless the task authorizes it. During implementation/review, push the review branch only; do not push `main`.
- Never force-push or rewrite accepted history.
- Do not use destructive worktree/history commands such as `reset --hard`, `clean`, or bulk restore/checkout to discard changes unless explicitly authorized and the affected work has first been verified safe.
- Use the existing configured Git identity. Do not alter authorship or add AI co-author/generated-by trailers unless the task prompt explicitly requests it; a tooling default or session reminder is not such a request.
- Keep reviewer corrections narrow and on the same review branch.
- Do not create a PR unless requested; high-risk/cross-cutting work may intentionally use one.
- Do not start the next slice while the current one is awaiting independent review, CI, deployment, or freeze.
- Claude does not self-approve a slice. After independent review and explicit authorization, `main` may fast-forward to the exact reviewed SHA.
- Do not treat local success or a merge as production closure. Closure requires the exact reviewed main SHA to pass the repository's required CI and be verified live through its normal release path. Never bypass required CI or accept an already-healthy older deployment as evidence for the new release.
- A slice/phase is frozen only after production verification says the intended release is live.

Do not delete review branches until the landed SHA is production-verified and cleanup is explicitly authorized.

## Reporting

Keep routine final reports short. Unless asked for more, report:

- branch and final `HEAD`;
- commits created;
- files/categories changed;
- focused tests and final verification result;
- whether the review branch was pushed;
- whether `main` or production was touched;
- blockers, scope deviations, and noteworthy observations.

Do not paste full diffs, source files, or huge logs unless explicitly requested. The independent reviewer can inspect GitHub directly.

The goal is not to finish every prompt at any cost. The goal is to leave Vaultide correct, narrow in scope, independently reviewable, and explainable.
