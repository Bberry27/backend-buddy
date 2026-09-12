Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-W05 Schema City MVP

| Field | Value |
|---|---|
| Work package | W05 (track W, phase 2) |
| Features | F08 (primary); F14 (P3 fly-to, inbound selection), F21 (palette consumer) |
| CTQs | CTQ-01, CTQ-02, CTQ-03, CTQ-04, CTQ-09, CTQ-10, CTQ-11 |
| Caveats | C01, C02, C03, C13, C16 (quoted only through `caveat-strings.ts`) |
| Depends on | C02, C03, W04 |
| Blocks | Q01, Q04 |
| Branch | `f08/city-mvp` |
| Gate | G2 |

### 1. Goal

Complete Schema City as the orientation view for large schemas: districts are domains (declared or discovered), footprint is column count, height is log row count, roads are FKs. It answers "where is the mass, what is unprofiled, what crosses domain boundaries" and hands the user to detail views. Deliver the nine MVP items B1-B9 below in `City.tsx`, `city-layout.ts`, and `City.css`, never fabricating counts, keeping the flat accessible mode, and staying readable on the medium fixture (1,000+ table performance is L-02). A verifier can check each B-item's Given/When/Then in `tests/e2e/city.spec.ts`, `city-layout.test.ts`, and `verify_host.mjs`.

### 2. Reading list (ordered)

1. `docs/features/F08-schema-city.md` (D05, fully worked for G0): sections 3 (current state with line pointers), 4 (B-numbered behaviours; the ids below must match it), 5 (inbound `t`, `ts`, `d`; `v.mode`, `v.districts`; outbound `onSelectTable`, `onSelectRelationship`, `onNavigate`), 7 (C01, C02, C03, C13, C16 quotes), 8-12.
2. `docs/architecture/drill-through-contract.md` sections 4 (`city: mode, districts`), 5 (camera pose in the persisted slice, not the URL), 6 (P3, P6), 7 (inbound rules; rule 5 names `City.tsx:309`).
3. `docs/architecture/adr/ADR-0004-selection-and-routing-contract.md`; `ADR-0008-testing-strategy.md` (swiftshader, `--use-gl=disabled` fallback test).
4. `docs/reference/caveats.md` C01, C02, C03, C13, C16; `docs/reference/limits-and-caps.md` A4 (palette 7 at `city-layout.ts:77`, `:194`; layout tested to 600 tables at `city-layout.test.ts:20`) and B (City chunk <= 700 KB; median frame <= 66 ms; `layoutCity(large)` <= 400 ms).
5. Existing code, the exact functions to reuse: `packages/explorer/src/city-layout.ts:32` `placeCityLabels` (gains `kind`), `:77` `COLORS` (replaced), `:82` `cityRowCount`, `:86` `cityTableLabel`, `:175` `layoutCity`, `:194` `COLORS[index % COLORS.length]`; `City.tsx:69-70` `webglcontextlost` handling (triple WebGL guard), `:107` `useFrame`, `:119` and `:221` label placement calls, `:141` and `:174` `setColorAt` (hover swap site), `:181` `raycast={() => {}}` on the road instanced mesh (B6 removes it), `:186` `FlatCity`, `:223` `.schema-city-flat`, `:309` `useEffect(() => { setHovered(null); setSelected(null); }, [layout])` (B9 narrows it), `:313-328` toolbar, `3D city`/`Flat map`/`Fit city` controls and the `role=status` empty state, `:343` tooltip, `:348-355` legend strings (C01, C02 wording today; replaced by `caveat-strings.ts`), `:349` failure status; `index.tsx:19` `CityDistricts` select (moves into City, B8).
6. Live profile pattern to copy for B1: `packages/explorer/src/NormalizationLens.tsx:111-127` (`live.profile`, `AbortController`, request token, `maxRowsPerTable`, button disabled without `live?.profile`).
7. C02 deliverables: `palettes.ts` (`domainColor(domainId, allDomainIds, theme)`, >= 12 hues, stripe variant beyond), `tokens.css` (`--selection`, `--selection-soft`), `theme.tsx` (`useTheme`); C03 deliverables (`selection.ts`, `view-state.ts`, `caveat-strings.ts`).
8. `scripts/verify_host.mjs`: the existing City checks (`cityDragCheck`, canvas non-blank, context-loss simulation at 390 px, `.schema-city-*` selectors) and the swiftshader flags at `:40`.
9. `docs/engineering/accessibility-standards.md` (combobox pattern, drawer keyboard model, reduced motion), `standards.md`, `testing-policy.md` (D03).

### 3. In scope

The Schema City MVP list, embedded from the approved plan, with acceptance criteria. Ids B1-B9 are the F08 feature-document ids; if D05 numbers them differently the feature document wins and this table is corrected in the same PR.

| Id | Item | Acceptance criteria (Given / When / Then) | CTQ |
|---|---|---|---|
| B1 | **Unknown-rows banner + profile action.** When every building has `rowCount === null`, show a `role=status` banner "Row counts unknown: all buildings use baseline height" with a "Profile visible tables" button enabled only when `live?.profile` exists (AbortController, cap shown). Heights update without remount; legend shows "sampled". | Given `fixtures/schemas/medium.json` (no counts) and no `live`, When City mounts, Then the banner is present with `role=status` and the button is disabled with a reason. Given a `live.profile` stub, When the button is clicked, Then one `live.profile` call is made with the visible table ids and the configured cap, `__backend-buddyMounts` is unchanged, heights of returned tables change, and the legend contains "sampled". Given the stub returns a table without `rowCount`, Then that building keeps baseline height and `data-rowcount="unknown"`. | CTQ-01, CTQ-10, CTQ-08 |
| B2 | **Search / focus-on-table.** `role=combobox` with accessible name `Search tables` over `id`, `name`, `className`; Enter selects and flies to the building within 600 ms (instant under reduced motion); flat mode pans. | Given the medium fixture, When the user types a table id and presses Enter, Then `onSelectTable(id)` is called, the building carries `data-selected="true"` and the camera reaches the target within 600 ms (asserted by a scripted `useFrame` counter or timestamp). Given `prefers-reduced-motion: reduce`, Then the camera pose is final on the next frame. Given flat mode, Then the SVG viewport pans so the rect is in view. | CTQ-03, CTQ-11 |
| B3 | **Inbound selection + highlight + fly-to.** `selected.tableId` drives label priority plus an outline mesh (`--selection`, `depthTest:false`); hovered building gets `--selection-soft` via `setColorAt` swap; eased camera move in `useFrame`. `.schema-city [data-selected="true"]` present; flat rect has `is-selected`. | Given `?t=<id>` from another view, When City renders, Then exactly one `.schema-city [data-selected="true"]` exists, its label has priority, the outline mesh is visible, and the camera moves once (no re-centre on a filter keystroke). Given flat mode, Then the rect has class `is-selected`. Given `selected.origin === 'city'`, Then no dimming is applied. | CTQ-10, CTQ-02 |
| B4 | **District labels in scene.** `placeCityLabels` gains `kind: 'district' | 'table'`; districts are placed first; every district is visible at the fit camera on the small and medium fixtures. | Given the small and medium fixtures, When the city is at fit camera, Then the number of visible `.schema-city-name[data-kind="district"]` equals `layout.districts.length`; `city-layout.test.ts` asserts districts are placed before tables and never dropped. | CTQ-02, CTQ-11 |
| B5 | **Palette >= 12, colour-vision-safe, deterministic, light/dark.** Replace `COLORS[index % 7]` (`city-layout.ts:77`, `:194`) with `domainColor(...)`; beyond 12 hues use a roof-stripe variant mirrored in the legend; no two adjacent districts share hue+pattern on the many-domains fixture. | Given `fixtures/schemas/many-domains.json`, When the layout is computed, Then no two districts sharing an edge have the same `(hue, pattern)`; colours are identical across two runs; light and dark themes produce different values from `tokens.css`; `tokens.test.ts` contrast and CVD checks (C02) pass for the City palette. | CTQ-11, CTQ-02 |
| B6 | **Inspectable roads.** Enable raycast with a wider invisible hit mesh; tooltip "<child> -> <parent> · declared FK · width ≈ child/parent row ratio (volume proxy, not measured cardinality)" or "ratio unknown"; click -> `onSelectRelationship`; flat paths get the same title and click. | Given the medium fixture, When a road is hovered, Then a `role=status` tooltip shows the endpoints, `kind`, and either the ratio with the C02 string or "ratio unknown" (both counts unknown). When clicked (3D and flat), Then `onSelectRelationship(ref)` is called with `constraintId` else `source.column>target.targetColumn`. `raycast={() => {}}` no longer appears in `City.tsx`. | CTQ-03, CTQ-10, CTQ-01 |
| B7 | **Keyboard table-list drawer** in 3D mode so every building is reachable; flat mode remains the AA path. | Given 3D mode, When the user opens the drawer (button and keyboard shortcut documented in the feature doc), Then every visible table appears as a focusable item; Enter selects and flies; Escape closes and restores focus. Axe reports 0 serious/critical with the drawer open at 1366 and 390. | CTQ-11 |
| B8 | **View state.** 3D/flat mode and district grouping (move the `CityDistricts` select from `index.tsx:19` into City) persisted per snapshot via `viewState` (`v.mode`, `v.districts`); camera persisted in localStorage under the C13 key family. | Given `?v.mode=flat&v.districts=discovered`, When City mounts, Then flat mode and discovered districts are active and the C03 string is shown in the legend. When the camera moves, Then a write occurs only to `backend-buddy:view-state:v1:<project.key>:<fingerprint>:city`; a different `project.key` reads no camera. Reload restores mode, grouping, and camera. | CTQ-10, CTQ-07 |
| B9 | **No remount on filter change**; selection no longer cleared at `City.tsx:309` when only filters change. | Given a selected building, When 20 filter keystrokes narrow and widen the graph while the selected table stays present, Then `__backend-buddyMounts` is unchanged and `[data-selected="true"]` persists. When the selected table leaves the graph, Then the "selected item is filtered out" notice appears (rule 4) and selection is cleared only then. | CTQ-10 |

Also in scope:
- `tests/e2e/city.spec.ts` (from the S02-converted `city-browser` suite) extended with the cases above, `CTQ-04 canvas non-blank`, `CTQ-04 flat fallback under --use-gl=disabled`, and `CTQ-03 city 3d drag does not inspect` / `city flat drag does not inspect`.
- `city-layout.test.ts` cases for B4, B5, deterministic colours, and `CTQ-01` baseline height for `rowCount: null` preserved.
- `scripts/verify_host.mjs` City checks kept green (selector names may only be added, not renamed).
- F08 sections 3 and 14; F14 section 14 row (P3 fly-to complete); `docs/reference/limits-and-caps.md` A4 row for the palette updated from 7 to the new mechanism in the same PR (rule in that file).

### 4. Out of scope

- L-02: in-view filter chips that dim instead of re-layout, minimap and compass, grid-based picker (`city-picking.ts`), label budget and LOD for 1,000+ tables, keyboard camera, PNG/SVG export with caveat footer, `rowCountLowerBound` as hatched height, `kind:'view'` glass material, discovered-community naming.
- Performance baselines and the 60-frame orbit harness (Q01); W05 records one manual median-frame measurement on the medium fixture under swiftshader as the pre-baseline number.
- Palette implementation (`palettes.ts`, `color-math.ts`) and tokens (C02): consumed, not edited.
- Registry or route changes (C03); inspector and context-menu components (W02); inbound/outbound plumbing shared with the other views (W04).
- Server-side camera persistence (`data-model.md` open question 5) stays client-side at MVP.

### 5. May modify

```
packages/explorer/src/City.tsx
packages/explorer/src/City.css
packages/explorer/src/city-layout.ts
packages/explorer/src/city-layout.test.ts
packages/explorer/src/index.tsx                  (remove the CityDistricts wrapper; the `city` map entry points at City)
tests/e2e/city.spec.ts
tests/a11y/keyboard-journeys.spec.ts             (complete the 'inspector -> city' journey)
scripts/verify_host.mjs                          (City selector additions only)
docs/features/F08-schema-city.md                 (sections 3 and 14 only)
docs/features/F14-drill-through-navigation.md   (section 14 only)
docs/reference/limits-and-caps.md                (A4 Schema City palette row only)
CHANGELOG.md                                     ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change (no BVH or picking library at MVP)
packages/explorer/src/types.ts          C01/C03 only
packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts   C03; read-only
packages/explorer/src/{tokens.css,palettes.ts,color-math.ts,theme.tsx}   C02; read-only
packages/explorer/src/{LivingERD,Fanout,ColumnTable,NormalizationLens,Domains,JoinMatrix,ArcDiagram,SchemaDiff}.tsx   W04
skill/assets/explorer.html              S01, S03, W03 only
skill/scripts/build_explorer.py         S01 only
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Selector contract `.schema-city-*` family (`schema-city-name`, `-name-priority`, `-unprofiled-mark`, `-name-count`, `-names`, `-flat`, `-target`, `-toolbar`, `-summary`, `-controls`, `-scene`, `-empty`, `-tooltip`, `-legend`, `-failure`, `-road-key`), `data-selected="true"`, `is-selected` on the flat rect, `data-rowcount` `unknown|0|<n>`; accessible names `Search tables`, `3D city`, `Flat map`, `Fit city`, `Inspect table <name>` | `City.tsx:80-354`; `drill-through-contract.md` section 7; `agent-briefs/README.md` | `scripts/verify_host.mjs`, `tests/e2e/city.spec.ts` |
| Unknown stays unknown: `rowCount: null` keeps baseline height and the unprofiled mark; profiling results without `rowCount` never write a count | C01, CTQ-01 | `city-layout.test.ts` `CTQ-01` cases; `tests/e2e/rowcount.spec.ts` |
| Flat accessible fallback remains available, uses the same layout, entered on WebGL failure or loss | C16, CTQ-04 | `CTQ-04 flat fallback under --use-gl=disabled` |
| Road width is a volume proxy, not measured cardinality | C02 | tooltip text equals `caveat-strings.ts` C02 |
| Discovered districts are analytical suggestions | C03 | legend text equals `caveat-strings.ts` C03 |
| `v.*` allowlist for `city`: `mode`, `districts` only; camera is never URL state | `drill-through-contract.md` sections 4-5 | `route-state.test.ts` |
| Storage key `backend-buddy:view-state:v1:<project.key>:<fingerprint>:city`; never unscoped | C13; `view-state.ts` | `view-state.test.ts`; storage-isolation e2e (Q02) |
| `layoutCity` output for tables and districts (positions, footprints, heights) unchanged for existing fixtures except district colour | `city-layout.test.ts` today (1, 2, 12, 120, 600 tables) | existing cases stay green |
| Host CSS variables and the artifact CSP untouched | D9, C02 | `tokens.test.ts`, `tests/security/artifact.spec.ts` |
| Budgets: City chunk <= 700 KB; median frame <= 66 ms (60-frame orbit, medium, swiftshader); `layoutCity(large)` <= 400 ms | `limits-and-caps.md` B | `size-budget.mjs`; Q01 harness (W05 records the manual number) |
| No remount; prop updates only | `mount-policy.ts` (C03) | `CTQ-10 no remount over 20 keystrokes` |
| Prefill, never execute: "Profile visible tables" is the only path to `live.profile` | C14, CTQ-06 | `tests/e2e/drill-through.spec.ts` (P3, P6 arrival makes no request) |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `F08`/CTQ ids and `B#`, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F08; F14 section 14 row)
- [ ] Migration: none, because camera and mode persistence stay client-side at MVP
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (no new network paths; tooltip and labels render schema text as React children; view-state values bounds-checked before use)
- [ ] Accessibility result recorded (axe 0 serious/critical in 3D with drawer open/closed and in flat mode, 2 themes x 1366/390; keyboard journey inspector -> city -> select via drawer; reduced-motion check)
- [ ] Performance measurement recorded: City chunk size; `layoutCity` on `large.json` (generated locally with `--large`) in ms; manual median frame over 60 frames on the medium fixture under swiftshader
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts` (C01, C02, C03, C13, C16)
- [ ] `npm run guard` green; no screenshots other than synthetic fixtures
- [ ] `npm run build` run and the mirror committed
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `limits-and-caps.md` A4 palette row updated in the same PR
- [ ] Package-specific: `grep -c 'raycast={() => {}}' packages/explorer/src/City.tsx` equals 0

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test                                                  # city-layout.test.ts incl. B4/B5/CTQ-01 cases; existing 600-table case
npm run build
git diff --exit-code skill/assets/extensions
node scripts/size-budget.mjs                              # City chunk <= 700 KB
node scripts/verify_host.mjs dist/backend-buddy.html <out> --widths=1920,1366,390     # City checks, flat fallback at 390, externalRequests: []
npx playwright test tests/e2e/city.spec.ts                # B1-B9, CTQ-03 drags, CTQ-04 canvas and fallback
npx playwright test tests/e2e/drill-through.spec.ts -g "P3|P6"
npx playwright test tests/e2e/shell.spec.ts -g "city"     # CTQ-10 no remount
npx playwright test tests/a11y/routes.spec.ts -g "city" tests/a11y/keyboard-journeys.spec.ts -g "inspector -> city"
node scripts/generate-fixtures.mjs --large && node --test packages/explorer/src/city-layout.perf.test.ts   # if Q01 has landed; else record the manual number
grep -c 'raycast={() => {}}' packages/explorer/src/City.tsx      # expected: 0
```

Package-specific assertions: on `medium.json` every `[data-rowcount]` inside `.schema-city` equals `unknown`; on `medium-measured.json` at least one equals `0` and at least one is a positive integer; on `many-domains.json` the legend has as many swatches as districts and no adjacent pair shares hue+pattern.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include a B1-B9 table with the test name proving each item.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-05 remount lifecycle | Narrow `City.tsx:309` to "selected table left the graph"; component test for layout change with a persisting selection. |
| RK-07 swiftshader flakiness | Frame numbers are recorded as measurements, not asserted, until Q01 baselines exist; pixel checks use the calibrated threshold from `verify_host.mjs`. |
| RK-17 theme fallbacks | All scene and legend colours come from `domainColor` and tokens; `check-hardcoded-colors.mjs` green (the SVG export allowlist does not apply here). |
| RK-10 scope creep | L-02 items (minimap, LOD, picker library, export) are refused; report them. |
| RK-14 sensitive values | The City never shows sample values; the B1 profile request uses the documented cap and shows it. |
| RK-19 storage origin split | Camera stored under the fingerprinted key only; loss of camera is convenience state (C13 string in the legend). |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
