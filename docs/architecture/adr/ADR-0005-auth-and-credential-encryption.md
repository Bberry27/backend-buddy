Status: draft | Owner: Security lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0005: Local accounts, server-side sessions, RBAC, API keys, and envelope-encrypted connection secrets

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Security lead, Backend lead
- **Work packages**: A01, A02, A03, S03, Q02
- **Related**: ADR-0003, ADR-0006, `docs/architecture/security-architecture.md`, `docs/architecture/data-model.md`, F17, F20

## Context

The baseline has no user identity. The only credential is a per-process capability token minted at `packages/explorer/server/serve_explorer.py:40`, injected into the served page as `window.__SCHEMA_LIVE__` (`:69-70`), and therefore handed to any unauthenticated caller of `GET /` on the loopback interface (`:61-71`); the browser bridge sends it as `X-Schema-Token` (`skill/assets/explorer.html:188`). Database credentials are read from an operator-named environment variable (`serve_explorer.py:35`), never stored; `connect_readonly` rejects `service`/`passfile` discovery (`schema_profiler.py:213-214`) and forces `default_transaction_read_only` and `statement_timeout` (`:215-216`), but does not require TLS. There is no authorization model, no rate limiting, no audit log (`log_message` is a no-op, `serve_explorer.py:45-46`), and all database errors collapse to fixed strings (`:107-111`), a pattern worth keeping.

Forces:

- The MVP must launch without depending on a customer identity provider (D5), yet must not preclude OIDC/SAML later (L-08).
- Connection secrets must be stored for the worker to use, never returned to the browser, and must survive a database dump falling into the wrong hands.
- The API and worker share one image and one database; only the worker opens customer databases (ADR-0003), so decryption can be confined to it.
- CTQ-07 requires an RBAC matrix that fails on undeclared routes, IDOR negatives returning 404, secrets absent from every response, and a strict SPA CSP; CTQ-16 requires audit rows for login, key and connection changes, jobs, exports, and decisions.
- Quoted from `docs/reference/caveats.md` (C14): "The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows."

## Decision

1. **Accounts**: local accounts with argon2id password hashes, minimum length 12, top-10k deny list; first owner created by `python -m app.bootstrap` with a one-time password; `is_active` for deactivation.
2. **Sessions**: server-side sessions in `sessions` with only an opaque token in a `__Host-backend-buddy_session` cookie (`Secure; HttpOnly; SameSite=Lax`); dev fallback to a non-`__Host-` name over HTTP with a startup warning; idle and absolute expiry; rotation on login and on role change; revoke-all endpoint; CSRF double-submit token bound to the session.
3. **RBAC**: roles `owner > admin > reviewer > viewer` per workspace (`workspace_members.role`); every route declares its minimum role through `require_role`; `test_rbac_matrix` enumerates routes and fails on any undeclared one; cross-workspace ids return 404.
4. **API keys**: per workspace and user, sha256-hashed, shown once, role-capped at the creator's role, expiring and revocable; exempt from CSRF because they carry no cookie.
5. **Connection secrets**: envelope encryption in `services/api/app/crypto/envelope.py`: AES-256-GCM, random 96-bit nonce, AAD = connection id, master key from a Docker secret file (`BB_MASTER_KEY_FILE`), key registry in `encryption_keys` with a master-key fingerprint checked at startup. Secrets are write-only; decrypted only in the worker immediately before `connect_readonly`; zeroed on delete; rewrap CLI is L-04.
6. **Customer-database TLS**: `connections.tls_mode` default `verify-full` mapped to `sslmode` by `targets.py`; private targets (loopback, link-local, metadata hosts) denied unless `BB_ALLOW_PRIVATE_TARGETS`.
7. **Rate limits and headers**: slowapi on login and job submission; security headers and the strict SPA CSP (`security-architecture.md` 6.2).
8. **Audit**: an audit service writes `audit_events` for the CTQ-16 list; the table is insert-only by trigger and by role grants.
9. **Skill loopback server** (S03): token moves from the page to an `HttpOnly; SameSite=Strict; Path=/api` cookie obtained through `GET /api/session`; POST requires `Sec-Fetch-Site: same-origin`; `--bind` and `--allowed-hosts`; `Server` header suppressed. This is the developer tool's model, not the platform's.

## Consequences

- Positive: launch without an IdP; secrets unreadable from a database dump without the master key; a single place (worker) ever holds plaintext; audit and RBAC are testable by enumeration.
- Negative: password-based accounts need reset and lockout flows (A02 scope); master-key loss forces re-entry of every connection (mitigated by documented off-host encrypted backup; rewrap is L-04); confining decryption to the worker makes `connection.test` a job or an API-side exception, an open decision recorded in `data-model.md` and `security-architecture.md`.
- Neutral: OIDC/SAML later adds an identity source, not a new session model.

## Alternatives considered

- OIDC/SAML only at MVP: rejected; blocks self-hosted licensees without an IdP and delays G2.
- JWT bearer tokens in localStorage: rejected; not revocable server-side, exposed to XSS, no CSRF story needed but weaker overall.
- Store connection secrets in plaintext or reversible obfuscation: rejected; a database dump would disclose customer credentials.
- Per-tenant KMS or HSM at MVP: rejected; over-engineered for single-tenant compose; the `encryption_keys` registry leaves room for a KMS-wrapped master key later.
- Customer-side connector agent so the platform never holds credentials: deferred to L-08 (`connections.mode` reserved now).
- Do nothing (loopback token): rejected; no identity, token disclosed to any local reader.

## CTQs affected

- CTQ-07: RBAC matrix, IDOR negatives, secrets never in responses, cookie flags, CSRF, strict CSP, audits clean.
- CTQ-16: audit rows and immutability; log redaction.
- CTQ-08: `tls_mode` and target deny list bound the worker's reach.
- CTQ-12: 95 % coverage for auth, crypto, and policy modules.

## Verification

- A02: `test_rbac_matrix` (fails on undeclared routes); IDOR negatives return 404; cookie flags and CSRF e2e; session rotation on login and role change; revoke-all; bootstrap one-time password; rate-limit tests.
- A03: `envelope.py` round-trip and tamper tests (wrong AAD, wrong key, truncated nonce); `GET /connections` response schema excludes `encrypted_secret`, `key_id`, `password`, `dsn`; `targets.py` deny-list and `tls_mode` mapping tests.
- A01: audit UPDATE/DELETE rejected by trigger and by role; upgrade/downgrade/upgrade.
- S03: `test_explorer_http.py` new cases (token absent from GET body; missing cookie; missing `Sec-Fetch-Site`; unlisted host; `localhost:<port>` accepted under the default allowlist).
- Q02: bundle grep for secrets; STRIDE control-to-test mapping (Gate G2).

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Security lead |
