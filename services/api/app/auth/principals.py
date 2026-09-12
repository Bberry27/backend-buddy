"""Who is calling: the principal, and how a request is resolved to one (work package A02).

``security-architecture.md`` section 2 names four human principals and one machine one. This
module resolves an HTTP request to whichever of them made it, from exactly two credentials and no
others:

* the session cookie (:mod:`app.auth.cookies`), which identifies an account; or
* ``Authorization: Bearer backend-buddy_...``, an API key, which identifies an account **and** pins the
  workspace and role it may act with.

Rules that matter more than they look:

* **A bearer header is never followed by a cookie fallback.** A request that presents a key we
  cannot accept is unauthenticated, even if the same browser also holds a valid session. Falling
  back would mean a revoked key silently keeps working for anybody whose browser is logged in.
* **A deactivated account authenticates as nobody.** ``users.is_active`` is checked on every
  request, so deactivation takes effect at once rather than when the session happens to expire.
* **The principal carries facts, not permissions.** It says which account, which credential,
  and -- for a key -- which workspace and role were recorded on it. The comparison against a
  route's declared minimum is :mod:`app.auth.rbac`'s job, and it re-reads
  ``workspace_members`` every request so a demotion is never served from a cache.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.orm import Session as OrmSession
from starlette.requests import Request

from app.audit import Actor
from app.auth import api_keys as api_key_auth
from app.auth import sessions as session_store
from app.auth.cookies import CookiePolicy
from app.core.settings import Settings
from app.models import Session, User

__all__ = ['Credential', 'Principal', 'resolve_principal']

_BEARER_PREFIX = 'bearer '


class Credential(StrEnum):
    """Which of the two credentials a request used."""

    SESSION = 'session'
    API_KEY = 'api_key'


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated caller of one request."""

    user_id: uuid.UUID
    email: str
    credential: Credential
    #: The live session row, for a cookie request: the CSRF check and rotation both need it.
    session_row: Session | None = None
    #: For an API-key request: the key's id, and the workspace and role recorded on it.
    api_key_id: uuid.UUID | None = None
    api_key_workspace_id: uuid.UUID | None = None
    api_key_role: str | None = None

    @property
    def actor(self) -> Actor:
        """This principal as an audit actor."""
        return Actor(user_id=self.user_id, api_key_id=self.api_key_id)

    @property
    def uses_cookie(self) -> bool:
        """Whether the request carried an ambient credential, and so needs a CSRF token."""
        return self.credential is Credential.SESSION


def resolve_principal(
    request: Request,
    session: OrmSession,
    settings: Settings,
    *,
    now: dt.datetime | None = None,
) -> Principal | None:
    """The principal behind ``request``, or ``None`` when it is not authenticated."""
    moment = now or dt.datetime.now(dt.UTC)
    header = request.headers.get('authorization', '')
    if header.lower().startswith(_BEARER_PREFIX):
        return _from_api_key(session, header[len(_BEARER_PREFIX) :], now=moment)
    return _from_cookie(request, session, settings, now=moment)


def _from_api_key(session: OrmSession, presented: str, *, now: dt.datetime) -> Principal | None:
    authenticated = api_key_auth.authenticate(session, presented, now=now)
    if authenticated is None:
        return None
    key, owner = authenticated
    return Principal(
        user_id=owner.id,
        email=owner.email,
        credential=Credential.API_KEY,
        api_key_id=key.id,
        api_key_workspace_id=key.workspace_id,
        api_key_role=key.role,
    )


def _from_cookie(
    request: Request,
    session: OrmSession,
    settings: Settings,
    *,
    now: dt.datetime,
) -> Principal | None:
    policy = CookiePolicy.from_settings(settings)
    token = request.cookies.get(policy.session_name)
    if not token:
        return None
    row = session_store.resolve(session, token, settings=settings, now=now)
    if row is None:
        return None
    owner = session.get(User, row.user_id)
    if owner is None or not owner.is_active:
        return None
    return Principal(
        user_id=owner.id,
        email=owner.email,
        credential=Credential.SESSION,
        session_row=row,
    )
