#!/usr/bin/env node
/**
 * install-hooks.mjs — points git at the tracked hooks directory (.githooks).
 *
 * When the repository has a .git entry (directory, or the file git writes for
 * worktrees), sets `core.hooksPath` to `.githooks` and marks the hook files executable
 * where the filesystem supports it (a no-op on Windows). Without a .git entry it
 * prints a hint and exits 0 so it is safe to run before `git init`.
 *
 * Usage: node scripts/install-hooks.mjs [--root <dir>]
 * Exit codes: 0 done or nothing to do, 1 git configuration failed, 2 usage error.
 * Node 22+, no dependencies.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_DIR = '.githooks';

export function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function parseArgs(argv) {
  const opts = { root: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root requires a directory argument');
      opts.root = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root=')) {
      opts.root = arg.slice('--root='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Installs the hooks path. Returns { status: 'installed' | 'no-git' | 'failed', hooks, message }.
 */
export function installHooks(rootOption) {
  const root = resolve(rootOption ?? defaultRoot());
  const hooksDir = join(root, HOOKS_DIR);
  if (!existsSync(join(root, '.git'))) {
    return {
      status: 'no-git',
      hooks: [],
      message: `install-hooks: no .git entry found; run git init first, then re-run this script to set core.hooksPath=${HOOKS_DIR}`,
    };
  }
  if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) {
    return { status: 'failed', hooks: [], message: `install-hooks: ${HOOKS_DIR}/ is missing` };
  }
  const result = spawnSync('git', ['-C', root, 'config', 'core.hooksPath', HOOKS_DIR], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : (result.stderr || '').trim();
    return { status: 'failed', hooks: [], message: `install-hooks: git config core.hooksPath failed${reason ? ` (${reason})` : ''}` };
  }
  const hooks = readdirSync(hooksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const hook of hooks) {
    try {
      chmodSync(join(hooksDir, hook), 0o755);
    } catch {
      // Executable bits are not supported on every filesystem; git for Windows does not need them.
    }
  }
  return {
    status: 'installed',
    hooks,
    message: `install-hooks: core.hooksPath=${HOOKS_DIR} (hooks: ${hooks.length ? hooks.join(', ') : 'none'})`,
  };
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`install-hooks: ${error.message}\nUsage: node scripts/install-hooks.mjs [--root <dir>]`);
    return 2;
  }
  const outcome = installHooks(opts.root);
  if (outcome.status === 'failed') {
    console.error(outcome.message);
    return 1;
  }
  console.log(outcome.message);
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exit(main());
