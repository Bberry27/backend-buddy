#!/usr/bin/env node
// Fails when a colour literal appears in packages/explorer outside the token layer
// (work package C02, feature F21, CTQ-11).
//
//   node scripts/check-hardcoded-colors.mjs          report and exit 1 on any violation
//   node scripts/check-hardcoded-colors.mjs --list   print every literal it can see, with its file
//
// Why the rule exists: before C02 the nine views carried 248 colour literals, including 105
// `var(--x, #hex)` fallbacks whose hex was a dark-theme value. Mounted anywhere but the artifact
// host page the fallbacks fired, and the light theme rendered dark-on-light. The fix was to move
// every colour into `tokens.css` and `palettes.ts`; this check is what keeps it there.
//
// What counts as a literal: a hex colour, a colour function (`rgb(`, `hsl(`, `hwb(` anywhere;
// `lab(`, `lch(`, `oklab(`, `oklch(`, `color(` in a stylesheet only, since those double as
// identifiers), or one of the CSS named colours used as a value. The CSS-wide keywords that carry
// no hue (`transparent`, `currentColor`, `inherit`, `none`, ...) are not literals, and never reported.
//
// What is exempt, and why:
//   - `tokens.css` and `palettes.ts` are the token layer: literals are their content.
//   - `*.test.ts`, `*.test.tsx` and `*.test.mjs` assert on colours, so they have to name them.
//     A test is not a rendered surface, and `tokens.test.ts` is where the literals are checked.
//   - Anything listed in `scripts/check-hardcoded-colors.allow`, which records the path, the
//     literal, the work package that removes it, and the reason. An unused entry fails too, so
//     the file cannot rot.
//
// Comments are stripped before scanning: prose is free to name a colour, and the reason a value
// was chosen is often exactly the hex a reviewer needs to see.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_ROOT = 'packages/explorer/src';
export const ALLOW_PATH = 'scripts/check-hardcoded-colors.allow';
const EXTENSIONS = /\.(?:ts|tsx|css)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;
/** The token layer: these two files hold the values every other file has to ask for. */
export const TOKEN_LAYER = new Set(['tokens.css', 'palettes.ts']);
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '__pycache__']);

/**
 * Colour notations that are unambiguous wherever they appear, so they are checked in TypeScript
 * as well: nothing in this codebase calls a function by these names.
 */
const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb'];
/**
 * The rest of the CSS colour functions. `lab()`, `lch()` and `color()` are also plausible
 * identifiers -- `color(cell, colors)` is a real helper in JoinMatrix.tsx -- so they count only
 * inside a stylesheet. `color-mix()` is never a violation: it composes tokens instead of naming
 * a colour, and the trailing `-` keeps it out of the `color(` match anyway.
 */
const CSS_ONLY_FUNCTIONS = ['lab', 'lch', 'oklab', 'oklch', 'color'];
/** CSS Color 4 named colours, minus the keywords that carry no hue. */
export const NAMED_COLORS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen',
];

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNCTION_CALL = new RegExp(`(?<![-\\w])(?:${COLOR_FUNCTIONS.join('|')})\\(`, 'g');
const CSS_FUNCTION_CALL = new RegExp(`(?<![-\\w])(?:${CSS_ONLY_FUNCTIONS.join('|')})\\(`, 'g');
/**
 * A named colour used as a value: preceded by a value position (`:`, `(`, `,`, `=`, a quote or a
 * backtick, possibly with spaces) and not glued to an identifier on either side. That keeps
 * `--red`, `.red-row` and an object key such as `{ green: 2 }` out of the results while catching
 * `color: red`, `fill="red"`, `stroke={'red'}` and a gradient stop after a comma.
 */
const NAMED = new RegExp(
  `(?<=[:(,='"\`]\\s{0,4})(?<![-\\w])(?:${NAMED_COLORS.join('|')})(?![-\\w])(?!\\s*:)`, 'g');

/** Removes block and line comments so prose can name a colour without failing the check. */
export function stripComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const block = text.indexOf('/*', index);
    const line = text.indexOf('//', index);
    const next = block === -1 ? line : line === -1 ? block : Math.min(block, line);
    if (next === -1) {
      out += text.slice(index);
      break;
    }
    // A `//` inside a URL or a string is not a comment; only treat it as one at a token boundary.
    if (next === line && next > 0 && /[:"'`\\]/.test(text[next - 1])) {
      out += text.slice(index, next + 2);
      index = next + 2;
      continue;
    }
    out += text.slice(index, next);
    if (next === block) {
      const close = text.indexOf('*/', next + 2);
      index = close === -1 ? text.length : close + 2;
    } else {
      const close = text.indexOf('\n', next + 2);
      index = close === -1 ? text.length : close;
    }
  }
  return out;
}

/**
 * Every colour literal in `text`, with the 1-based line it sits on. `stylesheet` widens the set of
 * colour functions to the ones whose names would be ambiguous in TypeScript.
 */
export function findLiterals(text, stylesheet = false) {
  const source = stripComments(text);
  const functions = stylesheet ? [FUNCTION_CALL, CSS_FUNCTION_CALL] : [FUNCTION_CALL];
  const found = [];
  for (const pattern of [HEX, ...functions, NAMED]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const literal = functions.includes(pattern) ? match[0].slice(0, -1) : match[0];
      found.push({ at: match.index, literal, line: source.slice(0, match.index).split('\n').length });
    }
  }
  // Reported in source order: the patterns run separately, so their results have to be merged.
  return found.sort((first, second) => first.at - second.at).map(({ literal, line }) => ({ literal, line }));
}

/** True when the path names a stylesheet rather than a TypeScript module. */
export const isStylesheet = (relativePath) => relativePath.endsWith('.css');

/** True when the file is allowed to hold literals whatever the allowlist says. */
export function isExempt(relativePath) {
  const name = relativePath.split('/').pop();
  return TOKEN_LAYER.has(name) || TEST_FILE.test(name);
}

/**
 * Parses the allowlist: `path | literal | work package | reason` per line; a line whose first
 * non-space character is `#` is a comment. Whole-line comments only, because a trailing `#`
 * would eat the hex colour the entry is about.
 * The work package is the one that removes the entry, so an allowance always has an owner and
 * an end. A literal of `*` allows every literal in that file.
 */
export function parseAllowlist(text) {
  const entries = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map(part => part.trim());
    if (parts.length !== 4 || parts.some(part => !part)) {
      throw new Error(`${ALLOW_PATH}:${index + 1}: expected "path | literal | work package | reason"`);
    }
    const [path, literal, workPackage, reason] = parts;
    if (!/^[A-Z]\d{2}$/.test(workPackage)) {
      throw new Error(`${ALLOW_PATH}:${index + 1}: "${workPackage}" is not a work-package id`);
    }
    entries.push({ path, literal, workPackage, reason, line: index + 1 });
  });
  return entries;
}

/** Lists the files the check scans, relative to the repository root, with forward slashes. */
export function listFiles(root = ROOT, scanRoot = SCAN_ROOT) {
  const base = join(root, scanRoot);
  const out = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_FOLDERS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (EXTENSIONS.test(entry.name)) out.push(relative(root, path).split('\\').join('/'));
    }
  };
  if (!statSync(base).isDirectory()) throw new Error(`${scanRoot} is not a directory`);
  walk(base);
  return out.sort();
}

/**
 * Runs the check. Returns `{ violations, unusedAllowances, scanned }`; the caller decides what to
 * do with them. A violation is a literal in a non-exempt file that no allowlist entry covers.
 */
export function check(root = ROOT) {
  const allowlist = parseAllowlist(readFileSync(join(root, ALLOW_PATH), 'utf8'));
  const used = new Set();
  const violations = [];
  const scanned = listFiles(root);
  for (const relativePath of scanned) {
    if (isExempt(relativePath)) continue;
    const literals = findLiterals(readFileSync(join(root, relativePath), 'utf8'), isStylesheet(relativePath));
    for (const { literal, line } of literals) {
      const allowance = allowlist.find(entry => entry.path === relativePath
        && (entry.literal === '*' || entry.literal === literal));
      if (allowance) used.add(allowance.line);
      else violations.push({ path: relativePath, line, literal });
    }
  }
  const unusedAllowances = allowlist.filter(entry => !used.has(entry.line));
  return { violations, unusedAllowances, scanned };
}

function main(argv) {
  if (argv.includes('--list')) {
    for (const relativePath of listFiles()) {
      const text = readFileSync(join(ROOT, relativePath), 'utf8');
      for (const { literal, line } of findLiterals(text, isStylesheet(relativePath))) {
        console.log(`${relativePath}:${line}: ${literal}${isExempt(relativePath) ? ' (exempt)' : ''}`);
      }
    }
    return 0;
  }
  const { violations, unusedAllowances, scanned } = check();
  for (const { path, line, literal } of violations) {
    console.error(`${path}:${line}: colour literal ${literal}; use a token from tokens.css or palettes.ts`);
  }
  for (const entry of unusedAllowances) {
    console.error(`${ALLOW_PATH}:${entry.line}: allowance for ${entry.path} ${entry.literal} is unused; remove it`);
  }
  if (violations.length || unusedAllowances.length) {
    console.error(`\n${violations.length} colour literal(s) and ${unusedAllowances.length} stale allowance(s)`
      + ` across ${scanned.length} files in ${SCAN_ROOT}.`);
    return 1;
  }
  console.log(`No hardcoded colours outside the token layer (${scanned.length} files in ${SCAN_ROOT}).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
