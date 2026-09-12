#!/usr/bin/env node
/**
 * docs_lint.mjs - documentation consistency lint (CTQ-13, work package Q05).
 *
 * Node 22 ESM, no dependencies beyond the standard library and the path rules
 * exported by scripts/private_data_guard.mjs. Rule ids are the stable DL-ids
 * from docs/product-management/traceability.md section 4 so that a PR can cite
 * the rule it fixes. Rules implemented here:
 *
 *   DL-01 status header      every docs/**\/*.md starts with the status header line
 *   DL-02 feature registry   docs/features/README.md lists F01-F22; every listed
 *                            slug file exists and every F*.md has a row; the
 *                            header-table Status matches the registry status
 *   DL-03 fourteen headings  every docs/features/F*.md has the 14 "## N. <title>"
 *                            headings of _template.md in order; stubs only where
 *                            the template allows them
 *   DL-04 caveat ids         every C## token under docs/ exists in caveats.md
 *   DL-05 caveat text        every "> C##:" blockquote in a feature document equals
 *                            the canonical text in caveats.md (whitespace-normalised)
 *   DL-07 CTQ ids            every CTQ-## token under docs/ exists in ctq.md
 *   DL-08 limits             the profiler constants in limits-and-caps.md match the
 *                            values and line numbers in schema_profiler.py
 *   DL-09 ADR index          every ADR file is listed in adr/README.md and vice
 *                            versa; each ADR has an ADR status and the headings
 *                            Context, Decision, Consequences
 *   DL-11 local paths        no Windows drive path or machine-local path in docs/
 *
 * Usage: node scripts/docs_lint.mjs [--root <dir>] [--quiet]
 * Exit code 0 when clean, 1 when violations are found, 2 on a usage error.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_RULES } from './private_data_guard.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DOCS_DIR = 'docs';
export const FEATURES_DIR = 'docs/features';
export const FEATURE_REGISTRY = 'docs/features/README.md';
export const FEATURE_TEMPLATE = 'docs/features/_template.md';
export const CAVEATS_FILE = 'docs/reference/caveats.md';
export const LIMITS_FILE = 'docs/reference/limits-and-caps.md';
export const CTQ_FILE = 'docs/product-management/ctq.md';
export const ADR_DIR = 'docs/architecture/adr';
export const ADR_INDEX = 'docs/architecture/adr/README.md';
export const ADR_TEMPLATE = '0000-template.md';
export const PROFILER_FILE = 'packages/explorer/server/schema_profiler.py';

/** Feature ids the registry must list (plan: F01-F22). */
export const FEATURE_IDS = Object.freeze(
  Array.from({ length: 22 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`),
);

/** Profiler constants whose documented values must match the source. */
export const PROFILER_CONSTANTS = Object.freeze([
  'MAX_ROWS',
  'MAX_DEPTH',
  'MAX_PARAMETERS',
  'MAX_BATCH_KEYS',
  'MAX_QUERIES',
  'DEADLINE_SECONDS',
  'MAX_SCALAR_LENGTH',
  'MAX_FD_COLUMNS',
]);

/** Owner roles allowed in the status header (docs/features/README.md "owner role"). */
export const OWNER_ROLES = Object.freeze([
  'Frontend lead',
  'Backend lead',
  'Security lead',
  'Platform lead',
  'Design and accessibility lead',
  'Product owner',
]);

/** Template files keep placeholder values and are exempt from the owner-role check. */
const TEMPLATE_BASENAMES = new Set(['_template.md', ADR_TEMPLATE]);

/** Feature ids the plan allows to stub sections 8-12 until their build work package. */
const STUB_ALLOWED_FEATURES = new Set(['F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22']);
const STUB_ALLOWED_SECTIONS = new Set([8, 9, 10, 11, 12]);

const STATUS_HEADER_RE =
  /^Status: (draft|reviewed|approved) \| Owner: ([^|]+?) \| Last verified against code: ([0-9a-f]{7,40}|pre-repo \(\d{4}-\d{2}-\d{2}\))\s*$/;

/** Windows drive-letter path such as X:\ or X:/ (a scheme like https:// is excluded by the look-behind). */
const DRIVE_LETTER_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])/;

const ADR_FILE_RE = /^(?:ADR-)?(\d{4})-[a-z0-9-]+\.md$/;
const ADR_REQUIRED_HEADINGS = ['Context', 'Decision', 'Consequences'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function toPosix(p) {
  return p.split('\\').join('/');
}

function rel(root, abs) {
  return toPosix(relative(root, abs));
}

function read(abs) {
  return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}

function normalizeWs(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Recursively list *.md files under dir (sorted, posix-relative to root). */
function listMarkdown(root, dir) {
  const out = [];
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith('.md')) out.push(rel(root, p));
    }
  };
  walk(abs);
  return out;
}

/** Numbered `## N. <title>` headings of a markdown text. */
function numberedHeadings(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^## (\d+)\. (.+?)\s*$/.exec(line);
    if (m) out.push({ line: i + 1, number: Number(m[1]), title: m[2], raw: line.trim() });
  });
  return out;
}

/** All `## ` headings with line numbers. */
function h2Headings(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) out.push({ line: i + 1, title: m[1] });
  });
  return out;
}

/**
 * Collect blockquote runs beginning with `> C##:`; continuation lines of the same
 * blockquote that do not start a new `Label:` field are joined into the quote.
 * Returns [{ id, line, text }] with surrounding straight quotes removed.
 */
function caveatQuotes(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^>\s*(C\d{2}):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const parts = [m[2]];
    let j = i + 1;
    while (j < lines.length) {
      const c = /^>\s?(.*)$/.exec(lines[j]);
      if (!c) break;
      if (/^\s*[A-Za-z][A-Za-z -]*:\s/.test(c[1]) || /^\s*C\d{2}:/.test(c[1])) break;
      if (c[1].trim() === '') break;
      parts.push(c[1]);
      j++;
    }
    let quote = normalizeWs(parts.join(' '));
    const wrapped = /^"(.*)"$/.exec(quote) || /^\u201c(.*)\u201d$/.exec(quote);
    if (wrapped) quote = wrapped[1].trim();
    out.push({ id: m[1], line: i + 1, text: quote });
  }
  return out;
}

/** Canonical caveats from caveats.md: `## C## <title>` followed by its first blockquote. */
export function parseCanonicalCaveats(text) {
  const lines = text.split('\n');
  const map = new Map();
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const h = /^## (C\d{2})\b/.exec(lines[i]);
    if (h) {
      current = { id: h[1], line: i + 1, text: null };
      map.set(h[1], current);
      continue;
    }
    if (current && current.text === null && /^>\s?/.test(lines[i])) {
      const parts = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        parts.push(lines[j].replace(/^>\s?/, ''));
        j++;
      }
      current.text = normalizeWs(parts.join(' '));
      current.quoteLine = i + 1;
      i = j - 1;
    }
  }
  return map;
}

/** Registry rows from docs/features/README.md. */
export function parseFeatureRegistry(text) {
  const rows = new Map();
  text.split('\n').forEach((line, i) => {
    const m = /^\|\s*(F\d{2})\s*\|\s*([^|]*?)\s*\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|/.exec(line);
    if (m) rows.set(m[1], { id: m[1], name: m[2], slug: m[3], status: m[4], line: i + 1 });
  });
  return rows;
}

/** CTQ ids defined as table rows in ctq.md. */
export function parseCtqIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const m = /^\|\s*(CTQ-\d{2})\s*\|/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** `NAME = value` module constants of the profiler with their line numbers. */
export function parseProfilerConstants(text) {
  const map = new Map();
  const names = new Set(PROFILER_CONSTANTS);
  text.split('\n').forEach((line, i) => {
    const m = /^([A-Z_]+)\s*=\s*([0-9][0-9_]*(?:\.[0-9]+)?)\s*(?:#.*)?$/.exec(line);
    if (m && names.has(m[1])) map.set(m[1], { value: Number(m[2].replace(/_/g, '')), line: i + 1, raw: m[2] });
  });
  return map;
}

/** Rows of limits-and-caps.md whose first cell is a backticked identifier. */
function parseLimitRows(text) {
  const rows = new Map();
  text.split('\n').forEach((line, i) => {
    const m = /^\|\s*`([A-Z_]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m) rows.set(m[1], { name: m[1], valueCell: m[2].trim(), sourceCell: m[3].trim(), line: i + 1 });
  });
  return rows;
}

function firstNumber(cell) {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(cell);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * Run every rule against the tree rooted at `root`.
 * @returns {{ violations: Array<{rule:string,path:string,line?:number,message:string}>, stats: object }}
 */
export function runLint(root = defaultRoot()) {
  const violations = [];
  const stats = { docs: 0, featureDocs: 0, adrs: 0, caveatQuotes: 0, caveatRefs: 0, ctqRefs: 0, limits: 0 };
  const add = (rule, path, line, message) => violations.push({ rule, path, line, message });
  const exists = (relPath) => existsSync(join(root, relPath));
  const readRel = (relPath) => read(join(root, relPath));

  const docs = listMarkdown(root, DOCS_DIR);
  stats.docs = docs.length;
  const texts = new Map(docs.map((p) => [p, readRel(p)]));

  // --- DL-01 status header -------------------------------------------------
  for (const [path, text] of texts) {
    const first = text.split('\n')[0] ?? '';
    const m = STATUS_HEADER_RE.exec(first);
    if (!m) {
      add('DL-01', path, 1, `missing or malformed status header (got: ${JSON.stringify(first.slice(0, 80))})`);
      continue;
    }
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!TEMPLATE_BASENAMES.has(base) && !OWNER_ROLES.includes(m[2].trim())) {
      add('DL-01', path, 1, `owner "${m[2].trim()}" is not one of the roles: ${OWNER_ROLES.join(', ')}`);
    }
  }

  // --- DL-02 feature registry completeness ----------------------------------
  let registry = new Map();
  if (!exists(FEATURE_REGISTRY)) {
    add('DL-02', FEATURE_REGISTRY, undefined, 'feature registry is missing');
  } else {
    registry = parseFeatureRegistry(texts.get(FEATURE_REGISTRY));
    for (const id of FEATURE_IDS) {
      if (!registry.has(id)) add('DL-02', FEATURE_REGISTRY, undefined, `registry has no row for ${id}`);
    }
    for (const [id] of registry) {
      if (!FEATURE_IDS.includes(id)) add('DL-02', FEATURE_REGISTRY, registry.get(id).line, `unexpected feature id ${id} (registry is F01-F22)`);
    }
    for (const row of registry.values()) {
      if (!/^F\d{2}-[a-z0-9-]+\.md$/.test(row.slug)) {
        add('DL-02', FEATURE_REGISTRY, row.line, `slug "${row.slug}" does not match F##-<slug>.md`);
      } else if (!row.slug.startsWith(`${row.id}-`)) {
        add('DL-02', FEATURE_REGISTRY, row.line, `slug "${row.slug}" does not start with ${row.id}-`);
      }
      const filePath = `${FEATURES_DIR}/${row.slug}`;
      if (!exists(filePath)) add('DL-02', FEATURE_REGISTRY, row.line, `${row.id} lists ${row.slug} but ${filePath} does not exist`);
    }
  }

  const featureDocs = docs.filter((p) => /^docs\/features\/F\d{2}-[^/]+\.md$/.test(p));
  stats.featureDocs = featureDocs.length;
  const slugToRow = new Map([...registry.values()].map((r) => [r.slug, r]));
  for (const path of featureDocs) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const row = slugToRow.get(base);
    if (!row) {
      add('DL-02', path, undefined, `feature document has no row in ${FEATURE_REGISTRY}`);
      continue;
    }
    const st = /^\|\s*Status\s*\|\s*([a-z]+)\s*\|/m.exec(texts.get(path));
    if (!st) add('DL-02', path, undefined, 'header table has no "| Status | existing|partial|planned |" row');
    else if (st[1] !== row.status) add('DL-02', path, undefined, `header Status "${st[1]}" differs from registry status "${row.status}"`);
  }

  // --- DL-03 fourteen headings ---------------------------------------------
  let templateHeadings = [];
  if (!exists(FEATURE_TEMPLATE)) {
    add('DL-03', FEATURE_TEMPLATE, undefined, 'feature template is missing; cannot check headings');
  } else {
    templateHeadings = numberedHeadings(texts.get(FEATURE_TEMPLATE));
    if (templateHeadings.length !== 14) {
      add('DL-03', FEATURE_TEMPLATE, undefined, `template defines ${templateHeadings.length} numbered headings, expected 14`);
    }
  }
  if (templateHeadings.length === 14) {
    for (const path of featureDocs) {
      const text = texts.get(path);
      const all = h2Headings(text);
      const expected = templateHeadings.map((h) => h.raw);
      const actual = all.map((h) => `## ${h.title}`);
      if (actual.length !== expected.length || actual.some((h, i) => h !== expected[i])) {
        const firstDiff = expected.findIndex((h, i) => actual[i] !== h);
        const at = firstDiff === -1 ? all[expected.length] : all[firstDiff];
        add(
          'DL-03',
          path,
          at?.line,
          `expected the 14 template headings in order; ${
            firstDiff === -1
              ? `found ${actual.length} "## " headings (extra: ${JSON.stringify(actual[expected.length])})`
              : `at position ${firstDiff + 1} expected ${JSON.stringify(expected[firstDiff])}, found ${JSON.stringify(actual[firstDiff] ?? '(none)')}`
          }`,
        );
        continue;
      }
      // Section bodies: empty sections and misplaced stubs.
      const lines = text.split('\n');
      const base = path.slice(path.lastIndexOf('/') + 1);
      const row = slugToRow.get(base);
      const featureId = base.slice(0, 3);
      const stubsAllowed = row?.status === 'planned' || STUB_ALLOWED_FEATURES.has(featureId);
      for (let i = 0; i < all.length; i++) {
        const start = all[i].line; // 1-based heading line
        const end = i + 1 < all.length ? all[i + 1].line - 1 : lines.length;
        const body = lines.slice(start, end).join('\n').trim();
        const n = i + 1;
        if (body === '') {
          add('DL-03', path, start, `section ${n} is empty (use "Stubbed until <WP id>." where the template allows a stub)`);
          continue;
        }
        const stub = /^Stubbed until ([A-Z]\d{2}[A-Za-z0-9-]*)\.?$/.exec(body);
        if (stub) {
          if (!STUB_ALLOWED_SECTIONS.has(n)) add('DL-03', path, start, `section ${n} is a stub; stubs are only permitted in sections 8-12`);
          else if (!stubsAllowed) add('DL-03', path, start, `section ${n} is a stub but ${featureId} is "${row?.status}" and not in the plan's stub-allowed set (F16-F22)`);
        }
      }
    }
  }

  // --- DL-04 / DL-05 caveats -----------------------------------------------
  let canonical = new Map();
  if (!exists(CAVEATS_FILE)) {
    add('DL-04', CAVEATS_FILE, undefined, 'caveats file is missing');
  } else {
    canonical = parseCanonicalCaveats(texts.get(CAVEATS_FILE));
    for (const [id, c] of canonical) {
      if (!c.text) add('DL-05', CAVEATS_FILE, c.line, `${id} has no canonical blockquote`);
    }
    for (let i = 1; i <= 16; i++) {
      const id = `C${String(i).padStart(2, '0')}`;
      if (!canonical.has(id)) add('DL-04', CAVEATS_FILE, undefined, `canonical caveat ${id} is not defined`);
    }
  }
  for (const [path, text] of texts) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bC(\d{2})\b/g)) {
        stats.caveatRefs++;
        const id = `C${m[1]}`;
        if (!canonical.has(id)) add('DL-04', path, i + 1, `caveat id ${id} is not defined in ${CAVEATS_FILE}`);
      }
    });
  }
  for (const path of featureDocs) {
    for (const q of caveatQuotes(texts.get(path))) {
      stats.caveatQuotes++;
      const c = canonical.get(q.id);
      if (!c || !c.text) continue; // reported by DL-04
      if (q.text !== c.text) {
        add('DL-05', path, q.line, `caveat ${q.id} text differs from ${CAVEATS_FILE}:${c.quoteLine}`);
      }
    }
  }

  // --- DL-07 CTQ ids -------------------------------------------------------
  let ctqIds = new Set();
  if (!exists(CTQ_FILE)) {
    add('DL-07', CTQ_FILE, undefined, 'CTQ registry is missing');
  } else {
    ctqIds = parseCtqIds(texts.get(CTQ_FILE));
    for (let i = 1; i <= 16; i++) {
      const id = `CTQ-${String(i).padStart(2, '0')}`;
      if (!ctqIds.has(id)) add('DL-07', CTQ_FILE, undefined, `${id} has no registry row`);
    }
  }
  for (const [path, text] of texts) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bCTQ-(\d{2})\b/g)) {
        stats.ctqRefs++;
        const id = `CTQ-${m[1]}`;
        if (!ctqIds.has(id)) add('DL-07', path, i + 1, `${id} is not defined in ${CTQ_FILE}`);
      }
    });
  }

  // --- DL-08 limits match constants -----------------------------------------
  if (!exists(PROFILER_FILE)) {
    add('DL-08', PROFILER_FILE, undefined, 'profiler source is missing; cannot verify limits');
  } else if (!exists(LIMITS_FILE)) {
    add('DL-08', LIMITS_FILE, undefined, 'limits file is missing');
  } else {
    const constants = parseProfilerConstants(readRel(PROFILER_FILE));
    const rows = parseLimitRows(texts.get(LIMITS_FILE));
    for (const name of PROFILER_CONSTANTS) {
      const c = constants.get(name);
      if (!c) {
        add('DL-08', PROFILER_FILE, undefined, `constant ${name} not found as a module-level numeric assignment`);
        continue;
      }
      const row = rows.get(name);
      if (!row) {
        add('DL-08', LIMITS_FILE, undefined, `no row for \`${name}\` (source value ${c.raw} at ${PROFILER_FILE}:${c.line})`);
        continue;
      }
      stats.limits++;
      const documented = firstNumber(row.valueCell);
      if (documented === null) {
        add('DL-08', LIMITS_FILE, row.line, `\`${name}\` value cell has no number (source value ${c.raw})`);
      } else if (documented !== c.value) {
        add('DL-08', LIMITS_FILE, row.line, `\`${name}\` documented as ${documented} but ${PROFILER_FILE}:${c.line} has ${c.raw}`);
      }
      const cited = new RegExp(`schema_profiler\\.py:(\\d+)`).exec(row.sourceCell);
      if (!cited) add('DL-08', LIMITS_FILE, row.line, `\`${name}\` source cell does not cite schema_profiler.py:<line>`);
      else if (Number(cited[1]) !== c.line) add('DL-08', LIMITS_FILE, row.line, `\`${name}\` cites schema_profiler.py:${cited[1]} but the constant is defined at line ${c.line}`);
    }
  }

  // --- DL-09 ADR index -----------------------------------------------------
  const adrFiles = docs
    .filter((p) => p.startsWith(`${ADR_DIR}/`))
    .map((p) => p.slice(ADR_DIR.length + 1))
    .filter((b) => b !== ADR_TEMPLATE && ADR_FILE_RE.test(b));
  stats.adrs = adrFiles.length;
  if (!exists(`${ADR_DIR}/${ADR_TEMPLATE}`)) add('DL-09', `${ADR_DIR}/${ADR_TEMPLATE}`, undefined, 'ADR template is missing');
  if (!exists(ADR_INDEX)) {
    add('DL-09', ADR_INDEX, undefined, 'ADR index is missing');
  } else {
    const indexText = texts.get(ADR_INDEX);
    const linked = new Set();
    for (const m of indexText.matchAll(/\]\(((?:ADR-)?\d{4}-[a-z0-9-]+\.md)\)/g)) linked.add(m[1]);
    for (const b of adrFiles) {
      if (!linked.has(b)) add('DL-09', ADR_INDEX, undefined, `${ADR_DIR}/${b} is not linked from the index`);
    }
    for (const b of linked) {
      if (!adrFiles.includes(b)) add('DL-09', ADR_INDEX, undefined, `index links ${b} but ${ADR_DIR}/${b} does not exist`);
    }
    // Consecutive numbering from 0001.
    const numbers = adrFiles.map((b) => Number(ADR_FILE_RE.exec(b)[1])).sort((a, b) => a - b);
    numbers.forEach((n, i) => {
      if (n !== i + 1) add('DL-09', ADR_DIR, undefined, `ADR numbering is not consecutive: expected ${String(i + 1).padStart(4, '0')}, found ${String(n).padStart(4, '0')}`);
    });
  }
  for (const b of adrFiles) {
    const path = `${ADR_DIR}/${b}`;
    const text = texts.get(path);
    const titles = new Set(h2Headings(text).map((h) => h.title));
    for (const h of ADR_REQUIRED_HEADINGS) {
      if (!titles.has(h)) add('DL-09', path, undefined, `missing "## ${h}" heading`);
    }
    const hasStatus = /^- \*\*ADR status\*\*:\s*(proposed|accepted|superseded by ADR-\d{4}|deprecated)\s*$/m.test(text) || titles.has('Status');
    if (!hasStatus) add('DL-09', path, undefined, 'missing ADR status ("- **ADR status**: proposed|accepted|superseded by ADR-NNNN|deprecated" or a "## Status" heading)');
  }

  // --- DL-11 machine-local paths --------------------------------------------
  for (const [path, text] of texts) {
    text.split('\n').forEach((line, i) => {
      for (const rule of CONTENT_RULES) {
        if (rule.regex.test(line)) add('DL-11', path, i + 1, `${rule.description} (${rule.id})`);
      }
      if (DRIVE_LETTER_RE.test(line)) add('DL-11', path, i + 1, 'absolute Windows drive-letter path');
    });
  }

  violations.sort((a, b) =>
    a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0),
  );
  return { violations, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatReport(result) {
  const { violations, stats } = result;
  const lines = [];
  for (const v of violations) lines.push(`${v.rule} ${v.path}${v.line ? `:${v.line}` : ''} ${v.message}`);
  const checked = `${stats.docs} docs, ${stats.featureDocs} feature docs, ${stats.adrs} ADRs, ${stats.caveatQuotes} caveat quotes, ${stats.caveatRefs} caveat refs, ${stats.ctqRefs} CTQ refs, ${stats.limits} limits`;
  if (violations.length === 0) lines.push(`docs lint: OK (${checked})`);
  else {
    const rules = [...new Set(violations.map((v) => v.rule))].sort().join(', ');
    lines.push(`docs lint: FAILED - ${violations.length} violation${violations.length === 1 ? '' : 's'} (${rules}); checked ${checked}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const opts = { root: undefined, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.root !== undefined && !opts.root) throw new Error('--root requires a directory');
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`docs lint: ${err.message}`);
    console.error('usage: node scripts/docs_lint.mjs [--root <dir>] [--quiet]');
    return 2;
  }
  if (opts.help) {
    console.log('usage: node scripts/docs_lint.mjs [--root <dir>] [--quiet]');
    console.log('Rules: DL-01 status header, DL-02 feature registry, DL-03 fourteen headings, DL-04 caveat ids,');
    console.log('       DL-05 caveat text, DL-07 CTQ ids, DL-08 limits match constants, DL-09 ADR index, DL-11 local paths.');
    return 0;
  }
  const root = resolve(opts.root ?? defaultRoot());
  if (!existsSync(join(root, DOCS_DIR))) {
    console.error(`docs lint: no ${DOCS_DIR}/ directory under ${toPosix(root)}`);
    return 2;
  }
  const result = runLint(root);
  if (!opts.quiet || result.violations.length > 0) console.log(formatReport(result));
  return result.violations.length === 0 ? 0 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exit(main());
