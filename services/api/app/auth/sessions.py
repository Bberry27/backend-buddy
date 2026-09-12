"""Server-side sessions: create, resolve, rotate, revoke (work package A02; ADR-0005).

The cookie carries a 256-bit opaque token and nothing else. Everything that decides whether a
request is authenticated lives in the ``sessions`` row, which is why a session can be revoked at
all -- the property a signed token in a cookie does not have.

Lifetimes are two, both from the environment contract:

* **idle**: ``BB_SESSION_IDLE_MINUTES`` since ``last_seen_at``. Every resolved request moves
  ``last_seen_at``, so an active reviewer is never logged out mid-review.
* **absolute**: ``BB_SESSION_ABSOLUTE_HOURS`` since ``created_at``, stored in ``expires_at`` at
  creation so a purge job needs no arithmetic and an index on ``expires_at`` is enough.

Rotation. :func:`rotate` is the whole of it: a new row with a new token, and the old row revoked
in the same transaction.

* **On login** it makes session fixation impossible: whatever token the browser arrived with is
  revoked, so a token planted before authentication cannot be authenticated afterwards.
* **On a role change** the user's sessions are revoked by :func:`revoke_all`, because the role a
  request is authorised against must not outlive the decision that changed it. The role is read
  from ``workspace_members`` on every request, so revocation is belt and braces -- but it is also
  what makes "the demotion took effect immediately" a true statement rather than an
  implementation detail nobody checked. When the demoted user is the caller, the caller's own
  session is rotated instead of revoked, so an owner who edits their own membership is not thrown
  out by their own click.

``last_seen_at``, ``user_agent`` and ``ip`` are audit fields. The user agent is truncated to
``NAME_CAP``: it is attacker-controlled text on its way into a database column.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any, Final, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.orm import Session as OrmSession

from app.auth import tokens
from app.core.settings import Settings
from app.models import Session
from app.models.base import NAME_CAP

__all__ = ['MintedSession', 'create', 'resolve', 'revoke', 'revoke_all', 'rotate']

#: ``sessions.user_agent`` is display and audit text, so it is capped like every other name.
USER_AGENT_CAP: Final = NAME_CAP


@dataclass(frozen=True, slots=True)
class MintedSession:
    """A new session and the two tokens that leave the server exactly once."""

    row: Session
    token: str
    csrf_token: str


def create(
    session: OrmSession,
    *,
    user_id: uuid.UUID,
    settings: Settings,
    now: dt.datetime,
    user_agent: str | None = None,
    ip: str | None = None,
) -> MintedSession:
    """Insert a session row for ``user_id`` and mint its session and CSRF tokens."""
    token = tokens.mint_token()
    csrf_token = tokens.mint_token()
    row = Session(
        token_hash=tokens.digest(token),
        user_id=user_id,
        csrf_token_hash=tokens.digest(csrf_token),
        created_at=now,
        last_seen_at=now,
        expires_at=now + dt.timedelta(hours=settings.session_absolute_hours),
        user_agent=user_agent[:USER_AGENT_CAP] if user_agent else None,
        ip=ip,
    )
    session.add(row)
    session.flush()
    return MintedSession(row=row, token=token, csrf_token=csrf_token)


def resolve(
    session: OrmSession,
    token: str,
    *,
    settings: Settings,
    now: dt.datetime,
) -> Session | None:
    """The live session for ``token``, or ``None``.

    ``None`` covers every reason equally -- no such token, revoked, past its absolute expiry, idle
    for too long -- because the client is told the same thing in each case and the log records
    which it was.

    The lookup is by digest on a unique index, so no token is ever compared in Python; the
    constant-time comparison in :func:`app.auth.tokens.matches` still guards the one place a value
    is checked against a row that was found another way (the CSRF token).
    """
    row = session.scalars(
        select(Session).where(Session.token_hash == tokens.digest(token))
    ).one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    if row.expires_at <= now:
        return None
    idle_limit = dt.timedelta(minutes=settings.session_idle_minutes)
    if row.last_seen_at + idle_limit <= now:
        return None
    row.last_seen_at = now
    return row


def revoke(row: Session, *, now: dt.datetime) -> None:
    """Mark one session revoked. Idempotent: an already revoked row keeps its first timestamp."""
    if row.revoked_at is None:
        row.revoked_at = now


def revoke_all(session: OrmSession, *, user_id: uuid.UUID, now: dt.datetime) -> int:
    """Revoke every live session of ``user_id`` and return how many were revoked.

    This is both the ``POST /auth/sessions/revoke-all`` endpoint and the role-change hook.
    """
    # ``rowcount`` is a cursor-level property; the ORM's Session.execute is typed as returning the
    # more general Result, so the DML result is narrowed here rather than counted with a second
    # query.
    result = cast(CursorResult[Any], session.execute(
        update(Session)
        .where(Session.user_id == user_id, Session.revoked_at.is_(None))
        .values(revoked_at=now)
    ))
    return int(result.rowcount or 0)


def rotate(
    session: OrmSession,
    *,
    user_id: uuid.UUID,
    settings: Settings,
    now: dt.datetime,
    previous: Session | None = None,
    user_agent: str | None = None,
    ip: str | None = None,
) -> MintedSession:
    """Revoke ``previous`` (when there is one) and mint a fresh session for ``user_id``."""
    if previous is not None:
        revoke(previous, now=now)
    return create(
        session,
        user_id=user_id,
        settings=settings,
        now=now,
        user_agent=user_agent,
        ip=ip,
    )
