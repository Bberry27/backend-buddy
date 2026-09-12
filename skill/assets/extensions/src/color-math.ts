/**
 * Colour mathematics for the design-token layer (work package C02, feature F21, CTQ-11).
 *
 * Pure and dependency-free on purpose: `tokens.test.ts` and `palettes.test.ts` run under
 * `node:test` with no DOM, and the offline artifact bundles this file without any runtime
 * of its own.
 *
 * Formulas, named so a reviewer can check them against the sources:
 *
 * - `relativeLuminance` and `contrastRatio`: WCAG 2.1 relative luminance and contrast ratio
 *   (`(Lighter + 0.05) / (Darker + 0.05)`), sRGB transfer function with the 0.04045 break.
 * - `toLab`: CIE 1976 L*a*b* against the D65 white point (0.95047, 1, 1.08883), using the
 *   CIE 2004 rational constants (216/24389 and 841/108) so the transfer function is
 *   continuous at the break.
 * - `deltaE`: CIEDE2000 (CIE 142-2001) with kL = kC = kH = 1, in the formulation of
 *   Sharma, Wu and Dalal (2005). `color-math.test.ts` pins it against five pairs of that
 *   paper's reference table.
 * - `deltaE76`: CIE 1976 Euclidean distance in L*a*b*. Kept because the CIE76 number is the
 *   one quoted by older palette guidance; CIEDE2000 is what the palette gates use, because
 *   CIE76 overstates differences between saturated blues that CIEDE2000 (and the eye) treat
 *   as close.
 * - `simulateCvd`: dichromat simulation in the Smith-Pokorny LMS space of Brettel, Vienot and
 *   Mollon (1997). Protanopia and deuteranopia use the single-plane simplification of Vienot,
 *   Brettel and Mollon (1999) with the 475 nm anchor, which is the method those authors
 *   validated for the two red-green deficiencies; composed into linear sRGB it reproduces
 *   their published matrices (protanopia [0.11238, 0.88762, 0], deuteranopia
 *   [0.29275, 0.70725, 0]) to five decimal places, and `color-math.test.ts` asserts that.
 *   The 1999 simplification is not defined for tritanopia, so tritanopia uses the original
 *   1997 two-half-plane construction with the 485 nm and 660 nm anchors; the half-plane is
 *   selected by comparing L/M against the white point's L/M ratio.
 *
 * Every entry point takes and returns plain numbers so that the palette tests can run the
 * whole token table through them without allocating objects per pair.
 */

/** An sRGB colour with channels in 0..255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** CIE L*a*b* coordinates. */
export interface Lab {
  l: number;
  a: number;
  b: number;
}

export type CvdKind = 'protanopia' | 'deuteranopia' | 'tritanopia';
/** The vision conditions the palette gates are evaluated under. */
export type VisionCondition = 'normal' | CvdKind;
export const VISION_CONDITIONS: readonly VisionCondition[] = ['normal', 'deuteranopia', 'protanopia', 'tritanopia'];

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** sRGB (linear) to CIE XYZ, D65, IEC 61966-2-1. */
const RGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
] as const;
const D65 = [0.95047, 1.0, 1.08883] as const;
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 841 / 108;
/** Linear sRGB to Smith-Pokorny LMS, the matrix used by Brettel (1997) and Vienot (1999). */
const RGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
] as const;
/** Inverse of RGB_TO_LMS, computed once and pinned by a round-trip test. */
const LMS_TO_RGB = [
  [0.080944447904977, -0.130504409160321, 0.116721066439603],
  [-0.010248533514607, 0.054019326635999, -0.113614708214044],
  [-0.000365296937861, -0.004121614685876, 0.693511404860859],
] as const;
/** Vienot (1999) single-plane reduction: L' = 2.02344 M - 2.52581 S (475 nm anchor). */
const PROTAN_FROM_MS = [2.02344, -2.52581] as const;
/** Vienot (1999) single-plane reduction: M' = 0.494207 L + 1.24827 S (475 nm anchor). */
const DEUTAN_FROM_LS = [0.494207, 1.24827] as const;
/** Brettel (1997) tritanopia half-plane through the 660 nm anchor: S' = a L + b M. */
const TRITAN_FROM_LM_660 = [-0.002515, 0.053545] as const;
/** Brettel (1997) tritanopia half-plane through the 485 nm anchor. */
const TRITAN_FROM_LM_485 = [-0.060102, 0.162975] as const;
/** M/L of the white point in LMS: L/M above this ratio selects the 660 nm half-plane. */
const WHITE_M_OVER_L = 34.47819 / 65.51785;

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (deg: number) => (deg * Math.PI) / 180;

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (with or without the leading `#`).
 * Alpha is accepted and dropped: contrast and colour difference are defined for opaque
 * colours, and every palette entry in `palettes.ts` is opaque.
 */
export function parseHex(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) throw new Error(`Not a hex colour: ${JSON.stringify(hex)}`);
  const digits = match[1];
  const expand = digits.length <= 4
    ? digits.slice(0, 3).split('').map(digit => digit + digit)
    : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
  const [r, g, b] = expand.map(pair => Number.parseInt(pair, 16));
  return { r, g, b };
}

/** Formats 0..255 channels as lower-case `#rrggbb`, rounding and clamping first. */
export function formatHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** sRGB 0..255 to linear-light 0..1 (IEC 61966-2-1 transfer function). */
export function toLinear({ r, g, b }: Rgb): [number, number, number] {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return [channel(r), channel(g), channel(b)];
}

/** Linear-light 0..1 back to sRGB 0..255, clamping out-of-gamut values. */
export function fromLinear(linear: readonly [number, number, number]): Rgb {
  const channel = (value: number) => {
    const unit = clamp01(value);
    return 255 * (unit <= 0.0031308 ? unit * 12.92 : 1.055 * unit ** (1 / 2.4) - 0.055);
  };
  return { r: channel(linear[0]), g: channel(linear[1]), b: channel(linear[2]) };
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  const [r, g, b] = toLinear(color);
  return RGB_TO_XYZ[1][0] * r + RGB_TO_XYZ[1][1] * g + RGB_TO_XYZ[1][2] * b;
}

/** WCAG 2.1 contrast ratio, always >= 1 and order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIE L*a*b* (D65) of an sRGB colour. */
export function toLab(color: Rgb): Lab {
  const linear = toLinear(color);
  const transfer = (value: number) => (value > LAB_EPSILON ? Math.cbrt(value) : LAB_KAPPA * value + 4 / 29);
  const xyz = RGB_TO_XYZ.map(row => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]);
  const [fx, fy, fz] = xyz.map((value, index) => transfer(value / D65[index]));
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE 1976 colour difference: Euclidean distance in L*a*b*. */
export function deltaE76(first: Lab, second: Lab): number {
  return Math.hypot(second.l - first.l, second.a - first.a, second.b - first.b);
}

/**
 * CIEDE2000 colour difference (CIE 142-2001), kL = kC = kH = 1.
 * Implemented in the form given by Sharma, Wu and Dalal (2005), whose reference pairs
 * `color-math.test.ts` reproduces.
 */
export function deltaE(first: Lab, second: Lab): number {
  const meanL = (first.l + second.l) / 2;
  const chroma1 = Math.hypot(first.a, first.b);
  const chroma2 = Math.hypot(second.a, second.b);
  const meanChroma = (chroma1 + chroma2) / 2;
  const pow7 = meanChroma ** 7;
  const g = 0.5 * (1 - Math.sqrt(pow7 / (pow7 + 25 ** 7)));
  const a1 = first.a * (1 + g);
  const a2 = second.a * (1 + g);
  const primeChroma1 = Math.hypot(a1, first.b);
  const primeChroma2 = Math.hypot(a2, second.b);
  const meanPrimeChroma = (primeChroma1 + primeChroma2) / 2;
  const hue1 = (degrees(Math.atan2(first.b, a1)) + 360) % 360;
  const hue2 = (degrees(Math.atan2(second.b, a2)) + 360) % 360;
  const chromaProductIsZero = primeChroma1 * primeChroma2 === 0;
  let hueDelta = hue2 - hue1;
  if (chromaProductIsZero) hueDelta = 0;
  else if (hueDelta > 180) hueDelta -= 360;
  else if (hueDelta < -180) hueDelta += 360;
  const hueSum = hue1 + hue2;
  const meanHue = chromaProductIsZero
    ? hueSum
    : Math.abs(hue1 - hue2) <= 180
      ? hueSum / 2
      : hueSum < 360
        ? (hueSum + 360) / 2
        : (hueSum - 360) / 2;
  const deltaLightness = second.l - first.l;
  const deltaChroma = primeChroma2 - primeChroma1;
  const deltaHue = 2 * Math.sqrt(primeChroma1 * primeChroma2) * Math.sin(radians(hueDelta) / 2);
  const t = 1
    - 0.17 * Math.cos(radians(meanHue - 30))
    + 0.24 * Math.cos(radians(2 * meanHue))
    + 0.32 * Math.cos(radians(3 * meanHue + 6))
    - 0.2 * Math.cos(radians(4 * meanHue - 63));
  const lightnessOffset = (meanL - 50) ** 2;
  const sL = 1 + (0.015 * lightnessOffset) / Math.sqrt(20 + lightnessOffset);
  const sC = 1 + 0.045 * meanPrimeChroma;
  const sH = 1 + 0.015 * meanPrimeChroma * t;
  const theta = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
  const meanPrimePow7 = meanPrimeChroma ** 7;
  const rC = 2 * Math.sqrt(meanPrimePow7 / (meanPrimePow7 + 25 ** 7));
  const rT = -rC * Math.sin(radians(2 * theta));
  const lightnessTerm = deltaLightness / sL;
  const chromaTerm = deltaChroma / sC;
  const hueTerm = deltaHue / sH;
  return Math.sqrt(lightnessTerm ** 2 + chromaTerm ** 2 + hueTerm ** 2 + rT * chromaTerm * hueTerm);
}

/**
 * Simulates how an sRGB colour appears to a dichromat, returning an sRGB colour.
 * Out-of-gamut results are clamped per channel, which is what every display-side
 * simulation does and what the palette gates need: the comparison is between colours
 * a screen can actually show.
 */
export function simulateCvd(color: Rgb, kind: CvdKind): Rgb {
  const linear = toLinear(color);
  const lms = RGB_TO_LMS.map(row => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]) as
    [number, number, number];
  const [l, m, s] = lms;
  if (kind === 'protanopia') {
    lms[0] = PROTAN_FROM_MS[0] * m + PROTAN_FROM_MS[1] * s;
  } else if (kind === 'deuteranopia') {
    lms[1] = DEUTAN_FROM_LS[0] * l + DEUTAN_FROM_LS[1] * s;
  } else {
    const plane = m <= WHITE_M_OVER_L * l ? TRITAN_FROM_LM_660 : TRITAN_FROM_LM_485;
    lms[2] = plane[0] * l + plane[1] * m;
  }
  const back = LMS_TO_RGB.map(row => row[0] * lms[0] + row[1] * lms[1] + row[2] * lms[2]) as
    [number, number, number];
  return fromLinear(back);
}

/** The colour as seen under `condition`; `'normal'` returns the input unchanged. */
export function underVision(color: Rgb, condition: VisionCondition): Rgb {
  return condition === 'normal' ? color : simulateCvd(color, condition);
}

/**
 * Smallest CIEDE2000 difference between two colours across the given vision conditions.
 * This is the number the categorical-palette gate in `tokens.test.ts` uses: a pair is only
 * as distinguishable as its worst condition.
 */
export function minimumDeltaE(
  first: Rgb,
  second: Rgb,
  conditions: readonly VisionCondition[] = VISION_CONDITIONS,
): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const condition of conditions) {
    const value = deltaE(toLab(underVision(first, condition)), toLab(underVision(second, condition)));
    if (value < smallest) smallest = value;
  }
  return smallest;
}
