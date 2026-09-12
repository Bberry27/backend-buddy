Status: draft | Owner: Security lead | Last verified against code: pre-repo (2026-09-07)

# WP-A02 API foundation

| Field | Value |
|---|---|
| Work package | A02 (track A, phase 2) |
| Features | F20 (primary); F16 (workspaces skeleton used by A04) |
| CTQs | CTQ-07, CTQ-16 (CTQ-15 `/healthz` `/readyz` endpoints consumed by O01) |
| Caveats | C13, C14 (server-side wording in API error and audit messages comes from `docs/reference/caveats.md`; the API has no `caveat-strings.ts` mirror at MVP, see open question 1) |
| Depends on | A01 |
| Blocks | A04 |
| Branch | `a02/api-foundation` |
| Gate | G2 |

### 1. Goal

Stand up the FastAPI application in `services/api/app`: pydantic-settings configuration (`BB_*`, `*_FILE` secrets, unknown variables fail startup), structlog JSON logging with request id and a redaction processor, local accounts (argon2id, minimum length 12, top-10k deny list), database-backed sessions with a `__Host-` cookie (dev fallback with a startup warning), CSRF double-submit, RBAC `require_role` (owner/admin/reviewer/viewer), API keys, session rotation on login and role change, revoke-all, an audit service, security headers plus the strict SPA CSP for the served SPA, `/healthz` and `/readyz`, slowapi rate limits, `python -m app.bootstrap` for the first owner, and an RBAC matrix test that fails on any undeclared route. A verifier can check `test_rbac_matrix`, the cookie flags, the redaction test, and that no response ever contains a secret field.

### 2. Reading list (ordered)

1. `docs/features/F20-auth-and-workspaces.md` (D05): B-numbered behaviours for accounts, sessions, roles, API keys; section 10 security requirements; section 8 acceptance criteria tagged CTQ-07/16.
2. `docs/architecture/security-architecture.md`: sections 2 (principals and trust boundaries), 3 (threats per component), 5 finding 7 (the platform-wide absence this package closes), 6.2 (strict SPA CSP text and the additional headers), 7 (cookie name and flags, CSRF, rotation, password policy), 9 (redaction), 10 (open questions 1-2 that A02 must not decide alone).
3. `docs/architecture/data-model.md` 3.2 `users`, 3.3 `workspace_members`, 3.4 `sessions`, 3.5 `api_keys`, 3.15 `audit_events` (action names list is the audit vocabulary).
4. `docs/architecture/deployment-architecture.md` section 4 (environment contract names and defaults; `BB_PUBLIC_ORIGIN`, `BB_COOKIE_SECURE`, `BB_SESSION_*`, `BB_RATE_LIMIT_LOGIN`), 5 (proxy headers trusted only from the compose network), 6 (`/healthz`, `/readyz` semantics including master-key fingerprint check).
5. `docs/architecture/adr/ADR-0003-backend-fastapi-and-contract-oracle.md`, `ADR-0005-auth-and-credential-encryption.md`, `ADR-0006-deployment-topology-and-artifact-csp.md`.
6. `docs/product-management/ctq.md` CTQ-07 and CTQ-16 rows (test names `test_rbac_matrix`, `test_A02_idor_returns_404`, `test_A02_audit_rows_for_auth_events`, `test_A02_log_redaction`).
7. A01 deliverables: `services/api/app/models/**`, `db.py`, migration `0001`.
8. Legacy pattern to keep for error hygiene: `packages/explorer/server/serve_explorer.py:109-111` (fixed error strings so DSNs and sample values never leak into responses) and `:79` (`hmac.compare_digest` for token comparison).
9. `docs/reference/limits-and-caps.md` B (password minimum 12, top-10k deny list).
10. `docs/engineering/security-policy.md` (checklist), `standards.md`, `testing-policy.md` (D03).

### 3. In scope

- `app/core/settings.py` (pydantic-settings; `extra='forbid'` for `BB_*`; `*_FILE` readers for `BB_DB_PASSWORD_FILE`, `BB_MASTER_KEY_FILE`; startup fails if the master key file is missing or not 32 bytes).
- `app/core/logging.py`: structlog JSON to stdout, request id middleware (`X-Request-Id` honoured from the proxy only when trusted), redaction processor for DSNs, passwords, tokens, cookies, `Authorization`, and any key named like `secret|password|dsn|token|sample`.
- `app/auth/`: argon2id hashing (`argon2-cffi`), password policy (length >= 12; deny list file shipped in the package, top-10k), login/logout, sessions table use (`token_hash` sha256, idle and absolute expiry, `last_seen_at`), cookie `__Host-backend-buddy_session` `Secure; HttpOnly; SameSite=Lax; Path=/` with the dev fallback name over plain HTTP and a startup warning, session rotation on login and on role change, `POST /auth/sessions/revoke-all`, CSRF double-submit bound to the session (`sessions.csrf_token_hash`), required on every state-changing request; API-key auth (`Authorization: Bearer`, `key_hash`, shown once, `expires_at`/`revoked_at`) exempt from CSRF.
- `app/auth/rbac.py`: `require_role(minimum)` dependency over `workspace_members.role` in `owner > admin > reviewer > viewer`; every route declares its role or `public`; `test_rbac_matrix` walks `app.routes` and fails on an undeclared route.
- `app/audit.py`: `record(action, actor, target, details)` writing `audit_events` with redacted `details`; actions for this package: `login.success`, `login.failure`, `logout`, `session.revoke_all`, `api_key.create`, `api_key.revoke`, `member.role_change`, `workspace.*`.
- Routers: `/auth/*`, `/workspaces` (create, list, members with roles), `/users/me`, `/api-keys`; IDOR negatives return 404 (never 403) for cross-workspace ids.
- Security headers middleware and the strict SPA CSP from `security-architecture.md` 6.2 on the SPA routes; `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, minimal `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, HSTS when `BB_PUBLIC_ORIGIN` is https; static serving of `packages/web/dist` with hashed assets.
- `GET /healthz` (process alive) and `GET /readyz` (database reachable, Alembic at head, master-key fingerprint matches `encryption_keys`).
- slowapi rate limits on login and API-key creation (`BB_RATE_LIMIT_LOGIN`; value to be decided, proposal in the PR).
- `python -m app.bootstrap`: creates the first owner with a one-time password printed once, refuses to run when a user exists; audited.
- OpenAPI document exported to `services/api/openapi.json` (checked in; W01 generates client types from it; drift check in O02).
- Tests: `test_A02_auth.py`, `test_A02_rbac_matrix.py` (`test_rbac_matrix`), `test_A02_idor_returns_404`, `test_A02_cookie_flags_and_csrf`, `test_A02_audit_rows_for_auth_events`, `test_A02_log_redaction`, `test_A02_settings_reject_unknown`, `test_A02_readyz_master_key_mismatch`, `test_A02_bootstrap_once`.
- `docs/security/authn-authz.md` (new, per the plan's key files): roles matrix, cookie and CSRF model, API-key lifecycle, bootstrap procedure; status header per docs rules.
- F20 sections 3 and 14; F16 section 14 row.

### 4. Out of scope

- Connections CRUD, envelope encryption implementation (A03), although the master-key fingerprint check in `/readyz` uses the `encryption_keys` row created by A03's first run or by bootstrap (decide and document which; open question 3).
- Jobs, worker, snapshots, reviews, preferences, ERD layouts routers (A04).
- OIDC/SAML, multi-tenant billing (L-08).
- Metrics endpoint and backup scripts (O03); this package only ships `/healthz` and `/readyz`.
- Docker image and compose (O01).
- The SPA itself (W01); A02 serves whatever `packages/web/dist` contains.
- Deciding `security-architecture.md` open questions 1 (API holding a decrypted secret) and 2 (`style-src 'unsafe-inline'`): implement the documented proposal and flag both in the report.

### 5. May modify

```
services/api/app/main.py
services/api/app/core/**
services/api/app/auth/**
services/api/app/audit.py
services/api/app/routers/{auth,workspaces,users,api_keys,health}.py
services/api/app/bootstrap.py
services/api/app/repositories/**             (workspace-scoped query helpers for users, members, sessions, api keys)
services/api/app/static.py                    (SPA serving with headers)
services/api/openapi.json                     (generated by `python -m app.export_openapi`; never hand-edited)
services/api/app/export_openapi.py
services/api/requirements*.txt                (fastapi, uvicorn, argon2-cffi, structlog, slowapi, pydantic-settings, cryptography for fingerprint only)
services/api/tests/test_A02_*.py
services/api/tests/helpers/**
docs/security/authn-authz.md
docs/features/F20-auth-and-workspaces.md      (sections 3 and 14 only)
docs/features/F16-projects-and-snapshots.md   (section 14 only)
CHANGELOG.md                                  ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no Node dependency change
packages/**                             W and C tracks; the profiler move is A03
services/api/alembic/**                 A01 owns 0001; a schema change needs a new revision in an A-track PR with owner approval (none expected)
services/api/app/models/**              A01 (a needed column is an open question, not an edit)
services/api/app/{crypto,routers/connections.py}   A03
services/api/app/{worker,routers/{jobs,snapshots,projects,reviews,preferences,layouts,exports}.py}   A04
skill/**                                S01, S03
docs/reference/caveats.md               frozen at G0
docs/architecture/security-architecture.md   D02; propose changes in the report
.github/workflows/**                    R00, S02, O01, O02, Q05 only
deploy/**                               O01
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Cookie `__Host-backend-buddy_session` with `Secure; HttpOnly; SameSite=Lax; Path=/`; dev fallback only over plain HTTP with a warning | `security-architecture.md` 7 | `test_A02_cookie_flags_and_csrf`; `tests/security/cookies-csrf.spec.ts` (Q02) |
| CSRF double-submit on every state-changing cookie request; API keys exempt | `security-architecture.md` 7 | `test_A02_cookie_flags_and_csrf` |
| RBAC roles `owner > admin > reviewer > viewer`; every route declares a role; undeclared route fails the matrix test | D5; CTQ-07 | `test_rbac_matrix` |
| IDOR negatives return 404 | CTQ-07 | `test_A02_idor_returns_404` |
| Secrets never in responses or logs: no `password`, `dsn`, `token`, `encrypted_secret`, `key_id` in any response schema; redaction processor active | `security-architecture.md` 4, 9 | `test_A02_log_redaction`; A03's `test_A03_connections_response_has_no_secret_fields` |
| Strict SPA CSP text exactly as `security-architecture.md` 6.2; never loosened to fix a library | RK-04 | `test_A02_security_headers`; `tests/e2e/csp.spec.ts` (W01) |
| Audit vocabulary and insert-only semantics; every auth event in the CTQ-16 list writes a row | `data-model.md` 3.15; CTQ-16 | `test_A02_audit_rows_for_auth_events` |
| Password policy: argon2id, minimum 12, top-10k deny list | `limits-and-caps.md` B | `test_A02_auth` |
| Environment contract names and defaults from `deployment-architecture.md` 4; unknown `BB_*` fails startup | `deployment-architecture.md` 4 | `test_A02_settings_reject_unknown` |
| `/healthz` and `/readyz` semantics (db reachable, migrations at head, master-key fingerprint matches) | `deployment-architecture.md` 6 | `test_A02_readyz_master_key_mismatch` |
| Error hygiene: fixed client-facing strings; details only in redacted logs | `serve_explorer.py:109-111` pattern; RK-21 | `test_A02_log_redaction` |
| Tenant scoping: every repository helper takes `workspace_id` | `data-model.md` 4 | `test_A01_tenant_scoping` (A01) keeps running over new helpers |
| Migration set unchanged (no new Alembic revision in A02) | A01 | `alembic history` shows one revision |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `A02`/CTQ ids, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F20; F16 section 14 row)
- [ ] Migration: none, because A01's `0001` already contains every table this package uses (state the check: `alembic history` unchanged)
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist from `docs/engineering/security-policy.md` completed in full (this package is the security foundation; attach the matrix test output)
- [ ] Accessibility result: not applicable, because no UI ships (the SPA is W01)
- [ ] Performance measurement recorded: `/readyz` latency and login p95 on a local run (no budget exists; numbers feed Q01)
- [ ] Caveat text: server-side messages that carry C13 or C14 wording are quoted verbatim from `docs/reference/caveats.md` (open question 1 on a Python mirror)
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable, because `packages/explorer` is unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `services/api/openapi.json` regenerated and committed; `python -m app.export_openapi --check` exits 0

### 9. Acceptance commands

```sh
npm run guard
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt
export BB_TEST_DATABASE_URL=postgresql://backend-buddy:backend-buddy@localhost:5432/backend-buddy_test
cd services/api && alembic upgrade head && cd ../..
python -m unittest discover -s services/api/tests -p 'test_A0[12]_*.py'    # A01 tests still green; A02 tests green; 0 skipped
python -m app.export_openapi --check                                         # run from services/api; exit 0
python -m coverage run -m unittest discover -s services/api/tests && python -m coverage report --fail-under=95 --include='services/api/app/auth/*'   # CTQ-12 auth >= 95 %
pip-audit -r services/api/requirements.txt                                   # 0 high/critical
curl -fsS -D - http://127.0.0.1:8000/healthz -o /dev/null | grep -i -E 'content-security-policy|x-content-type-options|referrer-policy'   # headers present on a local run
```

Package-specific assertions: `test_rbac_matrix` output lists every route with its declared role; a login response sets exactly one cookie whose attributes match the frozen contract; a failed login writes `login.failure` with no password in `details`; the log capture in `test_A02_log_redaction` contains `[REDACTED]` where a DSN was logged.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include the RBAC matrix table (route, method, role) from the test output.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-04 strict SPA CSP | The header is emitted exactly as documented; the W01 e2e is the arbiter; no `unsafe-eval` or wildcard ever. |
| RK-08 master-key loss | `/readyz` reports a fingerprint mismatch with a redacted reason; operator docs (O01) cover backup. |
| RK-18 read-only at session level only | Not this package's scope; A02 makes the connection-registering routes admin-only via RBAC so A03 can rely on it. |
| RK-21 no forensics | Structured logs with request id; audit rows for every auth event; fixed client-facing error strings. |
| RK-10 scope creep | Connections, jobs, and snapshots routers are refused; OIDC is L-08. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |


---

## ADDENDUM (product owner, 2026-09-08) — overrides anything above that conflicts

Sections most relevant to this work package: **D**. Read all of it; the
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
