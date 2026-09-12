Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-08)

# SchemaGraph contract

Part A reproduces `skill/references/schema-contract.md` verbatim (the contract adapters emit today and the artifact renders). Part B adds the contract v1 changes decided in D3 and built in work package C01: an explicit `contractVersion`, promotion of fields that views already read through the index signature, id forms used by drill-through, and the compatibility policy. Nothing in Part B removes or renames a Part A field; a Part A document remains valid under v1.

Source of truth since C01: `packages/contract/schema-graph.v1.json`. TypeScript types are generated into `packages/explorer/src/contract.generated.ts` by `scripts/gen_contract.mjs` (`npm run contract`, drift check `npm run contract:check`) and re-exported by `packages/explorer/src/types.ts`, which keeps only the hand-written `SubtreeResult`, `ProfileResult`, `LiveConnection` and `ViewProps`. Python validates with `jsonschema` and then runs `skill/scripts/build_explorer.py` `normalize()` as the semantic oracle, in `packages/profiler/bb_profiler/contract.py` (ADR-0003). Part A is written by the same generator: `npm run contract` copies `skill/references/schema-contract.md`, regenerated field tables included, into Part A, and `npm run contract:check` fails when the two copies differ. The prose contract and the machine-readable one therefore cannot drift apart silently, in either copy.

---

## Part A. Canonical Schema Contract (verbatim from `skill/references/schema-contract.md`)

# Canonical Schema Contract

The renderer accepts JSON. This is an exchange format for adapters, not a claim that every database uses the same type system.

```json
{
  "project": {"name": "Inventory Dev", "key": "inventory-dev", "dialect": "postgresql"},
  "source": {
    "file": "db/schema.prisma", "commit": "verified-ref-or-snapshot-id",
    "sha256": "source-hash", "generated": "2026-01-01T00:00:00Z",
    "basis": "Repository schema only; migration drift not inspected."
  },
  "tables": [
    {
      "id": "public.items", "schema": "public", "name": "items",
      "className": "Item", "domain": "Inventory", "type": "Core master entity",
      "file": "db/schema.prisma", "line": 12,
      "allColumns": [
        {"name": "id", "type": "Integer", "pk": true, "nullable": false},
        {"name": "name", "type": "Text", "nullable": false}
      ],
      "indexes": [], "uniques": [], "checks": []
    }
  ],
  "links": []
}
```

## Required and Defaulted Values

- Require `project.name`, a stable `project.key`, and arrays `tables` and `links`. Dialect defaults to `unknown`; SQL generation then stays off. Supported generated SQL: `postgresql` and `sqlite`.
- `tables[].id` is a unique lookup ID. Supply separate `schema` and physical `name` for qualified names; do not split identifiers on dots in SQL generation. The display ID may itself contain dots.
- Every table needs `allColumns` with unique nonempty `name` values. Unknown types remain `Unknown`. Flags `pk`, `index`, and `unique` are booleans; the renderer also accepts legacy `"True"`/`"False"`. `nullable` accepts boolean, null/unknown, or those legacy strings. PK nullability is constrained by the database's rules; confirm exceptions in the adapter.
- `primaryKey`, when provided, is an ordered array of names and takes precedence over individual PK flags. It preserves a composite key's declared order. Otherwise order follows PK-flagged columns.
- `indexes` entries: `{ "name": "ix_name", "columns": ["tenant_id", "name"], "unique": false }`. Exclude partial/filtered or expression indexes from generic full-coverage assumptions. Set `partial: true` or `expression: true` and document the definition when applicable; the renderer removes these from coverage heuristics.
- `uniques` entries: `{ "name": "uq_name", "columns": ["tenant_id", "name"] }`. Include column-level unique constraints as single-column groups. Keep ordered composite groups intact.
- `checks` entries: `{ "name": "ck_name", "definition": "quantity >= 0" }`.
- Per-column optional fields: `fk` (display target), `line`, `file`, `ondelete`, and `typeBasis`. Actual relationships come from `links`; adapters should not invent links from `fk` text without validating it.
- Entity categories used by the visual: `Core master entity`, `Transaction / operational`, `Association / detail`, `Configuration / reference`, `Audit / integration state`. Custom labels are allowed. Use `Unclassified` when evidence is insufficient. Classifications should state whether they are inferred or curated in `source.basis`.

## Relationships

```json
{
  "source": "public.order_lines", "column": "item_id",
  "target": "public.items", "targetColumn": "id",
  "kind": "declared FK", "constraintId": "fk_order_lines_item"
}
```

Use exactly `declared FK` or `inferred by naming` for `kind`. `declared FK` means declared in the identified evidence source, not necessarily verified live. All source tables and columns must exist. Declared targets must exist in the selected scope: include referenced external tables as clearly labeled stubs, or resolve the scope before rendering. An inferred target may be absent; label it unresolved and do not generate an executable validation query for it.

For a composite FK emit one link per ordered column pair, all sharing a nonempty `constraintId` unique within the source table. The renderer retains pair-level evidence and generates a combined orphan predicate rather than testing pairs independently. The map's association count is column pairs, not the number of physical FK constraints. Annotate nullable composite MATCH semantics separately; automatic orphan SQL is omitted when any component can be null or its nullability is unknown.

Do not attach a second conflicting inferred target to an already-declared source column. Many-to-many relationships need the junction entity and its two FK groups; don't fabricate a direct physical FK between endpoints.

## Project Isolation and Updates

`project.key` must remain stable for one project's environment, and differ between environments/projects with identical table names. Theme and review decisions are scoped to this key. Candidate signatures include relevant columns, relationships, and constraints; changed evidence reopens a finding rather than inheriting a stale decision. Retain schema JSON with the artifact; browser local storage is convenience state, not a team review database.

## Contract Version

`contractVersion` is the optional top-level version string, `MAJOR.MINOR`. A document without the field is treated as `1.0`, so every snapshot written before the field existed stays valid. A reader accepts any `1.x` document and ignores fields it does not know; a different major version is rejected with an error naming both versions. Within major version 1 the contract only grows: new optional fields and new enumeration values with a documented default. Renaming or removing a field, tightening a type, or changing the meaning of `kind`, `rowCount`, or `constraintId` is a major change.

The machine-readable form of this contract is `packages/contract/schema-graph.v1.json`. It carries the structural rules (types, enumerations, required fields, length caps, numeric bounds). The semantic rules stay in `normalize()` in `scripts/build_explorer.py`, which is the single oracle: a validator runs the JSON Schema first and then `normalize()`. The field tables below and the TypeScript interfaces in the extensions bundle are both generated from that file.

## Field Tables

The tables below are generated from `packages/contract/schema-graph.v1.json`. "JSON form" is what an adapter may put on the wire; "Required" is what the JSON Schema demands. Everything else is optional, and `normalize()` supplies the defaults listed above before a view sees the document.

<!-- generated:fields:start -->
<!-- Generated by `scripts/gen_contract.mjs --docs` from packages/contract/schema-graph.v1.json. Do not edit by hand. -->

### SchemaGraph

The exchange format adapters emit and the artifact renders. It is an exchange format, not a claim that every database uses the same type system.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `contractVersion` | `string` (up to 32 characters, pattern `^1\.[0-9]+$`) | no | Contract version as MAJOR.MINOR. A document without the field is treated as 1.0. A different major version is rejected; a higher minor version is accepted and its unknown fields are ignored. |
| `project` | `SchemaProject` | yes | Project identity. |
| `source` | `SchemaSource` | no | Evidence provenance. |
| `tables` | array of `SchemaTable` | yes | Every table and view in the selected scope, with unique ids. |
| `links` | array of `SchemaLink` | yes | Every relationship, one entry per ordered column pair. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaProject

Identity of the schema under review. The key scopes browser storage and review decisions and must stay stable for one project environment. See C13.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `name` | `string` (1-256 characters) | yes | Human-readable project name. Rendered escaped in the header, the provenance footer and the artifact title. |
| `key` | `string` (pattern `^[a-z0-9][a-z0-9_-]*$`) | yes | Stable lowercase key, matching the character set normalize() enforces. Two environments with identical table names must not share a key. |
| `dialect` | `string` (up to 256 characters) | no | SQL dialect of the source. Defaults to unknown, which turns generated SQL off. Generated SQL is supported for postgresql and sqlite only, and is always a draft the product never executes. See C04. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaSource

Where the graph came from and how far its evidence reaches. normalize() supplies a default for every field so the provenance footer is never blank; adapters should still emit the real values. See C09.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `file` | `string` (up to 4096 characters) | no | Path or identifier of the evidence source. |
| `commit` | `string` (up to 256 characters) | no | Verified reference or snapshot id. The provenance footer shows its first eight characters. |
| `sha256` | `string` (up to 256 characters) | no | Hash of the source bytes, or a recorded placeholder. |
| `generated` | `string` (up to 256 characters) | no | When the graph was produced. |
| `basis` | `string` (up to 4096 characters) | no | What the evidence covers and what it does not. Shown as the provenance tooltip. See C09. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaTable

One entity of the graph. Additional catalog metadata is kept as data and passed through unchanged.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `id` | `string` (1-256 characters) | yes | Unique lookup id for the table. It may contain dots; identifiers are never split on dots for SQL generation. |
| `name` | `string` (up to 256 characters) | no | Physical table name, supplied separately from the display id. |
| `schema` | `string` (up to 256 characters) | no | Physical schema name. |
| `className` | `string` (up to 256 characters) | no | Application or ORM class name for this entity. |
| `domain` | `string` (up to 256 characters) | no | Declared domain, or a discovered community label. A discovered community is an analytical suggestion. See C03. |
| `type` | `string` (up to 256 characters) | no | Entity category. The visual uses Core master entity, Transaction / operational, Association / detail, Configuration / reference and Audit / integration state; custom labels are allowed and Unclassified is used when evidence is insufficient. |
| `kind` | `"table"` or `"view"` | no | Whether the entity is a base table or a view. Defaults to table. View metadata never supplies executable SQL. See C04. |
| `definition` | `string` (up to 4096 characters) | no | View or entity definition text. Display-only and never executed. See C04. |
| `file` | `string` (up to 4096 characters) | no | Evidence file for this table, when it differs from the graph source. |
| `line` | `integer` (at least 0) | no | Line in the evidence file. A non-negative integer; a string is rejected. |
| `pk` | `string` | no | Primary-key column names joined for display. normalize() derives it from primaryKey or from the primary-key flags. |
| `primaryKey` | array of `string` (1-256 characters) | no | Ordered primary-key column names. When present it takes precedence over the per-column flags and preserves a composite key's declared order. |
| `allColumns` | array of `SchemaColumn` | yes | Every column of the entity, with unique non-empty names. |
| `indexes` | array of `SchemaIndex` | no | Index groups. |
| `uniques` | array of `SchemaIndex` | no | Unique groups, including single-column constraints. See C06. |
| `checks` | array of `SchemaCheck` | no | Check constraints. |
| `rowCount` | `integer` or `null` (at least 0) | no | Exact row count from the adapter or from an exhausted sample, or null when unknown. Zero is a measured value and is never substituted for unknown. See C01. |
| `rowCountLowerBound` | `integer` (at least 0) | no | Lower bound from a capped sample. A capped sample yields a lower bound, not a total, and it is present only while rowCount is unknown. See C01. |
| `rowCountExact` | `boolean` | no | Whether rowCount is exact rather than a floor. |
| `sampleSize` | `integer` (at least 0) | no | Rows examined for this table by the last profiling run. |
| `sampled` | `boolean` | no | True when the last profiling run sampled this table. |
| `profiling` | `TableProfiling` | no | Table-level profiling metadata, including completeness. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaLink

One ordered column pair. A composite foreign key is emitted as one link per pair, all sharing a non-empty constraintId, and counts once as a relationship while the association count is column pairs. See C11.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `source` | `string` (1-256 characters) | yes | Child table id. It must exist in tables. |
| `column` | `string` (1-256 characters) | yes | Child column name. It must exist in the source table. |
| `target` | `string` (1-256 characters) | yes | Parent table id. A declared target must resolve in the loaded scope; an inferred target may be absent and is then labelled unresolved. |
| `targetColumn` | `string` (1-256 characters) | yes | Parent column name. |
| `kind` | `"declared FK"` or `"inferred by naming"` | yes | Evidence class, exactly one of the two values. A declared relationship comes from whatever evidence source the snapshot identifies; a naming-based one is an observation about column names. The two classes stay distinguishable in data, styling and labels. See C07 and C09. |
| `constraintId` | `string` (up to 256 characters) | no | Constraint identity, non-empty and unique within the source table. Every pair of one composite foreign key shares it. See C11. |
| `name` | `string` (up to 256 characters) | no | Display name for the relationship. |
| `ondelete` | `string` (up to 256 characters) | no | Referential action recorded for the relationship. |
| `cardinality` | `"one-to-many"` or `"one-to-one"` or `"unknown"` | no | Cardinality when the evidence establishes it, otherwise unknown. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaColumn

One column of a table. Only name is required on the wire; normalize() supplies the defaults the views rely on, so the generated TypeScript type describes the normalized document.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `name` | `string` (1-256 characters) | yes | Physical column name, unique within its table. |
| `type` | `string` (up to 256 characters) | no | Declared type as written in the evidence source. An unknown type stays Unknown rather than being guessed. |
| `pk` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Primary-key membership flag. An explicit primaryKey array on the table takes precedence. A column named id is not a primary key without evidence. |
| `fk` | `string` (up to 256 characters) | no | Display-only foreign-key target text. Actual relationships come from links; a link is never invented from this text. See C07. |
| `nullable` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Tri-state nullability: an empty string means unknown, otherwise True or False. Booleans and the legacy string forms are accepted on the wire and coerced by normalize(). |
| `index` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Whether the column carries a single-column index. Partial and expression indexes are excluded from coverage heuristics. |
| `unique` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Whether the column carries a unique constraint of its own. Membership in a composite unique group is a different fact and is not this flag. See C06. |
| `file` | `string` (up to 4096 characters) | no | Evidence file for this column, when it differs from the graph source. |
| `line` | `integer` (at least 0) | no | Line in the evidence file. A non-negative integer; a string is rejected. |
| `typeBasis` | `string` (up to 256 characters) | no | How the type was established, for example a catalog read or an ORM model. |
| `typeDefinition` | `string` (up to 4096 characters) | no | Full type definition text, for example an enumeration body. |
| `default` | any JSON value | no | Default as recorded by the adapter, without a claim about where it is applied. |
| `serverDefault` | any JSON value | no | Default the database applies. See C15. |
| `applicationDefault` | any JSON value | no | Default the application applies. It is not a SQL default and does not constrain rows written by other clients. See C15. |
| `ondelete` | `string` (up to 256 characters) | no | Referential action recorded for this column's declared relationship. |
| `profiling` | `ColumnProfiling` | no | Bounded sample statistics for this column. |
| `sampleValues` | array of `string` or `number` or `boolean` or `null` (up to 256 characters) (at most 3 items) | no | At most three distinct, non-NULL, bounded scalars, written at the column level by the profiler when the caller opted in. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaIndex

An ordered column group. Column-level unique constraints appear as single-column groups; ordered composite groups stay intact.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `name` | `string` (up to 256 characters) | no | Constraint or index name. |
| `columns` | array of `string` (1-256 characters) | no | Ordered column names. Every name must exist in allColumns unless the group is an expression index. |
| `unique` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Whether the group enforces uniqueness. |
| `partial` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Whether the index is partial or filtered. Partial indexes are removed from generic full-coverage heuristics. |
| `expression` | `boolean` or `null`, or `""` or `"True"` or `"False"` or `"true"` or `"false"`, or `0` or `1` | no | Whether the index is over expressions rather than plain columns. Expression indexes are removed from generic full-coverage heuristics. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### SchemaCheck

A named check constraint. The definition is display-only and is never executed. See C04.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `name` | `string` (up to 256 characters) | no | Constraint name. |
| `definition` | `string` (up to 4096 characters) | no | Constraint body as written in the evidence source. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### TableProfiling

Metadata about the profiling run for one table, including its completeness. An incomplete table keeps whatever statistics were gathered; everything else stays unknown. See C01 and C05.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `status` | `"complete"` or `"incomplete"` | no | Whether the profiling run finished for this table. An incomplete table is labelled, never back-filled with zeros. See C01 and C05. |
| `reason` | `string` (up to 256 characters) | no | Why the run is incomplete, in fixed wording chosen by the worker. |
| `sampleSize` | `integer` (at least 0) | no | Rows examined for this table. |
| `sampled` | `boolean` | no | True when the metadata comes from a sample rather than the whole table. |
| `scope` | `string` (up to 256 characters) | no | Scope label for the metadata. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

### ColumnProfiling

Per-column observations from an explicitly requested, read-only, capped sample. Absent fields are unknown, never zero. See C01 and C05.

| Field | JSON form | Required | Notes |
|---|---|---|---|
| `nullFraction` | `number` or `null` (at least 0, at most 1) | no | Observed fraction of NULL values in the sample, or null when the sample was empty. |
| `distinctCount` | `integer` (at least 0) | no | Distinct non-NULL values observed in the sample. A sample distinct count is not a database uniqueness guarantee. See C05. |
| `min` | `string` or `number` or `boolean` or `null` (up to 256 characters) | no | Smallest value observed in the sample, as a bounded scalar. Extremes can be sensitive and are never published implicitly. |
| `max` | `string` or `number` or `boolean` or `null` (up to 256 characters) | no | Largest value observed in the sample, as a bounded scalar. |
| `sampleSize` | `integer` (at least 0) | no | Rows examined for this column. |
| `sampled` | `boolean` | no | True when the statistics come from a sample rather than the whole table. See C05. |
| `scope` | `string` (up to 256 characters) | no | Scope label for the statistics, for example sampled or table. |
| `sampleValues` | array of `string` or `number` or `boolean` or `null` (up to 256 characters) (at most 3 items) | no | At most three distinct, non-NULL, bounded scalars, retained only when the caller opted in. Exports strip them unless the exporter opts in as well. |
| other fields | any JSON value | no | Kept as data and passed through unchanged. |

<!-- generated:fields:end -->

---

## Part B. Contract v1 additions (D3, work package C01)

### B1. `contractVersion`

- New top-level field `contractVersion: string`, semantic `MAJOR.MINOR` (`"1.0"` for the first schema file).
- Today no version field exists (`types.ts:6` has only `tables`, `links`, `project?`, `source?` and an index signature). Documents without the field are treated as `"1.0"`: `normalize()` gains `data.setdefault('contractVersion', '1.0')` (S01) and rejects a different major version with a `ValueError` naming both versions.
- The JSON Schema `$id` carries the same version; the codegen check (`scripts/gen_contract.mjs --check`) fails CI when `contract.generated.ts` drifts from the schema.

### B2. Promoted fields

Fields that views already read but that the TypeScript contract only allows through `[key:string]:unknown` (`types.ts:4`, `:6`) or that `normalize()` defaults without typing. Promotion means: declared in the JSON Schema, typed in `contract.generated.ts`, validated by `normalize()` (type, character set, length) and documented here. Semantics do not change.

| Field | Location | Type | Today | v1 rule |
|---|---|---|---|---|
| `kind` | `tables[]` | `"table" \| "view"`, default `"table"` | Read by Schema Diff through the index signature; `schema_profiler.py:40-42` states view metadata never supplies executable SQL | Enumerated; `"view"` rendered as glass material in City post-MVP (L-02) |
| `definition` | `tables[]` | string, optional, length-capped | Free-form pass-through | Display-only; never executed (C04); capped and control-character-stripped by `normalize()` |
| `checks` | `tables[]` | array of `{name, definition}` | Defaulted to `[]` at `build_explorer.py:37`; names and definitions defaulted at `:68-70`; rendered escaped in the inspector (`explorer.html:77`) | Typed; `definition` length-capped |
| `file` | `tables[]`, `allColumns[]` | string, optional | Read at `explorer.html:77` (`t.file || data.source.file`); column `file` listed in Part A | Typed; path-like string, length-capped |
| `line` | `tables[]`, `allColumns[]` | non-negative integer | Defaulted to `0` at `build_explorer.py:37` and `:46` but never type-checked; rendered unescaped at `explorer.html:77` (finding 1 in `security-architecture.md`) | Integer required; strings rejected by `normalize()` (S01) |
| `sampleValues` | `allColumns[].profiling` | array, max 3 bounded scalars | Typed at `types.ts:1` (`ColumnProfiling.sampleValues`); written only under `include_sample_values=True` (`schema_profiler.py:24-26`) | Max 3 items, each a JSON scalar of at most 256 characters (`MAX_SCALAR_LENGTH`, `schema_profiler.py:79`); stripped from exports unless the exporter opts in |
| `rowCountLowerBound` | `tables[]` | non-negative integer | Typed at `types.ts:4`; set when a sample is capped (`schema_profiler.py:18-20`) | Present only when `rowCount` is `null`; `rowCount` remains `null` when unknown (C01) |
| `profiling.status` | `tables[].profiling` | `"complete" \| "incomplete"`, plus `reason?: string` | Not present; today a budget failure aborts the whole operation (`schema_profiler.py:58-59`) | Written by the worker per table; `incomplete` tables keep whatever statistics were gathered and are labelled unknown for the rest (C05) |

Field precedence for `rowCount`: an exact integer `rowCount` from the adapter or from an exhausted sample; otherwise `null` with an optional `rowCountLowerBound`. Zero is a measured value and is never substituted for unknown (CTQ-01: `data-rowcount="unknown"` and `"0"` stay distinguishable).

C01 enforces that precedence structurally: the schema carries `dependentSchemas: {rowCountLowerBound: {properties: {rowCount: {type: "null"}}}}` on a table, so a lower bound may sit only beside an absent or null count. `schema_profiler.profile()` does not yet obey it -- when the sample is not capped it writes an exact integer `rowCount` and a `rowCountLowerBound` of the same value (`schema_profiler.py:396-398`), which is a redundant bound this schema rejects. Its output is not validated anywhere today; A03 is the owner and must drop the bound once the count is exact (recorded as an out-of-scope finding by C01).

### B3. Id forms used by drill-through

These are the canonical string forms for the `Selection` model and the route grammar (`drill-through-contract.md`). They are derived, never stored in the graph.

| Entity | Id form | Notes |
|---|---|---|
| Table | `table.id` | Already unique (`build_explorer.py:34-36`); may contain dots (Part A) |
| Column | `table.id#column` | `#` is not permitted in `table.id` or `column.name` under v1 (`normalize()` character-set rule, S01); the pair is unique because column names are unique within a table (`build_explorer.py:43-45`) |
| Relationship | `constraintId` when present, else `source.column>target.targetColumn` | A composite FK shares one `constraintId` and is one relationship (C11); the fallback is unique because `normalize()` rejects duplicate `(source, column, target, targetColumn, kind)` tuples (`build_explorer.py:83-86`). `>` is not permitted in identifiers under v1 |
| Finding | opaque `finding.id` | Today `[table, rule, columns, signature].join('|')` (`explorer.html:104`); length-capped in the API (A04) |
| Domain | `table.domain` string | Declared domain, or `D01..Dnn` for discovered communities (`index.tsx:18`) |

Relationship refs are resolved against the loaded graph; an unknown ref is dropped with a warning, never guessed.

### B4. Validation pipeline

Implemented in C01: `packages/contract/schema-graph.v1.json` (the schema), `packages/profiler/bb_profiler/contract.py` (`validate_document()`, `ContractError`), `packages/profiler/tests/test_contract.py` (17 cases), `packages/explorer/src/contract.test.ts` (the TypeScript side of the corpus), `scripts/gen_contract.mjs` with `--check` in `npm test`. `BB_CONTRACT_PATH` overrides the schema location for a copy that ships outside the repository.

1. Structural: `jsonschema` against `schema-graph.v1.json` (types, enums, required fields, length caps, character sets). No character-set `pattern` is imposed on `table.id` or `column.name` under v1, matching `normalize()`; the caps are `NAME_CAP` 256 and `TEXT_CAP` 4096 from `build_explorer.py`, and `sampleValues` items are bounded by `MAX_SCALAR_LENGTH` 256 with at most three items. The error message is `<instance path>: <message>`.
2. Semantic: `normalize()` (13 rules today, unchanged): project key regex (`build_explorer.py:24`), unique table ids (`:34-36`), `allColumns` array (`:39-40`), unique column names (`:43-45`), boolean coercion (`:48-49`), nullable tri-state (`:50`), primary key subset and order (`:53-57`), index and unique column subsets (`:60-67`), link kind (`:73-74`), declared target resolution (`:81-82`), duplicate pair rejection (`:84-86`), composite group consistency (`:89-93`), inferred-link dedupe (`:94-95`). Two defaulting steps are not rules and are not counted: the dialect default (`:26`) and the `source.*` defaults (`:29-31`), both listed under B5. Structural checks that the JSON Schema also covers (`tables`/`links` must be arrays `:27-28`; link source column and target identifiers present `:77-78`) are likewise not counted.
3. Both sides run the same corpus, generated by `scripts/generate-fixtures.mjs` into `fixtures/contract/{valid,invalid}` (the Part A semantic cases from R01) and `fixtures/contract/v1/{valid,invalid}` (the Part B2 promoted-field cases from C01): 8 valid and 10 invalid documents. Each invalid document records the stage that rejects it -- `$structuralError` is the JSON Schema instance path, `$expectedError` is `normalize()`'s message -- and both test suites assert that the two stages partition the corpus, so a document accepted by one side and rejected by the other with no recorded reason fails CI (C01).

Three of the ten invalid documents are caught by both stages (`project`, `project/key`, `links/0/kind`); the schema runs first, so those report the structural message. Three are semantic only, because no JSON Schema can express them: duplicate table ids, duplicate column names, and declared-target resolution. Four are structural only: the major version, the integer `line`, the three-item `sampleValues` cap, and the non-negative `rowCountLowerBound`.

The TypeScript side does not re-implement `normalize()`; it consumes documents that the API has already normalized, and the artifact build always runs `normalize()` inside `render()` (`build_explorer.py:100`).

### B5. Compatibility policy

- **Additive within a major**: new optional fields and new enum values with a documented default. `MINOR` increments. Old readers ignore unknown fields (the index signature stays on `SchemaGraph` and `SchemaTable` for this reason); old documents validate without change.
- **Breaking**: removing or renaming a field, tightening a type, changing the meaning of `kind`, `rowCount`, or `constraintId`, or changing an id form. `MAJOR` increments, the Python side rejects the document, and a migration note is added to `CHANGELOG.md` and to every feature document whose section 6 lists the field.
- **Legacy coercions stay**: `"True"`/`"False"` booleans and nullable strings (`build_explorer.py:13-18`, `:50`) remain accepted for the life of v1 so existing adapters do not break (D9).
- **Renderer defaults stay**: `source.*` defaults at `build_explorer.py:29-31` and `source.basis` wording are part of the contract; adapters should still emit the real values (C09).
- **Extensions bundle and skill**: the copy of `packages/explorer/src` inside the skill must build without Python or the contract package; `contract.generated.ts` is committed, not generated at build time.
- **Deprecation**: a field is marked `deprecated: true` in the schema for at least one `MINOR` before removal in the next `MAJOR`; the docs lint (Q05) fails if a feature document cites a removed field.

### B6. Related documents

- `docs/architecture/drill-through-contract.md` (how the id forms are used)
- `docs/architecture/data-model.md` (`snapshots.contract_version`, `snapshots.graph`)
- `docs/reference/caveats.md` C01, C05, C06, C07, C09, C11, C15 (fields whose semantics carry a caveat)
- `docs/reference/limits-and-caps.md` A1 (`MAX_SCALAR_LENGTH`, sample values), B (upload size cap)
- ADR-0003 (contract oracle)
