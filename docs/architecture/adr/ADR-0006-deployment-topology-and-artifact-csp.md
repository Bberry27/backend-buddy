Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0006: Single-tenant Docker Compose topology and the byte-identical artifact CSP

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Platform lead, Security lead
- **Work packages**: O01, O02, O03, S01, S02, S03
- **Related**: ADR-0003, ADR-0005, `docs/architecture/deployment-architecture.md`, `docs/architecture/security-architecture.md` (section 6), F22

## Context

Nothing is containerised: the repository has no Dockerfile, compose file, `.dockerignore`, or `.env.example`. What exists constrains the design: `scripts/project.mjs` locates Python through `PYTHON` (`:10`) and builds the artifact from `fixtures/schemas/medium.json` by default (`:89-90`); `engines` pins `node >= 22` and `npm >= 10.5.1`; the loopback server binds `127.0.0.1` and requires an exact `Host` (`packages/explorer/server/serve_explorer.py:42`, `:58-59`, `:113`), which cannot work behind a Docker published port, and `test_explorer_http.py:206` pins `localhost:<port>` as rejected.

The offline artifact is governed by one CSP at `skill/assets/explorer.html:6`:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'
```

Decision D9 requires it to stay byte-identical: existing adapters, the installed skill, and the legacy handoff gate "Preserve the offline CSP" depend on it. The renderer never rewrites it (`skill/scripts/build_explorer.py:99-108`); only the skill's live mode rewrites `connect-src` on the served copy (`serve_explorer.py:68`). `test_explorer_http.py:34` currently pins a shorter constant without `img-src data:`, so the byte-identical requirement is not yet tested as written.

Forces:

- "Runs locally in my Docker now, SaaS later" without a rewrite (D4): tenant scoping in the data model now, one image for API and worker, TLS by the operator's proxy.
- CTQ-15: `docker compose up` to `/readyz` in under 5 minutes on a clean machine; upgrade/downgrade/upgrade; rollback rehearsal in CI.
- CTQ-14: images must not contain the private example or QA evidence; `.dockerignore` must mirror `.gitignore`.
- CTQ-05: artifact CSP byte-identical and zero network requests.
- Quoted from `docs/reference/caveats.md` (C04): "Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf."

## Decision

1. **Topology**: `deploy/compose.yml` with `db` (PostgreSQL 16, pinned digest, volume), `migrate` (one-shot `alembic upgrade head`), `api`, and `worker`, the last three from one multi-stage image (`node:22-bookworm-slim` build stage, `python:3.13-slim-bookworm` runtime, pinned digests, non-root `10001`, read-only rootfs with tmpfs, `HEALTHCHECK`). Secrets `backend-buddy_master_key` and `backend-buddy_db_password` as Docker secrets. `api` published on `127.0.0.1:8000` by default.
2. **Overlays**: `compose.dev.yml` (Vite HMR proxying `/api`, `api --reload`, fixture PostgreSQL seeded from `fixtures/sql/pg`, `BB_ALLOW_PRIVATE_TARGETS=true`); `compose.qa.yml` (pinned Playwright image, swiftshader flags, real-PostgreSQL profiler tests).
3. **TLS**: terminated by the operator's reverse proxy; documented in `docs/operations/deployment.md`; HSTS when `BB_PUBLIC_ORIGIN` is `https`; Caddy profile is L-07.
4. **Environment contract**: `BB_*` variables and `*_FILE` secrets listed in `deployment-architecture.md` section 4, mirrored in `deploy/.env.example`; unknown `BB_*` variables fail startup.
5. **Artifact CSP**: byte-identical to the string above for the life of the skill's v1 artifact; `verify_host` asserts zero external requests; `test_explorer_http.py:34` is corrected to the full string (S02/S03). `script-src 'unsafe-inline'` is accepted as the cost of a single-file offline artifact and is the reason escaping discipline in the host and renderer is mandatory (S01).
6. **Served SPA CSP**: strict policy (`security-architecture.md` 6.2) with `script-src 'self'`, no `unsafe-eval`, `connect-src 'self'`; `style-src 'unsafe-inline'` accepted at MVP for inline style attributes; enforced by a CSP-violation e2e across 13 views with 0 reports; a non-compliant library is isolated or replaced, never accommodated by loosening.
7. **Skill server inside containers**: S03 adds `--bind` and `--allowed-hosts` (default `127.0.0.1:<port>`, `localhost:<port>`), keeping exact-match semantics against an explicit allowlist rather than widening to any host.
8. **CI**: compose-smoke job (`up -> /readyz < 5 min -> upgrade/downgrade/upgrade -> previous tag`), image contents listed to prove `.dockerignore`, `release.yml` publishing to GHCR on tag.

## Consequences

- Positive: one image, one compose file, reproducible from a clean clone using fixtures only; SaaS path preserved through tenant scoping and `connections.mode`; artifact compatibility guaranteed.
- Negative: licensees must supply a reverse proxy for TLS at MVP; `style-src 'unsafe-inline'` remains in the SPA policy until L-07; swiftshader-based browser QA is slow on shared CI (baselines first, budgets as warnings until two green weeks, plan risk).
- Neutral: the artifact remains large and single-file; its size budget is to be decided (`docs/reference/limits-and-caps.md` B).

## Alternatives considered

- Kubernetes manifests or Helm at MVP: rejected; single-tenant licensees run one host; compose is enough and simpler to roll back.
- Bundle a TLS-terminating proxy inside compose: deferred (L-07 Caddy profile); operators usually have one and certificate management is their domain.
- Loosen the artifact CSP (for example add `connect-src 'self'` permanently) to simplify live mode: rejected by D9 and CTQ-05; the served copy is rewritten in flight instead.
- Nonced or hashed inline scripts in the artifact: rejected for now; the host IIFE and the bundle are inline by design and a single-file artifact has no server to issue nonces; hashing is possible later without changing the byte-identical requirement only if D9 is revisited by ADR.
- Bind the skill server to `0.0.0.0` and accept any `Host`: rejected; reopens DNS rebinding against the read-only adapter.
- Do nothing: rejected; the MVP definition requires `docker compose up` from a clean clone.

## CTQs affected

- CTQ-15 deployability and rollback rehearsal.
- CTQ-14 image contents free of private data.
- CTQ-05 artifact CSP byte-identical, zero network requests.
- CTQ-07 strict SPA CSP with 0 violations; security headers.
- CTQ-16 JSON logs and metrics endpoints available from the containers.

## Verification

- O01: compose-smoke CI job; `HEALTHCHECK` and `/readyz`; `docker image inspect` and file listing prove exclusions; runbooks exercised once.
- S02: `scripts/verify_host.mjs` asserts the CSP string byte-for-byte and `externalRequests` empty; `tests/security/artifact.spec.ts`.
- S03: `test_explorer_http.py` CSP constant equals `explorer.html:6`; allowlist tests.
- W01/Q02: SPA CSP-violation e2e across 13 views = 0 reports (Gate G2).
- O02: `release.yml` builds and pushes on tag; CHANGELOG section check.

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Platform lead |
