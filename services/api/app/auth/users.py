"""Account queries (work package A02).

These helpers live in :mod:`app.auth` rather than in ``app/repositories`` for a reason that is
part of the data model, not a matter of taste: ``users`` and ``sessions`` are deliberately **not**
tenant-scoped (``docs/architecture/data-model.md`` section 4), because one account may belong to
several workspaces. ``app/repositories`` holds the workspace-scoped helpers, every one of which
takes a ``workspace_id`` -- a rule ``test_A01_repository_helpers_take_a_workspace_id`` enforces
statically. Putting a user lookup there would have meant either weakening that check or inventing
a workspace argument the query does not have. The membership *listing* below is the same case: the
question "which workspaces does this user belong to" is a user-level question by construction.

Every function takes an open :class:`~sqlalchemy.orm.Session` and neither commits nor rolls back;
the request's transaction is owned by :func:`app.core.database.session_dependency`.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import func, select, update
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session as OrmSession

from app.models import User, Workspace, WorkspaceMember
from app.models.base import NAME_CAP

__all__ = [
    'any_user_exists',
    'create_user',
    'get_user',
    'get_user_by_email',
    'increment_failed_login',
    'list_memberships',
    'record_successful_login',
    'set_password_hash',
]


def get_user(session: OrmSession, user_id: uuid.UUID) -> User | None:
    """The account with ``user_id``, or ``None``."""
    return session.get(User, user_id)


def get_user_by_email(session: OrmSession, email: str) -> User | None:
    """The account whose email equals ``email``.

    The comparison is the database's: ``users.email`` is ``citext``, so two accounts cannot differ
    only in letter case and a login does not have to guess how the address was typed.
    """
    return session.scalars(select(User).where(User.email == email.strip())).one_or_none()


def any_user_exists(session: OrmSession) -> bool:
    """Whether the deployment has any account at all. ``app.bootstrap`` refuses when it does."""
    return session.scalar(select(func.count()).select_from(User)) != 0


def create_user(
    session: OrmSession,
    *,
    email: str,
    password_hash: str,
    display_name: str | None = None,
) -> User:
    """Insert an account. The caller has already applied the password policy and hashed it."""
    name = display_name.strip()[:NAME_CAP] if display_name and display_name.strip() else None
    user = User(email=email.strip(), password_hash=password_hash, display_name=name)
    session.add(user)
    session.flush()
    return user


def set_password_hash(user: User, password_hash: str, *, now: dt.datetime) -> None:
    """Replace the stored hash and move ``password_changed_at``, the rotation reference."""
    user.password_hash = password_hash
    user.password_changed_at = now


def increment_failed_login(connection: Connection, *, user_id: uuid.UUID) -> int:
    """Increment and return ``users.failed_login_count``, in ``connection``'s own transaction.

    It takes a :class:`~sqlalchemy.engine.Connection` rather than the request's session because a
    rejected login rolls the request back, and a counter that is undone by the very failure it
    counts is worse than no counter: it reads as zero during an attack. The caller passes
    :meth:`app.core.database.Database.separate_transaction`.

    The counter is for the audit trail and for an operator's judgement (``data-model.md`` 3.2).
    What actually slows an attacker down is the rate limit on the login route. An automatic
    lockout is deliberately not implemented: on a single-tenant deployment whose owner account is
    the only way in, it is a denial-of-service primitive handed to anybody who knows the address.
    """
    updated = connection.execute(
        update(User)
        .where(User.id == user_id)
        .values(failed_login_count=User.failed_login_count + 1)
        .returning(User.failed_login_count)
    ).scalar()
    return int(updated or 0)


def record_successful_login(user: User) -> None:
    """Reset the failure counter after a login that worked."""
    user.failed_login_count = 0


def list_memberships(session: OrmSession, user_id: uuid.UUID) -> list[tuple[Workspace, str]]:
    """Every workspace ``user_id`` belongs to, with the role held there, by workspace name."""
    rows = session.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id, Workspace.deleted_at.is_(None))
        .order_by(Workspace.name)
    ).all()
    return [(workspace, role) for workspace, role in rows]
