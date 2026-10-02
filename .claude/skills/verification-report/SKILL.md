---
name: verification-report
description: Run and report Vaultide's full local verification — dependency audit, pnpm verify:prepush, and the complete Playwright suite — with exact counts. Use before pushing a review branch, and whenever a task asks for verification totals.
---

# Full local verification and its report

CLAUDE.md decides when verification is required and what counts as a relevant edit. This skill is the
sequence and the report. Run focused suites while developing; run this after the last code, test,
schema, dependency or build/tooling change. Any later relevant edit invalidates the results.

## 1. Dependency audit

`pnpm audit --audit-level high` — CI runs it, `verify:prepush` does not.

- It must exit 0 with no high or critical advisory.
- Report moderate and low findings with their package and path, without acting on them.
- A new high or critical advisory the change did not cause is a repository-wide issue: stop and report
  it. Do not fix it inside the slice.

## 2. The gate

`pnpm verify:prepush`, with its output written to a log file. Strip ANSI colour codes before reading
counts, then report:

- **unit tests** per package — validation, finance, db, application, web — and the total;
- **finance coverage** — statements, branches, functions, lines, each with its fraction;
- **integration tests** per package — db, application — and the total;
- **build** — the Next.js version and whether it compiled.

Report a failure exactly as it happened, with its output.

## 3. The browser suite

`pnpm test:e2e:local` runs every Playwright journey against the build the gate just produced, with a
database provisioned for the run (see the header of `scripts/e2e/run-local.mjs`).

- Prerequisites: the local cluster is running (`pnpm db:local start`), port 3100 is free, and nothing
  else is using the cluster. Never run it alongside the integration suites.
- To pass Playwright arguments such as a spec or `--project`, call the script directly:
  `node --import tsx scripts/e2e/run-local.mjs <arguments>`.
- Its last lines are the summary: `total`, `first-pass`, `flaky`, `failed`, `skipped`, and every test
  that did not pass on its first attempt. Report those numbers as printed.
- For a test that failed or retried, read its first attempt's actual error before classifying it. Never
  call one a known flake from its project or file name alone.

## 4. Report

| Check | Result |
|---|---|
| Audit | exit code; high, critical, moderate, low |
| Unit | validation / finance / db / application / web = total |
| Finance coverage | statements, branches, functions, lines |
| Integration | db / application = total |
| Build | Next.js version, result |
| Playwright | total, first-pass, flaky/retried, failed, skipped |

Name any count that differs from the expected or previous one, and say exactly why. Never change or
remove a test to restore an expected count.
