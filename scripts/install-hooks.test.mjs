// Tests for scripts/install-hooks.mjs (R00). Uses throwaway directories under the OS temp
// directory; git-dependent cases are skipped when git is not on PATH.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(here, 'install-hooks.mjs');
const HAS_GIT = !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempRepo({ withHooksDir = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'install-hooks-'));
  created.push(root);
  if (withHooksDir) {
    mkdirSync(join(root, '.githooks'));
    writeFileSync(join(root, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  }
  return root;
}

function runInstaller(root, ...args) {
  const result = spawnSync(process.execPath, [INSTALLER, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined, 'installer process should start');
  return result;
}

test('without a .git entry it explains what to do and exits 0', () => {
  const run = runInstaller(tempRepo());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no \.git entry found; run git init first/);
});

test('unknown arguments exit 2', () => {
  const run = runInstaller(tempRepo(), '--nope');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument: --nope/);
});

test('with a git repository it sets core.hooksPath to .githooks', { skip: !HAS_GIT && 'git is not available' }, () => {
  const root = tempRepo();
  const init = spawnSync('git', ['-C', root, '-c', 'init.defaultBranch=main', 'init', '-q'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const run = runInstaller(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /core\.hooksPath=\.githooks \(hooks: pre-commit\)/);

  const configured = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  assert.equal(configured.stdout.trim(), '.githooks');
});

test('a repository without .githooks/ fails clearly', { skip: !HAS_GIT && 'git is not available' }, () => {
  const root = tempRepo({ withHooksDir: false });
  const init = spawnSync('git', ['-C', root, '-c', 'init.defaultBranch=main', 'init', '-q'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const run = runInstaller(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\.githooks\/ is missing/);
});
