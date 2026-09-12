#!/usr/bin/env node
/**
 * generate_notices.mjs — third-party attribution generator (work package R00).
 *
 * Produces THIRD_PARTY_NOTICES.md from packages/explorer/package-lock.json and the packages
 * installed under packages/explorer/node_modules:
 *
 *   - every lockfile entry that is not development-only (`dev !== true`) is included, because
 *     those packages are bundled into the explorer view library and the offline artifact;
 *   - the license identifier comes from the package's package.json (`license` as an SPDX
 *     string, the legacy `{ type }` object, or the legacy `licenses` array), with an explicit
 *     override map for packages that ship a license file but declare no field;
 *   - the license text is read from LICENSE*, LICENCE*, or COPYING* files in the package
 *     directory; packages that ship none get a pointer to their repository instead;
 *   - the bundled Lucide icon geometry (skill/assets/lucide-license.txt) and the optional
 *     Python dependencies (packages/explorer/server/requirements.txt) get their own sections.
 *
 * The output is deterministic: packages are sorted by name and version, nothing depends on
 * the clock, and line endings are LF. Every bundled license must be in LICENSE_ALLOWLIST;
 * a package with no identifiable license, or one outside the allowlist, fails the run and
 * is printed by name so the decision is made by a person, not by the generator.
 *
 * Usage:
 *   node scripts/generate_notices.mjs [--root <dir>]          write THIRD_PARTY_NOTICES.md
 *   node scripts/generate_notices.mjs --check [--root <dir>]  regenerate in memory and fail on drift
 *
 * Exit codes: 0 success, 1 license policy violation or drift, 2 usage or configuration error
 * (missing lockfile, packages not installed, node_modules out of sync with the lockfile).
 * Node 22+, no dependencies.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OUTPUT_FILE = 'THIRD_PARTY_NOTICES.md';
export const LOCKFILE = 'packages/explorer/package-lock.json';
export const LUCIDE_LICENSE_FILE = 'skill/assets/lucide-license.txt';
/**
 * Every Python requirements file, in listing order. This was a single path, which is why
 * `packages/profiler`'s jsonschema pin was absent from the notices entirely.
 */
export const PYTHON_REQUIREMENTS_FILES = Object.freeze([
  'packages/explorer/server/requirements.txt',
  'packages/profiler/requirements.txt',
  'tools/local_admin/requirements.txt',
]);
export const PRODUCT_NAME = 'Backend Buddy';

/** Licenses acceptable for code that is bundled and redistributed. Compared after normalisation. */
export const LICENSE_ALLOWLIST = Object.freeze([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  '(MIT OR Apache-2.0)',
  'Zlib',
  'Python-2.0',
]);

/**
 * Packages whose package.json has no license field. Each override names the license the shipped
 * license file grants and the heading the file must start with; if the file changes, the override
 * stops matching and the run fails instead of silently attributing the wrong license.
 */
export const LICENSE_OVERRIDES = Object.freeze({
  'webgl-constants': Object.freeze({
    license: 'MIT',
    reason: 'license file, no package.json field',
    expectedHeading: /^MIT License$/,
  }),
});

/**
 * Optional Python packages the operator installs separately. They are imported at runtime and never
 * bundled, so the redistribution allowlist does not apply; they are listed for transparency. A
 * requirement that is missing from this map fails the run so a new dependency gets a conscious entry.
 */
export const PYTHON_LICENSES = Object.freeze({
  cryptography: Object.freeze({
    displayName: 'cryptography',
    license: 'Apache-2.0 OR BSD-3-Clause',
    homepage: 'https://cryptography.io',
    repository: 'https://github.com/pyca/cryptography',
    licenseUrl: 'https://github.com/pyca/cryptography/blob/main/LICENSE',
    description: [
      'cryptography provides the AES-256-GCM implementation that encrypts a stored connection',
      'password in the local admin area (`tools/local_admin/store.py`). It is a **required**',
      'dependency of the container image, not an optional extra: the admin area cannot start',
      'without it.',
      '',
      'The package is dual-licensed and the recipient may choose either: the Apache License,',
      'Version 2.0, or the 3-clause BSD License. Its own LICENSE file offers the choice, and the',
      'two texts ship in the distribution as LICENSE.APACHE and LICENSE.BSD.',
      '',
      `${PRODUCT_NAME} imports cryptography unmodified at runtime and does not vendor, patch or`,
      'statically link it. The operator installs it with pip, so it remains a separately',
      'installed, replaceable component.',
      '',
      'The wheels this project installs are binary wheels, which carry compiled code beyond the',
      'Python package itself: a statically linked OpenSSL (Apache-2.0 for the 3.x series these',
      'wheels bundle) and the compiled Rust dependencies cryptography builds against, which carry',
      'their own predominantly MIT and Apache-2.0 terms. Those components are redistributed inside',
      'the wheel by its publisher, not by this project; consult the wheel\'s own bundled licence',
      'files for their exact texts and versions, which move with each release.',
    ].join('\n'),
  }),
  jsonschema: Object.freeze({
    displayName: 'jsonschema',
    license: 'MIT',
    homepage: 'https://python-jsonschema.readthedocs.io',
    repository: 'https://github.com/python-jsonschema/jsonschema',
    licenseUrl: 'https://raw.githubusercontent.com/python-jsonschema/jsonschema/main/COPYING',
    description: [
      'jsonschema performs the structural stage of contract validation in',
      '`packages/profiler/bb_profiler/contract.py`, which imports it at module scope; the semantic',
      "stage stays in the renderer's `normalize()` (ADR-0003). Unlike psycopg it is required by that",
      'package rather than an optional extra: the contract suite cannot even import without it.',
      'It is licensed under the MIT License and is imported unmodified at runtime, never bundled,',
      'vendored, or modified. It reaches no ${PRODUCT_NAME} distribution: the offline artifact carries no',
      'Python at all, and the container image installs only psycopg and cryptography. Installing it',
      'also pulls attrs, referencing, jsonschema-specifications and rpds-py; refer to those',
      "packages' own notices for their terms.",
    ].join('\n'),
  }),
  psycopg: Object.freeze({
    displayName: 'psycopg',
    license: 'LGPL-3.0-or-later',
    homepage: 'https://www.psycopg.org',
    repository: 'https://github.com/psycopg/psycopg',
    licenseUrl: 'https://www.gnu.org/licenses/lgpl-3.0.txt',
    description: [
      'psycopg 3 is the PostgreSQL adapter used by `packages/explorer/server/schema_profiler.py`. It is',
      'licensed under the GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later); the',
      'Lesser GPL permits programs under other licenses to use the library as a separately installed,',
      'replaceable component ("Combined Works", LGPL v3 section 4), which is how it is used here.',
      `${PRODUCT_NAME} imports psycopg unmodified at runtime, only when a PostgreSQL connection is`,
      'opened, and does not bundle, vendor, statically link, or modify it. SQLite profiling and the whole',
      'test suite run without it, but the admin area the container serves does not: for that it is a',
    'required dependency. The `[binary]` extra installs the `psycopg-binary` wheel, which ships a',
      'prebuilt libpq; refer to that wheel\'s own notices for the libraries it carries.',
    ].join('\n'),
  }),
});

const STANDARD_LIBRARY_ENTRY = Object.freeze({
  displayName: 'Python standard library',
  requirement: 'Python 3.13 (provided by the operator)',
  license: 'Python-2.0',
  homepage: 'https://www.python.org',
  licenseUrl: 'https://docs.python.org/3/license.html',
  description: [
    'The offline artifact renderer (`skill/scripts/build_explorer.py`), the bounded profiler, and the',
    'loopback server (`packages/explorer/server/*.py`) use only the Python standard library, which is',
    'distributed under the PSF License Agreement (SPDX `Python-2.0` family). The interpreter is not',
    `distributed with ${PRODUCT_NAME}; operators provide Python 3.13.`,
  ].join('\n'),
});

const BUNDLED_ASSETS = Object.freeze([
  Object.freeze({
    title: 'Lucide icon geometry',
    file: LUCIDE_LICENSE_FILE,
    licenses: Object.freeze(['ISC', 'MIT']),
    description: [
      '`skill/assets/icons.json` holds icon geometry taken from Lucide (https://lucide.dev). It is',
      'inlined into the offline artifact by `skill/scripts/build_explorer.py`, so no icon font or CDN is',
      'used. Lucide is distributed under the ISC License; the icons it derives from the Feather project',
      'remain under the MIT License. The complete text of `skill/assets/lucide-license.txt` follows.',
    ].join('\n'),
  }),
]);

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([.-][\w.-]*)?$/i;
const NODE_MODULES_SEGMENT = 'node_modules/';

export class NoticesError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'NoticesError';
    this.exitCode = exitCode;
  }
}

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Order version strings numerically per dot/dash segment so 1.9.0 sorts before 1.10.0. */
export function compareVersions(a, b) {
  const left = String(a).split(/[.+-]/);
  const right = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return byCodepoint(x, y);
  }
  return 0;
}

/** Normalise an SPDX expression for allowlist comparison: trim, collapse spaces, drop outer parentheses. */
export function normalizeLicenseExpression(value) {
  let text = String(value).trim().replace(/\s+/g, ' ');
  while (/^\(.*\)$/.test(text)) text = text.slice(1, -1).trim();
  return text;
}

const NORMALISED_ALLOWLIST = new Set(LICENSE_ALLOWLIST.map(normalizeLicenseExpression));

export function isAllowedLicense(value) {
  return value != null && NORMALISED_ALLOWLIST.has(normalizeLicenseExpression(value));
}

/**
 * Read the declared license of a package.json: an SPDX string, the legacy `{ type, url }` object,
 * or the legacy `licenses` array. Returns `{ id, source }` or `{ id: null, source: null }`.
 */
export function licenseIdentifier(pkg) {
  const { license, licenses } = pkg ?? {};
  if (typeof license === 'string' && license.trim() !== '') {
    return { id: license.trim(), source: 'license' };
  }
  if (license && typeof license === 'object' && typeof license.type === 'string' && license.type.trim() !== '') {
    return { id: license.type.trim(), source: 'license.type' };
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((item) => (typeof item === 'string' ? item : item?.type))
      .filter((type) => typeof type === 'string' && type.trim() !== '')
      .map((type) => type.trim());
    if (types.length === 1) return { id: types[0], source: 'licenses' };
    if (types.length > 1) return { id: `(${types.join(' OR ')})`, source: 'licenses' };
  }
  return { id: null, source: null };
}

/**
 * Turn the many spellings npm accepts for `repository` into one browsable https URL:
 * `owner/repo`, `github:owner/repo`, `git+ssh://git@host/...`, `git@host:owner/repo.git`,
 * `git://host/...`, `git+https://...`. Returns null when nothing usable is declared.
 */
export function normalizeRepositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url = raw.trim();
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shorthand[1] ?? 'github'];
    url = `https://${host}/${shorthand[2]}`;
  }
  url = url.replace(/^git\+/, '');
  const scp = /^git@([\w.-]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^(?:git|ssh|http|https):\/\/(?:[\w.-]+@)?/, 'https://');
  return url.replace(/\.git$/, '').replace(/\/+$/, '');
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Decode as UTF-8, drop a leading byte-order mark, normalise line endings to LF, trim blank edges. */
function normalizeText(buffer) {
  let text = buffer.toString('utf8');
  if (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(BYTE_ORDER_MARK.length);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/** Read every LICENSE-, LICENCE-, or COPYING-named regular file in `dir` (sorted); `text` is null when there is none. */
export function readLicenseText(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(byCodepoint);
  if (files.length === 0) return { files, text: null };
  const parts = files.map((file) => normalizeText(readFileSync(join(dir, file))));
  const text =
    files.length === 1 ? parts[0] : files.map((file, i) => `----- ${file} -----\n\n${parts[i]}`).join('\n\n');
  return { files, text };
}

function readJson(path, description) {
  if (!existsSync(path)) throw new NoticesError(`${description} not found: ${path}`, 2);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new NoticesError(`${description} is not valid JSON: ${path} (${error.message})`, 2);
  }
}

function packageNameFromKey(key) {
  const index = key.lastIndexOf(NODE_MODULES_SEGMENT);
  return key.slice(index + NODE_MODULES_SEGMENT.length);
}

function verifyOverride(name, override, license, problems) {
  const heading = license.text?.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  if (license.text == null) {
    problems.push(`${name}: override expects a license file but the package ships none`);
    return false;
  }
  if (!override.expectedHeading.test(heading)) {
    problems.push(
      `${name}: override records ${override.license} but the shipped license file starts with "${heading}"; review LICENSE_OVERRIDES`,
    );
    return false;
  }
  return true;
}

/**
 * Walk the lockfile and the installed tree. Returns `{ packages, entryCount, skipped }` where
 * `packages` is sorted by name and version, one record per distinct name@version.
 * Throws NoticesError(1) listing every license policy problem, NoticesError(2) on configuration errors.
 */
export function collectPackages(root) {
  const lockPath = join(root, LOCKFILE);
  const lock = readJson(lockPath, 'Lockfile');
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new NoticesError(`Lockfile ${lockPath} has no "packages" map; lockfileVersion 2 or 3 is required.`, 2);
  }
  const explorerDir = dirname(lockPath);
  const records = new Map();
  const problems = [];
  const skipped = [];
  let entryCount = 0;

  for (const [key, entry] of Object.entries(lock.packages).sort(([a], [b]) => byCodepoint(a, b))) {
    if (key === '' || entry.dev === true) continue;
    if (entry.link === true || !key.includes(NODE_MODULES_SEGMENT)) {
      skipped.push(`${key} (first-party workspace link)`);
      continue;
    }
    entryCount += 1;
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : packageNameFromKey(key);
    const version = entry.version;
    const packageDir = join(explorerDir, key);
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new NoticesError(`Lockfile entry ${key} is not installed (${manifestPath} missing); run "npm run restore".`, 2);
    }
    const pkg = readJson(manifestPath, `package.json for ${key}`);
    if (typeof version !== 'string' || version === '') {
      throw new NoticesError(`Lockfile entry ${key} has no version.`, 2);
    }
    if (typeof pkg.version === 'string' && pkg.version !== version) {
      throw new NoticesError(
        `Installed ${name}@${pkg.version} at ${key} does not match the lockfile (${version}); run "npm run restore".`,
        2,
      );
    }

    const id = `${name}@${version}`;
    const existing = records.get(id);
    if (existing) {
      existing.installPaths.push(key);
      existing.installPaths.sort(byCodepoint);
      continue;
    }

    const license = readLicenseText(packageDir);
    const declared = licenseIdentifier(pkg);
    let spdx = declared.id;
    let display = declared.id;
    let source = declared.source;
    if (spdx == null) {
      const override = LICENSE_OVERRIDES[name];
      if (override && verifyOverride(id, override, license, problems)) {
        spdx = override.license;
        display = `${override.license} (${override.reason})`;
        source = 'override';
      } else if (!override) {
        problems.push(`${id}: no license field in package.json and no entry in LICENSE_OVERRIDES`);
      }
    }
    if (spdx != null && !isAllowedLicense(spdx)) {
      problems.push(`${id}: license "${spdx}" is not in the allowlist [${LICENSE_ALLOWLIST.join(', ')}]`);
    }

    records.set(id, {
      name,
      version,
      license: spdx,
      licenseDisplay: display,
      licenseSource: source,
      installPaths: [key],
      repository: normalizeRepositoryUrl(pkg.repository),
      homepage: typeof pkg.homepage === 'string' && pkg.homepage.trim() !== '' ? pkg.homepage.trim() : null,
      licenseFiles: license.files,
      licenseText: license.text,
    });
  }

  if (problems.length > 0) {
    throw new NoticesError(
      `License policy violations (${problems.length}):\n${problems.map((line) => `  - ${line}`).join('\n')}`,
      1,
    );
  }

  const packages = [...records.values()].sort(
    (a, b) => byCodepoint(a.name, b.name) || compareVersions(a.version, b.version),
  );
  return { packages, entryCount, skipped };
}

export function loadBundledAssets(root) {
  return BUNDLED_ASSETS.map((asset) => {
    const path = join(root, asset.file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new NoticesError(`Bundled asset license file not found: ${path}`, 2);
    }
    for (const license of asset.licenses) {
      if (!isAllowedLicense(license)) {
        throw new NoticesError(`Bundled asset "${asset.title}" declares license ${license}, which is not allowlisted.`, 1);
      }
    }
    return { ...asset, text: normalizeText(readFileSync(path)) };
  });
}

/** Parse a requirements.txt line into `{ name, key, requirement }`; comments and blanks yield null. */
export function parseRequirementLine(line) {
  const text = line.replace(/(^|\s)#.*$/, '').trim();
  if (text === '' || text.startsWith('-')) return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[^\]]*\])?\s*(.*)$/.exec(text);
  if (!match) throw new NoticesError(`Cannot parse requirement line: "${line}"`, 2);
  return { name: match[1], key: match[1].toLowerCase().replace(/[._]/g, '-'), requirement: text };
}

export function loadPythonDependencies(root) {
  const entries = [];
  const unknown = [];
  const pinned = new Map();
  for (const file of PYTHON_REQUIREMENTS_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const parsed = parseRequirementLine(line);
      if (!parsed) continue;
      const info = PYTHON_LICENSES[parsed.key];
      if (!info) {
        unknown.push(`${parsed.requirement}  (${file})`);
        continue;
      }
      const previous = pinned.get(parsed.key);
      if (previous) {
        // One package pinned two ways across files is a real inconsistency, and silently keeping
        // either would put a requirement in the notices that nobody actually installs.
        if (previous.requirement !== parsed.requirement) {
          throw new NoticesError(
            `"${parsed.name}" is required as "${previous.requirement}" in ${previous.file} and as ` +
              `"${parsed.requirement}" in ${file}. Reconcile them before regenerating the notices.`,
            1,
          );
        }
        continue;
      }
      pinned.set(parsed.key, { requirement: parsed.requirement, file });
      entries.push({ ...info, requirement: parsed.requirement });
    }
  }
  if (unknown.length > 0) {
    throw new NoticesError(
      `Python requirements without a PYTHON_LICENSES entry in scripts/generate_notices.mjs:\n${unknown
        .map((line) => `  - ${line}`)
        .join('\n')}`,
      1,
    );
  }
  entries.sort((a, b) => byCodepoint(a.displayName, b.displayName));
  entries.push(STANDARD_LIBRARY_ENTRY);
  return entries;
}

/** Join for prose: "a", "a and b", "a, b and c". */
function listOf(items) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function fenced(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const cell = (value) => String(value).replace(/\|/g, '\\|');

export function licenseTally(packages) {
  const counts = new Map();
  for (const pkg of packages) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  return [...counts.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((a, b) => b.count - a.count || byCodepoint(a.license, b.license));
}

function registryUrl(pkg) {
  return `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`;
}

function renderPackage(pkg) {
  const lines = [`### ${pkg.name} ${pkg.version}`, '', `- License: ${pkg.licenseDisplay}`];
  if (pkg.repository) lines.push(`- Repository: ${pkg.repository}`);
  if (pkg.homepage && pkg.homepage !== pkg.repository) lines.push(`- Homepage: ${pkg.homepage}`);
  lines.push(`- Installed at: ${pkg.installPaths.map((path) => `\`${path}\``).join(', ')}`);
  if (pkg.licenseText == null) {
    const reference = pkg.repository ?? `${registryUrl(pkg)} (no repository field in package.json)`;
    lines.push('', `License text not shipped in package; see ${reference}`);
  } else {
    lines.push(`- License file: ${pkg.licenseFiles.map((file) => `\`${file}\``).join(', ')}`, '', fenced(pkg.licenseText));
  }
  return lines.join('\n');
}

/** Render the complete Markdown document. Pure: the same report always yields the same string. */
export function renderNotices({ packages, entryCount, assets, python }) {
  const out = [];
  out.push(
    '# Third-party notices',
    '',
    `${PRODUCT_NAME} distributes the open-source components listed here and reproduces the license`,
    'text each of them ships. This file is generated by `scripts/generate_notices.mjs` from',
    '`packages/explorer/package-lock.json` and the packages installed under',
    '`packages/explorer/node_modules`. Do not edit it by hand: regenerate it with `npm run notices`, and',
    'note that CI runs `npm run notices:check` and fails when it is out of date.',
    '',
    'Scope:',
    '',
    '- Every lockfile entry that is not development-only is included, because those packages are bundled',
    '  into the explorer view library and the offline artifact. Development-only tooling (the bundler,',
    '  the type checker, the test runner, and type definitions used only at build time) is not',
    '  distributed and is not listed.',
    '- Each package appears once per name and version; "Installed at" lists every path in the dependency',
    '  tree that resolves to that copy.',
    '- Bundled code must carry one of these licenses:',
    `  ${LICENSE_ALLOWLIST.join(', ')}.`,
    '  The generator fails when a package declares anything else or nothing at all.',
    '- Python dependencies are installed by the operator and imported at runtime, never bundled; they',
    '  are listed in their own section for transparency, required and optional alike.',
    '',
    '## Summary',
    '',
    `${packages.length} packages (${entryCount} lockfile entries), ${assets.length} bundled asset${
      assets.length === 1 ? '' : 's'
    }, ${python.length} Python entries.`,
    '',
    '| License | Packages |',
    '|---|---|',
    ...licenseTally(packages).map(({ license, count }) => `| ${cell(license)} | ${count} |`),
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...packages.map((pkg) => `| \`${cell(pkg.name)}\` | ${cell(pkg.version)} | ${cell(pkg.licenseDisplay)} |`),
    '',
    '## Package license texts',
    '',
  );
  out.push(packages.map(renderPackage).join('\n\n'));
  out.push('', '## Bundled assets', '');
  out.push(
    assets
      .map((asset) =>
        [`### ${asset.title}`, '', `- License: ${asset.licenses.join(' and ')}`, `- Source file: \`${asset.file}\``, '', asset.description, '', fenced(asset.text)].join(
          '\n',
        ),
      )
      .join('\n\n'),
  );
  out.push(
    '',
    '## Python dependencies',
    '',
    'The offline artifact renderer, the bounded profiler and the loopback server run on the standard',
    'library. The contract validator `packages/profiler` additionally requires `jsonschema`. The',
    `packages below are declared in ${listOf(PYTHON_REQUIREMENTS_FILES.map((file) => '`' + file + '`'))};`,
    `operators install them separately and ${PRODUCT_NAME} imports them unmodified at runtime. Nothing`,
    `in this section is bundled, vendored, or modified *by ${PRODUCT_NAME}*, so the redistribution`,
    'allowlist above does not apply to it. A binary wheel may itself carry compiled components its',
    'own publisher redistributes, which the entry for that package describes. Each entry below says',
    'whether the package is required or optional.',
    '',
    '| Component | Requirement | License |',
    '|---|---|---|',
    ...python.map((dep) => `| ${cell(dep.displayName)} | \`${cell(dep.requirement)}\` | ${cell(dep.license)} |`),
    '',
  );
  out.push(
    python
      .map((dep) => {
        const lines = [`### ${dep.displayName}`, '', `- License: ${dep.license}`];
        if (dep.homepage) lines.push(`- Homepage: ${dep.homepage}`);
        if (dep.repository) lines.push(`- Repository: ${dep.repository}`);
        lines.push(`- License text: ${dep.licenseUrl}`, '', dep.description);
        return lines.join('\n');
      })
      .join('\n\n'),
  );
  return `${out.join('\n')}\n`;
}

/** Build the report for `root` and render it. Throws NoticesError on policy or configuration problems. */
export function generateNotices(root) {
  const { packages, entryCount, skipped } = collectPackages(root);
  const assets = loadBundledAssets(root);
  const python = loadPythonDependencies(root);
  return { content: renderNotices({ packages, entryCount, assets, python }), packages, entryCount, skipped, assets, python };
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < limit; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      return { line: i + 1, expected: expectedLines[i] ?? '<end of file>', actual: actualLines[i] ?? '<end of file>' };
    }
  }
  return null;
}

function parseArgs(argv) {
  const options = { check: false, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new NoticesError('--root requires a directory argument.', 2);
      options.root = resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new NoticesError(`unknown argument: ${arg}`, 2);
    }
  }
  return options;
}

const USAGE = [
  'Usage: node scripts/generate_notices.mjs [--check] [--root <dir>]',
  '',
  `  (default)  write ${OUTPUT_FILE} from ${LOCKFILE}`,
  `  --check    regenerate in memory and exit 1 when ${OUTPUT_FILE} differs`,
  '  --root     repository root (default: the parent of scripts/)',
].join('\n');

function summarise(result) {
  const tally = licenseTally(result.packages)
    .map(({ license, count }) => `${license} ${count}`)
    .join(', ');
  return `${result.packages.length} packages (${result.entryCount} lockfile entries); license tally: ${tally}`;
}

export function main(argv, { stdout = console.log, stderr = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`generate_notices: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout(USAGE);
    return 0;
  }
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputPath = join(root, OUTPUT_FILE);
  try {
    const result = generateNotices(root);
    for (const entry of result.skipped) stdout(`generate_notices: skipped ${entry}`);
    if (options.check) {
      if (!existsSync(outputPath)) {
        stderr(`generate_notices: ${OUTPUT_FILE} is missing; run "npm run notices" and commit the result.`);
        return 1;
      }
      const committed = readFileSync(outputPath, 'utf8');
      if (committed !== result.content) {
        const hint =
          committed.replace(/\r\n/g, '\n') === result.content
            ? ' The only difference is CRLF line endings; the file must use LF.'
            : '';
        const diff = firstDifference(result.content, committed);
        const where = diff ? ` First difference at line ${diff.line}:\n  expected: ${diff.expected}\n  actual:   ${diff.actual}` : '';
        stderr(`generate_notices: ${OUTPUT_FILE} is out of date; run "npm run notices" and commit the result.${hint}${where}`);
        return 1;
      }
      stdout(`generate_notices: ${OUTPUT_FILE} is up to date. ${summarise(result)}`);
      return 0;
    }
    writeFileSync(outputPath, result.content);
    stdout(`generate_notices: wrote ${OUTPUT_FILE}. ${summarise(result)}`);
    return 0;
  } catch (error) {
    if (error instanceof NoticesError) {
      stderr(`generate_notices: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
