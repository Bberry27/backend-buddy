Status: draft | Owner: Security lead | Last verified against code: pre-repo (2026-09-07)

# WP-S01 Artifact and renderer hardening

| Field | Value |
|---|---|
| Work package | S01 (track S, phase 1) |
| Features | F01, F04, F15, F19, F22 (F19 has no feature document yet; its registry row is `docs/features/README.md:37`) |
| CTQs | CTQ-05, CTQ-06, CTQ-07, CTQ-10 (host `render()` part only), CTQ-14 |
| Caveats | C04 (quoted below; the wording the "no SQL for this dialect" message must not contradict) |
| Depends on | R01 (fixtures, `fixtures/schemas/hostile.json`) |
| Blocks | S02, S03, C01, W03 |
| Branch | `s01/artifact-renderer-hardening` |
| Gate | G1 |

### 1. Goal

Close the five artifact and renderer findings that Gate G1 lists (`docs/product-management/roadmap.md`, "Gate G1": XSS at `explorer.html:77`; quoting and dialect gate at `:108`/`:110`; `normalize()` validators; render escapes including mixed-case `</script`; CSV vectors), each with a named regression test, without changing the artifact CSP, the SchemaGraph contract's accepted inputs (beyond rejecting malformed ones), or any of the nine React views. S01 is the single owner of `skill/assets/explorer.html` and `skill/scripts/build_explorer.py` during Phase 1; the host `render()` change that stops unconditional unmounting is included because it is a one-line edit to the same file (its effect is only observable after C03 makes `mount()` reuse the root).

### 2. Reading list (ordered)

1. `docs/features/F22-offline-artifact-and-skill.md` sections 3, 4 (B1-B3), 10, 14: what the artifact is, the defects list, and the behaviours this package implements.
2. `docs/features/F04-schema-review.md` section 3 ("Validation SQL", "Defects and gaps") and section 14: the `quote`/`tableSQL`/`readonly` helpers at `explorer.html:97-101` and the two SQL defects.
3. `docs/features/F15-inspector.md` section 3: the `detail()` sink at `explorer.html:77` and its reachability on page load.
4. `docs/architecture/security-architecture.md` section 5 (findings 1-5 and their verifying tests) and section 6.1 (the CSP that must not change).
5. `docs/architecture/schema-graph-contract.md` Part B: B1 (`contractVersion` setdefault and major-version reject are S01 work), B2 (`line` becomes a required non-negative integer; `definition` and `checks[].definition` are capped and control-character-stripped), B3 (the `#` / `>` identifier rule: see open question 1 before implementing), B5 (legacy coercions stay).
6. `docs/architecture/adr/ADR-0006-deployment-topology-and-artifact-csp.md` decision 5 and `ADR-0002-frontend-spa-and-iife-export-path.md` decision 3 (host `render()` unmounts only on view change; root reuse itself is C03).
7. `docs/architecture/adr/ADR-0007-private-data-and-fixture-policy.md` decision 7: the hostile fixture is the only fixture allowed to contain markup-like text.
8. `docs/reference/caveats.md` C04 (wording of the SQL-never-executed caveat; the dialect message must stay consistent with it).
9. `docs/reference/limits-and-caps.md` sections A2 (the `10s` timeout text at `explorer.html:99` is display text) and C (preserved constants: CSP, 16 host variables, `kind` values, storage key families). New length caps you introduce are recorded in section A (see section 3 below).
10. Code, in this order:
    - `skill/assets/explorer.html:34` (`E()` escape helper: `& < > " '`), `:39-41` (storage prefix, `colors` map), `:58` (`data.source.commit.slice(0,8)` crash path), `:77` (the `${t.line}` sink inside `detail()`), `:97-101` (`quote`, `tableSQL`, `readonly`, `duplicates`, `orphanSQL`), `:104` (`add()` and the finding id), `:108` and `:110` (the two SQL generators to fix), `:126` (`buildFindings()` runs at module load), `:171` (`colors[n.t.type]||'var(--accent)'`), `:178` (`render()` calls `window.BackendBuddyViews?.unmount()` unconditionally), `:179-180` (`download`, `exportCSV` with the `cell` guard `/^[=+@-]/`), `:192-197` (`renderExtension` and `mount`).
    - `skill/scripts/build_explorer.py:13-18` (`boolean()`), `:21-96` (`normalize()`; table defaults incl. `line: 0` at `:37`, column defaults incl. `line: 0` at `:46`, `project.key` regex at `:24`), `:99-108` (`render()`: `html.escape` and JSON `<` escaping at `:103`, case-sensitive `</script` at `:105`, CSS verbatim at `:106`, one-pass `re.sub` at `:108`).
    - `skill/scripts/test_renderer.py` (9 tests; `fixture()` at `:9-22` is the fixture builder to reuse; the only injection test is `:60-68`).
    - `packages/explorer/server/test_explorer_http.py:373-407`: the node `vm` pattern that slices a function range out of the template and executes it with a fake context. Reuse this pattern to test host SQL generation and the CSV cell encoder without a browser.
    - `fixtures/schemas/hostile.json` and `fixtures/README.md` ("Schema fixtures" table, `hostile.json` row); `fixtures/test_fixtures_normalize.py` (renders the hostile fixture and must stay green).
    - `scripts/project.mjs:104-114` (the `test` step; `:108` discovers only `test_renderer.py`).
11. `AGENTS.md` sections 5-7 (definition of done, pre-commit commands, "do not" list). `docs/engineering/standards.md`, `security-policy.md`, `testing-policy.md` are D03 deliverables and do not exist yet; until they land, `AGENTS.md` and `CONTRIBUTING.md` are the standards.

### 3. In scope

Every finding below is closed only by the change and the named test together. Test names carry the `S01` prefix (Python `def test_S01_...`) per `docs/product-management/traceability.md` section 2.

| # | Finding (file:line) | Change | Test that proves it fixed |
|---|---|---|---|
| 1a | Stored XSS: `${t.line}` unescaped inside `innerHTML` at `skill/assets/explorer.html:77` (`<dd>${E(t.file||data.source.file)}:${t.line}</dd>`) | Wrap as `${E(t.line)}` | `skill/scripts/test_renderer_security.py::test_S01_host_source_line_is_escaped`: asserts the template contains `:${E(t.line)}</dd>` and contains no `${t.line}` outside an `E(...)` call (source pin; the DOM-level proof is 1c) |
| 1b | `normalize()` defaults `line` to `0` at `build_explorer.py:37` (table) and `:46` (column) but never type-checks it | Validate `line` as a non-negative `int` (`bool` excluded) for tables and columns; a string, float, negative, or object raises `ValueError` naming the table or column | `test_S01_string_table_line_rejected`, `test_S01_string_column_line_rejected`, `test_S01_negative_or_bool_line_rejected`, `test_S01_integer_line_preserved` |
| 1c | No browser-level proof that hostile content renders inert | Author `tests/security/artifact.spec.ts` with `test('CTQ-07 hostile fixture inert', ...)`: build the artifact from `fixtures/schemas/hostile.json`, open it from `file://`, select every table through the inspector, assert no `dialog` event, no element injected outside `#detail`'s expected structure, and `document.title` equals the escaped project name; and `test('CTQ-05 csp byte-identical', ...)` asserting the `<meta http-equiv="Content-Security-Policy">` content equals the frozen string. The spec is authored here and first executed in S02 (Playwright is not a dependency before S02); S01's runnable proof is 1a and 1b | `tests/security/artifact.spec.ts` exists, is referenced in `docs/features/F22-offline-artifact-and-skill.md` section 9, and runs green in S02 |
| 2a | `explorer.html:108` ("Repeating numbered fields") builds `FROM ${quote(t.id)}`; a dotted display id becomes one quoted identifier, contradicting `skill/references/schema-contract.md:32` | Use `tableSQL(t.id)` | `test_S01_review_sql_uses_qualified_table_names`: node `vm` execution of the template slice from `const quote=` (`:97`) to the line before `const findings=buildFindings()` (`:126`) with a synthetic `data` whose table has `id 'public.items'`, `schema 'public'`, `name 'items'` and two numbered columns; asserts the generated SQL contains `"public"."items"` and not `"public.items"` (skip with a message when `node` is not on `PATH`, as `test_explorer_http.py:373` does) |
| 2b | `explorer.html:110` ("Structured payloads") uses `quote(t.id)` and emits `jsonb_typeof(...)::jsonb` (PostgreSQL only) whenever the type contains `JSON`, then `readonly()` wraps it in the SQLite form | `tableSQL(t.id)`; dialect gate: `postgresql` -> `jsonb_typeof(<col>::jsonb)`; `sqlite` -> `json_type(<col>)`; any other dialect -> no SQL and the finding's `next` text gains the sentence `No validation SQL is generated for dialect <dialect>.` (the phrase must not paraphrase C04) | `test_S01_structured_payload_sql_postgresql`, `test_S01_structured_payload_sql_sqlite_uses_json_type`, `test_S01_structured_payload_no_sql_for_unknown_dialect` (same `vm` harness, `data.project.dialect` varied) |
| 2c | `structured[0].type.toUpperCase()` at `:110` throws when a column `type` is not a string and takes the whole page down because `buildFindings()` runs at load (`:126`) | Closed by finding 3 (`type` is validated as text) | `test_S01_non_string_column_type_rejected` |
| 3 | `normalize()` has no type, character-set, or length validation on display fields (`build_explorer.py:24-96`): `project.name`; `source.file`, `source.commit`, `source.sha256`, `source.generated`, `source.basis`; table `name`, `schema`, `className`, `domain`, `type`, `file`, `definition`; column `type`, `fk`, `ondelete`, `typeBasis`, `typeDefinition`; `indexes[].name`, `uniques[].name`; `checks[].name`, `checks[].definition`; `links[].constraintId`, `links[].name`. Non-string values crash the page (`explorer.html:58`, `:110`) or the build (`html.escape` at `build_explorer.py:103`) | Add `_text(value, field, *, cap)` in `build_explorer.py`: rejects non-`str` with `ValueError` naming the field; strips NUL, C0 controls (except `\n` and `\t` inside `definition`, `checks[].definition`, `source.basis`), DEL, and the bidi controls U+202A-U+202E and U+2066-U+2069; rejects values longer than the cap. Apply to every field above where `normalize()` already `setdefault`s it. Caps are new rows in `docs/reference/limits-and-caps.md` section A (proposed values: 256 characters for identifiers, labels, names, and `source.commit`/`sha256`/`generated`; 4,096 for `definition`, `checks[].definition`, `source.basis`, `source.file`, table `file`; confirm at kickoff, open question 2). Table `id` and column `name` keep their existing uniqueness rules and gain the same 256 cap (the hostile fixture's longest identifier is 128 characters and must still pass) | `test_S01_non_string_project_name_rejected`, `test_S01_non_string_source_commit_rejected`, `test_S01_control_characters_stripped_from_display_fields`, `test_S01_bidi_controls_stripped`, `test_S01_over_length_identifier_rejected`, `test_S01_definition_keeps_newlines_and_tabs`, `test_S01_hostile_fixture_still_normalizes` (loads `fixtures/schemas/hostile.json`) |
| 4 | `render()` template breakout: `__EXTENSIONS_JS__` escapes only lowercase `</script` (`build_explorer.py:105`); `__EXTENSIONS_CSS__` is inlined verbatim into the `<style>` block (`:106`, template `:16`); `<!--` is not neutralised in either | JS: `re.sub(r'(?i)</script', r'<\\/script', ...)` and `<!--` -> `<\!--`; CSS: `(?i)</style` -> `<\/style` and `<!--` -> `<\!--` (valid CSS escapes). Keep the one-pass `re.sub` at `:108` | `test_S01_render_escapes_mixed_case_script_close` (`</SCRIPT>`, `</Script >`), `test_S01_render_escapes_style_close_in_css`, `test_S01_render_neutralises_html_comment_open_in_js_and_css`. Tests point `build_explorer.ROOT` at a temporary copy of `skill/assets/` whose `extensions/dist/extensions.{js,css}` contain the vectors, and assert the rendered output has no raw `</script`, `</style`, or `<!--` after the template's own `<script>`/`<style>` structure |
| 5 | CSV formula guard is prefix-only at `explorer.html:180` (`/^[=+@-]/`) | Hoist the cell encoder to a module-level `const csvCell = v => ...` used by `exportCSV`, guarding `= + - @ \t \r` after optional leading whitespace (`/^\s*[=+\-@\t\r]/`) with the `'` prefix, quotes doubled, BOM and CRLF unchanged | `test_S01_csv_cell_neutralises_formula_vectors` (`vm` slice of `csvCell`; vectors `=1+1`, ` =1`, `\t=1`, `\r=1`, `+1`, `-1`, `@A1`, `"quoted"`, plain text unchanged) |
| 6 | `colors[n.t.type]||'var(--accent)'` at `explorer.html:171` resolves inherited keys (`constructor`, `toString`) to functions | `Object.hasOwn(colors,n.t.type)?colors[n.t.type]:'var(--accent)'` | Source pin in `test_S01_entity_type_colour_lookup_uses_hasown`; DOM proof folded into 1c (the hostile fixture uses `constructor` and `hasOwnProperty` as types) |
| 7 | No `contractVersion` (`schema-graph-contract.md` B1) | `data.setdefault('contractVersion', '1.0')`; reject when the major part differs from `1` with `ValueError` naming both versions; accept `1.x` | `test_S01_contract_version_defaults_to_1_0`, `test_S01_contract_version_major_mismatch_rejected`, `test_S01_contract_version_minor_accepted` |
| 8 | `render()` at `explorer.html:178` calls `window.BackendBuddyViews?.unmount()` on every render, including every filter keystroke | Track the last rendered view; call `unmount()` only when `state.view` changes or when the new view is a host view; still call `mount()` for React views (C03 makes `mount()` reuse the root; until then behaviour is unchanged because `mount()` unmounts internally at `index.tsx:22`) | Source pin `test_S01_host_render_unmounts_only_on_view_change`; behavioural proof is the S02 remount counter in `scripts/verify_host.mjs` and CTQ-10 in W01 |
| 9 | `scripts/project.mjs:108` discovers only `test_renderer.py`, so the new test module would never run under `npm test` | Change the pattern to `'test_*.py'` for `skill/scripts` | `npm test` output lists the `S01` tests |

Documentation in scope: `docs/features/F22-offline-artifact-and-skill.md` sections 3 and 14, `docs/features/F04-schema-review.md` sections 3 and 14 (SQL defects closed), `docs/features/F15-inspector.md` section 3 (sink closed), `docs/reference/limits-and-caps.md` section A (new caps), `CHANGELOG.md` (`Security` entries move from "scheduled" to fixed, prefixed `S01:`), and `skill/references/schema-contract.md` only if a new rule (integer `line`, caps) needs one sentence there.

### 4. Out of scope

- Loopback server, capability token, `Host` allowlist, live bridge at `explorer.html:186-190`: S03.
- Playwright toolchain, executing `tests/security/artifact.spec.ts`, `verify_host.mjs` changes, `ci.yml` edits (including `.github/workflows/ci.yml:59`, which also discovers only `test_renderer.py`): S02.
- JSON Schema, `contract.generated.ts`, `jsonschema` validation on the Python side: C01. S01 adds only `contractVersion` handling and text validators inside `normalize()`.
- Root reuse in `packages/explorer/src/index.tsx`, `mount-policy.ts`: C03.
- Lifting `buildFindings`, `orphanSQL`, `tableSQL`, `exportCSV`, `exportSVG` into tested TypeScript modules and deleting inline renderers: W03. S01 fixes the inline code in place.
- Finding-id scheme (`explorer.html:104`, risk RK-13): A04 and L-06.
- Failing the render when `extensions.js`/`extensions.css` are absent (risk RK-12, roadmap open question 4): not decided; do not implement unless the owner approves it before kickoff.
- Any hex colour, theme, or token change: C02.
- Trusted Types, nonces, or any CSP change: not at MVP (F22 B21, D9).

### 5. May modify

```
skill/assets/explorer.html                       (lines 77, 108, 110, 171, 178, 180 and the new csvCell/lastView declarations only)
skill/scripts/build_explorer.py
skill/scripts/test_renderer_security.py          (new)
skill/scripts/test_renderer.py                   (only to add a case; the nine existing tests stay unchanged and green)
tests/security/artifact.spec.ts                  (new; authored, executed in S02)
scripts/project.mjs                              (line 108 pattern only)
scripts/generate-fixtures.mjs                    (only if a new validator rejects a committed fixture; then run npm run fixtures and explain in the report)
docs/features/F22-offline-artifact-and-skill.md  (sections 3 and 14)
docs/features/F04-schema-review.md               (sections 3 and 14)
docs/features/F15-inspector.md                   (sections 3 and 14)
docs/reference/limits-and-caps.md                (section A rows for the new caps)
skill/references/schema-contract.md              (one sentence per new rule, if needed)
CHANGELOG.md                                     ([Unreleased] Security and Fixed entries)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated; change scripts/generate-fixtures.mjs only if in scope
THIRD_PARTY_NOTICES.md                  generated by scripts/generate_notices.mjs
package.json, package-lock.json         no dependency change in this package
packages/explorer/package.json          same
packages/explorer/src/**                every view, index.tsx, types.ts: C02, C03, W04 own them
packages/explorer/server/**             S03 owns the server and its tests
skill/assets/explorer.html:6            the CSP meta (byte-identical, D9)
skill/assets/explorer.html:9-10         the 16 host variables (C02 copies them byte-identically)
skill/assets/explorer.html:186-190      live bridge: S03
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    S02 owns the CI changes this package needs
scripts/verify_host.mjs                 S02
```

A path in neither list is "ask first".

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'` | `skill/assets/explorer.html:6`; D9 | `test_S01_csp_string_unchanged` (new, in `test_renderer_security.py`, asserts the exact string in the template and in a rendered output); `tests/security/artifact.spec.ts` `CTQ-05 csp byte-identical` (S02) |
| SchemaGraph backward compatibility: every document accepted today (all `fixtures/schemas/*.json`, `fixtures/contract/valid/*.json`, `test_renderer.py::fixture()`) is still accepted; legacy `"True"`/`"False"` and nullable coercions stay (`build_explorer.py:13-18`, `:50`) | `schema-graph-contract.md` B5 | `fixtures/test_fixtures_normalize.py`; `test_renderer.py` (9 tests unchanged) |
| `normalize()` is the oracle: the 13 rules are edited, not reimplemented elsewhere | D3; `schema-graph-contract.md` B4 | `test_renderer.py`; C01 corpus tests later |
| `render()` one-pass substitution: placeholder-like user data is never re-expanded | `build_explorer.py:107-108` | `test_renderer.py::test_markup_cannot_break_script_or_project_title` (`__ICON_DATA__` survives) |
| Draft SQL never executed; C04 wording | `explorer.html:127` ("Nothing is executed here."), `:99` | No new code path adds a network call; `test_S01_structured_payload_no_sql_for_unknown_dialect` |
| Storage key family `backend-buddy:<project.key>:...` | `explorer.html:39` | Untouched by this package |
| Host CSS variables | `explorer.html:9-10` | Untouched; `tokens.test.ts` (C02) |
| Mount API `window.BackendBuddyViews.mount(container, view, props)` / `unmount()` and the props shape `{graph, onSelectTable, onSelectTables, live}` | `explorer.html:195`, `index.tsx:21-22` | Untouched; only the call frequency of `unmount()` changes |
| Finding id format `[t.id, rule, names, signature].join('|')` | `explorer.html:104` | Untouched (stored decisions keep resolving) |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed `S01` (Python) or `CTQ-05`/`CTQ-07` (spec), green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F22, F04, F15
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md`: the three `S01 (scheduled)` bullets under `Security` rewritten as fixed, plus `Fixed` lines for the CSV guard, `Object.hasOwn`, `contractVersion`, and the `render()` unmount change, each prefixed `- S01: `
- [ ] Release-note line in the PR body
- [ ] Security checklist: until `docs/engineering/security-policy.md` (D03) lands, record in the PR body: every `innerHTML`/`insertAdjacentHTML` interpolation in `explorer.html` re-audited (12 sinks listed in `docs/architecture/security-architecture.md` finding 1 context: lines 47, 57, 61, 64, 74, 77, 84, 87, 93, 130, 158, 193) with the statement that `${t.line}` was the only unescaped schema value and is now escaped
- [ ] Accessibility result: no UI text or structure change beyond the dialect sentence; record "n/a: no interactive change" and confirm the new sentence renders inside the existing `Review next` paragraph
- [ ] Performance: none, because no budget applies (CTQ-09 budgets start at W01/Q01); record the artifact size from `npm run build` output for the F22 B11 baseline anyway
- [ ] Caveat text: the only caveat-adjacent string added is `No validation SQL is generated for dialect <dialect>.`; it quotes nothing and paraphrases nothing from `caveats.md` (verify against C04 by eye; DL-05 paraphrase detector runs in Q05)
- [ ] `npm run guard` green; no private schemas, screenshots, or QA reports added
- [ ] `npm run build` run; `packages/explorer` unchanged so the mirror shows no diff (`git status --porcelain skill/assets/extensions` empty)
- [ ] All changed paths inside the `may-modify` globs
- [ ] New caps recorded in `docs/reference/limits-and-caps.md` section A with `path:line`
- [ ] The nine tests in `skill/scripts/test_renderer.py` pass unchanged

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order; every command must exit 0 unless stated.

```sh
npm run restore
npm run guard
npm run typecheck
npm test
python3 -m unittest discover -s skill/scripts -p 'test_*.py' -v 2>&1 | grep -c 'test_S01_'      # >= 25 (the tests listed in section 3)
python3 -m unittest discover -s skill/scripts -p test_renderer.py                                # 9 tests, unchanged
python3 -m unittest discover -s fixtures -p 'test_*.py'                                          # hostile fixture still normalizes and renders
npm run build
grep -c "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" dist/backend-buddy.html   # 1
mkdir -p outputs && python3 skill/scripts/build_explorer.py --schema fixtures/schemas/hostile.json --output outputs/hostile.html
grep -c '<svg onload' outputs/hostile.html                                                        # 0 (every schema-derived < is < in the JSON island, build_explorer.py:103)
grep -c '<img src=x onerror' outputs/hostile.html                                                 # 0
grep -c ':${t.line}' skill/assets/explorer.html                                                   # 0
grep -c ':${E(t.line)}' skill/assets/explorer.html                                                # 1
grep -c 'FROM ${quote(t.id)}' skill/assets/explorer.html                                          # 0
grep -c 'Object.hasOwn(colors' skill/assets/explorer.html                                         # 1
git status --porcelain skill/assets/extensions                                                    # empty
test -f tests/security/artifact.spec.ts
```

Negative checks the verifier runs by hand (each must raise `ValueError`):

```sh
python3 - <<'EOF'
import json, sys
sys.path.insert(0, 'skill/scripts')
from build_explorer import normalize
base = json.load(open('fixtures/schemas/small.json', encoding='utf-8'))
cases = []
d = json.loads(json.dumps(base)); d['tables'][0]['line'] = '<svg onload=alert(1)>'; cases.append(('string line', d))
d = json.loads(json.dumps(base)); d['project']['name'] = 5; cases.append(('non-string project.name', d))
d = json.loads(json.dumps(base)); d['source']['commit'] = 12345; cases.append(('non-string commit', d))
d = json.loads(json.dumps(base)); d['contractVersion'] = '2.0'; cases.append(('major mismatch', d))
for name, doc in cases:
    try:
        normalize(doc); print('FAIL accepted:', name); sys.exit(1)
    except ValueError as e:
        print('ok rejected:', name, '->', e)
EOF
```

### 10. Reporting format

Per `docs/product-management/agent-briefs/README.md` section 10, in this order: files changed (tagged, with the glob statement); acceptance commands with exit status and the relevant output lines (include the `grep -c` values and the `S01` test count); definition of done with each item ticked, struck with reason, or open; frozen contracts, one line each ("preserved" with the pinning test); measurements (artifact size in bytes from `npm run build`, count of `S01` tests); out of scope, found (at minimum: `.github/workflows/ci.yml:59` still discovers only `test_renderer.py`, owner S02); open questions for the owner; deviations.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-01 private-data leakage | No new fixture, screenshot, or literal count; `npm run guard` before every commit; `outputs/` is git-ignored |
| RK-05 remount fix changes lifecycle assumptions | S01 changes only when the host calls `unmount()`; `mount()` still recreates the root until C03, so no lifecycle change is observable in this package; record that explicitly in the report |
| RK-12 silent build degradation | Not fixed here (roadmap open question 4); the `render()` tests in finding 4 use temporary extension files and must not depend on `skill/assets/extensions/dist` existing |
| RK-13 finding ids reopen decisions | Do not touch `explorer.html:104`; the SQL fixes change `sql` text, not ids, so stored decisions keep resolving |
| RK-10 scope creep | The `vm` harness is a test aid, not a module; do not start lifting host code into `packages/explorer/src` (W03) |
| RK-15 silently skipped suites | The `vm`-based tests skip only when `node` is absent and say so in the skip message, matching `test_explorer_http.py:373` |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). Open questions 1-3 recorded for the owner. |

Open questions for the owner (needed before S01 starts):

1. `schema-graph-contract.md` B3 assigns S01 a `normalize()` character-set rule forbidding `#` and `>` in `table.id` and `column.name`, but `fixtures/schemas/hostile.json` (R01, per ADR-0007 decision 7) has four table ids containing `>` (for example `hostile.v_<b>bold</b>`) and `fixtures/test_fixtures_normalize.py` renders it. The two documents conflict. Options: (a) S01 does not add the rule and C03 makes the column id and relationship ref safe by percent-encoding the separator instead (recommended; no fixture change, no data rejected); (b) add the rule and regenerate the hostile fixture without `>`, weakening the markup vectors. Decide by S01 kickoff; this brief assumes (a).
2. Confirm the proposed caps (256 characters for identifiers and labels; 4,096 for definitions, `source.basis`, and file paths). They go into `docs/reference/limits-and-caps.md` section A.
3. Whether over-length values are rejected (`ValueError`, this brief's default: identifiers must not be silently altered) or truncated for the free-text fields (`definition`, `basis`).
