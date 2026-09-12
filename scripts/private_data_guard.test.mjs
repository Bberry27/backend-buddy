// Tests for scripts/private_data_guard.mjs (R00, CTQ-14). Each test builds a throwaway
// tree under the OS temp directory and drives the guard through its CLI, because the
// CLI contract (exit codes, masked output) is what CI and the pre-commit hook rely on.
//
// Fixture strings that would themselves trip the guard are assembled from fragments so
// that this file stays clean when the guard scans the repository.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'private_data_guard.mjs');
const ALLOW_FILE = 'scripts/private_data_guard.allow';
const IS_WINDOWS = process.platform === 'win32';
const HAS_GIT = !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function makeTree(files) {
  return writeTree(tempDir('pdg-tree-'), files);
}

function runGuard(root, { args = [], denylist } = {}) {
  const env = { ...process.env };
  delete env.BB_DENYLIST_FILE;
  if (denylist !== undefined) env.BB_DENYLIST_FILE = denylist;
  const result = spawnSync(process.execPath, [GUARD, '--root', root, ...args], { encoding: 'utf8', env });
  assert.equal(result.error, undefined, 'guard process should start');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// Fixture builders (fragments keep this file free of literal machine-local strings).
const WINDOWS_USER_PATH = ['C:', '\\Us', 'ers\\someone\\notes.txt'].join('');
const CODEX_REFERENCE = `${['.co', 'dex'].join('')}/sessions/latest.json`;
const HOME_PATH = `${['/ho', 'me/'].join('')}alice/project/config.toml`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const ALLOW_HEADER = '# allow list\n\n';

const CLEAN_TREE = {
  'README.md': '# Project\n\nUse repository-relative paths such as docs/assets/diagram.png.\n',
  'docs/assets/diagram.png': PNG_BYTES,
  'docs/reference/caveats.md': '# Caveats\n\nNested reference directories are documentation, not private data.\n',
  'packages/app/package-lock.json': `{"resolved": "${WINDOWS_USER_PATH.replaceAll('\\', '\\\\')}"}\n`,
  'vendor/blob.dat': Buffer.concat([Buffer.from(WINDOWS_USER_PATH), Buffer.from([0x00, 0x01, 0x02])]),
  'vendor/tool.bin': Buffer.from(WINDOWS_USER_PATH),
  [ALLOW_FILE]: ALLOW_HEADER,
  'src/index.ts': 'export const answer = 42;\n',
};

test('clean tree passes with a one-line summary', () => {
  const root = makeTree(CLEAN_TREE);
  const run = runGuard(root);
  assert.equal(run.status, 0, run.output);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'summary is a single line');
  assert.match(lines[0], /^private-data guard: OK - \d+ files listed \(walk\), \d+ text files scanned, 9 rules$/);
  assert.equal(run.stderr, '', 'no warnings on a clean tree');
});

test('--quiet prints nothing on success', () => {
  const root = makeTree(CLEAN_TREE);
  const run = runGuard(root, { args: ['--quiet'] });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.output, '');
});

test('--list-only prints the candidate files sorted and exits 0 even with violations', () => {
  const root = makeTree({ 'zeta.md': 'z\n', 'alpha/one.txt': 'a\n', 'reference/private.txt': 'x\n', 'node_modules/pkg/index.js': 'ignored\n' });
  const run = runGuard(root, { args: ['--list-only'] });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.stdout.trim().split('\n'), ['alpha/one.txt', 'reference/private.txt', 'zeta.md']);
});

test('--help exits 0 and unknown flags exit 2', () => {
  const help = spawnSync(process.execPath, [GUARD, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/private_data_guard\.mjs/);
  const bad = runGuard(makeTree(CLEAN_TREE), { args: ['--bogus'] });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument: --bogus/);
});

test('files under reference/ and examples/ at the root fail', () => {
  const root = makeTree({ ...CLEAN_TREE, 'reference/adapter.py': 'print(1)\n', 'examples/demo/schema.json': '{}\n' });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /^private-data guard: FAILED - 2 violations in 2 files/m);
  assert.match(run.stderr, /path:forbidden-dir\s+reference\/adapter\.py/);
  assert.match(run.stderr, /path:forbidden-dir\s+examples\/demo\/schema\.json/);
  assert.doesNotMatch(run.stderr, /docs\/reference\/caveats\.md/, 'nested reference/ directories are allowed');
});

test('images outside docs/assets fail regardless of extension case', () => {
  const root = makeTree({ ...CLEAN_TREE, 'images/shot.png': PNG_BYTES, 'docs/Shot.PNG': PNG_BYTES, 'notes/photo.jpeg': PNG_BYTES });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /path:image-outside-docs-assets\s+images\/shot\.png/);
  assert.match(run.stderr, /path:image-outside-docs-assets\s+docs\/Shot\.PNG/);
  assert.match(run.stderr, /path:image-outside-docs-assets\s+notes\/photo\.jpeg/);
  assert.doesNotMatch(run.stderr, /docs\/assets\/diagram\.png/);
});

test('report.json fails anywhere in the tree', () => {
  const root = makeTree({ ...CLEAN_TREE, 'report.json': '{}\n', 'qa/run-1/report.json': '{}\n' });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /path:report-json\s+report\.json/);
  assert.match(run.stderr, /path:report-json\s+qa\/run-1\/report\.json/);
});

test('coverage data fails anywhere in the tree, binary though it is', () => {
  // A real .coverage is a SQLite database keyed by absolute source paths. The NUL bytes
  // here are enough to make the guard treat this as binary and skip content scanning,
  // which is the point: the machine path inside must be caught by name, not by content.
  const machinePath = 'C:' + String.raw`\Us` + String.raw`ers\someone\project\app.py`;
  const coverage = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.alloc(4, 0), Buffer.from(machinePath)]);
  const root = makeTree({ ...CLEAN_TREE, '.coverage': coverage, 'sub/.coverage.host.1234.56789': coverage });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /path:coverage-data\s+\.coverage/);
  assert.match(run.stderr, /path:coverage-data\s+sub\/\.coverage\.host\.1234\.56789/);
  assert.doesNotMatch(run.stderr, /content:windows-user-path/, 'binary content is not scanned; the name rule is what catches it');
});

test('a 3 MB file fails unless listed in the allow file', () => {
  const root = makeTree({ ...CLEAN_TREE, 'big/blob.txt': Buffer.alloc(3 * 1024 * 1024, 0x61), 'edge/exact.txt': Buffer.alloc(2 * 1024 * 1024, 0x62) });
  const blocked = runGuard(root);
  assert.equal(blocked.status, 1, blocked.output);
  assert.match(blocked.stderr, /path:oversize\s+big\/blob\.txt/);
  assert.match(blocked.stderr, /3\.00 MiB exceeds the 2 MB limit/);
  assert.doesNotMatch(blocked.stderr, /edge\/exact\.txt/, 'exactly 2 MiB is within the limit');

  writeTree(root, { [ALLOW_FILE]: `${ALLOW_HEADER}big/blob.txt\n` });
  const allowed = runGuard(root);
  assert.equal(allowed.status, 0, allowed.output);
  assert.equal(allowed.stderr, '', 'a used allow entry produces no warning');

  writeTree(root, { [ALLOW_FILE]: `${ALLOW_HEADER}big/blob.txt\nmissing/file.bin\n` });
  const stale = runGuard(root);
  assert.equal(stale.status, 0, stale.output);
  assert.match(stale.stderr, /warning: scripts\/private_data_guard\.allow: entry "missing\/file\.bin" does not match any listed file/);
});

test('a Windows user-profile path in text content fails with a masked snippet', () => {
  const root = makeTree({ ...CLEAN_TREE, 'notes/setup.md': `# Setup\nOpen ${WINDOWS_USER_PATH} to continue.\n` });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /content:windows-user-path\s+notes\/setup\.md:2:6/);
  assert.match(run.stderr, /matched "C:\\\*+"/);
  assert.doesNotMatch(run.stderr, /someone/, 'the user name never appears in the report');
  assert.ok(!run.stderr.includes(WINDOWS_USER_PATH.slice(0, 9)), 'the matched path segment is masked after three characters');
});

test('dot-codex and Unix home paths in text content fail', () => {
  const root = makeTree({ ...CLEAN_TREE, 'a/agent.md': `state lives in ${CODEX_REFERENCE}\n`, 'b/env.sh': `export CFG=${HOME_PATH}\n` });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /content:codex-path\s+a\/agent\.md:1:16/);
  assert.match(run.stderr, /content:home-path\s+b\/env\.sh:1:12/);
  assert.doesNotMatch(run.stderr, /alice/, 'the home directory owner is masked');
});

test('package-lock.json and binary files are not content-scanned', () => {
  // CLEAN_TREE carries the Windows path inside a lockfile, a NUL-bearing .dat, and a .bin.
  const run = runGuard(makeTree(CLEAN_TREE));
  assert.equal(run.status, 0, run.output);
});

test('denylist regex hits fail on content and on paths, with the match masked', () => {
  const denylistDir = tempDir('pdg-denylist-');
  const denylist = join(denylistDir, 'denylist.txt');
  writeFileSync(denylist, '# local names, never committed\n\nsecretcorp\nProj[0-9]+Name\n');
  const root = makeTree({ ...CLEAN_TREE, 'docs/a.md': 'Contact SecretCorp support for the adapter.\n', 'src/proj42name.ts': 'export {};\n' });
  const run = runGuard(root, { denylist });
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /denylist#3\s+docs\/a\.md:1:9/);
  assert.match(run.stderr, /denylist#4\s+src\/pro\*+\.ts/);
  assert.match(run.stderr, /9 rules \+ 2 denylist patterns/);
  const lower = run.output.toLowerCase();
  assert.doesNotMatch(lower, /secretcorp/, 'content match is masked');
  assert.doesNotMatch(lower, /proj42name/, 'path match is masked');
  assert.doesNotMatch(run.output, /\[0-9\]/, 'the pattern itself is never printed');
});

test('denylist absent or unreadable is fine', () => {
  const root = makeTree(CLEAN_TREE);
  const unset = runGuard(root);
  assert.equal(unset.status, 0, unset.output);
  assert.match(unset.stdout, /9 rules$/m);

  const missing = runGuard(root, { denylist: join(tempDir('pdg-missing-'), 'does-not-exist.txt') });
  assert.equal(missing.status, 0, missing.output);
  assert.match(missing.stderr, /warning: BB_DENYLIST_FILE is set but does not point to a readable file; denylist skipped/);

  const empty = runGuard(root, { denylist: '' });
  assert.equal(empty.status, 0, empty.output);
  assert.equal(empty.stderr, '');
});

test('a denylist inside the scanned tree is refused', () => {
  const root = makeTree({ ...CLEAN_TREE, 'local.denylist': 'topsecretname\n' });
  const run = runGuard(root, { denylist: join(root, 'local.denylist') });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /must point outside the repository/);
  assert.doesNotMatch(run.output, /topsecretname/);
});

test('an invalid denylist regex is a configuration error that does not echo the pattern', () => {
  const denylist = join(tempDir('pdg-denylist-'), 'denylist.txt');
  writeFileSync(denylist, '# header\nvalidname\nbroken(\n');
  const run = runGuard(makeTree(CLEAN_TREE), { denylist });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /BB_DENYLIST_FILE line 3: invalid regular expression/);
  assert.doesNotMatch(run.output, /broken\(/);
});

test('a Windows drive-letter path inside a file name fails', { skip: IS_WINDOWS && 'NTFS cannot create names containing a colon' }, () => {
  const root = makeTree({ ...CLEAN_TREE, 'stash/C:\\Backups\\dump.sql': 'select 1;\n' });
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /path:windows-drive-letter\s+stash\/C:\\Backups\\dump\.sql/);
});

test('symlink targets are scanned as text instead of being followed', { skip: IS_WINDOWS && 'symlink creation needs elevated rights on Windows' }, () => {
  const root = makeTree(CLEAN_TREE);
  symlinkSync(HOME_PATH, join(root, 'link-to-config'));
  const run = runGuard(root);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /content:home-path\s+link-to-config:1:1/);
  assert.match(run.stderr, /in symlink target/);
});

test('git mode lists what git would track: ignored files pass, force-added ones fail', { skip: !HAS_GIT && 'git is not available' }, () => {
  const root = makeTree({
    ...CLEAN_TREE,
    '.gitignore': 'reference/\ndist/\n',
    'reference/private.txt': 'private\n',
    'packages/x/dist/bundle.js': 'console.log(1);\n',
  });
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');

  const ignored = runGuard(root);
  assert.equal(ignored.status, 0, ignored.output);
  assert.match(ignored.stdout, /files listed \(git\)/);

  const listed = runGuard(root, { args: ['--list-only'] });
  assert.ok(listed.stdout.split('\n').includes('.gitignore'), 'untracked non-ignored files are listed');
  assert.ok(!listed.stdout.split('\n').includes('reference/private.txt'), 'ignored files are not listed');

  git(root, 'add', '-f', 'reference/private.txt', 'packages/x/dist/bundle.js');
  const forced = runGuard(root);
  assert.equal(forced.status, 1, forced.output);
  assert.match(forced.stderr, /path:forbidden-dir\s+reference\/private\.txt/);
  assert.match(forced.stderr, /path:forbidden-dir\s+packages\/x\/dist\/bundle\.js/);
  assert.match(forced.stderr, /under dist\/ \(build or QA output, never tracked\)/);
});
