Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# WP-Q05 Docs/code sync

| Field | Value |
|---|---|
| Work package | Q05 (track Q, phase 2) |
| Features | all F01-F22 (sections 3 and 14 verified against the merged code) |
| CTQs | CTQ-13 (primary); CTQ-08 (pilot UAT on a real read-only PostgreSQL) |
| Caveats | C01-C16 (the lint proves every quote matches `caveats.md`; no wording authored) |
| Depends on | all MVP work packages (W01-W06, A01-A04, O01-O03, Q01-Q04) |
| Blocks | none (G2 exit) |
| Branch | `q05/docs-code-sync` |
| Gate | G2 |

### 1. Goal

Make the documentation true for the code that will ship at G2 and make that property enforceable: every feature document's sections 3 and 14 updated to the merged implementation with valid `path:line` citations; `scripts/docs_lint.mjs` implementing rules DL-01 to DL-16 from `docs/product-management/traceability.md` section 4 (registry completeness, fourteen headings, caveat ids and verbatim text, ADR index, limits matching constants, brief headings, no machine-local paths); the PR-title regex step in CI; the legacy-handoff gate mapping; and a pilot UAT report on a real read-only PostgreSQL. A verifier can check `node scripts/docs_lint.mjs` exits 0 on `main`, fails on each seeded violation, and that the PR-title step rejects a non-conforming title.

### 2. Reading list (ordered)

1. `docs/product-management/traceability.md`: section 4 (the sixteen rules, verbatim; each becomes a lint check with a stable id), section 2 (PR title regex), section 3 (cross-matrix and the DL-06 divergence: 12 feature/caveat pairs; open question 4 must be decided by the owner before the lint can be green), section 5 (where the data lives).
2. `docs/README.md` (documentation map; status header format and the `pre-repo` rule after the first commit), `docs/features/README.md` (registry columns; rules 1-4), `docs/features/_template.md` (the fourteen headings), `docs/reference/caveats.md` (canonical blockquotes), `docs/reference/limits-and-caps.md` A (the `path:line` + value pairs DL-08 verifies), `docs/architecture/adr/README.md` and `overview.md` section 7 (DL-09), `docs/product-management/agent-briefs/README.md` (header table and twelve `### N.` sections for DL-16).
3. `docs/product-management/ctq.md` CTQ-13 row and notes; `roadmap.md` G0 (the lint applied by hand until now) and G2.
4. `docs/architecture/legacy-handoff.md` ("Acceptance Gates" and "Superseded by CTQs (D02 note)" sections): the gate mapping Q05 writes maps every legacy gate to the CTQ or test that now covers it.
5. `scripts/private_data_guard.mjs` (path rules reused by DL-11: user-profile paths, agent-local dot-directories, absolute Windows drives; defined once, imported).
6. `.github/workflows/ci.yml` and `.github/PULL_REQUEST_TEMPLATE.md`; `CONTRIBUTING.md` and `AGENTS.md` section 4 (conventions the lint enforces).
7. Every feature document and every brief (the lint's corpus); the merged code for each feature's section 14 implementation map.
8. `docs/developer/test.md` and `CONTRIBUTING.md` for where to document the lint.
9. `docs/engineering/definition-of-done.md` (D03) for the "section 14 touched" rule DL-12.
10. For the pilot UAT: `docs/operations/deployment.md` (O01), `docs/qa/release-checklist.md` (Q04), A03/A04 connection and job flows; a read-only PostgreSQL the owner designates (never the original private example's database or its snapshot; the report names the database only as "pilot database").

### 3. In scope

- `scripts/docs_lint.mjs` (node, no dependencies beyond the standard library and the guard's exported path rules): rules DL-01 to DL-16 with stable ids in the output (`DL-05 docs/features/F08-schema-city.md:41 caveat C02 text differs from caveats.md`); exit non-zero on any failure; `--fix` not provided (edits are human); CI-only rules DL-12 and DL-13 take `--base-ref` and `--pr-title`; whitespace normalisation for DL-05; the 12-consecutive-word paraphrase detector (threshold per `traceability.md` open question 2; configurable constant, default 12).
- `scripts/docs_lint.test.mjs`: one seeded violation per rule in a temporary docs tree; each must be reported with its id; a clean tree passes.
- `.github/workflows/ci.yml`: `docs-lint` job (`node scripts/docs_lint.mjs --base-ref origin/main --pr-title "$PR_TITLE"`); PR-title regex step from `traceability.md` section 2; Dependabot exemption or retitle per `traceability.md` open question 1 (implement the owner's decision; if undecided, exempt `dependabot[bot]` and record it).
- Feature documents F01-F22: section 3 rewritten against the merged code (status column in the registry updated: `existing`/`partial`/`planned` as truth), section 14 implementation map lists the actual files and the change-log rows for every merged PR since G0; citations re-verified (DL-10); stubs removed where the WP landed.
- `docs/architecture/legacy-handoff.md`: a "Gate mapping" table appended (legacy gate -> CTQ id -> test name -> status at G2); no other edit.
- Cross-matrix reconciliation: `traceability.md` section 3 updated to the merged tests; the DL-06 divergence resolved per the owner's decision (registry rows or "Where surfaced" lists edited accordingly; `caveats.md` is frozen so if the decision is to trim "Where surfaced", that is a reviewed caveats PR co-signed by the owner, not a Q05 edit).
- Status headers: every document's `Last verified against code` set to the G2 commit hash for documents Q05 verified; `pre-repo` rejected for `reviewed`/`approved` documents (DL-01).
- `docs/qa/pilot-uat-report.md`: the MVP definition sentence executed step by step by the owner or a designated pilot admin against a real read-only PostgreSQL (`docker compose up` from a clean clone, bootstrap, workspace, project, connection registered and tested, extraction, profiling with at least one partial result, all 13 views plus Insights, review decisions, exports, audit trail, rollback); each step pass/fail with the observed output (redacted; no schema names from the pilot database beyond what the owner approves); issues triaged to owning WPs or L-items.
- `docs/developer/test.md` and `CONTRIBUTING.md`: how to run the lint locally; `AGENTS.md` section 4 unchanged unless the conventions moved.
- CHANGELOG line; release-note line.

### 4. Out of scope

- Fixing code defects found during the sync or the pilot (report to owning WPs).
- Authoring or changing caveat wording (frozen; a change is a reviewed caveats PR).
- Changing CTQ targets or limits (CTQ rule 1).
- Writing new feature documents or ADRs beyond the 22 and 8 that exist (roadmap change control).
- Nightly visual-regression matrix (L-01); GitHub labels/issue forms sync (L-09).
- Deciding `traceability.md` open questions 1-4: implement decisions; record undecided ones with the lint rule disabled by an explicit `--allow DL-06` flag that the CI job passes only while the decision is pending, with the flag's removal date in the job comment.

### 5. May modify

```
scripts/docs_lint.mjs
scripts/docs_lint.test.mjs
.github/workflows/ci.yml                     (docs-lint job and PR-title regex step only)
docs/features/F01-*.md ... F22-*.md          (sections 3 and 14; registry status column in docs/features/README.md)
docs/features/README.md                      (status and caveat columns per the owner's DL-06 decision)
docs/product-management/traceability.md      (section 3 matrix; open-question resolutions)
docs/architecture/legacy-handoff.md          (appended "Gate mapping" section only)
docs/architecture/overview.md                (section 7 ADR list if an ADR was added since D02)
docs/**/*.md                                 (status header line only: commit hash and status value)
docs/qa/pilot-uat-report.md
docs/developer/test.md, CONTRIBUTING.md      (lint usage)
CHANGELOG.md                                 ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change (the lint is dependency-free)
packages/**, services/**, deploy/**, skill/**   code is never edited by Q05; a stale citation is fixed in the doc, a wrong behaviour is reported
docs/reference/caveats.md               frozen at G0 (a change is a separate reviewed PR)
docs/product-management/ctq.md, docs/reference/limits-and-caps.md   values change only by the CTQ rule-1 PR (Q05 may fix a stale path:line in limits-and-caps.md A, never a value)
docs/business/**                        D01; corrections proposed in the report
.github/workflows/{security,release,nightly}.yml   O02
scripts/private_data_guard.mjs          R00 (its path rules are imported, not copied)
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Lint rules DL-01 to DL-16 exactly as `traceability.md` section 4; ids stable | `traceability.md` 4 | `scripts/docs_lint.test.mjs` (one seeded violation per rule) |
| PR title regex `^(feat|fix|docs|test|chore|refactor|perf|build|ci|security)\((F(0[1-9]|1[0-9]|2[0-2])|[DRSCWAOQ]\d{2}|CTQ-(0[1-9]|1[0-6]))\)(!)?: \S.{2,}$` | `traceability.md` 2 | `ci.yml` PR-title step; `docs_lint.test.mjs` |
| Caveat wording frozen; DL-05 compares after whitespace normalisation; paraphrase detector 12 words (configurable) | D8; `caveats.md` | `docs_lint.mjs` |
| Fourteen feature headings and twelve brief sections; status header format | `_template.md`; `agent-briefs/README.md`; `docs/README.md` | DL-03, DL-16, DL-01 |
| Limits in `limits-and-caps.md` A must match the constants at the cited lines | DL-08 | `docs_lint.mjs` |
| No machine-local paths in docs; path rules imported from `private_data_guard.mjs` | DL-11; CTQ-14 | `docs_lint.mjs` imports, never duplicates |
| `skill/assets/extensions/` never cited | DL-10 | `docs_lint.mjs` |
| Feature ids, WP ids, CTQ ids, caveat ids, B ids, P ids, L ids, RK ids resolve to their registries | `traceability.md` 1 | DL-02, DL-04, DL-07, DL-09 |
| Section 14 appended on every merge touching a feature path | CTQ-13; DL-12 | `docs-lint` job with `--base-ref` |
| Project-neutral prose: "the original private example" only; no counts | ADR-0007; `docs/README.md` | guard; local denylist |
| Pilot UAT uses a database the owner designates; no private schema names in the report | ADR-0007 | owner review of the report |

### 8. Deliverables checklist (definition of done)

- [ ] Lint, tests, CI step green with the acceptance commands; `node scripts/docs_lint.mjs` exits 0 on the G2 candidate
- [ ] Feature document sections 3 and 14 updated for all 22 features; registry statuses true
- [ ] Migration: none, because no schema changes
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (lint runs no network; pilot report redacted; no private paths)
- [ ] Accessibility result: not applicable
- [ ] Performance measurement recorded: lint wall time on the full tree (no budget; recorded)
- [ ] Caveat text: verified by DL-05 across every document and `caveat-strings.ts`
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: every `Last verified against code` header Q05 touched carries the G2 commit hash; every DL rule has a passing and a failing test
- [ ] Package-specific: `pilot-uat-report.md` covers every clause of the MVP definition with pass/fail

### 9. Acceptance commands

```sh
npm run guard
node --test scripts/docs_lint.test.mjs                                    # 16 rule tests + clean-tree test green
node scripts/docs_lint.mjs                                                # exit 0 on the branch
node scripts/docs_lint.mjs --pr-title "feat(F08): Schema City search"     # exit 0
node scripts/docs_lint.mjs --pr-title "Update stuff"; echo "exit=$?"      # non-zero (DL-13)
node scripts/docs_lint.mjs --base-ref origin/main                         # DL-12 section-14-touched check against the PR diff
npm run test:scripts                                                      # docs_lint.test.mjs is collected by the scripts job glob
gh pr view --json title -q .title | grep -E "$(sed -n 's/^```$//;/PR title regex/,/```/p' docs/product-management/traceability.md | sed -n '3p')"   # or the CI step log
```

Package-specific assertions: `node scripts/docs_lint.mjs` on a scratch copy where one caveat quote is paraphrased reports exactly one `DL-05`; on a copy where `limits-and-caps.md` cites a wrong value reports `DL-08` with the file:line; the report lists the count of `path:line` citations verified.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Add a per-feature table (F01-F22: section 3 updated, section 14 rows added, citations verified) and the pilot UAT step table.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-03 docs-first becoming docs-only | Q05 runs last and verifies against merged code; it writes no aspirational text; stubs that remain are listed in the report with their owning WP. |
| RK-01 private data | DL-11 and the guard on every doc; the pilot report is redacted and owner-reviewed; the denylist runs locally before push. |
| RK-10 scope creep | Only sections 3 and 14, status headers, the matrix, the gate mapping, and the lint; anything else is a change request. |
| RK-22 duplicated source trees | DL-10 rejects citations into the generated mirror. |
| RK-11 licence unreviewed | The release checklist (Q04) carries the DRAFT-header check; Q05 verifies it is present in the checklist. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
