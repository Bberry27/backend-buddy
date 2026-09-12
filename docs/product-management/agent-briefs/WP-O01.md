Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# WP-O01 Docker and compose

| Field | Value |
|---|---|
| Work package | O01 (track O, phase 2) |
| Features | none (infrastructure); serves F16-F20 surfaces built by W01 and A01-A04 |
| CTQs | CTQ-14 (image contents prove `.dockerignore`), CTQ-15 (`docker compose up` to `/readyz` < 5 min; upgrade/downgrade/upgrade; rollback rehearsal) |
| Caveats | none surfaced |
| Depends on | A04, W01 |
| Blocks | O02, O03 |
| Branch | `o01/docker-compose` |
| Gate | G2 |

### 1. Goal

Package the product as one multi-stage image (`node:22-bookworm-slim` build stage, `python:3.13-slim-bookworm` runtime, pinned digests, non-root `10001`, read-only root filesystem with tmpfs, `HEALTHCHECK`) and three compose files: `deploy/compose.yml` (`db`, `migrate`, `api`, `worker`, secrets `backend-buddy_master_key` and `backend-buddy_db_password`), `deploy/compose.dev.yml` (Vite HMR proxying `/api`, `uvicorn --reload`, fixture PostgreSQL seeded from `fixtures/sql/pg/seed.sql`, `BB_ALLOW_PRIVATE_TARGETS=true`), `deploy/compose.qa.yml` (Playwright image), plus `.env.example`, `.dockerignore`, the runbooks `upgrade.md`, `rollback.md`, `backup-and-restore.md` exercised once, and the `compose-smoke` CI job. A verifier can check a clean ubuntu runner reaching `/readyz` in under 5 minutes, the migration round trip through the `migrate` service, a rollback to the previous tag, and an image file listing free of private paths.

### 2. Reading list (ordered)

1. `docs/architecture/deployment-architecture.md` in full: 1 (topology table, `depends_on` conditions), 2 (image stages and runtime hardening; `.dockerignore` additions), 3 (dev and qa overlays), 4 (environment contract; every variable in `.env.example` with a comment; secrets only as Docker secrets), 5 (TLS by reverse proxy; `127.0.0.1:8000` default bind), 6 (`/healthz` `/readyz`), 7 (backup outline), 8 (upgrade and rollback outline), 10 (open questions 1-4).
2. `docs/architecture/adr/ADR-0006-deployment-topology-and-artifact-csp.md`, `ADR-0007-private-data-and-fixture-policy.md` (image must not contain `reference/`, `examples/`, `.qa/`, `dist/backend-buddy.html`, PNGs).
3. `docs/operations/deployment.md` and `rollback.md` (D06, written as target topology per `roadmap.md` open question 2): O01 verifies them against the real compose files and corrects them in the same PR.
4. `docs/product-management/ctq.md` CTQ-14 (the `docker run ... find` listing command) and CTQ-15 (`docker compose -f deploy/compose.yml up -d --wait --wait-timeout 300`, `curl -fsS http://localhost:8000/readyz`, `alembic downgrade -1 && upgrade head`).
5. `docs/architecture/security-architecture.md` 4 (master key as a secret file; fingerprint check), 6.2 (the API serves the SPA; no separate web server at MVP), 9.
6. `.github/workflows/ci.yml` (job shape: Node setup `npm run restore`, Python setup, `npm run build`; the artifact job at `:65-93`) and `.github/workflows/security.yml`; `.gitignore` (mirrored by `.dockerignore`).
7. `scripts/project.mjs:10` (`PYTHON` indirection), `:52-60` (`syncSkill`), `:87-92` (`BB_SCHEMA` default `fixtures/schemas/medium.json`); `packages/explorer/server/profile_snapshot.py:14-17` (`--dsn-env` pattern: DSNs from the environment, never argv).
8. A01-A04 deliverables (`alembic upgrade head`, `python -m app.bootstrap`, `python -m app.worker`, `uvicorn app.main:app`), W01 (`packages/web/dist`), A03 (`packages/profiler` requirements).
9. `fixtures/sql/pg/seed.sql` and `fixtures/README.md` (R01): the dev fixture database seed; synthetic only.
10. `docs/developer/run.md` section 4 ("Compose flow: available after O01") and `setup.md`: O01 fills in the compose flow.
11. `docs/engineering/standards.md`, `security-policy.md` (D03).

### 3. In scope

- `deploy/Dockerfile`: stage 1 `node:22-bookworm-slim@sha256:<digest>` runs `npm ci` for `packages/explorer` and `packages/web`, `npm run build` (IIFE for the export path, Vite SPA, `syncSkill`); stage 2 `python:3.13-slim-bookworm@sha256:<digest>` installs `services/api` and `packages/profiler` with pinned requirements, copies `packages/web/dist` and `skill/` (renderer template and icons) from stage 1; runtime user `10001`, `WORKDIR /app`, `HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"`, OCI labels with git sha and version, no build tools in the final stage.
- `deploy/compose.yml`: services `db` (`postgres:16@sha256:<digest>`, volume `pgdata`, healthcheck `pg_isready`), `migrate` (`alembic upgrade head`, `depends_on: db: condition: service_healthy`), `api` (`uvicorn app.main:app --host 0.0.0.0 --port 8000`, published `127.0.0.1:8000:8000`, `read_only: true`, `tmpfs: /tmp`, `depends_on: migrate: condition: service_completed_successfully`), `worker` (`python -m app.worker`, same hardening); secrets `backend-buddy_master_key`, `backend-buddy_db_password` from files; `BB_*` from `.env`; `BB_ALLOW_PRIVATE_TARGETS` default `false`.
- `deploy/compose.dev.yml`: `web-dev` (`node:22`, `vite` on 5173 proxying `/api` to `api`), `api` with `--reload` and source bind mounts, `fixture-db` seeded from `fixtures/sql/pg/seed.sql`, `BB_ALLOW_PRIVATE_TARGETS=true`, `BB_COOKIE_SECURE=false` (A02 warning expected).
- `deploy/compose.qa.yml`: `playwright` (`mcr.microsoft.com/playwright:<version matching @playwright/test>`), runs `tests/{e2e,a11y,perf,security}` against `api` with `--use-angle=swiftshader --enable-unsafe-swiftshader`; `fixture-db` reused for Q03.
- `deploy/.env.example`: every variable from `deployment-architecture.md` section 4 with a comment and default; no secret values.
- `deploy/.dockerignore`: mirrors `.gitignore` plus `.git`, `docs/`, `tests/`, `.github/`.
- Runbooks in `docs/operations/`: `upgrade.md`, `rollback.md` (verify or replace the D06 draft), `backup-and-restore.md` (pg_dump from the `db` container; master key backed up separately, encrypted, off host; restore procedure; `/readyz` fingerprint check), each exercised once locally with the commands and observed output recorded (synthetic data only); `deployment.md` corrected to the real files.
- `.github/workflows/ci.yml` job `compose-smoke`: build the image, `docker compose -f deploy/compose.yml up -d --wait --wait-timeout 300`, `curl -fsS http://localhost:8000/readyz`, bootstrap the first owner non-interactively, `docker compose run --rm migrate alembic downgrade -1 && ... upgrade head`, image contents listing piped through the CTQ-14 grep (must be empty), `docker compose down -v`; rollback to the previous tag is O02's `rollback-rehearsal` (O01 documents the manual rehearsal in `rollback.md`).
- `docs/developer/run.md` section 4 and `setup.md` compose steps filled in.
- CHANGELOG line; release-note line.

### 4. Out of scope

- `release.yml`, GHCR publishing, `rollback-rehearsal` CI job, trivy scans, nightly jobs (O02).
- Metrics endpoint, `ops/backup.sh`, `ops/restore.sh` scripts (O03); O01's runbook uses plain `pg_dump`/`pg_restore` commands until O03 wraps them.
- Caddy or any TLS profile in the compose files (L-07; `deployment-architecture.md` open question 1).
- Multi-instance worker scaling for SaaS (L-08).
- Any application code change in `services/api`, `packages/web`, `packages/explorer`; a startup problem found here is reported to the owning WP.
- Loopback skill server containerisation beyond what S03 already enables (`deployment-architecture.md` section 9).

### 5. May modify

```
deploy/**
docs/operations/**
docs/developer/run.md                    (section 4 compose flow)
docs/developer/setup.md                  (compose prerequisites)
.github/workflows/ci.yml                 (compose-smoke job only)
scripts/project.mjs                      (only if a build step needs a flag for the Docker stage; documented in the PR)
CHANGELOG.md                             ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated (fixtures/sql/pg/seed.sql is mounted, not edited)
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change
packages/**                             W, C, A03
services/**                             A track
skill/**                                S01, S03
.gitignore                              R00 (propose additions in the report; .dockerignore mirrors, never diverges)
.github/workflows/security.yml, release.yml   O02
docs/reference/caveats.md               frozen at G0
docs/architecture/deployment-architecture.md   D02; corrections are proposed in the report, decided by the owner
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Topology: `db`, `migrate` (one-shot), `api`, `worker` from one image; `depends_on` conditions `service_healthy` (db) and `service_completed_successfully` (migrate) | `deployment-architecture.md` 1 | `compose-smoke` job; `docker compose config` |
| Image hardening: pinned digests, non-root `10001`, read-only rootfs with tmpfs, `HEALTHCHECK`, no private paths (`reference/`, `examples/`, `.qa/`, `dist/backend-buddy.html`, PNG) | `deployment-architecture.md` 2; CTQ-14 | image listing grep in `compose-smoke` |
| Secrets only as Docker secrets (`backend-buddy_master_key`, `backend-buddy_db_password`); never plain environment variables in `compose.yml` | `deployment-architecture.md` 4 | `grep -E 'PASSWORD=|MASTER_KEY=' deploy/compose.yml` empty |
| Environment contract names and defaults; every variable in `.env.example` | `deployment-architecture.md` 4; A02 settings | `test_A02_settings_reject_unknown`; a `compose-smoke` step that diffs `.env.example` keys against the settings model |
| `api` published on `127.0.0.1:8000` by default; TLS by the operator's proxy | `deployment-architecture.md` 5 | `docker compose config` shows the loopback bind |
| CTQ-15: `up` -> `/readyz` 200 in < 5 min on a clean runner; upgrade -> downgrade -> upgrade; rollback by previous tag + downgrade documented and rehearsed | CTQ-15 | `compose-smoke`; `rollback.md` transcript |
| `BB_ALLOW_PRIVATE_TARGETS` `false` in `compose.yml`, `true` only in the dev overlay | `deployment-architecture.md` 3.1 | `compose-smoke` asserts the default |
| Artifact and skill unchanged; the image copies `skill/` read-only | D9 | `tests/security/artifact.spec.ts` |
| Every migration has a working downgrade (A01) | CTQ-15 | `compose-smoke` downgrade step |
| Project-neutral fixtures: `fixture-db` seeds only `fixtures/sql/pg/seed.sql` | ADR-0007 | guard |

### 8. Deliverables checklist (definition of done)

- [ ] Compose files, Dockerfile, `.env.example`, `.dockerignore`, runbooks, CI job green with the acceptance commands
- [ ] Feature document sections 3 and 14: not applicable, because no feature surface changes; `docs/operations/*` and `docs/developer/run.md` updated instead
- [ ] Migration: none, because this package only wraps A01's commands
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (image listing clean; non-root; read-only rootfs; secrets as files; loopback bind; no build tools in the runtime stage)
- [ ] Accessibility result: not applicable, because no UI ships
- [ ] Performance measurement recorded: cold `up` to `/readyz` wall time on the CI runner (budget < 5 min); image size in MB (no budget; recorded for O02)
- [ ] Caveat text: not applicable, because no UI strings ship
- [ ] `npm run guard` green
- [ ] `npm run build`: run inside the Docker build; the repo mirror unchanged (`git diff --exit-code skill/assets/extensions`)
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: each runbook contains a dated "Exercised on <date> against <image tag>" line with the observed output (synthetic data only)

### 9. Acceptance commands

```sh
npm run guard
docker build -f deploy/Dockerfile -t backend-buddy:local .
docker run --rm --entrypoint sh backend-buddy:local -c 'find / -path /proc -prune -o -type f -print' | grep -E 'reference/|examples/|\.qa/|dist/backend-buddy\.html|\.png$'    # expected: no output
docker run --rm --entrypoint id backend-buddy:local                                                                   # uid=10001
cp deploy/.env.example deploy/.env && printf '%s' "$(openssl rand -hex 32 | head -c 32)" > /tmp/backend-buddy_master_key && printf 'devpass' > /tmp/backend-buddy_db_password
time docker compose -f deploy/compose.yml up -d --wait --wait-timeout 300                                    # < 5 min
curl -fsS http://127.0.0.1:8000/readyz                                                                      # 200
docker compose -f deploy/compose.yml run --rm api python -m app.bootstrap --email owner@example.test         # prints a one-time password once
docker compose -f deploy/compose.yml run --rm migrate alembic downgrade -1 && docker compose -f deploy/compose.yml run --rm migrate alembic upgrade head
docker compose -f deploy/compose.yml config | grep -E '127\.0\.0\.1:8000|read_only: true|service_completed_successfully|service_healthy'
grep -E 'PASSWORD=|MASTER_KEY=' deploy/compose.yml                                                          # expected: no output
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml config >/dev/null                             # overlay valid
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml config >/dev/null
docker compose -f deploy/compose.yml down -v
```

Package-specific assertions: the `compose-smoke` CI job runs the same sequence and uploads the `/readyz` timing as a job summary line; `rollback.md` contains the transcript of `alembic downgrade` followed by starting the previous image tag and `/readyz` returning 200.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include the image listing grep result and the `up` timing.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-08 master-key loss | `backup-and-restore.md` makes off-host encrypted key backup an explicit numbered step; medium is `risk-register.md` open question 3 (propose, do not decide). |
| RK-09 Windows vs Linux | Compose files and scripts are POSIX; Windows notes in `setup.md` only for Docker Desktop. |
| RK-14 sensitive values | Backups are labelled confidential in the runbook; no fixture with real data. |
| RK-18 read-only at session level | `deployment.md` instructs operators to create the read-only role from `ops/sql/roles.sql` for customer databases where applicable, and to use `verify-full`. |
| RK-23 CI has never run | `compose-smoke` is added only after `ci.yml` is green on `main`; the PR shows the run link. |
| RK-01 private data | Image listing check is part of acceptance and CI. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |


---

## ADDENDUM (product owner, 2026-09-08) — overrides anything above that conflicts

Sections most relevant to this work package: **A, B**. Read all of it; the
flow spans several packages and each must not contradict the others.

The connection experience is a first-class product flow, not an administrative detail.
A user running the product locally opens a Connections page, adds a connection, enters
credentials once, and the engine populates the schema and its statistics from there. The
reference deployment target is **Azure Database for PostgreSQL**, and the design must not
assume a database on the same host.

### A. Private and local targets are ALLOWED by default

The original instruction had `targets.py` deny loopback, link-local and cloud metadata
addresses unless `BB_ALLOW_PRIVATE_TARGETS` was set. That is correct for a hosted
multi-tenant service, where a user-supplied host is an untrusted server-side request. It
is **wrong for the self-hosted MVP**, where the user owns the machine and connecting to
`localhost` or a private VNet address is the normal case, and a default deny would make
the product appear broken.

Implement a deployment mode instead:

- `BB_DEPLOYMENT_MODE=self-hosted` (the default): any target the operator can reach is
  allowed. Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
  `169.254.170.2`) stay denied in every mode, because nothing legitimate profiles those
  and allowing them buys the user nothing.
- `BB_DEPLOYMENT_MODE=hosted`: the full deny-list applies, and only the connector-agent
  path may reach a private address. This mode is not exercised at MVP but the branch and
  its tests exist so the hosted edition is a configuration change, not a rewrite.

Document the reasoning where the setting is defined, so nobody "hardens" the default
later and breaks every local connection.

### B. TLS must work against Azure on the first try, without silently weakening

Azure enforces encryption in transit, and its hostnames look like
`<server>.postgres.database.azure.com`. Requirements:

- Offer `tls_mode` per connection: `verify-full` (default), `require`, `disable`.
  `disable` needs an explicit acknowledgement flag on the connection record.
- `verify-full` uses the system trust store, which already contains the DigiCert Global
  Root G2 that Azure chains to, so it should succeed unmodified. Allow an optional
  `ca_cert_pem` per connection for a private or rotated authority, written to a
  mode-0600 temporary file for the life of the connection and never logged.
- **Never silently downgrade.** If `verify-full` fails with a certificate or hostname
  error, the connection test must fail with an actionable message that names the cause
  and states that `require` encrypts without verifying identity, leaving the choice to
  the user. A tool that quietly falls back to an unverified channel is worse than one
  that fails.
- Set `sslmode` explicitly on every PostgreSQL connection. The current code sets
  `connect_timeout`, `options` and `autocommit` but leaves `sslmode` to libpq, whose
  default `prefer` will accept an unencrypted or unverified session without saying so.

Also handle the two Azure username shapes: Flexible Server takes a plain `user`, while
the legacy Single Server takes `user@servername`. Do not rewrite what the user typed;
if authentication fails and the host ends in `.postgres.database.azure.com` while the
username contains no `@`, say so in the error as a likely cause. A failed connection
must also distinguish a firewall rejection (timeout reaching the host) from a rejected
credential, because on Azure the first means an unconfigured firewall rule for the
client address and the second does not.

### C. A saved connection is stored configuration, not a held socket

"Stays connected" means the user enters credentials once and never again, not that a
socket stays open. Implement it as:

- The connection record persists: host, port, database, username, `tls_mode`, optional
  CA, and the envelope-encrypted password. `last_verified_at` and `last_error` are
  stored so the UI can show state without reconnecting.
- Every job opens a short-lived connection and closes it in a `finally`. A long-lived
  pooled connection to a customer database is a liability: it holds a server slot,
  survives credential rotation invisibly, and gives an idle process live read access.
- The UI shows `Verified 4 minutes ago`, never `Connected`, because the latter is a
  claim the product cannot make between jobs.
- Re-testing a connection is always available and is the only thing that updates
  `last_verified_at`.

### D. One guided flow, not four disconnected buttons

From the user's point of view adding a connection and seeing their schema is a single
action. Sequence it as one flow with visible progress and a resumable state per step:

1. **Add connection.** Host, port, database, username, password, TLS mode. Password is
   write-only from the moment it is submitted.
2. **Test.** A bounded round trip that authenticates and confirms catalog read access.
   Report a specific failure, not "connection failed".
3. **Populate structure.** Run `introspect()` and create the first snapshot. This is the
   step that makes the thirteen views show the user's own schema, so it is the moment the
   product becomes theirs. It reads catalog metadata only and touches no table rows.
4. **Populate statistics (optional, separate consent).** Profile selected tables for row
   counts and column statistics. This step reads rows, so it is never implicit: it is a
   distinct action with the scope, the caps, and the redaction policy stated on screen
   before it runs. Default to structure-only.

Steps 3 and 4 must be separately choosable, because the first is metadata and the second
touches data, and conflating them would take a decision away from the user that they are
entitled to make.

### E. What the user must do outside the product, and the product must tell them

Surface these in the Connections page as help text, since each is a common first failure:

- A dedicated read-only role, not an application user and not a superuser. The profiler
  asks the session to be read-only but cannot verify the credential lacks write grants.
- On Azure, a firewall rule permitting the client address, or private access configured.
- That column minimum and maximum values are real values from their tables and are part
  of a profile, and that sample values are separately opt-in and capped.


---

## ADDENDUM 2 (product owner, 2026-09-08) — deployment shape and container networking

Sections most relevant to this work package: **F, G**. Read all of it.

The product owner restated the target: **a local deployment that anyone can run**, where
the user adds their own database connections and sees their own data. Not a hosted
service. Two consequences, and the second is the most common reason a containerised
database tool appears broken on first use.

### F. Single-tenant local deployment is the shipping shape

`BB_DEPLOYMENT_MODE=self-hosted` is the default and the only mode exercised. The
workspace and role machinery stays, because it costs little and stored database
credentials must not be readable by an unauthenticated caller, but first run must be
trivial: one owner account created by a documented bootstrap command, no external
identity provider, no invitations, nothing to configure before the product is usable.
Optimise every decision for one person on one machine reaching their own databases.

### G. Connections are made from inside a container, so `localhost` is a trap

The API and worker run in a container. Inside it, `localhost` and `127.0.0.1` mean *the
container*, not the user's machine. A user who types `localhost` for a database running
on their host gets a connection refused that says nothing useful, and this is the single
most likely first-run failure. Handle all three topologies explicitly.

**1. A database on the user's own machine.** The container must reach the host. Add to
every service that opens database connections:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Docker Desktop on Windows and macOS resolves that name already; the mapping is what makes
it work on Linux, so include it unconditionally. Then, in `targets.py`, when the API is
running in a container and the user supplies `localhost`, `127.0.0.1`, or `::1`:

- Do not silently rewrite what they typed. Storing a host different from the one entered
  makes later failures inexplicable.
- Resolve and attempt `host.docker.internal` as a **documented fallback** when the literal
  host fails to connect, and on success report clearly that the host was reached through
  the container's host gateway and offer to save that instead.
- If both fail, the error must name the cause: the database is on the host but the API is
  in a container, and `host.docker.internal` is the address to use.

Detect containerisation rather than guessing: `BB_IN_CONTAINER=1` set by compose, with
the presence of `/.dockerenv` as a secondary signal. A test must cover both the detected
and undetected paths.

**2. A managed database such as Azure Database for PostgreSQL.** Outbound access works on
the default bridge network, so nothing in compose changes. What fails is the provider
firewall, and the message must say so: the rule must permit the **host machine's public
address**, not the container's private address, which the provider never sees. Distinguish
a firewall rejection, which presents as a connection timeout, from a rejected credential,
which returns promptly. Confirm DNS resolves inside the container before reporting a
network failure, so a broken resolver is not reported as a firewall problem.

**3. A database in another container.** Reaching it requires a shared Docker network and
the service or container name as the host. Document both the compose-level
`networks: [backend-buddy]` approach for a database defined in the same file, and
`docker network connect` for one from an unrelated project. This must be documentation,
not automation: joining another project's network on a user's behalf is not the product's
decision to make.

### H. First run shows an empty state, not sample data dressed as real data

The current build renders a synthetic fixture, and a user cannot tell from the interface
that what they are looking at is not their database. That is misleading, and it is the
specific complaint that produced this addendum.

- With no snapshot, the application opens on the Connections page with an empty state
  explaining that no database is connected yet. It does not open on sample data.
- The bundled fixture becomes an explicit, labelled action, something like "Explore a
  sample schema", and while a sample snapshot is loaded every view carries a persistent
  marker naming it as sample data. The marker is not dismissible.
- A snapshot records its origin, and the interface shows it: sample, uploaded file, or
  extracted from a named connection. A user must always be able to answer "whose data am
  I looking at" without leaving the page.
