# Fixtures

Status: draft | Owner: R01 (synthetic fixtures) | Last verified against code: unreleased

Synthetic SchemaGraph snapshots, SQL seeds, and contract cases that let the repository build
and test without any private data. Everything under `fixtures/` except this README, the
`.gitignore`, and `test_fixtures_normalize.py` is **generated** by
`scripts/generate-fixtures.mjs`; change the generator, never the output (AGENTS.md section 2).

## Rules

1. **Fixtures are synthetic and stay synthetic.** Every identifier comes from the word lists in
   the generator and every number from a seeded PRNG. Never replace, extend, or "correct" a
   fixture with a customer schema, an extracted snapshot, or real row counts (CTQ-14; ADR-0007).
   Private snapshots are used only locally through `--schema`, outside the repository.
2. **Unknown stays unknown.** `medium.json` carries no `rowCount`, `rowCountLowerBound`, or
   `profiling` anywhere. `medium-measured.json` marks a subset as measured, a subset as a lower
   bound only, and leaves the rest absent (CTQ-01).
3. **Committed fixtures stay under 2 MB.** `schemas/large.json` exceeds the cap on purpose and is
   git-ignored (`fixtures/.gitignore`); regenerate it locally with `--large` when a test needs it.
4. **No project-specific counts.** Tests assert ranges and structures derived from the loaded
   graph, never literals tied to one schema, and the generator never reproduces the dimensions of
   any real schema. The exact values are written down nowhere in the repository: set
   `BB_FORBIDDEN_COUNTS` (comma-separated integers) locally and `npm run test:scripts` rejects a
   fixture whose table count, column count, per-table column count, or file name matches one of
   them. CI cannot know the values and skips that single check with a printed reason.

## Regeneration

```sh
npm run fixtures                                   # rewrites fixtures/schemas, fixtures/sql, fixtures/contract
node scripts/generate-fixtures.mjs --large         # additionally writes schemas/large.json (git-ignored)
node scripts/generate-fixtures.mjs --out <dir>     # write elsewhere, e.g. for a comparison run
```

The generator prints the size of every file it writes and exits non-zero if a committed fixture
exceeds 2 MB. Output is byte-identical between runs; the node test below fails when the committed
files drift from the generator.

## Tests

```sh
npm run test:scripts                                                             # node --test "scripts/**/*.test.mjs": every script test (CI runs it after npm run restore)
node --test scripts/generate-fixtures.test.mjs                                   # this file only, plain Node
npx --prefix packages/explorer tsx --test scripts/generate-fixtures.test.mjs     # through tsx
python -m unittest discover -s fixtures -p "test_*.py"                          # Python contract oracle
```

`scripts/generate-fixtures.test.mjs` checks determinism (two CLI runs, byte for byte), drift
against the committed files, the 2 MB cap, the counts and structures listed below, the
measurement mix, both SQL seeds, and that every schema parses with
`packages/explorer/src/schema-diff-logic.ts` `parseSchemaSnapshot`, that `living-logic.ts`
detects the junction tables, and that `lens-domain-logic.ts` finds communities and repeated
fields. The TypeScript modules are loaded through Node's type stripping or, when that cannot
parse a module, through `tsx` from `packages/explorer/node_modules`. When neither is available
those subtests skip with an explicit message locally and fail under `CI` (GitHub Actions sets
it): the CI `scripts` job runs `npm run restore` first and must not turn green by skipping.

`fixtures/test_fixtures_normalize.py` runs every `schemas/*.json` and `contract/valid/*.json`
through `build_explorer.normalize()`, asserts that each `contract/invalid/*.json` raises a
`ValueError` containing its `$expectedError`, renders the hostile fixture, and executes
`sql/sqlite/seed.sql` in an in-memory SQLite database with `PRAGMA foreign_keys = ON` to prove
the DDL and inserts are consistent with the measured snapshot.

## Schema fixtures (`fixtures/schemas/`)

| File | Purpose | Shape (approximate) | Used by |
|---|---|---|---|
| `small.json` | Smallest readable graph; SQLite dialect; one composite FK group, one two-table cycle, a junction table, one inferred link | 3 domains, 12 tables, ~55 columns, 13 declared + 1 inferred pairs | Renderer and view unit tests, docs examples, CTQ-06 SQL drafting for `sqlite` |
| `medium.json` | Default build input (`scripts/project.mjs`), performance and UX baseline; no measurements at all | 8 domains, 160 tables (155 base + 5 views), ~2,300 columns, ~100 declared + ~25 inferred pairs, 4 base tables without PK, 1 three-table strongly connected cycle, 1 self reference, composite PKs and composite FK groups, 4 junctions, partial index, composite uniques, checks | `npm run build`, CTQ-01 (unknown rendering), CTQ-09 view TTI, CTQ-10 drill-through, CTQ-11 axe runs |
| `medium-measured.json` | Same schema as `medium.json` plus synthetic measurements | `rowCount` on ~80 % of tables (six of them 0), `rowCountLowerBound` only on ~10 tables, sampled column profiling on ~40 % of columns (`sampled: true`, `scope: 'sampled'`), `sampleValues` on exactly 3 PK columns, sample functional dependencies on 3 tables | CTQ-01 zero-versus-unknown, CTQ-08 profiler bounds, Row Fan-out, Column Table, Schema City heights, Normalization Lens, SQL seeds |
| `edge-cases.json` | Boundary shapes | A domain with one table, a table with only its PK, 60-character identifiers, unicode identifiers, the same table name in two schemas, `nullable: ''` and legacy `null`, a table without PK, an `Unknown` type, an unresolved inferred link | Layout, label, and unresolved-reference tests |
| `many-domains.json` | Palette and legend stress | 14 domains, 60 tables, ~780 columns | C02 palette contrast and colour-vision tests, Domains view |
| `hostile.json` | Security fixture: markup, `javascript:` URLs, spreadsheet formula prefixes, quotes and backslashes, `constructor` / `__proto__` / `hasOwnProperty` as type, domain, and column names, `__ICON_DATA__` placeholder text, 120-character identifiers | 4 tables including a view | CTQ-07 (renders inert; CSV export guard), S01 renderer hardening, `test_R01_hostile_fixture_renders_without_raw_markup` |
| `empty.json` | Project and source with empty `tables` and `links` | 0 tables | Empty-state rendering, `normalize()` defaults |
| `large.json` (git-ignored) | Scale and performance | 14 domains, 1,200 tables, ~16,000 columns, ~1,000 links | Q01 `layoutCity(large)` budget, City frame timing, parser limits |

Every schema fixture has a `project.key` matching `^[a-z0-9][a-z0-9_-]*$`, `project.dialect`
`postgresql` (except `small.json`, which is `sqlite`), and a complete `source` block whose `basis`
states that the data is synthetic and that no live database was inspected. Column `nullable`
values use the normalized `'True'` / `'False'` / `''` form so that `parseSchemaSnapshot` accepts the
files unchanged; the `legacy-flags` contract case covers the legacy boolean-string and `null` forms.

## SQL seeds (`fixtures/sql/`)

`pg/seed.sql` and `sqlite/seed.sql` materialise `medium-measured.json` as a database:

- `CREATE TABLE` statements for the 155 base tables in FK dependency order, identifiers
  double-quoted, types mapped per dialect (`String(n)` to `varchar(n)` / `TEXT`, `DateTime` to
  `timestamp` / `TEXT`, `Boolean` to `boolean` / `INTEGER`, and so on). Views are not created.
- PostgreSQL creates one schema per domain and adds the FK that closes the three-table cycle with
  `ALTER TABLE ... ADD CONSTRAINT` after all tables exist. SQLite has no schemas, so tables use
  their bare names (they are globally unique in the medium layout) and every FK is inline;
  `PRAGMA foreign_keys = ON` is set at the top.
- Deterministic multi-row `INSERT` statements with FK-consistent values. The cycle-closing
  column is inserted as `NULL` and back-filled with `UPDATE` statements once the referenced rows
  exist. Nullable non-key attributes are left `NULL` to keep each file well under 2 MB.
- **Row counts:** tables with `rowCount <= 200` receive exactly `rowCount` rows; tables with a
  larger `rowCount` or with only a `rowCountLowerBound` receive exactly 200 rows; tables without a
  measurement receive 10 rows; tables with `rowCount: 0` receive none (at least one such table is
  guaranteed). **Counts above 200 are therefore declared in the JSON snapshot, not measured from
  the SQL seed.** A profiler run against a seeded database will report the seeded counts, which is
  the intended way to test declared-versus-measured handling (CTQ-08, Q03).

## Contract cases (`fixtures/contract/`)

`valid/` holds five small graphs that `normalize()` and `parseSchemaSnapshot` must accept:
`composite-primary-key`, `composite-fk-group` (two column pairs sharing one `constraintId`),
`legacy-flags` (`'True'` / `'False'` strings and `null` nullability), `view-with-definition`
(`kind: 'view'` plus `definition`), and `external-stub` (a declared FK into a clearly labelled stub
table).

`invalid/` holds six graphs that `normalize()` must reject. Each carries a top-level
`$expectedError` string that the `ValueError` message must contain:

| File | `$expectedError` |
|---|---|
| `missing-project-key.json` | `project.name and a stable lowercase project.key are required` |
| `uppercase-project-key.json` | `project.name and a stable lowercase project.key are required` |
| `duplicate-table-id.json` | `Each table needs a unique nonempty string id` |
| `duplicate-column-name.json` | `duplicate or invalid column name` |
| `unresolved-declared-fk.json` | `Unresolved declared FK target: w.items.id` |
| `link-kind-fk.json` | `Relationship kind must distinguish declared FK from inferred by naming` |

The `$expectedError` key is ignored by both validators; it exists only for the tests.
