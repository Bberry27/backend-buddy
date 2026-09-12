Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F01 Relational map

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | host view `map` (`skill/assets/explorer.html`, tab `#tab-map` at `:22`, renderer `renderMap` at `:155-176`); planned React `MapView` registered under `map` (W03); planned SPA route `/w/:ws/p/:project/s/:snapshot/map` (W01) |
| CTQs | CTQ-02, CTQ-03, CTQ-10, CTQ-11 |
| Caveats | C01, C07, C11 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The relational map is the orientation view for a schema snapshot: every table as a box, grouped into domain bands, with declared foreign keys drawn as solid edges and inferred references as dashed edges. A user answers "which tables exist, how are they grouped, and what does this table touch" and then hands off to the inspector or a detail view. It is a structural diagram of one snapshot; it is not an ERD with cardinality, not a live-database picture, and its association count is column pairs, not physical constraints.

## 2. Driver

- **Persona**: P1 architect (primary), P3 backend developer, P5 engineering manager (definitions in `docs/business/business-case.md`, D01).
- **Job to be done**: "Show me the whole schema at once, grouped the way the team thinks about it, so I can find a table and see what it is connected to without reading DDL."
- **Business metric**: to be validated (business case D01 in progress). Candidate: time to locate a table and its neighbourhood in a schema the user has not seen before.

## 3. Current state

Verified against `skill/assets/explorer.html` and `skill/scripts/build_explorer.py`. The map is one of four host views implemented in vanilla JS inside a single IIFE (`explorer.html:30-201`); the other three are F02, F03, F04.

**Layout and rendering**

- `renderMap(tables)` at `explorer.html:155-176` rebuilds the whole view into `#content` with `innerHTML` (`:158`) and then builds the SVG with `document.createElementNS`/`setAttribute`/`textContent` through the `el()` factory (`:162`). No schema text reaches an HTML parser in the SVG path.
- Deterministic grid layout, not force-directed: column count `Math.max(1, Math.floor((stage.clientWidth-48)/290))` (`:163`); node pitch 290 px, left gutter 24 px, node width 254 (`:165`); per-domain `rowHeight = Math.max(140, ...wrapName(t.id).length*16+76)` and node height `rowHeight-30` (`:165`); domains sorted alphabetically and tables sorted by id inside a domain (`:164-165`); domain label rows from `wrapName` (`:165`). `wrapName(name, max=29)` splits on `_` and hard-wraps 29-character chunks (`:134`).
- Edges are cubic curves between node centres with a per-index offset `(i%5)*3` to separate parallel edges; self-references draw a loop on the right side (`:169`). Class `edge` plus `inferred` for `kind !== 'declared FK'` and `active` when either endpoint is the selected table (`:169`); CSS `.edge.inferred{stroke-dasharray:5 4}` and `.edge.active{stroke:var(--accent)...}` at `:11`. Every edge has a `<title>` of `source.column->target.targetColumn (kind)` (`:169`, key at `:42`).
- Nodes are `<g class="graph-node" tabindex="0" role="button" aria-label="<id>, N columns" data-node="<id>">` (`:171`) with a left stripe coloured by entity type from the `colors` map at `:41` (five entity types to `--blue --orange --green --purple --red`; anything else falls back to `var(--accent)`), a `PK ...` line truncated at 34 characters, and a meta line `N columns | N associations` where associations = `outgoing(t).length + incoming(t).length` (`:171`), which counts link column pairs (C11).
- SVG `<title>` says `N entities and N visible relationships` (`:167`); root `aria-label` on the `<svg>` says solid lines are declared FKs and dashed lines inferred references (`:158`).
- Empty result renders the text `No entities match the filters` (`:172`).

**Interaction**

- Toolbar (`:158`): relationship-kind select (`all | declared FK | inferred by naming`, filter applied at `:157`), `Selected neighborhood` checkbox (`state.focus`; when on, nodes = selected table plus everything linked to it, `:156`), legend (FK solid, Inferred dashed), zoom out/in, fit, `Export map as SVG`.
- Zoom range 0.08..2 via buttons (`:160`) and Ctrl/Cmd+wheel (`:175`); `zoom()` scales the SVG element and re-centres scroll (`:177`); `fit` computes the scale from `#stage` client size and `graphSize` (`:160`).
- Pan: `bindMapPan(stage)` at `:135-154`. Pointer-down records the origin; movement under 4 px is ignored (`:146`); beyond that the stage takes pointer capture, scrolls, and sets `suppressClick` (`:147-148`); a capture-phase `click` listener swallows the click that ends a drag (`:153`). `touch-action:none` and `user-select:none` are set on the stage (`:137`). The executable spec for this is `skill/scripts/check_map_pan.cjs` (drag from empty space and from a node must pan and must not open the inspector; a plain click must open it).
- Node click calls `selectTable(id)` and restores the stage scroll position afterwards (`:171`); Enter and Space trigger the same handler (`:171`). `selectTable` (`:63`) opens the inspector and, when the map is active, re-renders the whole map.
- Inspector button `Relationships` calls `openNeighborhood(t.id)` (`:72`, wired at `:78`), which clears the three global filters, sets `focus=true`, resets zoom, and switches to the map.
- Resize: a `ResizeObserver` on `#workspace` re-renders the map after a 100 ms debounce (`:200`). Toggling the inspector re-renders the map (`:62`).
- Global filters (search, domain, entity type at `:23`) apply through `scoped()` (`:60`) and re-render on every `input` event (`:68`) with no debounce.

**Export**

- `exportSVG()` at `:182` clones the live `<svg>`, inlines the computed `fill stroke stroke-width stroke-dasharray opacity font-family font-size font-weight` of every element, sets the background from `--bg`, and downloads `<project.key>-relational-map.svg` through `download()` (`:179`, Blob object URL and a synthetic anchor).
- The header export button (`#export`, `:21`) exports the visible links as CSV with columns `source_table source_column target_table target_column evidence` (`exportRows` at `:173`, encoder at `:180`).

**State and persistence**

- Map state (`zoom`, `focus`, `linkKind`) lives in the in-memory `state` object (`:37`) and is reset on reload and by the `Reset filters` button (`:69`). Nothing about the map is in the URL. Only theme and review decisions persist (`backend-buddy:<project.key>:theme` and `:reviews`, prefix at `:39`).

**Defects and gaps (current state)**

- Full re-layout and DOM rebuild of the map on every filter keystroke (`:68` -> `render()` at `:178` -> `renderMap`); no debounce; not covered by any timing test.
- `render()` at `:178` calls `window.BackendBuddyViews?.unmount()` unconditionally on every render, even when the active view is a host view; when a React view is active this tears down and recreates the React root (`packages/explorer/src/index.tsx:22` always calls `unmount()` then `createRoot`).
- `colors[n.t.type]` at `:171` is a prototype-chain lookup on a plain object; a table `type` of `constructor` or `toString` yields a function whose source is stringified into the stripe's `stroke` attribute (broken stripe, not an injection). S01 replaces it with `Object.hasOwn`.
- The five entity-type stripe colours have no legend on the map; the legend at `:158` explains only edge styles. Custom or `Unclassified` types fall back to the accent colour, which is also the selection colour.
- No inbound selection API: the map only reads the host's `state.selected`; there is no `data-selected` attribute (the selected node has CSS class `selected`, `:171`), no scroll-to-selection, and no column or relationship selection.
- Export button hidden at widths <= 700 px (`.top-actions>.iconbtn{display:none}` at `:14`); the map's own `Export map as SVG` button remains.
- The map encodes no row counts today, so C01 has nothing to show yet (see section 7).

## 4. Intended behaviour

### MVP

- **B1** `MapView` (React, `packages/explorer/src/MapView.tsx`) replaces `renderMap` and registers under the view id `map` (W03). The layout is lifted into a pure module `map-layout.ts` with the current constants (290 px pitch, 48 px total gutter, node width 254, `rowHeight = max(140, lines*16+76)`, `wrapName` max 29) so that positions are identical to the host for the same input and viewport width, and unit-tested.
- **B2** Pan and click separation is preserved in a hook `useMapPan.ts` with the same contract as `bindMapPan`: 4 px threshold, pointer capture, capture-phase click swallow, `touch-action:none` (CTQ-03). `skill/scripts/check_map_pan.cjs` is converted to `tests/e2e/views/map.spec.ts` (S02) and stays green against the React view.
- **B3** Filter changes update props on the mounted view; the React root is not recreated (`__backend-buddyMounts` constant over 20 filter keystrokes, CTQ-10). Layout recomputation is memoised on `(visible table ids, viewport width)`.
- **B4** Inbound selection: the map honours `selected.tableId` (highlight class `is-selected`, attribute `data-selected="true"` on the node group, `active` edges) and `selected.relationshipRef` (highlight one edge). On a selection change originating elsewhere it scrolls the node into view once; a selection originating from a click on the map does not move the viewport (today's behaviour at `:171`).
- **B5** Outbound: node click -> `onSelectTable(id)`; edge click -> `onSelectRelationship(ref)` (new, edges get a wider invisible hit path and `tabindex`); node context menu (right-click, Shift+F10) -> `onNavigate` targets from the registry (W02/W04).
- **B6** Zoom, fit, Ctrl/Cmd+wheel, relationship-kind filter, and `Selected neighborhood` keep today's semantics; zoom, neighbourhood focus, and the relationship-kind filter are URL state (`v.zoom`, `v.focus`, `v.link`; section 5).
- **B7** SVG export is lifted into `svg-export.ts` (computed-style inlining as at `:182`) and CSV export into `csv.ts` with the S01-hardened cell guard (leading whitespace then `= + - @ \t \r`). Export remains reachable at 390 px width (a toolbar action inside the view, not only in the hidden header button).
- **B8** Entity-type legend: the five entity-type colours are shown in the map legend with their labels; unknown types use a neutral colour that is not the selection colour (C02 tokens).
- **B9** Empty, single-table, no-link, and `hostile` fixtures render without error; hostile identifiers appear as text only.

### Later

- **B10** Map node -> Schema City fly-to (drill-through registry "Later"; L-02/W05 follow-up).
- **B11** Optional row-count badge per node once `rowCount` is present; unknown counts show `unknown`, never blank or `0` (C01, CTQ-01).
- **B12** Alternative layout (force or cluster) as an option, keeping the deterministic grid as default (open question 3).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005, D02). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03. Today the map is a registry target of P1 (Inspector -> Map neighbourhood).

### Inbound

- Honours `selected.tableId` (B4): `data-selected="true"` and `is-selected` on the node group, `active` on incident edges; scroll-into-view once per selection change when the origin is not the map.
- Honours `selected.relationshipRef` (`constraintId` else `source.column>target.targetColumn`): highlights the matching edge(s); for a composite FK all pairs sharing the `constraintId` highlight together (C11).
- Multi-select (`ts`) highlights each listed table; no dimming of the others (the map is an overview).

### Outbound

- `onSelectTable(id)` on node click, Enter, Space (today `:171`).
- `onSelectRelationship(ref)` on edge click (B5).
- `onNavigate(target)` from the node context menu: Fan-out (root = t), Living ERD (focus t), City (fly-to t), Column Table (t), Keys (t), Review (findings of t).
- Rule: a drill-through may prefill a live query but never runs it without a click. The map has no live query.

### URL state

- Reads and writes shared keys `t` (selected table), `r` (relationship), `ts` (multi-select), `q d k` (search, domain, entity type; the host's three global filters).
- Registers view-local keys `v.zoom` (number, 0.08..2), `v.focus` (`1` when `Selected neighborhood` is on), `v.link` (`declared` | `inferred`; absent means all kinds). These are exactly the `map` allowlist names in `docs/architecture/drill-through-contract.md` section 4 (`zoom`, `focus`, `link`); adding or renaming one needs a registry change and an update to this section in the same PR. Values capped at 200 characters and allowlisted per `route-state.ts` (C03).
- Not in the URL: stage scroll offsets (pan position). They live in the per-view `viewState` slice keyed by graph fingerprint.

## 6. Data contract dependencies

Fields read (from `packages/explorer/src/types.ts` today; `packages/contract/schema-graph.v1.json` after C01):

| Field | Required | Behaviour when absent |
|---|---|---|
| `tables[].id`, `domain`, `type`, `allColumns[]`, `pk` | yes (defaults from `normalize()` at `build_explorer.py:37`) | `domain`/`type` default `Unclassified`; `pk` shows `PK not recorded` |
| `links[].source`, `target`, `kind`, `column`, `targetColumn` | yes | link dropped from the drawing when either endpoint is not visible (`:169`) |
| `links[].constraintId` | optional | pairs highlighted individually instead of as one constraint |
| `tables[].rowCount` | optional | not used today (B11 later) |
| `project.key` | yes | storage prefix and export file names |

No `LiveConnection` method is used.

## 7. Caveats

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: edge style (solid vs dashed, `explorer.html:11`, `:169`), legend (`:158`), SVG `aria-label` (`:158`), edge `<title>` with the `kind` (`:169`), CSV `evidence` column (`:173`), relationship-kind filter labels (`:158`).

> C11: "A composite foreign key is one constraint and counts once wherever constraints are counted (matrix cells, community edges, cardinality). The relational map's association count is column pairs, not physical FK constraints. Every surface states which of the two it counts."
> Shown: node meta line `N columns | N associations` (`:171`) and the SVG title `N visible relationships` (`:167`) count column pairs; the MVP legend adds the words "column pairs" next to the count (B8) and the composite-FK highlight groups pairs by `constraintId` (B4).

> C01: "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."
> Shown: nothing today; the map encodes no counts. Applies to B11 (row-count badge) if it is built. See open question 1.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-02) Given the medium fixture at 1920, 1366, and 390 px in light and dark themes with the inspector open and closed, When the map renders, Then the document does not scroll horizontally, every node label stays inside its box, and node positions equal `map-layout.ts` output for that width.
- **AC2** (B2, CTQ-03) Given the map zoomed in twice, When the pointer drags 120 px from empty stage space and from a node, Then the stage scrolls and the inspector does not open; When a node is clicked without movement, Then the inspector opens with that table.
- **AC3** (B3, CTQ-10) Given the map mounted, When 20 characters are typed into the search box, Then `__backend-buddyMounts` is unchanged and the visible node count matches `scoped()` semantics.
- **AC4** (B4, CTQ-10) Given `?t=<id>` in the URL, When the map route loads, Then the node has `data-selected="true"` and is inside the visible stage area.
- **AC5** (B5, CTQ-10) Given a declared FK edge, When it is clicked, Then `onSelectRelationship` receives the `constraintId` (or `source.column>target.targetColumn`) and the inspector shows the relationship.
- **AC6** (B7, CTQ-02) Given the map, When `Export map as SVG` and CSV export are used at 1366 and 390 px, Then both downloads are non-empty and the CSV cells that start with `=`, `+`, `-`, `@`, tab, or CR (after optional whitespace) are prefixed with `'`.
- **AC7** (B9, CTQ-07) Given the `hostile` fixture, When the map renders, Then no dialog opens, no element outside the SVG is created from schema text, and the CSP reports zero violations.
- **AC8** (B1, CTQ-11) Given the map in both themes at 1366 and 390 px, When axe runs, Then there are zero serious or critical findings; every node is reachable with Tab and activates with Enter and Space.

## 9. Test expectations

- Unit (node:test, `packages/explorer`): `map-layout.test.ts` (positions for 1, 2, many tables; domain banding; `wrapName` cases including long names and names without `_`), `svg-export.test.ts`, `csv.test.ts` (formula-guard vectors). Test names prefixed `F01`.
- Component (Vitest, `packages/web`): `MapView` renders nodes and edges from `fixtures/schemas/small.json`; selection prop toggles `data-selected`; no remount on prop change.
- e2e (`tests/e2e/views/map.spec.ts`, converted from `skill/scripts/check_map_pan.cjs`): pan/click separation at 1366 and 390; zoom and fit; neighbourhood focus; exports.
- a11y (`tests/a11y`): axe on the map route in both themes; keyboard journey "Tab to a node, Enter, inspector shows table".
- Security (`tests/security/artifact.spec.ts`, S01): `hostile` fixture through the map in the artifact.
- Fixtures: `small`, `medium`, `edge-cases` (self-reference, table without PK, long identifiers), `hostile`, `empty`.

## 10. Security and privacy

- Inputs: the SchemaGraph only. The SVG path uses `createElementNS`/`textContent` (`:162`), so identifiers cannot inject markup; the toolbar `innerHTML` at `:158` interpolates only internal constants. The React port renders text as children, removing the `E()` discipline dependency entirely.
- `colors[n.t.type]` prototype-chain lookup (`:171`) is fixed by S01 (`Object.hasOwn`).
- Storage: none specific to the map. URL state values are allowlisted and capped (C03).
- Exports: SVG contains identifiers and the theme colours; CSV contains the visible links. No `sampleValues` or statistics are in these exports. CSV cells are guarded (B7).
- CTQ-07 checks that apply: hostile-fixture render, SPA CSP-violation count = 0 on the map route, artifact CSP byte-identical (CTQ-05 through F22).

## 11. Performance budget

- View TTI on the medium fixture <= 1.5 s (`docs/reference/limits-and-caps.md` section B, Q01).
- The map ships in the SPA shell chunk (<= 350 KB gzipped for the shell); it has no heavy dependency.
- Own caps: zoom clamped 0.08..2 (`:160`, `:175`); resize re-layout debounced 100 ms (`:200`). MVP adds memoised layout keyed on visible ids and width (B3). No node cap exists today; a large-fixture (`fixtures/schemas/large.json`) render time is recorded as a baseline in `docs/qa/perf-baselines.md` (Q01) rather than budgeted at MVP.

## 12. Accessibility

- Every node is a focusable `role="button"` with an `aria-label` of id and column count (`:171`), activated by Enter or Space. Edges are not keyboard-reachable today; B5 adds focusable edge hit paths with a `<title>`.
- The `<svg>` has `role="img"` and an `aria-label` describing the line conventions (`:158`).
- Colour independence: declared vs inferred is encoded by dash pattern, not colour (`:11`); entity type is colour plus the type text in the inspector and B8 legend.
- Reduced motion: no animation exists; scroll-into-view (B4) uses instant scrolling under `prefers-reduced-motion`.
- The map is an SVG in the DOM (not canvas), so C16 does not require a separate flat alternative.
- axe coverage: SPA map route x 2 themes x 1366/390 and the artifact host view (CTQ-11).

## 13. Open questions

1. Registry lists C01 for F01, but the map encodes no counts today. Keep C01 for B11 or remove it from the F01 registry row? Owner: Product owner. By G0.
2. Should edges become selectable (B5) at MVP, or is relationship selection only through the inspector and Living ERD? Owner: Frontend lead. By W03 brief.
3. Keep the deterministic domain grid as the only layout at MVP (plan) or add a force layout option later (B12)? Owner: Product owner. By G2 roadmap review.
4. Closed (D05 review): the relationship-kind filter is URL state. `docs/architecture/drill-through-contract.md` section 4 freezes the `map` allowlist as `zoom`, `focus`, `link`, and section 5 of this document uses the same names. Any later change goes through the contract's registry-change rule.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Current host view | `skill/assets/explorer.html:155-176` (`renderMap`), `:135-154` (`bindMapPan`), `:134` (`wrapName`), `:177` (`zoom`), `:182` (`exportSVG`), `:180` (`exportCSV`), CSS `:11` |
| Planned view | `packages/explorer/src/MapView.tsx` (W03) |
| Planned logic | `packages/explorer/src/map-layout.ts`, `useMapPan.ts`, `svg-export.ts`, `csv.ts` (W03) |
| Contract | `packages/explorer/src/types.ts`; `packages/contract/schema-graph.v1.json` (C01) |
| Tests | `skill/scripts/check_map_pan.cjs` (today); `tests/e2e/views/map.spec.ts`, `packages/explorer/src/map-layout.test.ts` (S02/W03) |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-07 | - | D05 | Initial document from the pre-repo code. |
| 2026-09-07 | - | D05 | Review fixes: URL key `v.kind` renamed to `v.link` to match the drill-through contract `map` allowlist (B6, section 5); open question 4 closed. |
