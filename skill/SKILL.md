---
name: backend-buddy
description: "Create or update interactive relational maps and database schema review documentation across projects. Use for ERDs, entity and PK/FK indexes, normalization analysis, row fan-out, column profiling, 3D schema city, schema comparisons, and refreshing an existing schema explorer."
---

# Backend Buddy

Produce an inspectable, standalone HTML schema explorer using the bundled working design. Preserve its full-browser viewport behavior, dark/light/system themes, entity comparison, key index, relationship neighborhood focus, and review tooling. A Markdown diagram is not the default deliverable. Use the user's chosen output format when explicitly specified.

## Create or Update

1. Identify the project, environment, authoritative schema source, existing extractor, and existing documentation outputs. For updates, reuse their locations and conventions. A repository checkout is not proof of the live database schema or the latest development branch.
2. Read [extraction.md](references/extraction.md) for the source appropriate to the project. Build a project-local adapter that emits [the canonical schema contract](references/schema-contract.md). Prefer native parsers, ORM metadata, or read-only catalog queries over regex extraction. Resolve local mixins, helper-defined columns, composite constraints, and dialect type variants. Report unsupported constructs instead of silently omitting them.
3. Keep source declarations, live constraints, naming guesses, and business/entity classifications distinguishable. Include source paths, revision/hash, extraction date, database dialect, and known coverage gaps. Do not embed rows, passwords, connection strings, or tokens in documentation.
4. Render with the bundled script, using absolute paths as appropriate:

   ```text
   python <skill>/scripts/build_explorer.py --schema <project>/outputs/schema.json --output <project>/outputs/backend-buddy.html
   ```

   The renderer has no runtime dependency beyond Python's standard library. It bundles its icons and data; the output works from a local file without a server or network requests. Use a stable, project-and-environment-specific `project.key` so browser review decisions survive refreshes without leaking into other projects.
5. Read [review-and-updates.md](references/review-and-updates.md) when updating an explorer or interpreting normalization candidates. Preserve custom domain mappings and decisions; re-evaluate findings when their supporting schema changes. Generate read-only validation SQL only for a supported, identified dialect. Do not run it merely because it is displayed.
6. Verify using [verification.md](references/verification.md). Run `scripts/check_explorer.cjs <output.html> <qa-directory>` with an available Playwright runtime. Inspect the screenshots, not only the test exit code. Keep the graph and inspector independently scrollable; do not squeeze every table into the viewport at unreadable scale.
7. Deliver a clickable absolute path and a concise statement of scope and verification. Publish only when requested or already authorized for this artifact; use existing hosting tools and reuse its project. Preserve existing CSP and sandbox boundaries when updating a wrapped or hosted artifact.

## Output Contract

- **Relational map:** non-overlapping entities, domain grouping, relationship evidence styling, entity selection, neighborhood focus, zoom/fit, and SVG export. Keep entity types visible in the inspector; color supplements labels. Show cardinality only when uniqueness and nullability support it, and keep composite keys together.
- **Entity index:** tables, mapped model/entity types, domain, columns, primary keys, associations, search/filter/sort, and two-entity comparison.
- **PK/FK index:** column and composite-key membership, declared versus inferred references, unresolved IDs, types, nullability, target columns, index coverage, and unique constraints. A column named `id` is not automatically a PK. An `_id` suffix is not proof of an FK.
- **Schema review:** candidate rules, affected tables/columns, evidence, next validation step, saved decisions, and CSV export. Keep normalization, referential integrity, and index performance in separate categories. Structured payloads and historical snapshots are not automatically design defects.
- **Reproducibility:** retain the canonical schema JSON and project-local extraction/render command. When requested, create Word documentation and spreadsheet catalogs from that same schema through the available document/spreadsheet skills; do not maintain competing table counts.

## Advanced Views and Profiling

The explorer also includes Living ERD (React Flow), Row Fan-out (d3-sankey), Column Table, Schema City (react-three-fiber with a flat fallback), Normalization Lens, Schema Diff, Join Matrix, Arc Diagram, and discovered Domains. Read [advanced-views.md](references/advanced-views.md) when creating, testing, or extending them.

Treat `rowCount` and profiling as optional evidence. Missing statistics are unknown, never zero or synthetic measurements. Node heights and flow widths must label unavailable data. Profile at most 10,000 rows per table and retain at most 10,000 subtree rows per hop, depth at most four. The optional local adapter requires an explicitly selected read-only connection. Do not discover or connect to production merely to make a diagram look populated.

`assets/extensions` retains the editable React feature source, locked dependencies, compiled offline bundle, and optional profiling service. The renderer consumes its compiled bundle without requiring Node. To modify the features, copy the extension project into the target workspace, run `npm ci`, edit and test it, then `npm run build`. Preserve the pinned lockfile unless a dependency change is needed. Use the scripts in `server` only for requested profiling or an explicitly configured live viewer.

## Bundled Resources

- `assets/explorer.html`: the reusable, data-free explorer source; modify a project-local copy for project-specific UI extensions.
- `assets/icons.json` and `assets/lucide-license.txt`: bundled Lucide icon geometry and license; no CDN required.
- `scripts/build_explorer.py`: validates, normalizes, and renders canonical schema JSON.
- `scripts/check_explorer.cjs`: generic browser checks and desktop/mobile screenshots; requires Playwright and a Chromium browser.
- `scripts/test_renderer.py`: portable renderer contract tests, including script injection handling, composite relationships, empty schemas, and project isolation.

Do not store a project's private schema in the installed skill. Keep project data and generated outputs in that project's workspace.
