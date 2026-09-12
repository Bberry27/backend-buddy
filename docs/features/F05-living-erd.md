Status: draft | Owner: Frontend lead | Last verified against code: 2026-09-08

# F05 Living ERD

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | view `living` (`packages/explorer/src/index.tsx:22` component map; `LivingERD.tsx`, React Flow); host tab `living` (`skill/assets/explorer.html:22`); planned SPA route `/w/:ws/p/:project/s/:snapshot/living` (W01) |
| CTQs | CTQ-02, CTQ-03, CTQ-09, CTQ-10, CTQ-11 |
| Caveats | C01, C07, C10, C13 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The Living ERD is the interactive entity-relationship diagram: tables as draggable cards, declared and inferred relationships as crow's-foot edges, N:M junctions collapsed into one edge when key evidence allows, and a layout the user can pin and keep across sessions. It answers "how is this part of the schema wired, and what refers to what". It is not a measured-data view: row labels come from the snapshot and say "Rows unknown" when there is no count, and an edge label is a structural cardinality inferred from unique keys, never an observed multiplicity.

## 2. Driver

- **Persona**: P1 architect (primary), P3 backend developer, P5 engineering manager (walkthroughs and exports).
- **Job to be done**: "Show me the tables around this one, how they are keyed to each other, and let me arrange it so the picture survives until the next review."
- **Business metric**: to be validated (business case lands in D01; candidate metric: share of review sessions that open at least one drill-through from the ERD).

## 3. Current state

Verified against `packages/explorer/src/LivingERD.tsx` and `packages/explorer/src/living-logic.ts`.

**Props and mount**

- `LivingERD(props: ViewProps)` (`LivingERD.tsx:207`) wraps `Diagram` in a `ReactFlowProvider` keyed on `snapshotKey(graph)` (`:208-209`), so a different snapshot remounts the React Flow instance.
- `Diagram` destructures only `graph` and `onSelectTable` (`LivingERD.tsx:66`); `live` and `onSelectTables` from `ViewProps` (`types.ts:10`) are ignored.
- Registered as `living` in the `mount()` component map (`index.tsx:22`).

**Rendering**

- Node types `table` and `domain`, edge type `relationship` (`LivingERD.tsx:63-64`).
- `TableCard` (`:18-41`): name (`table.name || table.id`) with `rowLabel(table)` (`:23`; `living-logic.ts:8` returns `"<n> rows"` or `"Rows unknown"`), a pin toggle with `aria-pressed` (`:24`), and, only when `detailed`, a scrollable column list with PK / FK / `NOT NULL` / `NULL` / `NULL ?` badges (`:33`) and up to three sample values (`samples.slice(0, 3)`, `:35`) truncated to 65 characters by `sampleText` (`:15-17`). Sample values are read from `column.sampleValues` or `column.profiling.sampleValues` (`:29-30`).
- `RelationshipEdge` (`:46-62`): bezier path, self-loop path for self-references (`:50-51`), crow's-foot markers only when cardinality is known (`:53-56`), inferred edges dashed `3 5` and coloured `var(--muted)` (`:56`), junction edges dashed `9 5` and thicker (`:56`). Label text is `N:M · <junction>`, `Inferred · ?`, `FK · ?`, `1:1`, or `N:1` (`:58`) with a `(N)` pair-count suffix for multi-pair constraints (`:59`); the tooltip lists every `column -> targetColumn` pair (`:57`).
- Semantic zoom: four tiers from `erdTier(zoom, previous)` (`living-logic.ts`), named in the toolbar by `TIER_LABELS`. `overview` below 0.16 draws one `DomainCard` per domain with the cross-domain ribbons between them; `domains` (0.16-0.42) adds up to ten member names per bubble; `tables` (0.42-1.15) draws the table cards; `detail` above 1.15 adds the column lists. `ERD_TIER_HYSTERESIS` (1.06) means a boundary must be cleared before the tier changes, in either direction, so a diagram parked on one does not flicker.
- Domain bubbles are positioned by `domainBounds()` around the tables they contain, in the same coordinate space as those tables, so a domain expands in place: clicking a bubble's header reveals its own tables where the outline was, leaving the other domains collapsed and the viewport untouched. `expanded` holds the open domains; the toolbar can open or close all of them and the footer states how many are open.
- Edges are planned by `planErdEdges()`, which resolves each endpoint to whatever is standing in for it. Two visible tables get a `RelationshipEdge`; anything else becomes a `RibbonEdge` between bubbles, or between a visible table and a collapsed domain's bubble, carrying the relationship count. A relationship wholly inside one collapsed domain is not drawn, because both ends would be the same bubble. Ribbon thickness is `log1p(count)` and a ribbon of only naming guesses is dashed and muted, so declared and inferred evidence stay separable at every tier.
- Selecting a table (search, or double-click) opens every domain its one-hop neighbourhood spans and frames the table with the neighbours laid out beside it, rather than dropping onto the single table at a fixed zoom. The fit is deferred one frame past the render that makes those nodes visible, because React Flow measures only what is on the canvas.
- Cardinality and grouping come from `relations()` (`living-logic.ts:28-41`): links grouped by `[source, target, kind, constraintId || [column, targetColumn]]` (`:33`); a declared FK whose target columns are covered by a unique key is `one-to-many`, or `one-to-one` when the source columns are also unique, otherwise `unknown` (`:39`).
- Junction collapse: `junctions()` (`living-logic.ts:43-52`) requires a non-view table with two or more outgoing `declared FK` `one-to-many` relations and a unique key covering exactly the union of the FK columns (`:48-50`); `visibleGraph()` (`:54-65`) collapses a candidate only when it has exactly two outgoing relations and nothing references it (`:61`, comment at `:60`). The footer reports `<N> junctions collapsed` (`LivingERD.tsx:204`); the "Show junctions" toggle (`:182`) disables collapsing; `reveal` re-shows one junction after a search focus (`:129`, `:101`).

**Interactions**

- Drag: `onNodesChange` updates positions (`:153-159`); `onNodeDragStop` pins the node and persists (`:195`).
- Pin / unpin per table (`:112-115`), unpin all (`:189`), refresh force layout keeping pins (`relayout`, `:160-164`).
- Hover dims non-neighbours (`:116-120`, `:138`, `:151`).
- Search: input at `:179`, matches capped at 25 (`:152`), Enter or a result click calls `focus(id)` (`:126-132`), which sets `reveal`, recentres with `setCenter(..., { zoom: 1.35, duration: 350 })` (`:130`) and then calls `onSelectTable(id)` (`:131`).
- Zoom in / out / fit (`:184-187`); `fitView` padding 0.12, `minZoom 0.001`, `maxZoom 2.6` (`:81-83`, `:195`). A `ResizeObserver` refits when the canvas size changes by more than one pixel (`:84-99`).
- Node click on a `table` node calls `onSelectTable(node.id)` (`:195`). Edges have no click handler and are `edgesFocusable={false}` (`:195`).
- Theme: `colorMode={useTheme()}` on `<ReactFlow>` (`:195`, C02) selects the library's own light or dark base, and `LivingERD.css:22` overrides its `--xy-*` variables with the design tokens, so the controls, minimap, handles, edge labels, selection box and node shadows follow the theme in both modes rather than only in dark.

**Persistence (C13)**

- Positions are stored under `backend-buddy-erd:v1:<encodeURIComponent(project.key || project.name || 'local')>:<fingerprint>` (`living-logic.ts` `snapshotKey()`), where the fingerprint is `source.hash`, `source.sourceHash`, `source.sha256`, or `graph.sourceHash`, else an FNV-1a hash of the sorted tables and links. Since C03 both halves of that key come from `packages/explorer/src/view-state.ts` (`projectScope`, `graphFingerprint`), which the per-view state key `backend-buddy:view-state:v1:*` shares, so the two families cannot drift apart (C13); the composed string is unchanged and is pinned by a regression case in `living-logic.test.ts`, so saved layouts are not orphaned. `parsePositions` accepts only `version: 1` payloads and finite coordinates with `|x|, |y| < 1e7` and a boolean `pinned` (`:75-85`). A failed `localStorage.setItem` sets the footer status "Layout storage unavailable; positions remain in this session." (`:110`).
- Layout: `layoutTables` runs a d3-force simulation for 220 ticks (`:105-111`) with domain anchors on a square grid of 1100 x 1000 units (`:97-99`), then resolves remaining rectangular overlaps while keeping pinned or saved placements authoritative (`:113-126`).

**Export**

- SVG and PNG via `html-to-image` `toSvg` / `toPng` on `canvas.current` (the `.lerd-canvas` element, `:194`) with `pixelRatio: 2`, `skipFonts: true`, and a filter excluding `.lerd-export-exclude` (`:169-170`); filenames `living-erd.svg` / `living-erd.png` (`:171`).

**Known limitations**

- Export captures only the visible viewport: `toSvg` / `toPng` snapshot the canvas element, so tables outside the current pan and zoom, and detail hidden by semantic zoom, are not exported. Failure is reported only as footer text (`:173`, `:204`). `skipFonts: true` drops web-font fidelity (`:169`).
- No inbound selection: nothing tells the diagram what the host selected; highlight state is the private `reveal` / `hovered` pair (`:73`, `:71`).
- Relationship edges are not clickable or focusable (`:195`), so there is no relationship-level drill-through today.
- The host no longer unmounts on a filter keystroke (S01) and `mount()` no longer creates a root unconditionally: since C03 it consults `mount-policy.ts` and re-renders in place when the container and the view are both unchanged. One step is still outstanding before the viewport, `reveal`, search text and unsaved positions survive a keystroke in the artifact: `renderExtension` in `skill/assets/explorer.html` rebuilds the `#extensionHost` element on every `render()`, so the policy sees a new container and recreates the root. Keeping that element belongs to the host work (L-05 / S03).
- Sample values are rendered inline whenever present in the graph (`:29-35`); there is no per-view redaction.
- Tables with no `domain` fall into `'Other'` (`living-logic.ts:95`, `LivingERD.tsx:142`).

## 4. Intended behaviour

### MVP

- **B1** Honour inbound `selected.tableId`: mark the card `data-selected="true"` and `is-selected`, reveal a collapsed junction if the target is one, and recentre once per selection change (fly-to under 600 ms; instant under `prefers-reduced-motion`).
- **B2** Honour inbound `selected.relationshipRef`: mark the matching edge selected (constraint id, or `source.column>target.targetColumn`), dim unrelated edges, and centre the midpoint once.
- **B3** Honour multi-select `ts` (P5, P6): mark every listed table `data-selected="true"` and the first listed table `is-primary` (`docs/architecture/drill-through-contract.md` section 7, inbound rule 1), fit the view to them once; unknown ids are dropped with a warning.
- **B4** Emit `onSelectRelationship(ref)` on edge click and on Enter / Space with an edge focused; keep `onSelectTable(id)` on node click and on search focus unchanged.
- **B5** Export the whole diagram, not the viewport: fit-to-content before capture, include every table card at the current detail level, and add a footer carrying the snapshot provenance line (C09 wording from `caveat-strings.ts`) and the row-count caveat (C01). Exported PNG and SVG must be non-empty on the medium fixture (CTQ-02 export check).
- **B6** Pass `colorMode` to `<ReactFlow>` from `useTheme()` (C02) so the canvas, controls, and background follow the theme.
- **B7** Survive filter changes without remount (C03 `mount-policy.ts`): viewport, pins, and session positions persist across 20 filter keystrokes; the `ReactFlowProvider` key remains the graph fingerprint so a different snapshot still resets the instance.
- **B8** Show the junction-collapse caveat (C10) in the footer next to the collapsed count and on the tooltip of every `N:M` edge.
- **B9** Keyboard alternative (C16): every table card is reachable by keyboard, Enter selects, and a "Table list" drawer lists all tables when the canvas is too dense to navigate.

### Later

- **B10** Living ERD edge → Join Matrix cell (registry "Later").
- **B11** Keys row → Living ERD (registry "Later").
- **B12** Hover sync with the inspector and keyboard chords (registry "Later").
- **B13** Layout persisted server-side in `erd_layouts` (A04) with the browser copy as cache; the storage-unavailable message becomes a sync status.

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

Registry entries that land on this view:

| Entry | From | Arrives with |
|---|---|---|
| P1 | Inspector "Open in Living ERD" | `t`, `v.focus=<t>` (focus the table) |
| P3 | City building context menu | `t`, `v.focus=<t>` (focus) |
| P5 | Arc Diagram cycle group | `ts` (members selected and fit) |
| P6 | Domains community | `ts` (members selected) |
| P8 | Review FK finding | `r` (relationship selected) |
| P10 | Column Table FK column | `r` (relationship selected) |

Honoured fields: `selected.tableId` (B1), `selected.relationshipRef` (B2), multi-select `ts` (B3). Highlight: `data-selected="true"` and `is-selected` on the card or edge; for a multi-selection every listed card carries `data-selected="true"` and the first listed card also carries `is-primary`; non-related nodes dimmed only when the selection origin is another view. Once per selection change: recentre or fit; never on every render.

### Outbound

- `onSelectTable(id)` on node click (`LivingERD.tsx:195`) and search focus (`:131`) - exists today.
- `onSelectRelationship(ref)` on edge click / Enter - B4.
- `onNavigate(target)` is not emitted by this view at MVP; "Open in ..." for a selected table is the Inspector's job (P1).
- This view runs no live query, so the prefill rule (a drill-through may prefill a live query but never runs it without a click) has no local effect; it is restated here because P10 originates from this view's neighbour, the Column Table, and lands on Fan-out.

### URL state

- Reads and writes shared keys `t`, `r`, `ts`; reads `q` to prefill the search box.
- View-local keys, per the `living` allowlist frozen in `docs/architecture/drill-through-contract.md` (section 4, table "Allowlisted `v.*` names"): `v.junctions=show|collapse` (the "Show junctions" toggle at `LivingERD.tsx:182`; `collapse` is the default and is omitted from the URL) and `v.focus=<table.id>` (the table to centre on, written by P1 and P3). When both `t` and `v.focus` are present, `t` is the selection and `v.focus` the centring target; without `v.focus` the view centres on `t`. Values capped at 200 characters.
- Deliberately not in the URL: viewport (zoom, pan), node positions, pins, `reveal`, hover. Viewport lives in the `viewState` slice keyed by graph fingerprint (`view-state.ts`, extracted from `living-logic.ts:68 snapshotKey`); positions stay in `localStorage` under the C13 key family until B13.

## 6. Data contract dependencies

Reads from `SchemaGraph` (`packages/explorer/src/types.ts`; `packages/contract/schema-graph.v1.json` after C01):

| Field | Required | When absent |
|---|---|---|
| `tables[].id`, `name`, `domain` | `id` required | name falls back to id; domain to `'Other'` |
| `tables[].rowCount` | optional (`number | null`) | "Rows unknown" (`living-logic.ts:8`); node width bonus 0 (`:9`) |
| `tables[].allColumns[].{name,type,pk,fk,nullable}` | required per contract | empty list shows "No column metadata" (`LivingERD.tsx:27`) |
| `tables[].allColumns[].profiling.sampleValues`, top-level `sampleValues` | optional | no samples row |
| `tables[].primaryKey`, `uniques`, `indexes`, `allColumns[].unique` | optional | cardinality `unknown`, no junction collapse |
| `tables[].kind` / `type === 'view'` | optional | views never collapse as junctions (`living-logic.ts:46`) |
| `links[].{source,target,column,targetColumn,kind,constraintId}` | required except `constraintId` | pairs grouped by column pair when no `constraintId` |
| `project.key`, `project.name`, `source.hash` / `sourceHash` / `sha256` | optional | storage key falls back to `'local'` and a content hash (`living-logic.ts:69-72`) |

`LiveConnection` methods used: none.

## 7. Caveats

> C01: "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."
> Shown: card row label "Rows unknown" (`living-logic.ts:8`); node width receives no size bonus for unknown counts (`:9`). MVP: export footer.

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: inferred edges dashed and muted (`LivingERD.tsx:56`), label "Inferred · ?" (`:58`), footer legend "Declared FK / Inferred / N:M / ? Unknown" (`:204`).

> C10: "A table is collapsed into an N:M junction edge only when its key evidence supports it: exactly two foreign-key groups whose columns are covered by a primary or unique key. A generic multi-FK fact table, a ternary relation, or a junction that is itself referenced is never collapsed into one binary edge."
> Shown: footer "<N> junctions collapsed" (`:204`) with the "Show junctions" toggle (`:182`); edge label "N:M · <junction>" and tooltip "N:M via <junction>" (`:57-58`). MVP (B8): the caveat sentence in the footer tooltip, from `caveat-strings.ts`.

> C13: "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state."
> Shown: layout key `backend-buddy-erd:v1:<project.key>:<fingerprint>` (`living-logic.ts:72`); status "Layout storage unavailable; positions remain in this session." (`LivingERD.tsx:110`).

Also surfaced here according to `docs/reference/caveats.md` "Where surfaced" but not listed in the registry row for F05 (reconciliation in section 13):

> C11: "A composite foreign key is one constraint and counts once wherever constraints are counted (matrix cells, community edges, cardinality). The relational map's association count is column pairs, not physical FK constraints. Every surface states which of the two it counts."
> Shown: one edge per constraint with the pair count "(N)" suffix (`LivingERD.tsx:59`).

> C16: "The flat, accessible rendering (flat SVG City, keyboard-reachable tables, text alternatives for canvas and WebGL surfaces) remains available in every release. It uses the same layout data as the 3D scene, can be chosen at any time, and is entered automatically when WebGL is unavailable or lost."
> Shown: MVP B9 table-list drawer; today there is no text alternative beyond React Flow defaults.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture is open in the Living ERD, when the route changes to `?t=<id>`, then the card for `<id>` carries `data-selected="true"`, the viewport centres on it once, and no other card is marked selected.
- **AC2** (B2, CTQ-10) Given a declared FK with a `constraintId`, when the route carries `?r=<constraintId>`, then exactly one edge is marked selected and its tooltip lists the column pairs.
- **AC3** (B3, CTQ-10) Given `?ts=a,b,c` where `c` does not exist, then `a` and `b` carry `data-selected="true"`, `a` also carries `is-primary`, the view fits them once, and a console warning names `c`.
- **AC4** (B4, CTQ-10) Given an edge is focused, when Enter is pressed, then `onSelectRelationship` is called once with the edge's ref and no `/api/*` request is made.
- **AC5** (B5, CTQ-02) Given the medium fixture at any viewport, when "Export SVG" is clicked, then the file contains every table id present in `graph.tables` and a footer with the C09 and C01 sentences.
- **AC6** (B6, CTQ-02) Given dark theme, when the ERD renders, then the React Flow background and controls use the dark tokens and axe reports no colour-contrast violation.
- **AC7** (B7, CTQ-10) Given the ERD is mounted with a pinned node and zoom 1.6, when 20 filter keystrokes are typed in the host search, then `window.__backend-buddyMounts` is unchanged and the zoom and pin are unchanged.
- **AC8** (B1, CTQ-03) Given a node drag of 30 px, when the pointer is released, then `onSelectTable` is not called (drag is not a click) and the node is pinned.
- **AC9** (B9, CTQ-11) Given keyboard-only navigation, when the user tabs into the diagram, then every table card is reachable and Enter selects it.
- **AC10** (CTQ-09; budget, no behaviour tag) Given the medium fixture, when the `living` route loads, then the lazy chunk is at most 250 KB and `performance.mark` TTI is at most 1.5 s.

## 9. Test expectations

- Unit (node:test, `packages/explorer`): `living-logic.test.ts` (9 tests today) keeps `relations`, `junctions`, `visibleGraph`, `snapshotKey`, `parsePositions`, `layoutTables`; add `F05` cases for relationship-ref resolution and multi-select fit inputs.
- Component (Vitest + Testing Library, `packages/web`): `F05` prop-change tests proving `selected` changes recentre once and that a graph change with the same fingerprint does not reset positions (prerequisite for root reuse, see plan risk "Remount fix changes lifecycle assumptions").
- E2E (`tests/e2e/views/living.spec.ts`, converted from `living-browser.test.mjs` per S02, `msedge` removed): drag-vs-click separation, pin persistence, junction toggle, export non-empty; `tests/e2e/drill-through.spec.ts` rows for P1, P3, P5, P6, P8, P10 generated from the registry.
- A11y (`tests/a11y`): axe on the `living` route x 2 themes x 1366/390; keyboard journey "search, Enter, Tab to card, Enter" (CTQ-11).
- Perf (`tests/perf`): chunk size and TTI on `fixtures/schemas/medium.json`; layout time for `large.json`.
- Security (`tests/security`): hostile fixture renders inert (sample values with markup are text, no dialog).
- Fixtures: `small`, `medium`, `large`, `edge-cases` (junction candidates: ternary, referenced junction, view), `hostile`.

## 10. Security and privacy

- Inputs: the `SchemaGraph` only; no user text reaches the DOM unescaped (React text nodes). Search text filters in memory (`LivingERD.tsx:152`).
- Renders from untrusted data: table and column names, types, and up to three `sampleValues` per column (`:29-35`). Sample values are potentially sensitive; the MVP export job strips `sampleValues` and string min/max by default (plan, A04) and the in-view rendering follows the workspace policy from A03 `policy.py` once wired.
- Storage: `localStorage` key `backend-buddy-erd:v1:<project.key>:<fingerprint>` (positions, pins). Values are validated on read (`living-logic.ts:75-85`); no other browser storage.
- Export: `html-to-image` produces data URLs (`:170`); under the strict SPA CSP (plan risk) this must be verified in the CSP-violation e2e (CTQ-07) and replaced or isolated if it violates.
- No network access from this view; no SQL.

## 11. Performance budget

| Budget or cap | Value | Source |
|---|---|---|
| Living ERD lazy chunk | <= 250 KB | `docs/reference/limits-and-caps.md` B (W01) |
| View TTI on medium fixture | <= 1.5 s | limits B (Q01) |
| Search results | 25 | `LivingERD.tsx:152` |
| Sample values shown per column | 3 | `LivingERD.tsx:35` |
| Zoom range | 0.001..2.6 | `LivingERD.tsx:195`; detail > 1.2, clusters < 0.4 (`:102`) |
| Node height | <= 350 px (`78 + 46 * columns`) | `living-logic.ts:9` |
| Force simulation | 220 ticks, then overlap resolution | `living-logic.ts:111`, `:113-126` |
| Sample text length | 65 chars | `LivingERD.tsx:16` |

## 12. Accessibility

- Roles and names today: search input `aria-label="Search tables"` (`:179`); toolbar buttons all carry `aria-label` (`:184-191`); pin toggle uses `aria-pressed` (`:24`); marker `<svg>` is `aria-hidden` (`:198`); footer status is `role="status"` (`:204`).
- Keyboard: search is fully keyboard operable (Enter focuses the first match, Escape closes results, `:178-180`). Table cards depend on React Flow's default node focus handling (unverified, to be measured in CTQ-11); edges are `edgesFocusable={false}` (`:195`) and therefore unreachable, which B4 and B9 fix.
- Motion: `setCenter` and zoom animations use fixed 200-350 ms durations (`:130`, `:184-185`, `:147`); no `prefers-reduced-motion` handling today (B1 adds it).
- Colour independence: inferred edges are dashed as well as muted (`:56`); junction edges dashed (`:56`); cardinality is also in the label text (`:58`).
- Text alternative (C16): none today beyond the footer; B9 adds the table-list drawer.
- Axe coverage: `living` route x light/dark x 1366/390 (CTQ-11); artifact host run in `scripts/verify_host.mjs` (S02).

## 13. Open questions

1. Registry reconciliation: `caveats.md` lists F05 under C11 and C16 but the F05 registry row lists C01, C07, C10, C13. Owner: Product owner. Gate: G0.
2. Should B5 export at the current detail level or always at full detail (column lists) regardless of zoom? Owner: Frontend lead with Design and accessibility lead. Gate: G0.
3. Should sample values render in the ERD at all when the workspace policy marks a column `pii-direct` or `secret`, or only in the Column Table? Owner: Security lead. Gate: G1 (before A03 policy classes freeze).
4. Is `html-to-image` compatible with the strict SPA CSP, or does export move to the server `export` job (A04)? Owner: Frontend lead. Gate: G1 (W01 CSP-violation e2e).
5. When both a `constraintId` and a legacy column-pair grouping exist for the same relationship, which `r` value is canonical for deep links? Owner: Frontend lead (C03). Gate: G1.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/LivingERD.tsx` |
| Logic | `packages/explorer/src/living-logic.ts` |
| Styles | `packages/explorer/src/LivingERD.css`; React Flow base styles `@xyflow/react/dist/style.css` (`LivingERD.tsx:7`) |
| Tokens | `packages/explorer/src/tokens.css` and `palettes.ts` (C02); the theme is read through `theme.tsx` `useTheme()` |
| Contract | `packages/explorer/src/types.ts` (`ViewProps`, `SchemaGraph`); the eight additive optional fields landed with C03 |
| Navigation | `packages/explorer/src/navigation.ts` (P1, P3, P5, P6, P8, P10 target the Living ERD); `selection.ts` and `route-state.ts` for the ids and the `living` allowlist (`junctions`, `focus`) |
| Persistence | `localStorage` `backend-buddy-erd:v1:*` (`living-logic.ts` `snapshotKey()`, composed from `view-state.ts`); planned `erd_layouts` table (A04) |
| Tests | `packages/explorer/src/living-logic.test.ts`; `packages/explorer/src/living-browser.test.mjs` (legacy, to be converted by S02 into `tests/e2e/views/living.spec.ts`); `tests/e2e/drill-through.spec.ts` (W04) |
| Host mount | `packages/explorer/src/index.tsx:22`; `skill/assets/explorer.html:195` |

### Change log

Appended on every merge that touches the feature (CTQ-13). Newest first.

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-08 | - | F05 | Navigation rework. The two hard thresholds (`detail = zoom > 1.2`, `clusters = zoom < 0.4`) became the four `erdTier()` tiers with a hysteresis margin, adding the intermediate "domains + names" step and ending the flicker at a boundary. Domain bubbles moved from the separate `domainOverviewLayout` grid onto `domainBounds()` in table space, so a domain expands in place instead of the view being replaced; `domainOverviewLayout` is removed. `planErdEdges()` gives the overview its cross-domain ribbons, which it previously had none of (edges were dropped entirely below zoom 0.4). `layoutTables()` now sizes a cell per domain from the area its tables need (`domainCells()`), anchors ten times more firmly inside it, bounds the charge force, and resolves residual overlap by searching outward rather than pushing down -- together these stop a domain's tables sprawling across its neighbours, which is what made the new bubbles overlap. A minimap was added; domain labels are now held at a constant on-screen size instead of being scaled *down* below zoom 0.2. |
| 2026-09-08 | - | C03 | The layout key's project scope and fingerprint moved into `view-state.ts` (`projectScope`, `graphFingerprint`) so the new `backend-buddy:view-state:v1:*` family shares them (C13). `snapshotKey()` output is unchanged and is now pinned by a regression case. `mount()` reuses its root when the container and view are unchanged, so a filter keystroke no longer tears the diagram down; the artifact still rebuilds the host container, which L-05 / S03 owns. No view file changed. |
| 2026-09-08 | - | C02 | `colorMode` is passed to `<ReactFlow>` from `useTheme()`, and `LivingERD.css:22` maps the library's controls, minimap, handles, edge labels, selection box and node shadows onto tokens, so React Flow's own light defaults no longer show through in light mode. Shadow literals became `--elevation-2` and `--elevation-3`. |
| 2026-09-07 | - | D05 | Review fixes: `v.junctions` values and `v.focus` aligned to the `living` allowlist; `is-primary` on multi-selection (B3, AC3, inbound rule); AC10 tagged to CTQ-09 only. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo baseline. |
