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
