import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const explorer = join(root, 'packages/explorer');
const npmCli = process.env.npm_execpath;
// Windows installs expose the interpreter as `python`; Debian/Ubuntu (the CI image) only ship `python3`.
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const SKIPPED_FOLDERS = new Set(['node_modules']);
const PYTHON_TEST_FILE = /^test_.*\.py$/;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function npm(script) {
  if (!npmCli) throw new Error('Run through npm run build or npm test.');
  run(process.execPath, [npmCli, 'run', script], explorer);
}
function unittest(startDir, pattern = 'test_*.py') {
  run(python, ['-m', 'unittest', 'discover', '-s', startDir, '-p', pattern]);
}

/** Remove every entry in `target` that has no counterpart of the same kind (file/directory) in `source`. */
function pruneStale(source, target) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const sourceStat = existsSync(sourcePath) ? statSync(sourcePath) : null;
    if (!sourceStat || sourceStat.isDirectory() !== entry.isDirectory()) {
      rmSync(targetPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      pruneStale(sourcePath, targetPath);
    }
  }
}

/** Mirror `source` into `target`: recursive copy, `node_modules` skipped, stale target entries removed. */
export function syncFolder(source, target) {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Cannot sync ${source}: not a directory.`);
  }
  mkdirSync(target, { recursive: true });
  pruneStale(source, target);
  cpSync(source, target, { recursive: true, filter: (path) => !SKIPPED_FOLDERS.has(basename(path)) });
}

function syncSkill() {
  const target = join(root, 'skill/assets/extensions');
  for (const folder of ['src', 'server', 'dist']) {
    syncFolder(join(explorer, folder), join(target, folder));
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'build.mjs', '.gitignore']) {
    cpSync(join(explorer, file), join(target, file));
  }
}

/**
 * True when `python -m unittest discover -s dir -p test_*.py` would collect at least one module:
 * test files at the top level, or inside sub-directories that are importable packages (`__init__.py`).
 * Python 3.12+ exits non-zero when discovery finds nothing, so the caller must skip in that case.
 */
export function hasUnittestFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && PYTHON_TEST_FILE.test(entry.name)) return true;
    if (
      entry.isDirectory() &&
      !SKIPPED_FOLDERS.has(entry.name) &&
      existsSync(join(dir, entry.name, '__init__.py')) &&
      hasUnittestFiles(join(dir, entry.name))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the SchemaGraph input for `build`: `--schema <path>` wins, then `BB_SCHEMA`, then the
 * committed synthetic medium fixture. A bare `--schema` with no value is a usage error, not a silent default.
 */
export function schemaArgument(argv, env = process.env) {
  const schemaFlag = argv.indexOf('--schema');
  if (schemaFlag === -1) return env.BB_SCHEMA || 'fixtures/schemas/medium.json';
  const value = argv[schemaFlag + 1];
  if (!value || value.startsWith('--')) throw new Error('--schema requires a path argument.');
  return value;
}

/**
 * Every Python suite, in the order they run. This list is the single definition: the CI `python`
 * job calls `npm run test:python` rather than restating it, because a restated list drifted twice
 * -- it omitted `packages/profiler/tests` entirely (the 17 contract tests, C01/CTQ-13) and pinned
 * `-p test_renderer.py` under `skill/scripts`, which excluded the 31 S01 security regressions.
 * `scripts/repo_consistency.test.mjs` holds the job to that.
 *
 * `optional` means "skip when the directory holds no test_*.py yet": Python 3.12+ exits non-zero
 * when discovery collects nothing, and an empty tree there is expected rather than a failure. The
 * two suites without the flag must always have tests, so an empty one should fail loudly.
 */
export const PYTHON_TEST_SUITES = Object.freeze([
  Object.freeze({ start: 'packages/explorer/server', label: 'profiler and loopback server' }),
  Object.freeze({ start: 'skill/scripts', label: 'renderer and its S01 security regressions' }),
  Object.freeze({ start: 'packages/profiler/tests', label: 'contract', optional: true }),
  Object.freeze({ start: 'fixtures', label: 'fixture validation', optional: true }),
  Object.freeze({ start: 'tools/local_admin', label: 'local admin area' }),
]);

function pythonSuites() {
  for (const suite of PYTHON_TEST_SUITES) {
    if (suite.optional && !hasUnittestFiles(join(root, suite.start))) {
      console.log(`${suite.start}/: no test_*.py files yet; skipping unittest discovery.`);
      continue;
    }
    unittest(suite.start);
  }
}

export function main(argv) {
  switch (argv[0]) {
    case 'build': {
      npm('build');
      syncSkill();
      const schema = schemaArgument(argv);
      run(python, ['skill/scripts/build_explorer.py', '--schema', schema, '--output', 'dist/backend-buddy.html']);
      break;
    }
    case 'test': {
      // contract.generated.ts and the reference field tables are generated, so the drift check
      // runs before the suites that consume them (C01, CTQ-13).
      run(process.execPath, ['scripts/gen_contract.mjs', '--check']);
      npm('typecheck');
      npm('test');
      pythonSuites();
      break;
    }
    case 'test:python':
      pythonSuites();
      break;
    default:
      throw new Error('Expected build, test or test:python.');
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
if (isEntryPoint()) main(process.argv.slice(2));
