Status: draft | Owner: Frontend lead | Last verified against code: branch `f19/view-exports` (2026-11-22)

# F19 Exports

| Field | Value |
|---|---|
| Status | partial |
| Owner | Frontend lead |
| Surfaces | host views `map` (SVG, CSV), `entities`, `keys`, `review` (CSV) in `skill/assets/explorer.html`; views `arcs`, `domains`, `city` (SVG, PNG), `columns` (CSV, HTML issue report, snapshot JSON), `living` (SVG, PNG), `diff` (draft SQL) in `packages/explorer/src`; planned `export` job and artifact download (A04) |
| CTQs | CTQ-05, CTQ-06, CTQ-07, CTQ-16 |
| Caveats | C04, C05, C13 |
| Last verified | branch `f19/view-exports` (2026-11-22) |

## 1. Purpose

Lets a person save what a view shows as a file they can hand to someone who does not run the explorer: a diagram as SVG or PNG, a table as CSV, and the Column Table as a self-contained HTML report with every detected issue highlighted and named. An export is a copy of snapshot evidence at one point in time, never a live result and never a verdict.

## 2. Driver

- **Persona**: P1 architect, P2 DBA/performance engineer, P5 engineering manager.
- **Job to be done**: "When I present a finding upward, I want an artifact that works with no network and carries its caveats, so that the reader trusts it and cannot mistake inference for fact." (`docs/business/business-case.md`)
- **Business metric**: to be validated.

## 3. Current state

Verified on branch `f19/view-exports`.

**Shared export logic (`packages/explorer/src/export-logic.ts`)**

- `csvCell` (`:36`) is the S01 spreadsheet-formula guard, byte-compatible with the host's `cell=v=>` (`skill/assets/explorer.html:182`); `export-logic.test.ts` extracts the host guard and asserts identical output for the formula vectors. `toCsv` (`:44`) writes a UTF-8 BOM, `# ` provenance preamble lines (each one guarded cell), a header and CRLF rows.
- `provenanceOf` / `provenanceLines` (`:71`, `:86`) carry project name and key, `source.generated`, `source.basis`, source file, commit and SHA-256, and the export time; an absent field reads `not recorded`.
- `COLUMN_ISSUES` (`:129`) names seven issues, each derived from facts `column-logic.ts` already computes for the Column Table: table scope `No primary key recorded` (no column has `ColumnFacts.primary`) and `Row count unknown` (`knownCount(rowCount)` false; a measured 0 is not unknown); column scope `Unindexed declared FK` (`unindexedDeclared`), `Nullable declared FK` (`foreign` and `nullableState === 'nullable'`), `Inferred relationship only` (`inferred && !foreign`), `_id without declared FK` (the view's `_id without FK` filter), `Nullability not recorded` (`nullableState === 'unknown'`). The only combination the view does not show as one badge is the nullable declared FK, which is the conjunction of two existing badges; no new threshold or heuristic was added. The host's Normalization review findings (`buildFindings`, `explorer.html:103`) are not part of this report; they keep their own CSV export.
- `columnReport` (`:208`) applies the view's own `matchesColumn` filter, so an export contains exactly the columns the filters show. Unknown counts and statistics are written as `unknown`, never 0. Declared and inferred targets are separate columns (`declared_fk_target`, `inferred_target`, `relationship_evidence`). `profiling.min`, `profiling.max` and `sampleValues` are never exported.
- `columnReportHtml` (`:313`) is a standalone document with its own policy `REPORT_CSP` (`:302`: no script, no network), provenance, the active filters, an issue summary, one table group per entity, and caveats C01, C06, C07, C08, C09 (plus C05 when any statistic is sample-scoped) quoted from `caveat-strings.ts`. A flagged row has class `issue`, a left rule and tint, and the text `⚠ Issue: <name>` in an Issues column, so the highlight does not rely on colour. Its closing style tag is assembled at run time (`:311`) so the bundle inlined into the artifact never contains the sequence the S01 renderer checks forbid.

**Diagram export (`packages/explorer/src/svg-export.ts`)**

- `inlineSvg` (`:120`) clones the live `<svg>` and inlines each element's computed presentation, so classes and custom properties survive outside the page; `buildExportSvg` (`:60`) frames it with a title, the provenance lines, a legend (dashed swatches for dashed marks) and caveat notes, all escaped.
- `svgToPng` (`:174`) rasterises through a `data:image/svg+xml` image, the only image source the artifact policy allows, then `canvas.toBlob`; `pngScale` (`:169`) keeps the canvas inside 8192 px per edge and 40 MP. `downloadBlob` (`:147`) hands a Blob to an anchor with `download`; it is only reached from a click handler.
- `ExportButtons.tsx` renders the controls with accessible names `Export <view> as SVG|PNG|CSV` and `Export <view> issue report (HTML)`, and shows a failure inline (`role="alert"`).

**Per view**

- Arc Diagram (`ArcDiagram.tsx:70`, `:92`): SVG and PNG of the whole diagram at its natural size, legend child-to-parent / cyclic / isolated, the count of excluded inferred or unresolved links, C07 and C12.
- Domains (`Domains.tsx:122`, `:148`): SVG and PNG of the current page at natural size; legend lists the communities on the page; scope line names page, search, community and relationship filter; C03 and C11.
- Schema City (`City.tsx:442`, `:509`): flat map as SVG or PNG; the 3D scene as PNG of the current camera, read through `CaptureBridge` (`:263`), which renders and reads the WebGL frame in one task, with the table-name overlay composited on top. Legend lists districts and declared / inferred / cross-domain roads; unprofiled tables are stated as unknown, not zero, with C01; C07.
- Column Table (`ColumnTable.tsx:167`, `:195`): CSV and HTML report of the filtered columns of the current (possibly profiled) graph. The JSON snapshot export is unchanged.
- PK / FK index (host, `explorer.html:93-94`): an in-view `Export PK / FK index as CSV` button calls the existing `exportCSV` (`:182`), which now writes the provenance preamble and a scope line for every host CSV (map, entities, keys, review).

**Gaps**

- PNG of Arc Diagram, Domains and the flat city depends on the browser rasterising SVG text; text uses the host font stack and may substitute on another machine. SVG is the lossless format.
- The Domains export is one page of the diagram, as shown; exporting every page is not offered.
- Living ERD and Schema Diff keep their earlier export paths (`LivingERD.tsx`, `SchemaDiff.tsx`) and do not yet carry the provenance frame.

## 4. Intended behaviour

### MVP

- **B1** Every export runs only on an explicit click; nothing is uploaded, hosted or sent.
- **B2** Every export carries the snapshot's provenance: project, `source.generated`, `source.basis`, source identifiers, export time.
- **B3** CSV cells pass the S01 formula guard.
- **B4** Declared and inferred evidence stay distinguishable, and unknown values are written as unknown, never zero.
- **B5** The Column Table report highlights issue rows and names each issue in text.
- **B6** Diagram exports are available as SVG and PNG; a 3D scene exports as PNG.
- **B7** `sampleValues` and min/max are not exported by the report paths.

### Later

- **B10** SPA export job (A04) reusing `build_explorer.render()` with stripping defaults and a C05 footer.
- **B11** Provenance frame for Living ERD and Schema Diff exports.

## 5. Drill-through contract

### Inbound

None: exports read the view's current state and do not change selection.

### Outbound

None. An export never navigates and never runs a query.

### URL state

None.

## 6. Data contract dependencies

Reads `project.name`, `project.key`, `project.dialect`, `source.*`, `tables[].rowCount`, `tables[].profiling`, `allColumns[]` flags and `profiling`, `links[].kind`. Absent provenance fields read `not recorded`; an absent row count or statistic reads `unknown`.

## 7. Caveats

> C04: "Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf."
> Shown: Schema Diff draft SQL download (unchanged).

> C05: "Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized."
> Shown: Column Table HTML report caveat section when any statistic is sample-scoped.

> C13: "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state."
> Shown: not surfaced by these exports; they store nothing.

Diagram footers also quote C01, C03, C07, C11 and C12 where the view encodes them.

## 8. Acceptance criteria

- **AC1** (B1, B6, CTQ-05) Given the rendered offline artifact under its unchanged policy, When each export control on Arc Diagram, Domains, Schema City (3D and flat), Column Table and PK / FK index is clicked, Then a download is produced, with no network request and no policy violation.
- **AC2** (B2) Given any export, Then it contains `Snapshot generated:` and `Basis:` with the snapshot's values.
- **AC3** (B3, CTQ-07) Given an identifier beginning with `=`, When it is exported to CSV, Then the cell begins with `'`.
- **AC4** (B4, B5) Given a nullable, unindexed declared FK, Then its Column Table CSV row reads `Unindexed declared FK; Nullable declared FK` and its HTML row is highlighted with both issues named.

## 9. Test expectations

- Unit: `packages/explorer/src/export-logic.test.ts`, `svg-export.test.ts` (tests named `F19 ...`, in `npm test`).
- Browser: `packages/explorer/src/export-browser.test.mjs` renders a synthetic schema with `build_explorer.py`, opens it from `file://` in Chromium and clicks every control. Run with `node --test packages/explorer/src/export-browser.test.mjs` after `npm run build`; set `EXPORT_BROWSER_EXECUTABLE` when Playwright's own Chromium build is not installed.

## 10. Security and privacy

Exports are generated in the page from data the page already holds. Identifiers are HTML-escaped in the report and XML-escaped in SVG; CSV cells are formula-guarded. The HTML report carries `default-src 'none'` and no script. The artifact policy is unchanged byte for byte; PNG rasterising uses `data:` images only. Min/max and sample values are not exported by the CSV or report paths. Snapshot JSON export (host header button and Column Table) still writes the whole graph, as before.

## 11. Performance budget

No budget is defined. PNG size is capped by `pngScale` (`svg-export.ts:169`).

## 12. Accessibility

Each control is a button with a text label and an accessible name; failures use `role="alert"`. Report highlighting pairs colour with a left rule and the issue name in text.

## 13. Open questions

1. Should the snapshot JSON exports strip min/max and `sampleValues` by default (RK-14)? Owner: Security lead, by G2.
2. Should every Domains page be exportable in one file? Owner: Product owner.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Logic | `packages/explorer/src/export-logic.ts` |
| Diagram export | `packages/explorer/src/svg-export.ts` |
| Controls | `packages/explorer/src/ExportButtons.tsx`, `ExportButtons.css` |
| Views | `ArcDiagram.tsx`, `Domains.tsx`, `City.tsx`, `ColumnTable.tsx`; host `skill/assets/explorer.html` (`renderKeys`, `exportCSV`) |
| Tests | `export-logic.test.ts`, `svg-export.test.ts`, `export-browser.test.mjs` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-11-22 | - | F19 | First document. SVG/PNG export for Arc Diagram, Domains and Schema City (flat SVG/PNG, 3D PNG); Column Table CSV and highlighted HTML issue report; in-view PK / FK index CSV button; provenance preamble on every host CSV; browser test under the artifact CSP. |
