#!/usr/bin/env node
/**
 * private_data_guard.mjs — repo-neutral private-data guard (work package R00, CTQ-14).
 *
 * Checks every file that git would track (or, without a .git entry, every file in the
 * tree minus dependency, build, and QA-output directories) against rules that keep
 * private or machine-local material out of the repository:
 *
 *   path:forbidden-dir               anything under reference/ or examples/ at the
 *                                    repository root, or under dist/, .qa/, outputs/
 *                                    at any depth
 *   path:image-outside-docs-assets   *.png *.jpg *.jpeg *.gif *.webp outside docs/assets/
 *   path:report-json                 any file named report.json
 *   path:coverage-data               any coverage data file (.coverage, .coverage.*);
 *                                    they are binary, so the content rules below cannot
 *                                    read the absolute machine paths they record
 *   path:oversize                    files larger than 2 MB unless listed in
 *                                    scripts/private_data_guard.allow
 *   path:windows-drive-letter        a Windows drive-letter path inside a file name
 *   content:windows-user-path        drive letter followed by the Users folder in text
 *   content:codex-path               dot-codex agent directory reference in text
 *   content:home-path                Unix home-directory path in text
 *   denylist#N                       optional local regexes from BB_DENYLIST_FILE
 *                                    (case-insensitive, checked on paths and content)
 *
 * The denylist file must live outside the repository and is never committed; the guard
 * refuses to read one from inside the scanned tree. Matches are reported with the
 * matched text masked after its first three characters, and the pattern itself is
 * never printed.
 *
 * Text content is scanned for every listed file except known binary extensions, files
 * whose first 8 KiB contain a NUL byte, and package-lock.json. Symbolic links are not
 * followed; their target string is scanned as text.
 *
 * Usage:
 *   node scripts/private_data_guard.mjs [--root <dir>] [--quiet] [--list-only]
 *
 * Exit codes: 0 clean, 1 violations found, 2 usage or configuration error.
 * Node 22+, no dependencies.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const ALLOW_FILE = 'scripts/private_data_guard.allow';
export const IMAGE_ALLOWED_PREFIX = 'docs/assets/';

const ROOT_ONLY_FORBIDDEN_DIRS = new Set(['reference', 'examples']);
const ANY_DEPTH_FORBIDDEN_DIRS = new Set(['dist', '.qa', 'outputs']);
const WALK_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.qa',
  'outputs',
  'playwright-report',
  'test-results',
  '.venv',
  '__pycache__',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const BINARY_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  '.ico', '.bmp', '.tif', '.tiff', '.psd',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.tar', '.jar', '.class',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.node', '.pyc', '.pyd',
  '.mp3', '.mp4', '.mov', '.webm', '.ogg', '.wav',
  '.sqlite', '.sqlite3', '.db', '.parquet',
]);
const CONTENT_SKIP_BASENAMES = new Set(['package-lock.json']);
const NUL_SNIFF_BYTES = 8192;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const MASK_VISIBLE = 3;
const MASK_MAX_STARS = 12;

const DRIVE_LETTER_IN_PATH = /(?:^|[\\/])[A-Za-z]:[\\/]/;
// coverage.py writes a SQLite database keyed by absolute source paths. It is binary, so
// the NUL sniff in runGuard skips its content: the only place to stop it is its name.
const COVERAGE_DATA_BASENAME = /^\.coverage(\..+)?$/;

// The content patterns are assembled from fragments so that this file (which is itself
// scanned) never matches its own rules.
export const CONTENT_RULES = Object.freeze([
  Object.freeze({
    id: 'content:windows-user-path',
    description: 'Windows user-profile path (drive letter followed by the Users folder)',
    regex: new RegExp(String.raw`[A-Za-z]:\\Us` + String.raw`ers\\`),
  }),
  Object.freeze({
    id: 'content:codex-path',
    description: 'agent-local dot-codex directory reference',
    regex: new RegExp(String.raw`\.co` + String.raw`dex\b`),
  }),
  Object.freeze({
    id: 'content:home-path',
    description: 'Unix home-directory path',
    regex: new RegExp(String.raw`\/ho` + String.raw`me\/[a-z0-9_-]+\/`, 'i'),
  }),
]);

export const PATH_RULE_IDS = Object.freeze([
  'path:forbidden-dir',
  'path:image-outside-docs-assets',
  'path:report-json',
  'path:coverage-data',
  'path:oversize',
  'path:windows-drive-letter',
]);

export const RULE_COUNT = PATH_RULE_IDS.length + CONTENT_RULES.length;

export class GuardConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardConfigError';
  }
}

export function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Masks everything after the first three characters; never reveals more than that. */
export function mask(value) {
  if (value.length <= MASK_VISIBLE) return value;
  const stars = Math.min(value.length - MASK_VISIBLE, MASK_MAX_STARS);
  return value.slice(0, MASK_VISIBLE) + '*'.repeat(stars);
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function position(text, index) {
  const before = text.slice(0, index);
  let line = 1;
  for (let i = 0; i < before.length; i += 1) if (before.charCodeAt(i) === 10) line += 1;
  const col = index - before.lastIndexOf('\n');
  return { line, col };
}

function firstMatch(regex, text) {
  const match = regex.exec(text);
  if (!match || match[0].length === 0) return null;
  return match;
}

/** Loads BB_DENYLIST_FILE. Returns [] when unset or unreadable (with a warning). */
export function loadDenylist(file, root, warnings) {
  if (!file) return [];
  let real;
  try {
    real = realpathSync(resolve(file));
  } catch {
    warnings.push('BB_DENYLIST_FILE is set but does not point to a readable file; denylist skipped');
    return [];
  }
  const rootReal = realpathSync(root);
  const rel = relative(rootReal, real);
  const inside = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  if (inside) {
    throw new GuardConfigError(
      'BB_DENYLIST_FILE must point outside the repository; refusing to read a denylist from inside the scanned tree',
    );
  }
  let text;
  try {
    text = readFileSync(real, 'utf8');
  } catch {
    warnings.push('BB_DENYLIST_FILE is set but could not be read; denylist skipped');
    return [];
  }
  const patterns = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      patterns.push({ line: i + 1, regex: new RegExp(line, 'i') });
    } catch {
      // The pattern text is private: report the line number only.
      throw new GuardConfigError(`BB_DENYLIST_FILE line ${i + 1}: invalid regular expression`);
    }
  });
  return patterns;
}

function loadAllowList(root) {
  const file = join(root, ALLOW_FILE);
  if (!existsSync(file)) return new Set();
  const entries = new Set();
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    entries.add(line.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return entries;
}

function walkTree(root) {
  const files = [];
  const visit = (dirAbs, relPosix) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (WALK_EXCLUDED_DIRS.has(entry.name)) continue;
        visit(join(dirAbs, entry.name), rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(rel);
      }
    }
  };
  visit(root, '');
  return files;
}

/** Lists candidate files: git's view when a .git entry exists, otherwise a tree walk. */
export function listFiles(root, warnings) {
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER },
    );
    if (!result.error && result.status === 0) {
      const files = [...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))].sort();
      return { files, mode: 'git' };
    }
    warnings.push('git ls-files failed; falling back to a filesystem walk');
  }
  return { files: walkTree(root), mode: 'walk' };
}

/** Path shown in reports: any denylist match inside the path is masked. */
function displayPath(rel, denylist) {
  let shown = rel;
  for (const entry of denylist) {
    const match = firstMatch(entry.regex, shown);
    if (match) shown = shown.slice(0, match.index) + mask(match[0]) + shown.slice(match.index + match[0].length);
  }
  return shown;
}

function checkPath(rel, shown, denylist) {
  const out = [];
  const dirs = rel.split('/').slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.length > 0 && ROOT_ONLY_FORBIDDEN_DIRS.has(dirs[0])) {
    out.push({ rule: 'path:forbidden-dir', path: shown, detail: `under ${dirs[0]}/ (private legacy directory, never tracked)` });
  } else {
    const hit = dirs.find((d) => ANY_DEPTH_FORBIDDEN_DIRS.has(d));
    if (hit) out.push({ rule: 'path:forbidden-dir', path: shown, detail: `under ${hit}/ (build or QA output, never tracked)` });
  }
  const ext = posix.extname(rel).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) && !rel.startsWith(IMAGE_ALLOWED_PREFIX)) {
    out.push({ rule: 'path:image-outside-docs-assets', path: shown, detail: `${ext} images are only allowed under ${IMAGE_ALLOWED_PREFIX}` });
  }
  if (posix.basename(rel) === 'report.json') {
    out.push({ rule: 'path:report-json', path: shown, detail: 'QA report files are never tracked' });
  }
  if (COVERAGE_DATA_BASENAME.test(posix.basename(rel))) {
    out.push({ rule: 'path:coverage-data', path: shown, detail: 'coverage data records absolute machine paths and is never tracked' });
  }
  if (DRIVE_LETTER_IN_PATH.test(rel)) {
    out.push({ rule: 'path:windows-drive-letter', path: shown, detail: 'file name contains a Windows drive-letter path' });
  }
  for (const entry of denylist) {
    const match = firstMatch(entry.regex, rel);
    if (match) {
      out.push({ rule: `denylist#${entry.line}`, path: shown, detail: `path matches local denylist rule ${entry.line} ("${mask(match[0])}")` });
    }
  }
  return out;
}

function scanText(text, shown, denylist, suffix = '') {
  const out = [];
  const rules = [
    ...CONTENT_RULES,
    ...denylist.map((entry) => ({
      id: `denylist#${entry.line}`,
      description: `local denylist rule ${entry.line}`,
      regex: entry.regex,
    })),
  ];
  for (const rule of rules) {
    const match = firstMatch(rule.regex, text);
    if (!match) continue;
    const { line, col } = position(text, match.index);
    out.push({
      rule: rule.id,
      path: shown,
      location: `${line}:${col}`,
      detail: `matched "${mask(match[0])}"${suffix} (${rule.description})`,
    });
  }
  return out;
}

function isBinaryByName(rel) {
  return BINARY_EXTENSIONS.has(posix.extname(rel).toLowerCase());
}

/**
 * Runs the guard. Returns { root, mode, files, textScanned, violations, warnings, denylistCount }.
 * Throws GuardConfigError for usage and configuration problems.
 */
export function runGuard(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) throw new GuardConfigError('--root must name an existing directory');

  const warnings = [];
  const denylist = loadDenylist(options.denylistFile, root, warnings);
  const { files, mode } = listFiles(root, warnings);
  const result = { root, mode, files, textScanned: 0, violations: [], warnings, denylistCount: denylist.length };
  if (options.listOnly) return result;

  const allow = loadAllowList(root);
  const usedAllow = new Set();

  for (const rel of files) {
    const shown = displayPath(rel, denylist);
    result.violations.push(...checkPath(rel, shown, denylist));

    const abs = join(root, rel);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      warnings.push(`${shown}: listed but missing on disk; skipped`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(abs, 'utf8');
      } catch {
        continue;
      }
      result.violations.push(...scanText(target, shown, denylist, ' in symlink target'));
      continue;
    }
    if (!stat.isFile()) continue;

    if (allow.has(rel)) usedAllow.add(rel);
    if (stat.size > MAX_FILE_BYTES && !allow.has(rel)) {
      result.violations.push({
        rule: 'path:oversize',
        path: shown,
        detail: `${formatBytes(stat.size)} exceeds the 2 MB limit (list the path in ${ALLOW_FILE} only with review approval)`,
      });
    }

    if (CONTENT_SKIP_BASENAMES.has(posix.basename(rel)) || isBinaryByName(rel)) continue;
    let buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      warnings.push(`${shown}: could not be read; content not scanned`);
      continue;
    }
    if (buffer.subarray(0, NUL_SNIFF_BYTES).includes(0)) continue;
    result.textScanned += 1;
    result.violations.push(...scanText(buffer.toString('utf8'), shown, denylist));
  }

  for (const entry of allow) {
    if (!usedAllow.has(entry)) warnings.push(`${ALLOW_FILE}: entry "${entry}" does not match any listed file`);
  }
  result.violations.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0,
  );
  return result;
}

function rulesLabel(result) {
  const extra = result.denylistCount
    ? ` + ${result.denylistCount} denylist pattern${result.denylistCount === 1 ? '' : 's'}`
    : '';
  return `${RULE_COUNT} rules${extra}`;
}

export function formatSummary(result) {
  return `private-data guard: OK - ${result.files.length} files listed (${result.mode}), ${result.textScanned} text files scanned, ${rulesLabel(result)}`;
}

export function formatFailure(result) {
  const paths = new Set(result.violations.map((v) => v.path));
  const count = result.violations.length;
  const lines = [
    `private-data guard: FAILED - ${count} violation${count === 1 ? '' : 's'} in ${paths.size} file${paths.size === 1 ? '' : 's'}; ${result.files.length} files listed (${result.mode}), ${result.textScanned} text files scanned, ${rulesLabel(result)}`,
    '',
  ];
  for (const v of result.violations) {
    lines.push(`  ${v.rule.padEnd(32)} ${v.path}${v.location ? `:${v.location}` : ''}`);
    lines.push(`      ${v.detail}`);
  }
  lines.push('');
  lines.push(
    `Remove or .gitignore the files above, move screenshots under ${IMAGE_ALLOWED_PREFIX}, and replace machine-local paths with repository-relative ones. Oversize files need an entry in ${ALLOW_FILE}.`,
  );
  return lines.join('\n');
}

const USAGE = `Usage: node scripts/private_data_guard.mjs [--root <dir>] [--quiet] [--list-only]

  --root <dir>   directory to scan (default: the repository containing this script)
  --quiet, -q    print nothing on success (violations and errors are still printed)
  --list-only    print the files that would be scanned, one per line, and exit 0
  --help, -h     show this help

Environment:
  BB_DENYLIST_FILE   optional local denylist (one case-insensitive regex per line,
                       # comments allowed) that must live outside the repository

Exit codes: 0 clean, 1 violations, 2 usage or configuration error.`;

export function parseArgs(argv) {
  const opts = { root: undefined, quiet: false, listOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--list-only') opts.listOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--root') {
      if (i + 1 >= argv.length) throw new GuardConfigError('--root requires a directory argument');
      opts.root = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root=')) opts.root = arg.slice('--root='.length);
    else throw new GuardConfigError(`unknown argument: ${arg}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`private-data guard: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let result;
  try {
    result = runGuard({
      root: opts.root,
      denylistFile: env.BB_DENYLIST_FILE || undefined,
      listOnly: opts.listOnly,
    });
  } catch (error) {
    if (error instanceof GuardConfigError) {
      console.error(`private-data guard: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (opts.listOnly) {
    for (const file of result.files) console.log(file);
    return 0;
  }
  if (!opts.quiet) {
    for (const warning of result.warnings) console.error(`private-data guard: warning: ${warning}`);
  }
  if (result.violations.length > 0) {
    console.error(formatFailure(result));
    return 1;
  }
  if (!opts.quiet) console.log(formatSummary(result));
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exit(main());
