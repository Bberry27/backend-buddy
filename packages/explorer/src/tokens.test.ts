// Tests for packages/explorer/src/tokens.css and its TypeScript mirror
// (work package C02, feature F21, CTQ-02, CTQ-04, CTQ-11).
//
// Four jobs, in the order the C02 brief lists them:
//
//   a. the sixteen host variables in tokens.css are byte-identical to the two lines of
//      skill/assets/explorer.html they were copied from, per theme, so the artifact's chrome
//      cannot drift from the token layer;
//   b. the host text pairs (--ink and --muted on --bg, --panel and --raised) reach 4.5:1;
//   c. every data and semantic colour reaches 3:1 against both surfaces of its theme, and the
//      ones a stylesheet uses as text reach 4.5:1;
//   d. no two of the twelve domain hues are closer than the recorded floor under normal vision,
//      deuteranopia, protanopia or tritanopia;
//   g. tokens.css and palettes.ts agree, in both directions.
//
// The palette behaviour tests the brief lists as (e) and (f), determinism and the stripe variant
// on the 14-domain fixture, live in palettes.test.ts next to the function they exercise.
//
// The numbers below are measurements, not preferences. When a palette value changes, run this
// file: it reports which pair broke the floor and by how much.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMN_FAMILIES } from './column-logic';
import {
  DOMAIN_COLORS,
  DOMAIN_HUE_COUNT,
  HOST_COLORS,
  HOST_VARIABLES,
  MATRIX_COLORS,
  THEMES,
  cssVariables,
  type Theme,
} from './palettes';
import { VISION_CONDITIONS, contrastRatio, minimumDeltaE, parseHex, underVision, toLab, deltaE } from './color-math';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const TOKENS_CSS = join(HERE, 'tokens.css');
const HOST_HTML = join(ROOT, 'skill/assets/explorer.html');
/** The two lines of the host page that declare the sixteen variables, one per theme. */
const HOST_SELECTORS: Record<Theme, string> = { light: ':root{', dark: ':root[data-theme=dark]{' };
const TOKENS_SELECTORS: Record<Theme, string> = { light: ':root {', dark: ':root[data-theme=dark] {' };

/**
 * The lowest CIEDE2000 difference any two domain hues may have, under any of the four vision
 * conditions. The measured worst case is 11.34 (light, tritanopia) and 12.18 (dark,
 * deuteranopia); the floor sits just under both so that a palette edit which loses ground fails
 * here rather than shipping. Raising it means re-running the palette search, not relaxing the
 * contrast rule the search works inside.
 */
const DOMAIN_SEPARATION_FLOOR = 11;
/** WCAG 2.1 minimums: 4.5:1 for text under 24 px, 3:1 for a graphical object or a UI boundary. */
const TEXT_CONTRAST = 4.5;
const DATA_CONTRAST = 3;

/**
 * Tokens a view stylesheet uses as a text colour, so they owe 4.5:1 rather than 3:1:
 * `--sd-removed` in `.sd-risk` (`SchemaDiff.css:69`), `--arc-cycle` in `.schema-arc-cycle-count`
 * and `.schema-arc-self` (`ArcDiagram.css:6`, `:21`), and the semantic inks a view may set on a
 * surface as a word. `--warning` is measured with them and its shortfall is recorded below.
 */
const TEXT_TOKENS = ['--sd-removed', '--arc-cycle', '--danger', '--success', '--warning'] as const;
/**
 * Tokens that are not read as a colour against a surface, with the reason each is excluded.
 * Every other token in `cssVariables()` owes at least 3:1 on both surfaces of its theme.
 */
const NOT_MEASURED_AGAINST_SURFACES: Record<string, string> = {
  '--bg': 'is the surface',
  '--panel': 'is the surface',
  '--raised': 'is a surface',
  '--soft': 'is a selected-row surface, measured through the text drawn on it',
  '--selection-soft': 'is a selection surface, measured through the text drawn on it',
  '--line': 'is a hairline separator, exempt from 1.4.11 as a decorative boundary',
  '--grid': 'is the stage grid, deliberately at the edge of visibility',
  '--elevation-1': 'is shadow ink, not a colour a reader resolves',
  '--elevation-2': 'is shadow ink, not a colour a reader resolves',
  '--elevation-3': 'is shadow ink, not a colour a reader resolves',
  '--city-light-sky': 'is a light source multiplied into a material, not a surface',
  '--city-light-ground': 'is a light source multiplied into a material, not a surface',
  '--matrix-count-ink': 'is measured against the matrix cell fills it is drawn on, below',
};
/**
 * Pairs that fall short of the ratio their use asks for, with the owner of the decision.
 * `--warning` is the host `--orange`, a frozen value: raising it needs an ADR, so C02 records the
 * number instead of changing it, and no view uses `--warning` as text today. A pair that leaves
 * this list must be removed from it, and a new shortfall fails the test rather than being added
 * without an owner.
 */
const RECORDED_TEXT_CONTRAST_FINDINGS: Record<string, number> = {
  'light --warning on --bg': 4.21,
};
/**
 * Data-contrast shortfalls that come from a frozen host value, with the owner of the decision.
 * `--edge` is the relationship stroke on the host relational map, drawn at 0.48 opacity on top of
 * this ratio, so what a reader sees is lower still. Changing `--edge` needs an ADR, so C02 records
 * the measurement and leaves the value alone. A new entry needs an owner; a fixed one comes out.
 */
const RECORDED_DATA_CONTRAST_FINDINGS: Record<string, number> = {
  'light --edge on --bg': 2.29,
  'light --edge on --panel': 2.48,
};

/** Strips CSS comments so a declaration parser cannot see values inside prose. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of one brace-delimited block starting at `selector`, as name to value. */
function declarations(css: string, selector: string): Record<string, string> {
  const start = withoutComments(css).indexOf(selector);
  assert.notEqual(start, -1, `selector ${selector} not found`);
  const body = withoutComments(css).slice(start + selector.length);
  const end = body.indexOf('}');
  assert.notEqual(end, -1, `unterminated block for ${selector}`);
  const found: Record<string, string> = {};
  for (const piece of body.slice(0, end).split(';')) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    const name = piece.slice(0, colon).trim();
    if (!name) continue;
    assert.ok(!(name in found), `${selector} declares ${name} twice`);
    found[name] = piece.slice(colon + 1).trim();
  }
  return found;
}

const tokensCss = readFileSync(TOKENS_CSS, 'utf8');
const hostHtml = readFileSync(HOST_HTML, 'utf8');

/** Only the sixteen host variables of a block, dropping `color-scheme` and the new tokens. */
function hostSubset(block: Record<string, string>): Record<string, string> {
  const subset: Record<string, string> = {};
  for (const name of HOST_VARIABLES) {
    const key = `--${name}`;
    assert.ok(key in block, `block is missing ${key}`);
    subset[key] = block[key];
  }
  return subset;
}

test('CTQ-11 tokens: host variables byte-identical to the artifact host page', () => {
  for (const theme of THEMES) {
    const host = declarations(hostHtml, HOST_SELECTORS[theme]);
    const tokens = declarations(tokensCss, TOKENS_SELECTORS[theme]);
    assert.equal(Object.keys(hostSubset(host)).length, 16);
    assert.deepEqual(hostSubset(tokens), hostSubset(host),
      `${theme}: tokens.css and skill/assets/explorer.html disagree on a frozen host variable`);
    assert.equal(host['color-scheme'], theme);
    assert.equal(tokens['color-scheme'], theme);
    // The host page declares exactly the sixteen and nothing else on those two lines.
    assert.deepEqual(Object.keys(host).sort(), ['color-scheme', ...HOST_VARIABLES.map(n => `--${n}`)].sort());
  }
});

test('CTQ-11 tokens: palettes.ts and tokens.css declare the same values in both directions', () => {
  for (const theme of THEMES) {
    const tokens = declarations(tokensCss, TOKENS_SELECTORS[theme]);
    const { 'color-scheme': scheme, ...declared } = tokens;
    assert.equal(scheme, theme);
    assert.deepEqual(declared, cssVariables(theme),
      `${theme}: edit palettes.ts and tokens.css in the same change`);
  }
});

test('CTQ-11 tokens: the host variables in palettes.ts are the host page values', () => {
  for (const theme of THEMES) {
    const host = declarations(hostHtml, HOST_SELECTORS[theme]);
    for (const name of HOST_VARIABLES) {
      assert.equal(HOST_COLORS[theme][name], host[`--${name}`], `${theme} --${name}`);
    }
  }
});

test('CTQ-05 tokens: the stylesheet stays inside what the artifact CSP allows', () => {
  // Measured on the stylesheet without its comments, which are free to name the rules in prose.
  const body = withoutComments(tokensCss);
  assert.equal(body.includes('url('), false, 'no url() may appear: the CSP blocks the fetch');
  assert.equal(body.includes('@import'), false, 'no @import: the CSP blocks the fetch');
  assert.equal(/@font-face/.test(body), false, 'no font may be declared here');
  // Custom properties and color-scheme only, so bundle order against the view stylesheets
  // cannot change how anything renders.
  const selectors = [...body.matchAll(/([^{}]+)\{/g)].map(match => match[1].trim());
  assert.deepEqual(selectors, [':root', ':root[data-theme=dark]']);
  for (const theme of THEMES) {
    for (const name of Object.keys(declarations(tokensCss, TOKENS_SELECTORS[theme]))) {
      assert.ok(name === 'color-scheme' || name.startsWith('--'), `${name} styles an element`);
    }
  }
});

test('CTQ-11 tokens: host text pairs reach 4.5:1 in both themes', () => {
  const shortfalls: string[] = [];
  for (const theme of THEMES) {
    for (const ink of ['ink', 'muted'] as const) {
      for (const surface of ['bg', 'panel', 'raised'] as const) {
        const ratio = contrastRatio(parseHex(HOST_COLORS[theme][ink]), parseHex(HOST_COLORS[theme][surface]));
        if (ratio < TEXT_CONTRAST) shortfalls.push(`${theme} --${ink} on --${surface} = ${ratio.toFixed(2)}`);
      }
    }
  }
  // The sixteen host values are frozen (ADR required to change one), so a shortfall here is a
  // finding for the Design and accessibility lead, not something this package may fix. All six
  // pairs per theme clear the ratio today, and this assertion is what tells us if that changes.
  assert.deepEqual(shortfalls, []);
});

test('CTQ-11 tokens: every data and semantic colour reaches 3:1 on both surfaces', () => {
  const shortfalls: Record<string, number> = {};
  for (const theme of THEMES) {
    const variables = cssVariables(theme);
    for (const [name, value] of Object.entries(variables)) {
      if (name in NOT_MEASURED_AGAINST_SURFACES) continue;
      for (const surface of ['--bg', '--panel'] as const) {
        const ratio = contrastRatio(parseHex(value), parseHex(variables[surface]));
        if (ratio < DATA_CONTRAST) shortfalls[`${theme} ${name} on ${surface}`] = Number(ratio.toFixed(2));
      }
    }
  }
  assert.deepEqual(shortfalls, RECORDED_DATA_CONTRAST_FINDINGS,
    'every colour C02 chose must clear 3:1; only a frozen host value may be recorded instead');
});

test('CTQ-11 tokens: the tokens used as text reach 4.5:1, and the shortfalls are the recorded ones', () => {
  const shortfalls: Record<string, number> = {};
  for (const theme of THEMES) {
    const variables = cssVariables(theme);
    for (const name of TEXT_TOKENS) {
      for (const surface of ['--bg', '--panel'] as const) {
        const ratio = contrastRatio(parseHex(variables[name]), parseHex(variables[surface]));
        if (ratio < TEXT_CONTRAST) shortfalls[`${theme} ${name} on ${surface}`] = Number(ratio.toFixed(2));
      }
    }
  }
  assert.deepEqual(shortfalls, RECORDED_TEXT_CONTRAST_FINDINGS,
    'a new text-contrast shortfall needs an owner, and a fixed one must leave the recorded list');
});

test('CTQ-11 tokens: the matrix count reads against every cell fill it is drawn on', () => {
  for (const theme of THEMES) {
    const matrix = MATRIX_COLORS[theme];
    for (const fill of [matrix.oneToOne, matrix.oneToMany, matrix.unknown]) {
      const ratio = contrastRatio(parseHex(matrix.countInk), parseHex(fill));
      assert.ok(ratio >= TEXT_CONTRAST, `${theme}: count ink on ${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('CTQ-11 tokens: no two domain hues are confusable under any of the four vision conditions', () => {
  const report: string[] = [];
  for (const theme of THEMES) {
    const hues = DOMAIN_COLORS[theme];
    assert.equal(hues.length, DOMAIN_HUE_COUNT);
    let worst = Number.POSITIVE_INFINITY;
    let worstPair = '';
    for (let first = 0; first < hues.length; first++) {
      for (let second = first + 1; second < hues.length; second++) {
        const separation = minimumDeltaE(parseHex(hues[first]), parseHex(hues[second]), VISION_CONDITIONS);
        if (separation < worst) {
          worst = separation;
          worstPair = `${hues[first]} and ${hues[second]}`;
        }
      }
    }
    report.push(`${theme}: worst pair ${worstPair} at ${worst.toFixed(2)}`);
    assert.ok(worst >= DOMAIN_SEPARATION_FLOOR, report.join('; '));
  }
});

test('CTQ-11 tokens: the domain separation floor holds condition by condition', () => {
  for (const theme of THEMES) {
    const hues = DOMAIN_COLORS[theme].map(parseHex);
    for (const condition of VISION_CONDITIONS) {
      const seen = hues.map(hue => toLab(underVision(hue, condition)));
      let worst = Number.POSITIVE_INFINITY;
      for (let first = 0; first < seen.length; first++) {
        for (let second = first + 1; second < seen.length; second++) {
          worst = Math.min(worst, deltaE(seen[first], seen[second]));
        }
      }
      assert.ok(worst >= DOMAIN_SEPARATION_FLOOR,
        `${theme} under ${condition}: worst pair is ${worst.toFixed(2)}, floor is ${DOMAIN_SEPARATION_FLOOR}`);
    }
  }
});

test('CTQ-11 tokens: no two column-family swatches are confusable', () => {
  // Ten families, the same contrast rule and the same search as the domains, so the same floor.
  for (const theme of THEMES) {
    const variables = cssVariables(theme);
    const swatches = COLUMN_FAMILIES.map(family => parseHex(variables[`--ct-family-${family}`]));
    for (let first = 0; first < swatches.length; first++) {
      for (let second = first + 1; second < swatches.length; second++) {
        const separation = minimumDeltaE(swatches[first], swatches[second], VISION_CONDITIONS);
        assert.ok(separation >= DOMAIN_SEPARATION_FLOOR,
          `${theme}: ${COLUMN_FAMILIES[first]} and ${COLUMN_FAMILIES[second]} are ${separation.toFixed(2)} apart`);
      }
    }
  }
});

/**
 * The three-colour palettes, with the floor each one is held to and why.
 * The schema-diff floor is lower than the rest because added, removed and changed have to stay
 * green, red and amber: that convention is the first thing a reviewer reads, and a red-green
 * dichromat separates the three by lightness plus the stripe fill `SchemaDiff.css:29` gives
 * `removed`. Every other group was free to choose its hues, so it meets the categorical floor.
 */
const THREE_WAY_GROUPS: readonly { group: string; names: readonly string[]; floor: number }[] = [
  { group: 'schema diff', names: ['--sd-added', '--sd-removed', '--sd-changed'], floor: 10 },
  {
    group: 'join matrix',
    names: ['--matrix-one-to-one', '--matrix-one-to-many', '--matrix-unknown'],
    floor: DOMAIN_SEPARATION_FLOOR,
  },
  {
    group: 'join matrix soft',
    names: ['--matrix-one-to-one-soft', '--matrix-one-to-many-soft', '--matrix-unknown-soft'],
    floor: DOMAIN_SEPARATION_FLOOR,
  },
  { group: 'arc diagram', names: ['--arc-normal', '--arc-cycle', '--arc-isolated'], floor: DOMAIN_SEPARATION_FLOOR },
  { group: 'city roads', names: ['--road-declared', '--road-inferred', '--road-cross'], floor: DOMAIN_SEPARATION_FLOOR },
];

test('CTQ-11 tokens: no two members of a three-way palette are confusable', () => {
  for (const theme of THEMES) {
    const variables = cssVariables(theme);
    for (const { group, names, floor } of THREE_WAY_GROUPS) {
      for (let first = 0; first < names.length; first++) {
        for (let second = first + 1; second < names.length; second++) {
          const separation = minimumDeltaE(
            parseHex(variables[names[first]]),
            parseHex(variables[names[second]]),
            VISION_CONDITIONS,
          );
          assert.ok(separation >= floor,
            `${theme} ${group}: ${names[first]} and ${names[second]} are ${separation.toFixed(2)} apart, floor ${floor}`);
        }
      }
    }
  }
});

test('CTQ-04 tokens: a matrix cell backed by several foreign keys is not the single-key colour', () => {
  // The flat City fallback and the matrix both encode a second state by shifting the same hue,
  // so the shift has to survive a dichromat's eye as well as a normal one.
  for (const theme of THEMES) {
    const matrix = MATRIX_COLORS[theme];
    const pairs: readonly [string, string][] = [
      [matrix.oneToOne, matrix.oneToOneSoft],
      [matrix.oneToMany, matrix.oneToManySoft],
      [matrix.unknown, matrix.unknownSoft],
    ];
    for (const [strong, soft] of pairs) {
      // The count digit drawn in the cell is the definitive cue, so the colour step only has to be
      // unmistakable rather than categorical. It clears the categorical floor anyway.
      const separation = minimumDeltaE(parseHex(strong), parseHex(soft), VISION_CONDITIONS);
      assert.ok(separation >= DOMAIN_SEPARATION_FLOOR,
        `${theme}: ${strong} and ${soft} are ${separation.toFixed(2)} apart`);
    }
  }
});
