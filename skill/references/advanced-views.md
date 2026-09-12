# Advanced Explorer Views

## Shared Schema and Inspector

All views consume the canonical SchemaGraph and share table selection. Keep the existing entrypoint and output path on updates. Extend adapters with `rowCount`, `kind: "view"`, view `definition`, column `default`/`serverDefault`, type parameters, FK names/actions, and ordered composite keys when the source supplies them. Application-level defaults are separate from SQL defaults; never emit a Python or JavaScript function as executable migration SQL.

## Views

- **Living ERD:** React Flow with d3-force initial positioning, draggable/pinned positions per snapshot, domain/table/column semantic zoom, crow's feet, one-hop highlighting, junction collapse, table search, and SVG/PNG export. Never collapse a generic multi-FK fact table as an N:M junction without checking its key constraints.
- **Row Fan-out:** traverse declared parent-to-child 1:N relations to depth four, with cycle handling and expansion. The canonical link direction is child-to-parent, so traversal reverses it. Show local `child.rowCount / parent.rowCount` ratios, not conserved flow or proven per-parent multiplicity. Empty/unknown parents do not have a finite measured ratio. Live PK mode uses bounded actual subtree counts, not table totals.
- **Column Table:** type-family tiles with constraints/index badges, optional sample null/distinct statistics and min/max, filters, and snapshot export. Composite unique membership does not mean each individual column is unique. Show the sample denominator and coverage alongside any distinct/rowCount ratio.
- **Schema City:** treemap districts, column-count footprints, log row-count heights, domain colors and FK roads; orbit/inspect interaction. Keep persistent readable labels in 3D and flat views, with collision handling and detail on zoom. Unknown rows retain their domain color and use an explicit unprofiled label and baseline height, never a fabricated count. The flat SVG mode uses the same layout and must remain available when WebGL fails.
- **Normalization Lens:** sample candidate dependencies, cross-table name/type duplication, lookup-table exemptions, explained review scores, and dependency/duplicate arrows. `distinct(A) == distinct(A,B)` is sample evidence, not proof across the full relation. A unique or constant determinant can be vacuous; label or exclude such cases. Do not claim unprofiled tables are normalized.
- **Schema Diff:** load local A/B snapshots, compare structural metadata, show a union diagram with before/after details and side-by-side DDL. Migration SQL is a draft, never executed by the artifact. Cover dependency order and dialect quoting; mark unsupported types/expressions, missing definitions, and destructive changes explicitly.
- **Join Matrix:** directed FK grid, cardinality/count coloring, alphabetical/count/schema/cluster ordering, keyboard navigation, and pair inspection. Use canvas over 100 tables, keep labels accessible, count one composite constraint rather than each pair as separate FKs.
- **Arc Diagram:** parent-first topological order with strongly connected component analysis, cycle/backward arcs below the axis, isolated ticks, and a cycle list. Cycles require SCC analysis, not simply treating every traversal repeat as a cycle.
- **Domains:** deterministic FK community detection with hierarchical edge bundling to expose within/cross-cluster coupling. Discovered clusters are analytical suggestions, not automatically the project's business ownership model.

## Optional Read-only Profiling

The bundled `server/schema_profiler.py` supports explicitly selected SQLite and PostgreSQL connections; PostgreSQL requires optional psycopg 3 in the executor. It opens read-only transactions, parameterizes row values, validates identifiers against the snapshot, and bounds rows, depth, query count, and time. It never connects on import.

Batch example (use an environment variable name for a PostgreSQL DSN, not credentials on the command line):

```text
python <extensions>/server/profile_snapshot.py --schema schema.json --output profiled-schema.json --dialect postgresql --dsn-env DOCUMENTATION_READONLY_DSN --limit 10000
```

Live local viewer:

```text
python <extensions>/server/serve_explorer.py --html backend-buddy.html --schema schema.json --dialect sqlite --database /absolute/review.sqlite --snapshot-output profiled-schema.json --port 8765
```

The server binds to 127.0.0.1, requires same-origin requests plus an ephemeral capability, and changes only the served copy's connect policy. Static HTML retains its offline CSP. No sample rows are embedded by default; `--include-sample-values` explicitly enables up to three bounded values per column. Min/max and profile summaries can still contain sensitive scalar values, so only profile and share the requested data scope.

Stats are stored under column `profiling` and table `profiling`, including sample size, scope, null fraction, distinct count, min/max, and candidate functional dependencies. A capped sample cannot establish the exact table row count: retain unknown or an independently measured total, plus a lower bound. Do not run unbounded COUNT scans to fill a chart. Exports of a profiled graph are review artifacts, not a backup of the database.

## Validation

Use feature logic tests for traversal cycles, composite FKs, ratio handling, FD candidates, graph clustering/SCCs, diff ordering, and dialect SQL. Exercise a synthetic measured snapshot as well as a real unprofiled schema. Inspect desktop/mobile screenshots, 3D canvas pixels and orbit motion, flat fallback, exports, loaded snapshots, and saved positions. Browser success does not validate live PostgreSQL behavior; distinguish fixture and live checks in the final report.
