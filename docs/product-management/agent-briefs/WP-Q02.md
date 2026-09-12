Status: draft | Owner: Security lead | Last verified against code: pre-repo (2026-09-07)

# WP-Q02 Security tests and threat model

| Field | Value |
|---|---|
| Work package | Q02 (track Q, phase 2) |
| Features | F20, F16, F17, F10, F14, F19, F22 (verification only; no feature code) |
| CTQs | CTQ-07 (primary), CTQ-06, CTQ-05, CTQ-14 |
| Caveats | none surfaced (tests assert that C04 and C14 hold; wording is not authored here) |
| Depends on | W04, A04 |
| Blocks | none (Q05 collects the release security checklist) |
| Branch | `q02/security-tests` |
| Gate | G2 |

### 1. Goal

Write the STRIDE threat model per component with a control-to-test mapping (`docs/security/threat-model.md`) and the cross-cutting security tests it requires: RBAC matrix completeness, IDOR negatives, upload abuse, cookie and CSRF e2e, the hostile fixture rendered through all 13 views and the offline artifact (no dialog, no injected node, CSV cells neutralised, no prototype pollution), deep-link fuzz over the route grammar, storage isolation by `project.key`, bundle grep for secrets, SPA CSP-violation e2e across 13 views with 0 reports, and the release security checklist. A verifier can check every control in the threat model names a test that exists and passes.

### 2. Reading list (ordered)

1. `docs/architecture/security-architecture.md` in full: 2 (principals and trust boundaries), 3 (threat summary per component: the STRIDE table starts there), 5 (the eight baseline findings and their verifying tests; Q02 re-runs the matrix at G2), 6 (both CSPs), 7 (cookies and CSRF), 8 (draft SQL), 9 (private data).
2. `docs/product-management/ctq.md` CTQ-05, CTQ-06, CTQ-07, CTQ-14 rows (test names: `CTQ-07 csp violations = 0`, `CTQ-07 hostile fixture inert`, `CTQ-07 cookie flags and csrf`, `node scripts/bundle-secret-grep.mjs`, `test_rbac_matrix`, `test_A02_idor_returns_404`).
3. `docs/architecture/drill-through-contract.md` 4 (route grammar: the fuzz corpus targets `t c r ts f q d k v.*`, 200-char cap, unknown ids dropped), 9 (storage isolation; `project.key` regex at `skill/scripts/build_explorer.py:24`).
4. `docs/architecture/adr/ADR-0005-auth-and-credential-encryption.md`, `ADR-0006-deployment-topology-and-artifact-csp.md`, `ADR-0007-private-data-and-fixture-policy.md`, `ADR-0008-testing-strategy.md`.
5. Existing hardening to build on: `packages/explorer/src/schema-diff-logic.ts:39-70` `parseSchemaSnapshot` (depth 32, 20,000 tables, 100,000 links, 200,000 columns; type checks) and `SchemaDiff.tsx:84` (20 MB file cap); S01 deliverables `skill/scripts/test_renderer_security.py` and `tests/security/artifact.spec.ts`; S03 deliverables in `packages/explorer/server/test_explorer_http.py`; `fixtures/schemas/hostile.json` (R01; the hostile corpus: script text in identifiers, formula-leading cells, `__proto__` keys, oversized strings).
6. A02 `test_rbac_matrix`, A03 `test_A03_connections_response_has_no_secret_fields`, A04 `test_A04_no_endpoint_accepts_sql`, W01 `tests/e2e/csp.spec.ts`: Q02 extends, and where they already exist, cross-references them from the threat model rather than duplicating.
7. `scripts/private_data_guard.mjs` and `scripts/private_data_guard.allow` (CTQ-14 controls the threat model cites).
8. `SECURITY.md` (D06) for the disclosure process referenced by the release checklist.
9. `docs/engineering/security-policy.md` (D03: the per-PR checklist Q02 turns into a release checklist), `testing-policy.md`.

### 3. In scope

- `docs/security/threat-model.md`: STRIDE per component (browser SPA, offline artifact, API, worker, metadata database, customer database connection, CI and image), each row: threat, control, control location (`path:line` or config), verifying test name, status; a closing table mapping the eight baseline findings (`security-architecture.md` 5) to their G2 re-verification results.
- `tests/security/hostile-fixture.spec.ts`: load `fixtures/schemas/hostile.json` in the SPA through all 13 views and Insights, and in the built artifact; assert no `dialog` event, no node added outside the view root that was not rendered by React (mutation observer for `<script>`, `<iframe>`, `<img onerror>`), CSV exports have every hostile cell neutralised (from W03 `csv.ts`), `Object.prototype` unchanged after load (`test 'CTQ-07 hostile fixture inert'`).
- `tests/security/csp-violations.spec.ts`: listen for `securitypolicyviolation` on every SPA route (13 views plus Insights, both themes); 0 reports (`CTQ-07 csp violations = 0`); W01's `csp.spec.ts` is folded in or referenced.
- `tests/security/cookies-csrf.spec.ts`: cookie attributes (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`), CSRF token required on `PUT /reviews/{id}` and `POST /connections`, rejected without it, API key bypasses CSRF but not RBAC (`CTQ-07 cookie flags and csrf`).
- `tests/security/deep-link-fuzz.spec.ts`: property-based corpus over the route grammar (random keys, over-cap values, unknown ids, encoded control characters, `__proto__` in `v.*` names); the page renders the view with no selection or drops the key; no console error escalates to a dialog; URL after load is canonical.
- `tests/security/storage-isolation.spec.ts`: two fixtures with identical table names and different `project.key` never read each other's `backend-buddy:*`, `backend-buddy-erd:v1:*`, or `backend-buddy:view-state:v1:*` keys; a key with a colon-smuggled project key is impossible (regex at `build_explorer.py:24`).
- `services/api/tests/test_Q02_security.py`: upload abuse (oversize, wrong content type, 33-level nesting, 20,001 tables, duplicate ids, `__proto__` keys) all rejected with fixed messages; IDOR negatives for every tenant-scoped resource (extends A02's test); RBAC matrix completeness re-run; `test_Q02_no_secret_in_any_response` walks `openapi.json` response schemas for the forbidden field names.
- `scripts/bundle-secret-grep.mjs`: greps `packages/web/dist`, `packages/explorer/dist`, and `dist/backend-buddy.html` for `BB_`, `password`, `BEGIN PRIVATE KEY`, GitHub token patterns, and the fixture DSN; expected empty; wired into `npm test`.
- `docs/qa/release-security-checklist.md` (or a section in Q04's `release-checklist.md`; coordinate): audits clean, matrix complete, CSP 0 reports, hostile fixture inert, guard green, image listing clean, threat model status column all green or accepted.
- CHANGELOG line; F20, F16, F17, F10, F14, F19, F22 section 14 rows (tests added).

### 4. Out of scope

- Fixing any finding (report to the owning WP with the failing test); the threat model records status `open` until fixed.
- ZAP, SBOM, cosign, trivy gate (L-07; O02 runs trivy as a warning).
- Penetration testing by a third party (to be validated by the owner; not a repository deliverable).
- Changing the CSPs, cookie attributes, or the route grammar (architecture decisions; propose in the report).
- Compliance regime decisions (`security-architecture.md` open question 3).

### 5. May modify

```
tests/security/**
services/api/tests/test_Q02_*.py
scripts/bundle-secret-grep.mjs
scripts/project.mjs                      (add bundle-secret-grep to the test step only)
docs/security/threat-model.md
docs/qa/release-security-checklist.md
docs/features/F10-schema-diff.md, F14-drill-through-navigation.md, F16-projects-and-snapshots.md, F17-connections-and-profiling.md, F19-exports.md, F20-auth-and-workspaces.md, F22-offline-artifact-and-skill.md   (section 14 only)
CHANGELOG.md                             ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated (a needed hostile vector is a change request to scripts/generate-fixtures.mjs, reported)
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change (fast-check or similar is a deviation to record if needed)
packages/**, services/api/app/**, deploy/**, skill/**   application code is never edited by Q02
docs/architecture/security-architecture.md   D02; corrections proposed in the report
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    O02 wires the suites
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical; zero network requests | D9; CTQ-05 | `tests/security/artifact.spec.ts` (S01/S02), re-run here |
| Strict SPA CSP: 0 violation reports across 13 views plus Insights | `security-architecture.md` 6.2 | `CTQ-07 csp violations = 0` |
| Cookie and CSRF model | `security-architecture.md` 7 | `CTQ-07 cookie flags and csrf` |
| RBAC complete; IDOR 404; secrets never in responses | CTQ-07 | `test_rbac_matrix`, `test_Q02_security.py` |
| Draft SQL never executed; no endpoint accepts SQL | C04; CTQ-06 | `scripts/sql-path-lint.mjs`, `test_A04_no_endpoint_accepts_sql` re-run |
| Route grammar: unknown keys dropped, values capped at 200, unknown ids dropped | `drill-through-contract.md` 4 | `deep-link-fuzz.spec.ts` |
| Storage key families scoped by `project.key` and fingerprint | C13 | `storage-isolation.spec.ts` |
| Hostile input renders inert in every view, the artifact, and CSV | S01; CTQ-07 | `hostile-fixture.spec.ts` |
| Private-data guard green; image contents listed | CTQ-14 | `guard`, `compose-smoke` |
| Threat model rows cite existing tests; a row without a test is `open`, never blank | this brief | docs lint (Q05) DL-10 for citations |

### 8. Deliverables checklist (definition of done)

- [ ] Tests and scripts, names prefixed with `CTQ-07`/`CTQ-06`/`Q02`, green locally with the acceptance commands
- [ ] Feature document section 14 rows added for the features whose tests were added; section 3 unchanged
- [ ] Migration: none, because no schema changes
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (this package produces the release version of it)
- [ ] Accessibility result: not applicable
- [ ] Performance measurement: not applicable (record the suite wall time for O02 planning)
- [ ] Caveat text: not applicable
- [ ] `npm run guard` green
- [ ] `npm run build` run so the artifact under test is current; mirror unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: every threat-model control row has a test name that exists in the tree (`grep -rn` proof in the PR)

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run build
node scripts/bundle-secret-grep.mjs                                       # expected: no output, exit 0
node scripts/sql-path-lint.mjs
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml up -d --wait --wait-timeout 300
npx playwright test tests/security/ --reporter=junit                      # hostile, csp-violations, cookies-csrf, deep-link-fuzz, storage-isolation, artifact
python -m unittest discover -s services/api/tests -p 'test_Q02_*.py'
python -m unittest discover -s services/api/tests -p 'test_A02_rbac_matrix.py'
npm --prefix packages/explorer audit --omit=dev --audit-level=high && pip-audit -r services/api/requirements.txt -r packages/profiler/requirements.txt
node scripts/no-skip-check.mjs <junit-output>
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml down -v
```

Package-specific assertions: `threat-model.md` has no row with an empty test column; the hostile-fixture run's mutation log lists 0 unexpected nodes; the fuzz suite ran at least 500 generated URLs (count printed).

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). "Out of scope, found" is expected to be the longest section: every failing control with its owning WP.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-04 strict SPA CSP | The 0-violation e2e is the arbiter; a report is a defect for the owning view's WP, never a CSP change. |
| RK-14 sensitive values | `test_Q02_no_secret_in_any_response` and the export stripping check. |
| RK-16 loopback server | S03's tests re-run as part of `python -m unittest discover -s packages/explorer/server`. |
| RK-19 storage origin split | Isolation test documents the expected behaviour; loss on origin change is C13, not a defect. |
| RK-01 private data | Hostile fixture is synthetic (R01); guard green. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
