Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Contributing a change

How a change moves from a work-package brief to `main`. `CONTRIBUTING.md` at the root is the short version; this page is the full workflow. Coding agents follow the same steps (AGENTS.md).

## 1. Start from a brief

Every change belongs to a work package (`R`, `S`, `C`, `W`, `A`, `O`, `Q`, `D` tracks) or a feature (`F01`-`F22`, `docs/features/README.md`). The brief `docs/product-management/agent-briefs/WP-<id>.md` (D08) lists the reading order, in-scope and out-of-scope items, `may-modify` and `must-not-touch` globs, frozen contracts, and the exact acceptance commands. No brief, no code: ask for one.

Read in the brief's order: feature doc, contract, ADRs, then the code. Stay inside the globs; other work packages run concurrently in other worktrees.

## 2. Branch

Branch from an up-to-date `main`:

| Work | Branch name | Example |
|---|---|---|
| Feature | `f##/<slug>` | `f08/city-search` |
| Other work package | `<wp-id>/<slug>`, lower case | `s01/renderer-escaping`, `d07/developer-docs` |

Rebase on `main` rather than merging `main` into the branch. Never force-push `main`; force-pushing your own branch after a rebase is fine.

## 3. Commit

Conventional Commits with the id as the scope:

```
feat(F08): add table search with fly-to in Schema City
fix(S01): escape the inspector source line and validate it as an integer
docs(D07): developer setup, run, test, contribute, release, troubleshooting
test(Q02): hostile fixture renders inert through all 13 views
chore(R00): pin Node 22 in .nvmrc and engines
```

Types in use: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `build`, `ci`. One logical change per commit; the PR is squash-merged, so the PR title becomes the commit on `main` and must follow the same format.

Before every commit:

```sh
npm run guard      # blocks the commit via .githooks/pre-commit as well
npm test
npm run build      # when packages/explorer changed, so skill/assets/extensions follows; commit the mirror
```

The pre-commit hook (`.githooks/pre-commit`) runs only the guard; run the tests yourself. Install the hook once with `npm run hooks` (`docs/developer/setup.md`, step 4).

## 4. The private-data guard

`npm run guard` (`scripts/private_data_guard.mjs`) must be green on every commit (CTQ-14). It lists what git would track (`git ls-files --cached --others --exclude-standard`, `:229-243`) and applies the rules documented at `:9-24`: no files under `reference/` or `examples/` at the root or under `dist/`, `.qa/`, `outputs/` anywhere; no images outside `docs/assets/`; no `report.json`; no file over 2 MB unless listed in `scripts/private_data_guard.allow` with review approval; no Windows user-profile, dot-codex, or Unix home paths in text; plus the local denylist when `BB_DENYLIST_FILE` is exported.

When it fails, fix the cause rather than the rule: move a screenshot under `docs/assets/` only if it shows synthetic fixtures, replace a machine-local path with a repository-relative one, delete QA output. Exit code 2 means a configuration error (bad `--root`, denylist inside the tree, invalid regex), not a violation.

## 5. Documentation is part of the change

Update, in the same PR:

- the feature doc `docs/features/F##-<slug>.md`, sections 3 (current state, with `file:line` citations valid at the PR's commit) and 14 (implementation map and change log);
- `CHANGELOG.md` under `[Unreleased]`, one line prefixed with the id (`- F08: table search with fly-to in Schema City`);
- any architecture, engineering, or developer document whose statements the change makes false; and the "Last verified against code" value of every document you touched.

Rules for prose: Markdown, LF, repository-relative paths, no machine-local paths, no private project names (say "the original private example" if you must), no invented numbers ("to be validated" where a fact is unknown), one sentence per claim. Caveats are never paraphrased: quote the C-id text from `docs/reference/caveats.md` verbatim, and UI copy for a caveat comes only from `packages/explorer/src/caveat-strings.ts` once C03 lands (decision D8).

### Docs lint

`scripts/docs_lint.mjs` (Q05) will check: status header on every document, feature registry completeness and the 14 headings per feature doc, caveat ids resolve and quoted text matches `caveats.md`, ADR index consistency, and that the constants in `docs/reference/limits-and-caps.md` match the source. It also gates PR titles on the id regex (CTQ-13). Until it exists, reviewers check these by hand; write documents as if the lint were already running.

## 6. Open the pull request

One work package per PR. Use the template `.github/PULL_REQUEST_TEMPLATE.md`; every section is required:

1. **Work package / Feature id** and the brief path.
2. **Summary**: what changed and why, two or three sentences.
3. **Definition of done** checklist (section 7), every box ticked or explained.
4. **Release-note line**: one user-facing line prefixed with the id (the release-notes template arrives with O01; until then this line is the record).
5. **Acceptance commands** from the brief, pasted with their results.
6. **Notes for reviewers**: risks, follow-ups, decisions to confirm; screenshots of synthetic fixtures only.

PR title = Conventional Commit line with the id as scope, for example `feat(F08): Schema City search`.

Once R00 bootstraps the repository (the directory is not a git repository at the commit in the status header), `main` is protected: CI (`ci.yml`, `security.yml`) must be green and PRs are squash-merged; an approving review from a code owner (`.github/CODEOWNERS`) becomes required once a second maintainer joins, and until then the sole maintainer merges green PRs (`CONTRIBUTING.md`, "Branches, commits, pull requests"). Dependabot PRs carry the `chore(R00)` prefix (`.github/dependabot.yml:10`, `:27`) and follow the same rules. The PR that performs the bootstrap flips this paragraph to the present tense.

## 7. Definition of done

The checklist every PR ticks (approved plan, "Work packages"; full rationale in `docs/engineering/definition-of-done.md`, D03):

- [ ] Code follows `docs/engineering/standards.md` and stays inside the brief's `may-modify` globs; no generated path (`skill/assets/extensions/**`, `fixtures/**` outputs, `THIRD_PARTY_NOTICES.md`) edited by hand
- [ ] Tests added or updated, names prefixed with the F/CTQ id, green locally with the brief's acceptance commands
- [ ] Feature doc sections 3 (current state) and 14 (implementation map) updated, or n/a: no feature affected
- [ ] Migration with a tested downgrade, or "none because ..."
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line provided
- [ ] Security checklist from `docs/engineering/security-policy.md` completed
- [ ] Accessibility result recorded (axe serious/critical = 0 and a keyboard journey where UI changed), or n/a: no UI change
- [ ] Performance number recorded where a budget exists (CTQ-09, `docs/reference/limits-and-caps.md` section B), or n/a
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts` (once C03 has landed)
- [ ] `npm run guard` green; no private schemas, snapshots, screenshots, or QA reports added
- [ ] `npm test` green; `npm run build` run and the mirror committed if `packages/explorer` changed

## 8. Review

Reviewers check, in this order: private data (guard output, prose, fixture names), scope (globs, one package), correctness (tests prove the behaviour, `file:line` citations in docs are real), caveat wording (verbatim), and the DoD boxes. Phase 0 documents additionally pass an adversarial review (facts versus code, caveat wording, scope creep) before merge, and their status header moves from `draft` to `reviewed`.

## 9. After merge

Delete the branch. If the change closes a scheduled finding listed in the Security section of `CHANGELOG.md`, move the entry to `Fixed` in the same PR that fixes it. Feature doc section 14 is appended on merge (CTQ-13).

## 10. Guardrails you never trade away

From AGENTS.md, section 3; each has tests and a CTQ behind it. Four of them are caveats, cited here by id only and never restated: C01, C04, C07, and C14 (wording in `docs/reference/caveats.md`). The others are engineering rules: keep SchemaGraph project-neutral; profiler caps may be tightened, never raised, without an ADR; keep click-drag pan versus click-select covered in browser tests; no upload, hosting, telemetry, or export as a side effect of any action; keep the artifact CSP byte-identical; secrets never reach the browser or the repository. If a brief seems to require breaking one, stop and raise it. (AGENTS.md section 3 itself still restates the four caveats in its own words; aligning it with D8 is outside this document.)
