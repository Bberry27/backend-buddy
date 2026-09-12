Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# WP-C01 Contract v1

| Field | Value |
|---|---|
| Work package | C01 (track C, phase 1) |
| Features | F22, F16, F17 (the contract carries `profiling.status`, `rowCountLowerBound`, and `sampleValues` for F17; F16 validates uploads against it in A04; F16 and F17 have no feature document yet, registry rows `docs/features/README.md:34-35`) |
| CTQs | CTQ-01 (schema rules for `rowCount`/`rowCountLowerBound`/`profiling.status`), CTQ-07 (length caps and enums as structural validation), CTQ-13 (`schema-contract.md` regenerated from the schema; drift check in CI) |
| Caveats | none surfaced in UI; C01, C05, C07, C09, C11, C15 govern field semantics (`docs/architecture/schema-graph-contract.md` B6) and the JSON Schema `description` strings may cite them by id only, never paraphrase them |
| Depends on | S01 (`contractVersion` setdefault and major-version reject, `_text` validators, integer `line` in `normalize()`) |
| Blocks | C03 (generated types), A01 (`snapshots.contract_version`), A03 (`bb_profiler.contract`), A04 (upload validation) |
| Branch | `c01/contract-v1` |
| Gate | G1 |

### 1. Goal

Make `packages/contract/schema-graph.v1.json` the single source of truth for the SchemaGraph contract: TypeScript types generated from it into `packages/explorer/src/contract.generated.ts` and re-exported by `types.ts` so the nine views compile untouched; a Python module that validates a document with `jsonschema` against the same file and then runs `build_explorer.normalize()` as the semantic oracle (never reimplemented); a shared valid/invalid corpus exercised on both sides with a CI drift check; and `skill/references/schema-contract.md` field tables regenerated from the schema. The contract stays backward compatible: every fixture and every document accepted today validates as `contractVersion "1.0"`.

### 2. Reading list (ordered)

1. `docs/architecture/schema-graph-contract.md` in full: Part A (verbatim legacy contract), Part B1 (`contractVersion`), B2 (promoted fields and their v1 rules), B3 (id forms; note open question 1), B4 (validation pipeline: structural, then `normalize()`, both sides run the same corpus), B5 (compatibility policy: additive within a major, legacy coercions stay, `contract.generated.ts` committed not generated at build time), B6.
2. `docs/architecture/adr/ADR-0003-backend-fastapi-and-contract-oracle.md` decisions 3-4 and `ADR-0001-monorepo-layout.md` (`packages/contract`, `packages/profiler` locations).
3. `docs/features/F22-offline-artifact-and-skill.md` section 4 B5 and section 6.
4. `docs/reference/limits-and-caps.md` A1 (`MAX_SCALAR_LENGTH` 256 bounds `sampleValues` items) and the section A rows S01 added for text caps (the schema's `maxLength` values must equal them; DL-08 will check `limits-and-caps.md` against code, and this package keeps schema and `normalize()` aligned).
5. `docs/reference/caveats.md` C01, C05, C07, C09, C11, C15 (semantics behind `rowCount`, `profiling.status`, `kind`, `source.basis`, `constraintId`, `applicationDefault`/`serverDefault`).
6. Code, in this order:
    - `packages/explorer/src/types.ts` (10 lines): `ColumnProfiling` `:1`, `SchemaColumn` `:2`, `SchemaIndex` `:3`, `SchemaTable` with index signature `:4`, `SchemaLink` with `kind` union `:5`, `SchemaGraph` with `project?`, `source?`, index signature `:6`, `SubtreeResult` `:7`, `ProfileResult` `:8`, `LiveConnection` `:9`, `ViewProps` `:10`. The first six move to the generated file (re-exported); `:7-10` stay hand-written.
    - `skill/scripts/build_explorer.py:21-96` (`normalize()` after S01: rule list in `schema-graph-contract.md` B4; defaults at `:26`, `:29-31`, `:37`, `:46`; `boolean()` at `:13-18` accepts `True/'True'/'true'/1`).
    - `skill/scripts/test_renderer.py::fixture()` (`:9-22`): a document with `nullable: False` (boolean) and `pk=True`; the schema must accept the legacy forms B5 lists.
    - `fixtures/contract/valid/*.json` (`composite-fk-group`, `composite-primary-key`, `external-stub`, `legacy-flags`, `view-with-definition`) and `fixtures/contract/invalid/*.json` (`duplicate-column-name`, `duplicate-table-id`, `link-kind-fk`, `missing-project-key`, `unresolved-declared-fk`, `uppercase-project-key`; each carries `$expectedError`); `fixtures/test_fixtures_normalize.py` (how the corpus is consumed today); `scripts/generate-fixtures.mjs` (the corpus generator: new cases are added there, never by hand).
    - `packages/explorer/src/schema-diff-logic.ts:39` (`parseSchemaSnapshot`: the TypeScript side's existing structural parser with caps at `:44`, `:50`, `:68`; the generated types must be assignable to what it returns).
    - `packages/explorer/server/schema_profiler.py:18-27` (fields the profiler writes: `rowCount`, `rowCountExact`, `rowCountLowerBound`, `sampleSize`, `profiling`, `sampleValues`), `:297-302` (`min`/`max` scalars).
    - `skill/references/schema-contract.md` (59 lines; the field tables to regenerate) and `docs/architecture/schema-graph-contract.md` Part A, which quotes it verbatim and must be regenerated in the same PR.
    - `scripts/project.mjs:104-114` (the `test` step must also discover `packages/profiler/tests`); `.github/workflows/ci.yml` `python` job (S02 owns the file; see out of scope).
7. `AGENTS.md` sections 5-7 ("Reimplement `normalize()`" is in the do-not list).

### 3. In scope

1. **`packages/contract/schema-graph.v1.json`** (JSON Schema draft 2020-12, `$id` carrying `v1`): every field of Part A and B2 with types, enums (`kind`: `table|view`; `links[].kind`: `declared FK|inferred by naming`; `profiling.status`: `complete|incomplete`; `nullable`: boolean, `''`, `'True'`, `'False'`, `null`), `required` sets matching `normalize()` (`project.name`, `project.key` with the regex from `build_explorer.py:24`, `tables`, `links`, `tables[].id`, `allColumns`, `allColumns[].name`, `links[].source/column/target/targetColumn/kind`), `maxLength` equal to the S01 caps, `line` as non-negative integer, `sampleValues` `maxItems 3` with scalar items, `rowCountLowerBound` non-negative integer, `contractVersion` pattern `^1\.[0-9]+$` with default `"1.0"`, `additionalProperties` permitted at table, column, and graph level (B5: unknown fields are ignored). `description` strings cite caveats by id (`See C01`), never quote or paraphrase them.
2. **`scripts/gen_contract.mjs`**: dependency-free generator (open question 2) from the schema to `packages/explorer/src/contract.generated.ts` (interfaces `SchemaGraph`, `SchemaTable`, `SchemaColumn`, `SchemaIndex`, `SchemaLink`, `ColumnProfiling`, `TableProfiling`, `SchemaProject`, `SchemaSource`, plus `CONTRACT_VERSION = '1.0'`), with a header stating it is generated; `--check` mode regenerates to memory and exits 1 on drift; `--docs` mode emits the Markdown field tables consumed by `skill/references/schema-contract.md` between marker comments (`<!-- generated:fields:start -->` / `end`) so prose stays hand-written. `npm run contract` and `npm run contract:check` scripts at the root.
3. **`packages/explorer/src/types.ts`**: `export type {SchemaGraph, SchemaTable, SchemaColumn, SchemaIndex, SchemaLink, ColumnProfiling} from './contract.generated'` plus the unchanged hand-written `SubtreeResult`, `ProfileResult`, `LiveConnection`, `ViewProps`. `npm run typecheck` must pass with no view changed; the index signatures on `SchemaTable` and `SchemaGraph` are preserved in the generated types (B5).
4. **`packages/profiler/bb_profiler/__init__.py`** and **`contract.py`**: `validate_document(raw) -> dict` runs `jsonschema.Draft202012Validator` against the schema file (located relative to the repository root, with an environment override `BB_CONTRACT_PATH` for the skill copy), then `build_explorer.normalize()` imported from `skill/scripts/build_explorer.py` (path import; A03 decides the packaging), returning the normalized document; `ContractError(ValueError)` carrying the structural error path or the `normalize()` message. `packages/profiler/requirements.txt` lists `jsonschema` (exact version) and nothing else; `packages/profiler/tests/test_contract.py` with `test_C01_*` cases: every `fixtures/schemas/*.json` and `fixtures/contract/valid/*.json` validates; every `fixtures/contract/invalid/*.json` raises and the message contains `$expectedError`; `contractVersion` absent -> `"1.0"` present after validation; a document with `contractVersion "2.0"` raises; a structurally valid document that `normalize()` rejects (unresolved declared FK) raises with the `normalize()` message (proves the oracle is called).
5. **TypeScript corpus test** `packages/explorer/src/contract.test.ts` (node:test): every valid corpus document and every `fixtures/schemas/*.json` parses with `parseSchemaSnapshot` (`schema-diff-logic.ts:39`) and satisfies the generated `SchemaGraph` type (compile-time via `satisfies` on a loaded sample plus runtime shape checks for the enums and `contractVersion`); every invalid corpus document whose `$expectedError` names a structural rule is rejected by `parseSchemaSnapshot` or explicitly listed as "semantic, Python-only" in the test (the two rejection sets must partition the invalid corpus; a document accepted by one side and rejected by the other with no listed reason fails).
6. **Corpus additions** through `scripts/generate-fixtures.mjs` (then `npm run fixtures`): valid `contract-version-1-1.json` (`contractVersion "1.1"`, an unknown extra field), `profiling-status-incomplete.json` (`profiling.status "incomplete"` with `reason`, `rowCount null`, `rowCountLowerBound`), `sample-values-three.json`; invalid `contract-version-2-0.json`, `line-as-string.json`, `sample-values-four.json`, `negative-row-count-lower-bound.json`, each with `$expectedError`. `fixtures/test_fixtures_normalize.py` keeps passing (it only asserts `ValueError`, which `ContractError` subclasses).
7. **Wiring**: `scripts/project.mjs` `test` step discovers `packages/profiler/tests` (`unittest('packages/profiler/tests')`, guarded like the fixtures step) and runs `node scripts/gen_contract.mjs --check`; `skill/references/schema-contract.md` regenerated tables and a `contractVersion` paragraph; `docs/architecture/schema-graph-contract.md` Part A refreshed to match, Part B4 updated to say the pipeline exists; `docs/features/F22-offline-artifact-and-skill.md` sections 3, 6, 14; `CHANGELOG.md`.

### 4. Out of scope

- Any change to `normalize()` or `render()`: S01 owns `build_explorer.py`. If the schema needs a rule `normalize()` lacks, record it as "Out of scope, found" for S01 (or, after G1, for the owner), do not add it here.
- Moving `schema_profiler.py` into `packages/profiler`, the `Driver` protocol, `compat.py`, `policy.py`, `targets.py`: A03. This package creates only `bb_profiler/__init__.py`, `contract.py`, `requirements.txt`, and `tests/test_contract.py`.
- `services/api`, pydantic models, Alembic `snapshots.contract_version`: A01/A04. No pydantic codegen of the graph anywhere (ADR-0003 decision 4).
- `ViewProps`, `Selection`, `NavigationTarget`, route grammar: C03.
- `.github/workflows/ci.yml` and `security.yml` edits (a `contract-drift` step and `pip-audit -r packages/profiler/requirements.txt`): S02 owns the workflows; list both as "Out of scope, found" with the exact lines to add (`ci.yml` `python` job: `python -m unittest discover -s packages/profiler/tests -p 'test_*.py'`; `security.yml:76`: second requirements file).
- Runtime JSON Schema validation in the browser (ajv or similar): not at MVP; the TypeScript side consumes API-normalized documents (B4).
- A `contractVersion` major bump or any breaking change (B5).
- Field-table prose in `skill/references/schema-contract.md` outside the generated markers.

### 5. May modify

```
packages/contract/**                                  (new: schema-graph.v1.json, README.md)
scripts/gen_contract.mjs, scripts/gen_contract.test.mjs   (new)
packages/explorer/src/contract.generated.ts           (new, committed, generated only by gen_contract.mjs)
packages/explorer/src/types.ts                        (re-exports; hand-written interfaces at today's :7-10 unchanged)
packages/explorer/src/contract.test.ts                (new)
packages/profiler/bb_profiler/__init__.py, packages/profiler/bb_profiler/contract.py, packages/profiler/requirements.txt, packages/profiler/tests/__init__.py, packages/profiler/tests/test_contract.py   (new)
scripts/generate-fixtures.mjs                         (corpus cases only; then npm run fixtures)
scripts/generate-fixtures.test.mjs                    (expectations for the new corpus files)
scripts/project.mjs                                   (test step: profiler tests discovery and contract --check)
package.json                                          (scripts contract, contract:check only; no dependency)
skill/references/schema-contract.md                   (generated tables between markers; one contractVersion paragraph)
docs/architecture/schema-graph-contract.md            (Part A refresh, B4 status)
docs/features/F22-offline-artifact-and-skill.md       (sections 3, 6, 14)
CHANGELOG.md                                          ([Unreleased], prefixed C01:)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build (types.ts and contract.generated.ts propagate)
fixtures/**                             generated; edit scripts/generate-fixtures.mjs and run npm run fixtures
THIRD_PARTY_NOTICES.md                  generated; jsonschema is a Python dependency and is listed in packages/profiler/requirements.txt, not here
package-lock.json, packages/explorer/package.json, packages/explorer/package-lock.json   no JavaScript dependency (open question 2)
skill/scripts/build_explorer.py         S01 (normalize() is imported, never edited or copied)
skill/assets/explorer.html              S01 / S03
packages/explorer/src/*.tsx             the nine views compile untouched; if one fails to typecheck against the generated types, the generator is wrong, not the view
packages/explorer/src/*-logic.ts        C03 / W-track
packages/explorer/server/**             S03 / A03
docs/reference/caveats.md               frozen at G0
docs/reference/limits-and-caps.md       caps are S01's; the schema copies them
.github/workflows/**                    S02
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| SchemaGraph backward compatibility: additive only; `kind` values `declared FK` / `inferred by naming` unchanged; legacy boolean strings and nullable forms accepted; index signatures kept | `schema-graph-contract.md` B5; `types.ts:4-6` today | `test_C01_all_fixture_schemas_validate`, `test_C01_legacy_flags_accepted`; `npm run typecheck` with untouched views |
| `normalize()` is the oracle, imported not reimplemented | D3; ADR-0003 decision 4 | `test_C01_semantic_rejection_comes_from_normalize` (message text originates in `build_explorer.py`) |
| `contractVersion` handling: default `"1.0"`, major mismatch rejected, minors accepted | B1; S01 `normalize()` | `test_C01_contract_version_*` (Python) and the corpus files |
| Generated paths never hand-edited: `contract.generated.ts`, `fixtures/**` | repository-wide list | `node scripts/gen_contract.mjs --check`; `node --test scripts/generate-fixtures.test.mjs` |
| `ViewProps`, `LiveConnection`, `SubtreeResult`, `ProfileResult` stay hand-written and unchanged in this package | `types.ts:7-10` | `git diff` of those four declarations is empty |
| Profiler caps (`MAX_SCALAR_LENGTH 256` bounds `sampleValues` items; `MAX_ROWS` etc.) | `schema_profiler.py:73-80` | Schema `maxLength 256` on `sampleValues` items and `min`/`max` string forms; `test_schema_profiler.py` untouched |
| Unknown stays unknown: `rowCount` nullable, never coerced; `rowCountLowerBound` present only with `rowCount null` (schema `dependentSchemas`) | C01; `schema-graph-contract.md` B2 | `test_C01_lower_bound_requires_null_rowcount`, invalid corpus case |
| Artifact CSP, storage key families, host CSS variables | repository-wide list | Untouched |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, names prefixed `C01` (`test_C01_*` in Python and `test('C01 ...')` in node:test), green with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F22; `docs/architecture/schema-graph-contract.md` B4 marked as implemented with file paths
- [ ] Migration: none, because no database exists yet; A01 adds `snapshots.contract_version` and cites this package
- [ ] `CHANGELOG.md` lines prefixed `- C01: `
- [ ] Release-note line in the PR body
- [ ] Security checklist (interim): `jsonschema` pinned exactly; `pip-audit -r packages/profiler/requirements.txt` run locally and clean; the schema enforces every S01 cap so structurally oversized documents are rejected before `normalize()`
- [ ] Accessibility result: n/a, no UI change
- [ ] Performance: none, because no budget applies; record validation time of `fixtures/schemas/medium.json` (structural + `normalize()`) in the PR body as an informational baseline for A04 upload handling
- [ ] Caveat text: none quoted; schema `description` strings cite ids only (`grep -c "C0[1-9]\|C1[0-6]" packages/contract/schema-graph.v1.json` > 0, and none of them contains more than 12 consecutive words of a canonical caveat)
- [ ] `npm run guard` green; corpus files are synthetic and generated
- [ ] `npm run build` run and the mirror committed (`skill/assets/extensions/src/types.ts` and `contract.generated.ts` follow)
- [ ] All changed paths inside the `may-modify` globs
- [ ] `skill/references/schema-contract.md` regenerated tables equal `gen_contract.mjs --docs` output byte for byte

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order.

```sh
npm run restore
python3 -m pip install -r packages/profiler/requirements.txt
npm run guard
node scripts/gen_contract.mjs --check                                             # exit 0, "contract.generated.ts up to date"
node scripts/gen_contract.mjs --docs | diff - <(sed -n '/generated:fields:start/,/generated:fields:end/p' skill/references/schema-contract.md)   # empty
npm run typecheck                                                                 # nine views untouched
git diff --quiet main -- packages/explorer/src/*.tsx                              # exit 0 (no view changed)
npm test                                                                          # includes contract.test.ts, packages/profiler/tests, fixtures
python3 -m unittest discover -s packages/profiler/tests -p 'test_*.py' -v 2>&1 | grep -c 'test_C01_'   # >= 8
node --test packages/explorer/src/contract.test.ts 2>&1 | grep -c '^ok'          # >= 1 with 0 failures
node --test scripts/generate-fixtures.test.mjs                                    # corpus additions committed and byte-identical to the generator
npm run fixtures && git diff --quiet fixtures                                     # generator output equals the committed fixtures
npm run build
git status --porcelain skill/assets/extensions/src | grep -v 'types.ts\|contract.generated.ts' | wc -l   # 0
python3 - <<'EOF'
import json, sys
sys.path.insert(0, 'packages/profiler')
from bb_profiler.contract import validate_document, ContractError
doc = json.load(open('fixtures/schemas/medium.json', encoding='utf-8'))
out = validate_document(doc); assert out['contractVersion'] == '1.0', out.get('contractVersion')
doc['contractVersion'] = '2.0'
try:
    validate_document(doc); print('FAIL: major mismatch accepted'); sys.exit(1)
except ContractError as e:
    print('ok:', e)
EOF
```

### 10. Reporting format

Per `agent-briefs/README.md` section 10. Measurements: number of corpus documents per side and per outcome (valid/invalid, structural/semantic), medium-fixture validation time. "Out of scope, found" must include the two CI lines for S02 (section 4) and any `normalize()` rule the schema cannot express (for S01 or the owner).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-02 contract churn | Freezes the field set and id forms of Part B before C03 and any view work; additive-only policy pinned by tests |
| RK-01 private-data leakage | Corpus documents are generated by `scripts/generate-fixtures.mjs` from word lists; no real snapshot enters the corpus |
| RK-22 duplicated source trees | `npm run build` after changing `types.ts`; `contract.generated.ts` is committed so the skill copy builds without the generator |
| RK-23 CI has never run | The new Python tests run under `npm test` via `scripts/project.mjs`; the CI additions are handed to S02 explicitly |
| RK-10 scope creep | No profiler move, no API, no browser validator |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). |

Open questions for the owner (needed before C01 starts):

1. `schema-graph-contract.md` B3 says `#` and `>` are not permitted in `table.id` or `column.name` under v1, but `fixtures/schemas/hostile.json` contains four table ids with `>` (see WP-S01 open question 1). If S01 does not enforce the rule, the JSON Schema must not carry a `pattern` forbidding them either; C03 then percent-encodes separators in `route-state.ts`. This brief assumes no such `pattern` (consistent with WP-S01's default).
2. Generator dependency: this brief specifies a dependency-free `scripts/gen_contract.mjs` covering the schema subset used (objects, arrays, primitives, enums, `oneOf` for `nullable`). If the owner prefers `json-schema-to-typescript`, the exact version must be added to the may-modify list (`package.json`, `package-lock.json`) and `THIRD_PARTY_NOTICES.md` regenerated (devDependencies are not bundled; confirm `generate_notices.mjs` scope).
3. Corpus location: the plan names `packages/contract/fixtures/contract/{valid,invalid}` while R01 landed `fixtures/contract/{valid,invalid}`. This brief keeps one corpus at `fixtures/contract/` (generated) and makes `packages/contract/README.md` point to it. Confirm.
