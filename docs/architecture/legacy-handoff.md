Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Legacy Handoff (pre-repository baseline)

## React Solution Handoff

## Objective

Turn the standalone Backend Buddy visualization into a reusable React solution
for exploring, comparing, documenting, and reviewing schemas across multiple projects.
This project extraction is complete; choosing and implementing the new React application shell
is the next development phase, not work claimed as already delivered.

## Preserved Capabilities

- Relational map with click-drag panning, zoom, neighborhood focus, and SVG export.
- Entity and PK/FK indexes, comparison, search, filtering, and schema review decisions.
- Living ERD with React Flow, d3-force layout, semantic zoom, pins, and SVG/PNG export.
- Row Fan-out with d3-sankey, bounded depth, collapse/expand, and optional read-only subtree counts.
- Column Table with type families, key/index/nullability badges, profiling, and review filters.
- Schema City with react-three-fiber, domain colors, persistent labels, treemap districts,
  log row-count heights, left-drag pan, right-drag orbit, and accessible flat SVG fallback.
- Normalization Lens with explained heuristic flags and sampled functional dependencies.
- Schema Diff with local A/B snapshots, union differences, DDL comparison, and draft PostgreSQL
  and MySQL migration SQL. Its union diagram currently uses SVG, not the Living ERD React Flow renderer.
- Join Matrix, dependency Arc Diagram with cycles, and discovered Domains with bundled edges.
- Dark/light/system theme and shared inspector integration.

## Source and Data Boundaries

The original private example snapshot stays in the owner's local copy; its table, column, and relationship counts are not recorded in this repository.
It is ORM/source documentation, not proof of the current deployed database schema. It has no
measured row counts. Missing values must remain unknown; never substitute column counts or
synthetic values to make building heights or fan-out widths look populated.

The canonical interfaces live in `packages/explorer/src/types.ts`. The portable normalization
and HTML renderer live in `skill/scripts/build_explorer.py`; the data contract and extraction
guidance are under `skill/references`.

The existing Python service supports explicitly selected SQLite and PostgreSQL read-only access.
Profile at most 10,000 rows per table; subtree traversal is at most four hops with at most
10,000 retained rows per hop. A capped sample cannot establish an exact total row count.
Only opt-in sample values should enter exported snapshots. Min/max can also be sensitive.
No live PostgreSQL UAT or production data profiling was performed for this extraction.

## Proposed React Migration

1. Introduce a React application shell and project/snapshot state while retaining the existing
   SchemaGraph contract and proven feature components. Pick routing/build infrastructure as part
   of that implementation; the current esbuild package builds an embeddable library, not an SPA.
2. Migrate the HTML host's theme, navigation, filters, inspector, base map, entity index, key index,
   and review state to React components. Keep per-project and per-snapshot persistence isolated.
3. Add snapshot import/export and project switching. Replace any source-project-specific QA assumptions
   with generic fixtures and schema-derived assertions.
4. Integrate the read-only adapter as a deliberate, separately configured mode. Keep credentials
   out of browser bundles and do not execute draft migration SQL from the explorer.
5. Preserve an offline/exportable artifact mode and make documentation regeneration reproducible.

## Acceptance Gates

- Reproduce current functionality against both the private example snapshot and synthetic
  schemas with measured counts, composite keys, missing metadata, empty schemas, and cycles.
- Test at 1920, 1366, and 390 pixel widths, dark/light modes, and inspector open/closed.
- Zoom, then drag from empty map space, table geometry, and persistent labels. Panning must work
  without selecting text or accidentally opening the inspector. Ordinary clicks must still inspect.
- Verify 3D canvas pixels, camera motion, touch navigation, flat fallback, and exports.
- Preserve the offline CSP; document any deliberate live-mode policy change.
- Keep migrations labeled draft and flag incomplete/unsupported metadata rather than guessing SQL.

## Provenance

Extracted on 2026-09-07 from the source project's worktree visualization work. The source snapshot's
own provenance remains in its JSON. The original HTML bytes and the separately regenerated portable
baseline are archived in the owner's local copy, outside this repository. The original checkout,
installed personal skill, and open visualization were intentionally retained. No hosting deployment
was performed.

## Extraction Validation

Validated in the owner's local copy on 2026-09-07, before this repository existed:

- Clean dependency restore with the preserved package lock completed.
- Root build regenerated `dist/backend-buddy.html` using only files in that copy.
- TypeScript typecheck passed.
- Feature suite: 75 passed, 2 opt-in browser suites skipped by that unit-test command.
- Read-only service suite: 51 passed using synthetic SQLite fixtures, not a live PostgreSQL source.
- Portable renderer suite: 9 passed.
- Browser baseline passed at 1920, 1366, and 390 pixel widths, including themes, indexes,
  comparison, and layout bounds. Screenshots are archived in the owner's local copy.
- Click-drag pan regression passed at 1366 and 390 pixel widths, including drags starting
  on table nodes and ordinary click-to-inspect behavior.
- The original HTML matched its archived copy by SHA-256; the hash stays in the owner's local copy.

## Dependency Follow-up

> **D02 note (2026-09-07):** historical and resolved. The lockfile now resolves esbuild 0.27.7 (`packages/explorer/package-lock.json:1275`) and the advisory below was fixed upstream in esbuild 0.25.0 (approved plan); no follow-up remains.

`npm audit` reports one low-severity advisory for esbuild 0.27.3:
`GHSA-g7r4-m6w7-qqqr`, concerning its Windows development-server behavior.
The current build calls esbuild's bundle API and does not start that development server.
The existing lockfile was preserved for extraction reproducibility; evaluate an updated esbuild
release before introducing the React development server. No forced dependency upgrade was applied.

## Not Claimed

This is not a completed React SPA, deployment, live database schema verification, or production UAT.
Historical Word and spreadsheet documents were preserved, not regenerated. The independent
project was extracted non-destructively; original source files and the installed personal skill
were not removed or redirected.

## Superseded by CTQs (D02 note)

> Archived from the pre-repository extraction on 2026-09-07 and kept for provenance. The acceptance gates above are superseded by `docs/product-management/ctq.md`. Private example data referenced above stays in the owner's local copy and is never part of this repository; its counts are not recorded here (ADR-0007, Decision 1). This note is placed at the end of the file so that the line numbers of the archived text above, which `docs/reference/caveats.md` cites, stay stable.

**Gate mapping.** The six acceptance gates under "Acceptance Gates" are carried forward as CTQs; the CTQ registry (`docs/product-management/ctq.md`) is the enforced version and the gate `G2` criteria in the approved plan are their measurement.

| Legacy gate | CTQ ids | Notes |
|---|---|---|
| 1. Reproduce current functionality against the private snapshot and synthetic schemas (measured counts, composite keys, missing metadata, empty schemas, cycles) | CTQ-01, CTQ-10, CTQ-14 | Synthetic fixtures from R01 replace the private snapshot in the repository; the owner's local `--schema` build covers the private case outside the repo. |
| 2. Test at 1920, 1366, 390 px, dark/light, inspector open/closed | CTQ-02 | Matrix run by `scripts/verify_host.mjs` (S02) and the SPA e2e (W01). |
| 3. Zoom, then drag from empty space, table geometry, and labels; pan without selecting text or opening the inspector; ordinary clicks still inspect | CTQ-03 | Map, City 3D and flat, Living ERD. |
| 4. Verify 3D canvas pixels, camera motion, touch navigation, flat fallback, and exports | CTQ-04, CTQ-09, CTQ-16 (export audit) | Flat fallback under `--use-gl=disabled`; frame budget in Q01; exports non-empty at G2. |
| 5. Preserve the offline CSP; document any deliberate live-mode policy change | CTQ-05, CTQ-07 | Byte-identical string in ADR-0006; live-mode changes recorded in S03 and `docs/architecture/security-architecture.md`. |
| 6. Keep migrations labelled draft; flag incomplete or unsupported metadata rather than guessing SQL | CTQ-06 | Caveat C04 wording in `docs/reference/caveats.md`; static lint plus API test. |
