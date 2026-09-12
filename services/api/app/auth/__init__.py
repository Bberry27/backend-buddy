"""Authentication and authorization (work package A02; ADR-0005).

The package is deliberately split by *what a module can be wrong about*:

* :mod:`app.auth.passwords` -- the policy and argon2id. Nothing else hashes or compares a
  password.
* :mod:`app.auth.tokens` -- minting, sha256, and constant-time comparison. Nothing else decides
  how wide a token is or how it is stored.
* :mod:`app.auth.cookies` -- the two cookie names and their flags, including the ``__Host-``
  prefix and its development fallback.
* :mod:`app.auth.sessions` -- the ``sessions`` row's whole life: create, resolve, rotate, revoke.
* :mod:`app.auth.api_keys` -- authenticating a presented key (creating one is workspace-scoped and
  lives in :mod:`app.repositories.api_keys`).
* :mod:`app.auth.csrf` -- the double-submit token and the origin check.
* :mod:`app.auth.principals` -- resolving a request to the caller behind it.
* :mod:`app.auth.rbac` -- the role ladder, and the dependency that both declares and enforces each
  route's minimum role.
* :mod:`app.auth.users` -- account queries, here rather than in ``app/repositories`` because
  ``users`` is not tenant-scoped (that module's docstring explains why it matters).

CTQ-12 sets the coverage floor for this package at 95 %.
"""

from __future__ import annotations

__all__: list[str] = []
