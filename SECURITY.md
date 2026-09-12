# Security Policy

## Reporting a vulnerability

Report security issues privately. Do not open a public issue, discussion, or pull request that describes a vulnerability before a fix is available.

- Preferred: GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). It is available on private repositories and keeps the report and the fix in one place. Enable it once under Settings, Code security.
- Include the affected component and commit, reproduction steps or a proof of concept, your assessment of impact, and whether the issue involves customer data or credentials.
- Expect an acknowledgement within a week and a disclosure timeline agreed with you. This is a single-maintainer project, so response times are best effort, not contractual. Reporters who wish to be credited are credited when the fix is released.

If private vulnerability reporting is not yet enabled, contact the repository owner named in `.github/CODEOWNERS` directly through a private channel. There is no security mailing address for this project; it is maintained by one person.

## Supported versions

The project is pre-release. Only the `main` branch receives security fixes. There are no tagged releases with support commitments yet; the first supported release line will be recorded here when it ships.

| Version | Supported |
|---|---|
| `main` | Yes |
| Any other branch, tag, or fork | No |

## Hardening summary

What the current baseline does to protect users and their data:

- **Offline artifact CSP.** `dist/backend-buddy.html` ships with `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`. It cannot load remote scripts, styles, or images and cannot make network requests. CI asserts that `connect-src 'none'` is present in every build; the full string is kept byte-identical by policy.
- **Read-only profiler bounds.** The profiler opens read-only transactions, uses only identifiers allowlisted from the loaded graph (always quoted), binds every value, and caps rows (10,000 per table), traversal depth (4), bound parameters (400), batch keys (100), queries (512), wall time (5 s), scalar length (256 characters), and functional-dependency columns (32). Nothing connects on import and no credentials are discovered from the environment.
- **Explicit connections only.** SQLite requires an explicit file path and never creates a database. PostgreSQL requires the *name* of an environment variable holding the DSN; the DSN itself is never on the command line, in logs, or in the page.
- **Loopback server.** `serve_explorer.py` binds `127.0.0.1`, requires an exact `Host` match on every request and an exact `Origin` match on `POST`, gates profiling behind a per-process capability token compared in constant time, and serialises operations behind a single lock. Only the served copy relaxes `connect-src` to `'self'`; the static artifact stays offline. Moving the token out of the page into a cookie and adding bind and allowed-host options is scheduled for S03.
- **Secrets never in the browser.** Connection credentials are not embedded in snapshots, the artifact, or the bundle. Sample values are opt-in and capped at three bounded scalars per column; min/max are treated as potentially sensitive and profiled only for the requested scope.
- **Draft SQL is never executed.** Validation SQL and migration drafts are displayed for a supported dialect and never run by the explorer.
- **Supply chain.** Dependencies are locked; CI runs gitleaks, `npm audit --omit=dev --audit-level=high`, pip-audit, and a third-party notices drift check on every pull request, on every push to `main`, and weekly.
- **Private data hygiene.** Only synthetic fixtures are tracked; `scripts/private_data_guard.mjs` rejects private and QA-output paths, images outside `docs/assets/`, QA reports, oversize files, and machine-local paths in CI and before commits, and applies a local name denylist that is never committed (`BB_DENYLIST_FILE`).

## Known findings

Findings that are known and scheduled are recorded in the Security subsection of [CHANGELOG.md](CHANGELOG.md) together with the work package that closes them. Until they are closed, build artifacts only from snapshots you trust and do not serve the artifact to untrusted users.

## Full policy

Threat-model scope, trust boundaries, the baseline findings with their owning work packages, and the private-data rules live in [`docs/architecture/security-architecture.md`](docs/architecture/security-architecture.md) and [ADR-0007](docs/architecture/adr/ADR-0007-private-data-and-fixture-policy.md). The engineering security policy with the release security checklist and the response process is the D03 deliverable `docs/engineering/security-policy.md`; until it lands, this file and the two documents above are the policy.
