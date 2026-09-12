"""The API's routers (work package A02: ``auth``, ``workspaces``, ``users``, ``api_keys``,
``health``; A03 adds ``connections``; A04 adds jobs, snapshots, projects, reviews, preferences,
layouts and exports).

Every route in every module here declares its minimum role, or declares itself public, through
:mod:`app.auth.rbac`. ``test_rbac_matrix`` walks the assembled application and fails on a route
that declares neither, so adding a router without a declaration breaks the suite rather than
shipping an unguarded endpoint.
"""

from __future__ import annotations

__all__: list[str] = []
