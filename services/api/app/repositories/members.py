"""Membership and role (work package A02; ``data-model.md`` 3.3).

``workspace_members`` is where RBAC gets its answer: :func:`get_member` is called on every
workspace-scoped request, and its ``role`` is compared against the route's declared minimum by
:mod:`app.auth.rbac`. The role is read per request rather than copied into the session, so a
demotion takes effect on the next request even if the session survives.

:func:`set_member_role` refuses to remove the last owner. That is not a nicety: a workspace with
no owner cannot grant a role again, so the operation would be irreversible through the API and
would have to be repaired with SQL.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session as OrmSession

from app.models import User, WorkspaceMember

__all__ = ['add_member', 'count_role', 'get_member', 'list_members', 'set_member_role']


def get_member(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
) -> WorkspaceMember | None:
    """The membership row for ``user_id`` in ``workspace_id``, or ``None``."""
    return session.get(WorkspaceMember, {'workspace_id': workspace_id, 'user_id': user_id})


def list_members(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
) -> list[tuple[WorkspaceMember, User]]:
    """Every membership in ``workspace_id`` with its account, ordered by email."""
    rows = session.execute(
        select(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(User.email)
    ).all()
    return [(member, user) for member, user in rows]


def count_role(session: OrmSession, *, workspace_id: uuid.UUID, role: str) -> int:
    """How many members of ``workspace_id`` hold ``role``."""
    return int(
        session.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.role == role)
        )
        or 0
    )


def add_member(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    role: str,
) -> WorkspaceMember:
    """Insert a membership. The role has already been checked against the caller's own."""
    member = WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role)
    session.add(member)
    session.flush()
    return member


def set_member_role(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    role: str,
    now: dt.datetime,
) -> WorkspaceMember | None:
    """Change a member's role and return the row, or ``None`` when there is no such member.

    Raises :class:`ValueError` when the change would leave the workspace without an owner; the
    router turns that into a 409, because it is a conflict with the current state rather than a
    malformed request.
    """
    member = get_member(session, workspace_id=workspace_id, user_id=user_id)
    if member is None:
        return None
    if (
        member.role == 'owner'
        and role != 'owner'
        and count_role(session, workspace_id=workspace_id, role='owner') <= 1
    ):
        raise ValueError('a workspace must keep at least one owner')
    member.role = role
    member.updated_at = now
    session.flush()
    return member
