Status: draft | Owner: Design and accessibility lead | Last verified against code: pre-repo (2026-09-07)

# WP-C02 Design tokens and theme

| Field | Value |
|---|---|
| Work package | C02 (track C, phase 1) |
| Features | F21, F05 (React Flow `colorMode`), F07 (`--ct-family` palette), F08 (`domainColor` provided; consumed in W05), F10 (status palette), F11 (JoinMatrix theme read), F12, F13 (community palette) (F21, F08, F11, F12, F13 have no feature document yet; registry rows `docs/features/README.md:26`, `:29-31`, `:39`) |
| CTQs | CTQ-02 (theme matrix), CTQ-04 (flat City stays legible in both themes), CTQ-11 (contrast >= 4.5:1 text, >= 3:1 data, colour-vision-deficiency separation) |
| Caveats | none surfaced in UI; C16 governs F21 (the flat fallback must remain available and legible in both themes) |
| Depends on | R01 (`fixtures/schemas/many-domains.json` with 14 domains for palette tests) |
| Blocks | W01 (theme toggle, `ThemeProvider`), W05 (`domainColor`, road tokens) |
| Branch | `c02/design-tokens-theme` |
| Gate | G1 |

### 1. Goal

Create the token layer that does not exist today: `packages/explorer/src/tokens.css` with the 16 host variables byte-identical to `skill/assets/explorer.html:9-10` plus semantic tokens, six data palettes as CSS variables with light and dark values, `palettes.ts` (`domainColor(domainId, allDomainIds, theme)` with at least 12 hues and a stripe variant beyond), `color-math.ts` (contrast, Brettel/Vienot colour-vision-deficiency simulation, colour difference), `theme.tsx` (`ThemeProvider`, `useTheme`, single-observer `useThemeDetector` for the artifact), replace the per-ancestor `MutationObserver` in `JoinMatrix.tsx:103-111`, pass `colorMode` to `<ReactFlow>` in `LivingERD.tsx:195`, remove every hardcoded colour from the nine views' CSS and TSX into tokens or palettes, and add `scripts/check-hardcoded-colors.mjs` plus `tokens.test.ts` so the invariants hold in CI. The artifact must render pixel-identically in dark mode for the host chrome (same variable values) and legibly in light mode for every view.

### 2. Reading list (ordered)

1. `docs/features/README.md` row F21 (surfaces: `explorer.html:9-10` today; planned `tokens.css`, `palettes.ts`, `theme.tsx`) and rows F05, F07, F08, F10, F11, F13 (caveat and CTQ columns).
2. `docs/features/F05-living-erd.md`, `F07-column-table.md`, `F10-schema-diff.md` sections 3 and 12 (current colour usage and accessibility notes); `docs/features/F22-offline-artifact-and-skill.md` section 3 (host theme persistence `backend-buddy:<project.key>:theme`, `explorer.html:53-56`).
3. `docs/architecture/adr/ADR-0002-frontend-spa-and-iife-export-path.md` decision 5 (theme via `html[data-theme]` + `tokens.css` + a `theme` prop later; single `useThemeDetector` in the artifact) and decision 2 (`packages/explorer` stays shell-neutral: no router, fetch, Vitest).
4. `docs/architecture/adr/ADR-0006-deployment-topology-and-artifact-csp.md` decision 5: the CSP forbids external stylesheets, fonts, and `url()` fetches; tokens must be plain inline CSS bundled into `extensions.css`.
5. `docs/product-management/ctq.md` CTQ-11 row and note (axe per route/theme/width; `tokens.test.ts` contrast and pairwise colour difference >= 20 under normal, deuteranopia, protanopia) and CTQ-02.
6. `docs/product-management/risk-register.md` RK-17 (theme fallbacks are wrong outside the host; City palette and roads untested in light mode) and RK-05 (do not change lifecycle behaviour while editing views).
7. `docs/reference/limits-and-caps.md` A4 (City palette 7 colours at `city-layout.ts:77`, `:194`; W05 replaces the call site) and C (16 host variables preserved).
8. Code, in this order:
    - `skill/assets/explorer.html:9` (light `:root`: `--bg #f4f6f7 --panel #fff --raised #edf1f3 --ink #20262b --muted #53646c --line #ccd5d9 --accent #087c77 --soft #d7eeea --edge #98a7ac --focus #006e69 --blue #3165a0 --orange #af6226 --green #31754e --purple #7654a2 --red #af465c --grid #e4eaec`, `color-scheme:light`) and `:10` (dark: `--bg #131718 --panel #1b2022 --raised #242b2e --ink #edf2f3 --muted #a8b7bd --line #3a4549 --accent #71d5c2 --soft #253e38 --edge #64767d --focus #a4eee0 --blue #7fb6f0 --orange #edb571 --green #8fd3a5 --purple #b99de1 --red #ee99aa --grid #222a2d`, `color-scheme:dark`); `:2` (`<html data-theme="dark">`), `:16` (`__EXTENSIONS_CSS__` is inlined after the host variables, so identical `:root` values in `tokens.css` change nothing), `:41` (host entity-type stripe map: the only token-driven data palette today), `:53-56` (theme switching, storage key).
    - `packages/explorer/src/JoinMatrix.tsx:10` (`COLORS` cardinality palette), `:56-61` (`getComputedStyle` reads of `--bg --panel --line --ink --accent` with dark-only hex fallbacks), `:70` and `:183` (`#fff` cell text), `:103-111` (the observer to replace: `MutationObserver` on every ancestor's `class`/`style`/`data-theme` plus a `matchMedia` listener), `:180-197` (SVG path with inline `var(--x, fallback)`).
    - `packages/explorer/src/LivingERD.tsx:7` (`@xyflow/react/dist/style.css` import), `:169` (`getComputedStyle(...).backgroundColor` for PNG/SVG export: an allowlisted read), `:195` (`<ReactFlow ...>` without `colorMode`); `LivingERD.css:22` (four `--xy-*` overrides).
    - `packages/explorer/src/ColumnTable.css:13` (`color-scheme: light dark` contradicts the host), `:37-46` (`--ct-family` per `ct-family-<name>` class, 10 values), `:53` (`#de6871` error red), `:65`, `:76`; `packages/explorer/src/column-logic.ts:5` (`COLUMN_FAMILIES`, the class-name binding); `ColumnTable.tsx:83`, `:187` (class composition).
    - `packages/explorer/src/SchemaDiff.css:1` (`--sd-added #269867 --sd-removed #cc5665 --sd-changed #b58a28` and the `color-mix` fills), `:30-33` (per-status remap to `--sd-status`/`--sd-fill`: the pattern to reuse for every palette).
    - `packages/explorer/src/city-layout.ts:77` (`COLORS`, 7 values) and `:194` (`COLORS[index % COLORS.length]`; W05 swaps the call, this package leaves both lines and allowlists them), `:7`, `:10` (`color: string` on district and building); `City.tsx:141` (`new THREE.Color(building.color)`), `:174` and `:242` (road colours `#e96d92` cross-district, `#abb7bb` inferred, `#70c5c8` declared, duplicated for 3D and flat), `:333` (`hemisphereLight` `#ffffff`/`#849396`); `City.css:42`, `:48`, `:59`.
    - `packages/explorer/src/Domains.tsx:11` (8-colour `colors`, index-cycled at `:66`); `ArcDiagram.tsx:77`, `:80`, `:93`, `:102` (`#56abb4`, `#df8b54`, `#90969c`) and `ArcDiagram.css:6`, `:21`, `:30-32`; `Fanout.css:20` (`#dc626c`); `NormalizationLens.css:3` (`#d05e65`, `#0001` shadow); `Domains.css:1`, `LivingERD.css:8`, `:23`, `City.css:48` (shadow literals).
    - Hex literal counts today (`grep -o '#[0-9a-fA-F]\{3,8\}\b'`): `ArcDiagram.css` 22, `City.css` 23, `ColumnTable.css` 43, `Domains.css` 1, `Fanout.css` 1, `JoinMatrix.css` 10, `LivingERD.css` 2, `NormalizationLens.css` 1, `SchemaDiff.css` 30, `ArcDiagram.tsx` 8, `City.tsx` 3, `Domains.tsx` 1, `JoinMatrix.tsx` 15, `city-layout.ts` 1: the target after this package is 0 outside `tokens.css`, `palettes.ts`, and the allowlist.
    - `packages/explorer/src/index.tsx` (must not be edited here: C03 owns it; `tokens.css` is imported from `theme.tsx`, which views import, so esbuild bundles it into `dist/extensions.css`).
    - `fixtures/schemas/many-domains.json` (14 domains; palette stress) and `fixtures/README.md` (the `many-domains` row names C02).
9. `AGENTS.md` sections 5-7. `docs/engineering/accessibility-standards.md` (D03) does not exist yet; CTQ-11 and this brief are the standard.

### 3. In scope

1. **`packages/explorer/src/tokens.css`**: `:root` and `:root[data-theme=dark]` blocks with the 16 host variables at exactly the values above (byte-identical per variable; `tokens.test.ts` parses both files and compares), `color-scheme` per theme, semantic tokens `--danger --success --warning --focus-ring --elevation-1 --elevation-2 --elevation-3 --selection --selection-soft --dim` (light and dark values chosen to meet the contrast rules; `--focus-ring` derives from `--focus`, `--danger` from `--red`), and six data palettes as variables with light and dark values: `--palette-domain-01..12` (district and community hues), `--ct-family-*` (10, one per `COLUMN_FAMILIES` entry), `--sd-added --sd-removed --sd-changed`, `--matrix-one-to-many --matrix-one-to-one --matrix-unknown` (plus soft variants), `--arc-normal --arc-cycle --arc-isolated`, `--road-declared --road-inferred --road-cross`. Also `@media (prefers-reduced-motion: reduce)` is not this package (W01).
2. **`palettes.ts`** (pure, node:test): `domainColor(domainId, allDomainIds, theme): {color: string; pattern: 'solid' | 'stripe'}` deterministic by sorted position of `domainId` within `allDomainIds`; hues 1-12 solid, 13-24 the same hues with `pattern: 'stripe'`; exported `COLUMN_FAMILY_COLORS`, `DIFF_STATUS_COLORS`, `MATRIX_COLORS`, `ARC_COLORS`, `ROAD_COLORS` as `Record<theme, ...>` for JS consumers (three.js materials, canvas, SVG attributes) that cannot read CSS variables cheaply; the values are the single source and `tokens.css` mirrors them (`tokens.test.ts` asserts equality between the CSS text and the exports).
3. **`color-math.ts`** (pure): `parseHex`, `relativeLuminance`, `contrastRatio` (WCAG 2.x), `simulateCvd(rgb, 'deuteranopia' | 'protanopia' | 'tritanopia')` (Brettel/Vienot/Mollon 1997 as simplified by Vienot 1999), `deltaE(a, b)` (CIEDE2000; the file header names the formula), `toLab`.
4. **`theme.tsx`**: `ThemeProvider({theme, children})`, `useTheme(): 'light' | 'dark'` (context value; when no provider is present, falls back to a module-level single `useThemeDetector()` that observes `document.documentElement` only for `data-theme` and listens once to `matchMedia('(prefers-color-scheme: dark)')`), `import './tokens.css'`. No storage writes: the host owns `backend-buddy:<project.key>:theme`.
5. **View edits, colour and theme only** (no behaviour, markup, or prop changes; RK-05):
    - `JoinMatrix.tsx`: delete `:103-111`; `const theme = useTheme()`; canvas colours from `MATRIX_COLORS[theme]` and `getComputedStyle` reads keep working but the hex fallbacks become token names (`var(--ink)` resolves in the artifact; when mounted standalone, `tokens.css` supplies them); `#fff` cell text becomes a token; SVG path attributes use `var(--x)` without literal fallbacks.
    - `LivingERD.tsx:195`: `colorMode={useTheme()}`; `LivingERD.css:22` extends the `--xy-*` overrides so React Flow controls, minimap, handles, edge labels, and selection follow tokens in both modes (RK-17 lists the light-tuned defaults).
    - `ColumnTable.css:13` -> `color-scheme: inherit`; `:37-46` map `--ct-family` to the palette variables; `:53` -> `var(--danger)`.
    - `SchemaDiff.css:1` base status colours become palette variables with light/dark values; remap pattern at `:30-33` kept.
    - `ArcDiagram.tsx`/`.css`, `Domains.tsx:11`, `Fanout.css:20`, `NormalizationLens.css:3`, shadows in `City.css`, `Domains.css`, `LivingERD.css`, `NormalizationLens.css`: tokens (`--arc-*`, `domainColor`, `--danger`, `--elevation-*`).
    - `City.tsx:174`, `:242`: `ROAD_COLORS[theme]`; `:333`: light values from tokens (`--city-light-sky`, `--city-light-ground` as data tokens); `City.css` fallbacks removed. `city-layout.ts:77` and `:194` are not edited (W05); they are allowlisted with the expiry note `W05`.
    - Every `var(--x, #hex)` fallback in the nine `.css` files becomes `var(--x)`.
6. **`scripts/check-hardcoded-colors.mjs`**: fails on any hex, `rgb(`, `hsl(`, or named CSS colour literal in `packages/explorer/src/**/*.{ts,tsx,css}` outside `tokens.css` and `palettes.ts`, except entries in `scripts/check-hardcoded-colors.allow` (path, literal, reason, expiry WP): `city-layout.ts` `COLORS` (W05), `LivingERD.tsx:169` export background read (not a literal, listed for clarity), and any SVG export inlining that must embed resolved colours. `npm run lint:colors`.
7. **`tokens.test.ts`** (node:test): (a) the 16 host variables in `tokens.css` equal `explorer.html:9-10` per theme; (b) text tokens: `--ink`, `--muted` on `--bg`, `--panel`, `--raised` contrast >= 4.5:1 in both themes (report any existing pair that fails as a finding, do not change the host values: see open question 1); (c) data tokens: every palette colour against `--bg` and `--panel` >= 3:1 in both themes; (d) pairwise `deltaE` >= 20 between the 12 domain hues under normal vision, deuteranopia, and protanopia, in both themes; (e) `domainColor` determinism and the stripe variant from the 13th domain; (f) on `many-domains.json` (14 domains) no two adjacent districts (sorted order) share hue and pattern; (g) `palettes.ts` exports equal the `tokens.css` values. `color-math.test.ts` with known reference pairs (for example white on black = 21:1).
8. **Documentation**: `docs/features/README.md` F21 row status stays `partial` (planned files now exist; W01 adds the toggle); F05, F07, F10 sections 3 and 14 (colour source changed); `docs/reference/limits-and-caps.md` A4 City palette row gains "values now in `tokens.css`/`palettes.ts`; call site swap in W05"; `CHANGELOG.md`.

### 4. Out of scope

- The `theme?: 'light' | 'dark'` field on `ViewProps` and `types.ts`: C03. Views read `useTheme()` in this package; C03/W01 wire the prop through the provider.
- Replacing `COLORS[index % COLORS.length]` at `city-layout.ts:194` with `domainColor`, district labels, roof stripes in the 3D scene, legend changes: W05 item 5.
- Theme toggle UI, `ThemeProvider` mounting in the SPA, reduced-motion handling, live region: W01. Host `explorer.html:53-56` stays as is (S01 owns the file).
- Any markup, aria, selector, or behaviour change in a view; any `.schema-city-*`, `.ct-*`, `.sd-*`, `.dm-*`, `.lerd-*` class rename.
- axe runs (S02 harness, W01 SPA) and visual regression (L-01).
- Domains view community naming or layout: W04/W06.
- Changing any of the 16 host variable values, even one that fails a contrast rule: requires an ADR (frozen contract). Report the failure.

### 5. May modify

```
packages/explorer/src/tokens.css, palettes.ts, color-math.ts, theme.tsx          (new)
packages/explorer/src/tokens.test.ts, color-math.test.ts, palettes.test.ts        (new)
packages/explorer/src/JoinMatrix.tsx, JoinMatrix.css
packages/explorer/src/LivingERD.tsx (line 195 and the useTheme import only), LivingERD.css
packages/explorer/src/ColumnTable.css
packages/explorer/src/SchemaDiff.css
packages/explorer/src/ArcDiagram.tsx (colour literals only), ArcDiagram.css
packages/explorer/src/Domains.tsx (line 11 palette only), Domains.css
packages/explorer/src/Fanout.css
packages/explorer/src/NormalizationLens.css
packages/explorer/src/City.tsx (lines 174, 242, 333 colour literals only), City.css
scripts/check-hardcoded-colors.mjs, scripts/check-hardcoded-colors.allow, scripts/check-hardcoded-colors.test.mjs   (new)
package.json                                      (script lint:colors only; no dependency)
docs/features/F05-living-erd.md, F07-column-table.md, F10-schema-diff.md   (sections 3 and 14)
docs/features/README.md                           (F21 row surfaces column only)
docs/reference/limits-and-caps.md                 (A4 City palette row note)
CHANGELOG.md                                      ([Unreleased], prefixed C02:)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package-lock.json, packages/explorer/package.json, packages/explorer/package-lock.json   no dependency
packages/explorer/src/types.ts          C03 (theme prop)
packages/explorer/src/index.tsx         C03 (mount policy; do not add the ThemeProvider here)
packages/explorer/src/city-layout.ts    W05 (COLORS at :77 and :194 allowlisted with expiry)
packages/explorer/src/column-logic.ts   COLUMN_FAMILIES is the binding key; palettes.ts imports it
packages/explorer/src/*.tsx             any line that is not a colour literal (Fanout.tsx, NormalizationLens.tsx, SchemaDiff.tsx, ColumnTable.tsx untouched)
packages/explorer/src/*-logic.ts, *.test.ts (existing)   unchanged; the 75 tests stay green
skill/assets/explorer.html              S01 / S03 (the host variables at :9-10 are copied, never edited)
skill/scripts/**, packages/explorer/server/**
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    S02 adds lint:colors to CI; list it as out of scope, found
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Host CSS variables: the 16 variables keep their values byte-identically in `tokens.css` | `explorer.html:9-10`; `limits-and-caps.md` C | `tokens.test.ts` (a) |
| Artifact CSP: no external stylesheet, font, or `url()`; `tokens.css` is bundled inline into `extensions.css` | `explorer.html:6`; ADR-0006 decision 5 | `verify_host.mjs` `externalRequests` empty (S02); `grep -c 'url(' packages/explorer/src/tokens.css` = 0 |
| Selector contracts: `.schema-city-*`, `.ct-family-<name>` classes, `.sd-status-*`, accessible names | frozen list; `ColumnTable.tsx:83`, `:187`; `SchemaDiff.css:30-33` | The six view suites (S02) and `verify_host.mjs` stay green with no selector edit in this package |
| `--ct-family` mechanism and `COLUMN_FAMILIES` binding (10 names in `column-logic.ts:5`) | `ColumnTable.css:37-46` | `tokens.test.ts` (g) asserts one palette entry per family name |
| Storage key `backend-buddy:<project.key>:theme` written by the host only | `explorer.html:39`, `:55-56` | `theme.tsx` contains no `localStorage` access (`grep -c localStorage packages/explorer/src/theme.tsx` = 0) |
| `ViewProps` unchanged in this package; views compile untouched apart from colour lines | `types.ts:10` | `npm run typecheck`; `git diff --stat` limited to the may-modify list |
| Unknown stays unknown: no colour encodes a fabricated count; unprofiled buildings keep baseline height (`city-layout.ts`) | C01 | `city-layout.test.ts` untouched and green |
| Flat accessible fallback remains available and legible in both themes (C16) | `City.tsx:224-262` | `verify_host.mjs` flat City checks in both themes (S02) |
| Profiler caps, `normalize()` oracle, route grammar | repository-wide list | Untouched |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, names prefixed `F21`/`CTQ-11` in node:test (`test('CTQ-11 tokens: host variables byte-identical', ...)`), green with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F05, F07, F10; F21 has no document yet, so the F21 registry row's surfaces column names the new files
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md` lines prefixed `- C02: `
- [ ] Release-note line in the PR body
- [ ] Security checklist (interim): no `url()`, `@import`, or external font in any CSS; no new dependency; `npm run guard` green
- [ ] Accessibility result recorded: the `tokens.test.ts` contrast and colour-difference table (every token pair, both themes, three vision conditions) pasted into the PR body; any host-variable pair below 4.5:1 reported as a finding for the Design and accessibility lead (not changed)
- [ ] Performance measurement: `extensions.css` and `extensions.js` gzip sizes before and after (`node scripts/size-budget.mjs` once S02 has landed; otherwise `gzip -c ... | wc -c`) recorded; no budget applies yet
- [ ] Caveat text: none added
- [ ] `npm run guard` green; no screenshots committed
- [ ] `npm run build` run and the mirror committed (`skill/assets/extensions/src` and `dist` follow)
- [ ] All changed paths inside the `may-modify` globs; every `.tsx` diff hunk touches only colour literals, the `useTheme` import, or the `colorMode` prop
- [ ] `npm run lint:colors` green with the allowlist containing only the entries listed in section 3 item 6

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order.

```sh
npm run restore
npm run guard
npm run typecheck
npm test                                                                        # 75 existing + new tokens/color-math/palettes tests
node --test --import tsx packages/explorer/src/tokens.test.ts packages/explorer/src/color-math.test.ts packages/explorer/src/palettes.test.ts 2>&1 | grep -c '^not ok'   # 0
npm run lint:colors                                                             # exit 0
grep -rho '#[0-9a-fA-F]\{3,8\}\b' packages/explorer/src --include='*.css' --include='*.tsx' --include='*.ts' --exclude=tokens.css --exclude=palettes.ts --exclude=city-layout.ts --exclude='*.test.ts' | wc -l   # 0
grep -c 'MutationObserver' packages/explorer/src/JoinMatrix.tsx                 # 0
grep -c 'colorMode=' packages/explorer/src/LivingERD.tsx                        # 1
grep -c 'color-scheme: light dark' packages/explorer/src/ColumnTable.css        # 0
grep -c 'url(' packages/explorer/src/tokens.css                                 # 0
grep -c 'localStorage' packages/explorer/src/theme.tsx                          # 0
npm run build
grep -c -- '--accent:#71d5c2' packages/explorer/dist/extensions.css              # >= 1 (tokens bundled into the artifact CSS)
git diff --stat main -- packages/explorer/src | grep -v 'tokens\|palettes\|color-math\|theme.tsx\|\.css\|JoinMatrix.tsx\|LivingERD.tsx\|ArcDiagram.tsx\|Domains.tsx\|City.tsx' | grep 'packages/explorer/src' | wc -l   # 0
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host-c02 --widths=1366,390   # after S02: theme loop green, axe serious/critical 0 on host views and flat City
```

Until S02 lands, the last command is replaced by a manual check recorded in the PR body: open `dist/backend-buddy.html`, switch the theme select to `Light`, visit all 13 tabs, and confirm every data encoding (City roads and districts in flat mode, Column Table swatches, Schema Diff statuses, Join Matrix cells, Arc colours, Domains swatches) is visible against the light background.

### 10. Reporting format

Per `agent-briefs/README.md` section 10. Measurements must include the contrast and deltaE table, hex-literal count before (`248` across `packages/explorer/src` at the commit in the status header, including 2 in test files) and after, and CSS/JS gzip sizes. "Out of scope, found" at minimum: CI step for `npm run lint:colors` (S02), `city-layout.ts:77`/`:194` swap (W05), any host-variable contrast failure (Design and accessibility lead, ADR needed).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-17 theme fallbacks wrong outside the host | Every fallback literal removed; `tokens.css` supplies the values wherever a view is mounted; light-mode legibility asserted by contrast tests and the manual/S02 theme loop |
| RK-05 remount and lifecycle assumptions | No lifecycle code touched; JoinMatrix's repaint trigger moves from an observer to `useTheme()` state, which re-renders on theme change exactly as the observer did |
| RK-04 strict SPA CSP | No inline `style` attributes added; tokens are class-based CSS so W01's strict policy is not made harder |
| RK-10 scope creep | Colour-only diffs in views; the City call-site swap is explicitly W05 |
| RK-22 duplicated source trees | `npm run build` after the change |
| RK-01 private-data leakage | Palette tests use `many-domains.json`; no screenshots committed |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). |

Open questions for the owner (needed before C02 starts):

1. If a host variable pair (for example `--muted #53646c` on `--raised #edf1f3` in light mode) measures below 4.5:1, the values are frozen and cannot change in this package. Decide whether `tokens.test.ts` treats such a pair as a failure (blocking G1 until an ADR changes the value) or as a recorded finding (this brief's default: record, do not fail).
2. Colour-difference formula: this brief specifies CIEDE2000 for the deltaE >= 20 rule. Confirm, or name CIE76.
3. Whether the semantic token names (`--danger --success --warning --focus-ring --elevation-* --selection --selection-soft --dim`) are final; W02/W04/W05 will depend on `--selection` and `--selection-soft` by name.
