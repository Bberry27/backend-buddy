# Extraction and Evidence

## Choose the Source

Use the project's existing schema adapter first. For live documentation, prefer read-only database catalog metadata with an explicitly identified connection/environment. For code documentation, use the ORM/schema definitions and migration graph at a recorded checkout. Do not import an application module merely to inspect it if import can initialize services, run migrations, or contact providers.

Use standard parsers for structured exports and ASTs for language declarations. A loose search for `mapped_column`, `CREATE TABLE`, or `ForeignKey` is a discovery step, not a complete extractor.

## ORM and Migration Coverage

- SQLAlchemy: resolve mapped-column helpers, local mixins, inherited columns, explicit SQL column names, table-level PK/FK/unique/index constraints, compound FKs, type aliases and `with_variant`. Preserve SQL type arguments in supporting metadata. When safe isolated ORM metadata can be loaded, prefer its resolved tables over an incomplete AST approximation. An AST adapter must report dynamic expressions and imports it cannot resolve.
- Prisma/Drizzle/TypeORM/Django/EF: distinguish application navigation properties from physical columns and constraint mappings. Inspect composite IDs, mapped table/column names, join entities, implicit relation tables, and enum/reference definitions using the ecosystem's own schema parser or metadata when possible.
- SQL/DDL: use the dialect's parser or database catalog. Migration files describe transitions; unioning every historical `CREATE TABLE` and `ADD COLUMN` yields tables that may no longer exist. Apply history only in an authorized isolated scratch environment, or use the current model plus explicit reconciliation gaps.
- Live catalogs: collect tables/views, ordered columns, types, PKs, all FK column pairs, unique constraints, indexes including predicates and expressions, and referential actions. A metadata-only request does not authorize scanning customer rows.

## Reconcile Before Rendering

Check table and column totals against an independent listing or model inventory. Every declared FK target must resolve. Preserve composite grouping and column order. Resolve all helper-defined primary keys before calling a table keyless. Include inherited indexes and avoid double counting overridden columns. Mark unknown nullability and types instead of substituting convenient defaults.

Business domains and entity types should use actual module ownership or existing documentation. Prefix heuristics are acceptable when marked inferred. Project-specific aliases belong in the project's adapter/configuration, not the personal skill.

For multi-schema databases use stable qualified lookup IDs and separate physical schema/name fields. Preserve cross-schema references. A single column's apparent uniqueness does not establish uniqueness of each member of a composite key; index coverage depends on order, predicates, and expressions.

## Reproducible Update

Keep the adapter and its configuration in the project. Emit one canonical schema JSON and derive all HTML/Word/Excel outputs from it. Record source hashes or a migration/catalog snapshot identifier. A git commit alone is insufficient when schema files have uncommitted changes; hash the actual source too. Retain an explicit list of unsupported/uninspected constructs in `source.basis`.
