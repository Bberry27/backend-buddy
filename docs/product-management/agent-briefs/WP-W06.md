Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# WP-W06 Insights v0

| Field | Value |
|---|---|
| Work package | W06 (track W, phase 2) |
| Features | F18 (primary, MVP v0 slice); F15 (inspector section) |
| CTQs | CTQ-01, CTQ-10, CTQ-11 |
| Caveats | C05, C07, C08 (F18 registry row); C01, C02, C03, C12 appear in `caveats.md` "Where surfaced" for F18 and are surfaced by the corresponding item kinds pending `traceability.md` open question 4 |
| Depends on | W03, W04 |
| Blocks | Q04 |
| Branch | `f18/insights-v0` |
| Gate | G2 |

### 1. Goal

Add `insights-logic.ts` (pure) and `InsightsView` (view id `insights`) that aggregate existing signals into evidence-linked items: review findings (`review-logic.ts`), normalization analysis (`analyzeNormalization`), fan-out width, SCC cycles, unresolved inferred links, FK columns lacking an index, unprofiled tables, and widest tables. Every item carries the C08 wording ("review candidates, not verdicts" via `caveat-strings.ts`), its evidence (tables, columns, relationships, counts with unknown kept unknown), and one or more `onNavigate` targets from the registry. An inspector section lists the items for the selected table. A verifier can check the item kinds on the fixtures, that no item states a verdict or a fabricated number, and that every item's navigation target resolves through `navigation.ts`.

### 2. Reading list (ordered)

1. `docs/features/F18-insights-and-recommendations.md` (D05, MVP v0): sections 1-2 (the persona and the job), 4 (B-numbered item kinds for v0), 5 (`v.kind`; outbound `onNavigate` only), 7 (C05, C07, C08 quotes), 13 (open questions on ranking).
2. `docs/reference/caveats.md` C05, C07, C08 (and C01, C02, C03, C12 for the item kinds that encode counts, ratios, communities, and cycles).
3. `docs/architecture/drill-through-contract.md` sections 4 (`insights: kind`), 6 (targets are existing entries; Insights adds no registry entry at MVP), 7 (inbound `t` filters the list; outbound rule 2), 8.
4. `docs/architecture/adr/ADR-0004-selection-and-routing-contract.md`.
5. Existing pure modules to compose, not modify: `packages/explorer/src/review-logic.ts` (W03; 7 rules, finding ids), `lens-domain-logic.ts:114` `analyzeNormalization` (reviews and duplicates; `sampleDependencies` at `:90` is sample evidence, C05), `lens-domain-logic.ts:29` `computeCommunities` (C03), `dependency-logic.ts:35` `buildDependencyModel` and `:109` `dependencyTopology` (SCC cycles: `cyclic = members.length > 1 || selfLoop`, C12), `fanout-logic.ts:88` `buildFanout` and `:54` `localRatio` (C02 ratios; unknown when a count is unknown), `column-logic.ts:49` `tableColumnFacts` (FK columns, index flags), `living-logic.ts:7` `knownRows`.
6. `docs/reference/limits-and-caps.md` A3 (fan-out 400 nodes / 5,000 paths) so item computation reuses the capped model rather than re-traversing.
7. C03 deliverables (`navigation.ts` `targetsFor`/`resolve`, `caveat-strings.ts`, `route-state.ts`), W02 (`Inspector.tsx` section slot), W04 (inbound marker conventions).
8. `docs/engineering/standards.md`, `testing-policy.md`, `accessibility-standards.md` (D03).

### 3. In scope

- `packages/explorer/src/insights-logic.ts` (pure, node:test): `buildInsights(graph, options): InsightItem[]` where an item has `id` (stable, derived from kind + evidence ids), `kind` (one of the v0 kinds below), `title`, `evidence` (`tables[]`, `columns[]`, `relationships[]`, `counts` with `number | 'unknown'`), `why` (one sentence), `confirm` (what would confirm or dismiss, per C08), `caveats: CaveatId[]`, and `targets: NavigationTarget[]` produced by `navigation.resolve`.
- v0 item kinds: `review-finding` (one per `review-logic` finding, same id), `normalization` (from `analyzeNormalization` flagged reviews and duplicates), `fanout-width` (largest known local ratios; unknown ratios listed separately as `ratio unknown`), `cycle` (each SCC with more than one member, or self-loop), `unresolved-inferred` (links `kind: 'inferred by naming'` whose target is absent), `fk-without-index` (FK columns with `index: false` and not covered by a PK or index prefix), `unprofiled` (tables with `rowCount === null`; count of them, never a substituted value), `widest-table` (top N by `allColumns.length`).
- Ordering: deterministic (kind order then evidence ids); no scoring or confidence in v0 (F18 open question).
- `packages/explorer/src/InsightsView.tsx` + `InsightsView.css` (tokens only): list grouped by kind with `v.kind` filter, inbound `t` filters to items whose evidence includes the table (`data-selected="true"` on those items), each item renders its C08 line and its `targets` as buttons calling `onNavigate`; keyboard operable; `data-rowcount` on any count display (`unknown` preserved).
- Inspector section (W02 slot): items for the selected table, same rendering component.
- Registration under the view id `insights` in `index.tsx` and the SPA route table; tab label "Insights".
- Tests: `insights-logic.test.ts` on `small`, `medium`, `medium-measured`, `edge-cases`, `hostile`, `empty` fixtures (no throw; every target resolves; unknown counts stay `'unknown'`; hostile identifiers are plain strings); `InsightsView` component test; `tests/e2e/insights.spec.ts` (inbound `t`, `v.kind`, navigation to a target view shows `[data-selected="true"]`, no live request).
- F18 sections 3, 8-12 (unstub), 14; F15 section 14 row.

### 4. Out of scope

- Server-side insights, persistence of dismissals, or notifications (not in the MVP definition).
- Ranking, scoring, or "recommendation confidence" (F18 later; open question).
- New registry entries or `v.*` names beyond `insights: kind` (C03 change control).
- Changing any rule in `review-logic.ts` or output of the composed logic modules.
- Live profiling from the Insights view (arrival never profiles; the `unprofiled` item navigates to City B1 or Column Table where the user clicks).
- Exports of insights (F19 later).

### 5. May modify

```
packages/explorer/src/insights-logic.ts
packages/explorer/src/insights-logic.test.ts
packages/explorer/src/InsightsView.tsx
packages/explorer/src/InsightsView.css
packages/explorer/src/index.tsx                  (component map entry `insights` only)
packages/explorer/src/Inspector.tsx              (insights section slot only; coordinate with W02 owner if concurrent)
packages/web/src/**                              (route table entry and tab label only)
tests/e2e/insights.spec.ts
docs/features/F18-insights-and-recommendations.md   (sections 3, 8-12, 14)
docs/features/F15-inspector.md                   (section 14 only)
CHANGELOG.md                                     ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change in this brief
packages/explorer/src/types.ts          C01/C03 only
packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts   C03; read-only
packages/explorer/src/{review-logic,lens-domain-logic,dependency-logic,fanout-logic,column-logic,living-logic}.ts   composed, never edited here
packages/explorer/src/{City,LivingERD,Fanout,ColumnTable,NormalizationLens,Domains,JoinMatrix,ArcDiagram,SchemaDiff,MapView,EntityIndex,KeyIndex,ReviewView}.tsx
skill/assets/explorer.html              S01, S03, W03 only
skill/scripts/build_explorer.py         S01 only
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Heuristic findings are review candidates, not verdicts: every item shows the C08 string and names columns, evidence, why, and confirm/dismiss | C08 | `insights-logic.test.ts` asserts the four fields non-empty; `caveats.test.ts` |
| Unknown stays unknown: counts are `number | 'unknown'`; `unprofiled` never reports `0` rows | C01, CTQ-01 | `insights-logic.test.ts` on `medium.json`; `tests/e2e/rowcount.spec.ts` |
| Fan-out ratios are local factors; unknown when either count is unknown | C02; `fanout-logic.ts:54` | `insights-logic.test.ts` |
| Declared vs inferred stay distinguishable; unresolved inferred links produce no SQL | C07 | `insights-logic.test.ts` |
| Cycle = SCC with more than one member or self-loop | C12; `dependency-logic.ts:109` | `insights-logic.test.ts` reuses `dependencyTopology` |
| Sampled evidence is not proof; normalization items carry C05 | C05 | `insights-logic.test.ts` |
| Finding ids identical to `review-logic.ts` (no second scheme) | F04 B3 | `insights-logic.test.ts` |
| Navigation only through `navigation.resolve`; Insights adds no registry entry; `v.*` allowlist `insights: kind` | `drill-through-contract.md` sections 4, 6 | `navigation.test.ts`, `route-state.test.ts` |
| Selector contract `[data-selected="true"]`, `[data-rowcount]` | section 7 | `tests/e2e/insights.spec.ts` |
| No remount; views never touch `location` | `mount-policy.ts`; section 7 | `CTQ-10 no remount over 20 keystrokes` |
| Prefill, never execute | C14, CTQ-06 | `tests/e2e/insights.spec.ts` asserts no `/api/*` request |
| Caveat wording from `caveat-strings.ts` only | `docs/reference/caveats.md` | docs lint DL-05 |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `F18`/CTQ ids and `B#`, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F18 in full, unstubbing 8-12; F15 section 14 row)
- [ ] Migration: none, because insights are computed client-side from the loaded graph
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (schema text as React children; hostile fixture produces items without error; no network paths)
- [ ] Accessibility result recorded (axe 0 serious/critical x 2 themes x 1366/390; keyboard: filter by kind, activate a target)
- [ ] Performance measurement recorded: `buildInsights(medium)` wall time in node:test (no budget exists; record the number for Q01) and shell size within budget
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts`
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: the report lists each v0 item kind with its fixture count on `medium.json` (counts derived from the fixture at test time, not hardcoded)

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test                                                  # insights-logic.test.ts across six fixtures
npm --prefix packages/web test -- --coverage
npm run build
git diff --exit-code skill/assets/extensions
node scripts/size-budget.mjs
npx playwright test tests/e2e/insights.spec.ts            # inbound t, v.kind, target navigation, no /api request
npx playwright test tests/e2e/shell.spec.ts -g "insights" # CTQ-10 no remount
npx playwright test tests/a11y/routes.spec.ts -g "insights"
npx playwright test tests/e2e/rowcount.spec.ts -g "insights"    # data-rowcount unknown vs 0
```

Package-specific assertions: on `medium.json` the `unprofiled` item count equals `graph.tables.length` and no item contains the strings `verdict`, `violates`, or `is normalized`; on `hostile.json` the rendered view contains no `<script` text node and opens no dialog.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-03 docs-only drift | F18 sections 8-12 are unstubbed with tests that exist, not planned. |
| RK-10 scope creep | Scoring, dismissals, server persistence are refused and reported. |
| RK-13 finding ids | Reuse `review-logic` ids; do not introduce a parallel scheme. |
| RK-14 sensitive values | Items never include sample values or min/max; evidence is structural plus counts. |
| RK-05 remount lifecycle | Item list is memoised on the graph fingerprint; filter changes update props only. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
