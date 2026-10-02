---
name: land-pr
description: Land one independently reviewed Vaultide PR by advancing main to the exact reviewed head, then verify post-merge CI, the production deploy and production health. Manual only.
argument-hint: <pr-number> <reviewed-base-sha> <reviewed-head-sha>
arguments: [pr, base, head]
disable-model-invocation: true
---

# Land PR #$pr

The user invoked this with PR `$pr`, reviewed base `$base` and reviewed head `$head`. That invocation is
the explicit landing authorization CLAUDE.md requires, for exactly that PR, base and head, and nothing
else. CLAUDE.md's rules under "Git, review, and release" apply throughout; this skill only orders the
steps.

Before anything else: if any of the three arguments is missing, or either SHA is not a full 40-character
hex SHA, stop and ask. Never infer a SHA, take one from the PR page as authority, or land a different
head because it looks newer.

## Stop conditions

Stop and report — never work around — when any of these is true:

- `origin/main` is not `$base`, or the PR head is not `$head`;
- the PR is not open, does not target `main`, or is not a linear fast-forward of `$base`;
- a review requests changes, or a review thread is unresolved;
- the exact-head CI is missing, unfinished or not fully successful, or a code-checkout job ran another SHA;
- the dependency audit shows a high or critical advisory;
- the working tree is dirty, or there is a stash;
- the push is not a fast-forward.

Never squash, create a merge commit, rebase, amend, cherry-pick, force-push, delete a branch, trigger a
second deploy while one exists, or start the next slice.

## 1. Pre-merge live checks

1. `git fetch origin`. Check `origin/main` equals `$base`, and the remote head branch equals `$head`.
2. `gh pr view $pr --json state,mergedAt,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,reviews,commits,changedFiles`:
   open, unmerged, base ref `main`, head `$head`, mergeable and clean. Count unresolved review threads
   with the GraphQL `reviewThreads { isResolved }` field: it must be 0.
3. `git rev-list --left-right --count $base...$head` is `0 N`. Each commit in `$base..$head` has one
   parent (`git log --format='%H %P %s' $base..$head`).
4. List `git diff --name-only $base $head` for the report, and compare it with the reviewed file list
   when the user gave one.
5. Exact-head CI: `gh run list --commit $head` and `gh run view <id> --json conclusion,headSha,jobs`.
   Every job succeeded. In the log (`gh run view <id> --log`, with ANSI codes stripped), every
   code-checkout job shows `HEAD is now at <first 7 of $head>`. Read the audit step's summary.
6. Run `pnpm audit --audit-level high` locally as well, because the advisory database is live. It must
   exit 0 with no high or critical advisory. Report moderate and low findings without acting on them.
7. Local working tree clean, no stash.

## 2. Land

1. `git fetch origin` again, and recheck `origin/main == $base` and PR head `== $head` in the same
   command as the push.
2. `git push origin $head:refs/heads/main` — never a force push. The repository's ask rule prompts the
   user at this moment; that prompt is the final human gate, and is expected.
3. If the push is refused or is not a fast-forward, stop.

## 3. Integrity

1. `git fetch origin`; `origin/main` is `$head`.
2. `gh pr view $pr --json state,mergedAt,mergeCommit`: merged, and the merge commit is `$head`. Record
   the merge timestamp.
3. `git rev-parse origin/main^{tree}` equals `git rev-parse $head^{tree}`, and
   `git log --format='%H %s' $base..origin/main` lists exactly the reviewed commits.
4. Fast-forward local `main` with `git merge --ff-only origin/main`. The working tree stays clean.

## 4. Post-merge CI

1. Find the push run on `main` for `$head`: `gh run list --commit $head`.
2. Wait in the background with `gh run watch <id>`, then confirm with
   `gh run view <id> --json status,conclusion`. A watcher can return early: never read its exit code as
   the run's result.
3. Inspect every job, not the badge:
   - the checkout SHA;
   - the audit summary;
   - unit counts per package, finance coverage, integration counts;
   - the build's Next.js version;
   - Playwright total, first-pass, flaky or retried, failed, skipped.
4. For any retry, read the first attempt's actual error before classifying it. Never classify a retry as
   a known flake from its project or file name alone.

## 5. Production

1. Find the deploy that the successful push CI triggered:
   `gh run list --workflow deploy-production.yml --limit 3`. It must be for `$head`. Do not trigger
   one manually unless it never started.
2. Wait as above, then read its steps:
   - the candidate is the current tip of `main`;
   - migrations applied;
   - currency seed;
   - the deploy hook accepted;
   - the health gate's final line.
3. Check both production health endpoints, `https://vaultide.app/api/health` and
   `https://vaultide.vercel.app/api/health`. Each must report `status` ok, `database` ok and `version`
   equal to the first 7 characters of `$head`. The landing is not closed until both do.

## 6. Report

Report, briefly and exactly:

- **Pre-merge:** main, PR head, commits, mergeability, ahead/behind, changed files, reviews and
  threads, exact-head CI, local audit.
- **Landing:** the push and its result, merge timestamp, resulting main, SHAs preserved.
- **Integrity:** tree equality, lineage, working tree.
- **Post-merge CI:** run id, SHA, every job, audit, unit and integration totals, coverage, build, and
  Playwright total / first-pass / flaky / failed / skipped, with any retry classified from its error.
- **Production:** deploy run id, source SHA, migrations, seed, hook, health gate, both health checks.
- **Final state:** main and production SHA, working tree, branches retained.

Then stop. Branch cleanup needs its own authorization.
