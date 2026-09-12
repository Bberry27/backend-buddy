Status: draft | Owner: Security lead | Last verified against code: pre-repo (2026-09-07)

# WP-S03 Loopback server hardening

| Field | Value |
|---|---|
| Work package | S03 (track S, phase 1) |
| Features | F17, F22, F06 (live `POST /api/subtree`), F09 (live `POST /api/profile`) (F17 has no feature document yet; registry row `docs/features/README.md:35`) |
| CTQs | CTQ-05 (the served copy must remain the only CSP deviation), CTQ-07, CTQ-08 (`ProfileLimitError` surfaced as 422 with no fabricated result), CTQ-14 |
| Caveats | C14 (quoted in section 7; the skill docs updated here must keep quoting it verbatim) |
| Depends on | S01 (single owner of `explorer.html` in Phase 1; S03 edits only the live bridge `:186-190` after S01 merges) |
| Blocks | none on the critical path; closes Gate G1 finding "loopback server (S03)"; A03 reuses the hardened flag semantics for `compat.py` |
| Branch | `s03/loopback-server-hardening` |
| Gate | G1 |

### 1. Goal

Close finding 6 of `docs/architecture/security-architecture.md` section 5: the live-mode capability token is injected into the page (`serve_explorer.py:69-70`) where any script can read it, the server binds `127.0.0.1` with an exact `Host` match (`:42`, `:58-59`, `:113`) that cannot work behind a Docker published port, and `test_explorer_http.py:206` pins `localhost` as rejected. After this package the token lives in an `HttpOnly; SameSite=Strict; Path=/api` cookie, the page carries no secret, POSTs require `Sec-Fetch-Site: same-origin`, `--bind` and `--allowed-hosts` make deployment behind a published port possible without widening to any host, `ProfileLimitError` returns 422 instead of 500, and the `Server` header is suppressed. Read-only and bounded behaviour of the profiler is unchanged.

### 2. Reading list (ordered)

1. `docs/features/F22-offline-artifact-and-skill.md` section 3 ("Loopback server", "Host behaviours" live bridge, "Defects and gaps" live-mode bullet), section 4 B6 (this package's behaviour), section 10, section 14.
2. `docs/architecture/security-architecture.md` section 5 finding 6 (and finding 8's S03 part: `ProfileLimitError` -> 422), section 6.1 (the served copy may rewrite only `connect-src`; after S03 it injects no token script; `test_explorer_http.py:34` must assert the full CSP string), section 2 (trust boundaries).
3. `docs/architecture/adr/ADR-0006-deployment-topology-and-artifact-csp.md` decision 7 (`--bind`, `--allowed-hosts` default `127.0.0.1:<port>`, `localhost:<port>`, exact-match semantics against an explicit allowlist) and `ADR-0005-auth-and-credential-encryption.md` (S03 listed; cookie conventions that the later API follows: `HttpOnly`, `SameSite`, no secret in responses).
4. `docs/reference/limits-and-caps.md` A2 (request body 1..65,536 bytes, single-flight lock, bind address row that names S03) and A1 (`DEADLINE_SECONDS`, `MAX_QUERIES`: the paths that raise `ProfileLimitError`).
5. `docs/reference/caveats.md` C14 (wording; the skill docs you edit must quote it, not paraphrase it).
6. `docs/product-management/risk-register.md` RK-16 (DNS rebinding argument for keeping an allowlist), RK-21 (no forensics; not fixed here).
7. Code, in this order:
    - `packages/explorer/server/serve_explorer.py`: arguments `:17-26`, token `:40`, `address` `:42`, `Handler.log_message` no-op `:45-46`, `send()` `:48-56` (headers `Content-Type`, `Cache-Control: no-store`, `X-Content-Type-Options`, `Content-Length`), `valid_host()` `:58-59`, `do_GET` `:61-71` (CSP rewrite `:68`, token script injection `:69-70`), `do_POST` `:73-111` (Origin check `:75`, token via `hmac.compare_digest` `:79`, body cap `:83-85`, lock `:89-90`, routes `:94-103`, `ValueError/KeyError/TypeError` -> 400 `:107-108`, everything else -> 500 `:109-111`), `ThreadingHTTPServer(('127.0.0.1', args.port))` `:113`.
    - `packages/explorer/server/schema_profiler.py:83-84` (`ProfileLimitError(RuntimeError)`), `:190` (`connect_readonly`), `:368` (`profile`), `:458` (`subtree`); module docstring lines 56-59 (the server accepts no graph-supplied SQL).
    - `packages/explorer/server/test_explorer_http.py` in full (411 lines); the assertions this package may change are enumerated in section 3.
    - `skill/assets/explorer.html:186-190` (the live bridge: `let live;` gate on `window.__SCHEMA_LIVE__ && location.protocol.startsWith('http')`, `fetch('/api/'+action, {headers:{'X-Schema-Token': ...}})`, `profile()` replacing `data.tables`/`data.links`) and `:195` (`live` passed to `mount`). `test_explorer_http.py:373-407` executes exactly this slice (`'let live;'` to `'function renderExtension'`) in a node `vm`, so the bridge's shape is test-visible.
    - `skill/references/advanced-views.md:32-35` (server invocation and the sentence "The server binds to 127.0.0.1, requires same-origin requests plus an ephemeral capability, and changes only the served copy's connect policy.") and `skill/SKILL.md` (steps referring to the profiling service).
8. `AGENTS.md` sections 5-7. `docs/engineering/security-policy.md` (D03) does not exist yet.

### 3. In scope

**Server (`serve_explorer.py`)**

1. `--bind <address>` (default `127.0.0.1`) and `--allowed-hosts <host:port,...>` (default `127.0.0.1:<port>,localhost:<port>`; when given, the list replaces the default, so an operator behind a published port passes exactly the public `host:port`). `valid_host()` becomes an exact match against the allowlist; the `Origin` check becomes `Origin == 'http://' + <the request's Host header>` and the Host must be allowlisted (no scheme widening; `https` origins are out of scope because TLS is the reverse proxy's job at MVP, ADR-0006 decision 3). Startup prints the bind address and the allowlist.
2. Token delivery: `GET /` (live mode only) sets `Set-Cookie: bb_live=<token>; HttpOnly; SameSite=Strict; Path=/api` and injects `window.__SCHEMA_LIVE__={"live":true}` (a non-secret flag, so the synchronous bridge at `:186-195` keeps working; see open question 1). The token never appears in the HTML body. `GET /api/session` returns `200 {"live":true}` when the cookie is valid, `403 {"live":false}` otherwise, `Cache-Control: no-store`.
3. POST authorisation: allowlisted Host, exact Origin, `Sec-Fetch-Site: same-origin` header present and equal, cookie token via `hmac.compare_digest` (ASCII check retained), body cap, lock: unchanged order of checks otherwise. `X-Schema-Token` is no longer accepted.
4. `ProfileLimitError` -> `422 {"error":"Read-only operation exceeded its query or time budget"}` (no DSN, no partial rows); other non-client exceptions stay `500` with the existing generic message.
5. `Server` header suppressed: override `version_string()` to return an empty string or use `send_response_only` plus explicit `Date`; assert the header is absent.
6. Metadata-only mode (no `--dialect`): no cookie, no `__SCHEMA_LIVE__`, page byte-identical (existing test `:157-166` stays valid).

**Host bridge (`explorer.html:186-190` only)**

7. Gate on `window.__SCHEMA_LIVE__?.live === true && location.protocol.startsWith('http')`; `fetch('/api/'+action, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body, signal})` with no token header; error handling unchanged. `Sec-Fetch-Site` is a browser-set forbidden header; the bridge does not set it.

**Tests (`test_explorer_http.py`): the only assertions that may change, and why**

| Lines | Today | Change | Why |
|---|---|---|---|
| `:29-33` | `HOST_TEMPLATE` already reads `explorer-host-template.html` with fallbacks | none | R00 did the rename |
| `:34` | `CSP` constant omits `img-src data:` | Use the full frozen string | ADR-0006 decision 5; `security-architecture.md` 6.1 note |
| `:83-87` `capability(page)` | Parses `window.__SCHEMA_LIVE__={token}` from the page | Parse `{"live":true}` from the page and read the token from the `Set-Cookie` header of the `GET /` response (`request()` must return headers; it already does) | Token leaves the page |
| `:148-149` `authorized()` | Adds `Origin` and `X-Schema-Token` | Adds `Origin`, `Cookie: bb_live=<token>`, `Sec-Fetch-Site: same-origin` | New authorisation shape |
| `:157-166` | Metadata-only: `assertNotIn('__SCHEMA_LIVE__', page)`; POST 403 | Keep; add `assertNotIn('Set-Cookie', headers)` for `GET /` | Metadata-only must issue no cookie |
| `:176-193` | `capability` keys `{'token'}`, `count('window.__SCHEMA_LIVE__=')==1`, script precedes `#schema-data`, CSP rewritten to `connect-src 'self'`, second GET returns the same capability, token not in log | Keys `{'live'}`; the flag script still precedes `#schema-data`; token from `Set-Cookie` has length >= 32, flags `HttpOnly`, `SameSite=Strict`, `Path=/api`; token absent from the body (`assertNotIn(token, page)`); second GET returns the same cookie token; `Server` header absent; CSP assertion unchanged | Token moved to cookie; process-scoped token retained |
| `:195-202` | Cross-process token via `capability()['token']` | Same test with the cookie token | Helper change only |
| `:204-213` | `localhost:<port>` expected 404 (`:206`) | `localhost:<port>` expected 200 with no token in the body; `attacker.invalid` and `127.0.0.1:1` stay 404; path checks unchanged | Default allowlist includes `localhost:<port>` |
| `:215-225` | Nine header permutations, all 403 | Keep all nine (with the cookie replacing `X-Schema-Token`; the `Origin: http://localhost:<port>` case still fails because Host is `127.0.0.1:<port>` and Origin must match the request Host exactly); add: missing cookie, missing `Sec-Fetch-Site`, `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Site: same-site`, legacy `X-Schema-Token` header without cookie | New checks |
| `:227-234` | Non-ASCII token header -> 403 without dropping the connection | Non-ASCII cookie value -> 403 without dropping the connection | Same defence, new carrier |
| `:236-259`, `:261-283`, `:285-293`, `:295-301`, `:303-308` | Use `self.authorized(...)`; bodies unchanged | none beyond the helper | Behaviour preserved |
| `:310-317` | Missing database -> 500, redacted | Keep 500 (a connection failure is not a `ProfileLimitError`) | Distinguishes 422 from 500 |
| new | - | `test_S03_profile_limit_error_returns_422`: inject `patch.object(schema_profiler, 'DEADLINE_SECONDS', -1)` into the child process with the `-c` runner pattern of `:357-371`, POST `/api/profile`, assert 422 and the generic message, no `SENTINEL` | Finding 8 part |
| new | - | `test_S03_unlisted_host_rejected_with_custom_allowlist`: start with `--allowed-hosts example.test:<port>`; Host `example.test:<port>` -> 200; Host `127.0.0.1:<port>` -> 404; POST with matching Origin `http://example.test:<port>` and cookie -> 200 | `--allowed-hosts` semantics |
| new | - | `test_S03_bind_flag_is_honoured`: `--bind 127.0.0.1` explicit works; `--bind 0.0.0.0 --allowed-hosts 127.0.0.1:<port>` starts and serves on loopback (CI has no second interface; do not assert reachability on other addresses) | `--bind` |
| new | - | `test_S03_session_endpoint`: `GET /api/session` with cookie -> `200 {"live":true}`; without -> `403 {"live":false}`; in metadata-only mode -> 404 | New route |
| new | - | `test_S03_server_header_absent` on every response class (200, 400, 403, 404, 422, 500) | `Server` suppressed |
| `:373-407` bridge test | Context `window.__SCHEMA_LIVE__={token:'synthetic-token'}`; asserts `headers['X-Schema-Token']==='synthetic-token'` | Context `{live:true}`; assert no `X-Schema-Token` header, `options.credentials==='same-origin'`, the `file:`/no-flag cases still produce `live===undefined` and zero calls; the rest unchanged | Bridge shape changed |

**Documentation**

8. `skill/references/advanced-views.md:32-35`: document `--bind`, `--allowed-hosts`, the cookie, and the published-port recipe; keep the C14 quotation verbatim where the live connection is described. `skill/SKILL.md`: the sentence about the profiling service. `docs/features/F22-offline-artifact-and-skill.md` sections 3 and 14; `docs/reference/limits-and-caps.md` A2 bind-address row updated with the new lines; `CHANGELOG.md` (`Security`: the S03 paragraph becomes a fixed entry).

### 4. Out of scope

- Anything in `serve_explorer.py` beyond the items above: no logging (RK-21 is A02/O03), no TLS, no rate limiting, no multi-user auth (A02), no `https` Origin support (reverse proxy, ADR-0006 decision 3).
- `schema_profiler.py`, `profile_snapshot.py`, `snapshot_io.py`, `test_schema_profiler.py`: unchanged. Per-table budgets, `policy.py`, `targets.py`, `compat.py`: A03. Real PostgreSQL tests: Q03.
- `explorer.html` outside lines 186-190; `build_explorer.py`: S01.
- The renderer's `test_renderer*.py`, Playwright, `verify_host.mjs`: S01/S02.
- Removing the `connect-src 'self'` rewrite of the served copy: it stays (CTQ-05 note in `ctq.md`).
- The SPA API's session cookie (`__Host-backend-buddy_session`, CSRF): A02. This package's cookie is the skill's local capability only.
- `packages/explorer/server/requirements.txt`: no new dependency (standard library only).

### 5. May modify

```
packages/explorer/server/serve_explorer.py
packages/explorer/server/test_explorer_http.py       (only the lines and additions enumerated in section 3)
skill/assets/explorer.html                            (lines 186-190 only, the live bridge)
skill/SKILL.md                                        (profiling-service sentences only)
skill/references/advanced-views.md                    (lines 30-36 region: server invocation and description)
docs/features/F22-offline-artifact-and-skill.md       (sections 3 and 14)
docs/reference/limits-and-caps.md                     (A2 bind-address row)
CHANGELOG.md                                          ([Unreleased] Security and Added, prefixed S03:)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror (includes server/); run npm run build so it follows
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json, packages/explorer/package*.json   no dependency change
packages/explorer/server/schema_profiler.py, profile_snapshot.py, snapshot_io.py, test_schema_profiler.py, requirements.txt
packages/explorer/src/**                views, index.tsx, types.ts (LiveConnection at types.ts:9 is unchanged: the bridge keeps the same profile/subtree shape)
skill/assets/explorer.html              everything outside lines 186-190 (S01), in particular :6 CSP and :195 mount call
skill/scripts/**                        S01 / S02
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    S02 owns CI; the python job already discovers test_*.py under packages/explorer/server
scripts/**                              S02
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical; only the served live copy rewrites `connect-src 'none'` -> `connect-src 'self'` | `explorer.html:6`; `serve_explorer.py:68`; `ctq.md` CTQ-05 note | `test_explorer_http.py:183` (kept), `:34` corrected to the full string; `:91` (`assert_sources_unchanged`: the file on disk is never modified) |
| Read-only, bounded, explicitly selected connections (C14): "The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows." | `docs/reference/caveats.md` C14 | `test_metadata_only_does_not_open_a_supplied_database_or_environment_dsn` (`:168`), `test_bound_sql_injection_values_and_unlisted_tables_cannot_mutate_db` (`:285`); the DSN still comes only from `--dsn-env` (`serve_explorer.py:23`, `:35`) |
| Loopback server security tests: changes limited to the section 3 enumeration | `agent-briefs/README.md` frozen list | The verifier diffs `test_explorer_http.py` against the table |
| `LiveConnection` shape `{profile(request, signal), subtree(request, signal)}` and the routes `/api/profile`, `/api/subtree` with their request bodies and defaults | `types.ts:9`; `serve_explorer.py:94-101`; `limits-and-caps.md` A2 | `:236-283` tests unchanged; `:373-407` bridge test (request bodies asserted) |
| Profiler caps and budgets (`schema_profiler.py:73-80`) and patchability | repository-wide list | `test_schema_profiler.py:201-213` untouched |
| Error hygiene: no DSN, path, sample value, or token in any response or log | `serve_explorer.py:109-111`; `SENTINEL` checks throughout the test file | Every existing `assertNotIn(SENTINEL, ...)`; new 422 test adds the same assertion |
| Single-flight lock and 64 KiB body cap | `serve_explorer.py:83-90` | `:295-301` |
| Storage key families, host CSS variables, `normalize()` oracle | repository-wide list | Untouched |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, Python test names prefixed `test_S03_` for new tests (existing names kept), green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F22; F17 has no document yet, so record the F17 impact in `docs/features/README.md`'s F17 row only if the surfaces column changes (it does not)
- [ ] Migration: none, because the loopback server has no persistent state
- [ ] `CHANGELOG.md`: the trailing S03 paragraph under `Security` replaced by fixed entries prefixed `- S03: ` (cookie token, `Sec-Fetch-Site`, allowlist and bind flags, 422, `Server` header)
- [ ] Release-note line in the PR body (operator-facing: new flags and the published-port recipe)
- [ ] Security checklist (interim): state in the PR body that the token appears in no response body, no log, and no CLI output; that `Set-Cookie` carries `HttpOnly; SameSite=Strict; Path=/api`; that no new header is trusted without exact matching; and that the default allowlist is loopback-only
- [ ] Accessibility result: n/a, no UI change (the bridge is non-visual)
- [ ] Performance: none, because no budget applies; note that the single-flight lock is unchanged
- [ ] Caveat text: C14 quoted verbatim in `skill/references/advanced-views.md` if the live-connection paragraph is rewritten; no paraphrase
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed (`skill/assets/extensions/server/serve_explorer.py` and `test_explorer_http.py` follow)
- [ ] All changed paths inside the `may-modify` globs; the `test_explorer_http.py` diff matches section 3 line by line

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order.

```sh
npm run restore
npm run guard
npm test
python3 -m unittest discover -s packages/explorer/server -p 'test_*.py' -v 2>&1 | tee outputs/s03-tests.log | grep -c 'test_S03_'   # >= 6
grep -c 'ok$' outputs/s03-tests.log                                                     # >= 32 + 19 + new S03 tests; 0 FAIL/ERROR lines
grep -c "X-Schema-Token" packages/explorer/server/serve_explorer.py                     # 0
grep -c "X-Schema-Token" skill/assets/explorer.html                                     # 0
grep -c "credentials:'same-origin'" skill/assets/explorer.html                          # 1
grep -c "'token'" packages/explorer/server/serve_explorer.py                             # 0 (the token is never serialised into HTML)
grep -c "img-src data:" packages/explorer/server/test_explorer_http.py                  # 1 (the :34 constant now carries the full string)
git diff --stat main -- skill/assets/explorer.html                                      # only the live-bridge lines changed
npm run build
git status --porcelain skill/assets/extensions | grep -v '^ M skill/assets/extensions/server/' | wc -l   # 0 (mirror changes limited to server/)
```

Manual verification the verifier performs once (documents the published-port recipe):

```sh
python3 skill/assets/extensions/server/serve_explorer.py --html dist/backend-buddy.html --schema fixtures/schemas/small.json --port 8765 --bind 127.0.0.1 --allowed-hosts 127.0.0.1:8765,localhost:8765 --dialect sqlite --database /tmp/none.sqlite 2>&1 | head -1   # startup fails closed on the missing database without printing the path (existing behaviour)
curl -sD - -o /dev/null -H 'Host: localhost:8765' http://127.0.0.1:8765/ | grep -ci 'set-cookie: bb_live=.*HttpOnly.*SameSite=Strict.*Path=/api'   # 1 when a real read-only SQLite file is supplied instead
curl -sD - -o /dev/null http://127.0.0.1:8765/ | grep -ci '^Server:'                                                                                  # 0
```

### 10. Reporting format

Per `agent-briefs/README.md` section 10. "Frozen contracts" must contain the line "Loopback server security tests: changes limited to the S03 brief, section 3" with the list of changed line ranges. Measurements: Python test count before and after. "Out of scope, found" at minimum: `serve_explorer.py:45-46` still logs nothing (RK-21, owner A02/O03).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-16 loopback server behind a published port | Delivers `--bind` and `--allowed-hosts` with exact-match semantics; documents the recipe in `advanced-views.md`; never accepts an unlisted Host |
| RK-01 private-data leakage | Tests keep using the synthetic SQLite database and `SENTINEL`; no real DSN anywhere; the DSN still comes from an environment variable name |
| RK-14 sensitive scalars in outputs | Not changed here (A03 policy); `--include-sample-values` stays an explicit opt-in (`serve_explorer.py:25`) |
| RK-21 no forensics | Not fixed; recorded as out of scope, found |
| RK-22 duplicated source trees | `npm run build` after the change so `skill/assets/extensions/server` follows |
| RK-10 scope creep | No logging, TLS, or auth work in this package |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). |

Open questions for the owner (needed before S03 starts):

1. Whether the served page may keep a non-secret `window.__SCHEMA_LIVE__={"live":true}` flag (this brief's default: it keeps the bridge synchronous, so `:195` is untouched) or whether the flag must also go and the bridge probe `GET /api/session` asynchronously (this would move the `live` decision after the first `mount()` at `:195`, which S01 owns; not recommended in Phase 1).
2. Cookie name: `bb_live` (this brief) or a `__Host-` prefixed name, which browsers require `Secure` for and therefore does not work over plain `http://127.0.0.1`. Default: `bb_live`.
3. Whether `--allowed-hosts` should also accept a bare host without port (matching any port). Default: no; exact `host:port` only (RK-16).
