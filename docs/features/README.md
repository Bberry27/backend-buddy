Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Feature registry (F01-F22)

One row per feature. The registry is the index for `docs/features/F##-<slug>.md` (written in D05, each following `_template.md`). Ids are stable: a feature keeps its id even if its name changes. CTQ ids resolve in `docs/product-management/ctq.md` (D04); caveat ids resolve in `docs/reference/caveats.md`.

## Columns

- **status** `existing` = works today in the artifact; `partial` = a real implementation exists but the intended behaviour is materially incomplete; `planned` = no product-level implementation yet. The approved plan groups F16-F22 as planned for template purposes (sections 8-12 may be stubbed until their build work package); the status column below records the finer-grained truth.
- **owner role** a role, not a person. Roles used: Frontend lead, Backend lead, Security lead, Platform lead, Design and accessibility lead, Product owner.
- **surfaces** view ids as registered in the `mount()` component map at `packages/explorer/src/index.tsx:22` (`fanout|columns|city|living|lens|domains|matrix|arcs|diff`) and in the host tablist at `skill/assets/explorer.html:22` (`data-view="map|entities|keys|review"` plus the nine React ids); `host` = vanilla-JS host in `explorer.html`; `API` = planned FastAPI routes (D2/A0x); `SPA` = planned `packages/web` routes.
- **CTQs** the CTQs whose measurement includes this feature. CTQ-12 (test health), CTQ-13 (docs-code sync), and CTQ-14 (private-data hygiene) apply to every feature and are not repeated.
- **caveats** caveat ids the feature must surface (see "Where surfaced" in `caveats.md`).

## Registry

| id | name | slug | status | owner role | surfaces | CTQs | caveats | doc |
|---|---|---|---|---|---|---|---|---|
| F01 | Relational map | `F01-relational-map.md` | existing | Frontend lead | host view `map` (`explorer.html`); SPA route `.../map` (W03) | CTQ-02, 03, 10, 11 | C01, C07, C11 | D05 |
| F02 | Entity index | `F02-entity-index.md` | existing | Frontend lead | host view `entities`; SPA route `.../entities` (W03) | CTQ-02, 10, 11 | C07 | D05 |
| F03 | PK/FK index | `F03-pk-fk-index.md` | existing | Frontend lead | host view `keys`; SPA route `.../keys` (W03) | CTQ-02, 10, 11 | C06, C07 | D05 |
| F04 | Schema review | `F04-schema-review.md` | existing | Frontend lead | host view `review` (7-rule findings engine, read-only validation SQL); SPA route `.../review` (W03); API `PUT/GET /reviews/{findingId}` (A04) | CTQ-02, 06, 10, 11, 16 | C04, C07, C08, C13 | D05 |
| F05 | Living ERD | `F05-living-erd.md` | existing | Frontend lead | view `living` (`LivingERD.tsx`, React Flow) | CTQ-02, 03, 09, 10, 11 | C01, C07, C10, C13 | D05 |
| F06 | Row fan-out | `F06-row-fanout.md` | existing | Frontend lead | view `fanout` (`Fanout.tsx`); live `POST /api/subtree` (`serve_explorer.py`) | CTQ-01, 02, 08, 10, 11 | C01, C02, C05, C14 | D05 |
| F07 | Column table | `F07-column-table.md` | existing | Frontend lead | view `columns` (`ColumnTable.tsx`) | CTQ-01, 02, 10, 11 | C01, C05, C06 | D05 |
| F08 | Schema City | `F08-schema-city.md` | partial | Frontend lead | view `city` (`City.tsx`, `CityDistricts` wrapper in `index.tsx`) | CTQ-01, 02, 03, 04, 09, 10, 11 | C01, C02, C03, C13, C16 | D05 (fully worked for G0) |
| F09 | Normalization lens | `F09-normalization-lens.md` | existing | Frontend lead | view `lens` (`NormalizationLens.tsx`); live `POST /api/profile` | CTQ-01, 02, 08, 10, 11 | C01, C05, C08, C14 | D05 |
| F10 | Schema diff | `F10-schema-diff.md` | existing | Frontend lead | view `diff` (`SchemaDiff.tsx`) | CTQ-02, 06, 07, 10, 11 | C04, C09, C15 | D05 |
| F11 | Join matrix | `F11-join-matrix.md` | existing | Frontend lead | view `matrix` (`JoinMatrix.tsx`) | CTQ-02, 09, 10, 11 | C07, C11 | D05 |
| F12 | Arc diagram | `F12-arc-diagram.md` | existing | Frontend lead | view `arcs` (`ArcDiagram.tsx`) | CTQ-02, 10, 11 | C07, C12 | D05 |
| F13 | Domains | `F13-domains.md` | existing | Frontend lead | view `domains` (`Domains.tsx`) | CTQ-02, 10, 11 | C03, C11 | D05 |
| F14 | Drill-through navigation | `F14-drill-through-navigation.md` | partial | Frontend lead | all 13 views; host `onSelectTable`/`onSelectTables` up-channel; `selection.ts`, `route-state.ts`, `view-state.ts`, `navigation.ts`, `mount-policy.ts`, `caveat-strings.ts` and the additive `ViewProps` fields (C03); view wiring and SPA route `/w/:ws/p/:project/s/:snapshot/:view` (W04, W01) | CTQ-03, 10, 11 | C13 | D05 (fully worked for G0) |
| F15 | Inspector | `F15-inspector.md` | partial | Frontend lead | host `#side`/`#detail` (`explorer.html`); planned `Inspector.tsx` (W02) | CTQ-02, 10, 11 | C07, C08, C13 | D05 |
| F16 | Projects and snapshots | `F16-projects-and-snapshots.md` | planned | Backend lead | API workspaces/projects/snapshots routers (A04); SPA project page and upload page (W01) | CTQ-01, 07, 15, 16 | C09, C13 | D05 |
| F17 | Connections and profiling | `F17-connections-and-profiling.md` | partial | Backend lead | `packages/explorer/server/schema_profiler.py` and `serve_explorer.py` today; planned `packages/profiler`, connections router, jobs and worker (A03, A04); SPA connections page (W01) | CTQ-01, 07, 08, 09, 16 | C01, C05, C09, C14 | D05 |
| F18 | Insights and recommendations | `F18-insights-and-recommendations.md` | planned | Product owner | planned `InsightsView` and `insights-logic.ts` (W06) | CTQ-01, 10, 11 | C05, C07, C08 | D05 (MVP v0) |
| F19 | Exports | `F19-exports.md` | partial | Frontend lead | CSV/SVG in host views, SVG/PNG in `LivingERD.tsx`, CSV in `ColumnTable.tsx`, draft SQL in `SchemaDiff.tsx`; planned `export` job and artifact download (A04) | CTQ-05, 06, 07, 16 | C04, C05, C13 | D05 |
| F20 | Auth and workspaces | `F20-auth-and-workspaces.md` | planned | Security lead | API accounts, sessions, CSRF, RBAC, API keys (A02); SPA `/login`, `/w/:ws` (W01) | CTQ-07, 16 | C13, C14 | D05 |
| F21 | Theming and design tokens | `F21-theming-and-design-tokens.md` | partial | Design and accessibility lead | 16 CSS variables in `explorer.html:9-10`, mirrored byte for byte by `packages/explorer/src/tokens.css` with the semantic tokens and the six data palettes; `palettes.ts` (the values as TypeScript, `domainColor()`), `color-math.ts` (contrast, CIEDE2000, dichromat simulation), `theme.tsx` (`ThemeProvider`, `useTheme`, one shared `useThemeDetector`), `scripts/check-hardcoded-colors.mjs` (C02); toggle in W01 | CTQ-02, 04, 11 | C16 | D05 |
| F22 | Offline artifact and skill | `F22-offline-artifact-and-skill.md` | existing | Platform lead | `skill/` (renderer `build_explorer.py`, `explorer.html`, hardened `serve_explorer.py`); export path via esbuild IIFE (`packages/explorer/build.mjs`) | CTQ-05, 08, 09, 14 | C04, C09, C13, C14 | D05 |

## Rules

1. Adding a feature means adding a row here, a document from `_template.md`, and a line in `docs/product-management/traceability.md`. The docs lint (Q05) fails when a row has no document or a document has no row.
2. Status changes are made in the same PR as the code that changes them, with section 14 of the feature document appended.
3. Branch names, commit scopes, test names, and CHANGELOG lines carry the feature id (`feat(F08): ...`).
4. Caveat text in any feature document is quoted from `docs/reference/caveats.md`, never paraphrased.
