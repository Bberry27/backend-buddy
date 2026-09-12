# Contributing

Short version: work from a brief, stay inside your globs, prove the change with tests, keep the documentation in step, and run the guard before you commit. The step-by-step guides live in `docs/developer/`.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the canonical sources, generated mirrors, and guardrails.
- Find the work-package brief in `docs/product-management/agent-briefs/`. If there is no brief, ask for one before writing code.
- Set up with `docs/developer/setup.md`: Node 22 (`.nvmrc`), npm 10, Python 3.13. `npm run restore` installs the explorer's locked dependencies with `npm ci`; `python -m pip install -r packages/profiler/requirements.txt` installs the `jsonschema` that `bb_profiler` imports, without which the contract tests in `npm test` fail to import.

## Branches, commits, pull requests

- Branch from `main`: `f##/<slug>` for feature work, `<wp-id>/<slug>` in lower case for other work packages (`r00/governance`, `s01/renderer-escaping`).
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with the feature or work-package id as the scope: `feat(F08): ...`, `fix(S01): ...`, `docs(D06): ...`, `test(Q02): ...`, `chore(R00): ...`.
- One work package per pull request. The PR title carries the id as its scope. Fill in the pull-request template completely; the "Work package / Feature id" line is required.
- `main` is the single long-lived branch. CI must be green before merge and PRs are squash-merged. GitHub does not enforce branch protection or required reviews on a private repository under a free personal account, so the green CI run and `npm run guard` are the gate; treat them as mandatory. Never force-push to `main`.
- Rebase your branch on `main` rather than merging `main` into it.

## Definition of done

Every PR ticks every box, or states why a box does not apply:

- [ ] Code follows the conventions in `docs/developer/contribute.md` (the engineering standards document is the D03 deliverable `docs/engineering/standards.md`) and stays inside the brief's `may-modify` globs; no generated path edited by hand
- [ ] Tests added or updated, names prefixed with the F/CTQ id, green locally
- [ ] Feature doc sections 3 (current state) and 14 (implementation map) updated
- [ ] Migration with a tested downgrade, or "none because ..."
- [ ] CHANGELOG line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line (in the PR description until the release-notes template lands with O01)
- [ ] Security review recorded against `docs/architecture/security-architecture.md` (threat summary, section 3; private data and secrets, section 9); the release security checklist arrives with D03
- [ ] Accessibility result recorded (axe serious/critical = 0 and a keyboard journey where UI changed)
- [ ] Performance number recorded where a budget exists (`docs/product-management/ctq.md`, CTQ-09)
- [ ] `npm run guard` green; no private schemas, screenshots, or QA reports added

## Dependencies

The explorer's `package-lock.json` is pinned deliberately: the offline artifact is one
self-contained file whose bundle contents are asserted by tests, so a dependency change
is a reviewed change. Dependabot therefore proposes only grouped minor and patch updates
plus GitHub Actions bumps, and ignores major updates to the runtime dependencies.

A major update is its own work package, not a merge. Each of these is a migration:

| Dependency | What a major requires |
|---|---|
| `typescript` | 7.x errors on CSS side-effect imports (TS2882); needs an ambient `*.css` declaration and a typecheck pass |
| `@types/node` | must match the Node major in `.nvmrc` (22), not the newest published |
| `lucide-react` | icon exports can be renamed or removed; all 30 imported icons must resolve and render |
| `react`, `three`, `@xyflow/react`, `@react-three/*` | change rendering; need the browser and visual suites |

Merging any dependency change makes `THIRD_PARTY_NOTICES.md` stale. That is expected and
is not a merge blocker on a Dependabot pull request, where the drift check is advisory.
Immediately after merging, run `npm run notices` and commit the result; the push to
`main` enforces the check, so skipping this turns `main` red.

## Running the checks

```sh
npm run restore                       # once, and after lockfile changes
python -m pip install -r packages/profiler/requirements.txt   # once: jsonschema, for the contract tests
npm run guard                         # private-data guard (also runs in CI)
npm test                              # contract drift + typecheck + TypeScript unit + profiler + renderer + contract + fixture tests
npm run build                         # regenerate the bundle, the skill mirror, and dist/backend-buddy.html
npm run test:scripts                  # node:test suites under scripts/: node --test "scripts/**/*.test.mjs" (after npm run restore)
npm run test:python                   # the Python suites only, the same list npm test and CI use
npm --prefix packages/explorer test   # TypeScript unit tests only
python -m unittest discover -s packages/explorer/server -p 'test_*.py'
python -m unittest discover -s skill/scripts -p 'test_*.py'   # renderer AND its S01 security regressions
python -m unittest discover -s packages/profiler/tests -p 'test_*.py'   # needs jsonschema
```

Set `PYTHON=python3` if that is your interpreter's name. CI runs the same commands on `ubuntu-latest`; see `.github/workflows/ci.yml` and `.github/workflows/security.yml`.

Script tests live under `scripts/` at any depth and end with `.test.mjs`. `npm run test:scripts` is the one supported invocation (a bare `node --test scripts/` fails on Node 22, and other suffixes are not discovered); CI's `scripts` job runs that same script after `npm run restore`, and the fixture tests fail rather than skip under `CI` when the TypeScript validators cannot load. The local-only denylists are read from the environment and never committed: `BB_DENYLIST_FILE` (name patterns for the guard) and `BB_FORBIDDEN_COUNTS` (table and column counts no fixture may reproduce).

## Documentation

Documentation is part of the change, not a follow-up. Update the feature doc, the changelog, and any affected architecture or developer doc in the same PR. Markdown, LF line endings, no machine-local paths, no private project names.

## More

- `docs/developer/setup.md`, `run.md`, `test.md`, `contribute.md`, `release.md` for the detailed workflow
- `docs/developer/contribute.md` section 7 for the checklist with package-specific additions; the rationale document `docs/engineering/definition-of-done.md` lands with D03
- [SECURITY.md](SECURITY.md) for reporting vulnerabilities
