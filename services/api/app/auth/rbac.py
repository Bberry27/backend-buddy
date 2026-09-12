"""Role-based access control (work package A02; CTQ-07; frozen contract).

The contract: *roles ``owner > admin > reviewer > viewer``; every route declares its role;
an undeclared route fails the matrix test.*

The design decision that makes that testable is that **the declaration is the enforcement**.
There is no table of routes and roles kept beside the code, because a table drifts. A route
declares its minimum role by depending on a :class:`RoleRequirement`, and that same object is what
checks the caller. :func:`route_declarations` reads the declarations back out of the application's
own dependency graph, and ``test_rbac_matrix`` fails when a route has none. A route cannot
therefore be declared one way and enforced another; it can only be undeclared, which fails the
suite, or unenforced, which is the same thing.

Six declarations exist. Four are the frozen workspace ladder, read from ``workspace_members.role``
on every request. The other two are not roles and do not extend the ladder:

* ``public`` -- no credential at all: ``/healthz``, ``/readyz``, ``POST /auth/login``, the SPA
  files. Declared explicitly, so "public" is a decision somebody made rather than a route
  somebody forgot.
* ``authenticated`` -- any principal, no workspace claim: ``/users/me``, ``POST /auth/logout``,
  ``POST /auth/sessions/revoke-all``, ``GET /workspaces``, ``POST /workspaces``. These routes
  have no workspace to be a member of; a user who belongs to none must still be able to see who
  they are, log out, and create their first workspace. Mapping them onto ``viewer`` would have
  meant either inventing a membership or locking a new account out of the product.

Two more rules are enforced here because this is where the request's identity is established:

* **CSRF.** A state-changing request that authenticated with a cookie must carry a valid token
  (:mod:`app.auth.csrf`). API keys are exempt: they are not ambient.
* **IDOR.** A workspace id the principal cannot see answers **404, never 403**
  (``test_A02_idor_returns_404``). A 403 would confirm that the id exists, which is exactly the
  fact a cross-tenant probe is after. Insufficient *role* inside a workspace the caller can see
  is a 403, because there the existence is not a secret.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Final

from fastapi import Depends
from sqlalchemy.orm import Session as OrmSession
from starlette.requests import Request
from starlette.routing import BaseRoute

from app.auth.csrf import require_csrf
from app.auth.principals import Principal, resolve_principal
from app.core.database import session_dependency
from app.core.errors import ApiError, ErrorCode
from app.core.settings import Settings
from app.models import WORKSPACE_ROLES
from app.repositories import members as member_repository
from app.repositories import workspaces as workspace_repository

__all__ = [
    'AUTHENTICATED',
    'DECLARATIONS',
    'PUBLIC',
    'ROLE_LADDER',
    'AdminPrincipal',
    'AnyPrincipal',
    'OwnerPrincipal',
    'PUBLIC_ROUTE',
    'PublicRoute',
    'ReviewerPrincipal',
    'RoleRequirement',
    'ViewerPrincipal',
    'declaration_of',
    'require_role',
    'role_in_workspace',
    'route_declarations',
]

#: The frozen ladder, weakest first. ``data-model.md`` 3.3 and ADR-0005 decision 3.
ROLE_LADDER: Final[tuple[str, ...]] = ('viewer', 'reviewer', 'admin', 'owner')

PUBLIC: Final = 'public'
AUTHENTICATED: Final = 'authenticated'

#: Everything a route may declare.
DECLARATIONS: Final[tuple[str, ...]] = (PUBLIC, AUTHENTICATED, *ROLE_LADDER)

_RANK: Final[dict[str, int]] = {role: index for index, role in enumerate(ROLE_LADDER)}


class PublicRoute:
    """Marker dependency: this route needs no credential, and somebody decided that."""

    declaration: Final = PUBLIC

    def __call__(self) -> None:
        """Nothing to check. The declaration is the point."""
        return None

    def __repr__(self) -> str:
        return 'PublicRoute()'


class RoleRequirement:
    """The dependency that both declares and enforces a route's minimum role."""

    def __init__(self, minimum: str) -> None:
        if minimum not in DECLARATIONS or minimum == PUBLIC:
            raise ValueError(
                f'{minimum!r} is not a role a route can require; use one of '
                f'{(AUTHENTICATED, *ROLE_LADDER)} or declare the route public'
            )
        self.declaration = minimum

    def __repr__(self) -> str:
        return f'RoleRequirement({self.declaration!r})'

    def __call__(
        self,
        request: Request,
        session: Annotated[OrmSession, Depends(session_dependency)],
    ) -> Principal:
        """Authenticate, check CSRF, resolve the role, and return the principal."""
        settings: Settings = request.app.state.settings
        principal = resolve_principal(request, session, settings)
        if principal is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, detail='no usable credential')
        if principal.uses_cookie and principal.session_row is not None:
            require_csrf(request, principal.session_row, settings)
        if self.declaration == AUTHENTICATED:
            return principal
        workspace_id = _requested_workspace(request)
        role = role_in_workspace(session, principal, workspace_id)
        if role is None:
            # Not a member, or not this key's workspace, or the workspace does not exist. All
            # three answer the same way: see the IDOR rule in the module docstring.
            raise ApiError(
                ErrorCode.NOT_FOUND,
                detail=f'principal {principal.user_id} has no role in workspace {workspace_id}',
            )
        if _RANK[role] < _RANK[self.declaration]:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                detail=f'role {role} is below the required {self.declaration}',
            )
        return principal


def require_role(minimum: str) -> RoleRequirement:
    """The dependency declaring and enforcing ``minimum`` on one route."""
    return RoleRequirement(minimum)


def role_in_workspace(
    session: OrmSession,
    principal: Principal,
    workspace_id: uuid.UUID,
) -> str | None:
    """The role ``principal`` holds in ``workspace_id``, or ``None``.

    An API key holds only the role recorded on it, and only in the workspace recorded on it: a key
    is never widened by its owner's memberships elsewhere, which is what makes it safe to give to
    a script. A session holds whatever ``workspace_members`` says right now.
    """
    if workspace_repository.get_workspace(session, workspace_id=workspace_id) is None:
        return None
    if principal.api_key_id is not None:
        if principal.api_key_workspace_id != workspace_id:
            return None
        return principal.api_key_role
    member = member_repository.get_member(
        session,
        workspace_id=workspace_id,
        user_id=principal.user_id,
    )
    return member.role if member is not None else None


def _requested_workspace(request: Request) -> uuid.UUID:
    """The ``workspace_id`` path parameter, or a 404.

    Read from ``request.path_params`` rather than declared as a dependency parameter on purpose:
    declaring it would make FastAPI accept ``?workspace_id=`` as a query parameter on routes that
    have no such path segment, which is a way to ask a question no route intended to answer.
    """
    raw = request.path_params.get('workspace_id')
    if raw is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            detail=(
                f'{request.url.path} requires a workspace role but has no workspace_id path '
                'parameter; declare it authenticated instead'
            ),
        )
    if isinstance(raw, uuid.UUID):
        return raw
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise ApiError(ErrorCode.NOT_FOUND, detail='workspace_id is not a uuid') from None


def declaration_of(route: BaseRoute) -> str | None:
    """The declaration ``route`` carries, or ``None`` when it declares nothing.

    Walks the route's whole dependency graph, so a declaration made on a router, on a single
    route, or through a nested dependency is found the same way. Two different declarations on one
    route is a programming error and raises: it would be ambiguous which one is enforced.
    """
    dependant = getattr(route, 'dependant', None)
    if dependant is None:
        return None
    found: set[str] = set()
    stack = [dependant]
    while stack:
        current = stack.pop()
        call = getattr(current, 'call', None)
        if isinstance(call, RoleRequirement | PublicRoute):
            found.add(call.declaration)
        stack.extend(getattr(current, 'dependencies', ()))
    if len(found) > 1:
        raise ValueError(f'{route} declares more than one role: {sorted(found)}')
    return found.pop() if found else None


def route_declarations(routes: list[BaseRoute]) -> list[tuple[str, str, str | None]]:
    """``(method, path, declaration)`` for every route, sorted; the RBAC matrix.

    Consumed by ``test_rbac_matrix``, which fails on a ``None``, and by
    :mod:`app.export_openapi`, which writes the declaration into the OpenAPI document as
    ``x-backend-buddy-role`` so the matrix is reviewable without running the suite.
    """
    matrix: list[tuple[str, str, str | None]] = []
    for route in routes:
        path = getattr(route, 'path', None)
        if not isinstance(path, str):
            continue
        methods = getattr(route, 'methods', None) or {'GET'}
        declaration = declaration_of(route)
        for method in sorted(methods):
            if method in {'HEAD', 'OPTIONS'}:
                continue
            matrix.append((method, path, declaration))
    return sorted(matrix, key=lambda entry: (entry[1], entry[0]))


#: The one marker instance every public route depends on. A singleton rather than a factory
#: because :func:`declaration_of` recognises the dependency by the object it finds in the graph.
PUBLIC_ROUTE: Final = PublicRoute()


#: Annotated aliases, so a route reads as its own access-control statement.
AnyPrincipal = Annotated[Principal, Depends(require_role(AUTHENTICATED))]
ViewerPrincipal = Annotated[Principal, Depends(require_role('viewer'))]
ReviewerPrincipal = Annotated[Principal, Depends(require_role('reviewer'))]
AdminPrincipal = Annotated[Principal, Depends(require_role('admin'))]
OwnerPrincipal = Annotated[Principal, Depends(require_role('owner'))]

# The ladder here and the check constraint in the database are the same four values. If
# ``data-model.md`` 3.3 ever gains a role, this is where the two meet: importing the API with a
# ladder that does not match the database fails immediately rather than at the first request that
# needs the new role.
if set(ROLE_LADDER) != set(WORKSPACE_ROLES):
    raise RuntimeError(
        f'the RBAC ladder {ROLE_LADDER} must equal workspace_members.role {tuple(WORKSPACE_ROLES)}'
    )
