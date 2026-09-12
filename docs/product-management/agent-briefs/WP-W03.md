Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-W03 Port host views

| Field | Value |
|---|---|
| Work package | W03 (track W, phase 2) |
| Features | F01, F02, F03, F04, F19 (CSV/SVG export modules), F22 (inline renderers deleted from the artifact host) |
| CTQs | CTQ-02, CTQ-03, CTQ-05, CTQ-06, CTQ-10, CTQ-11 |
| Caveats | C01, C04, C06, C07, C08, C11, C13 (quoted only through `caveat-strings.ts`) |
| Depends on | C03, S01, W01 |
| Blocks | W04, W06 |
| Branch | `w03/port-host-views` |
| Gate | G2 |

### 1. Goal

Lift the four vanilla-JS host views out of `skill/assets/explorer.html` into tested, shell-neutral React modules in `packages/explorer/src`: `MapView` (`map-layout.ts`, `useMapPan.ts`), `EntityIndex`, `KeyIndex` (`key-logic.ts`), and `ReviewView` (`review-logic.ts`), plus `csv.ts` and `svg-export.ts`. Register them under the view ids `map|entities|keys|review`, prove `review-logic.ts` produces the same finding set as the inline `buildFindings` on the medium fixture, then delete the inline renderers from `explorer.html` while every S01 regression test stays green and the artifact CSP stays byte-identical. A verifier can check the parity test, the four `tests/e2e/views/*.spec.ts` suites, and that `explorer.html` no longer defines `renderMap`, `renderEntities`, `renderKeys`, `renderReview`, or `buildFindings`.

### 2. Reading list (ordered)

1. `docs/features/F01-relational-map.md` (B1-B9), `F02-entity-index.md` (B1-B8), `F03-pk-fk-index.md` (B1-B7), `F04-schema-review.md` (B1-B11): the behaviours this package delivers; sections 3 give the `explorer.html` line pointers.
2. `docs/features/F19-exports.md` (D05): the CSV guard vectors and SVG export requirements for `csv.ts` and `svg-export.ts`.
3. `docs/architecture/drill-through-contract.md` sections 3, 4 (`v.*` allowlists for `map`, `entities`, `keys`, `review`), 7 (inbound markers), 8 (draft SQL never executed).
4. `docs/architecture/security-architecture.md` section 5 findings 2 and 5 (SQL quoting and dialect gate; CSV guard) and section 8.
5. `docs/architecture/adr/ADR-0002-frontend-spa-and-iife-export-path.md`, `ADR-0004-selection-and-routing-contract.md`.
6. Existing host code to lift (single file, very long lines): `skill/assets/explorer.html:60` `scoped()`; `:73` `detail()` (owned by W02; read for the selection hand-off); `:98` `tableSQL`; `:99` `readonly()` wrapper; `:100` `duplicates`; `:101` `orphanSQL` (composite handling); `:102` `buildFindings` (7 rules); `:104` finding id signature; `:108`/`:110` (S01-fixed quoting and dialect gate that `review-logic.ts` must mirror); `:134` `wrapName`; `:135` `bindMapPan`; `:163-165` map layout constants (column pitch 290, gutter 48, node width 254, `rowHeight = Math.max(140, lines*16+76)`); `:177` `zoom()`; `:178` `render()`; `:180` `exportCSV` (cell encoder, S01-hardened); `:182` `exportSVG` (computed-style inlining).
7. Reuse from the view library: `packages/explorer/src/schema-diff-logic.ts:167` `quoteIdentifier`, `:172` `qualifiedName` (dialect-correct identifiers for review SQL); `column-logic.ts:49` `tableColumnFacts`; `dependency-logic.ts:109` `dependencyTopology` (not required, but the SCC definition for any cycle wording).
8. C03 deliverables (`selection.ts`, `route-state.ts`, `navigation.ts`, `mount-policy.ts`, `caveat-strings.ts`) and C02 (`tokens.css`, `palettes.ts`, `theme.tsx`).
9. S01 deliverables: `skill/scripts/test_renderer_security.py`, `tests/security/artifact.spec.ts`; these must stay green after the inline deletion.
10. `scripts/verify_host.mjs` (S02-parameterised): the host view checks it performs (bounds, label visibility, `cityDragCheck` pattern reused for map pan).
11. `docs/reference/limits-and-caps.md` A2 (host validation SQL timeout text, display-only) and `docs/reference/caveats.md` C04, C06, C07, C08, C11.
12. `docs/engineering/standards.md`, `security-policy.md`, `testing-policy.md`, `accessibility-standards.md` (D03).

### 3. In scope

- `map-layout.ts` (pure): deterministic grid with the constants above; `wrapName`; domain group labels; output positions and `graphSize`; unit tests on small, medium, edge-cases, empty fixtures.
- `useMapPan.ts`: same contract as `bindMapPan` (4 px threshold, pointer capture, capture-phase click swallow after a drag); component test plus `tests/e2e/views/map.spec.ts` pan/click separation (CTQ-03).
- `MapView.tsx` (F01 B1-B9): inbound `selected.tableId` -> `data-selected="true"` and `is-selected`; edge click -> `onSelectRelationship`; zoom/fit/neighbourhood as `v.zoom`, `v.focus`, `v.link`; legend with the C07 and C11 strings.
- `EntityIndex.tsx` (F02 B1-B8): sort and compare as `v.sort`, `v.compare`; C03 note and C11 header note from `caveat-strings.ts`.
- `key-logic.ts` (`uniqueGroups`, `indexed`, `keyRows`) and `KeyIndex.tsx` (F03 B1-B7): `v.kind`; C06 and C07 strings.
- `review-logic.ts` (F04 B1-B3, B11): the 7 rules with identical rule strings, categories, evidence and next text, and ordering; SQL through `quoteIdentifier`/`qualifiedName`; rule 3 emits `jsonb_typeof` for `postgresql`, `json_type` for `sqlite`, and no SQL plus an explicit message otherwise; finding id scheme unchanged (`[table, rule, columns, signature].join('|')`); defensive `String()` on every field.
- **Parity test** `review-logic.test.ts`: loads `fixtures/schemas/medium.json`, runs the inline `buildFindings` (extracted verbatim into a test-only harness from the pre-deletion `explorer.html`) and `review-logic.ts`, asserts identical `{table, rule, columns, category}` sets and identical SQL text per finding. This test runs and passes before the inline code is deleted, and the harness copy is deleted in the same PR that deletes the inline code (a second PR under W03 is acceptable).
- `ReviewView.tsx` (F04 B4-B10): filters as `v.rule`, `v.category`, `v.status` plus shared `q`; inbound `f` and `t`; decisions through W02's `decisions.ts`; `Copy SQL` is the only SQL affordance; C04, C08, C13 strings.
- `csv.ts`: cell encoder with the S01 guard (`= + - @ \t \r` after leading whitespace neutralised), BOM, CRLF policy from F19; `csv.test.ts` with the formula vectors.
- `svg-export.ts`: computed-style inlining as at `explorer.html:182`, `xmlns`, width/height; `svg-export.test.ts` with jsdom.
- Registration of `map|entities|keys|review` in the `mount()` component map (`index.tsx:22`) and in the SPA route table via the navigation registry ids.
- `scripts/sql-path-lint.mjs` (CTQ-06): fails when a module importing `review-logic` or `schema-diff-logic` SQL builders also imports a driver, `fetch`, or the API client; wired into `npm test`.
- Deletion of `renderMap`, `renderEntities`, `renderKeys`, `renderReview`, `buildFindings`, `orphanSQL`, `duplicates`, `wrapName`, `bindMapPan`, `exportCSV`, `exportSVG` from `explorer.html`; the host mounts the four ported views through `BackendBuddyViews.mount` with the C03 mount policy; `render()` remains only as the view switch.
- `tests/e2e/views/{map,entities,keys,review}.spec.ts`; F01-F04 sections 3 and 14; F19 and F22 section 14 rows.

### 4. Out of scope

- Inspector panel and `detail()` replacement (W02); context menus inside views (W04 wires the W02 component).
- Drill-through entries P1-P10 beyond the inbound markers and outbound callbacks each ported view needs for parity (W04 owns the matrix).
- Finding id redesign (L-06); confidence gradation (F04 B22).
- Alternative map layouts (F01 B12), row-count badges (F01 B11, F02 B11), structural two-table diff (F02 B10).
- Server-side reviews endpoint (A04); CSV/SVG export jobs (A04); PNG export (F19 later items).
- Any edit to `explorer.html` other than deleting the inline renderers and mounting the ported views; the live bridge (`:186-190`) belongs to S03; the escaping fixes belong to S01.
- Artifact hash deep links (L-05).

### 5. May modify

```
packages/explorer/src/map-layout.ts
packages/explorer/src/map-layout.test.ts
packages/explorer/src/useMapPan.ts
packages/explorer/src/MapView.tsx
packages/explorer/src/MapView.css
packages/explorer/src/EntityIndex.tsx
packages/explorer/src/EntityIndex.css
packages/explorer/src/key-logic.ts
packages/explorer/src/key-logic.test.ts
packages/explorer/src/KeyIndex.tsx
packages/explorer/src/KeyIndex.css
packages/explorer/src/review-logic.ts
packages/explorer/src/review-logic.test.ts
packages/explorer/src/ReviewView.tsx
packages/explorer/src/ReviewView.css
packages/explorer/src/csv.ts
packages/explorer/src/csv.test.ts
packages/explorer/src/svg-export.ts
packages/explorer/src/svg-export.test.ts
packages/explorer/src/index.tsx                 (component map entries map|entities|keys|review only)
skill/assets/explorer.html                      (inline renderers and their helpers only; CSP line 6 and lines 9-10 untouched)
scripts/sql-path-lint.mjs
scripts/project.mjs                             (add sql-path-lint to the test step only)
packages/web/src/routes/**                      (route table entries for the four views)
tests/e2e/views/map.spec.ts
tests/e2e/views/entities.spec.ts
tests/e2e/views/keys.spec.ts
tests/e2e/views/review.spec.ts
docs/features/F01-relational-map.md             (sections 3 and 14 only)
docs/features/F02-entity-index.md               (sections 3 and 14 only)
docs/features/F03-pk-fk-index.md                (sections 3 and 14 only)
docs/features/F04-schema-review.md              (sections 3 and 14 only)
docs/features/F19-exports.md                    (section 14 only)
docs/features/F22-offline-artifact-and-skill.md (sections 3 and 14 only)
CHANGELOG.md                                    ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change in this brief
packages/explorer/src/types.ts          C01/C03 only
packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts   C03; read-only
skill/assets/explorer.html lines 6 and 9-10   CSP and host variables are byte-frozen (D9, C02)
skill/assets/explorer.html live bridge (:186-190)   S03
skill/scripts/build_explorer.py         S01 only
skill/scripts/test_renderer*.py         S01 owns; they must stay green unchanged
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
packages/explorer/src/{City,LivingERD,Fanout,ColumnTable,NormalizationLens,Domains,JoinMatrix,ArcDiagram,SchemaDiff}.tsx   W04/W05
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical (`explorer.html:6`) | D9; `security-architecture.md` 6.1 | `tests/security/artifact.spec.ts`, `test_renderer.py`, CI job `artifact` |
| Host CSS variables (`explorer.html:9-10`) byte-identical to `tokens.css` | C02 | `tokens.test.ts` |
| Finding set parity: `review-logic.ts` == inline `buildFindings` on the medium fixture (`{table, rule, columns, category}` and SQL text) | F04 B1 | `review-logic.test.ts` parity case, run before deletion |
| Finding id scheme unchanged until L-06 | F04 B3; `explorer.html:104` | `review-logic.test.ts` |
| Draft SQL never executed; `Copy SQL` is the only affordance; no import path from SQL builders to a connection | C04, CTQ-06 | `scripts/sql-path-lint.mjs`; `tests/e2e/views/review.spec.ts` asserts no network request on copy |
| Map pan/click contract: 4 px threshold, pointer capture, capture-phase click swallow | F01 B2; `explorer.html:135` | `tests/e2e/views/map.spec.ts` (`CTQ-03 map pan does not inspect`) |
| Map layout constants 290/48/254, `rowHeight = max(140, lines*16+76)` | F01 B1; `explorer.html:163-165` | `map-layout.test.ts` |
| Selector contract `[data-selected="true"]`, `.is-selected`, `#tab-<view>`, `[data-view]` | `drill-through-contract.md` section 7 | `tests/e2e/views/*.spec.ts`, `verify_host.mjs` |
| `v.*` allowlists for `map` (`zoom`, `focus`, `link`), `entities` (`sort`, `compare`), `keys` (`kind`), `review` (`rule`, `category`, `status`) | `drill-through-contract.md` section 4 | `route-state.test.ts` |
| Storage key family `backend-buddy:<project.key>:reviews` unchanged | C13; `explorer.html:39` | `decisions.test.ts` (W02) |
| Unknown stays unknown: `nullable` exported as `true | false | unknown`; no `0` for missing counts | C01, CTQ-01 | `csv.test.ts`, `key-logic.test.ts` |
| Caveat wording from `caveat-strings.ts` only | `docs/reference/caveats.md` | `caveats.test.ts`, docs lint DL-05 |
| `normalize()` is the oracle; no reimplementation of its rules in `review-logic.ts` | D3 | `test_renderer.py` |
| Project-neutral fixtures: expected counts derived from the loaded graph | ADR-0007 | `scripts/private_data_guard.mjs` |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with the F/CTQ id, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F01-F04, F22; F19 section 14)
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (CSV vectors, SQL quoting and dialect gate, no `innerHTML`, sql-path-lint green)
- [ ] Accessibility result recorded (axe 0 serious/critical on the four views x 2 themes x 1366/390 in the SPA and in the artifact via `verify_host.mjs`; keyboard: tab through map nodes and edges, activate with Enter)
- [ ] Performance measurement recorded: artifact size before and after deletion; shell budget still passes
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts`
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: parity test green on the pre-deletion commit (link the CI run in the PR body)
- [ ] Package-specific: `grep -c -E 'function (renderMap|renderEntities|renderKeys|renderReview|buildFindings)\(' skill/assets/explorer.html` equals 0 after deletion

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test                                                  # map-layout, key-logic, review-logic (parity), csv, svg-export, sql-path-lint
npm run build
git diff --exit-code skill/assets/extensions
node scripts/sql-path-lint.mjs                            # exit 0
python -m unittest discover -s skill/scripts -p 'test_renderer*.py'     # S01 tests unchanged and green
node scripts/verify_host.mjs dist/backend-buddy.html <out> --widths=1920,1366,390
npx playwright test tests/e2e/views/map.spec.ts tests/e2e/views/entities.spec.ts tests/e2e/views/keys.spec.ts tests/e2e/views/review.spec.ts
npx playwright test tests/security/artifact.spec.ts       # CTQ-05 csp byte-identical; zero external requests
npx playwright test tests/a11y/routes.spec.ts
grep -c -E 'function (renderMap|renderEntities|renderKeys|renderReview|buildFindings)\(' skill/assets/explorer.html   # expected: 0
```

Package-specific assertions: `<out>/report.json` has `externalRequests: []`; the CSV export of the review view on the `hostile` fixture contains no cell starting with `=`, `+`, `-`, `@`, tab, or CR after optional whitespace; the review view on the medium fixture with `project.dialect` set to a non-supported value shows the explicit "no SQL" message and no `BEGIN`.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-01 private-data leakage | No count literals; fixtures only; guard in acceptance. |
| RK-02 contract churn | Uses C03 types as frozen; `v.*` names only from the allowlist. |
| RK-05 remount lifecycle | Ported views are function components with prop-driven layout; component tests for filter-change props. |
| RK-12 silent build degradation | After deletion the host depends on the bundle for all 13 views; the PR records the artifact size and the `artifact` CI job result. |
| RK-13 finding ids reopen decisions | Id scheme kept for parity; report any orphaned-decision count observed on fixtures. |
| RK-15 uncollected browser tests | The four new suites live under `tests/e2e/views/` and run in CI (S02 wiring). |
| RK-17 theme fallbacks | New CSS uses tokens only; `check-hardcoded-colors.mjs` green. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
