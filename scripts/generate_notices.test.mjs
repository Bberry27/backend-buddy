// Tests for scripts/generate_notices.mjs (R00). Every case builds a throwaway repository tree under
// the OS temp directory with a synthetic lockfile and installed packages, so nothing depends on the
// real packages/explorer/node_modules.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LICENSE_ALLOWLIST,
  LOCKFILE,
  LUCIDE_LICENSE_FILE,
  OUTPUT_FILE,
  PYTHON_REQUIREMENTS_FILES,
  compareVersions,
  generateNotices,
  isAllowedLicense,
  licenseIdentifier,
  licenseTally,
  normalizeLicenseExpression,
  normalizeRepositoryUrl,
  parseRequirementLine,
  readLicenseText,
} from './generate_notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'generate_notices.mjs');

const BOM = String.fromCharCode(0xfeff);
const MIT_TEXT = 'MIT License\n\nCopyright (c) 2024 Example\n\nPermission is hereby granted, free of charge.\n';
const ISC_TEXT = 'ISC License\n\nCopyright (c) 2024 Example\n\nPermission to use, copy, modify.\n';

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * Create a repository tree. `packages` entries: `{ key, version, dev?, manifest?, files? }` where `key`
 * is the lockfile path (for example `node_modules/foo`), `manifest` extra package.json fields, and
 * `files` a map of file name to content written into the package directory.
 */
function makeTree({ packages, requirements = 'psycopg[binary]>=3.2,<4\n', contractRequirements = null, lucide = 'ISC License\n\nLucide text.\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'generate-notices-'));
  created.push(root);
  const explorerDir = join(root, dirname(LOCKFILE));
  mkdirSync(explorerDir, { recursive: true });
  const lockPackages = { '': { name: 'fixture-root', version: '0.0.0' } };
  for (const pkg of packages) {
    const name = pkg.name ?? pkg.key.slice(pkg.key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    lockPackages[pkg.key] = { version: pkg.version, ...(pkg.dev ? { dev: true } : {}), ...(pkg.lock ?? {}) };
    const dir = join(explorerDir, pkg.key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: pkg.version, ...(pkg.manifest ?? {}) }));
    for (const [file, content] of Object.entries(pkg.files ?? {})) writeFileSync(join(dir, file), content);
  }
  writeFileSync(join(explorerDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }));
  if (lucide != null) {
    mkdirSync(join(root, dirname(LUCIDE_LICENSE_FILE)), { recursive: true });
    writeFileSync(join(root, LUCIDE_LICENSE_FILE), lucide);
  }
  // `requirements` writes the first declared file (the profiler's optional psycopg) and
  // `contractRequirements` the second (packages/profiler), so a test can exercise either or both.
  for (const [index, content] of [requirements, contractRequirements].entries()) {
    if (content == null) continue;
    const file = PYTHON_REQUIREMENTS_FILES[index];
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function runCli(root, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined, 'generator process should start');
  return result;
}

const BASE_PACKAGES = [
  { key: 'node_modules/zeta', version: '1.0.0', manifest: { license: 'MIT', repository: 'owner/zeta' }, files: { LICENSE: MIT_TEXT } },
  {
    key: 'node_modules/alpha',
    version: '2.1.0',
    manifest: { license: { type: 'ISC', url: 'https://example.invalid/isc' }, repository: { type: 'git', url: 'git+ssh://git@github.com/owner/alpha.git' } },
    files: { 'LICENSE.md': ISC_TEXT },
  },
  {
    key: 'node_modules/no-text',
    version: '0.3.0',
    manifest: { license: 'Apache-2.0', repository: { type: 'git', url: 'git://github.com/owner/no-text.git' } },
  },
  { key: 'node_modules/no-text-no-repo', version: '4.0.0', manifest: { license: 'BSD-3-Clause', homepage: 'https://example.invalid/home' } },
  { key: 'node_modules/webgl-constants', version: '1.1.1', manifest: {}, files: { LICENSE: MIT_TEXT } },
  { key: 'node_modules/alpha/node_modules/shared', version: '3.0.0', manifest: { license: 'MIT' }, files: { LICENSE: MIT_TEXT } },
  { key: 'node_modules/shared', version: '3.0.0', manifest: { license: 'MIT' }, files: { LICENSE: MIT_TEXT } },
  { key: 'node_modules/crlf', version: '1.0.0', manifest: { license: 'MIT' }, files: { LICENSE: `${BOM}MIT License\r\n\r\nWindows text.\r\n` } },
  { key: 'node_modules/dev-only', version: '9.9.9', dev: true, manifest: { license: 'GPL-3.0-only' } },
];

test('normalizeRepositoryUrl handles the spellings npm accepts', () => {
  assert.equal(normalizeRepositoryUrl('owner/repo'), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl('gitlab:owner/repo'), 'https://gitlab.com/owner/repo');
  assert.equal(normalizeRepositoryUrl('git+ssh://git@github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl('git://github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl({ type: 'git', url: 'git+https://github.com/owner/repo.git' }), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl('https://github.com/owner/repo/'), 'https://github.com/owner/repo');
  assert.equal(normalizeRepositoryUrl(undefined), null);
  assert.equal(normalizeRepositoryUrl({ type: 'git' }), null);
  assert.equal(normalizeRepositoryUrl('   '), null);
});

test('licenseIdentifier reads SPDX strings, legacy objects, and legacy arrays', () => {
  assert.deepEqual(licenseIdentifier({ license: ' MIT ' }), { id: 'MIT', source: 'license' });
  assert.deepEqual(licenseIdentifier({ license: { type: 'ISC' } }), { id: 'ISC', source: 'license.type' });
  assert.deepEqual(licenseIdentifier({ licenses: [{ type: 'MIT' }] }), { id: 'MIT', source: 'licenses' });
  assert.deepEqual(licenseIdentifier({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), { id: '(MIT OR Apache-2.0)', source: 'licenses' });
  assert.deepEqual(licenseIdentifier({}), { id: null, source: null });
  assert.deepEqual(licenseIdentifier({ license: '' }), { id: null, source: null });
});

test('allowlist comparison normalises parentheses and whitespace', () => {
  for (const license of LICENSE_ALLOWLIST) assert.ok(isAllowedLicense(license), license);
  assert.equal(normalizeLicenseExpression(' ( MIT  OR Apache-2.0 ) '), 'MIT OR Apache-2.0');
  assert.ok(isAllowedLicense('MIT OR Apache-2.0'));
  assert.ok(!isAllowedLicense('GPL-3.0-only'));
  assert.ok(!isAllowedLicense('(MIT OR GPL-3.0-only)'));
  assert.ok(!isAllowedLicense(null));
});

test('compareVersions orders numerically per segment', () => {
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.ok(compareVersions('0.183.2', '0.170.0') > 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') !== 0);
});

test('parseRequirementLine strips comments and extras', () => {
  assert.deepEqual(parseRequirementLine('psycopg[binary]>=3.2,<4  # optional'), {
    name: 'psycopg',
    key: 'psycopg',
    requirement: 'psycopg[binary]>=3.2,<4',
  });
  assert.equal(parseRequirementLine('# comment only'), null);
  assert.equal(parseRequirementLine(''), null);
  assert.equal(parseRequirementLine('-r other.txt'), null);
  assert.equal(parseRequirementLine('Some_Package.Name==1.0').key, 'some-package-name');
});

test('readLicenseText finds LICENSE, LICENCE, COPYING variants and normalises line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'license-files-'));
  created.push(dir);
  writeFileSync(join(dir, 'COPYING.LESSER'), 'B\r\n');
  writeFileSync(join(dir, 'licence.txt'), `${BOM}\n\nA\n\n`);
  writeFileSync(join(dir, 'LICENSE-checker.js'), 'not a license');
  writeFileSync(join(dir, 'README.md'), 'nope');
  mkdirSync(join(dir, 'LICENSES'));
  const result = readLicenseText(dir);
  assert.deepEqual(result.files, ['COPYING.LESSER', 'LICENSE-checker.js', 'licence.txt']);
  assert.ok(!result.text.includes('\r'));
  assert.ok(!result.text.includes(BOM));
  assert.match(result.text, /----- COPYING\.LESSER -----\n\nB\n\n----- LICENSE-checker\.js -----/);
  assert.deepEqual(readLicenseText(join(dir, 'LICENSES')), { files: [], text: null });
});

test('generates a deterministic document covering every non-dev package', () => {
  const root = makeTree({ packages: BASE_PACKAGES });
  const first = generateNotices(root);
  const second = generateNotices(root);
  assert.equal(first.content, second.content, 'two runs must produce identical output');
  const text = first.content;

  assert.equal(first.entryCount, 8, 'eight non-dev lockfile entries');
  assert.equal(first.packages.length, 7, 'seven distinct name@version records');
  assert.deepEqual(
    first.packages.map((pkg) => pkg.name),
    ['alpha', 'crlf', 'no-text', 'no-text-no-repo', 'shared', 'webgl-constants', 'zeta'],
  );
  assert.ok(!text.includes('dev-only'), 'dev-only packages are excluded');
  assert.ok(!text.includes('GPL-3.0-only'), 'the dev-only GPL package leaves no trace');
  assert.ok(!text.includes('\r'), 'output is LF only');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no timestamps');

  assert.match(text, /^# Third-party notices\n/);
  assert.match(text, /\| `alpha` \| 2\.1\.0 \| ISC \|\n\| `crlf` \| 1\.0\.0 \| MIT \|/, 'summary table sorted by name');
  assert.match(text, /\| `webgl-constants` \| 1\.1\.1 \| MIT \(license file, no package\.json field\) \|/);
  assert.match(text, /\| MIT \| 4 \|\n\| Apache-2\.0 \| 1 \|\n\| BSD-3-Clause \| 1 \|\n\| ISC \| 1 \|/, 'tally by count then name');

  assert.match(text, /### alpha 2\.1\.0\n\n- License: ISC\n- Repository: https:\/\/github\.com\/owner\/alpha\n/);
  assert.match(text, /- License file: `LICENSE\.md`\n\n```text\nISC License\n/);
  assert.match(text, /### zeta 1\.0\.0\n\n- License: MIT\n- Repository: https:\/\/github\.com\/owner\/zeta\n/);
  assert.match(text, /### no-text 0\.3\.0\n(?:.*\n)*?\nLicense text not shipped in package; see https:\/\/github\.com\/owner\/no-text\n/);
  assert.match(
    text,
    /### no-text-no-repo 4\.0\.0\n\n- License: BSD-3-Clause\n- Homepage: https:\/\/example\.invalid\/home\n- Installed at: `node_modules\/no-text-no-repo`\n\nLicense text not shipped in package; see https:\/\/www\.npmjs\.com\/package\/no-text-no-repo\/v\/4\.0\.0 \(no repository field in package\.json\)\n/,
  );
  assert.match(text, /### shared 3\.0\.0\n(?:.*\n)*?- Installed at: `node_modules\/alpha\/node_modules\/shared`, `node_modules\/shared`\n/);
  assert.equal((text.match(/^### shared /gm) ?? []).length, 1, 'nested duplicate copies collapse into one section');
  assert.match(text, /### webgl-constants 1\.1\.1\n\n- License: MIT \(license file, no package\.json field\)\n/);
  assert.match(text, /### crlf 1\.0\.0\n(?:.*\n)*?```text\nMIT License\n\nWindows text\.\n```/);

  assert.match(text, /## Bundled assets\n\n### Lucide icon geometry\n\n- License: ISC and MIT\n- Source file: `skill\/assets\/lucide-license\.txt`\n/);
  assert.match(text, /```text\nISC License\n\nLucide text\.\n```/);
  assert.match(text, /## Python dependencies\n/);
  assert.match(text, /\| psycopg \| `psycopg\[binary\]>=3\.2,<4` \| LGPL-3\.0-or-later \|\n\| Python standard library \| `Python 3\.13 \(provided by the operator\)` \| Python-2\.0 \|/);
  assert.match(text, /### psycopg\n\n- License: LGPL-3\.0-or-later\n/);
  assert.match(text, /### Python standard library\n\n- License: Python-2\.0\n/);
});

test('license tally sorts by count then name', () => {
  const tally = licenseTally([{ license: 'ISC' }, { license: 'MIT' }, { license: 'MIT' }, { license: 'Apache-2.0' }]);
  assert.deepEqual(tally, [
    { license: 'MIT', count: 2 },
    { license: 'Apache-2.0', count: 1 },
    { license: 'ISC', count: 1 },
  ]);
});

test('a license text containing backtick fences gets a longer fence', () => {
  const root = makeTree({
    packages: [{ key: 'node_modules/fency', version: '1.0.0', manifest: { license: 'MIT' }, files: { LICENSE: 'MIT License\n\n```\ninner\n```\n' } }],
  });
  const { content } = generateNotices(root);
  assert.match(content, /````text\nMIT License\n\n```\ninner\n```\n````/);
});

test('CLI writes the file, then --check passes, detects drift, and detects a missing file', () => {
  const root = makeTree({ packages: BASE_PACKAGES });
  const outputPath = join(root, OUTPUT_FILE);

  const write = runCli(root);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /wrote THIRD_PARTY_NOTICES\.md\. 7 packages \(8 lockfile entries\); license tally: MIT 4, Apache-2\.0 1, BSD-3-Clause 1, ISC 1/);
  const written = readFileSync(outputPath, 'utf8');
  assert.equal(written, generateNotices(root).content);

  const check = runCli(root, '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /is up to date\. 7 packages/);

  writeFileSync(outputPath, written.replace('| `zeta` | 1.0.0 | MIT |', '| `zeta` | 1.0.0 | ISC |'));
  const drift = runCli(root, '--check');
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /out of date; run "npm run notices"/);
  assert.match(drift.stderr, /First difference at line \d+:/);

  writeFileSync(outputPath, written.replace(/\n/g, '\r\n'));
  const crlf = runCli(root, '--check');
  assert.equal(crlf.status, 1);
  assert.match(crlf.stderr, /only difference is CRLF line endings/);

  rmSync(outputPath);
  const missing = runCli(root, '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is missing; run "npm run notices"/);
});

test('a package with a license outside the allowlist fails and is named', () => {
  const root = makeTree({
    packages: [
      ...BASE_PACKAGES,
      { key: 'node_modules/copyleft', version: '2.0.0', manifest: { license: 'GPL-3.0-only' }, files: { LICENSE: 'GPL text' } },
    ],
  });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /License policy violations \(1\):\n  - copyleft@2\.0\.0: license "GPL-3\.0-only" is not in the allowlist/);
  assert.ok(!existsSync(join(root, OUTPUT_FILE)), 'nothing is written on failure');
});

test('a package with no license field and no override fails and is named', () => {
  const root = makeTree({
    packages: [...BASE_PACKAGES, { key: 'node_modules/mystery', version: '0.0.1', manifest: {}, files: { LICENSE: MIT_TEXT } }],
  });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /mystery@0\.0\.1: no license field in package\.json and no entry in LICENSE_OVERRIDES/);
});

test('an override whose license file no longer matches fails instead of attributing the wrong license', () => {
  const root = makeTree({
    packages: [{ key: 'node_modules/webgl-constants', version: '1.1.1', manifest: {}, files: { LICENSE: 'Apache License\nVersion 2.0\n' } }],
  });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /webgl-constants@1\.1\.1: override records MIT but the shipped license file starts with "Apache License"/);

  const noFile = makeTree({ packages: [{ key: 'node_modules/webgl-constants', version: '1.1.1', manifest: {} }] });
  const runNoFile = runCli(noFile);
  assert.equal(runNoFile.status, 1);
  assert.match(runNoFile.stderr, /webgl-constants@1\.1\.1: override expects a license file but the package ships none/);
});

test('every policy problem is reported in one run', () => {
  const root = makeTree({
    packages: [
      { key: 'node_modules/a', version: '1.0.0', manifest: { license: 'GPL-2.0-only' } },
      { key: 'node_modules/b', version: '1.0.0', manifest: {} },
    ],
  });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /License policy violations \(2\):/);
  assert.match(run.stderr, /a@1\.0\.0: license "GPL-2\.0-only"/);
  assert.match(run.stderr, /b@1\.0\.0: no license field/);
});

test('a Python requirement without a PYTHON_LICENSES entry fails', () => {
  const root = makeTree({ packages: BASE_PACKAGES, requirements: 'psycopg[binary]>=3.2,<4\nrequests>=2\n' });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Python requirements without a PYTHON_LICENSES entry[^\n]*\n  - requests>=2/);
});

test('without a requirements file only the standard library is listed', () => {
  const root = makeTree({ packages: BASE_PACKAGES, requirements: null });
  const { content, python } = generateNotices(root);
  assert.equal(python.length, 1);
  assert.match(content, /\| Python standard library \|/);
  assert.ok(!content.includes('### psycopg'));
});

test('installed tree out of sync with the lockfile is a configuration error (exit 2)', () => {
  const missing = makeTree({ packages: BASE_PACKAGES });
  rmSync(join(missing, dirname(LOCKFILE), 'node_modules', 'zeta'), { recursive: true, force: true });
  const runMissing = runCli(missing);
  assert.equal(runMissing.status, 2);
  assert.match(runMissing.stderr, /Lockfile entry node_modules\/zeta is not installed/);

  const mismatched = makeTree({ packages: BASE_PACKAGES });
  writeFileSync(
    join(mismatched, dirname(LOCKFILE), 'node_modules', 'zeta', 'package.json'),
    JSON.stringify({ name: 'zeta', version: '1.0.1', license: 'MIT' }),
  );
  const runMismatch = runCli(mismatched);
  assert.equal(runMismatch.status, 2);
  assert.match(runMismatch.stderr, /Installed zeta@1\.0\.1 at node_modules\/zeta does not match the lockfile \(1\.0\.0\)/);
});

test('missing lockfile or missing Lucide license file is a configuration error (exit 2)', () => {
  const noLock = mkdtempSync(join(tmpdir(), 'generate-notices-empty-'));
  created.push(noLock);
  const runNoLock = runCli(noLock);
  assert.equal(runNoLock.status, 2);
  assert.match(runNoLock.stderr, /Lockfile not found/);

  const noLucide = makeTree({ packages: BASE_PACKAGES, lucide: null });
  const runNoLucide = runCli(noLucide);
  assert.equal(runNoLucide.status, 2);
  assert.match(runNoLucide.stderr, /Bundled asset license file not found/);
});

test('workspace links are skipped as first-party and reported on stdout', () => {
  const root = makeTree({
    packages: [...BASE_PACKAGES, { key: 'node_modules/local-pkg', version: '1.0.0', manifest: { license: 'MIT' }, lock: { link: true, resolved: '../local' } }],
  });
  const run = runCli(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /skipped node_modules\/local-pkg \(first-party workspace link\)/);
  assert.ok(!readFileSync(join(root, OUTPUT_FILE), 'utf8').includes('local-pkg'));
});

test('unknown arguments and a bare --root exit 2 with usage; --help exits 0', () => {
  const root = makeTree({ packages: BASE_PACKAGES });
  const unknown = runCli(root, '--nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --nope/);
  assert.match(unknown.stderr, /Usage: node scripts\/generate_notices\.mjs/);

  const bareRoot = spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' });
  assert.equal(bareRoot.status, 2);
  assert.match(bareRoot.stderr, /--root requires a directory argument/);

  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);
});

test('R00 a requirement from any declared requirements file is listed', () => {
  // packages/profiler pins jsonschema, which bb_profiler.contract imports at module scope. While
  // the generator read one hardcoded path this was absent from the notices altogether.
  const root = makeTree({ packages: BASE_PACKAGES, contractRequirements: 'jsonschema==4.26.0\n' });
  const { content, python } = generateNotices(root);
  assert.deepEqual(python.map((dep) => dep.displayName), ['jsonschema', 'psycopg', 'Python standard library']);
  assert.match(content, /\| jsonschema \| `jsonschema==4\.26\.0` \| MIT \|/);
  assert.match(content, /### jsonschema\n\n- License: MIT\n/);
  // The section can no longer claim the Python code is standard library only.
  assert.ok(!content.includes('## Python dependencies (optional)'));
  for (const file of PYTHON_REQUIREMENTS_FILES) assert.ok(content.includes(file), `${file} is named`);
});

test('R00 an unknown requirement names the file it came from', () => {
  const root = makeTree({ packages: BASE_PACKAGES, contractRequirements: 'requests>=2\n' });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /- requests>=2 {2}\(packages\/profiler\/requirements\.txt\)/);
});

test('R00 the same package pinned two ways in two files is refused', () => {
  const root = makeTree({
    packages: BASE_PACKAGES,
    requirements: 'psycopg[binary]>=3.2,<4\n',
    contractRequirements: 'psycopg[binary]>=3.1,<4\n',
  });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"psycopg" is required as[\s\S]*Reconcile them/);
});

test('R00 the same package pinned identically in two files is listed once', () => {
  const root = makeTree({
    packages: BASE_PACKAGES,
    requirements: 'psycopg[binary]>=3.2,<4\n',
    contractRequirements: 'psycopg[binary]>=3.2,<4\n',
  });
  const { python } = generateNotices(root);
  assert.deepEqual(python.map((dep) => dep.displayName), ['psycopg', 'Python standard library']);
});
