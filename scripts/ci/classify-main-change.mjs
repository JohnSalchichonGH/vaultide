#!/usr/bin/env node
/**
 * Full suite or docs only: how much of CI a run needs (blueprint 21.7).
 *
 *   node scripts/ci/classify-main-change.mjs              (in GitHub Actions)
 *   node --test scripts/ci/classify-main-change.test.mjs
 *
 * Pull requests and manual runs always get the full suite. A push to main is
 * light — the heavy jobs skipped — only when every path that differs between
 * the pushed commit and the last main commit to pass the full suite is
 * README.md or under docs/.
 *
 * The comparison starts at that commit, never at the previous push. CI cancels
 * an in-progress main run when the next push arrives, so a docs commit pushed
 * on top of a code commit whose run was cancelled would look harmless against
 * its parent while the code beneath it was never verified.
 *
 * That commit, the anchor, is the head of the newest successful push run of
 * this workflow on main whose `Full CI complete` job succeeded; ci.yml runs that
 * job only after every job of the full suite has passed. Pull request runs
 * never count, even for the same commit.
 *
 * Every doubt resolves to the full suite: a failed or unexpected API answer, no
 * anchor, an anchor that is not an ancestor of the pushed commit, an empty
 * comparison, or any path outside the allowlist. Uncertainty may waste a run;
 * it must never skip one.
 *
 * Writes `full_ci` (true|false), `anchor` and `reason` to $GITHUB_OUTPUT.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The only branch whose pushes may run light; ci.yml's push trigger names it alone. */
export const MAIN_BRANCH = 'main';

/** The name ci.yml gives the job that marks a passed full suite. */
export const MARKER_JOB = 'Full CI complete';

/** How many recent successful pushes to main are searched for the marker. */
export const RUNS_SEARCHED = 30;

/** Paths listed in the log and the step summary. */
const PATHS_LISTED = 50;

const SHA = /^[0-9a-f]{40}$/;

const short = (sha) => sha.slice(0, 7);

/**
 * The explicit allowlist: README.md, and anything under docs/. Nothing is
 * harmless by extension — CLAUDE.md, a package's README or any other Markdown
 * outside those two places needs the full suite like any unknown path.
 */
export function isHarmlessPath(file) {
  if (file === 'README.md') return true;
  if (typeof file !== 'string' || !file.startsWith('docs/')) return false;
  // Git never reports empty, `.` or `..` segments; refuse them rather than
  // reason about where they point.
  return file
    .slice('docs/'.length)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function full(reason, anchor = null, paths = []) {
  return { fullCi: true, anchor, reason, paths };
}

/**
 * The decision. `api(resource)` resolves to the parsed JSON of a GitHub REST
 * GET, or is null when there is no token; `git` answers two questions about
 * commits in the checkout. Both are injected so the tests can drive every
 * branch with real Git and a scripted Actions history.
 */
export async function classify({ eventName, ref, sha, repository, runId }, { api, git }) {
  if (eventName === 'pull_request') return full('Pull requests always run full CI.');
  if (eventName === 'workflow_dispatch') return full('Manual runs always run full CI.');
  if (eventName !== 'push') {
    return full(`Unrecognised event ${JSON.stringify(eventName)}; running full CI.`);
  }
  if (ref !== `refs/heads/${MAIN_BRANCH}`) {
    return full(`A push to ${JSON.stringify(ref)} is not a push to ${MAIN_BRANCH}; running full CI.`);
  }
  if (!SHA.test(sha ?? '')) return full('The commit under test is not a full SHA; running full CI.');

  let anchor;
  try {
    anchor = await findAnchor({ repository, runId, sha }, api);
  } catch (error) {
    return full(`Could not establish a safe full-CI anchor (${error.message}); running full CI.`);
  }
  if (anchor === null) {
    return full(
      `No successful "${MARKER_JOB}" job in the last ${RUNS_SEARCHED} successful pushes ` +
        `to ${MAIN_BRANCH}; running full CI.`,
    );
  }

  let paths;
  try {
    if (!git.isAncestor(anchor, sha)) {
      return full(
        `Full-CI anchor ${short(anchor)} is not an ancestor of ${short(sha)}; running full CI.`,
        anchor,
      );
    }
    paths = git.changedPaths(anchor, sha);
  } catch (error) {
    return full(
      `Could not compare ${short(sha)} with full-CI anchor ${short(anchor)} (${error.message}); ` +
        'running full CI.',
      anchor,
    );
  }

  if (paths.length === 0) {
    return full(
      `Nothing differs from full-CI anchor ${short(anchor)}, so nothing shows the change is ` +
        'documentation; running full CI.',
      anchor,
    );
  }
  const outside = paths.filter((file) => !isHarmlessPath(file));
  if (outside.length > 0) {
    const more = outside.length > 1 ? ` and ${outside.length - 1} more` : '';
    return full(
      `Changes outside README.md and docs/** since full-CI anchor ${short(anchor)}: ` +
        `${JSON.stringify(outside[0])}${more}; running full CI.`,
      anchor,
      paths,
    );
  }
  return {
    fullCi: false,
    anchor,
    reason:
      `Only README.md and docs/** changed since full-CI anchor ${short(anchor)}; ` +
      'skipping the heavy jobs.',
    paths,
  };
}

/**
 * The head SHA of the newest successful push run of this workflow on main
 * whose marker job succeeded, or null when the searched history has none.
 * Throws on anything unexpected; the caller turns that into the full suite.
 */
async function findAnchor({ repository, runId, sha }, api) {
  if (!api) throw new Error('no GitHub token');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('no usable GITHUB_REPOSITORY');
  if (!/^[1-9]\d*$/.test(runId ?? '')) throw new Error('no usable GITHUB_RUN_ID');

  // This run itself: it confirms the context and names the workflow to search.
  const current = await api(`/repos/${repository}/actions/runs/${runId}`);
  if (
    current?.id !== Number(runId) ||
    current.event !== 'push' ||
    current.head_branch !== MAIN_BRANCH ||
    current.head_sha !== sha ||
    !Number.isInteger(current.workflow_id)
  ) {
    throw new Error(`run ${runId} is not this push to ${MAIN_BRANCH}`);
  }

  const listing = await api(
    `/repos/${repository}/actions/workflows/${current.workflow_id}/runs` +
      `?branch=${MAIN_BRANCH}&event=push&status=success&exclude_pull_requests=true` +
      `&per_page=${RUNS_SEARCHED}`,
  );
  if (!Array.isArray(listing?.workflow_runs)) throw new Error('unexpected workflow runs response');

  // The query already asks for exactly these; a run still has to say so itself.
  const candidates = listing.workflow_runs.filter(
    (run) =>
      run?.id !== current.id &&
      run?.workflow_id === current.workflow_id &&
      run?.event === 'push' &&
      run?.head_branch === MAIN_BRANCH &&
      run?.head_repository?.full_name === repository &&
      run?.status === 'completed' &&
      run?.conclusion === 'success',
  );
  for (const run of candidates) {
    if (!Number.isInteger(run.id) || !Number.isInteger(run.run_number) || !SHA.test(run.head_sha ?? '')) {
      throw new Error(`unexpected fields on run ${run.id}`);
    }
  }
  candidates.sort((a, b) => b.run_number - a.run_number);

  for (const run of candidates.slice(0, RUNS_SEARCHED)) {
    const page = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (!Array.isArray(page?.jobs) || page.total_count !== page.jobs.length) {
      throw new Error(`unexpected jobs response for run ${run.id}`);
    }
    const marked = page.jobs.some(
      (job) =>
        job?.name === MARKER_JOB &&
        job.run_id === run.id &&
        job.head_sha === run.head_sha &&
        job.status === 'completed' &&
        job.conclusion === 'success',
    );
    // A light run has the marker too, skipped: keep looking beneath it.
    if (marked) return run.head_sha;
  }
  return null;
}

/** A GET against the GitHub REST API. The token goes in a header and nowhere else. */
export function githubApi({ apiUrl, token, fetchImpl = fetch }) {
  return async (resource) => {
    const response = await fetchImpl(`${apiUrl}${resource}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'vaultide-ci-classifier',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${resource.split('?')[0]}`);
    return response.json();
  };
}

/** The two Git questions the decision asks, answered in the repository at `cwd`. */
export function gitIn(cwd, env = process.env) {
  const git = (args) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const failure = (command, result) =>
    new Error(`${command} failed: ${(result.stderr || result.error?.message || '').trim().split('\n')[0]}`);

  return {
    isAncestor(ancestor, descendant) {
      const result = git(['merge-base', '--is-ancestor', ancestor, descendant]);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw failure('git merge-base', result);
    },
    changedPaths(from, to) {
      // Tree against tree. --no-renames: a file moved from apps/ into docs/
      // must report its old path too, or the move would pass as documentation.
      const result = git(['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', from, to, '--']);
      if (result.status !== 0) throw failure('git diff', result);
      return result.stdout.split('\0').filter((file) => file !== '');
    },
  };
}

/** `$GITHUB_OUTPUT` lines; the reason is kept to one line so it cannot add an output. */
export function outputLines({ fullCi, anchor, reason }) {
  return `full_ci=${fullCi}\nanchor=${anchor ?? ''}\nreason=${reason.replace(/[\r\n]+/g, ' ')}\n`;
}

function summaryLines({ fullCi, anchor, reason, paths }) {
  const lines = [`### CI scope: ${fullCi ? 'full suite' : 'docs only'}`, '', reason, ''];
  if (anchor) lines.push(`Full-CI anchor: \`${anchor}\``, '');
  if (paths.length > 0) {
    // JSON-quoted, so no path can begin a line that closes the fence.
    lines.push(`Paths changed since the anchor (${paths.length}):`, '', '```text');
    lines.push(...paths.slice(0, PATHS_LISTED).map((file) => JSON.stringify(file)));
    if (paths.length > PATHS_LISTED) lines.push(`… and ${paths.length - PATHS_LISTED} more`);
    lines.push('```', '');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const env = process.env;
  let result;
  try {
    result = await classify(
      {
        eventName: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
        sha: env.CI_SHA,
        repository: env.GITHUB_REPOSITORY,
        runId: env.GITHUB_RUN_ID,
      },
      {
        api:
          env.GITHUB_TOKEN && env.GITHUB_API_URL
            ? githubApi({ apiUrl: env.GITHUB_API_URL, token: env.GITHUB_TOKEN })
            : null,
        git: gitIn(process.cwd()),
      },
    );
  } catch (error) {
    result = full(`The classifier failed (${error.message}); running full CI.`);
  }

  console.log(`CI scope: ${result.fullCi ? 'FULL' : 'LIGHT (docs only)'}`);
  console.log(result.reason);
  if (result.anchor) console.log(`Full-CI anchor: ${result.anchor}`);
  for (const file of result.paths.slice(0, PATHS_LISTED)) console.log(`  ${JSON.stringify(file)}`);

  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputLines(result));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryLines(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
