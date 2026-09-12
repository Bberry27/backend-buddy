Status: draft | Owner: Security lead | Last verified against code: A02 (2026-09-08)

# F20 Auth and workspaces

| Field | Value |
|---|---|
| Status | partial (API landed with A02; the SPA screens are W01) |
| Owner | Security lead |
| Surfaces | API `/auth/*`, `/users/me`, `/workspaces`, `/workspaces/{id}/members`, `/workspaces/{id}/api-keys`, `/healthz`, `/readyz`; SPA `/login`, `/w/:ws` (W01) |
| CTQs | CTQ-07, CTQ-16 (CTQ-15 for `/healthz` and `/readyz`) |
| Caveats | C13, C14 |
| Last verified | A02 (2026-09-08) |

## 1. Purpose

F20 answers "who is asking, and what may they see" for everything else the platform does. It
turns a single-user local tool into something a team can share without sharing one credential: an
account, a session, a role per workspace, and an audit row for every decision that changes who can
do what. It must not be mistaken for an identity provider (there is no OIDC or SAML at MVP, see
L-08), for a user directory (there is no way to list or search accounts), or for a permission
system finer than the workspace: a role is held in a workspace, not on a project or a snapshot.

## 2. Driver

- **Persona**: P6 licensee security reviewer, and P5 engineering manager. P1-P4 meet this feature
  once, at the login screen, and should never think about it again.
- **Job to be done**: "Before I let this near our schema metadata, show me that only the people I
  named can see it, that I can take access away, and that I can tell afterwards who did what."
- **Business metric**: security review passed without a blocking finding (`docs/business/
  business-case.md`); a licensee's security questionnaire is the gate this feature exists to clear.

## 3. Current state

Landed with work package A02 (2026-09-08). The API is complete for its own scope; no UI ships.

**Accounts** (`services/api/app/auth/passwords.py`, `users.py`): local accounts with argon2id
hashes (cost parameters pinned at `passwords.py:_TIME_COST` and following), minimum length 12, a
maximum of 1024, a shipped common-password deny list (`app/auth/common-passwords.txt`, extended by
`BB_PASSWORD_DENYLIST_FILE`), structural rules, and a rule against the account's own address.
`users.failed_login_count` is incremented in its own transaction so a rejected login cannot roll
back the count of itself. There is no lockout, deliberately (`docs/security/authn-authz.md`
section 3), and no route creates an account: `python -m app.bootstrap` creates the first owner and
refuses to run twice.

**Sessions** (`app/auth/sessions.py`, `cookies.py`): server-side rows with only a sha256 of the
token stored; cookie `__Host-backend-buddy_session` with `Secure; HttpOnly; SameSite=Strict; Path=/`, and a
non-prefixed fallback name plus a startup warning when cookies are not `Secure`; idle expiry
(default 60 minutes) and absolute expiry (default 12 hours); rotation on login and on a role
change; `POST /auth/sessions/revoke-all`.

**CSRF** (`app/auth/csrf.py`, `app/core/http.py`): double submit bound to
`sessions.csrf_token_hash`, delivered in the login response and in a readable
`__Host-backend-buddy_csrf` cookie, required on every state-changing cookie request; plus an origin check
in middleware that also covers `POST /auth/login`. API keys are exempt.

**RBAC** (`app/auth/rbac.py`): `owner > admin > reviewer > viewer` read from
`workspace_members.role` on every request, plus the two non-role declarations `public` and
`authenticated`. The declaration is the enforcement, and `test_rbac_matrix` fails on an undeclared
route. Cross-workspace identifiers answer 404. Nobody may grant a role at or above their own; a
workspace keeps at least one owner.

**API keys** (`app/auth/api_keys.py`, `app/repositories/api_keys.py`): `backend-buddy_`-prefixed 256-bit
secrets, shown once, stored as a prefix plus a sha256, scoped to one workspace at one role,
expiring and revocable, `last_used_at` recorded.

**Audit** (`app/audit.py`): a closed vocabulary checked against `data-model.md` 3.15, rows written
in their own transaction so a failure survives its own rollback, `details` redacted before
storage.

**Configuration** (`app/core/settings.py`): the whole `BB_*` contract from
`deployment-architecture.md` section 4, with an unknown `BB_*` variable failing startup and the
master key read from a file and checked for length at startup.

**Logging** (`app/core/logging.py`): structlog JSON on stdout for every line, including uvicorn's
own; a request id per request, honoured from a proxy only when the peer is trusted and echoed in
`X-Request-Id`; a redaction processor covering DSNs, passwords, tokens, bearer headers and sample
values, applied after the traceback is rendered so an exception message cannot smuggle a DSN out.

**Errors** (`app/core/errors.py`): every failure answers with one of a fixed set of strings plus
the request id. FastAPI's own validation handler is replaced, because the default echoes the
rejected input -- which for a login body is the password.

**Health** (`app/routers/health.py`): `/healthz` touches nothing; `/readyz` checks the store, the
Alembic head and the master-key fingerprint, and answers 503 with a redacted reason.

**The request transaction** (`app/core/database.py`): one transaction per request, opened and
committed by `UnitOfWorkMiddleware` **before the response is forwarded**, not in a dependency
teardown. The distinction is not academic: teardown runs after the response is sent, so a live
`uvicorn` run showed a revoked API key working once more after its own 200 came back. A test
client cannot see it -- it completes teardown before handing back the response -- so
`test_A02_transactions.py` drives the raw ASGI application and reads the database from another
connection inside the `http.response.start` hook.

Not built, and not started: the SPA login and workspace screens (W01), account creation beyond the
first owner, password change and reset, member removal, session listing, and the expired-session
purge (`docs/security/authn-authz.md` section 12).

## 4. Intended behaviour

### MVP

- **B1** A person signs in with an email address and a password and receives a session; the
  response says who they are, which workspaces they may open, and with what role.
- **B2** A wrong password, an unknown address and a disabled account are indistinguishable in the
  response, except that a *correct* password for a disabled account is told the account is
  disabled.
- **B3** A session expires after inactivity and after an absolute lifetime, and can be ended by
  the user, everywhere at once.
- **B4** A session is rotated on login, so a token planted before authentication is useless.
- **B5** Every state-changing cookie request carries a CSRF token bound to that session; a request
  from another origin is refused whether or not it carries one.
- **B6** Every route declares a minimum role, and an undeclared route fails the test suite.
- **B7** An identifier belonging to another workspace is indistinguishable from one that does not
  exist.
- **B8** An owner or admin grants roles at or below their own, and cannot remove the last owner.
- **B9** A role change stops the affected member's existing sessions from acting under the old
  role.
- **B10** An admin creates an API key scoped to one workspace at one role, sees its secret exactly
  once, and can revoke it or give it an expiry.
- **B11** Every event in B1-B10 writes an audit row with an actor, a target and a request id, and
  the row survives a failed request.
- **B12** No response, log line or audit row contains a password, a token, a hash or a DSN.
- **B13** The password policy is advertised (`GET /users/me`) so a client can state the rules
  before a user types.
- **B14** An operator creates the first owner once, from the command line, and the command refuses
  to run again.
- **B15** A client that acts on a success response sees the effect of it: the request's transaction
  is committed before the response is forwarded, so a revocation, a logout or a role change is in
  force by the time its own 200 arrives.

### Later

- **B20** Invitation-based account creation, password change and reset (L-01; needs the
  `user.*` audit actions).
- **B21** Member removal, session listing and per-session revocation (L-01).
- **B22** OIDC and SAML as an identity source, keeping this session model (L-08).
- **B23** Row-level security in PostgreSQL rather than query-level tenant scoping (L-08).

## 5. Drill-through contract

Not applicable: F20 registers no view and emits no `Selection`. Two obligations towards the
drill-through contract exist and are W01's to honour:

- **Inbound**: the SPA resolves `/w/:ws` from `workspaces.slug` to the workspace id used by the
  API, through `GET /workspaces`.
- **Outbound**: a 401 from any route sends the SPA to `/login` with the attempted route
  remembered; a 404 from a workspace-scoped route is presented as "not found", never as
  "forbidden", so the UI does not undo the IDOR rule the API enforces.

### URL state

None. Session state lives in a cookie; the workspace and project segments are F14's and F16's.

## 6. Data contract dependencies

None: F20 reads no SchemaGraph field and uses no `LiveConnection` method. It depends on the
metadata model instead -- `users`, `workspace_members`, `sessions`, `api_keys`, `audit_events`,
and `encryption_keys` for the readiness fingerprint (`data-model.md` 3.2-3.5, 3.9, 3.15) -- and on
the environment contract in `deployment-architecture.md` section 4.

## 7. Caveats

> C13: "Browser storage holds convenience state only: theme, layouts, camera, and local decisions.
> It is not a team review database. Every stored key is scoped by the project's stable key (and,
> where the data depends on the schema, by the snapshot fingerprint) so that different projects and
> environments never read or overwrite each other's state."
>
> Shown: W01's workspace switcher, beside any local state that survives a workspace change. F20's
> own contribution is the reason it matters -- once there are several accounts in a workspace, a
> decision kept in one browser is not the team's record. The canonical text is mirrored for the
> server in `services/api/app/core/caveats.py` and checked against `caveats.md` by
> `test_A02_caveats_quote_the_canonical_file`.

> C14: "The product never discovers or connects to a database implicitly, and never to production
> to make a view look populated. Live access uses only a connection the user explicitly selected,
> opened read-only with bounded queries, and a metadata request never authorizes scanning customer
> rows."
>
> Shown: quoted verbatim in the API's own OpenAPI description (`app/main.py` `DESCRIPTION`), which
> is the document a licensee's security reviewer reads first, and asserted by
> `test_A02_the_description_quotes_caveat_c14`. F20's part in it is authorization: connection
> registration is admin-only, so "explicitly selected" has an accountable principal behind it.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-07) Given an account with a role in a workspace, when it signs in with the
  right password, then the response is 200, sets exactly one session cookie with `Secure`,
  `HttpOnly`, `SameSite` and `Path=/`, and lists that workspace with that role.
- **AC2** (B2, CTQ-07) Given a wrong password and an unknown address, when each signs in, then the
  status, code and message are identical.
- **AC3** (B4, CTQ-07) Given a browser that already holds a session, when it signs in again, then
  the previous session row is revoked and the new cookie differs.
- **AC4** (B5, CTQ-07) Given a valid session, when a POST arrives without `X-CSRF-Token`, with a
  token from another session, or from another origin, then it is refused with 403.
- **AC5** (B6, CTQ-07) Given the assembled application, when the route table is walked, then every
  route declares one of the six declarations.
- **AC6** (B7, CTQ-07) Given a workspace the caller is not a member of, when any of its routes is
  called, then the answer is 404 and never 403.
- **AC7** (B8, CTQ-07) Given an admin, when they attempt to grant `owner`, then the answer is 403;
  and given the only owner, when they demote themselves, then the answer is 409.
- **AC8** (B9, CTQ-07) Given a member with a live session, when their role changes, then their next
  request is 401.
- **AC9** (B10, CTQ-07) Given an admin, when they create a key, then the secret appears in that one
  response and no other, and the stored row holds only a prefix and a digest.
- **AC10** (B11, CTQ-16) Given each of login, failed login, logout, revoke-all, key create, key
  revoke and role change, when it happens, then an `audit_events` row exists with the actor, the
  target and the request id.
- **AC11** (B12, CTQ-07) Given the OpenAPI document, when every response schema is walked, then no
  property name could carry a credential, except the four documented exceptions.
- **AC12** (B14, CTQ-07) Given a deployment with an account, when bootstrap runs, then it exits 2
  and changes nothing.
- **AC13** (CTQ-15) Given a migrated but un-bootstrapped deployment, when `/readyz` is called, then
  it answers 200; and given a master key that does not match the registry, then it answers 503
  with a reason that contains neither fingerprint.

## 9. Test expectations

Python `unittest` in `services/api/tests`, names prefixed `A02` (or the CTQ-registered name where
the registry fixes it: `test_rbac_matrix`). A real PostgreSQL 16 is required and is taken from
`BB_TEST_DATABASE_URL`; each test class gets its own throwaway database
(`tests/helpers/__init__.py`).

| File | Covers |
|---|---|
| `test_A02_settings.py` | the environment contract, unknown variables, the master-key file |
| `test_A02_auth.py` | the password policy, login, session lifetimes, revocation, API-key authentication, rate limits |
| `test_A02_cookies_csrf.py` | cookie flags, CSRF, origin resolution, the security headers, the SPA CSP |
| `test_A02_rbac_matrix.py` | `test_rbac_matrix`, the role ladder, IDOR negatives, workspace and member routes |
| `test_A02_audit.py` | the audit vocabulary and every auth event |
| `test_A02_logging.py` | redaction and the request id |
| `test_A02_health.py` | `/healthz`, `/readyz`, the master-key mismatch |
| `test_A02_bootstrap.py` | the one-time bootstrap |
| `test_A02_openapi.py` | no secret fields in responses, `x-backend-buddy-role`, document drift, the caveat mirror |
| `test_A02_static.py` | serving the SPA, path traversal, the fallback |
| `test_A02_transactions.py` | the commit happens before the response; a 4xx rolls the request back while the audit row and the failure counter survive |

No SchemaGraph fixture is used: F20 reads no graph. Coverage of `app/auth/**` is held at 95 %
(CTQ-12); the A02 run measured 98 %. Browser-level cookie and CSRF checks are Q02's
(`tests/security/cookies-csrf.spec.ts`), and the CSP-violation end-to-end across the thirteen
views is W01's.

## 10. Security and privacy

- **Accepted input**: an email address (bounded and pattern-checked without a DNS library), a
  password (bounded, never echoed), a workspace slug and name, a role from a closed set, a key
  name and expiry, and two identifiers in the path. Every request model forbids unknown fields.
- **Rendered from untrusted data**: nothing. F20 ships no UI; the SPA is W01's and renders through
  React escaping under the strict CSP.
- **Stored**: `users` (argon2id hash, no plaintext), `sessions` (sha256 of the token and of the
  CSRF token, plus a truncated user agent and an IP for audit), `api_keys` (prefix and sha256),
  `workspace_members`, `audit_events` (redacted details). No browser storage of its own.
- **Exported**: nothing. The only credential that ever leaves the server is a freshly minted API
  key, once, and the CSRF token, which is useless without the session cookie.
- **CTQ-07 checks that apply**: RBAC matrix complete, IDOR negatives 404, secrets absent from
  every response schema, cookie flags and CSRF, the strict SPA CSP, `pip-audit` clean.

## 11. Performance budget

No budget exists for F20 in `docs/reference/limits-and-caps.md`; the numbers below were measured
on a local run (single uvicorn worker, PostgreSQL 16 in Docker on the same host) and are recorded
for Q01 to baseline.

| Operation | Median | p95 |
|---|---|---|
| `GET /healthz` | 1.3 ms | 2.8 ms |
| `GET /readyz` | 10.2 ms | 15.4 ms |
| `POST /auth/login` | 58 ms | 76 ms |

Login is dominated by the argon2id verification (64 MiB, three passes), which is the intended
cost and applies equally to a wrong password and an unknown address. The caps F20 enforces itself:
password length 12-1024, user agent truncated to 256 characters, rate limits per client address.

## 12. Accessibility

Not applicable: no UI ships with A02. Two obligations pass to W01 and are recorded here so they
are not lost: the login form needs labelled fields, a programmatically associated error message
and a live region for the failure, and the password policy from `GET /users/me` should be stated
before submission rather than only after a rejection.

## 13. Open questions

1. Whether the API process may ever hold a decrypted connection secret (a synchronous
   `connection.test`) or all decryption is confined to the worker. Owner: Security lead, by G2.
   A02 implements neither; it holds no connection secret at all.
2. Whether `style-src 'unsafe-inline'` stays in the SPA CSP at MVP. Owner: Security lead, by G2.
   A02 emits the documented policy including it; `script-src` stays strict either way.
3. Whether `SameSite=Strict` (shipped) replaces the `Lax` in `security-architecture.md` section 7,
   or the document stands and the setting is flipped. Owner: Security lead, by G2.
4. How additional accounts are created: an invitation flow, or an operator CLI. Needs a
   `user.create` audit action in `data-model.md` 3.15. Owner: Security lead, by G2.
5. Whether the Python mirror of the caveat wording (`app/core/caveats.py`, two ids) should be
   *generated* from `caveats.md` the way `packages/explorer/src/caveat-strings.ts` is (C03),
   rather than hand-written and compared against it by a test. Owner: Product owner, by G2.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Application factory, middleware order, router mounting | `services/api/app/main.py` |
| Configuration (`BB_*`, secret files, deployment mode) | `services/api/app/core/settings.py` |
| Logging, request id, redaction | `services/api/app/core/logging.py` |
| Fixed client-facing errors | `services/api/app/core/errors.py` |
| Security headers, the two CSPs, the origin guard | `services/api/app/core/http.py` |
| Engine, the unit-of-work middleware, the separate transaction, readiness probes | `services/api/app/core/database.py` |
| Request and response models | `services/api/app/core/api_models.py`, `presenters.py` |
| Rate limits | `services/api/app/core/rate_limit.py` |
| Caveat mirror | `services/api/app/core/caveats.py` |
| Passwords and the deny list | `services/api/app/auth/passwords.py`, `app/auth/common-passwords.txt` |
| Tokens, sessions, cookies, CSRF | `services/api/app/auth/{tokens,sessions,cookies,csrf}.py` |
| Principal resolution, API-key authentication | `services/api/app/auth/{principals,api_keys}.py` |
| RBAC ladder and the route declarations | `services/api/app/auth/rbac.py` |
| Account queries (not tenant-scoped, and why) | `services/api/app/auth/users.py` |
| Workspace-scoped query helpers | `services/api/app/repositories/{workspaces,members,api_keys}.py` |
| Audit service and vocabulary | `services/api/app/audit.py` |
| Routers | `services/api/app/routers/{auth,users,workspaces,api_keys,health}.py` |
| Served SPA | `services/api/app/static.py` |
| First owner | `services/api/app/bootstrap.py` |
| OpenAPI export and drift check | `services/api/app/export_openapi.py`, `services/api/openapi.json` |
| Tests | `services/api/tests/test_A02_*.py`, `services/api/tests/helpers/` |
| Operator and reviewer documentation | `docs/security/authn-authz.md` |
| Planned | W01 (`/login`, `/w/:ws`), A03 (connections router, `crypto/`), A04 (jobs, snapshots, reviews), Q02 (STRIDE and the browser cookie/CSRF spec), O01 (compose, `.env.example`, TLS) |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-08 | - | A02 | Document created with the API foundation it describes (D05 had not written it; sections 1-13 are new, not appended). Accounts, sessions, CSRF, RBAC, API keys, audit, health and readiness, bootstrap, the served SPA, and the OpenAPI export all landed; 147 A02 tests, `app/auth/**` coverage 98 %. |
| 2026-09-08 | - | A02 | Two defects a test client cannot reach, both found by a live `uvicorn` run and both now pinned by tests: the request transaction committed in a dependency teardown, that is *after* the response, so a revoked key or an ended session worked once more (fixed by `UnitOfWorkMiddleware`); and `POST /workspaces/{id}/api-keys` answered 500 on its success path with the rate limiter enabled, because slowapi writes its headers into a `Response` parameter the handler did not declare. |
| 2026-09-08 | - | A02 | Recorded deviations: `SameSite=Strict` instead of the documented `Lax` (tightening, one setting away from the document); `authenticated` and `public` declared as non-role route declarations beside the four-role ladder; `BB_DEPLOYMENT_MODE` added for the product owner's addendum; `cryptography` deliberately not declared as a dependency (A02 needs only `hashlib`). |
