// Tests for packages/explorer/src/color-math.ts (work package C02, feature F21, CTQ-11).
//
// The palette gates in tokens.test.ts are only worth their names if the arithmetic under them is
// right, so every formula is pinned against a published reference rather than against itself:
// WCAG contrast against the values the specification quotes, CIEDE2000 against five pairs of the
// Sharma, Wu and Dalal (2005) test table, and the dichromat simulation against the linear-sRGB
// matrices published by Vienot, Brettel and Mollon (1999), recomputed here from those constants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VISION_CONDITIONS,
  contrastRatio,
  deltaE,
  deltaE76,
  formatHex,
  fromLinear,
  minimumDeltaE,
  parseHex,
  relativeLuminance,
  simulateCvd,
  toLab,
  toLinear,
  underVision,
  type Lab,
  type Rgb,
} from './color-math';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const lab = (l: number, a: number, b: number): Lab => ({ l, a, b });

/** Vienot, Brettel and Mollon (1999), table 1: the reduction matrices in linear sRGB. */
const VIENOT_MATRICES = {
  protanopia: [
    [0.11238, 0.88762, 0.0],
    [0.11238, 0.88762, 0.0],
    [0.00401, -0.00401, 1.0],
  ],
  deuteranopia: [
    [0.29275, 0.70725, 0.0],
    [0.29275, 0.70725, 0.0],
    [-0.02234, 0.02234, 1.0],
  ],
} as const;

/** Applies one published matrix through the same clamp and encode path simulateCvd uses. */
function vienot(color: Rgb, kind: 'protanopia' | 'deuteranopia'): Rgb {
  const linear = toLinear(color);
  const matrix = VIENOT_MATRICES[kind];
  return fromLinear(matrix.map(row => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]) as
    [number, number, number]);
}

const SAMPLES: readonly string[] = [
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
  '#087c77', '#71d5c2', '#af465c', '#3165a0', '#edb571', '#8fd3a5', '#722418', '#0066ff',
];

test('F21 parseHex accepts the three-, four-, six- and eight-digit forms and drops alpha', () => {
  assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('#0f83'), { r: 0, g: 255, b: 136 });
  assert.deepEqual(parseHex('#087c77'), { r: 8, g: 124, b: 119 });
  assert.deepEqual(parseHex('#087c7780'), { r: 8, g: 124, b: 119 });
  assert.deepEqual(parseHex('  #AF465C  '), { r: 175, g: 70, b: 92 });
});

test('F21 parseHex rejects anything that is not a hex colour', () => {
  for (const value of ['', '#', '#ff', '#fffff', 'rebeccapurple', 'rgb(0,0,0)', '#12345g']) {
    assert.throws(() => parseHex(value), /Not a hex colour/, `should reject ${JSON.stringify(value)}`);
  }
});

test('F21 formatHex round-trips every sample and clamps out-of-range channels', () => {
  for (const sample of SAMPLES) assert.equal(formatHex(parseHex(sample)), sample);
  assert.equal(formatHex({ r: -20, g: 300, b: 127.5 }), '#00ff80');
});

test('F21 toLinear and fromLinear invert each other to within a quantisation step', () => {
  for (const sample of SAMPLES) {
    const original = parseHex(sample);
    const roundTrip = fromLinear(toLinear(original));
    for (const channel of ['r', 'g', 'b'] as const) {
      assert.ok(Math.abs(roundTrip[channel] - original[channel]) < 1e-6,
        `${sample} channel ${channel}: ${roundTrip[channel]} vs ${original[channel]}`);
    }
  }
});

test('F21 relativeLuminance matches the WCAG anchors', () => {
  // The IEC 61966-2-1 matrix row sums to 1.0000001, not to 1, so white lands one part in ten
  // million above unity. That is the published matrix, not a rounding slip here.
  assert.ok(Math.abs(relativeLuminance(WHITE) - 1) < 1e-6);
  assert.equal(relativeLuminance(BLACK), 0);
  // A neutral colour's luminance is its own linearised channel value, because the three
  // coefficients sum to one: ((0.5 + 0.055) / 1.055) to the 2.4 is 0.2140411...
  assert.ok(Math.abs(relativeLuminance({ r: 127.5, g: 127.5, b: 127.5 }) - 0.2140411618863466) < 1e-12);
});

test('CTQ-11 contrastRatio matches the WCAG anchors and is order-independent', () => {
  // 21:1 up to the 1.0000001 row sum of the published matrix.
  assert.ok(Math.abs(contrastRatio(WHITE, BLACK) - 21) < 1e-5);
  assert.equal(contrastRatio(BLACK, WHITE), contrastRatio(WHITE, BLACK));
  assert.equal(contrastRatio(WHITE, WHITE), 1);
  // #767676 is the darkest grey that still clears 4.5:1 on white; #777777 does not.
  assert.ok(contrastRatio(parseHex('#767676'), WHITE) >= 4.5);
  assert.ok(contrastRatio(parseHex('#777777'), WHITE) < 4.5);
});

test('F21 toLab places the neutral axis where CIE L*a*b* says it is', () => {
  const white = toLab(WHITE);
  assert.ok(Math.abs(white.l - 100) < 1e-4);
  assert.ok(Math.abs(white.a) < 1e-3 && Math.abs(white.b) < 1e-3);
  const black = toLab(BLACK);
  assert.ok(Math.abs(black.l) < 1e-9);
  const grey = toLab({ r: 128, g: 128, b: 128 });
  assert.ok(Math.abs(grey.l - 53.585) < 0.01, `mid grey L* was ${grey.l}`);
  assert.ok(Math.abs(grey.a) < 1e-3 && Math.abs(grey.b) < 1e-3);
});

test('CTQ-11 deltaE reproduces the Sharma, Wu and Dalal CIEDE2000 reference pairs', () => {
  const pairs: readonly [Lab, Lab, number][] = [
    [lab(50, 2.6772, -79.7751), lab(50, 0, -82.7485), 2.0425],
    [lab(50, 3.1571, -77.2803), lab(50, 0, -82.7485), 2.8615],
    [lab(50, -1.3802, -84.2814), lab(50, 0, -82.7485), 1.0],
    [lab(60.2574, -34.0099, 36.2677), lab(60.4626, -34.1751, 39.4387), 1.2644],
    [lab(2.0776, 0.0795, -1.135), lab(0.9033, -0.0636, -0.5514), 0.9082],
  ];
  for (const [first, second, expected] of pairs) {
    assert.ok(Math.abs(deltaE(first, second) - expected) < 1e-4,
      `expected ${expected}, got ${deltaE(first, second)}`);
    assert.ok(Math.abs(deltaE(second, first) - expected) < 1e-4, 'CIEDE2000 must be symmetric');
  }
});

test('F21 deltaE and deltaE76 are zero for identical colours and positive otherwise', () => {
  for (const sample of SAMPLES) {
    const value = toLab(parseHex(sample));
    assert.equal(deltaE(value, value), 0);
    assert.equal(deltaE76(value, value), 0);
  }
  assert.ok(deltaE(toLab(WHITE), toLab(BLACK)) > 90);
  assert.ok(Math.abs(deltaE76(lab(50, 0, 0), lab(50, 3, 4)) - 5) < 1e-12);
});

test('F21 simulateCvd reproduces the published Vienot 1999 matrices for the red-green types', () => {
  for (const kind of ['protanopia', 'deuteranopia'] as const) {
    for (const sample of SAMPLES) {
      const color = parseHex(sample);
      const mine = simulateCvd(color, kind);
      const published = vienot(color, kind);
      for (const channel of ['r', 'g', 'b'] as const) {
        assert.ok(Math.abs(mine[channel] - published[channel]) < 0.02,
          `${kind} ${sample} channel ${channel}: ${mine[channel]} vs ${published[channel]}`);
      }
    }
  }
});

test('F21 simulateCvd leaves the neutral axis and the confusion anchors alone', () => {
  for (const condition of VISION_CONDITIONS) {
    assert.equal(formatHex(underVision(WHITE, condition)), '#ffffff');
    assert.equal(formatHex(underVision(BLACK, condition)), '#000000');
  }
  // Blue is unmoved by the red-green types, and yellow by both of them.
  assert.equal(formatHex(simulateCvd(parseHex('#0000ff'), 'protanopia')), '#0000ff');
  assert.equal(formatHex(simulateCvd(parseHex('#0000ff'), 'deuteranopia')), '#0000ff');
  assert.equal(formatHex(simulateCvd(parseHex('#ffff00'), 'protanopia')), '#ffff00');
  assert.equal(formatHex(simulateCvd(parseHex('#ffff00'), 'deuteranopia')), '#ffff00');
});

test('F21 simulateCvd collapses red against green and keeps them apart for a tritanope', () => {
  const red = parseHex('#ff0000');
  const green = parseHex('#00ff00');
  // Lightness survives every deficiency, so the telling measure is how much of the a*/b*
  // separation is left: a red-green dichromat loses most of it, a tritanope keeps it.
  const chromaGap = (first: Rgb, second: Rgb) => {
    const a = toLab(first);
    const b = toLab(second);
    return Math.hypot(b.a - a.a, b.b - a.b);
  };
  const normal = chromaGap(red, green);
  assert.ok(normal > 150, `red and green differ by ${normal} to a normal-vision viewer`);
  for (const kind of ['protanopia', 'deuteranopia'] as const) {
    const left = chromaGap(simulateCvd(red, kind), simulateCvd(green, kind));
    assert.ok(left < normal * 0.35, `${kind} left ${(left / normal * 100).toFixed(0)}% of the hue gap`);
  }
  const tritan = chromaGap(simulateCvd(red, 'tritanopia'), simulateCvd(green, 'tritanopia'));
  assert.ok(tritan > normal * 0.5, `tritanopia should keep red and green apart, kept ${tritan}`);
});

test('F21 simulateCvd tritanopia pins the primaries it is hardest to get right', () => {
  // Blue reads as a desaturated teal and green as a pale cyan for a tritanope; these are the
  // values the Brettel 1997 two-half-plane construction gives with the 485 nm and 660 nm anchors.
  assert.equal(formatHex(simulateCvd(parseHex('#0000ff'), 'tritanopia')), '#006288');
  assert.equal(formatHex(simulateCvd(parseHex('#00ff00'), 'tritanopia')), '#79e9ff');
  assert.equal(formatHex(simulateCvd(parseHex('#ff0000'), 'tritanopia')), '#ff004e');
  assert.equal(formatHex(simulateCvd(parseHex('#ffff00'), 'tritanopia')), '#ffeef1');
});

test('F21 minimumDeltaE is symmetric and never exceeds the normal-vision difference', () => {
  const first = parseHex('#00784c');
  const second = parseHex('#b04050');
  const worst = minimumDeltaE(first, second);
  assert.equal(worst, minimumDeltaE(second, first));
  assert.ok(worst <= deltaE(toLab(first), toLab(second)) + 1e-12);
  assert.equal(minimumDeltaE(first, first), 0);
  assert.equal(minimumDeltaE(first, second, ['normal']), deltaE(toLab(first), toLab(second)));
});

test('F21 underVision passes normal vision through untouched', () => {
  for (const sample of SAMPLES) {
    const color = parseHex(sample);
    assert.deepEqual(underVision(color, 'normal'), color);
  }
});
