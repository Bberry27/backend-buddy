Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Developer setup

One-time preparation of a workstation for this repository. After this page, `docs/developer/run.md` builds the artifact, `docs/developer/test.md` runs every check, and `docs/developer/contribute.md` explains how a change reaches `main`.

All paths are repository-relative. Never copy files in from another local project, and never build or commit inside any directory other than this clone (AGENTS.md, section 6).

## 1. Prerequisites

| Tool | Version | Why | Enforced by |
|---|---|---|---|
| Node.js | 22.x (`.nvmrc` = `22`) | esbuild bundle, TypeScript tests, all `scripts/*.mjs` | `engines` in `package.json` and `packages/explorer/package.json`. Advisory for `npm run restore` today: the root `.npmrc` sets `engine-strict=true`, but `restore` is `npm --prefix packages/explorer ci` (`package.json:12`) and npm reads the project `.npmrc` from the prefix directory, where none exists (`npm --prefix packages/explorer config get engine-strict` prints `false`). On an older Node the install prints `EBADENGINE` and completes; only npm commands run at the repository root are refused. Enforcement for `restore` is an open R00 item (add `packages/explorer/.npmrc` or `--engine-strict` to the script) |
| npm | 10.5.1 or later | lockfile v3 in `packages/explorer/package-lock.json` | same `engines` field |
| Python | 3.13 (CI pin: `.github/workflows/ci.yml`, `setup-python` `3.13`) | renderer `skill/scripts/build_explorer.py`, profiler and loopback server in `packages/explorer/server`, contract validator `packages/profiler`, all Python tests | not enforced at runtime. The renderer, profiler and loopback server use only the standard library; `bb_profiler` requires `jsonschema` (`packages/profiler/pyproject.toml`) |
| Git | 2.x | clone, hooks (`.githooks/pre-commit`) | `scripts/install-hooks.mjs` |
| Docker Engine + Compose v2 | current | the Compose stack of work package O01 (`deploy/compose.yml`); not needed for anything that exists today | none yet |

Optional:

- `psycopg[binary]>=3.2,<4` (`packages/explorer/server/requirements.txt:4`) only if you profile PostgreSQL. SQLite profiling and every test run without it; the import is deferred until a PostgreSQL connection is opened (`packages/explorer/server/schema_profiler.py:205-206`).
- A Playwright runtime for the browser suites and `scripts/verify_host.mjs`. Playwright is not a dependency today; S02 pins `@playwright/test` with bundled Chromium. Until then see "Bring your own Playwright" in `docs/developer/test.md`.

Use a Node version manager that reads `.nvmrc` (`nvm use`, `fnm use`) so the shell picks Node 22 automatically.

## 2. Clone

Once R00 bootstraps the repository (`git init`, first commit, `gh repo create`), it will live, private, in the `Bberry27` personal GitHub account (decision D7). At the commit in the status header the directory is not yet a git repository and no remote exists. You will need organisation membership and an SSH key or `gh auth login`.

```sh
git clone git@github.com:Bberry27/backend-buddy.git
cd backend-buddy
```

Line endings are normalised to LF by `.gitattributes` (`* text=auto eol=lf`); do not override `core.autocrlf` for this clone.

## 3. Install dependencies

```sh
npm run restore
python -m pip install -r packages/profiler/requirements.txt
```

`restore` is `npm --prefix packages/explorer ci` (`package.json`, `scripts.restore`): a clean install of the locked explorer dependencies; the root `package.json` has no dependencies of its own. Re-run it after every lockfile change, and never use `npm install` in place of `npm ci` (AGENTS.md, section 7).

The second command is required, not optional. `bb_profiler.contract` imports `jsonschema` at module scope (`packages/profiler/bb_profiler/contract.py:42`), so the 17 contract tests that `npm test` discovers under `packages/profiler/tests` fail to import without it. `packages/profiler/requirements.txt` pins the exact version the tests and `pip-audit` run against; the compatible range is in `packages/profiler/pyproject.toml`.

Optional Python extras:

```sh
python -m venv .venv            # .venv/ is ignored by .gitignore
# activate the venv for your shell, then:
python -m pip install -r packages/explorer/server/requirements.txt   # psycopg 3, PostgreSQL profiling only
```

On Linux and macOS the interpreter is usually `python3`; see step 6.

## 4. Install the git hooks

```sh
npm run hooks
```

`scripts/install-hooks.mjs` sets `core.hooksPath` to `.githooks` for this clone (`scripts/install-hooks.mjs:59`) and marks the hook files executable where the filesystem supports it (`:68-74`; a no-op on Windows, which Git for Windows does not need). Without a `.git` entry it prints a hint and exits 0 (`:49-55`), so it is safe to run early. The hook `.githooks/pre-commit` runs the private-data guard and blocks the commit on any violation (`.githooks/pre-commit:28-32`, the `node scripts/private_data_guard.mjs` call).

Equivalent manual command: `git config core.hooksPath .githooks`.

## 5. Configure the local name denylist (owner and maintainers)

The private-data guard (`scripts/private_data_guard.mjs`) has a repo-neutral rule set that runs everywhere, plus an optional local denylist of regular expressions that must never appear in a tracked path or in text content: the name of the original private example, internal aliases, and similar. The denylist is deliberately not part of the repository (approved plan, "Repository and privacy plan", item 3).

1. Create a text file **outside** the clone, for example `~/.config/backend-buddy/denylist.txt`. One case-insensitive regular expression per line; blank lines and `#` comments are ignored (`private_data_guard.mjs:178-189`).
2. Export `BB_DENYLIST_FILE` with its path in the shell you commit from. The pre-commit hook honours the exported variable (comment at `.githooks/pre-commit:16`).

```sh
# bash / zsh (add to your shell profile)
export BB_DENYLIST_FILE="$HOME/.config/backend-buddy/denylist.txt"
```

```powershell
# PowerShell; persist with [Environment]::SetEnvironmentVariable(..., 'User') if wanted
$env:BB_DENYLIST_FILE = "$HOME\.config\backend-buddy\denylist.txt"
```

Rules the guard applies to the file: it refuses a denylist that lives inside the scanned tree (`private_data_guard.mjs:163-169`, exit code 2), reports matches with the matched text masked after three characters and never prints the pattern (`:128-133`, `:277`, `:301`), and skips the denylist with a warning when the variable points to an unreadable file (`:157-161`). An invalid regular expression is a configuration error that reports only the line number (`:184-187`).

Never commit the denylist, never quote its contents in an issue or PR, and never add a rule that would itself reveal the private name (for example in a `.gitleaks.toml`; the security workflow runs default gitleaks rules only, `.github/workflows/security.yml`, job `gitleaks`).

## 6. Interpreter name

`scripts/project.mjs` locates Python as `process.env.PYTHON`, falling back to `python` on Windows and `python3` elsewhere (`scripts/project.mjs:10`). CI sets `PYTHON=python3` (`.github/workflows/ci.yml`, top-level `env`). Set `PYTHON` explicitly when your interpreter has another name or lives in a virtual environment:

```sh
export PYTHON="$PWD/.venv/bin/python"
```

## 7. Verify the setup

```sh
npm run guard        # private-data guard: expect "private-data guard: OK - ..."
npm test             # typecheck, TypeScript unit tests, Python profiler, HTTP, and renderer tests
npm run build        # bundle, skill mirror, dist/backend-buddy.html (needs fixtures/, see below)
```

Expected results at the commit in the status header: `npm test` runs the explorer typecheck, the `tsx --test src/*.test.ts` suite (75 logic tests; the two browser tests matched by that glob self-skip without their environment variables), 51 Python tests in `packages/explorer/server` (one is skipped when `node` is not on `PATH`, `packages/explorer/server/test_explorer_http.py:373`), 9 renderer tests in `skill/scripts`, and 10 fixture tests in `fixtures/test_fixtures_normalize.py` (R01). `npm run build` renders from `fixtures/schemas/medium.json` by default (`scripts/project.mjs:89`); the fixture set is committed and regenerated by `npm run fixtures` (`scripts/generate-fixtures.mjs`, R01). To build against a snapshot you keep outside the repository, pass `--schema <path>` or set `BB_SCHEMA` (see `docs/developer/run.md`).

## 8. Editor

`.editorconfig` sets UTF-8, LF, final newline, two-space indentation (four for Python). A VS Code workspace file `backend-buddy.code-workspace` is tracked. No linter or formatter is configured yet; ESLint lands with S02.

## 9. What not to do

- Do not edit `skill/assets/extensions/**`; `npm run build` regenerates it from `packages/explorer` (`syncSkill()` in `scripts/project.mjs:52-60`).
- Do not put a real snapshot, a customer schema, a screenshot, or a `report.json` inside the clone. `npm run guard` rejects images outside `docs/assets/`, any `report.json`, files over 2 MB not listed in `scripts/private_data_guard.allow`, and machine-local paths in text (rule list at `scripts/private_data_guard.mjs:9-24`).
- Do not add or upgrade dependencies unless your work-package brief says so (AGENTS.md, section 7).
