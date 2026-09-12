"""Workspace rows (work package A02; ``data-model.md`` 3.1).

``workspaces`` is the tenant itself, so "scoped by ``workspace_id``" means "addressed by id":
every helper takes the id of the workspace it is about, and a soft-deleted workspace reads as
absent.

The id is supplied by the caller rather than defaulted by the database. The column does have a
``gen_random_uuid()`` default, but a create that returns a row whose id was invented server-side
forces a round trip before anything else can reference it -- and the audit row for the create has
to name the target. Generating it in the caller costs nothing and keeps the two in step.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.models import Workspace
from app.models.base import NAME_CAP

__all__ = ['create_workspace', 'get_workspace', 'workspace_slug_taken']


def get_workspace(session: OrmSession, *, workspace_id: uuid.UUID) -> Workspace | None:
    """The workspace with ``workspace_id``, or ``None`` when it is absent or soft-deleted."""
    return session.scalars(
        select(Workspace).where(Workspace.id == workspace_id, Workspace.deleted_at.is_(None))
    ).one_or_none()


def workspace_slug_taken(session: OrmSession, *, workspace_id: uuid.UUID | None, slug: str) -> bool:
    """Whether ``slug`` is already used by a workspace other than ``workspace_id``.

    ``workspace_id`` is the row being renamed, and ``None`` when the workspace does not exist yet;
    excluding it is what lets a rename keep its own slug.
    """
    statement = select(Workspace.id).where(Workspace.slug == slug)
    if workspace_id is not None:
        statement = statement.where(Workspace.id != workspace_id)
    return session.scalars(statement).first() is not None


def create_workspace(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    slug: str,
    name: str,
) -> Workspace:
    """Insert a workspace with the id the caller chose.

    The slug's character set and length are constrained by the database
    (``ck_workspaces_slug_pattern``, ``ck_workspaces_slug_length``) and by the request model, so
    this helper does not re-validate them; it caps ``name`` because that is display text.
    """
    workspace = Workspace(id=workspace_id, slug=slug, name=name[:NAME_CAP])
    session.add(workspace)
    session.flush()
    return workspace
