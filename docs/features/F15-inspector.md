Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F15 Inspector

| Field | Value |
|---|---|
| Status | partial |
| Owner | Frontend lead |
| Surfaces | host `#side` / `#detail` panel (`skill/assets/explorer.html:24`, `detail()` at `:73-80`, `selectTables` relationship inspector at `:64`, `findingDetail` at `:127`); planned React `Inspector.tsx` with `inspector-logic.ts` and `decisions.ts` (W02) used by both the SPA and the offline artifact |
| CTQs | CTQ-02, CTQ-10, CTQ-11 |
| Caveats | C07, C08, C13 (registry row); also surfaced here per `caveats.md`: C06, C09, C10, C15 (see open question 1) |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The inspector is the persistent side panel that shows what is selected (a table, later a column, a relationship, or a review finding) and offers the ways to go deeper: keys, relationships, findings, provenance, and "Open in ..." targets in the other views. It is the hub of drill-through navigation (F14): every view selects into it and it navigates out to every view. It shows evidence about a snapshot, never a live verdict; and the decisions it lets a user record in the browser are convenience state.

## 2. Driver

- **Persona**: all of P1-P5; P6 licensee security reviewer for the provenance section (definitions in `docs/business/business-case.md`, D01).
- **Job to be done**: "Whatever I clicked, show me everything the snapshot knows about it and let me jump to the view that explains it best without losing my place."
- **Business metric**: to be validated (business case D01 in progress). Candidate: drill-through path efficiency <= 1.5 in the UX protocol (Q04).

## 3. Current state

Verified against `skill/assets/explorer.html`.

**Panel and layout**

- Markup at `explorer.html:24`: `<aside class="side" id="side">` with `#inspectorTitle` (`Entity inspector`), a `#closeSide` button (`aria-label="Close inspector"`), and `<div id="detail">`. The header filter row holds `#toggleSide` (`aria-label="Toggle inspector"`, `:23`).
- `setSide(show)` at `:61` toggles `hidden` on `#side`, the `no-side` grid class on `#workspace`, and the toggle icon. Initial state `state.side = innerWidth > 700` (`:37`). At <= 700 px the panel becomes an absolute overlay `width:min(360px,100%)` (`:14`); `openNeighborhood` closes it on narrow screens before switching to the map (`:72`). Panel width 400 px at >= 1800 px, 310 px at <= 1050 px (`:12-13`).
- The panel scrolls independently of the view (`.side{... overflow:auto}` at `:11`).

**Entity inspector (`detail()` at `:73-80`)**

- Runs on every `render()` (`:178`) for `state.selected`, which is initialised to the first table (`:37`), so the inspector is populated on page load without interaction.
- Content (`:77`, one `innerHTML` assignment): title with `_` soft-wrapped by `​`; class name; domain and type badges; actions `Relationships` (`#focusEntity` -> `openNeighborhood`, `:78`) and `Keys` (`#entityKeys` -> clears filters, searches the table id, opens the key index, `:78`); finding detail when a finding is selected; facts `Primary key`, `Columns`, `Declared FKs (N outbound / N inbound)`, `Source <file>:<line>`; a `Columns` table with `PK`, `FK`, `Unique`, `Index lead` badges and nullability text (`Nullable | Required | Nullability implicit`); `Relationships (N)` listing `to`/`from` table links with `column -> targetColumn | kind`; `Declared indexes & constraints` (indexes, uniques, checks, or `No explicit declarations recorded`); a collapsed `Source & scope` block with `source.basis`, `source.generated`, and `Source SHA-256`.
- Table links inside the panel are wired to `selectTable` (`wireRefs($('detail'))` at `:78`), so the inspector navigates to related tables in place.
- Title switches to `Review evidence` when a finding is selected (`:76`) and the finding block (`findingDetail`, `:127`) is inserted above the facts, including the decision select whose change handler persists to `backend-buddy:<project.key>:reviews` (`:79`, F04).

**Relationship inspector (`selectTables` at `:64`)**

- Called by React views through `onSelectTables` (`:195`; `ViewProps.onSelectTables` in `packages/explorer/src/types.ts:10`). Selects the first id, then when more than one id is given sets the title to `Relationship inspector` and prepends one `<details open>` block per additional table (id, PK, column/type table with PK/FK badges).
- Every call rebuilds the panel; there is no breadcrumb or history.

**Selection flow**

- `selectTable(id)` at `:63`: ignore unknown ids, set `state.selected`, clear `state.finding`, open the panel, render `detail()`, and either re-render the map or update row highlights (`highlight()` at `:65`, class `selected` on `tr[data-row]`).
- Inbound from React views is one-directional: views emit `onSelectTable`/`onSelectTables`; nothing flows back into a view (F14).

**Contract available after C03 (nothing rendered yet)**

- The shell-neutral half of the drill-through contract exists as pure modules: `selection.ts` (`Selection`, `NavigationTarget`, the B3 id forms, `validateSelection`), `route-state.ts` (the `t c r ts f q d k` grammar and the per-view `v.*` allowlist), `view-state.ts`, `navigation.ts` (the P1-P10 registry with `targetsFor` and `resolve`), `mount-policy.ts` and `caveat-strings.ts`. `ViewProps` gained the eight additive optional fields, `onSelectTable` unchanged.
- The "Open in ..." menu W02 builds is `targetsFor(selection, 'inspector')`, which today returns P1 for any selection carrying a table; `resolve('P1', selection, graph, view)` produces the target, with the selection already validated against the loaded graph and unknown ids dropped. The panel itself is unchanged in this work package: no menu, breadcrumb, focus management or column and relationship detail exists yet.

**Defects and gaps (current state)**

- Confirmed stored XSS: `${t.line}` at `:77` is the only unescaped schema value in the host (`<dd>${E(t.file||data.source.file)}:${t.line}</dd>`). `normalize()` only `setdefault`s `line` to `0` (`build_explorer.py:37`) and never type-checks it; a string such as `<img src=x onerror=...>` survives `json.dumps(...).replace('<','\\u003c')` (`build_explorer.py:103`, which `JSON.parse` reverses) and is concatenated raw into `innerHTML`. The CSP's `script-src 'unsafe-inline'` (`:6`) permits inline handlers, and `detail()` runs on load for the first table (`:37`, `:178`), so no interaction is needed. `test_renderer.py:60-68` does not cover this sink. S01 escapes the value with `E()` and validates `line` as an int in `normalize()`.
- No focus management: opening the panel does not move focus; closing it does not return focus; keyboard users must Tab across the view to reach it.
- No breadcrumb, no back navigation, no browser-history integration: following a table link inside the panel replaces the content.
- The panel offers only two outbound targets (`Relationships` -> map, `Keys` -> key index); no way to open the selected table in any React view.
- Column and relationship selection do not exist; the relationship inspector is a stack of table cards, not a relationship detail (no `constraintId`, `ondelete`, `cardinality` shown).
- `nullable` text at `:77` treats `pk` as `Required` even when `nullable` is `''` (reasonable, but undocumented).
- The relationship-count fact counts links (column pairs), not constraints (C11 wording applies).
- `detail()` runs on every `render()`, including filter keystrokes, and `selectTable` renders it twice when the map is active (`:63` then `:178`).
- The inspector's C08 notice (`:127`) and the `Source` line's implicit C09 statement are paraphrases or absent. The canonical wording is now available to import: C03 added `packages/explorer/src/caveat-strings.ts`, the checked mirror of `docs/reference/caveats.md`, so W02 quotes it rather than writing its own text.

## 4. Intended behaviour

### MVP

- **B1** `Inspector.tsx` (React, shell-neutral, in `packages/explorer/src`) replaces `detail()`, `selectTables`, and `findingDetail` for both the SPA and the artifact (W02). Content model in `inspector-logic.ts` (pure): table facts, columns with flags, relationships grouped by constraint, indexes/uniques/checks, findings for the table, provenance.
- **B2** Selection kinds: table, column, relationship, finding (`Selection` type from C03). A relationship detail shows both endpoints, all column pairs of a composite constraint as one item (C11), `kind` (C07), `ondelete`, `cardinality` when present, and the N:M collapse status when the relationship came from Living ERD (C10).
- **B3** "Open in ..." menu generated from the navigation registry (P1: Fan-out root, Living ERD focus, City fly-to, Column Table, Join Matrix row, Arc, Map neighbourhood, Keys, Review findings); entries are disabled with a reason when the target view cannot show the selection.
- **B4** Breadcrumb of the last 6 selections with browser history integration (back returns to the previous selection); the cap is recorded in `docs/reference/limits-and-caps.md` B.
- **B5** Context menu on any selectable element in any view (right-click, Shift+F10) showing the same targets as B3.
- **B6** Focus management: opening the panel moves focus to its heading; closing returns focus to the invoking element; Escape closes an overlay panel at narrow widths.
- **B7** Decisions section for findings uses `decisions.ts` adapters (localStorage in the artifact, API in the SPA) and states which store is in use (C13).
- **B8** Provenance section shows `source.basis`, `generated`, `sha256`, `commit`, and the snapshot `origin` when available, with the C09 canonical text.
- **B9** All schema text rendered as React children; the `Source` line renders `line` as a number (fixes the `:77` sink for the ported panel; S01 fixes the host until W03 deletes it).
- **B10** No remount on filter change; the panel keeps its selection when the filters change and shows a note when the selected table is filtered out of the current view.

### Later

- **B20** Hover synchronisation with views and keyboard chords (drill-through "Later").
- **B21** Column statistics (from `profiling`) and sample values (opt-in) in the column detail, with C05 wording; today shown by F07.
- **B22** Artifact host-bridge: "Open in ..." inside the artifact via `location.hash` deep links (L-05).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005, D02). The inspector is the source of registry entry P1 (Inspector -> any view) and the sink of every view's outbound selection.

### Inbound

- Receives the full `Selection` (`tableId`, `columnId`, `relationshipRef`, `findingId`, multi-select `ts`) from the shell store; renders the matching detail; unknown ids show `Not in this snapshot` rather than clearing silently (today unknown ids are ignored at `:63`).
- Highlight is the inspector's own content; no `data-selected` is needed on the panel, but the panel exposes `data-selection-kind` for tests.

### Outbound

- `onSelectTable`, `onSelectColumn`, `onSelectRelationship` when the user clicks a related item inside the panel (today table links only, `:78`).
- `onNavigate(target)` from "Open in ..." and the context menu (B3, B5).
- Rule: a drill-through may prefill a live query but never runs it without a click. "Open in Fan-out" prefills the root; "Open in Normalization Lens" never triggers `live.profile`.

### URL state

- Reads and writes `t c r f ts`; the inspector open/closed flag is not URL state (persisted per user as a preference in the SPA, per project key in the artifact).
- Breadcrumb history is browser history, not URL query state.

## 6. Data contract dependencies

| Field | Required | Behaviour when absent |
|---|---|---|
| `tables[].id`, `className`, `domain`, `type`, `pk`, `allColumns[]`, `indexes[]`, `uniques[]`, `checks[]` | yes (defaults at `build_explorer.py:37`, `:68-70`) | `No explicit declarations recorded`, `None recorded` |
| `tables[].file`, `line` | optional | `Source` shows `source.file` and `0` today; MVP shows `not recorded` when `line` is `0` or absent |
| `source.basis`, `generated`, `sha256`, `commit`, `file` | defaults at `build_explorer.py:29-31` | default strings shown |
| `links[]` incl. `constraintId`, `ondelete`, `cardinality` | yes / optional | relationship detail omits absent fields |
| `allColumns[].default`, `serverDefault`, `applicationDefault` | optional | shown separately when present (C15) |
| `allColumns[].profiling` | optional | B21 later |

No `LiveConnection` method is used by the inspector itself.

## 7. Caveats

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: relationship list `column -> targetColumn | kind` (`:77`); `Declared FKs` fact counts declared links only (`:77`); relationship detail (B2).

> C08: "Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect."
> Shown: finding block inside the inspector (`findingDetail`, `:127`; MVP canonical text).

> C13: "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state."
> Shown: decision store note in the finding block (B7); storage-failure toast (`:79`).

> C06: "Membership in a composite unique key or composite primary key does not make any member column unique on its own. Uniqueness is stated per key group, and index coverage depends on column order, predicates, and expressions."
> Shown: `Declared indexes & constraints` section lists whole groups (`:77`); column `Unique` badge appears only for single-column uniqueness (`c.unique`), `Index lead` only for leading columns (`indexed`, `:44`).

> C09: "A source checkout, ORM model, or stored snapshot documents a schema at one point in time. It is not proof of the live database schema. "Declared" means declared in the identified evidence source, not verified against a live catalog, unless the snapshot's provenance says so."
> Shown: `Source & scope` block with `source.basis` (`:77`); MVP provenance section (B8).

> C10: "A table is collapsed into an N:M junction edge only when its key evidence supports it: exactly two foreign-key groups whose columns are covered by a primary or unique key. A generic multi-FK fact table, a ternary relation, or a junction that is itself referenced is never collapsed into one binary edge."
> Shown: relationship detail for a collapsed junction edge names the junction table and its two FK groups (B2; nothing today).

> C15: "An application-level default (an ORM or code default) is not a SQL default. The two are shown separately, an application default is never emitted as DDL, and a code function is never emitted as executable migration SQL."
> Shown: column detail shows `default`, `serverDefault`, and `applicationDefault` as separate labelled values (B2; nothing today).

## 8. Acceptance criteria

- **AC1** (B9, CTQ-07) Given the `hostile` fixture with a string `line` containing markup, When the artifact and the SPA render the inspector for that table, Then no element is created from the value, no dialog opens, and the text appears literally (S01 regression test for `explorer.html:77`).
- **AC2** (B1, CTQ-10) Given any view, When a table, column, relationship, or finding is selected, Then the inspector shows the matching detail within one render and `data-selection-kind` matches.
- **AC3** (B3, CTQ-10) Given a selected table, When "Open in ..." is opened, Then every enabled entry navigates to the named view with the selection carried in the URL (`t`, `c`, `r`, or `f`), and no `/api/subtree` or `/api/profile` request is issued before the user clicks Run in the target view.
- **AC4** (B4, CTQ-10) Given six successive selections, When the breadcrumb is read, Then it lists the last six in order and browser Back restores the previous selection.
- **AC5** (B6, CTQ-11) Given keyboard-only use, When the panel opens, Then focus is on its heading; When it closes, Then focus returns to the invoking control; at 390 px Escape closes the overlay.
- **AC6** (B10, CTQ-10) Given a selected table and 20 filter keystrokes, When the view updates, Then the inspector keeps its selection and `__backend-buddyMounts` is unchanged.
- **AC7** (B7, CTQ-16) Given the SPA, When a decision changes in the inspector, Then the API adapter is used and an audit row exists; Given the artifact, Then the localStorage adapter writes under `backend-buddy:<project.key>:reviews`.
- **AC8** (B1, CTQ-02) Given 1920, 1366, and 390 px in both themes with the panel open, When rendered, Then no horizontal page scroll and the panel scrolls independently.
- **AC9** (B1, CTQ-11) Given both themes at 1366 and 390 px, When axe runs on a route with the panel open, Then zero serious or critical findings.

## 9. Test expectations

- Unit (node:test): `inspector-logic.test.ts` (facts, relationship grouping by `constraintId`, nullability text, provenance defaults), `decisions.test.ts` (adapter contract, key family). Prefix `F15`.
- Renderer (Python, S01): `test_renderer_security.py` asserts a string `line` is rejected or rendered inert.
- Component (Vitest): `Inspector` for each selection kind; focus management; "Open in ..." entries from a stub registry.
- e2e (`tests/e2e/drill-through.spec.ts`, W04): P1 matrix generated from the registry, including the no-live-request assertion; `tests/e2e/inspector.spec.ts`: breadcrumb and Back.
- Security (`tests/security/artifact.spec.ts`): hostile `line` through the artifact inspector.
- a11y (`tests/a11y`): axe with the panel open; keyboard journeys through the inspector.
- Fixtures: `small`, `medium`, `edge-cases`, `hostile`.

## 10. Security and privacy

- Inputs: SchemaGraph and the selection; unknown ids are rejected (`:63` today) and MVP shows a not-in-snapshot state.
- Rendering: today one template literal at `:77`; every schema-derived value passes through `E()`, either directly or inside an escaping helper (`badge()` at `:50`, `ref()` at `:49`, the pre-escaped row template handed to `tableHTML()`, `findingDetail()` at `:127`), except `${t.line}`, the confirmed sink fixed by S01. Numeric counts and the internal `dir` constant on that line are not schema text. The React port removes the class of risk.
- Storage: decisions (`backend-buddy:<project.key>:reviews`, C13) and, in the SPA, the inspector-open preference (`user_preferences`).
- Exports: none from the inspector itself.
- CTQ-07: hostile-fixture render through the panel in the artifact and the SPA; CSP violations = 0.

## 11. Performance budget

- The inspector is part of the shell chunk (<= 350 KB gzipped total). Panel render for a table with the widest column count in the large fixture is recorded as a baseline in Q01; no separate budget at MVP.
- Own caps: breadcrumb 6 entries (B4).

## 12. Accessibility

- Today: `aside` landmark; close and toggle buttons have `aria-label`s (`:23-24`); headings `h2`/`h3` structure inside the panel (`:77`); table links are buttons; the decision control is a labelled select (`:127`).
- MVP: focus management (B6), `aria-live="polite"` announcement of the selected item's name, context menu operable with Shift+F10 and arrow keys, breadcrumb as a `nav` with a list; reduced motion respected for any panel transition.
- No canvas or WebGL surface; C16 does not apply to the panel.
- axe coverage: every route with the panel open, both themes, 1366/390 (CTQ-11).

## 13. Open questions

1. The registry row lists C07, C08, C13; `caveats.md` also lists F15 under C06, C09, C10, C15. Update the registry row to all seven? Owner: Product owner. By G0.
2. Should the inspector open/closed state be URL state for shareable layouts, or a user preference (plan: preference)? Owner: Frontend lead. By C03 freeze.
3. Breadcrumb cap of 6: confirmed, or measured in the UX round (Q04)? Owner: Design and accessibility lead. By W02 brief.
4. Should the relationship inspector for `onSelectTables` with more than two ids (possible from views today) show a list or only the first pair? Owner: Frontend lead. By W02 brief.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Current host panel | `skill/assets/explorer.html:24` (markup), `:61-64` (`setSide`, `selectTable`, `selectTables`), `:73-80` (`detail`), `:127` (`findingDetail`), `:11-14` (CSS incl. narrow overlay) |
| Host fix | S01: escape `${t.line}` at `explorer.html:77`; int validator in `skill/scripts/build_explorer.py` `normalize()` |
| Planned view | `packages/explorer/src/Inspector.tsx` (W02) |
| Contract | C03: `packages/explorer/src/selection.ts`, `route-state.ts`, `view-state.ts`, `navigation.ts` (P1 is the inspector's entry), `mount-policy.ts`, `caveat-strings.ts`; the additive `ViewProps` fields in `types.ts` |
| Planned logic | `packages/explorer/src/inspector-logic.ts`, `decisions.ts` (W02) |
| Tests | `selection.test.ts`, `navigation.test.ts`, `caveats.test.ts` (C03); planned `inspector-logic.test.ts`, `tests/e2e/drill-through.spec.ts`, `tests/security/artifact.spec.ts`; `skill/scripts/test_renderer_security.py` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-07 | - | D05 | Initial document from the pre-repo code; recorded the `:77` XSS sink as a current-state defect. |
| 2026-09-07 | - | D05 | Review fixes: section 10 wording on the `:77` interpolations corrected (helpers named, no count); AC4 tagged CTQ-10. |
| 2026-09-08 | - | C03 | Section 3 records the contract the panel will consume: the selection model, the route grammar, the P1-P10 registry, and `caveat-strings.ts` as the only source of caveat wording for W02. The host panel is unchanged. |

### S01 artifact and renderer hardening (2026-09-08)

Closed the findings this document's section 3 recorded, each with a named regression
test in `skill/scripts/test_renderer_security.py`:

- `assets/explorer.html`: escape the inspector's source-line reference; route review SQL
  through `tableSQL`; dialect-gate the structured-payload probe via a new `jsonProbe`
  helper; own-property entity-type colour lookup; widen the CSV formula guard; unmount
  the React view only when the view changes.
- `scripts/build_explorer.py`: case-insensitive `</script` and `</style` neutralisation,
  `<!--` neutralisation, `_text` field validation with length caps, `_line_number`
  validation, and `contractVersion` with a major-version compatibility check.
- `scripts/project.mjs`: discover every `test_*.py` under `skill/scripts`, not only
  `test_renderer.py`, so the security suite runs.
