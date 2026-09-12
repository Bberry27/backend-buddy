"""Request and response models (work package A02; CTQ-07).

Two rules, both testable from the OpenAPI document rather than from the handlers:

1. **No response model has a field that could carry a secret.** ``test_A02_no_secret_fields_in_
   responses`` walks every schema in ``openapi.json`` and fails on a property whose name contains
   ``password``, ``dsn``, ``secret``, ``token``, ``hash``, ``key_id`` or ``encrypted``. Asserting
   on the schema rather than on a handler is deliberate: a handler can be tested only for the
   cases somebody thought of, while the schema is the exhaustive statement of what *can* be
   returned. Two exceptions exist, both required by the design and both named in that test with
   their reason:

   * ``ApiKeyCreated.apiKey`` -- the key's plaintext, "shown once at creation"
     (``data-model.md`` 3.5, ADR-0005 decision 4). It is never stored and never returned again.
   * ``Login.csrfToken`` and ``Csrf.csrfToken`` -- the double-submit token, which the SPA has to
     be able to read (``security-architecture.md`` section 7). It is useless without the session
     cookie.

2. **Every request model forbids unknown fields.** A body with a field the model does not declare
   is rejected rather than ignored, so a client that thinks it is setting ``role`` on a route that
   does not accept one finds out.

Field names are camelCase over the wire, because the consumer is a TypeScript SPA (W01 generates
its client from this document), and snake_case in Python. The alias generator does both; nothing
is spelled twice.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from app.auth.passwords import MAXIMUM_LENGTH, MINIMUM_LENGTH
from app.auth.rbac import ROLE_LADDER
from app.models.base import NAME_CAP, WORKSPACE_SLUG_CAP, WORKSPACE_SLUG_PATTERN

__all__ = [
    'Acknowledgement',
    'ApiKeyCreateRequest',
    'ApiKeyCreated',
    'ApiKeyResponse',
    'CsrfResponse',
    'DisplayName',
    'EmailAddress',
    'Health',
    'LoginRequest',
    'LoginResponse',
    'MeResponse',
    'MemberAddRequest',
    'MemberResponse',
    'MemberRoleRequest',
    'PasswordSpecification',
    'Readiness',
    'RevokeAllResponse',
    'Role',
    'UserResponse',
    'WorkspaceCreateRequest',
    'WorkspaceResponse',
    'WorkspaceSlug',
]

#: The role ladder as a type. Written out because a ``Literal`` must be static; the guard at the
#: bottom of this module fails at import if it ever stops matching :data:`app.auth.rbac.
#: ROLE_LADDER` and therefore ``workspace_members.role``.
Role = Literal['viewer', 'reviewer', 'admin', 'owner']

#: An email address, bounded and shaped. Deliberately not ``pydantic.EmailStr``: that pulls in
#: ``email-validator`` and, with it, a DNS library, to check a syntax this expression already
#: covers. 254 characters is the SMTP maximum.
EmailAddress = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=254,
        pattern=(
            r'^[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
            r'(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
        ),
    ),
]

#: A workspace slug: the ``:ws`` URL segment (``data-model.md`` 3.1).
WorkspaceSlug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=WORKSPACE_SLUG_CAP,
        pattern=WORKSPACE_SLUG_PATTERN,
    ),
]

#: Display text: bounded at the renderer's ``NAME_CAP`` so one cap governs the whole product.
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=NAME_CAP)]


class _Model(BaseModel):
    """Base for every model here: camelCase over the wire, no unknown fields."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='forbid',
        from_attributes=True,
    )


# -- Requests ----------------------------------------------------------------------------------


class LoginRequest(_Model):
    """``POST /auth/login``."""

    email: EmailAddress
    #: Bounded, not validated against the policy: the policy applies when a password is *set*.
    #: A login body is bounded only so that hashing cannot be turned into a denial of service.
    password: Annotated[str, Field(min_length=1, max_length=MAXIMUM_LENGTH)]


class WorkspaceCreateRequest(_Model):
    """``POST /workspaces``."""

    slug: WorkspaceSlug
    name: DisplayName


class MemberAddRequest(_Model):
    """``POST /workspaces/{workspace_id}/members``: grant an existing account a role.

    A02 creates no accounts beyond the first owner (``python -m app.bootstrap``), so the address
    must already exist; an unknown address answers 404 like any other absent target, which also
    means this route cannot be used to find out whether an address has an account.
    """

    email: EmailAddress
    role: Role


class MemberRoleRequest(_Model):
    """``PUT /workspaces/{workspace_id}/members/{user_id}``."""

    role: Role


class ApiKeyCreateRequest(_Model):
    """``POST /workspaces/{workspace_id}/api-keys``."""

    name: DisplayName
    role: Role
    #: Optional expiry. A key without one is revocable but never expires, so the UI says so.
    expires_at: dt.datetime | None = None


class PasswordSpecification(_Model):
    """The password policy, so a client can state the rules before a user types (F20 B-numbered).

    Advertising the minimum is not a disclosure; leaving a user to discover it by rejection is
    just bad manners.
    """

    minimum_length: int = MINIMUM_LENGTH
    maximum_length: int = MAXIMUM_LENGTH
    common_password_check: bool = True


# -- Responses ---------------------------------------------------------------------------------


class UserResponse(_Model):
    """An account, as the API returns it. No hash, no counter, no session."""

    id: uuid.UUID
    email: str
    display_name: str | None
    is_active: bool
    created_at: dt.datetime


class WorkspaceResponse(_Model):
    """A workspace and, when the caller is a member, the role they hold in it."""

    id: uuid.UUID
    slug: str
    name: str
    role: Role | None = None
    created_at: dt.datetime


class MemberResponse(_Model):
    """One membership of a workspace."""

    user_id: uuid.UUID
    email: str
    display_name: str | None
    role: Role
    created_at: dt.datetime
    updated_at: dt.datetime


class ApiKeyResponse(_Model):
    """An API key's *metadata*. The secret is not here and cannot be recovered."""

    id: uuid.UUID
    name: str
    key_prefix: str
    role: Role
    user_id: uuid.UUID
    created_at: dt.datetime
    expires_at: dt.datetime | None
    revoked_at: dt.datetime | None
    last_used_at: dt.datetime | None


class ApiKeyCreated(_Model):
    """The one response in the API that carries a credential, and only at creation."""

    key: ApiKeyResponse
    #: The plaintext key, shown once. Store it now or create another one.
    api_key: str


class LoginResponse(_Model):
    """What a successful login returns: who you are, where you may go, and the CSRF token."""

    user: UserResponse
    workspaces: list[WorkspaceResponse]
    csrf_token: str
    session_expires_at: dt.datetime


class CsrfResponse(_Model):
    """``GET /auth/csrf``: a fresh copy of the session's CSRF token for a reloaded SPA."""

    csrf_token: str


class MeResponse(_Model):
    """``GET /users/me``: the caller and their memberships."""

    user: UserResponse
    workspaces: list[WorkspaceResponse]
    credential: Literal['session', 'api_key']
    password_policy: PasswordSpecification = PasswordSpecification()


class RevokeAllResponse(_Model):
    """``POST /auth/sessions/revoke-all``."""

    revoked_sessions: int


class Acknowledgement(_Model):
    """A state change with nothing to return but the fact that it happened."""

    status: Literal['ok'] = 'ok'


class Health(_Model):
    """``GET /healthz``: this process is running."""

    status: Literal['ok'] = 'ok'


class Readiness(_Model):
    """``GET /readyz``: the three checks from ``deployment-architecture.md`` section 6.

    ``reason`` is a short, fixed phrase when a check fails -- never a driver message, a URL, or a
    fingerprint (RK-08 says "reports a fingerprint mismatch with a redacted reason").
    """

    status: Literal['ready', 'not_ready']
    database: bool
    migrations: bool
    master_key: bool
    reason: str | None = None


if list(ROLE_LADDER) != ['viewer', 'reviewer', 'admin', 'owner']:
    raise RuntimeError(
        f'the Role literal in this module must equal app.auth.rbac.ROLE_LADDER {ROLE_LADDER}'
    )
