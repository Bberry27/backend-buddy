// Tests for packages/explorer/src/palettes.ts (work package C02, feature F21, CTQ-11).
//
// These cover the palette API: that `domainColor` is a function of the domain's sorted position
// and nothing else, that it reaches for the stripe variant instead of reusing a hue silently,
// and that every palette has exactly one entry per thing it has to colour. The perceptual gates
// (contrast, colour-vision separation) and the agreement with `tokens.css` live in
// `tokens.test.ts`; the two files together are the CTQ-11 palette evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMN_FAMILIES } from './column-logic';
import {
  ARC_COLORS,
  CITY_LIGHT_COLORS,
  COLUMN_FAMILY_COLORS,
  DIFF_STATUS_COLORS,
  DOMAIN_APPEARANCE_COUNT,
  DOMAIN_COLORS,
  DOMAIN_HUE_COUNT,
  HOST_COLORS,
  HOST_VARIABLES,
  MATRIX_COLORS,
  ROAD_COLORS,
  SEMANTIC_COLORS,
  THEMES,
  cssVariables,
  domainColor,
  type Theme,
} from './palettes';
import { parseHex, toLab } from './color-math';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANY_DOMAINS = join(ROOT, 'fixtures/schemas/many-domains.json');

/** The distinct `domain` values of a committed fixture, which is where the 14-domain case comes from. */
function fixtureDomains(path: string): string[] {
  const graph = JSON.parse(readFileSync(path, 'utf8')) as { tables: { domain?: string }[] };
  return [...new Set(graph.tables.map(table => table.domain).filter((d): d is string => typeof d === 'string'))];
}

test('F21 every palette entry is a parseable opaque hex colour', () => {
  for (const theme of THEMES) {
    for (const [name, value] of Object.entries(cssVariables(theme))) {
      assert.doesNotThrow(() => parseHex(value), `${theme} ${name} = ${value}`);
    }
  }
});

test('F21 the palettes cover exactly the things they have to colour', () => {
  assert.equal(HOST_VARIABLES.length, 16);
  for (const theme of THEMES) {
    assert.equal(DOMAIN_COLORS[theme].length, DOMAIN_HUE_COUNT);
    assert.equal(new Set(DOMAIN_COLORS[theme]).size, DOMAIN_HUE_COUNT, 'no hue repeats inside a theme');
    assert.deepEqual(Object.keys(COLUMN_FAMILY_COLORS[theme]).sort(), [...COLUMN_FAMILIES].sort());
    assert.deepEqual(Object.keys(HOST_COLORS[theme]).sort(), [...HOST_VARIABLES].sort());
    assert.deepEqual(Object.keys(DIFF_STATUS_COLORS[theme]).sort(), ['added', 'changed', 'removed']);
    assert.deepEqual(Object.keys(ARC_COLORS[theme]).sort(), ['cycle', 'isolated', 'normal']);
    assert.deepEqual(Object.keys(ROAD_COLORS[theme]).sort(), ['cross', 'declared', 'inferred']);
    assert.deepEqual(Object.keys(CITY_LIGHT_COLORS[theme]).sort(), ['ground', 'sky']);
    assert.deepEqual(Object.keys(MATRIX_COLORS[theme]).sort(),
      ['countInk', 'oneToMany', 'oneToManySoft', 'oneToOne', 'oneToOneSoft', 'unknown', 'unknownSoft']);
  }
});

test('F21 the semantic tokens are the host hues, not near-misses of them', () => {
  for (const theme of THEMES) {
    assert.equal(SEMANTIC_COLORS[theme].danger, HOST_COLORS[theme].red);
    assert.equal(SEMANTIC_COLORS[theme].success, HOST_COLORS[theme].green);
    assert.equal(SEMANTIC_COLORS[theme].warning, HOST_COLORS[theme].orange);
    assert.equal(SEMANTIC_COLORS[theme].focusRing, HOST_COLORS[theme].focus);
    assert.equal(SEMANTIC_COLORS[theme].selection, HOST_COLORS[theme].accent);
    assert.equal(SEMANTIC_COLORS[theme].selectionSoft, HOST_COLORS[theme].soft);
  }
});

test('F21 domainColor depends only on the sorted position, not on the caller order', () => {
  const ids = ['delta', 'alpha', 'charlie', 'bravo'];
  const shuffled = ['charlie', 'bravo', 'delta', 'alpha'];
  for (const theme of THEMES) {
    for (const id of ids) {
      assert.deepEqual(domainColor(id, ids, theme), domainColor(id, shuffled, theme), id);
    }
    assert.equal(domainColor('alpha', ids, theme).color, DOMAIN_COLORS[theme][0]);
    assert.equal(domainColor('bravo', ids, theme).color, DOMAIN_COLORS[theme][1]);
    assert.equal(domainColor('charlie', ids, theme).color, DOMAIN_COLORS[theme][2]);
    assert.equal(domainColor('delta', ids, theme).color, DOMAIN_COLORS[theme][3]);
  }
});

test('F21 domainColor is stable when unrelated domains repeat in the id list', () => {
  const withDuplicates = ['b', 'a', 'b', 'c', 'a'];
  for (const theme of THEMES) {
    assert.equal(domainColor('c', withDuplicates, theme).color, DOMAIN_COLORS[theme][2]);
    assert.deepEqual(domainColor('c', ['a', 'b', 'c'], theme), domainColor('c', withDuplicates, theme));
  }
});

test('F21 domainColor places an id that is missing from the list rather than failing', () => {
  for (const theme of THEMES) {
    const appearance = domainColor('b', ['a', 'c'], theme);
    assert.equal(appearance.color, DOMAIN_COLORS[theme][1], 'sorted in between a and c');
    assert.equal(appearance.pattern, 'solid');
  }
});

test('CTQ-11 domainColor switches to the stripe variant at the thirteenth domain', () => {
  const ids = Array.from({ length: DOMAIN_APPEARANCE_COUNT }, (_, index) => `d${String(index).padStart(2, '0')}`);
  for (const theme of THEMES) {
    ids.forEach((id, index) => {
      const appearance = domainColor(id, ids, theme);
      const expectedPattern = index < DOMAIN_HUE_COUNT ? 'solid' : 'stripe';
      assert.equal(appearance.pattern, expectedPattern, `${id} at position ${index}`);
      assert.equal(appearance.color, DOMAIN_COLORS[theme][index % DOMAIN_HUE_COUNT], id);
    });
    // Hue and pattern together are unique across all 24 appearances.
    const seen = new Set(ids.map(id => {
      const appearance = domainColor(id, ids, theme);
      return `${appearance.color} ${appearance.pattern}`;
    }));
    assert.equal(seen.size, DOMAIN_APPEARANCE_COUNT);
  }
});

test('CTQ-11 no two adjacent domains of the many-domains fixture share hue and pattern', () => {
  const domains = fixtureDomains(MANY_DOMAINS);
  assert.ok(domains.length > DOMAIN_HUE_COUNT,
    `the fixture must exceed the ${DOMAIN_HUE_COUNT} hues to exercise the stripe variant, found ${domains.length}`);
  const sorted = [...domains].sort();
  for (const theme of THEMES) {
    for (let index = 1; index < sorted.length; index++) {
      const previous = domainColor(sorted[index - 1], domains, theme);
      const current = domainColor(sorted[index], domains, theme);
      assert.notEqual(`${previous.color} ${previous.pattern}`, `${current.color} ${current.pattern}`,
        `${theme}: ${sorted[index - 1]} and ${sorted[index]} would look the same`);
    }
  }
});

test('F21 cssVariables lists every token exactly once and identically per theme', () => {
  const names = THEMES.map(theme => Object.keys(cssVariables(theme)));
  assert.deepEqual(names[0], names[1], 'both themes must declare the same token names');
  assert.equal(new Set(names[0]).size, names[0].length, 'no token declared twice');
  for (const name of names[0]) assert.match(name, /^--[a-z0-9-]+$/, name);
  const expected = 16 + 10 + DOMAIN_HUE_COUNT + COLUMN_FAMILIES.length + 3 + 7 + 3 + 3 + 2;
  assert.equal(names[0].length, expected, `token count changed: ${names[0].length} instead of ${expected}`);
});

test('F21 the light and dark palettes differ everywhere a theme should change the colour', () => {
  const light = cssVariables('light');
  const dark = cssVariables('dark');
  // The city sky light is deliberately white in both themes; everything else moves.
  const sharedByDesign = new Set(['--city-light-sky']);
  for (const [name, value] of Object.entries(light)) {
    if (sharedByDesign.has(name)) assert.equal(dark[name], value, name);
    else assert.notEqual(dark[name], value, `${name} is the same in both themes`);
  }
});

test('F21 the light and dark domain hues stay in the same family index by index', () => {
  // Measured as the CIE L*a*b* hue angle, which is the space the palette was searched in.
  const hue = (value: string) => {
    const { a, b } = toLab(parseHex(value));
    return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  };
  for (let index = 0; index < DOMAIN_HUE_COUNT; index++) {
    const lightHue = hue(DOMAIN_COLORS.light[index]);
    const darkHue = hue(DOMAIN_COLORS.dark[index]);
    const separation = Math.abs(((lightHue - darkHue + 180) % 360 + 360) % 360 - 180);
    assert.ok(separation <= 32,
      `domain ${index + 1}: ${DOMAIN_COLORS.light[index]} and ${DOMAIN_COLORS.dark[index]} are ${separation.toFixed(0)} degrees apart`);
  }
});

test('F21 the theme list is exactly the two themes the token layer defines', () => {
  const themes: readonly Theme[] = THEMES;
  assert.deepEqual([...themes], ['light', 'dark']);
});
