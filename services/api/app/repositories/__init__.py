"""Workspace-scoped query helpers (work packages A02, A03, A04).

One rule governs this package, and it is enforced statically by
``test_A01_repository_helpers_take_a_workspace_id``: **every public function here takes a
``workspace_id`` argument.** ``docs/architecture/data-model.md`` section 4 requires every API
query over a tenant-scoped table to filter by the caller's workspace, and CTQ-07 turns that into a
test; a helper that could be called without a workspace is the shape a cross-tenant read has
whenever one ships.

Two consequences worth knowing before adding a module here:

* A query over a table that is *not* tenant-scoped -- ``users``, ``sessions``,
  ``encryption_keys`` -- does not belong in this package. Those helpers live beside the code that
  needs them (:mod:`app.auth.users`, :mod:`app.auth.sessions`), with the reason recorded in their
  module docstring. Giving them a ``workspace_id`` parameter they do not use would satisfy the
  check and defeat its purpose.
* An identifier from outside the workspace must read as absent, not as forbidden: every getter
  here returns ``None`` for a row in another workspace, and the router turns that into 404. A 403
  would confirm that the id exists, which is the disclosure the IDOR negatives exist to prevent
  (``test_A02_idor_returns_404``).

No helper commits. The request's transaction belongs to
:func:`app.core.database.session_dependency`.
"""

from __future__ import annotations

__all__: list[str] = []
