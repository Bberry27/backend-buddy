// Tests for scripts/check-hardcoded-colors.mjs (work package C02, feature F21, CTQ-11).
//
// Two jobs. The pure detector has to see the notations a stylesheet or a TSX attribute can hold
// without tripping over identifiers that merely read like colours, and the real repository has to
// come back clean with an allowlist that carries only the entries C02 agreed to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_PATH,
  NAMED_COLORS,
  SCAN_ROOT,
  TOKEN_LAYER,
  check,
  findLiterals,
  isExempt,
  isStylesheet,
  listFiles,
  parseAllowlist,
  stripComments,
} from './check-hardcoded-colors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/check-hardcoded-colors.mjs');
const literals = (text, stylesheet = false) => findLiterals(text, stylesheet).map(found => found.literal);

/** A throwaway tree shaped like the real one, so `check()` can be driven end to end. */
function scratchTree(files, allowText = '') {
  const root = mkdtempSync(join(tmpdir(), 'backend-buddy-colors-'));
  mkdirSync(join(root, SCAN_ROOT), { recursive: true });
  mkdirSync(join(root, dirname(ALLOW_PATH)), { recursive: true });
  writeFileSync(join(root, ALLOW_PATH), allowText, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, SCAN_ROOT, name), content, 'utf8');
  }
  return root;
}

test('C02 findLiterals sees every colour notation a view could hold', () => {
  assert.deepEqual(literals('.a { color: #fff; border-color: #a1b2c3; }'), ['#fff', '#a1b2c3']);
  assert.deepEqual(literals('.a { color: #fff8; background: #11223344; }'), ['#fff8', '#11223344']);
  assert.deepEqual(literals('.a { color: rgb(1 2 3); background: rgba(1,2,3,.5); }'), ['rgb', 'rgba']);
  assert.deepEqual(literals('.a { color: hsl(1 2% 3%); outline-color: hwb(1 2% 3%); }'), ['hsl', 'hwb']);
  assert.deepEqual(literals('<rect fill="red" stroke={\'navy\'} />'), ['red', 'navy']);
  assert.deepEqual(literals('.a { color: rebeccapurple; }'), ['rebeccapurple']);
});

test('C02 findLiterals ignores the keywords that carry no hue', () => {
  for (const value of ['transparent', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'none']) {
    assert.deepEqual(literals(`.a { background: ${value}; }`), [], value);
  }
});

test('C02 findLiterals does not mistake an identifier for a colour', () => {
  // The token names, the class names and the helper that shares a name with the CSS function.
  assert.deepEqual(literals('.a { color: var(--red); border-color: var(--orange); }'), []);
  assert.deepEqual(literals('.red-row, .schema-city-white { color: var(--ink); }'), []);
  assert.deepEqual(literals('const fill = color(cell, colors);'), []);
  assert.deepEqual(literals('const angle = Math.tan(x);'), []);
  assert.deepEqual(literals('const style = { red: 1, green: 2 };'), []);
  assert.deepEqual(literals('.a { background: color-mix(in srgb, var(--sd-added) 13%, var(--panel)); }', true), []);
});

test('C02 findLiterals counts the ambiguous CSS functions in a stylesheet only', () => {
  const css = '.a { color: lab(50 3 4); background: oklch(0.5 0.1 20); border-color: color(srgb 1 0 0); }';
  assert.deepEqual(literals(css, true), ['lab', 'oklch', 'color']);
  assert.deepEqual(literals(css, false), []);
  assert.equal(isStylesheet('packages/explorer/src/City.css'), true);
  assert.equal(isStylesheet('packages/explorer/src/City.tsx'), false);
});

test('C02 findLiterals reports the line a literal sits on', () => {
  const source = ['.a { color: var(--ink); }', '.b { color: #123456; }', '.c { fill: red; }'].join('\n');
  assert.deepEqual(findLiterals(source, true), [
    { literal: '#123456', line: 2 },
    { literal: 'red', line: 3 },
  ]);
});

test('C02 stripComments keeps prose out of the results without losing code around it', () => {
  assert.deepEqual(literals('/* was #ff0000 */ .a { color: var(--danger); }', true), []);
  assert.deepEqual(literals('// the old value was #ff0000\nconst a = 1;'), []);
  assert.deepEqual(literals('/* #ff0000 */ .a { color: #00ff00; } /* #0000ff */', true), ['#00ff00']);
  assert.equal(stripComments('a/*b*/c'), 'ac');
  assert.equal(stripComments('a\n// b\nc'), 'a\n\nc');
  // A protocol-relative or absolute URL in a string is not the start of a comment.
  assert.equal(stripComments("const u = 'https://example.test/x';"), "const u = 'https://example.test/x';");
});

test('C02 the named-colour list is the CSS list, without duplicates or the hueless keywords', () => {
  assert.equal(new Set(NAMED_COLORS).size, NAMED_COLORS.length);
  assert.ok(NAMED_COLORS.length > 140, `expected the full CSS list, found ${NAMED_COLORS.length}`);
  for (const keyword of ['transparent', 'currentcolor', 'inherit', 'none']) {
    assert.equal(NAMED_COLORS.includes(keyword), false, keyword);
  }
  assert.deepEqual([...NAMED_COLORS].sort(), [...NAMED_COLORS], 'keep the list sorted so a diff is readable');
});

test('C02 the token layer and the test files are exempt, and nothing else is', () => {
  for (const name of TOKEN_LAYER) assert.equal(isExempt(`${SCAN_ROOT}/${name}`), true, name);
  assert.equal(isExempt(`${SCAN_ROOT}/tokens.test.ts`), true);
  assert.equal(isExempt(`${SCAN_ROOT}/city-browser.test.mjs`), true);
  assert.equal(isExempt(`${SCAN_ROOT}/City.tsx`), false);
  assert.equal(isExempt(`${SCAN_ROOT}/City.css`), false);
  assert.equal(isExempt(`${SCAN_ROOT}/city-layout.ts`), false, 'it is allowlisted, not exempt');
});

test('C02 parseAllowlist reads a well-formed file and rejects a malformed one', () => {
  const entries = parseAllowlist([
    '# a comment',
    '',
    'packages/explorer/src/a.ts | #ff0000 | W05 | because the call site moves in W05',
    '  # an indented comment',
    'packages/explorer/src/b.css | * | Q03 | every literal here',
  ].join('\n'));
  assert.deepEqual(entries, [
    {
      path: 'packages/explorer/src/a.ts',
      literal: '#ff0000',
      workPackage: 'W05',
      reason: 'because the call site moves in W05',
      line: 3,
    },
    { path: 'packages/explorer/src/b.css', literal: '*', workPackage: 'Q03', reason: 'every literal here', line: 5 },
  ]);
  assert.throws(() => parseAllowlist('a | b | C02'), /expected "path \| literal \| work package \| reason"/);
  assert.throws(() => parseAllowlist('a | b | later | why'), /not a work-package id/);
  assert.throws(() => parseAllowlist('a |  | C02 | why'), /expected "path/);
});

test('C02 check fails on a literal and names the file, line and value', () => {
  const root = scratchTree({
    'Bad.css': '.a { color: var(--ink); }\n.b { color: #ff0000; }\n',
    'tokens.css': ':root { --ink: #20262b; }\n',
    'palettes.ts': "export const A = '#20262b';\n",
    'Bad.test.ts': "assert.equal(value, '#ff0000');\n",
  });
  try {
    const { violations, unusedAllowances } = check(root);
    assert.deepEqual(unusedAllowances, []);
    assert.deepEqual(violations, [{ path: `${SCAN_ROOT}/Bad.css`, line: 2, literal: '#ff0000' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C02 check honours an allowlist entry and reports it once it is no longer needed', () => {
  const allow = `${SCAN_ROOT}/Bad.css | #ff0000 | W05 | moves in W05\n`;
  const withLiteral = scratchTree({ 'Bad.css': '.b { color: #ff0000; }\n' }, allow);
  try {
    assert.deepEqual(check(withLiteral).violations, []);
    assert.deepEqual(check(withLiteral).unusedAllowances, []);
  } finally {
    rmSync(withLiteral, { recursive: true, force: true });
  }
  const tokenised = scratchTree({ 'Bad.css': '.b { color: var(--danger); }\n' }, allow);
  try {
    const { violations, unusedAllowances } = check(tokenised);
    assert.deepEqual(violations, []);
    assert.equal(unusedAllowances.length, 1);
    assert.equal(unusedAllowances[0].workPackage, 'W05');
  } finally {
    rmSync(tokenised, { recursive: true, force: true });
  }
});

test('C02 check is green on this repository', () => {
  const { violations, unusedAllowances, scanned } = check(ROOT);
  assert.deepEqual(violations, [], 'move the colour into tokens.css and palettes.ts');
  assert.deepEqual(unusedAllowances.map(entry => `${entry.path} ${entry.literal}`), []);
  assert.ok(scanned.length > 30, `expected the explorer sources, found ${scanned.length} files`);
  for (const name of TOKEN_LAYER) {
    assert.ok(scanned.includes(`${SCAN_ROOT}/${name}`), `${name} must exist and be scanned`);
  }
});

test('C02 the allowlist carries only the entries C02 agreed to', () => {
  const entries = parseAllowlist(readFileSync(join(ROOT, ALLOW_PATH), 'utf8'));
  assert.deepEqual(entries.map(entry => [entry.path, entry.literal, entry.workPackage]), [
    ['packages/explorer/src/city-layout.ts', '*', 'W05'],
  ]);
  for (const entry of entries) assert.ok(entry.reason.length > 20, `${entry.path}: give a real reason`);
});

test('C02 listFiles finds the stylesheets and modules and nothing else', () => {
  const files = listFiles(ROOT);
  assert.ok(files.every(path => /\.(?:ts|tsx|css)$/.test(path)), 'only sources are scanned');
  assert.ok(files.every(path => path.startsWith(`${SCAN_ROOT}/`)), 'the scan stays inside the explorer sources');
  assert.equal(files.includes(`${SCAN_ROOT}/tokens.css`), true);
  assert.equal(files.some(path => path.includes('node_modules')), false);
  assert.deepEqual([...files].sort(), files, 'the listing is sorted so the report order is stable');
});

test('C02 the command line exits 0 on this repository and 1 on a violation', () => {
  const green = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /No hardcoded colours outside the token layer/);

  const listing = spawnSync(process.execPath, [SCRIPT, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /tokens\.css:\d+: #[0-9a-f]{3,8} \(exempt\)/);

  const planted = join(ROOT, SCAN_ROOT, '__color-lint-probe.css');
  writeFileSync(planted, '.probe { color: #ff00ff; }\n', 'utf8');
  try {
    const red = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(red.status, 1);
    assert.match(red.stderr, /__color-lint-probe\.css:1: colour literal #ff00ff/);
  } finally {
    rmSync(planted, { force: true });
  }
});
