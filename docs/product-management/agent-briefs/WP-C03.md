Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-C03 Navigation contract

| Field | Value |
|---|---|
| Work package | C03 (track C, phase 1) |
| Features | F14, F15 (caveat strings the inspector will consume), F08 (view-state slice), F05 (fingerprint extracted from `snapshotKey`), F22 (root reuse in the IIFE) (F14 and F08 have no feature document yet; registry rows `docs/features/README.md:26`, `:32`; F14 is required at G0) |
| CTQs | CTQ-07 (deep-link hygiene: allowlist, 200-character cap, unknown ids dropped), CTQ-10 (no remount on filter change; registry P1-P10 is the source of the e2e matrix), CTQ-13 (`caveats.test.ts` mirrors `caveats.md`) |
| Caveats | C01-C16 (all sixteen are mirrored verbatim into `caveat-strings.ts`); C13 is the one this package's storage code directly implements, quoted in section 7 |
| Depends on | C01 (generated types re-exported by `types.ts`), D00 (`docs/reference/caveats.md`; wording frozen at G0, see open question 1) |
| Blocks | W01, W02, W03, W04, W05 |
| Branch | `c03/navigation-contract` |
| Gate | G1 |

### 1. Goal

Deliver the shell-neutral navigation contract as pure, node:test-covered modules in `packages/explorer/src`: additive optional `ViewProps` fields (`selected?`, `onSelectColumn?`, `onSelectRelationship?`, `onNavigate?`, `viewState?`, `onViewStateChange?`, `fullGraph?`, `theme?`) with `onSelectTable` unchanged so the nine views compile untouched; `selection.ts`; `route-state.ts` (parse and canonical serialize of `t c r ts f q d k` and per-view `v.*`, 200-character cap, unknown ids dropped with a warning); `view-state.ts` (graph fingerprint extracted from `living-logic.snapshotKey` with unchanged output; per-view slice key `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>`); `navigation.ts` (registry entries P1-P10 with `targetsFor` and `resolve`); `mount-policy.ts` plus `index.tsx` root reuse (props update instead of remount when the view id is unchanged); `caveat-strings.ts` with `caveats.test.ts` asserting equality with `docs/reference/caveats.md`. No view is wired in this package; W04 does that against this frozen contract.

### 2. Reading list (ordered)

1. `docs/architecture/drill-through-contract.md` in full: section 2 (`Selection`, `NavigationTarget`, `ViewId` including `insights`), section 3 (the additive `ViewProps`, the `onSelectTables` fallback pattern as the model), section 4 (route grammar, canonical serialization, the per-view `v.*` allowlist table: frozen here), section 5 (view-state layers and the fingerprint extraction), section 6 (registry P1-P10, `targetsFor`, `resolve`), section 7 (highlight rules W04 implements), section 8 (prefill, never execute), section 9 (storage isolation), section 10 (tests named per module), section 11 (open questions).
2. `docs/architecture/adr/ADR-0004-selection-and-routing-contract.md` (decisions 1-8) and `ADR-0002-frontend-spa-and-iife-export-path.md` decision 3 (root reuse: `mount()` re-renders when the view id is unchanged, unmounts only on view change) and decision 2 (`packages/explorer` stays `node:test` only; no router, fetch, Vitest).
3. `docs/architecture/schema-graph-contract.md` B3 (id forms `table.id`, `table.id#column`, `constraintId` else `source.column>target.targetColumn`, opaque finding id, domain string) and the `#`/`>` note (open question 2).
4. `docs/features/F15-inspector.md` sections 4-5 (the "Open in ..." menu W02 builds from the registry; which caveats the inspector shows) and `docs/features/F04-schema-review.md` section 5 (review `v.*` keys `rule`, `category`, `status`).
5. `docs/reference/caveats.md` in full (the sixteen canonical blockquotes; the "Where surfaced" lists).
6. `docs/product-management/traceability.md` section 4 rules DL-04, DL-05 (verbatim after whitespace normalization; paraphrase detector) and section 1 (`P([1-9]|10)` id pattern).
7. `docs/product-management/risk-register.md` RK-05 (root reuse changes lifecycle assumptions: `City.tsx:309` clears selection on layout change; Schema Diff holds loaded snapshots in state), RK-19 (storage origin split), RK-02.
8. Code, in this order:
    - `packages/explorer/src/types.ts` after C01 (hand-written `SubtreeResult`, `ProfileResult`, `LiveConnection`, `ViewProps {graph, onSelectTable, onSelectTables?, live?}` at today's `:7-10`).
    - `packages/explorer/src/index.tsx` (22 lines): module-level `root` `:15`, `CityDistricts` wrapper `:16-20` (holds `mode` state; a remount loses it), `unmount()` `:21`, `mount()` `:22` (`unmount(); root=createRoot(container); ... root.render(...)`; the component map keyed by the nine view ids).
    - `packages/explorer/src/living-logic.ts:67` (`hash`, FNV-1a), `:68-73` (`snapshotKey`: identity `source.hash ?? source.sourceHash ?? source.sha256 ?? graph.sourceHash`, else the hash of sorted `source`, `tables`, `links`; key `backend-buddy-erd:v1:<project.key|name|'local'>:<fingerprint>`), `:75-86` (`parsePositions` bounds validation: the pattern for validating persisted values), `:87-92` (`readPositions`/`savePositions` try/catch); `living-logic.test.ts` (must stay green; add a regression case pinning `snapshotKey` output on a fixed graph).
    - `packages/explorer/src/JoinMatrix.tsx:116` (`if (onSelectTables) onSelectTables(ids); else onSelectTable(...)`) and `ArcDiagram.tsx:56`: the fallback idiom.
    - `skill/assets/explorer.html:37` (`state`), `:39-40` (`backend-buddy:<project.key>:reviews`, `:theme`), `:63-64` (`selectTable`, `selectTables`), `:178` (host `render()` after S01: unmounts only on view change), `:195` (`mount($('extensionHost'), state.view, {graph, onSelectTable, onSelectTables, live})`): the props the artifact passes today; C03 does not change this call (L-05 adds `selected`/`viewState`/`onNavigate` from `location.hash`).
    - `packages/explorer/src/City.tsx:309` (`useEffect(() => { setHovered(null); setSelected(null); }, [layout])`) and `SchemaDiff.tsx` state: read only, to write the RK-05 note in `mount-policy.ts`.
    - `fixtures/schemas/small.json`, `medium.json` (ids for route-state tests: dotted ids, composite `constraintId`, inferred links).
9. `AGENTS.md` sections 5-7. `docs/engineering/standards.md` (D03) does not exist yet.

### 3. In scope

1. **`types.ts`**: add the eight optional fields exactly as `drill-through-contract.md` section 3 lists them, importing `Selection` and `NavigationTarget` from `selection.ts`; `theme?: 'light' | 'dark'`; nothing removed or renamed. `npm run typecheck` passes with the nine views untouched.
2. **`selection.ts`**: `ViewId` union (`map entities keys review fanout columns city living lens domains matrix arcs diff insights`), `Selection`, `NavigationTarget`, helpers `columnId(tableId, column)`, `relationshipRef(link)` (`constraintId` else `source.column>target.targetColumn`), `parseColumnId`, `resolveRelationshipRef(ref, graph)`, `validateSelection(selection, graph)` (drops unknown ids with `console.warn`, enforces "exactly one of `tableId`/`tableIds`"). Separator safety per open question 2.
3. **`route-state.ts`**: `parseRouteState(search: string, view: ViewId, graph?: SchemaGraph): RouteState`, `serializeRouteState(state): string` (fixed key order `t c r ts f q d k` then `v.*` sorted; `encodeURIComponent`; no empty values; two equal states produce byte-identical strings), `VIEW_STATE_ALLOWLIST: Record<ViewId, readonly string[]>` frozen to the section 4 table (`fanout: root depth pk`; `columns: family only page`; `city: mode districts`; `living: junctions focus`; `lens: flagged page size`; `domains: community page`; `matrix: order related`; `arcs: cycle`; `diff: dialect side`; `map: zoom focus link`; `keys: kind`; `review: rule category status`; `entities: sort compare`; `insights: kind`), `MAX_VALUE_LENGTH = 200`, undeclared `v.*` names and over-length values dropped with a warning, `fromHash(hash)`/`toHash(state)` for the artifact (`#t=...`), unknown ids dropped after validation against the graph.
4. **`view-state.ts`**: `graphFingerprint(graph)` extracted from `snapshotKey` (identical output for identical input: the function body moves, `living-logic.ts:68-73` calls it, and `snapshotKey`'s returned string is unchanged), `viewStateKey(graph, view)` = `backend-buddy:view-state:v1:<encodeURIComponent(project.key || project.name || 'local')>:<fingerprint>:<view>`, `readViewState(graph, view, validate)`/`writeViewState(graph, view, value)` with try/catch and bounds validation in the style of `parsePositions` (`living-logic.ts:75-86`), `MVP slices` typed: City `{mode, districts, camera?: {position, target}}`, map `{pan, zoom}`, diff `{a?, b?}` (fingerprint references), fanout `{collapsed: string[]}`.
5. **`navigation.ts`**: `entries: NavigationEntry[]` with ids `P1`..`P10` exactly as `drill-through-contract.md` section 6 (each with `from: ViewId | 'inspector'`, `to: ViewId`, `requires` selection shape, `label`, `viewState` producer, `prefillOnly?: true` for P10's `v.pk` and P2's `v.root`), `targetsFor(selection, currentView): NavigationEntry[]`, `resolve(entryId, selection, graph): NavigationTarget` (throws on an unknown entry; returns a target whose `selection` passed `validateSelection`). This table is what W02's menu, W04's context menus, and the generated e2e matrix read.
6. **`mount-policy.ts`** and **`index.tsx`**: `decideMount(previous: {container, view} | undefined, next: {container, view}): 'create' | 'update' | 'recreate'` (pure, tested); `index.tsx` keeps `root` and the last `{container, view}`, calls `root.render(<Component {...props}/>)` on `'update'`, and unmounts and recreates only on `'recreate'` or `'create'`; `unmount()` unchanged. Export `mountCount()` (module counter, incremented on create/recreate only) for harnesses. `CityDistricts` stays as is (its `mode` state now survives filter changes; W05 moves it). Write the RK-05 note as a comment referencing `City.tsx:309` and Schema Diff state.
7. **`caveat-strings.ts`**: `export const CAVEATS: Record<'C01' | ... | 'C16', {id, title, text}>` with `text` equal to the canonical blockquote of `docs/reference/caveats.md` and `title` equal to the heading after the id; `caveats.test.ts` reads `../../../docs/reference/caveats.md` relative to the test file, extracts each `## C## <title>` heading and its first blockquote, normalizes whitespace, and asserts equality for all sixteen (missing or extra ids fail). The test is excluded from the skill copy's runnable set (the skill does not carry `docs/`); note this in the file header.
8. **Tests** (node:test, names prefixed `F14`/`CTQ-10`/`CTQ-07`/`CTQ-13` per `traceability.md`): `selection.test.ts`, `route-state.test.ts` (round-trip on `small.json` and `medium.json` ids incl. dotted ids and composite refs; cap; allowlist; unknown ids; hash form; canonical order), `view-state.test.ts` (fingerprint equals legacy `snapshotKey` suffix; key isolation across two projects and two fingerprints; invalid stored JSON ignored), `navigation.test.ts` (ten entries present; every `to` view has an allowlist covering the `viewState` it produces; `resolve` output validates; P2 and P10 marked prefill-only), `mount-policy.test.ts`, `caveats.test.ts`, plus the `snapshotKey` regression case in `living-logic.test.ts`.
9. **Documentation**: `docs/architecture/drill-through-contract.md` section 10 marked implemented with file paths; `docs/features/F15-inspector.md` and `F05-living-erd.md` sections 3 and 14; `docs/features/README.md` F14 row surfaces column (planned files now exist); `docs/reference/limits-and-caps.md` B row "Route `v.*` value length 200" gains the `route-state.ts` line; `CHANGELOG.md`.

### 4. Out of scope

- Wiring any view to `selected`, `onSelectColumn`, `onSelectRelationship`, `onNavigate`, `viewState`, `theme`, `data-selected`, `is-selected`, dimming, fly-to: W04 (and W05 for City). The nine `.tsx` files are not edited here.
- The inspector menu, breadcrumb, context menus, focus management: W02.
- `ViewHost`, router integration, `window.__backend-buddyMounts`, URL sync in the SPA: W01.
- Host `explorer.html` changes (passing `selected`/`viewState`/`onNavigate` from `location.hash`, writing the hash): L-05 (S01/S03 own the file in Phase 1).
- Moving `CityDistricts` into `City.tsx`: W05 item 8.
- `tests/e2e/drill-through.spec.ts` generation from the registry: W04.
- `caveats.md` wording changes: G0 freeze; if the freeze happens after C03 starts, the mirror is updated in the same PR that changes the source (frozen contract "Caveat wording").
- Any `.css`, token, or colour change: C02.
- Server-side `erd_layouts`: A04.

### 5. May modify

```
packages/explorer/src/types.ts                        (additive optional fields only)
packages/explorer/src/selection.ts, route-state.ts, view-state.ts, navigation.ts, mount-policy.ts, caveat-strings.ts   (new)
packages/explorer/src/selection.test.ts, route-state.test.ts, view-state.test.ts, navigation.test.ts, mount-policy.test.ts, caveats.test.ts   (new)
packages/explorer/src/index.tsx                       (root reuse; component map and CityDistricts unchanged)
packages/explorer/src/living-logic.ts                 (lines 67-73 only: fingerprint delegated to view-state.ts; snapshotKey output unchanged)
packages/explorer/src/living-logic.test.ts            (one added regression case)
docs/architecture/drill-through-contract.md           (section 10 status and file paths)
docs/features/F15-inspector.md, docs/features/F05-living-erd.md   (sections 3 and 14)
docs/features/README.md                               (F14 row surfaces column)
docs/reference/limits-and-caps.md                     (B row for the 200-character cap: add the code line)
CHANGELOG.md                                          ([Unreleased], prefixed C03:)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json, packages/explorer/package*.json   no dependency (no router, no jsdom)
packages/explorer/src/*.tsx             except index.tsx: City, LivingERD, JoinMatrix, ArcDiagram, Domains, Fanout, ColumnTable, NormalizationLens, SchemaDiff stay untouched (W04/W05)
packages/explorer/src/*.css             C02
packages/explorer/src/contract.generated.ts   generated by scripts/gen_contract.mjs (C01)
packages/explorer/src/*-logic.ts        except living-logic.ts lines 67-73
skill/assets/explorer.html              S01 / S03; the mount call at :195 keeps passing {graph, onSelectTable, onSelectTables, live}
skill/scripts/**, packages/explorer/server/**
docs/reference/caveats.md               frozen at G0; the mirror follows the source, never the reverse
.github/workflows/**                    S02
scripts/**                              S02 (verify_host remount counter flips to a hard assertion in this package's acceptance, using the existing S02 flag)
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| `ViewProps` additive fields: `onSelectTable(id)` signature unchanged; new fields optional: `selected?`, `onSelectColumn?`, `onSelectRelationship?`, `onNavigate?`, `viewState?`, `onViewStateChange?`, `fullGraph?`, `theme?` | `drill-through-contract.md` section 3; ADR-0004 decision 2 | `npm run typecheck` with untouched views; `navigation.test.ts` |
| Route grammar: `/w/:ws/p/:project/s/:snapshot/:view`; keys `t c r ts f q d k`; `v.*` allowlisted per view (the section 4 table); values capped at 200; unknown ids dropped with a warning; artifact shares the grammar via `location.hash` | `drill-through-contract.md` section 4; ADR-0004 decision 3 | `route-state.test.ts` |
| Id forms: `table.id`; `table.id#column`; `constraintId` else `source.column>target.targetColumn`; opaque finding id | `schema-graph-contract.md` B3 | `selection.test.ts` |
| Storage key families (C13): "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state." Keys: `backend-buddy:<project.key>:...` (`explorer.html:39`), `backend-buddy-erd:v1:<project.key>:<fingerprint>` (`living-logic.ts:72`), new `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>`; never unscoped | `docs/reference/caveats.md` C13; `drill-through-contract.md` section 5 | `view-state.test.ts`; `living-logic.test.ts` `snapshotKey` regression |
| `snapshotKey()` output unchanged for every input (saved Living ERD layouts are not orphaned) | `living-logic.ts:68-73` | `living-logic.test.ts` new case with a fixed expected string |
| Registry P1-P10 ids and directions exactly as `drill-through-contract.md` section 6; new entries only through a contract-document change | ADR-0004 decision 5 | `navigation.test.ts` asserts the ten ids and `from`/`to` pairs |
| Prefill, never execute: P2 (`v.root`) and P10 (`v.pk`) are `prefillOnly`; no module in this package performs I/O or calls `live.*` | `drill-through-contract.md` section 8; CTQ-06 | `grep -c 'live\.' packages/explorer/src/{selection,route-state,view-state,navigation,mount-policy}.ts` = 0 |
| Caveat wording: `caveat-strings.ts` mirrors `caveats.md` verbatim | D8; DL-05 | `caveats.test.ts` |
| Mount API: `mount(container, view, props)` and `unmount()` names and signatures | `index.tsx:21-22`; `explorer.html:195` | `mount-policy.test.ts`; `verify_host.mjs` (S02) still mounts every React view |
| `packages/explorer` is `node:test` only; no router, fetch, or Vitest imports | ADR-0002 decision 2 | `npm run lint` (S02 ESLint `no-restricted-imports`) |
| Artifact CSP, host CSS variables, `normalize()` oracle, profiler caps | repository-wide list | Untouched |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, names prefixed `F14`, `CTQ-07`, `CTQ-10`, `CTQ-13` as appropriate, green with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F15, F05; F14 has no document yet (D05, required at G0), so `docs/architecture/drill-through-contract.md` section 10 carries the implementation status until it exists
- [ ] Migration: none, because this package has no server-side state (`erd_layouts` is A04)
- [ ] `CHANGELOG.md` lines prefixed `- C03: `
- [ ] Release-note line in the PR body
- [ ] Security checklist (interim): deep-link inputs are parsed, capped at 200 characters, allowlisted, and validated against the graph before use; no `eval`, no `innerHTML`, no I/O in the new modules; `console.warn` messages contain the offending key name but never the full value
- [ ] Accessibility result: n/a, no UI change in this package (the artifact's rendered DOM is unchanged; `CityDistricts` select keeps its `aria-label`)
- [ ] Performance measurement: `mountCount()` observed constant across 20 filter keystrokes in the artifact (S02 `verify_host.mjs` remount counter, now a hard assertion); record the number of `mount()` calls per view switch (expected 1)
- [ ] Caveat text: `caveat-strings.ts` is the only new caveat surface; `caveats.test.ts` green
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed (`skill/assets/extensions/src` gains the new modules)
- [ ] All changed paths inside the `may-modify` globs; `git diff --stat` shows no view `.tsx` other than `index.tsx`

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order.

```sh
npm run restore
npm run guard
npm run typecheck                                                                  # nine views untouched, new optional fields compile
git diff --quiet main -- packages/explorer/src/City.tsx packages/explorer/src/LivingERD.tsx packages/explorer/src/JoinMatrix.tsx packages/explorer/src/ArcDiagram.tsx packages/explorer/src/Domains.tsx packages/explorer/src/Fanout.tsx packages/explorer/src/ColumnTable.tsx packages/explorer/src/NormalizationLens.tsx packages/explorer/src/SchemaDiff.tsx   # exit 0
npm test                                                                           # 75 existing + new module tests, 0 failures
node --test --import tsx packages/explorer/src/caveats.test.ts                     # 16 equalities
node --test --import tsx packages/explorer/src/route-state.test.ts packages/explorer/src/selection.test.ts packages/explorer/src/view-state.test.ts packages/explorer/src/navigation.test.ts packages/explorer/src/mount-policy.test.ts 2>&1 | grep -c '^not ok'   # 0
npm run lint                                                                       # after S02: no restricted imports in packages/explorer
grep -c "live\." packages/explorer/src/selection.ts packages/explorer/src/route-state.ts packages/explorer/src/view-state.ts packages/explorer/src/navigation.ts packages/explorer/src/mount-policy.ts | grep -v ':0' | wc -l   # 0
grep -c 'backend-buddy-erd:v1:' packages/explorer/src/living-logic.ts                     # 1 (key format unchanged)
grep -c 'backend-buddy:view-state:v1:' packages/explorer/src/view-state.ts                  # >= 1
npm run build
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host-c03 --widths=1366 --views=city,living,matrix   # remount counter: mount count constant across 20 keystrokes (hard assertion enabled)
node -e "const r=require('./outputs/verify-host-c03/report.json');const c=r.checks.filter(x=>/remount/i.test(x.name));if(!c.length||c.some(x=>!x.passed))process.exit(1);console.log(c.map(x=>x.name+': '+JSON.stringify(x.evidence)).join('\n'))"
```

Registry completeness check the verifier runs:

```sh
node --import tsx -e "import('./packages/explorer/src/navigation.ts').then(m=>{const ids=m.entries.map(e=>e.id).sort((a,b)=>+a.slice(1)-+b.slice(1));if(ids.join(',')!=='P1,P2,P3,P4,P5,P6,P7,P8,P9,P10'){console.error(ids);process.exit(1)};console.log('P1-P10 present')})"
```

### 10. Reporting format

Per `agent-briefs/README.md` section 10. "Frozen contracts" must include one line per row of section 7. Measurements: `mountCount()` per view switch and across 20 keystrokes; number of caveat strings mirrored (16). "Out of scope, found" at minimum: the RK-05 lifecycle observations for City (`City.tsx:309`) and Schema Diff, owner W04/W05; any `caveats.md` blockquote whose whitespace normalization was needed (owner D00/G0 review).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-02 contract churn | Freezes `ViewProps`, the route grammar, the `v.*` allowlist, and P1-P10 before W01; every later change goes through ADR-0004 revision |
| RK-05 remount fix changes lifecycle assumptions | Root reuse is enabled in the artifact by this package; because no view is wired to new props yet, the only observable change is that filter keystrokes update props instead of remounting. Run the six view suites (S02) and `verify_host.mjs` on all 13 tabs; report any view whose state now persists unexpectedly (City selection at `:309` clears on `layout` change, which still happens when `graph` changes) |
| RK-19 storage origin split | New keys are scoped by `project.key` and fingerprint (C13); no migration of existing keys; `living-erd:v1` untouched |
| RK-01 private-data leakage | Route and selection tests use `small.json`/`medium.json` ids only |
| RK-10 scope creep | No view wiring, no inspector, no host hash handling |
| RK-22 duplicated source trees | `npm run build` after the change |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). |

Open questions for the owner (needed before C03 starts):

1. `caveats.md` freezes at G0 with C12 and C15 "explicitly confirmed" (roadmap Gate G0). If C03 starts before G0 closes, `caveat-strings.ts` mirrors the current draft and any G0 wording change lands as a follow-up PR touching both files. Confirm that sequencing, or make G0 a hard prerequisite of C03.
2. Separator safety for id forms (`#` in `table.id#column`, `>` in the relationship fallback): `fixtures/schemas/hostile.json` has ids containing `>` and S01/C01 (their open question 1) assume no character ban. This brief's default: `selection.ts` percent-encodes `#`, `>`, `.`, `,` inside id components when building `c`, `r`, and `ts` values and decodes on parse, so any `table.id` round-trips. Confirm.
3. Whether `index.tsx` should also expose the mount counter as `window.__backend-buddyMounts` in the artifact (the plan names that hook for the SPA in W01) so `verify_host.mjs` reads it directly instead of wrapping `mount`. Default here: `mountCount()` export only; W01 decides the window hook.
