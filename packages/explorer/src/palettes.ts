/**
 * The data palettes of the explorer (work package C02, feature F21, CTQ-11).
 *
 * This file is the single source for every colour that encodes data. `tokens.css` mirrors it
 * as CSS custom properties for stylesheets, and `tokens.test.ts` fails if the two disagree.
 * The duplication exists because three.js materials, the Join Matrix canvas and SVG attributes
 * need a resolved colour string, and reading a CSS variable per frame is neither cheap nor
 * possible before the element is in the document.
 *
 * How the values were chosen, so a future change can be held to the same bar:
 *
 * - Every colour reaches at least 3:1 against both surfaces of its theme (`--bg` and `--panel`),
 *   which is the WCAG 2.1 non-text contrast minimum and the CTQ-11 rule for data colours.
 *   The tokens a stylesheet uses as text (`--sd-removed` in `.sd-risk`, `--arc-cycle` in the Arc
 *   Diagram cycle count and self-reference note, and the semantic inks) reach 4.5:1, or their
 *   shortfall is recorded against an owner; `tokens.test.ts` holds both lists.
 * - The twelve domain hues were selected by maximising the smallest CIEDE2000 difference between
 *   any two of them under normal vision, deuteranopia, protanopia and tritanopia at once, over
 *   the sRGB colours that satisfy the contrast rule, with one hue per 30-degree sector so the set
 *   still reads as categorical to a normal-vision viewer. The achieved worst case is 11.3 in the
 *   light theme and 12.2 in the dark one, and `tokens.test.ts` holds the floor. That is roughly
 *   six times the difference at which two patches stop looking identical, and short of the 20 the
 *   C02 brief asked for: 20 is not reachable for twelve colours whose lightness is pinned by the
 *   3:1 contrast rule, and the best unconstrained arrangement this search found was 15.4. Reducing
 *   the count instead of the threshold was the other option; the twelve stay because the stripe
 *   variant, not another hue, is what carries the thirteenth domain onwards.
 * - Light and dark entries at the same index sit in the same hue family, so switching theme
 *   never reshuffles which district or community is which colour.
 *
 * The sixteen host variables are copied byte for byte from `skill/assets/explorer.html` lines 9
 * and 10. They are a frozen contract: changing one needs an ADR, not an edit here.
 */

import { COLUMN_FAMILIES, type ColumnFamily } from './column-logic';

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** The sixteen host variables, byte-identical to `skill/assets/explorer.html:9-10`. */
export const HOST_VARIABLES = [
  'bg', 'panel', 'raised', 'ink', 'muted', 'line', 'accent', 'soft',
  'edge', 'focus', 'blue', 'orange', 'green', 'purple', 'red', 'grid',
] as const;
export type HostVariable = (typeof HOST_VARIABLES)[number];

export const HOST_COLORS: Record<Theme, Record<HostVariable, string>> = {
  light: {
    bg: '#f4f6f7', panel: '#fff', raised: '#edf1f3', ink: '#20262b',
    muted: '#53646c', line: '#ccd5d9', accent: '#087c77', soft: '#d7eeea',
    edge: '#98a7ac', focus: '#006e69', blue: '#3165a0', orange: '#af6226',
    green: '#31754e', purple: '#7654a2', red: '#af465c', grid: '#e4eaec',
  },
  dark: {
    bg: '#131718', panel: '#1b2022', raised: '#242b2e', ink: '#edf2f3',
    muted: '#a8b7bd', line: '#3a4549', accent: '#71d5c2', soft: '#253e38',
    edge: '#64767d', focus: '#a4eee0', blue: '#7fb6f0', orange: '#edb571',
    green: '#8fd3a5', purple: '#b99de1', red: '#ee99aa', grid: '#222a2d',
  },
};

/** Number of distinct hues before `domainColor` starts reusing them with a stripe. */
export const DOMAIN_HUE_COUNT = 12;
/** Distinct appearances `domainColor` can produce: every hue as a solid and as a stripe. */
export const DOMAIN_APPEARANCE_COUNT = DOMAIN_HUE_COUNT * 2;

/** The twelve district and community hues, ordered by hue angle. */
export const DOMAIN_COLORS: Record<Theme, readonly string[]> = {
  light: [
    '#7e0636', '#906054', '#604206', '#909054', '#54780c', '#66907e',
    '#064e48', '#127884', '#1896d8', '#484266', '#8436cc', '#f63cae',
  ],
  dark: [
    '#cc6c8a', '#ea1e1e', '#90725a', '#eade96', '#a8c000', '#7eae6c',
    '#aedec6', '#60f0ff', '#00bafc', '#0084f0', '#846ca8', '#cc9cba',
  ],
};

export type DomainPattern = 'solid' | 'stripe';
export interface DomainAppearance {
  color: string;
  pattern: DomainPattern;
}

/**
 * The appearance of one domain, district or community.
 *
 * Deterministic by the sorted position of `domainId` inside `allDomainIds`, so the same schema
 * always paints the same domain the same way, whatever order the caller happens to hold the ids
 * in and whichever view asks. The first twelve positions get the twelve hues as solids, the next
 * twelve repeat the hues as stripes, and beyond that the pair repeats: a schema with more than
 * twenty-four domains cannot be told apart by colour alone, and the views say so in their legend
 * rather than pretending otherwise.
 *
 * An id that is not in `allDomainIds` is still placed deterministically, by sorting it in.
 */
export function domainColor(domainId: string, allDomainIds: readonly string[], theme: Theme): DomainAppearance {
  const unique = [...new Set([...allDomainIds, domainId])].sort();
  const position = unique.indexOf(domainId);
  const appearance = ((position % DOMAIN_APPEARANCE_COUNT) + DOMAIN_APPEARANCE_COUNT) % DOMAIN_APPEARANCE_COUNT;
  return {
    color: DOMAIN_COLORS[theme][appearance % DOMAIN_HUE_COUNT],
    pattern: appearance < DOMAIN_HUE_COUNT ? 'solid' : 'stripe',
  };
}

/** One colour per `COLUMN_FAMILIES` entry (`column-logic.ts`), keyed by family name. */
export const COLUMN_FAMILY_COLORS: Record<Theme, Record<ColumnFamily, string>> = {
  light: {
    integer: '#2496cc', decimal: '#66846c', text: '#849012', datetime: '#6c6600',
    boolean: '#9c004e', json: '#5a00a2', binary: '#246cae', uuid: '#a87290',
    enum: '#5a3612', other: '#004842',
  },
  dark: {
    integer: '#a8e4f6', decimal: '#a2c06c', text: '#d8e400', datetime: '#9c6c54',
    boolean: '#ffaeba', json: '#78729c', binary: '#00bafc', uuid: '#b496b4',
    enum: '#e43c00', other: '#609c84',
  },
};

/** Schema diff status colours. `unchanged` stays `--muted`, so it is not listed here. */
export const DIFF_STATUS_COLORS: Record<Theme, { added: string; removed: string; changed: string }> = {
  light: { added: '#148054', removed: '#901834', changed: '#886400' },
  dark: { added: '#6cd4a0', removed: '#d86070', changed: '#c49838' },
};

/**
 * Join Matrix cell colours. The `soft` entry paints a cell backed by one declared foreign key
 * and the plain entry a cell backed by several, so the emphasis moves away from the surface in
 * both themes: darker on light, lighter on dark. `countInk` is the foreign-key count drawn on
 * the emphasised cell, and is the only pairing here that has to clear 4.5:1 against a fill.
 */
export const MATRIX_COLORS: Record<Theme, {
  oneToOne: string; oneToOneSoft: string;
  oneToMany: string; oneToManySoft: string;
  unknown: string; unknownSoft: string;
  countInk: string;
}> = {
  light: {
    oneToOne: '#00504c', oneToOneSoft: '#288884',
    oneToMany: '#a00008', oneToManySoft: '#f45044',
    unknown: '#3c0870', unknownSoft: '#6830a8',
    countInk: '#ffffff',
  },
  dark: {
    oneToOne: '#94f4ec', oneToOneSoft: '#38a098',
    oneToMany: '#fc9c84', oneToManySoft: '#fc3c28',
    unknown: '#e0c0ff', unknownSoft: '#c080fc',
    countInk: '#131718',
  },
};

/** Arc Diagram colours: an ordinary dependency, one on a cycle, and an isolated table. */
export const ARC_COLORS: Record<Theme, { normal: string; cycle: string; isolated: string }> = {
  light: { normal: '#006460', cycle: '#e01414', isolated: '#8c54d0' },
  dark: { normal: '#389490', cycle: '#fc5034', isolated: '#cc90fc' },
};

/** Schema City road colours: declared foreign key, inferred link, and a cross-district road. */
export const ROAD_COLORS: Record<Theme, { declared: string; inferred: string; cross: string }> = {
  light: { declared: '#006c68', inferred: '#ac70f0', cross: '#e82018' },
  dark: { declared: '#309c94', inferred: '#d094fc', cross: '#fc5438' },
};

/**
 * Schema City hemisphere-light colours. These are light sources multiplied into the district and
 * building materials rather than surfaces a reader looks at, so the contrast rule does not apply
 * to them; `tokens.test.ts` names them as the one deliberate exclusion.
 */
export const CITY_LIGHT_COLORS: Record<Theme, { sky: string; ground: string }> = {
  light: { sky: '#ffffff', ground: '#d3dbde' },
  dark: { sky: '#ffffff', ground: '#849396' },
};

/**
 * Semantic tokens. `danger`, `success`, `warning` and `focusRing` are the host `--red`,
 * `--green`, `--orange` and `--focus` under names that say what they mean, so a view never has
 * to decide which of the sixteen host hues carries an error. `selection` and `selectionSoft`
 * likewise track `--accent` and `--soft`; W02, W04 and W05 depend on those two names.
 * `elevation1..3` are shadow inks, not whole shadows: the geometry stays in each view's
 * stylesheet so this package changes no layout.
 *
 * `dim` is for marks and strokes that are present but pushed back, never for text. In the light
 * theme "quieter than `--muted`" and "4.5:1 on `--bg`" cannot both hold, because `--muted` itself
 * measures 5.69:1: a dim colour that reads as text would not read as dim. It therefore clears the
 * 3:1 graphical minimum (3.47:1 light, 4.96:1 dark) and `tokens.test.ts` holds it to that. A view
 * that needs de-emphasised words uses `--muted`.
 */
export const SEMANTIC_COLORS: Record<Theme, {
  danger: string; success: string; warning: string; focusRing: string;
  selection: string; selectionSoft: string; dim: string;
  elevation1: string; elevation2: string; elevation3: string;
}> = {
  light: {
    danger: HOST_COLORS.light.red,
    success: HOST_COLORS.light.green,
    warning: HOST_COLORS.light.orange,
    focusRing: HOST_COLORS.light.focus,
    selection: HOST_COLORS.light.accent,
    selectionSoft: HOST_COLORS.light.soft,
    dim: '#78868c',
    elevation1: '#00000011', elevation2: '#00000022', elevation3: '#00000033',
  },
  dark: {
    danger: HOST_COLORS.dark.red,
    success: HOST_COLORS.dark.green,
    warning: HOST_COLORS.dark.orange,
    focusRing: HOST_COLORS.dark.focus,
    selection: HOST_COLORS.dark.accent,
    selectionSoft: HOST_COLORS.dark.soft,
    dim: '#7f9096',
    elevation1: '#0000002b', elevation2: '#00000040', elevation3: '#00000059',
  },
};

const domainVariable = (index: number) => `--palette-domain-${String(index + 1).padStart(2, '0')}`;

/**
 * Every custom property `tokens.css` declares, per theme, with the value it must carry.
 * `tokens.test.ts` parses the stylesheet and compares it to this map in both directions, so a
 * palette edited here without regenerating the stylesheet (or the other way round) fails.
 */
export function cssVariables(theme: Theme): Record<string, string> {
  const host = HOST_COLORS[theme];
  const semantic = SEMANTIC_COLORS[theme];
  const diff = DIFF_STATUS_COLORS[theme];
  const matrix = MATRIX_COLORS[theme];
  const arc = ARC_COLORS[theme];
  const road = ROAD_COLORS[theme];
  const cityLight = CITY_LIGHT_COLORS[theme];
  const variables: Record<string, string> = {};
  for (const name of HOST_VARIABLES) variables[`--${name}`] = host[name];
  variables['--danger'] = semantic.danger;
  variables['--success'] = semantic.success;
  variables['--warning'] = semantic.warning;
  variables['--focus-ring'] = semantic.focusRing;
  variables['--selection'] = semantic.selection;
  variables['--selection-soft'] = semantic.selectionSoft;
  variables['--dim'] = semantic.dim;
  variables['--elevation-1'] = semantic.elevation1;
  variables['--elevation-2'] = semantic.elevation2;
  variables['--elevation-3'] = semantic.elevation3;
  DOMAIN_COLORS[theme].forEach((color, index) => { variables[domainVariable(index)] = color; });
  for (const family of COLUMN_FAMILIES) variables[`--ct-family-${family}`] = COLUMN_FAMILY_COLORS[theme][family];
  variables['--sd-added'] = diff.added;
  variables['--sd-removed'] = diff.removed;
  variables['--sd-changed'] = diff.changed;
  variables['--matrix-one-to-one'] = matrix.oneToOne;
  variables['--matrix-one-to-one-soft'] = matrix.oneToOneSoft;
  variables['--matrix-one-to-many'] = matrix.oneToMany;
  variables['--matrix-one-to-many-soft'] = matrix.oneToManySoft;
  variables['--matrix-unknown'] = matrix.unknown;
  variables['--matrix-unknown-soft'] = matrix.unknownSoft;
  variables['--matrix-count-ink'] = matrix.countInk;
  variables['--arc-normal'] = arc.normal;
  variables['--arc-cycle'] = arc.cycle;
  variables['--arc-isolated'] = arc.isolated;
  variables['--road-declared'] = road.declared;
  variables['--road-inferred'] = road.inferred;
  variables['--road-cross'] = road.cross;
  variables['--city-light-sky'] = cityLight.sky;
  variables['--city-light-ground'] = cityLight.ground;
  return variables;
}
