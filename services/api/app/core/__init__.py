"""Cross-cutting foundations of the API (work package A02).

Five modules, each with one job:

* :mod:`app.core.settings` -- the ``BB_*`` environment contract from
  ``docs/architecture/deployment-architecture.md`` section 4, read once at startup, with the
  secret *files* read lazily and an unknown ``BB_*`` variable failing startup.
* :mod:`app.core.logging` -- structlog JSON to stdout, the request-id middleware, and the
  redaction processor that keeps DSNs, passwords, tokens and sampled values out of every line.
* :mod:`app.core.database` -- the engine and session factory over :mod:`app.db`, plus the
  request-scoped session dependency.
* :mod:`app.core.errors` -- fixed client-facing error strings; details reach the redacted log
  only (the pattern at ``packages/explorer/server/serve_explorer.py:109-111``).
* :mod:`app.core.http` -- the security headers and the two Content Security Policies from
  ``docs/architecture/security-architecture.md`` section 6.

:mod:`app.core.api_models` holds the request and response models; :mod:`app.core.caveats`
mirrors the canonical caveat wording so no server-side message paraphrases it.

Importing any of them performs no I/O and opens no connection.
"""

from __future__ import annotations

__all__: list[str] = []
