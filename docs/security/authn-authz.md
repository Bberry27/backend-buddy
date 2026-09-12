Status: draft | Owner: Security lead | Last verified against code: A02 (2026-09-08)

# Authentication and authorization

How a request to the API is identified, what it is allowed to do, and what an operator has to do
once, by hand, before any of it works. The design decisions are in
[`ADR-0005`](../architecture/adr/ADR-0005-auth-and-credential-encryption.md); the trust boundaries
and the two Content Security Policies are in
[`security-architecture.md`](../architecture/security-architecture.md); the tables are in
[`data-model.md`](../architecture/data-model.md) sections 3.2-3.5 and 3.15. This document is the
operator's and reviewer's view of what work package A02 built.

## 1. Principals and credentials

Two credentials exist, and nothing else authenticates a request.

| Credential | Presented as | Identifies | CSRF | Revocation |
|---|---|---|---|---|
| Session | cookie `__Host-backend-buddy_session` | an account | required on every state-changing request | `POST /auth/logout`, `POST /auth/sessions/revoke-all`, idle and absolute expiry |
| API key | `Authorization: Bearer backend-buddy_<secret>` | an account **and** one workspace at one role | exempt (no ambient credential) | `DELETE /workspaces/{id}/api-keys/{key}`, optional `expires_at` |

A request that presents a bearer token never falls back to the cookie: an unusable key is an
unauthenticated request, even from a browser that also holds a valid session. Otherwise a revoked
key would keep working for anybody who happened to be logged in.

`users.is_active` is checked on every request, so deactivating an account takes effect at once
rather than when its sessions happen to expire, and it disables that account's API keys too.

## 2. The role matrix

Roles are per workspace, held in `workspace_members.role`, and ordered
`owner > admin > reviewer > viewer`. Two further declarations exist that are **not** roles and do
not extend the ladder:

- `public` -- no credential at all;
- `authenticated` -- any principal, with no workspace claim. Used by the routes that have no
  workspace to be a member of. A user who belongs to no workspace must still be able to see who
  they are, log out, and create their first workspace.

Every route declares one of the six, and the declaration *is* the enforcement: a route depends on
`app.auth.rbac.RoleRequirement`, and that same object performs the check.
`test_rbac_matrix` reads the declarations back out of the assembled application and fails on a
route that declares nothing, so an unguarded endpoint breaks the suite rather than shipping. The
same declarations are written into `services/api/openapi.json` as `x-backend-buddy-role`, so the matrix is
reviewable as a diff.

| Method | Route | Role |
|---|---|---|
| GET | `/healthz` | public |
| GET | `/readyz` | public |
| POST | `/auth/login` | public |
| GET | `/` and `/{spa_path:path}` (the served SPA) | public |
| POST | `/auth/logout` | authenticated |
| POST | `/auth/sessions/revoke-all` | authenticated |
| GET | `/auth/csrf` | authenticated |
| GET | `/users/me` | authenticated |
| GET | `/workspaces` | authenticated |
| POST | `/workspaces` | authenticated |
| GET | `/workspaces/{workspace_id}` | viewer |
| GET | `/workspaces/{workspace_id}/members` | viewer |
| POST | `/workspaces/{workspace_id}/members` | admin |
| PUT | `/workspaces/{workspace_id}/members/{user_id}` | admin |
| GET | `/workspaces/{workspace_id}/api-keys` | admin |
| POST | `/workspaces/{workspace_id}/api-keys` | admin |
| DELETE | `/workspaces/{workspace_id}/api-keys/{api_key_id}` | admin |

Three rules apply across the workspace-scoped routes:

1. **Nobody may grant a role at or above their own.** An admin can neither create an owner, nor
   change an owner's role, nor mint an owner API key. Without this, admin and owner are the same
   role with different names.
2. **A workspace always keeps an owner.** The change that would remove the last one answers 409:
   a workspace with no owner cannot grant a role again, so the operation would be irreversible
   through the API.
3. **An identifier from another workspace answers 404, never 403** (CTQ-07). A 403 would confirm
   that the identifier exists, which is the fact a cross-tenant probe is looking for. Insufficient
   *role* inside a workspace the caller can already see is a 403, because there the existence is
   not a secret.

A role change revokes the affected member's sessions. The role itself is read from
`workspace_members` on every request, so this is not what makes the new role take effect; it is
what stops the old session from continuing to act under a decision that has been reversed. When
the affected member is the caller, the caller's own session is rotated instead, so an owner who
edits their own membership is not logged out by their own click.

## 3. Passwords

- argon2id (`argon2-cffi`), cost parameters pinned in `app/auth/passwords.py`: 64 MiB, three
  passes, four lanes, 32-byte hash, 16-byte salt. Written down rather than inherited, so a
  dependency upgrade cannot lower the work factor silently.
- Minimum length 12 (`docs/reference/limits-and-caps.md` section B), maximum 1024 so a large body
  cannot turn one login into a memory-hard denial of service.
- A common-password deny list, plus structural rules that reject a single repeated character, a
  run of consecutive digits, a keyboard row, a short string repeated, and anything containing the
  account's own email address or display name.
- A rejection says which rule applied. A policy that answers "no" without saying why produces
  users who append `1` until it stops complaining.

**The deny list.** `app/auth/common-passwords.txt` ships with the package and is a *curated
subset*: the 12-character minimum already rejects the great majority of any published top-10k
list, so what has to be written down is the long entries that survive it plus the short base words
that the variant rules turn into long guesses. A password is also compared with its leet
substitutions undone and with leading and trailing non-letters stripped, so `password` in the file
also rejects `Password1234` and `p4ssword!!`.

A deployment that wants the full published list points `BB_PASSWORD_DENYLIST_FILE` at it (one
password per line, `#` comments allowed) and it is used **in addition** to the shipped file:

```sh
# In the image build or on the host, out of band:
curl -fsSL <top-10k list URL> -o /etc/backend-buddy/top10k.txt
export BB_PASSWORD_DENYLIST_FILE=/etc/backend-buddy/top10k.txt
```

The file is read once, at first use. A path that cannot be read fails loudly rather than quietly
weakening the policy.

**No lockout.** `users.failed_login_count` is incremented (in its own transaction, so a rejected
login cannot roll back the count of itself) and every failure is audited, but an account is never
locked automatically. On a single-tenant deployment whose owner account is the only way in, an
automatic lockout is a denial-of-service primitive handed to anybody who knows the address. The
control that slows an attacker down is the rate limit.

## 4. Sessions and cookies

The cookie carries a 256-bit opaque token and nothing else; everything that decides whether a
request is authenticated lives in the `sessions` row, which is what makes a session revocable.
Only the sha256 of the token is stored.

| Attribute | Value | Why |
|---|---|---|
| Name | `__Host-backend-buddy_session` | the prefix is a browser-enforced promise: `Secure`, `Path=/`, no `Domain` |
| `HttpOnly` | yes | no script can read the token |
| `Secure` | yes | forced on whenever `BB_PUBLIC_ORIGIN` is HTTPS, whatever `BB_COOKIE_SECURE` says |
| `SameSite` | `Strict` (see below) | the session is not sent on a cross-site navigation |
| `Path` | `/` | required by the `__Host-` prefix |
| Idle expiry | `BB_SESSION_IDLE_MINUTES`, default 60 | `last_seen_at` moves on every request, so an active reviewer is never logged out mid-review |
| Absolute expiry | `BB_SESSION_ABSOLUTE_HOURS`, default 12 | a forgotten browser is not still authenticated the next morning |

**`SameSite=Strict` is a recorded deviation.** `security-architecture.md` section 7 proposes
`Lax`; A02 ships `Strict` on instruction from the work-package owner, and it is a tightening. The
SPA is served from the same origin as the API and nothing at MVP depends on a session surviving a
cross-site top-level navigation: there is no OAuth callback, no email deep link into an
authenticated view, no payment return. `BB_COOKIE_SAMESITE=lax` restores the documented value
for a deployment that later needs it, so the change is one setting rather than a rewrite. The A02
report proposes the same edit to section 7.

**Development fallback.** A browser silently drops a `__Host-` cookie over plain HTTP, which would
make login look as though it did nothing. So when cookies are not `Secure`
(`BB_COOKIE_SECURE=false`, the dev overlay) the name falls back to `backend-buddy_session` and startup
logs a warning that names what is weaker. There is no configuration that produces a `__Host-`
name without `Secure`.

**Rotation.** A new row with a new token, and the old row revoked in the same transaction:

- **on login**, which makes session fixation impossible -- whatever token the browser arrived with
  is revoked, so a token planted before authentication cannot be authenticated afterwards;
- **on a role change**, as described in section 2.

**Revoke-all.** `POST /auth/sessions/revoke-all` revokes every session of the calling account,
including the one making the request, and clears its cookies. It is the control a user reaches for
when they think a device is compromised, so it does not spare the caller.

**A revocation is in force before its own response arrives.** The request's transaction is
committed by `UnitOfWorkMiddleware` when the status line is known and before it is forwarded,
rather than in a dependency teardown, which FastAPI runs *after* the response has been sent. The
window that closes is small and was real: a live run showed a revoked API key succeeding once more
after its own `200`. It matters most for exactly the three operations a user or an operator
performs *because* they no longer trust a credential -- logout, revoke-all, and key revocation.

## 5. CSRF

Double submit, bound to the session, plus an origin check. Two checks that fail differently:

1. **Origin.** `OriginGuardMiddleware` refuses a state-changing request whose `Origin` header is
   not this deployment's origin. It runs before any route is matched, so it also covers
   `POST /auth/login`, which has no session yet and therefore cannot be protected by a token --
   and a login form posted from another origin is a real attack, because it logs the victim in as
   the attacker. A request with no `Origin` passes this check; non-browser clients do not send one.
2. **Token.** The `X-CSRF-Token` header must hash to `sessions.csrf_token_hash`. The token is
   delivered in the login response body and in a readable (not `HttpOnly`) cookie
   `__Host-backend-buddy_csrf` with the same lifetime as the session cookie, so a reloaded SPA can echo it
   back.

`GET /auth/csrf` exists for one case: the readable cookie is gone but the session cookie is not.
It cannot return the stored token -- only the sha256 is stored -- so it *rotates* the token and
returns the new one. Two tabs calling it will invalidate each other's token, which is why the SPA
reads the cookie first and calls this only when there is none.

API-key requests are exempt: they carry no ambient credential, so there is nothing for another
site to ride on.

## 6. API-key lifecycle

1. **Create** -- `POST /workspaces/{id}/api-keys` with a name, a role at or below the caller's own,
   and an optional `expiresAt`. The response is the only place the secret ever appears:
   `apiKey` = `backend-buddy_` plus a 256-bit URL-safe secret. Store it now; there is no second chance.
2. **Stored** -- `key_prefix` (the first eight characters, an identifier used in the UI and in
   audit rows) and `key_hash` (sha256). The secret itself is not recoverable from the database, by
   anybody, including the operator.
3. **Use** -- `Authorization: Bearer backend-buddy_...`. The key acts in the workspace and at the role
   recorded on its row, never wider, whatever else its owner may be a member of. That is what
   makes a key safe to give to a script. `last_used_at` is updated on every request, so an owner
   can tell whether a key is still in use before revoking it.
4. **Revoke** -- `DELETE /workspaces/{id}/api-keys/{key}` sets `revoked_at`. The row is never
   deleted: it is the audit reference for `api_key.revoke`.
5. **Expire** -- `expires_at`, when set, makes the key unusable without an action from anybody.

Both create and revoke are audited. Key creation is rate limited
(`BB_RATE_LIMIT_API_KEY`, default `20/hour` per client address).

## 7. Rate limits

| Route | Setting | Default |
|---|---|---|
| `POST /auth/login` | `BB_RATE_LIMIT_LOGIN` | `10/minute` per client address |
| `POST /workspaces/{id}/api-keys` | `BB_RATE_LIMIT_API_KEY` | `20/hour` per client address |

The key is the caller's address, taken from `X-Forwarded-For` **only** when the request came from
a network in `BB_TRUSTED_PROXY_CIDRS` and from the socket peer otherwise. A limit keyed on a
header any client can set is worse than no limit, because it looks like one.

Storage is in-process, which is honest for the single-API-container deployment
(`deployment-architecture.md` section 1). Scaling the API out would make each limit per instance
and would need a shared backend.

The limit is a brake, not the control: every failed login is audited whether or not the limit
fires, so an attack that stays underneath it is still visible.

## 8. The audit trail

`app.audit.record()` writes `audit_events` (insert-only, enforced by an A01 trigger and by
`ops/sql/roles.sql`) with three properties worth knowing:

- **Its own transaction.** A rejected login rolls the request back; an audit trail that recorded
  only the requests that succeeded would look complete and be wrong.
- **A closed vocabulary.** An action outside the list in `data-model.md` 3.15 raises, so a typo is
  a test failure rather than a silent hole (a query for `login.failure` would not find
  `login.faliure`).
- **Redacted details.** `details` passes through the log redaction before it is stored, so a
  caller that hands over a whole request body cannot put a password or a DSN in the database.

Actions A02 writes: `login.success`, `login.failure`, `logout`, `session.revoke_all`,
`api_key.create`, `api_key.revoke`, `member.role_change`, `workspace.create`,
`workspace.bootstrap`. Adding a member is recorded as `member.role_change` from `null`, because
that is exactly what changed and the document defines no separate action.

`request_id` joins a row to the structured log line. Every response carries the same id in
`X-Request-Id`, and every error body repeats it, so a user can quote it and an operator can grep
for it.

## 9. Bootstrap: the one manual step

A fresh deployment has no account and there is no self-service sign-up. Run once, after `migrate`
and before anybody tries to sign in:

```sh
docker compose run --rm api python -m app.bootstrap \
  --email owner@example.test \
  --workspace-slug default \
  --workspace-name "Default workspace"
```

It creates the workspace, the owner account and the `encryption_keys` registry row, prints a
generated password **once** to stdout, and refuses to run again once any account exists -- a
bootstrap that could run twice would be an unauthenticated password reset for the only account
that can do anything.

The password is printed with `print`, not through the logger: the logger would redact it, and a
credential does not belong in a log stream that gets shipped to a collector. Copy it into a
password manager immediately. There is no recovery path: if it is lost, restore from a backup.

Exit codes: `0` created, `2` refused or misconfigured (the message says which).

**Which component registers the master key.** Bootstrap does. It is the one step that already
reads the master key and runs before anything else (this settles A02 brief open question 3). A03's
first connection write may create the row if bootstrap never ran. `GET /readyz` therefore treats
an **empty** registry as ready -- a fresh `docker compose up` has to reach `/readyz` 200 within
five minutes (CTQ-15), before any human has run bootstrap -- and a **mismatching** registry as not
ready.

## 10. Health and readiness

- `GET /healthz` -- the process is alive. Touches no database, no secret and no file, so it stays
  green while a dependency is down; otherwise Docker restarts a healthy API because PostgreSQL is
  being upgraded.
- `GET /readyz` -- the metadata store answers, Alembic is at the head revision this image ships,
  and the master key matches the fingerprint in `encryption_keys`. Not ready is 503, with a
  redacted reason: it says *that* the fingerprint differs, never either value. This is the RK-08
  mitigation -- a restored database plus the wrong key file is otherwise discovered much later, by
  a decryption failure on one connection.

## 11. What an operator must do outside the product

1. Provide the two secret files (`BB_DB_PASSWORD_FILE`, `BB_MASTER_KEY_FILE`). The master key
   is 32 random bytes, or 64 hexadecimal characters -- `openssl rand -hex 32 > backend-buddy_master_key` --
   and startup fails if it is missing or the wrong length.
2. **Back the master key up, off host, encrypted.** Without it, the connection secrets in a
   restored database are unusable and every connection has to be entered again.
3. Terminate TLS at a reverse proxy and set `BB_PUBLIC_ORIGIN=https://...`. That switch decides
   the cookie's `Secure` attribute, the CSRF origin check and HSTS.
4. Narrow `BB_TRUSTED_PROXY_CIDRS` to the proxy if the API is reachable from anywhere but the
   compose network.
5. Run `python -m app.bootstrap` once (section 9), then keep the password in a password manager.

## 12. Known gaps at A02

Each of these is scoped out of A02 deliberately, and each needs an audit action that
`data-model.md` 3.15 does not yet define, so closing them is a documented change and not a
drive-by:

1. **No account creation beyond the first owner.** `POST /workspaces/{id}/members` grants a role to
   an account that already exists. An invitation flow (or an operator CLI) plus a `user.create`
   audit action is needed for a multi-user deployment. Owner: Security lead, by G2.
2. **No password change or reset route.** The hash is re-computed opportunistically at login when
   the cost parameters have moved, which is not the same thing. Needs `user.password_change` in
   the vocabulary. Owner: Security lead, by G2.
3. **No member removal.** A role can be lowered to `viewer`; the membership row cannot be deleted.
   Needs `member.remove`. Owner: Security lead, by G2.
4. **No session listing.** A user can revoke all sessions but cannot see them. `sessions` carries
   `user_agent` and `ip` for exactly this. Owner: Security lead, post-MVP.
5. **No expired-session purge.** `sessions.expires_at` is indexed and the rows are harmless once
   expired, but nothing deletes them yet; the purge job is A04's.

## 13. Verification

| Property | Test |
|---|---|
| Every route declares a role | `test_rbac_matrix` |
| Cross-workspace ids answer 404 | `test_A02_idor_returns_404` |
| Cookie flags and CSRF | `test_A02_cookie_flags_and_csrf` |
| Security headers and the strict SPA CSP | `test_A02_security_headers`, `test_A02_spa_csp_matches_the_architecture_document` |
| No response schema can carry a secret | `test_A02_no_secret_fields_in_responses` |
| Audit rows for every auth event | `test_A02_audit_rows_for_auth_events` |
| Log redaction | `test_A02_log_redaction` |
| Unknown `BB_*` fails startup | `test_A02_settings_reject_unknown` |
| Master-key mismatch fails readiness | `test_A02_readyz_master_key_mismatch` |
| Bootstrap runs once | `test_A02_bootstrap_once` |
| Password policy | `test_A02_password_minimum_length_is_twelve`, `test_A02_password_denylist_rejects_common_passwords` |

Run them with a PostgreSQL 16 available:

```sh
export BB_TEST_DATABASE_URL=postgresql://backend-buddy:backend-buddy@127.0.0.1:55432/backend-buddy_test
python -m unittest discover -s services/api/tests -p 'test_A0[12]_*.py'
```

## 14. Change log

| Date | WP | Change |
|---|---|---|
| 2026-09-08 | A02 | Created with the API foundation: accounts, sessions, CSRF, RBAC, API keys, audit, health and readiness, bootstrap. |
