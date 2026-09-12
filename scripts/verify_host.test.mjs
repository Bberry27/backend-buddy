// Tests for scripts/verify_host.mjs (R00 interim contract; S02 extends them with report
// parsing once the browser toolchain is pinned). The harness needs playwright and pngjs to do
// its work, so these tests cover what holds without them: the CLI surface, the absence of
// count literals tied to one schema (AGENTS.md section 3), the in-repository default output,
// and the message a clean clone gets instead of a stack trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SCRIPT = join(here, 'verify_host.mjs');
const source = readFileSync(SCRIPT, 'utf8');
const lines = source.split('\n');
/** Lines whose assertions used to carry the private example's counts (ADR-0007, RK-01). */
const DERIVED_COUNT_LINES = [249, 261, 269, 278, 292, 303, 327, 334];
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('R00 --help prints the usage string and exits 0 before any browser dependency loads', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: node verify_host\.mjs <generated\.html> \[output-directory\]/);
  for (const flag of ['--skip-diff', '--views=', '--widths=1920,1366,390', '--sample-fixture', '--local-living']) {
    assert.ok(result.stdout.includes(flag), `usage names ${flag}`);
  }
});

test('R00 no arguments exits 2 with the usage string', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^Usage: node verify_host\.mjs/);
});

test('R00 count assertions derive from the embedded snapshot instead of literals', () => {
  // Zero is structural (no changed tables, no stale rows); any other literal is tied to one schema.
  assert.doesNotMatch(source, /count\(\)\s*,\s*[1-9]\d*\)/, 'a DOM count is compared against a numeric literal');
  assert.doesNotMatch(source, /\b\d{2,}\s+(?:tables|columns|entities|unprofiled|unchanged tables|known row counts)\b/, 'a count literal in a message or pattern');
  assert.doesNotMatch(source, /report\.schema\.(?:tables|columns|knownRowCounts)\s*,\s*\d+\)/, 'report.schema compared against a literal');
  for (const number of DERIVED_COUNT_LINES) {
    assert.match(lines[number - 1], /report\.schema\.(?:tables|columns|knownRowCounts)/, `line ${number} reads its expectation from report.schema`);
  }
});

test('R00 the default output directory is the git-ignored outputs/ folder inside the repository', () => {
  assert.ok(lines[18].includes("'../outputs/schema-map-qa'"), `line 19: ${lines[18]}`);
  assert.doesNotMatch(source, /\.\.\/\.\.\/outputs/, 'no default may resolve above the repository');
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^outputs\/$/m);
});

test('R00 the QA-only Living ERD bundles resolve packages/explorer', () => {
  assert.equal((source.match(/'\.\.\/packages\/explorer\/src\/LivingERD\.tsx'/g) || []).length, 2);
  assert.doesNotMatch(source, /'src\/LivingERD\.tsx'/, 'the pre-move component path');
  assert.doesNotMatch(source, /import\('esbuild'\)/, 'esbuild must come from packages/explorer, not from scripts/');
  assert.ok(existsSync(join(ROOT, 'packages/explorer/src/LivingERD.tsx')));
});

test('R00 a missing playwright exits 2 with installation instructions instead of a stack trace', (t) => {
  const require = createRequire(SCRIPT);
  let installed = true;
  try {
    require.resolve('playwright');
  } catch {
    installed = false;
  }
  if (installed) return t.skip('playwright resolves from scripts/, so the missing-dependency path cannot be exercised here');
  const dir = mkdtempSync(join(tmpdir(), 'backend-buddy-verify-host-'));
  try {
    const input = join(dir, 'artifact.html');
    writeFileSync(input, '<!doctype html><title>placeholder</title>\n');
    const result = run([input, join(dir, 'out')]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /verify_host: cannot find "playwright"\. Install the browser toolchain/);
    assert.doesNotMatch(result.stderr, /node:internal/, 'no stack trace');
    assert.ok(!existsSync(join(dir, 'out')), 'nothing is written before the dependency check passes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
