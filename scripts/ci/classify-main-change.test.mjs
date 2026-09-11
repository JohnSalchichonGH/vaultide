/**
 * Tests for the CI classifier (scripts/ci/classify-main-change.mjs).
 *
 *   node --test scripts/ci/classify-main-change.test.mjs
 *
 * The Actions history is scripted, and deliberately ignores the query's
 * filters: the classifier's own checks are what must keep pull request,
 * failed, cancelled and light runs from becoming anchors. Commit histories are
 * real throwaway Git repositories, so ancestry and the changed-path list come
 * from Git itself.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  classify,
  githubApi,
  gitIn,
  isHarmlessPath,
  MARKER_JOB,
  outputLines,
  RUNS_SEARCHED,
} from './classify-main-change.mjs';

const REPOSITORY = 'example/vaultide';
const WORKFLOW_ID = 7;
const CURRENT_RUN_ID = 9000;

/** A well-formed SHA that no repository here contains. */
const fakeSha = (digit) => digit.repeat(40);

const pushTo = (sha) => ({
  eventName: 'push',
  ref: 'refs/heads/main',
  sha,
  repository: REPOSITORY,
  runId: String(CURRENT_RUN_ID),
});

/** A completed, successful push run of this workflow on main, unless overridden. */
function run(id, runNumber, headSha, overrides = {}) {
  return {
    id,
    run_number: runNumber,
    workflow_id: WORKFLOW_ID,
    event: 'push',
    head_branch: 'main',
    head_sha: headSha,
    head_repository: { full_name: REPOSITORY },
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

/**
 * The jobs of `target` as ci.yml would leave them: `marker` is how the marker
 * job ended, or null for a run from before the marker existed.
 */
function jobsOf(target, marker) {
  const heavy = marker === 'skipped' ? 'skipped' : 'success';
  const jobs = [
    { name: 'Classify the change', conclusion: 'success' },
    { name: 'Secret scan', conclusion: 'success' },
    { name: 'Lint, boundaries and types', conclusion: heavy },
    { name: 'Build and end-to-end', conclusion: heavy },
    ...(marker === null ? [] : [{ name: MARKER_JOB, conclusion: marker }]),
  ];
  return jobs.map((job, index) => ({
    id: target.id * 100 + index,
    run_id: target.id,
    head_sha: target.head_sha,
    status: 'completed',
    ...job,
  }));
}

/**
 * A scripted Actions API over `entries` ({ run, marker }). It answers every
 * listing with every run it holds, whatever the query asked for, and records
 * each request. `current` overrides fields of this run's own record.
 */
function actions(currentSha, entries, current = {}) {
  const requests = [];
  const jobs = new Map(entries.map(({ run: target, marker }) => [target.id, jobsOf(target, marker)]));
  const api = async (resource) => {
    requests.push(resource);
    const [pathname] = resource.split('?');
    if (pathname === `/repos/${REPOSITORY}/actions/runs/${CURRENT_RUN_ID}`) {
      return run(CURRENT_RUN_ID, 1000, currentSha, { status: 'in_progress', conclusion: null, ...current });
    }
    if (pathname === `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs`) {
      return { total_count: entries.length, workflow_runs: entries.map((entry) => entry.run) };
    }
    const match = /\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (match && jobs.has(Number(match[1]))) {
      const list = jobs.get(Number(match[1]));
      return { total_count: list.length, jobs: list };
    }
    throw new Error(`HTTP 404 from ${pathname}`);
  };
  return { api, requests };
}

/** Git for tests about the Actions side: any anchor is an ancestor, and only docs changed. */
const docsOnlyGit = {
  isAncestor: () => true,
  changedPaths: () => ['docs/development-state.md'],
};

/** A throwaway repository, isolated from the user's and the system's Git configuration. */
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'vaultide-classifier-'));
  const dir = path.join(root, 'repo');
  const globalConfig = path.join(root, 'gitconfig');
  mkdirSync(dir);
  writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Classifier test',
    GIT_AUTHOR_EMAIL: 'classifier-test@example.invalid',
    GIT_COMMITTER_NAME: 'Classifier test',
    GIT_COMMITTER_EMAIL: 'classifier-test@example.invalid',
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');

  return {
    git: gitIn(dir, env),
    run: git,
    /** Writes each file (null deletes it), commits everything and returns the SHA. */
    commit(message, files = {}) {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        if (content === null) {
          rmSync(target);
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      }
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** Runs `scenario` against a fresh repository and removes it afterwards. */
async function inRepository(scenario) {
  const repo = repository();
  try {
    await scenario(repo);
  } finally {
    repo.remove();
  }
}

const baseline = {
  'apps/web/src/app/page.tsx': 'export default function Page() {}\n',
  'docs/development-state.md': 'State one.\n',
  'README.md': 'Vaultide.\n',
};

describe('the harmless-path allowlist', () => {
  test('README.md and anything under docs/ is harmless', () => {
    for (const file of [
      'README.md',
      'docs/development-state.md',
      'docs/adr/0005-phase-3-implementation-decisions.md',
      'docs/ops/restore.md',
      'docs/diagram.png',
    ]) {
      assert.equal(isHarmlessPath(file), true, file);
    }
  });

  test('nothing else is, whatever its extension', () => {
    for (const file of [
      'CLAUDE.md',
      '.github/workflows/ci.yml',
      '.github/workflows/deploy-production.yml',
      'apps/web/src/app/page.tsx',
      'packages/finance/src/index.ts',
      'scripts/ci/classify-main-change.mjs',
      'e2e/monthly.spec.ts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.gitleaks.toml',
      '.npmrc',
      'packages/finance/test/golden/basic-eur-september/README.md',
      'apps/web/README.md',
      'CHANGELOG.md',
      'readme.md',
      'README.MD',
      'Docs/notes.md',
      'docs.md',
      'docs',
      'docs/',
      'docs/../apps/web/src/app/page.tsx',
      './README.md',
      'a-new-unknown-file',
      '',
    ]) {
      assert.equal(isHarmlessPath(file), false, JSON.stringify(file));
    }
  });
});

describe('a push to main, measured against its full-CI anchor', () => {
  const anchor = fakeSha('a');
  const head = fakeSha('c');
  const classifyPaths = (paths) =>
    classify(pushTo(head), {
      api: actions(head, [{ run: run(101, 1, anchor), marker: 'success' }]).api,
      git: { isAncestor: () => true, changedPaths: () => paths },
    });

  for (const [name, paths, fullCi] of [
    ['README.md alone is light', ['README.md'], false],
    ['one file under docs/ is light', ['docs/development-state.md'], false],
    [
      'many files under docs/ are light',
      ['docs/adr/0006-x.md', 'docs/implementation-blueprint.md', 'docs/ops/restore.md'],
      false,
    ],
    ['README.md with docs/ is light', ['README.md', 'docs/development-state.md'], false],
    ['CLAUDE.md is full', ['CLAUDE.md'], true],
    ['a workflow file is full', ['.github/workflows/ci.yml'], true],
    ['source code is full', ['packages/finance/src/money/index.ts'], true],
    ['a package manifest is full', ['apps/web/package.json'], true],
    ['the lockfile is full', ['pnpm-lock.yaml'], true],
    ['root configuration is full', ['.dependency-cruiser.cjs'], true],
    ['Markdown outside the allowlist is full', ['packages/finance/test/golden/simple-user/README.md'], true],
    [
      'docs with one runtime file among them is full',
      ['README.md', 'docs/development-state.md', 'packages/db/migrations/0008_next.sql'],
      true,
    ],
    ['an empty comparison is full', [], true],
  ]) {
    test(name, async () => {
      const result = await classifyPaths(paths);
      assert.equal(result.fullCi, fullCi, result.reason);
      assert.equal(result.anchor, anchor);
    });
  }

  test('a full result names the path that forced it', async () => {
    const result = await classifyPaths(['docs/a.md', 'packages/db/migrations/0008_next.sql', 'e2e/x.ts']);
    assert.match(result.reason, /"packages\/db\/migrations\/0008_next\.sql" and 1 more/);
  });
});

describe('choosing the full-CI anchor', () => {
  const head = fakeSha('c');
  const anchorOf = async (entries) => classify(pushTo(head), { api: actions(head, entries).api, git: docsOnlyGit });

  test('the newest successful push to main whose marker passed', async () => {
    const result = await anchorOf([
      { run: run(101, 1, fakeSha('1')), marker: 'success' },
      { run: run(103, 3, fakeSha('3')), marker: 'success' },
      { run: run(102, 2, fakeSha('2')), marker: 'success' },
    ]);
    assert.equal(result.anchor, fakeSha('3'));
    assert.equal(result.fullCi, false);
  });

  test('a light run is passed over for the full run beneath it', async () => {
    const result = await anchorOf([
      { run: run(101, 1, fakeSha('1')), marker: 'success' },
      { run: run(102, 2, fakeSha('2')), marker: 'skipped' },
    ]);
    assert.equal(result.anchor, fakeSha('1'));
  });

  test('a pull request run never anchors, even one that passed for a commit now on main', async () => {
    const pullRequest = run(103, 3, fakeSha('3'), { event: 'pull_request' });
    const withFullBeneath = await anchorOf([
      { run: run(101, 1, fakeSha('1')), marker: 'success' },
      { run: pullRequest, marker: 'success' },
    ]);
    assert.equal(withFullBeneath.anchor, fakeSha('1'));

    const alone = await anchorOf([{ run: pullRequest, marker: 'success' }]);
    assert.equal(alone.fullCi, true);
    assert.equal(alone.anchor, null);
  });

  test('neither does a manual run', async () => {
    const result = await anchorOf([
      { run: run(101, 1, fakeSha('1'), { event: 'workflow_dispatch' }), marker: 'success' },
    ]);
    assert.equal(result.fullCi, true);
    assert.equal(result.anchor, null);
  });

  test('failed and cancelled runs never anchor', async () => {
    const result = await anchorOf([
      { run: run(101, 1, fakeSha('1'), { conclusion: 'failure' }), marker: 'skipped' },
      { run: run(102, 2, fakeSha('2'), { conclusion: 'cancelled' }), marker: 'success' },
      { run: run(103, 3, fakeSha('3'), { status: 'in_progress', conclusion: null }), marker: 'success' },
      { run: run(104, 4, fakeSha('4')), marker: 'failure' },
      { run: run(105, 5, fakeSha('5')), marker: 'cancelled' },
    ]);
    assert.equal(result.fullCi, true);
    assert.equal(result.anchor, null);
  });

  test('nor does this run, another workflow, another branch or another repository', async () => {
    const result = await anchorOf([
      { run: run(CURRENT_RUN_ID, 1000, head), marker: 'success' },
      { run: run(102, 2, fakeSha('2'), { workflow_id: WORKFLOW_ID + 1 }), marker: 'success' },
      { run: run(103, 3, fakeSha('3'), { head_branch: 'phase3/next' }), marker: 'success' },
      { run: run(104, 4, fakeSha('4'), { head_repository: { full_name: 'fork/vaultide' } }), marker: 'success' },
    ]);
    assert.equal(result.fullCi, true);
    assert.equal(result.anchor, null);
  });

  test('without a marker anywhere, the first run of the scheme is full', async () => {
    const result = await anchorOf([
      { run: run(101, 1, fakeSha('1')), marker: null },
      { run: run(102, 2, fakeSha('2')), marker: null },
    ]);
    assert.equal(result.fullCi, true);
    assert.equal(result.anchor, null);
    assert.match(result.reason, /No successful "Full CI complete" job/);
  });

  test('a marker beyond the searched history does not count', async () => {
    const entries = [{ run: run(100, 1, fakeSha('1')), marker: 'success' }];
    for (let n = 2; n <= RUNS_SEARCHED + 1; n += 1) {
      entries.push({ run: run(100 + n, n, fakeSha('2')), marker: 'skipped' });
    }
    const result = await anchorOf(entries);
    assert.equal(result.fullCi, true);
    assert.equal(result.anchor, null);
  });

  test('the search asks only for successful pushes to main of this workflow', async () => {
    const { api, requests } = actions(head, [{ run: run(101, 1, fakeSha('1')), marker: 'success' }]);
    await classify(pushTo(head), { api, git: docsOnlyGit });
    const listing = new URL(requests[1], 'https://api.invalid');
    assert.equal(listing.pathname, `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs`);
    assert.equal(listing.searchParams.get('branch'), 'main');
    assert.equal(listing.searchParams.get('event'), 'push');
    assert.equal(listing.searchParams.get('status'), 'success');
  });
});

describe('when the Actions history cannot be trusted', () => {
  const head = fakeSha('c');
  const entries = [{ run: run(101, 1, fakeSha('1')), marker: 'success' }];
  const expectFull = async (api) => {
    const result = await classify(pushTo(head), { api, git: docsOnlyGit });
    assert.equal(result.fullCi, true);
    assert.match(result.reason, /^Could not establish a safe full-CI anchor .*; running full CI\.$/);
    return result;
  };

  test('an API error is full', async () => {
    await expectFull(async () => {
      throw new Error('HTTP 502 from /repos/example/vaultide/actions/runs/9000');
    });
  });

  test('no token is full', async () => {
    await expectFull(null);
  });

  test('a malformed runs listing is full', async () => {
    const { api } = actions(head, entries);
    await expectFull(async (resource) => (resource.includes('/workflows/') ? { runs: [] } : api(resource)));
  });

  test('a run with malformed fields is full', async () => {
    await expectFull(actions(head, [{ run: run(101, 1, 'not-a-sha'), marker: 'success' }]).api);
  });

  test('a truncated jobs listing is full', async () => {
    const { api } = actions(head, entries);
    await expectFull(async (resource) => {
      const answer = await api(resource);
      return resource.includes('/jobs') ? { ...answer, total_count: answer.total_count + 1 } : answer;
    });
  });

  test('a record of this run that does not match this push is full', async () => {
    await expectFull(actions(head, entries, { head_sha: fakeSha('d') }).api);
    await expectFull(actions(head, entries, { event: 'pull_request' }).api);
  });

  test('the HTTP client fails closed and never repeats the token', async () => {
    // Built, not written out, so the secret scan has no literal to flag.
    const token = 'x'.repeat(24);
    const seen = [];
    const api = githubApi({
      apiUrl: 'https://api.invalid',
      token,
      fetchImpl: async (url, init) => {
        seen.push(init.headers.authorization);
        return { ok: false, status: 503, json: async () => ({}) };
      },
    });
    const result = await expectFull(api);
    assert.deepEqual(seen, [`Bearer ${token}`]);
    assert.equal(result.reason.includes(token), false);
  });
});

describe('events other than a push to main', () => {
  const untouched = {
    api: async () => assert.fail('no API call expected'),
    git: {
      isAncestor: () => assert.fail('no Git call expected'),
      changedPaths: () => assert.fail('no Git call expected'),
    },
  };
  const head = fakeSha('c');

  test('a pull request is full, even one that only changes README.md', async () => {
    const result = await classify({ ...pushTo(head), eventName: 'pull_request', ref: 'refs/pull/7/merge' }, untouched);
    assert.deepEqual(result, { fullCi: true, anchor: null, reason: 'Pull requests always run full CI.', paths: [] });
  });

  test('a manual run is full, even on a docs-only tip of main', async () => {
    const result = await classify({ ...pushTo(head), eventName: 'workflow_dispatch' }, untouched);
    assert.deepEqual(result, { fullCi: true, anchor: null, reason: 'Manual runs always run full CI.', paths: [] });
  });

  test('a push to another branch, an unknown event or a malformed SHA is full', async () => {
    for (const context of [
      { ...pushTo(head), ref: 'refs/heads/phase3/next' },
      { ...pushTo(head), eventName: 'merge_group' },
      { ...pushTo(head), eventName: undefined },
      { ...pushTo(head), sha: 'c'.repeat(39) },
      { ...pushTo(head), sha: undefined },
    ]) {
      const result = await classify(context, untouched);
      assert.equal(result.fullCi, true, JSON.stringify(context));
    }
  });
});

describe('real commit histories', () => {
  test('a docs commit on a code commit whose run was cancelled is full', async () => {
    await inRepository(async (repo) => {
      const full = repo.commit('F: last full CI', baseline);
      const code = repo.commit('R: runtime change', { 'apps/web/src/app/page.tsx': 'export default 2;\n' });
      const docs = repo.commit('D: docs change', { 'docs/development-state.md': 'State two.\n' });

      // Against its parent alone, D looks like documentation.
      assert.deepEqual(repo.git.changedPaths(code, docs), ['docs/development-state.md']);

      const { api } = actions(docs, [
        { run: run(101, 1, full), marker: 'success' },
        { run: run(102, 2, code, { conclusion: 'cancelled' }), marker: 'skipped' },
      ]);
      const result = await classify(pushTo(docs), { api, git: repo.git });
      assert.equal(result.fullCi, true);
      assert.equal(result.anchor, full);
      assert.deepEqual(result.paths, ['apps/web/src/app/page.tsx', 'docs/development-state.md']);
      assert.match(result.reason, /"apps\/web\/src\/app\/page\.tsx"/);
    });
  });

  test('a chain of docs commits stays light on the same anchor', async () => {
    await inRepository(async (repo) => {
      const full = repo.commit('F: last full CI', baseline);
      const firstDocs = repo.commit('D1: status', { 'docs/development-state.md': 'State two.\n' });

      const first = await classify(pushTo(firstDocs), {
        api: actions(firstDocs, [{ run: run(201, 1, full), marker: 'success' }]).api,
        git: repo.git,
      });
      assert.equal(first.fullCi, false, first.reason);
      assert.equal(first.anchor, full);

      const secondDocs = repo.commit('D2: readme', { 'README.md': 'Vaultide, again.\n' });
      const second = await classify(pushTo(secondDocs), {
        api: actions(secondDocs, [
          { run: run(201, 1, full), marker: 'success' },
          { run: run(202, 2, firstDocs), marker: 'skipped' },
        ]).api,
        git: repo.git,
      });
      assert.equal(second.fullCi, false, second.reason);
      assert.equal(second.anchor, full);
      assert.deepEqual(second.paths, ['README.md', 'docs/development-state.md']);
    });
  });

  test('an anchor that is not an ancestor of the pushed commit is full', async () => {
    await inRepository(async (repo) => {
      const full = repo.commit('F: last full CI', baseline);
      repo.run('switch', '-q', '-c', 'elsewhere');
      const elsewhere = repo.commit('X: not on main', { 'docs/elsewhere.md': 'Elsewhere.\n' });
      repo.run('switch', '-q', 'main');
      const docs = repo.commit('D: docs change', { 'docs/development-state.md': 'State two.\n' });

      const { api } = actions(docs, [
        { run: run(301, 1, full), marker: 'success' },
        { run: run(302, 2, elsewhere), marker: 'success' },
      ]);
      const result = await classify(pushTo(docs), { api, git: repo.git });
      assert.equal(result.fullCi, true);
      assert.equal(result.anchor, elsewhere);
      assert.match(result.reason, /is not an ancestor of/);
    });
  });

  test('an anchor missing from the checkout is full', async () => {
    await inRepository(async (repo) => {
      repo.commit('F: last full CI', baseline);
      const docs = repo.commit('D: docs change', { 'docs/development-state.md': 'State two.\n' });
      const { api } = actions(docs, [{ run: run(401, 1, fakeSha('e')), marker: 'success' }]);
      const result = await classify(pushTo(docs), { api, git: repo.git });
      assert.equal(result.fullCi, true);
      assert.match(result.reason, /^Could not compare/);
    });
  });

  test('moving a file out of apps/ into docs/ is full', async () => {
    await inRepository(async (repo) => {
      const moved = 'export const legacy = 1;\n';
      const full = repo.commit('F: last full CI', { ...baseline, 'apps/web/src/legacy.ts': moved });
      const docs = repo.commit('D: move', { 'apps/web/src/legacy.ts': null, 'docs/legacy.ts': moved });
      const { api } = actions(docs, [{ run: run(501, 1, full), marker: 'success' }]);
      const result = await classify(pushTo(docs), { api, git: repo.git });
      assert.equal(result.fullCi, true);
      assert.deepEqual(result.paths, ['apps/web/src/legacy.ts', 'docs/legacy.ts']);
    });
  });

  test('a commit that changes nothing is full', async () => {
    await inRepository(async (repo) => {
      const full = repo.commit('F: last full CI', baseline);
      const empty = repo.commit('E: empty');
      const { api } = actions(empty, [{ run: run(601, 1, full), marker: 'success' }]);
      const result = await classify(pushTo(empty), { api, git: repo.git });
      assert.equal(result.fullCi, true);
      assert.match(result.reason, /^Nothing differs from full-CI anchor/);
    });
  });
});

describe('the workflow that consumes the decision', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  test('names its marker job exactly as the classifier looks for it', () => {
    assert.match(workflow, new RegExp(`^ {4}name: ${MARKER_JOB}\\r?$`, 'm'));
  });

  test('skips a job only on an explicit docs-only answer', () => {
    const gates = workflow.match(/needs\.classify\.outputs\.full_ci\s*\S+\s*'[^']*'/g) ?? [];
    assert.ok(gates.length > 0);
    for (const gate of gates) assert.equal(gate, "needs.classify.outputs.full_ci != 'false'");
  });
});

describe('outputs', () => {
  test('each output stays on one line', () => {
    assert.equal(
      outputLines({ fullCi: false, anchor: fakeSha('a'), reason: 'two\nlines' }),
      `full_ci=false\nanchor=${fakeSha('a')}\nreason=two lines\n`,
    );
    assert.equal(outputLines({ fullCi: true, anchor: null, reason: 'x' }), 'full_ci=true\nanchor=\nreason=x\n');
  });
});
