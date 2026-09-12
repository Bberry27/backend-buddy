Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-W01 SPA shell

| Field | Value |
|---|---|
| Work package | W01 (track W, phase 2) |
| Features | F14, F16, F17, F20, F21 (shell surfaces only; no view internals) |
| CTQs | CTQ-02, CTQ-07, CTQ-09, CTQ-10, CTQ-11 |
| Caveats | C13, C14 (quoted only from `docs/reference/caveats.md`, via `caveat-strings.ts`) |
| Depends on | C02, C03, S02, gate G0 |
| Blocks | W02, W03, O01, Q01 |
| Branch | `w01/spa-shell` |
| Gate | G2 |

### 1. Goal

Deliver `packages/web`, a Vite + React 19 + React Router 7 (library mode) SPA that hosts exactly one view at a time without remounting it on filter changes, keeps selection and filters in the URL through `route-state.ts`, and provides the login, workspace, project (snapshots list, upload page, connections page with job-progress polling) pages against an `msw` stub API. Auth wiring against the real API is added when A02 lands; until then the stub is the contract. A verifier can check: `window.__backend-buddyMounts` stays constant over 20 filter keystrokes, size budgets pass, axe reports 0 serious/critical on every route, and no secret field is ever rendered on the connections page.

### 2. Reading list (ordered)

1. `docs/features/F14-drill-through-navigation.md` (D05, required at G0): the shell's obligations for inbound/outbound selection and URL state.
2. `docs/features/F16-projects-and-snapshots.md`, `F17-connections-and-profiling.md`, `F20-auth-and-workspaces.md` (D05): the pages this package builds; take the B-numbered behaviours that name "SPA" or "W01".
3. `docs/architecture/drill-through-contract.md` sections 3, 4, 5, 7 and 8: the route grammar, the `ViewProps` additive fields the shell must supply, the "shell updates inspector and URL in one transaction" rule, and "prefill, never execute".
4. `docs/architecture/schema-graph-contract.md` and `packages/contract/schema-graph.v1.json` (C01): the graph the shell fetches and hands to views.
5. `docs/architecture/adr/ADR-0002-frontend-spa-and-iife-export-path.md` (stack), `ADR-0004-selection-and-routing-contract.md` (routing), `ADR-0006-deployment-topology-and-artifact-csp.md` (the SPA is served by the API under the strict CSP in `docs/architecture/security-architecture.md` section 6.2).
6. `docs/architecture/security-architecture.md` section 6.2 and 7: the strict SPA CSP the shell must run under with 0 violations, cookie and CSRF model for the API client.
7. Existing code to re-express, not copy: host tablist keyboard model and `render()` at `skill/assets/explorer.html:22` (tablist markup) and `:178` (`render()` unmounts unconditionally, the behaviour W01 must not reproduce); `scoped()` filter semantics at `explorer.html:60`; theme persistence key `backend-buddy:<project.key>:theme` (`explorer.html:39`); breakpoints 1050/700 px in the host CSS (`explorer.html:13-14`); `mount()`/`unmount()` at `packages/explorer/src/index.tsx:21-22` (the root-per-mount pattern replaced by C03 `mount-policy.ts`).
8. C03 deliverables: `packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts` and their tests; the shell consumes them and adds nothing to them.
9. C02 deliverables: `packages/explorer/src/{tokens.css,theme.tsx,palettes.ts}`; `ThemeProvider`/`useTheme` are the only theme API.
10. S02 deliverables: `playwright.config.ts`, `tests/README.md`, `scripts/size-budget.mjs`, ESLint config with `no-restricted-imports` (router, fetch, Vitest are forbidden inside `packages/explorer`; they belong here).
11. `docs/reference/limits-and-caps.md` section B: shell <= 350 KB gzipped, City chunk <= 700 KB, Living ERD chunk <= 250 KB.
12. `docs/engineering/standards.md`, `security-policy.md`, `testing-policy.md`, `accessibility-standards.md` (D03, once landed).

### 3. In scope

- `packages/web` scaffold: Vite, React 19, TypeScript, React Router 7 in library mode, Zustand store, Vitest + Testing Library + jsdom, `msw` stub API for unit tests and e2e.
- Routes: `/login`, `/w/:ws`, `/w/:ws/p/:project` (snapshots list, upload page, connections page), `/w/:ws/p/:project/s/:snapshot/:view` (route grammar from `drill-through-contract.md` section 4; parse and serialize only via `route-state.ts`).
- `ViewHost`: mounts exactly one view component, updates props on filter and selection changes, never recreates the root; exposes `window.__backend-buddyMounts` in non-production builds (CTQ-10).
- Roving tablist (`role=tablist`, arrow keys, Home/End, `#tab-<view>` ids and `[data-view]` per the selector contract), debounced filters synced to `q d k`, theme toggle through `ThemeProvider`, `aria-live` region for status, `prefers-reduced-motion` honoured.
- Connections page (F17 SPA surface): create, test, extract, profile actions with job-progress polling of `GET /jobs/{id}`; secret fields are write-only inputs; the page never renders `encrypted_secret`, `key_id`, `password`, or `dsn`; partial job status shown with the item reason.
- Upload page (F16 SPA surface): size and content-type checks client-side mirror the API; success shows the snapshot provenance (C09 wording is F16's; the shell only displays fields).
- API client: credentials included, CSRF header from the session, 401 redirect to `/login`, request types generated from the A02 OpenAPI document (checked-in generated file; hand edits forbidden).
- Lazy chunks for City and Living ERD; `scripts/size-budget.mjs` thresholds wired for the shell and both chunks.
- CSP-violation e2e: `tests/e2e/csp.spec.ts` loads all 13 views under the strict SPA CSP and asserts 0 `securitypolicyviolation` events (RK-04).
- Vitest component tests for `ViewHost` (no remount), tablist keyboard model, filter debounce and URL sync, connections page secret-free rendering.
- Feature docs F14, F16, F17, F20 sections 3 and 14 updated for the shell surfaces.

### 4. Out of scope

- Inspector panel, "Open in ..." menu, breadcrumb, context menu (W02).
- Porting the four host views (W03) and any change inside the nine view components (W04, W05).
- Real authentication endpoints, sessions, CSRF issuance (A02); the shell codes against the stub until A02 merges, then a follow-up PR under W01 wires it.
- Docker image and compose serving of the SPA (O01).
- Performance baselines and TTI harness (Q01); this package only wires the size budgets.
- Artifact hash deep links and Open-in inside the artifact (L-05).
- Any change to `route-state.ts`, `navigation.ts`, or the `v.*` allowlists (C03; a needed change is raised through roadmap change control).

### 5. May modify

```
packages/web/**
package.json                              (workspace entry for packages/web, npm scripts for web test/build only)
package-lock.json                         (consequence of the workspace entry)
tests/e2e/shell.spec.ts
tests/e2e/csp.spec.ts
tests/e2e/matrix.spec.ts                  (CTQ-02 matrix for the SPA)
tests/a11y/routes.spec.ts
scripts/size-budget.mjs                   (thresholds only)
docs/features/F14-drill-through-navigation.md   (sections 3 and 14 only)
docs/features/F16-projects-and-snapshots.md     (sections 3 and 14 only)
docs/features/F17-connections-and-profiling.md  (sections 3 and 14 only)
docs/features/F20-auth-and-workspaces.md        (sections 3 and 14 only)
CHANGELOG.md                              ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated; change scripts/generate-fixtures.mjs only if in scope
THIRD_PARTY_NOTICES.md                  generated by scripts/generate_notices.mjs
packages/explorer/src/types.ts          C01/C03 only
skill/assets/explorer.html              S01, S03 (live bridge only), W03 (inline renderers only)
skill/scripts/build_explorer.py         S01 only
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01 (compose-smoke job), O02, Q05 only
packages/explorer/src/**                view library is read-only for W01 (W02-W06 own changes there)
services/api/**                         A track
deploy/**                               O01
```

A path in neither list is "ask first".

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| `ViewProps` additive fields; `onSelectTable(id)` signature unchanged | `packages/explorer/src/types.ts` (C03); `drill-through-contract.md` section 3 | `npm run typecheck`, `navigation.test.ts` |
| Route grammar `/w/:ws/p/:project/s/:snapshot/:view`, keys `t c r ts f q d k`, `v.*` allowlist, 200-char cap, unknown ids dropped | `drill-through-contract.md` section 4; `route-state.ts` | `route-state.test.ts`; `tests/e2e/shell.spec.ts` URL round trip |
| Selector contract: `#tab-<view>`, `[data-view]`, `[data-selected="true"]`, `.is-selected`, `[data-rowcount]` | `drill-through-contract.md` section 7 | `tests/e2e/**`, `scripts/verify_host.mjs` |
| Storage key families: `backend-buddy:<project.key>:...`, `backend-buddy-erd:v1:<project.key>:<fingerprint>`, `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>`; never unscoped | `explorer.html:39`, `living-logic.ts:68`, `view-state.ts` (C03) | `view-state.test.ts`; storage-isolation e2e (Q02) |
| Host CSS variables byte-identical in `tokens.css`; shell uses tokens only, no hex literals | `explorer.html:9-10`, `tokens.css` (C02) | `tokens.test.ts`, `scripts/check-hardcoded-colors.mjs` |
| Strict SPA CSP (`security-architecture.md` 6.2): no inline scripts, no `unsafe-eval`; a non-compliant library is isolated or replaced, never the policy loosened | A02 header; `tests/e2e/csp.spec.ts` | `CTQ-07 csp violations = 0` |
| Draft SQL never executed; a drill-through may prefill a live query but never runs it without a click | `drill-through-contract.md` section 8 | `tests/e2e/drill-through.spec.ts` (W04) |
| Caveat wording from `caveat-strings.ts` only | `docs/reference/caveats.md` | `caveats.test.ts`, docs lint DL-05 |
| No remount: one React root per `ViewHost`, props update on filter change | `mount-policy.ts` (C03) | `CTQ-10 no remount over 20 keystrokes` |
| Size budgets: shell <= 350 KB gz, City chunk <= 700 KB, Living ERD chunk <= 250 KB | `limits-and-caps.md` B | `node scripts/size-budget.mjs` |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with the F/CTQ id, green locally with the acceptance commands
- [ ] Feature document sections 3 (current state) and 14 (implementation map and change log) updated (F14, F16, F17, F20)
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist from `docs/engineering/security-policy.md` completed (CSP e2e result, secret-free connections page test, 401 handling)
- [ ] Accessibility result recorded (axe serious/critical = 0 on every route x 2 themes x 1366/390; tablist keyboard journey)
- [ ] Performance measurement recorded: `size-budget.mjs` output for shell and both chunks
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts`
- [ ] `npm run guard` green; no private schemas, screenshots, or QA reports added
- [ ] `npm run build` run; the explorer mirror is unchanged (this package does not edit `packages/explorer`)
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `window.__backend-buddyMounts` is absent from the production build (`grep -c __backend-buddyMounts packages/web/dist/assets/*.js` equals 0)
- [ ] Package-specific: generated API types file carries a header naming the OpenAPI source and is regenerated, not edited

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test
npm --prefix packages/web test -- --coverage           # Vitest; components >= 75 % (CTQ-12)
npm --prefix packages/web run build
node scripts/size-budget.mjs                            # exit 0; prints shell/city/living sizes
npx playwright test tests/e2e/shell.spec.ts             # includes 'CTQ-10 no remount over 20 keystrokes'
npx playwright test tests/e2e/csp.spec.ts               # 'CTQ-07 csp violations = 0' across 13 views
npx playwright test tests/e2e/matrix.spec.ts            # CTQ-02 1920/1366/390 x light/dark x inspector open/closed
npx playwright test tests/a11y/routes.spec.ts           # CTQ-11 axe serious/critical = 0
npx eslint packages/web packages/explorer/src           # no-restricted-imports: no router/fetch/Vitest in packages/explorer
grep -c __backend-buddyMounts packages/web/dist/assets/*.js      # expected: 0 matches
```

Package-specific assertions: the connections page e2e asserts the rendered HTML contains none of `encrypted_secret`, `key_id`, `password`, `dsn`; the shell e2e reloads a deep link `/w/<ws>/p/<p>/s/<s>/columns?t=<id>&c=<id>%23<col>` and asserts the same selection is restored.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10: files changed (tagged, with glob statement); acceptance commands run with exit status; definition of done; frozen contracts (one line each); measurements (bundle sizes, axe counts, mount count); out of scope, found; open questions for the owner; deviations.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-02 contract churn | Start only after C03 is merged; never edit `types.ts`, `route-state.ts`, or `navigation.ts`. |
| RK-04 strict SPA CSP breaks libraries | `tests/e2e/csp.spec.ts` across 13 views is part of acceptance; a violation is fixed by isolating or replacing the library, and the PR must say which. |
| RK-05 remount fix changes lifecycle assumptions | `ViewHost` component test for prop-change behaviour; `__backend-buddyMounts` hook; do not enable behaviours in views (W04/W05 own those). |
| RK-09 Windows vs Linux CI | No absolute paths, no `msedge`; bundled Chromium per S02. |
| RK-10 scope creep | Anything inside `packages/explorer/src` goes to the "Out of scope, found" list. |
| RK-17 theme fallbacks outside the host | Shell CSS uses tokens only; `check-hardcoded-colors.mjs` runs in acceptance. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |


---

## ADDENDUM (product owner, 2026-09-08) — overrides anything above that conflicts

Sections most relevant to this work package: **C, D, E**. Read all of it; the
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

Sections most relevant to this work package: **G, H**. Read all of it.

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


---

## ADDENDUM 3 note for W01 (2026-09-08)

A03 now ships a server-rendered admin area at `/admin` with a working credentials form,
because the product owner needed somewhere to enter credentials before the SPA existed.
Consequences for this package:

- The endpoints are already defined and exercised. Build the SPA Connections page against
  the same routes; do not invent a parallel shape.
- **Do not delete or break `/admin`.** It is the zero-build path for a local install and
  the fallback when the SPA bundle fails to load. Its tests stay green.
- Where the SPA improves on it (job progress polling, inline validation, the guided
  four-step flow with resumable state), improve the SPA. Where the two disagree about what
  a field means, the server-rendered page is the contract, because it shipped first and
  a user may already have connections created through it.
