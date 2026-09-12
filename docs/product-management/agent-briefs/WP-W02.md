Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-W02 Inspector

| Field | Value |
|---|---|
| Work package | W02 (track W, phase 2) |
| Features | F15 (primary), F14 (registry entry P1), F04 (decision adapters) |
| CTQs | CTQ-02, CTQ-10, CTQ-11 |
| Caveats | C07, C08, C13 (F15 registry row); C06, C09, C10, C11, C15 are surfaced in relationship and provenance detail per `caveats.md` "Where surfaced" pending `traceability.md` open question 4 |
| Depends on | C03, W01 |
| Blocks | W04 |
| Branch | `f15/inspector-react` |
| Gate | G2 |

### 1. Goal

Replace the host's `detail()` panel with a shell-neutral React `Inspector.tsx` in `packages/explorer/src`, backed by a pure `inspector-logic.ts` content model and `decisions.ts` adapters (localStorage for the artifact, API for the SPA). The panel renders table, column, relationship, and finding selections, offers an "Open in ..." menu generated from the navigation registry (entry P1), keeps a six-entry breadcrumb integrated with browser history, provides a context menu (right-click, Shift+F10), manages focus, and shows caveat text only from `caveat-strings.ts`. A verifier can check: every P1 target listed in `navigation.ts` appears in the menu, focus returns to the invoking element on close, and no `detail()` string is rendered through `innerHTML`.

### 2. Reading list (ordered)

1. `docs/features/F15-inspector.md`: sections 3 (current state with `explorer.html` line pointers), 4 (B1-B10), 5 (inbound/outbound, URL keys `t c r f ts`), 7 (caveat quotes), 8 (acceptance criteria).
2. `docs/features/F14-drill-through-navigation.md` (D05, G0) and `docs/architecture/drill-through-contract.md` sections 2, 3, 6 (entry P1 and the `NavigationEntry` shape), 7 (outbound rules 2-4: context menu offers `targetsFor`, views never touch `location`, shell updates inspector and URL in one transaction).
3. `docs/features/F04-schema-review.md` B5 and B8: the decision store adapters and the C13 store note the inspector must show.
4. `docs/architecture/schema-graph-contract.md` (fields shown in detail: `indexes`, `uniques`, `checks`, `constraintId`, `kind`, `ondelete`, `cardinality`, `source.*`, `default`/`serverDefault`/`applicationDefault`).
5. `docs/architecture/adr/ADR-0004-selection-and-routing-contract.md`.
6. Existing code to lift, then delete in W03: `skill/assets/explorer.html:73` `detail()` (entity detail), `:77` (the `${t.line}` sink S01 escapes; the ported panel renders `line` as a number, F15 B9), `:77-78` `#entityKeys` and `#focusEntity` actions, `:101` `orphanSQL` (relationship inspector SQL is display-only), `:104` finding id signature (kept as-is for parity; L-06 changes it).
7. C03 deliverables: `selection.ts` (`Selection` type), `navigation.ts` (`entries`, `targetsFor`, `resolve`), `caveat-strings.ts`.
8. `docs/reference/limits-and-caps.md` section B: breadcrumb 6 entries.
9. `docs/engineering/accessibility-standards.md` (D03): focus management, menu keyboard model, `role=menu` semantics.
10. `docs/engineering/standards.md`, `security-policy.md`, `testing-policy.md` (D03).

### 3. In scope

- `packages/explorer/src/inspector-logic.ts` (pure, node:test): table facts, columns with flags, relationships grouped by `constraintId` (one item per composite constraint, C11), indexes/uniques/checks, findings for the table (from `review-logic.ts` once W03 lands; until then from the inline finding shape passed by the shell), provenance (`source.basis`, `generated`, `sha256`, `commit`, snapshot `origin`).
- `packages/explorer/src/Inspector.tsx` + `Inspector.css` (tokens only): selection kinds table/column/relationship/finding (F15 B1-B2); `data-selection-kind` attribute for tests; all schema text as React children (B9).
- "Open in ..." menu from `navigation.ts` (B3): one item per P1 target; disabled with a reason when the target cannot show the selection; choosing an item calls `onNavigate(resolve(...))`.
- Breadcrumb of the last 6 selections with browser-history integration (B4); the cap is read from one constant that the test pins.
- Context menu component reusable by views (B5): right-click and Shift+F10 open a `role=menu` with `targetsFor(selection, view)`; Escape closes and restores focus.
- Focus management (B6): open moves focus to the heading; close returns focus to the invoker; Escape closes the overlay at narrow widths.
- `packages/explorer/src/decisions.ts` (B7): `DecisionsStore` interface; `localStorageDecisions(projectKey)` writing `backend-buddy:<project.key>:reviews` (today's key, C13); `apiDecisions(client)` calling `PUT/GET /reviews/{findingId}` (A04 contract; stubbed with msw until A04 lands); the panel states which store is in use with the C13 string from `caveat-strings.ts`.
- Provenance section with the C09 string (B8); selected id not in the snapshot renders `Not in this snapshot` (section 5 inbound).
- Filter-out notice (B10): the panel keeps its selection across filter changes and shows a note when the selected table is filtered out.
- Wiring in `packages/web` `ViewHost` layout (inspector open/closed persisted as a user preference in the SPA; `backend-buddy:<project.key>:inspector` in the artifact) and in the artifact host only through the C03 mount policy (no `explorer.html` edits; the host panel is deleted in W03).
- Tests: `inspector-logic.test.ts`, `decisions.test.ts`, `Inspector` component test (Vitest in `packages/web` or node:test with jsdom, per `testing-policy.md`), `tests/e2e/inspector.spec.ts` (menu completeness against the registry, focus return, breadcrumb length, `data-selection-kind`).
- F15 sections 3 and 14; F04 section 14 row for `decisions.ts`.

### 4. Out of scope

- Deleting `detail()`, `selectTables`, and the inline renderers from `explorer.html` (W03).
- Implementing inbound highlight or context menus inside the nine views (W04); this package ships the reusable context-menu component only.
- `review-logic.ts` and the finding engine (W03); the finding id scheme (L-06).
- `PUT/GET /reviews/{findingId}` server side (A04).
- Hover synchronisation, keyboard chords (F15 B20), column statistics in the panel (B21), artifact host-bridge (B22, L-05).
- Any change to `navigation.ts` entries or `types.ts` (C03).

### 5. May modify

```
packages/explorer/src/Inspector.tsx
packages/explorer/src/Inspector.css
packages/explorer/src/inspector-logic.ts
packages/explorer/src/inspector-logic.test.ts
packages/explorer/src/decisions.ts
packages/explorer/src/decisions.test.ts
packages/explorer/src/ContextMenu.tsx
packages/explorer/src/ContextMenu.css
packages/explorer/src/index.tsx                (export Inspector and ContextMenu for the artifact mount; no view-map changes)
packages/web/src/**                            (inspector slot in ViewHost, preference wiring, msw handlers for /reviews)
tests/e2e/inspector.spec.ts
tests/a11y/keyboard-journeys.spec.ts           (journey 'inspector -> city' skeleton; W04/W05 complete it)
docs/features/F15-inspector.md                 (sections 3 and 14 only)
docs/features/F04-schema-review.md             (section 14 only)
CHANGELOG.md                                   ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change in this brief
packages/explorer/src/types.ts          C01/C03 only
packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts   C03 contract; read-only
skill/assets/explorer.html              S01, S03, W03 only
skill/scripts/build_explorer.py         S01 only
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
packages/explorer/src/{City,LivingERD,Fanout,ColumnTable,NormalizationLens,Domains,JoinMatrix,ArcDiagram,SchemaDiff}.tsx   W04/W05
services/api/**                         A track
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| `Selection` shape and `NavigationEntry` shape (`id`, `from`, `to`, `accepts`, `target`, `label`, `viewStateKeys`) | `selection.ts`, `navigation.ts` (C03); `drill-through-contract.md` section 6 | `navigation.test.ts` |
| Entry P1 targets: Fan-out root, Living ERD focus, City fly-to, Column Table (`t`,`c`), Join Matrix row, Arc, Map neighbourhood, Keys, Review findings of `t` | `drill-through-contract.md` section 6 | `tests/e2e/inspector.spec.ts` asserts menu = registry |
| Storage key family `backend-buddy:<project.key>:reviews` unchanged; decisions never unscoped | `explorer.html:39`; C13 | `decisions.test.ts`; storage-isolation e2e (Q02) |
| Finding id scheme unchanged until L-06 (`[table, rule, columns, signature].join('|')`, `explorer.html:104`) | F04 B3; `data-model.md` 3.12 | `review-logic` parity test (W03) |
| Views never call `history` or touch `location`; only the shell serialises URLs | `drill-through-contract.md` section 7 outbound rule 3 | ESLint `no-restricted-globals` in `packages/explorer` (S02) |
| Breadcrumb cap 6 | `limits-and-caps.md` B | `inspector-logic.test.ts` |
| Caveat wording from `caveat-strings.ts` only | `docs/reference/caveats.md` | `caveats.test.ts`, docs lint DL-05 |
| No remount on filter change | `mount-policy.ts` (C03) | `CTQ-10 no remount over 20 keystrokes` |
| Prefill, never execute: "Open in Fan-out" prefills root only; "Open in Normalization Lens" never triggers `live.profile` | `drill-through-contract.md` section 8 | `tests/e2e/drill-through.spec.ts` (W04) |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with the F/CTQ id, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F15; F04 section 14)
- [ ] Migration: none, because decisions are stored server-side by A04's migration, not by this package
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (no `innerHTML`; `line` rendered as a number; decision notes length-capped client-side)
- [ ] Accessibility result recorded (axe 0 serious/critical with the panel open at 1366 and 390; keyboard journey: open menu with Shift+F10, choose a target, Escape restores focus)
- [ ] Performance: no budget applies to the panel; record that the shell budget (`size-budget.mjs`) still passes
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts`
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed (`packages/explorer` changed)
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `grep -c innerHTML packages/explorer/src/Inspector.tsx packages/explorer/src/ContextMenu.tsx` equals 0

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test                                                  # includes inspector-logic.test.ts, decisions.test.ts
npm --prefix packages/web test -- --coverage
npm run build
git diff --exit-code skill/assets/extensions              # mirror committed
npx playwright test tests/e2e/inspector.spec.ts           # menu = registry P1 targets; focus return; breadcrumb <= 6
npx playwright test tests/e2e/shell.spec.ts               # CTQ-10 still green with the panel mounted
npx playwright test tests/a11y/routes.spec.ts             # panel open and closed variants
node scripts/size-budget.mjs
grep -c innerHTML packages/explorer/src/Inspector.tsx packages/explorer/src/ContextMenu.tsx    # expected: 0 each
```

Package-specific assertions: with the medium fixture loaded and `?t=<id>` in the URL, `[data-selection-kind="table"]` is present; navigating `?r=<constraintId>` renders one relationship item for a composite FK; the localStorage adapter writes only keys prefixed `backend-buddy:<project.key>:`.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-02 contract churn | Consumes `Selection` and `NavigationEntry` as frozen; a missing capability is reported, not patched into C03 files. |
| RK-05 remount lifecycle | Panel keeps selection across filter changes (B10) and is tested with a prop-change component test. |
| RK-13 finding ids reopen decisions | Keep today's id scheme; `decisions.ts` treats ids as opaque strings; note orphaned decisions in the report rather than migrating them. |
| RK-19 browser-storage origin split | Show the C13 store note; API adapter is the review record in the SPA. |
| RK-10 scope creep | View internals and `explorer.html` deletions stay with W03/W04. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
