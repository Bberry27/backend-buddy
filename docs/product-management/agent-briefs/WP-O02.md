Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# WP-O02 CI complete and release

| Field | Value |
|---|---|
| Work package | O02 (track O, phase 2) |
| Features | none (infrastructure) |
| CTQs | CTQ-07 (audits, trivy), CTQ-12 (coverage gates, no-skip), CTQ-13 (CHANGELOG section check), CTQ-14 (guard, notices drift), CTQ-15 (rollback rehearsal) |
| Caveats | none surfaced |
| Depends on | O01 |
| Blocks | Q05 (docs/code sync needs the full CI to exist) |
| Branch | `o02/ci-release` |
| Gate | G2 |

### 1. Goal

Complete the GitHub Actions set: e2e, a11y, perf-smoke, and security suites run through `deploy/compose.qa.yml`; a migrations job; contract drift (`gen_contract.mjs --check`, `openapi.json --check`); `security.yml` gains pip-audit for every requirements file, trivy filesystem and image scans, and the notices drift check already present; `release.yml` publishes the image to `ghcr.io/cesprototypers/backend-buddy` on a tag after checking that `CHANGELOG.md` has a section for the version; nightly jobs run the perf harness (Q01) and the real-PostgreSQL profiler tests (Q03); a `rollback-rehearsal` job pulls the previous tag and repeats upgrade/downgrade. A verifier can check every job green on a clean clone and the release workflow producing an image for a test tag.

### 2. Reading list (ordered)

1. `docs/product-management/ctq.md` rows CTQ-07, CTQ-12, CTQ-13, CTQ-14, CTQ-15 (measurement commands and the jobs named there: `npm-audit`, `pip-audit`, `gitleaks`, `notices-drift`, `compose-smoke`, `rollback-rehearsal`, `no-skip-check.mjs`).
2. `docs/product-management/traceability.md` section 2 (release-note line collected at tag time; PR title regex is Q05's step, not O02's) and section 4 DL-15 (CHANGELOG id prefix).
3. `docs/architecture/deployment-architecture.md` 8 (tags by version and git sha; GHCR path; CHANGELOG section check) and 3.2 (qa overlay).
4. `docs/architecture/adr/ADR-0008-testing-strategy.md` (which suites run where; bundled Chromium; nightly vs PR).
5. `.github/workflows/ci.yml` (jobs `explorer`, `python`, `artifact`, `guard`, `scripts`; the `compose-smoke` job from O01) and `.github/workflows/security.yml` (jobs `gitleaks`, `npm-audit`, `pip-audit` at `:60-75` currently auditing one requirements file, `notices-drift` at `:84-101`); `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`.
6. `docs/developer/release.md` (D07): the release procedure this package automates; correct it to the real workflow in the same PR.
7. `docs/product-management/risk-register.md` RK-07 (flaky swiftshader: perf as warnings until two green weeks), RK-20 (notices drift), RK-22 (proposed `git diff --exit-code skill/assets/extensions` after build; `roadmap.md` open question 5: not approved, do not add unless the owner has decided), RK-23 (CI never run).
8. S02 deliverables: `playwright.config.ts`, `scripts/no-skip-check.mjs`, `scripts/size-budget.mjs`, coverage configs; Q01 (`tests/perf/**`), Q03 (`packages/profiler/tests/test_postgres_live.py`), C01 (`scripts/gen_contract.mjs --check`), A02 (`python -m app.export_openapi --check`).
9. `scripts/generate_notices.mjs` (`--check`) and `THIRD_PARTY_NOTICES.md`.
10. `docs/engineering/standards.md`, `testing-policy.md`, `security-policy.md` (D03).

### 3. In scope

- `ci.yml` additions: `web` job (Vitest with coverage threshold, `npm --prefix packages/web run build`, `node scripts/size-budget.mjs`); `contract-drift` job (`node scripts/gen_contract.mjs --check`, `python -m app.export_openapi --check`, `node scripts/generate_notices.mjs --check`); `migrations` job (PostgreSQL service container; `alembic upgrade head && downgrade base && upgrade head`; `python -m unittest ... test_A01_*`); `api` job (`services/api` and `packages/profiler` tests with `coverage report --fail-under` per CTQ-12 groups); `e2e` job (`docker compose -f deploy/compose.yml -f deploy/compose.qa.yml run playwright npx playwright test tests/e2e tests/a11y tests/security --reporter=junit`, then `node scripts/no-skip-check.mjs`); `artifact` job extended with `node scripts/verify_host.mjs dist/backend-buddy.html out --widths=1920,1366,390` and the byte-identical CSP assertion (replacing the substring grep at `ci.yml:93`); `rollback-rehearsal` job (pull previous tag from GHCR, `up`, upgrade to the new image, downgrade, start previous, `/readyz` 200).
- `security.yml` additions: pip-audit over `services/api/requirements*.txt` and `packages/profiler/requirements.txt`; `trivy fs` on the repo and `trivy image` on the built image (severity HIGH,CRITICAL; as a gate only after the first clean run, otherwise warning per RK-07's pattern; the flip is recorded in the workflow comment); weekly schedule retained.
- `release.yml`: on `v*` tags: verify `CHANGELOG.md` contains `## [<version>]`; build with the O01 Dockerfile; tag `ghcr.io/cesprototypers/backend-buddy:<version>` and `:<git sha>`; push with the GitHub token; attach `THIRD_PARTY_NOTICES.md` and the release notes (CHANGELOG section) to the GitHub release; no SBOM/cosign (L-07).
- `nightly.yml`: perf harness (`tests/perf`, Q01) and real-PostgreSQL profiler tests (`compose.qa.yml`, Q03) with results uploaded as artifacts and a summary line; failures notify but do not block PRs (RK-07).
- Concurrency groups and `permissions:` minimal on every workflow; pinned action versions by sha.
- `docs/developer/release.md` corrected; `docs/developer/test.md` section 8 ("checks that run in CI") updated; CHANGELOG line.

### 4. Out of scope

- PR-title regex step and `docs_lint.mjs` step (Q05).
- Writing the perf harness (Q01) or the real-PostgreSQL tests (Q03); O02 wires whatever exists and skips a job with a visible "not yet delivered" status rather than a silent pass.
- SBOM, cosign, ZAP, Lighthouse, Caddy (L-07); GitHub labels/issue forms/CODEOWNERS sync (L-09).
- Adding `git diff --exit-code skill/assets/extensions` after build unless `roadmap.md` open question 5 has been decided in favour (report it as pending).
- Any change to Dockerfile or compose files (O01) or application code.

### 5. May modify

```
.github/workflows/ci.yml
.github/workflows/security.yml
.github/workflows/release.yml
.github/workflows/nightly.yml
.github/dependabot.yml                   (add pip and docker ecosystems)
scripts/no-skip-check.mjs                (only if S02's version needs a JUnit path flag)
docs/developer/release.md
docs/developer/test.md                   (section 8 only)
CHANGELOG.md                             ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated (the drift job checks it)
package.json, package-lock.json         no dependency change
packages/**, services/**, deploy/**, skill/**   owned by other tracks
tests/**                                S02, Q01, Q02, Q03 (O02 runs them)
scripts/*.mjs other than no-skip-check.mjs   owned by their packages
.github/PULL_REQUEST_TEMPLATE.md, CODEOWNERS   R00; D03 for the DoD reference
docs/reference/caveats.md               frozen at G0
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical and zero external requests asserted in CI (replaces the substring check) | D9; CTQ-05 | `artifact` job |
| Generated paths never hand-edited; drift checks fail CI (`generate_notices.mjs --check`, `gen_contract.mjs --check`, `export_openapi --check`) | README "Generated paths" | `contract-drift` job |
| Coverage gates: logic 90, components 75, overall 80, Python 85, auth/crypto/policy 95; zero silently skipped suites | CTQ-12 | `web`, `explorer`, `api`, `e2e` jobs; `no-skip-check.mjs` |
| Audits: `npm audit --omit=dev --audit-level=high`, pip-audit, gitleaks clean; trivy HIGH/CRITICAL | CTQ-07 | `security.yml` |
| Release only when `CHANGELOG.md` has the version section; images tagged by version and git sha at `ghcr.io/cesprototypers/backend-buddy` | `deployment-architecture.md` 8; CTQ-13 | `release.yml` |
| Rollback rehearsal: previous tag + downgrade -> `/readyz` 200 | CTQ-15 | `rollback-rehearsal` job |
| Guard runs on every commit and in CI; image contents listed | CTQ-14 | `guard`, `compose-smoke` |
| ubuntu CI is the reference; bundled Chromium with swiftshader flags; no `msedge` | RK-09; S02 | `e2e` job |
| Perf budgets as warnings until two green weeks, then failures | RK-07; CTQ-09 | `nightly.yml` comment records the flip date |
| Minimal `permissions:` and sha-pinned actions on every workflow | `security-policy.md` (D03) | review checklist |

### 8. Deliverables checklist (definition of done)

- [ ] Workflows green on a clean clone (link every job run in the PR)
- [ ] Feature document sections 3 and 14: not applicable, because no feature surface changes; `docs/developer/{release,test}.md` updated instead
- [ ] Migration: none, because this package changes no schema
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (permissions minimal; actions pinned; secrets only via GitHub secrets; trivy results attached)
- [ ] Accessibility result: not applicable (the a11y suite is wired, its results belong to the feature PRs)
- [ ] Performance measurement recorded: total CI wall time per job on the first green run (no budget; recorded for planning)
- [ ] Caveat text: not applicable
- [ ] `npm run guard` green
- [ ] `npm run build`: run by the `artifact` job; mirror unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: a test tag (`v0.0.0-test`) exercised `release.yml` end to end and the image was deleted afterwards; the transcript is in the PR

### 9. Acceptance commands

```sh
npm run guard
npx --yes action-validator .github/workflows/*.yml                     # syntax valid (or actionlint if available)
gh workflow run ci.yml --ref <branch> && gh run watch                   # all jobs green
gh workflow run security.yml --ref <branch> && gh run watch
gh workflow run nightly.yml --ref <branch> && gh run watch              # perf and real-PG jobs run or report 'not yet delivered'
git tag v0.0.0-test && git push origin v0.0.0-test && gh run watch      # release.yml: CHANGELOG check, image pushed, release created
gh release delete v0.0.0-test --yes && git push --delete origin v0.0.0-test
grep -c "grep -q \"connect-src 'none'\"" .github/workflows/ci.yml       # expected: 0 (byte-identical assertion replaces the substring check)
```

Package-specific assertions: the `e2e` job summary shows `skipped: 0`; `contract-drift` fails when `THIRD_PARTY_NOTICES.md` is edited by hand in a scratch branch (demonstrated once, linked in the PR); `rollback-rehearsal` shows `/readyz` 200 on the previous tag.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include a job matrix (workflow, job, trigger, gate, blocking or warning).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-07 swiftshader flakiness | Perf and pixel jobs are nightly and non-blocking until baselines exist (Q01); medians over 60 frames. |
| RK-20 notices drift | `notices-drift` stays required on every PR; release attaches the notices file. |
| RK-22 duplicated source trees | Records `roadmap.md` open question 5 as pending; adds the diff step only on approval. |
| RK-23 CI has never run | The first task is to make the existing five jobs green on `main` before adding new ones; each addition is its own commit. |
| RK-09 Windows vs Linux | All jobs on `ubuntu-latest`; `PYTHON=python3`. |
| RK-11 licence unreviewed | `release.yml` refuses to publish a non-prerelease tag while `LICENSE` carries the DRAFT header (grep step). |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
