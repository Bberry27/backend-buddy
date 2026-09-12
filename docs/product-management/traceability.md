Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Traceability

How a line in `CHANGELOG.md` leads to the brief, the branch, the pull request, the tests, and the feature document, and how the docs lint (`scripts/docs_lint.mjs`, Q05) enforces it. Conventions here are the specification; `AGENTS.md` section 4 and `CONTRIBUTING.md` summarise them.

## 1. Identifiers

| Registry | Pattern (regex) | Where authored | Used in |
|---|---|---|---|
| Feature | `F(0[1-9]\|1[0-9]\|2[0-2])` | `docs/features/README.md` | branch, commit scope, PR title, test names, CHANGELOG, feature doc filename, briefs |
| Work package | `[DRSCWAOQ]\d{2}` (D00-D08, R00-R01, S01-S03, C01-C03, W01-W06, A01-A04, O01-O03, Q01-Q05) | `docs/product-management/roadmap.md` | branch, commit scope, PR title, CHANGELOG, brief filename `WP-<id>.md` |
| Critical-to-quality | `CTQ-(0[1-9]\|1[0-6])` | `docs/product-management/ctq.md` | test names, feature doc sections 8-12, ADR "CTQs affected", PR title when a PR exists only to satisfy a CTQ |
| Caveat | `C(0[1-9]\|1[0-6])` | `docs/reference/caveats.md` | feature doc section 7, `packages/explorer/src/caveat-strings.ts` (C03), insight items |
| Behaviour | `B\d+` (per feature document, never renumbered) | feature doc section 4 | acceptance criteria tags, test names, briefs |
| Drill-through entry | `P([1-9]\|10)` | `docs/architecture/drill-through-contract.md`, `navigation.ts` | e2e matrix names, F14 |
| Later item | `L-0[1-9]` | `roadmap.md` | feature doc section 4 "Later", briefs' out-of-scope lists |
| Risk | `RK-\d{2}` | `docs/product-management/risk-register.md` | PR "Notes for reviewers", briefs |

Rules:

- An id is stable for life. A withdrawn behaviour or feature keeps its id with the marker "withdrawn"; nothing is renumbered.
- Exactly one work-package or feature id per PR. A PR that spans two ids is split.
- Caveats are quoted, never paraphrased. A document or UI string carrying caveat wording must match `caveats.md` byte for byte (after whitespace normalisation).

## 2. Branch, commit, PR, test, CHANGELOG conventions

| Where | Convention | Example |
|---|---|---|
| Branch | `f##/<slug>` for feature work; `<wp-id>/<slug>` in lower case for other work packages; slug is kebab-case ASCII | `f08/city-search`, `s01/renderer-escaping`, `d04/pm-docs` |
| Commit | Conventional Commits; scope is the id; type from `feat fix docs test chore refactor perf build ci security` | `feat(F08): add table search to Schema City` |
| PR title | Same shape as a commit subject; regex below; the squash commit takes the PR title | `fix(S01): escape table.line in the inspector` |
| PR body | `.github/PULL_REQUEST_TEMPLATE.md`: id line, brief path, summary, definition-of-done checklist, release-note line, acceptance commands with results | |
| Test names | Prefixed with the id the test proves; CTQ tests use the CTQ id; behaviour tests may add `B#` | TS: `test('F08 B2 search selects and flies to the table', ...)`; Python: `def test_S01_line_is_escaped(self)`; e2e: `test('CTQ-10 P2 matrix cell -> fanout root', ...)` |
| Test files | Unit next to the module (`<module>.test.ts`, `test_<module>.py`); e2e/a11y/perf/security under `tests/<kind>/`; feature-level e2e named `<feature-slug>.spec.ts` | `packages/explorer/src/city-layout.test.ts`, `tests/e2e/city.spec.ts` |
| CHANGELOG | One line under `## [Unreleased]` in the Keep a Changelog section (`Added`, `Changed`, `Fixed`, `Security`, `Removed`), prefixed `- <id>: ` | `- F08: table search with fly-to in Schema City` |
| Release note | One user-facing line in the PR body, prefixed with the id; collected into the release notes at tag time (O02 `release.yml` checks the CHANGELOG section exists) | |
| Feature doc | Section 14 change-log row appended on merge: date, PR number, WP id, one-line change; section 3 updated when current state changed | `\| 2026-09-30 \| #42 \| W05 \| search combobox, fly-to \|` |
| Migration | `services/api/alembic/versions/<NNNN>_<slug>.py` with a working `downgrade()`; the PR body states "none, because ..." when no migration is needed | |

### PR title regex

```
^(feat|fix|docs|test|chore|refactor|perf|build|ci|security)\((F(0[1-9]|1[0-9]|2[0-2])|[DRSCWAOQ]\d{2}|CTQ-(0[1-9]|1[0-6]))\)(!)?: \S.{2,}$
```

Enforced by a CI step added in Q05 (CTQ-13). Until then reviewers check by eye. The `!` marks a breaking change and is allowed only with a `contractVersion` major bump (C01) or an ADR.

### Mapping a CHANGELOG line to everything else

`- F08: table search with fly-to in Schema City` leads to:

1. Brief: the WP that delivered it is in the PR body (`WP-W05.md`).
2. Branch and PR: `f08/*` branches; PR title scope `F08`; `git log --grep='(F08)'`.
3. Tests: `grep -rn "F08" packages/explorer/src/*.test.ts tests/` and, for CTQs the feature lists, `grep -rn "CTQ-10" tests/`.
4. Feature doc: `docs/features/F08-schema-city.md` section 14 has the row; section 4 has the `B#` the tests cite.
5. Caveats shown: section 7 of the same document, each quoted from `caveats.md`.

## 3. Cross-matrix: feature x CTQ x caveat x work package x tests

CTQ-12, CTQ-13, CTQ-14 apply to every feature and are omitted. Test paths are the planned locations; unit tests that exist today are named. Work packages are those whose scope names the feature.

| Feature | CTQs | Caveats | Work packages | Tests (existing today in bold) |
|---|---|---|---|---|
| F01 Relational map | 02, 03, 10, 11 | C01, C07, C11 | S01, W03, W04 | `map-layout.test.ts`, `useMapPan` component test, `tests/e2e/views/map.spec.ts`, **`skill/scripts/check_map_pan.cjs`** (retired in S02) |
| F02 Entity index | 02, 10, 11 | C07 | S01, W03 | `EntityIndex` component test, `tests/e2e/views/entities.spec.ts` |
| F03 PK/FK index | 02, 10, 11 | C06, C07 | S01, W03 | `key-logic.test.ts`, `tests/e2e/views/keys.spec.ts` |
| F04 Schema review | 02, 06, 10, 11, 16 | C04, C07, C08, C13 | S01, W03, W04, A04 | `review-logic.test.ts` (parity with inline `buildFindings` on the medium fixture), `tests/e2e/views/review.spec.ts`, `services/api/tests/test_reviews.py` |
| F05 Living ERD | 02, 03, 09, 10, 11 | C01, C07, C10, C13 | C02, W04 | **`living-logic.test.ts`**, `tests/e2e/views/living.spec.ts` (from `living-browser.test.mjs`), `tests/perf/tti.spec.ts` |
| F06 Row fan-out | 01, 02, 08, 10, 11 | C01, C02, C05, C14 | S03, W04 | **`fanout-logic.test.ts`**, `tests/e2e/views/fanout.spec.ts` (from `fanout-browser.test.mjs`), `tests/e2e/drill-through.spec.ts` (P9, P10) |
| F07 Column table | 01, 02, 10, 11 | C01, C05, C06 | W04 | **`column-logic.test.ts`**, `tests/e2e/views/columns.spec.ts` |
| F08 Schema City | 01, 02, 03, 04, 09, 10, 11 | C01, C02, C03, C13, C16 | C02, C03, W04, W05, Q01 | **`city-layout.test.ts`**, `tests/e2e/city.spec.ts` (from `city-browser.test.mjs`), `tests/perf/city-frames.spec.ts`, `city-layout.perf.test.ts`, `tokens.test.ts` |
| F09 Normalization lens | 01, 02, 08, 10, 11 | C01, C05, C08, C14 | W04 | **`lens-domain-logic.test.ts`**, `tests/e2e/views/lens.spec.ts` |
| F10 Schema diff | 02, 06, 07, 10, 11 | C04, C09, C15 | W04, Q02 | **`schema-diff-logic.test.ts`**, `tests/e2e/views/diff.spec.ts`, `tests/security/hostile-fixture.spec.ts`, `scripts/sql-path-lint.mjs` |
| F11 Join matrix | 02, 09, 10, 11 | C07, C11 | C02, W04 | `JoinMatrix` component test (theme via context), `tests/e2e/views/matrix.spec.ts`, `tests/e2e/drill-through.spec.ts` (P2) |
| F12 Arc diagram | 02, 10, 11 | C07, C12 | W04 | **`dependency-logic.test.ts`**, `tests/e2e/views/arcs.spec.ts` (from `dependency-browser.test.mjs`) |
| F13 Domains | 02, 10, 11 | C03, C11 | C02, W04 | **`lens-domain-logic.test.ts`**, `tests/e2e/views/domains.spec.ts` |
| F14 Drill-through navigation | 03, 10, 11 | C13 | C03, W02, W04 | `route-state.test.ts`, `selection.test.ts`, `navigation.test.ts`, `view-state.test.ts`, `mount-policy.test.ts`, `tests/e2e/drill-through.spec.ts`, `tests/a11y/keyboard-journeys.spec.ts` |
| F15 Inspector | 02, 10, 11 | C07, C08, C13 | W02 | `inspector-logic.test.ts`, `decisions.test.ts`, `Inspector` component test, `tests/e2e/inspector.spec.ts` |
| F16 Projects and snapshots | 01, 07, 15, 16 | C09, C13 | A01, A04, W01 | `services/api/tests/test_snapshots.py`, `test_projects.py`, `test_A01_upgrade_downgrade_upgrade`, `tests/e2e/upload.spec.ts` |
| F17 Connections and profiling | 01, 07, 08, 09, 16 | C01, C05, C09, C14 | S03, A03, A04, Q03 | **`packages/explorer/server/test_schema_profiler.py`**, **`test_explorer_http.py`**, `packages/profiler/tests/test_policy.py`, `test_targets.py`, `test_postgres_live.py`, `services/api/tests/test_connections.py`, `test_jobs.py`, `tests/perf/api/profile_p95.py` |
| F18 Insights and recommendations | 01, 10, 11 | C05, C07, C08 | W06 | `insights-logic.test.ts`, `InsightsView` component test, `tests/e2e/insights.spec.ts` |
| F19 Exports | 05, 06, 07, 16 | C04, C05, C13 | S01, W03, A04 | `csv.test.ts` (formula vectors), `svg-export.test.ts`, `services/api/tests/test_export.py`, `tests/security/artifact.spec.ts` |
| F20 Auth and workspaces | 07, 16 | C13, C14 | A01, A02, Q02 | `services/api/tests/test_auth.py`, `test_rbac_matrix`, `test_A02_idor_returns_404`, `test_audit.py`, `tests/security/cookies-csrf.spec.ts` |
| F21 Theming and design tokens | 02, 04, 11 | C16 | C02 | `tokens.test.ts`, `color-math.test.ts`, `scripts/check-hardcoded-colors.mjs`, `tests/a11y/` |
| F22 Offline artifact and skill | 05, 08, 09, 14 | C04, C09, C13, C14 | S01, S02, S03, C01 | **`skill/scripts/test_renderer.py`**, `test_renderer_security.py`, **`test_explorer_http.py`**, `tests/security/artifact.spec.ts`, `scripts/verify_host.mjs`, `scripts/private_data_guard.mjs` (**`private_data_guard.test.mjs`**) |

Caveat coverage check (every caveat must be surfaced by at least one feature): C01 F05-F09, F11, F13, F17, F18 · C02 F06, F08, F18 · C03 F02, F08, F13, F18 · C04 F04, F10, F19, F22 · C05 F06, F07, F09, F17, F18, F19 · C06 F03, F07, F15 · C07 F01-F05, F11, F12, F15, F18 · C08 F04, F09, F15, F18 · C09 F10, F15, F16, F17, F22 · C10 F05, F15 · C11 F01, F05, F11, F12, F13 · C12 F06, F12, F18 · C13 F04, F05, F08, F14-F16, F19, F20, F22 · C14 F06, F09, F17, F20, F22 · C15 F07, F10, F15 · C16 F05, F08, F11, F21. These lists match "Where surfaced" in `caveats.md`. They do not match the registry's caveat column in `docs/features/README.md` (reproduced in the Caveats column above): `caveats.md` names 12 feature/caveat pairs, under 8 caveats, that the registry rows do not carry: C03 -> F02; C06 -> F15; C09 -> F15; C10 -> F15; C11 -> F05, F12; C12 -> F06, F18; C15 -> F07, F15; C16 -> F05, F11. In the other direction the registry is a strict subset (every registry caveat appears in the matching "Where surfaced" list). DL-06 fails on these 12 pairs today; open question 4 decides which side changes.

## 4. Docs lint (`scripts/docs_lint.mjs`, delivered in Q05)

The lint runs on every PR (`node scripts/docs_lint.mjs`, CTQ-13) and at G0 by hand. It fails the build on any of the following. Rule ids are stable so a PR can cite the rule it fixes.

| Rule | Check |
|---|---|
| DL-01 status header | Every `docs/**/*.md` starts with `Status: (draft\|reviewed\|approved) \| Owner: <role> \| Last verified against code: (<7-40 hex chars>\|pre-repo \(\d{4}-\d{2}-\d{2}\))`. Owner is one of the roles in `docs/features/README.md`. After the first commit, `pre-repo` is rejected for documents with status `reviewed` or `approved`. |
| DL-02 feature registry completeness | Every row in `docs/features/README.md` has a file `docs/features/F##-<slug>.md` with the same slug, and every such file has a row. Status in the file header matches the row. |
| DL-03 fourteen headings | Each feature document has exactly the fourteen `## N. <title>` headings of `_template.md`, numbered 1-14, in order. A stub reads `Stubbed until <WP id>.` and is permitted only in sections 8-12 of features whose registry status is `planned`. |
| DL-04 caveat ids resolve | Every `C\d\d` token in `docs/**` and in `packages/explorer/src/caveat-strings.ts` is one of C01-C16. |
| DL-05 caveat text verbatim | Every blockquote that begins with `C##:` in a feature document, and every string in `caveat-strings.ts`, equals the canonical blockquote in `caveats.md` for that id after whitespace normalisation. Any other sentence in `docs/**` that shares more than 12 consecutive words with a canonical caveat but is not identical is reported (paraphrase detector). |
| DL-06 caveat surfacing | For each feature, the caveat column in the registry equals the ids listed in that feature document's section 7 and header, and every caveat's "Where surfaced" list in `caveats.md` names only features whose registry row lists that caveat. |
| DL-07 CTQ completeness | Every row CTQ-01..16 in `ctq.md` has non-empty metric/target, measurement method, owner role, and gate cells; every `CTQ-\d\d` token in `docs/**` and `tests/**` resolves. |
| DL-08 limits match constants | For each row in `limits-and-caps.md` section A, the cited `path:line` exists and the line contains the cited value. |
| DL-09 ADR index | `docs/architecture/adr/` contains `0000-template.md` and `NNNN-<slug>.md` files numbered consecutively; each ADR has headings Context, Decision, Consequences, CTQs affected; `docs/architecture/overview.md` lists every ADR. |
| DL-10 file:line citations | Every `` `path:line` `` or `` `path:start-end` `` citation in `docs/**` names a file that exists; a citation into `skill/assets/extensions/` is an error (generated copy). |
| DL-11 no machine-local paths | No user-profile path (Windows `Users\<name>` or `/home/<name>`), agent-local dot-directory, or absolute Windows drive path appears in `docs/**`. The lint reuses the path rules of `scripts/private_data_guard.mjs`, which covers the rest of the tree, so the patterns are defined once. |
| DL-12 section 14 touched | When a PR changes a path listed in a feature document's implementation map (section 14) or in the registry's surfaces column, the same PR adds a row to that document's change log. Runs only in CI with a base ref. |
| DL-13 PR title | The PR title matches the regex in section 2. Runs only in CI. |
| DL-14 no invented numbers | Lines in `docs/business/**` that contain a currency symbol, a percentage, or a market-size figure must also contain "to be validated" or a source citation. |
| DL-15 CHANGELOG id prefix | Every bullet under `## [Unreleased]` in `CHANGELOG.md` starts with `- <id>: ` where `<id>` matches a feature, work-package, or CTQ id. |
| DL-16 brief headings | Every `docs/product-management/agent-briefs/WP-*.md` starts with the status header (DL-01) and the header table of `agent-briefs/README.md`, then has exactly the twelve `### N. <title>` sections of the brief format, numbered 1-12, in order. |

The private name denylist is not a lint rule: it runs only locally through `BB_DENYLIST_FILE` (`scripts/private_data_guard.mjs`) so that the name never enters the repository, including inside the rule that would detect it.

## 5. Where the traceability data lives

| Artefact | Path | Maintained by |
|---|---|---|
| Feature registry | `docs/features/README.md` | D00, D05; then every feature PR |
| CTQ registry | `docs/product-management/ctq.md` | D04; targets changed only by reviewed PR |
| Caveats | `docs/reference/caveats.md`; mirror `packages/explorer/src/caveat-strings.ts` | D00 (frozen at G0); C03 |
| Limits | `docs/reference/limits-and-caps.md` | D00; every PR that changes a cap |
| Work packages and gates | `docs/product-management/roadmap.md` | D04; change control in that file |
| Briefs | `docs/product-management/agent-briefs/WP-<id>.md` | D08; updated when scope changes |
| Risks | `docs/product-management/risk-register.md` | D04; every gate |
| Per-feature change log | `docs/features/F##-*.md` section 14 | every merge |
| Repository-wide change log | `CHANGELOG.md` | every merge |
| Release notes | generated from CHANGELOG at tag time (O02) | release |

## Open questions

1. Whether Dependabot PRs are exempt from the PR-title regex (their titles are generated) or are retitled with `chore(R00): ...` by a workflow step. Owner: Platform lead, by G1.
2. Whether DL-05's paraphrase detector threshold (12 consecutive words) is too strict for the short caveats C12 and C15. Owner: Product owner, by Q05.
3. Whether CTQ ids may be PR scopes at all, or whether every PR must carry an F or WP id and cite CTQs in the body only. The plan says "PR title carries F/CTQ id"; this document allows both. Owner: Product owner, by G0.
4. Caveat surfacing divergence (DL-06): `caveats.md` "Where surfaced" names 12 feature/caveat pairs the registry does not carry (C03 -> F02; C06 -> F15; C09 -> F15; C10 -> F15; C11 -> F05, F12; C12 -> F06, F18; C15 -> F07, F15; C16 -> F05, F11). Either the registry rows (and section 7 of the affected feature documents) gain these caveats, or the "Where surfaced" lists are trimmed, before the G0 freeze. Owner: Product owner, by G0.
