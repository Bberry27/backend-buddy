Status: current | Owner: Product owner | Last updated: 2026-09-08

# Handoff: where the project stands

Written to be picked up on a different machine with no memory of the session that produced
it. Read this first, then `docs/product-management/roadmap.md` for the plan and
`docs/product-management/agent-briefs/` for the work packages.

The product is **Backend Buddy**. Repository: `Bberry27/backend-buddy`, private.

---

## 1. Start here on a new machine

```sh
git clone git@github.com:Bberry27/backend-buddy.git
cd backend-buddy

npm run restore     # npm ci inside packages/explorer, from the committed lockfile
python -m pip install -r packages/profiler/requirements.txt   # jsonschema, for the 17 contract tests
npm test            # 159 unit + 51 profiler + 40 renderer + 17 contract + 10 fixture
npm run up          # build and start the container
npm run open        # http://127.0.0.1:8080/
```

Prerequisites: Node 22 (`.nvmrc`), npm 10, Python 3.13, Docker with Compose. Set
`PYTHON=python3` if that is your interpreter's name; the scripts handle either. `jsonschema` is
the one Python package the test suite needs; everything the container serves is either standard
library or installed inside the image.

**Your database connections do not travel.** They live encrypted in a Docker volume
(`backend-buddy_state`) on the machine that created them, under a key held only there.
That is deliberate: a credential store that syncs through a repository is a credential
store that leaks. On the new machine, open the admin area and add the connection again.

Also not in git, by design: `.backend-buddy/` (local credential store outside Docker),
`snapshots/` (they describe real schemas), `.venv/`, `node_modules/`, `dist/`.

---

## 2. What works today

A person can run the stack, open one URL, type database credentials into a form, test the
connection, populate the schema, and explore it in thirteen views. That path is verified
end to end against a real PostgreSQL 16.

| Area | State |
|---|---|
| Local admin area (`tools/local_admin`) | Working. Opens on a workspace: a File / Connection / Tools / Help menu bar over the rendered explorer, with the connections table at `/connections`. Switching connection is a menu toggle; each one keeps its own rendered page (`/state/views`, served at `/view/{id}`) and the open one is remembered in `/state/active.json`. Connections list, credential form, test, populate structure, measure row counts, gather column statistics, query time and lock holds (`activity.py`: server views only, nothing written, no live statement text), edit, delete. Editing keeps the password and certificate unless they are retyped, and discards the populated structure when the server, port or database changes. Server-rendered, no build step, no script on any page. 88 tests, in `npm test` and in CI. Dependencies declared in `tools/local_admin/requirements.txt`, which the image installs from. |
| Catalog introspection (`scripts/introspect_pg.py`) | Working for PostgreSQL. Tables, views with definitions, columns, keys, constraints, indexes, declared foreign keys. Metadata only. |
| Thirteen views (`packages/explorer/src` + `skill/assets/explorer.html`) | Working. Four host views, nine React views. |
| Offline artifact (`skill/`) | Working. Single self-contained file, strict Content Security Policy, no network. |
| Docker (`deploy/`) | Working. One port, one command, credentials persisted in a volume. |
| Contract (`packages/contract/schema-graph.v1.json`) | Versioned. TypeScript generated from it; the renderer's `normalize()` is the semantic oracle. Drift checked in `npm test`. |
| Row counts (`tools/local_admin/introspection.py` `measure_row_counts`) | Working. A separate, consented **Measure row counts** action per connection: exact `count(*)` per table, merged into the snapshot, re-rendered. Verified against a real PostgreSQL 16. |
| Column statistics (`tools/local_admin/introspection.py` `measure_column_stats`) | Working. A second consented **Gather column statistics** action: one aggregate pass per table computed by the database, so null fractions and distinct counts cover the whole table rather than a sample. Extremes are retained only for numeric and temporal types. Verified against a real PostgreSQL 16. |
| Sample values | Not offered anywhere. They are the one profiling output that puts real row content on screen, so they need the triple opt-in of WP-A03 `policy.py` (policy allows, connection opts in, request opts in) and the redaction classes that go with it. Nothing writes `sampleValues` today, and both actions strip any left behind. |
| Bounded row-sampling profiler (`packages/explorer/server/schema_profiler.py`) | Exists with 51 tests, still not wired into the admin area, and no longer needed for counts or statistics: both are computed as SQL aggregates instead, which is exact rather than capped at 10,000 rows. It remains the path for the Row fan-out live subtree (S03) and for sample values. |
| Documentation (`docs/`) | Business case, architecture with 8 ADRs, CTQ registry, roadmap, 11 of 22 feature docs, 24 work-package briefs. |
| Security work package S01 | Complete. 31 regression tests. |
| API service (`services/api`) | **In progress, stopped mid-package.** See section 4. |
| Web application (`packages/web`) | Not started. |

---

## 3. Next thing to build, and why

**Sample values, or nothing.** Profiling is done and its dependencies are declared: **Measure
row counts** and **Gather column statistics** both work, are verified against a real
PostgreSQL 16, and their libraries are now declared, audited and carried into the notices.
Schema City has relief, Row fan-out has ratios, the Column Table reports 100% coverage, and a
city with no counts says so instead of looking broken.

The remaining profiling output is **sample values**, and it is the only one that puts real row
content on screen. It needs the triple opt-in and the redaction classes of `WP-A03.md`
`policy.py` (policy allows, connection opts in, request opts in). Do not add it to either
existing action: both state in writing that no row is retained, and both strip any
`sampleValues` an earlier run left behind. It wants a third action, or a checkbox on the
statistics consent page whose default is off.

It is also reasonable to stop here. Nothing else in the roadmap depends on sample values, and
the next real steps are the connections API with the metadata database, sessions and an audit
trail (A02, A04), then the web application (W01).

Details in `docs/product-management/agent-briefs/WP-A03.md`, addendum sections C and D.

After that, in order: the connections API with the metadata database, sessions and an
audit trail (A03, A04), then the web application whose Connections page replaces the
server-rendered one while keeping the same endpoints (W01).

---

## 4. In-progress work you will find on disk

`services/api` was stopped mid-package so a repository-wide rename could touch every file
at once rather than racing an agent writing into those same files. On disk and committed:
the metadata model with Alembic migrations, argon2 accounts, server-side sessions, CSRF,
role checks, API keys, audit events, and a bootstrap command. Its tests are under
`services/api/tests`.

It is **not** finished and **not** wired to anything. Resume from
`docs/product-management/agent-briefs/WP-A02.md`, then A03.

Two frontend packages landed before that stop and are complete: the design-token layer
with theme handling, and the navigation and selection contract with the caveat strings.

---

## 5. Decisions already made, so they are not relitigated

Recorded properly in `docs/architecture/adr/`. In brief:

- **Local and private database targets are allowed by default.** The server-side-request
  deny list is a hosted-mode control; blocking `localhost` in a self-hosted product makes
  it look broken. Cloud metadata endpoints stay denied in every mode.
- **TLS is explicit and never silently downgraded.** Full verification is the default and
  works against a managed PostgreSQL on the system certificate bundle. A verification
  failure reports the cause and leaves the choice of a weaker mode to the user.
- **A saved connection is stored configuration, not a held socket.** Jobs open a
  short-lived connection. The interface says when a connection was last verified rather
  than claiming it is connected.
- **Domains are inferred from table-name prefixes** when a database has one schema, and
  `source.basis` says so. Without it every table lands in one district and the three
  grouping views have nothing to group by.
- **The contract is a committed JSON Schema**, not generated from Python models, because
  the view library is copied into the portable skill and must build without a Python
  toolchain.

---

## 6. Known gaps, stated plainly

- Sample values are not offered by either profiling action, deliberately (section 3).
- A column whose type the database will not aggregate (`json` and `xml` have no equality
  operator) costs its whole table its distinct counts: the statistics pass retries with
  counts alone and labels the table `incomplete`. Per-column degradation would need the
  types resolved from `pg_type` first.
- Seven of `tools/local_admin`'s 42 tests need a real PostgreSQL and skip without one. Provide
  it as `BB_TEST_ADMIN_DSN`; that file's docstring carries a one-line Docker command, and
  `fixtures/sql/pg/seed.sql` seeds 155 tables to profile against.
- `--state-dir` moves the connection store but not the snapshots or the rendered
  artifact, which follow `BB_STATE_DIR` (`server.py` computes them at import). The
  container sets both to the same place, so only tests and hand runs can diverge.
- Live profiling through the skill's loopback server cannot work behind a published
  container port. The `--bind` and `--allowed-hosts` options that fix it are work
  package S03.
- Playwright is not a dependency yet, so six browser suites exist but do not run in
  `npm test`. Work package S02.
- Eleven feature documents and the engineering standards set are unwritten: F08, F11–F14,
  F16–F21, and `docs/engineering/`.
- No continuous-integration gate on accessibility, performance, or visual regression yet.
- The license names Bberry27 and carries a `DRAFT — PENDING LEGAL REVIEW` header. Confirm
  the full legal name before removing it; a copyright notice naming a legal person is
  stronger to enforce than an account handle.

---

## 7. Two things that need you, not an agent

1. **Gate G0 review.** Approve or correct the business case, the CTQ registry, the
   roadmap, and the feature registry. The build proceeds without it, but every later
   acceptance criterion cites those targets.
2. **Legal review of `LICENSE`.**

---

## 8. Things worth knowing that are easy to trip over

- A bare `127.0.0.1` goes to port 80 and nothing serves it. The port is 8080, and
  `npm run open` avoids remembering that.
- Inside the container, `localhost` means the container. To reach a database on your own
  machine use `host.docker.internal`; the connection form says so under the host field.
- On a managed PostgreSQL, a connection timeout usually means the provider firewall has
  no rule for **your machine's public address**, not the container's private one.
- A populated schema is never overwritten by a snapshot sitting in `snapshots/`. Set
  `BB_RERENDER=1` to force the mounted file to win.
- The rendered page *is* refreshed when the views change: the entrypoint compares
  `tools/build_id.py` against `/state/view.build` and re-renders the populated snapshot when
  they differ. That changes the interface, never the data. Before this existed, an upgraded
  image kept serving the interface from the day the schema was populated.
- `npm run guard` must be green before every commit. It also runs in continuous
  integration. Keep the local name denylist outside the repository and point
  `BB_DENYLIST_FILE` at it.
