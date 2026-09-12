"""``app``: the metadata store, API, and worker for Backend Buddy.

Work package A01 creates the package with two modules: :mod:`app.db`, which resolves the metadata
store URL from ``BB_DB_*`` and the password secret file, and :mod:`app.models`, the declarative
model of the fifteen tables in ``docs/architecture/data-model.md`` section 3.

Nothing here opens a connection on import and nothing discovers credentials: a password is read
only from the file named by ``BB_DB_PASSWORD_FILE``, and only when an engine is actually built.
The FastAPI application, the auth and crypto packages, and the worker arrive with A02-A04.
"""

from __future__ import annotations

__all__ = ['__version__']

#: Package version, kept in step with ``services/api/pyproject.toml``.
__version__ = '0.1.0'
