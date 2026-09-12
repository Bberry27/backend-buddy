// Consistency tests for the repository's entry points (R00). They pin the decisions an
// independent verifier found drifting after the bootstrap: one script-test invocation
// defined in package.json and echoed by every document that names it, a CI `scripts` job
// that restores dependencies before running it, a test glob that really recurses, and root
// governance documents whose relative links resolve to files that exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_GLOB = 'scripts/**/*.test.mjs';
const TEST_SCRIPT = `node --test "${TEST_GLOB}"`;
/** Earlier spellings of the invocation; none may survive anywhere the command is documented. */
const SUPERSEDED_GLOBS = ['"scripts/*.test.mjs"', '{.test,-test,_test}'];
const DOCS_NAMING_THE_COMMAND = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'fixtures/README.md',
  'docs/developer/test.md',
  'docs/developer/troubleshooting.md',
];
const GOVERNANCE_DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
];
/** Suffixes Node's default discovery accepts but the documented glob does not. */
const UNDISCOVERED_TEST_SUFFIX = /(?:[-_]test\.[cm]?js|\.test\.[cm]?js|\.test\.cjs)$/;

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Relative link targets in Markdown (`](target)`), without URLs, mail links, and same-page anchors. */
export function localLinkTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const path = target.split('#')[0];
    if (path) targets.push(decodeURI(path));
  }
  return targets;
}

/** The text of one job in a GitHub Actions workflow (from its key to the next top-level job key). */
export function workflowJob(yaml, name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  if (start === -1) return null;
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('R00 localLinkTargets keeps relative paths and drops URLs, mail links, and anchors', () => {
  const markdown = [
    '[a](docs/README.md) [b](CHANGELOG.md#unreleased) [c](https://example.test/x) [d](mailto:x@example.test)',
    '[e](#local) [f](docs/a%20b.md "title") ![img](docs/assets/pic.png)',
  ].join('\n');
  assert.deepEqual(localLinkTargets(markdown), ['docs/README.md', 'CHANGELOG.md', 'docs/a b.md', 'docs/assets/pic.png']);
});

test('R00 workflowJob isolates one job of a workflow', () => {
  const yaml = 'jobs:\n  first:\n    steps:\n      - run: a\n  second:\n    steps:\n      - run: b\n';
  assert.match(workflowJob(yaml, 'first'), /run: a/);
  assert.doesNotMatch(workflowJob(yaml, 'first'), /run: b/);
  assert.match(workflowJob(yaml, 'second'), /run: b/);
  assert.equal(workflowJob(yaml, 'third'), null);
});

test('R00 package.json defines the single script-test invocation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:scripts'], TEST_SCRIPT);
});

test('R00 every document that names the script-test command agrees with package.json', () => {
  for (const rel of DOCS_NAMING_THE_COMMAND) {
    const text = read(rel);
    assert.ok(text.includes(TEST_GLOB), `${rel} must name the glob ${TEST_GLOB}`);
    for (const stale of SUPERSEDED_GLOBS) assert.ok(!text.includes(stale), `${rel} still carries the superseded glob ${stale}`);
  }
  const ci = read('.github/workflows/ci.yml');
  for (const stale of SUPERSEDED_GLOBS) assert.ok(!ci.includes(stale), `ci.yml still carries the superseded glob ${stale}`);
});

test('R00 the CI scripts job restores dependencies, then runs npm run test:scripts, and owns no glob of its own', () => {
  const job = workflowJob(read('.github/workflows/ci.yml'), 'scripts');
  assert.ok(job, 'ci.yml has a job named scripts');
  const restore = job.indexOf('run: npm run restore');
  const run = job.indexOf('run: npm run test:scripts');
  assert.ok(restore !== -1, 'the scripts job restores packages/explorer (tsx is needed by the fixture validators)');
  assert.ok(run !== -1 && run > restore, 'npm run test:scripts must follow the restore step');
  assert.doesNotMatch(job, /run: node --test/, 'the glob is owned by package.json, not by the workflow');
  assert.match(job, /cache-dependency-path: packages\/explorer\/package-lock\.json/, 'the npm cache follows the explorer lockfile');
});

test('S02 the CI python job runs the shared suite list and owns none of it', () => {
  // Restating the suites in the workflow drifted twice: packages/profiler/tests was missing
  // altogether (the 17 contract tests, C01/CTQ-13) and skill/scripts was pinned to
  // `-p test_renderer.py`, which silently excluded the 31 S01 security regressions. The list now
  // lives once, in scripts/project.mjs PYTHON_TEST_SUITES, reached through npm run test:python.
  const job = workflowJob(read('.github/workflows/ci.yml'), 'python');
  assert.ok(job, 'ci.yml has a job named python');
  const install = job.indexOf('packages/profiler/requirements.txt');
  const run = job.indexOf('run: npm run test:python');
  assert.ok(install !== -1, 'the python job installs packages/profiler/requirements.txt (jsonschema)');
  assert.ok(run !== -1 && run > install, 'npm run test:python must follow the dependency install');
  assert.doesNotMatch(job, /unittest discover/, 'the suite list is owned by project.mjs, not the workflow');
});

test('S02 every Python suite project.mjs runs exists and holds tests', () => {
  const project = read('scripts/project.mjs');
  const starts = [...project.matchAll(/start: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(starts, ['packages/explorer/server', 'skill/scripts', 'packages/profiler/tests',
    'fixtures', 'tools/local_admin'],
    'PYTHON_TEST_SUITES changed; update this test and the CHANGELOG together');
  for (const start of starts) {
    const dir = join(ROOT, start);
    assert.ok(existsSync(dir), `${start} exists`);
    const tests = readdirSync(dir).filter((name) => /^test_.*\.py$/.test(name));
    assert.ok(tests.length > 0, `${start} holds at least one test_*.py`);
  }
  // The renderer's security regressions live beside its contract tests, so the discovery pattern
  // has to be the default glob rather than a single file name.
  assert.ok(readdirSync(join(ROOT, 'skill/scripts')).includes('test_renderer_security.py'));
});

test('R00 every declared requirements file is audited and carried into the notices', () => {
  // Three lists have to agree, and each one silently omitting a file has already happened once:
  // the notices generator's, the pip-audit step's, and what the image installs.
  const generator = read('scripts/generate_notices.mjs');
  const declared = [...generator.matchAll(/'([^']*requirements\.txt)'/g)].map((match) => match[1]);
  const unique = [...new Set(declared)];
  assert.ok(unique.length >= 3, `expected every requirements file to be declared, saw ${unique}`);

  const audit = workflowJob(read('.github/workflows/security.yml'), 'pip-audit');
  assert.ok(audit, 'security.yml has a job named pip-audit');
  for (const file of unique) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is declared but absent`);
    assert.ok(audit.includes(file), `${file} is declared for the notices but never audited`);
  }

  // The image must install from a declaration, not repeat the list.
  const dockerfile = read('deploy/Dockerfile');
  assert.match(dockerfile, /pip install[^\n]*-r [^\n]*tools\/local_admin\/requirements\.txt/,
    'the Dockerfile should install from the requirements file it declares');
  assert.doesNotMatch(dockerfile, /pip install[^\n]*'cryptography/,
    'a version named in the Dockerfile can drift from the declared one');
});

test('R00 package.json defines the single Python-suite invocation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:python'], 'node scripts/project.mjs test:python');
});

test('R00 script tests end with .test.mjs so the documented glob discovers them', () => {
  const files = walk(join(ROOT, 'scripts')).map((path) => path.slice(ROOT.length + 1).replaceAll('\\', '/'));
  const discovered = files.filter((rel) => rel.endsWith('.test.mjs'));
  assert.ok(discovered.includes('scripts/repo_consistency.test.mjs'));
  assert.ok(discovered.length >= 6, `expected the known suites, saw ${discovered.join(', ')}`);
  const stray = files.filter((rel) => UNDISCOVERED_TEST_SUFFIX.test(rel) && !rel.endsWith('.test.mjs'));
  assert.deepEqual(stray, [], `test files that ${TEST_GLOB} would not run`);
});

test('R00 the glob recurses into subdirectories and ignores other suffixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backend-buddy-glob-'));
  try {
    const cases = {
      'scripts/alpha.test.mjs': 'alpha',
      'scripts/nested/deeper/beta.test.mjs': 'beta',
      'scripts/gamma-test.mjs': 'gamma',
      'scripts/delta_test.mjs': 'delta',
      'scripts/epsilon.test.cjs': 'epsilon',
      'other/zeta.test.mjs': 'zeta',
    };
    for (const [rel, name] of Object.entries(cases)) {
      const abs = join(dir, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `import { test } from 'node:test';\ntest('${name} ran', () => {});\n`);
    }
    // The runner marks its child processes with NODE_TEST_CONTEXT; a nested runner that inherits
    // it reports to the parent over IPC instead of stdout, so the probe must start clean.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TEST_GLOB], { cwd: dir, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['alpha', 'beta']) assert.match(result.stdout, new RegExp(`ok \\d+ - ${name} ran`), `${name} must be discovered`);
    for (const name of ['gamma', 'delta', 'epsilon', 'zeta']) assert.doesNotMatch(result.stdout, new RegExp(`${name} ran`), `${name} must not be discovered`);
    assert.match(result.stdout, /^# tests 2$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R00 root governance documents link only to existing paths', () => {
  const missing = [];
  for (const rel of GOVERNANCE_DOCS) {
    const base = dirname(join(ROOT, rel));
    for (const target of localLinkTargets(read(rel))) {
      if (!existsSync(resolve(base, target))) missing.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], 'links to files that do not exist (planned documents must be named in prose, not linked)');
});
