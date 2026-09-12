"""Review decisions, ERD layouts, and user preferences (``data-model.md`` 3.12-3.14).

These three tables are the server-side records behind the browser storage the artifact uses
today, which C13 keys by ``project.key`` and graph fingerprint:

* ``review_decisions`` replaces ``backend-buddy:<project.key>:reviews``; a decision follows the
  project across snapshots, and ``snapshot_id`` records where it was taken;
* ``erd_layouts`` replaces ``backend-buddy-erd:v1:<project.key>:<fingerprint>``;
* ``user_preferences`` replaces the host theme key.

``finding_id`` is opaque: the schema does not encode the current ``table|rule|columns|signature``
form, so a producer change (L-06 sha256 signatures) needs no migration (RK-13).
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, ClassVar

from sqlalchemy import ForeignKey, Index, Text, UniqueConstraint, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    FINDING_ID_CAP,
    JSONB,
    NAME_CAP,
    REVIEW_DECISIONS,
    TEXT_CAP,
    THEMES,
    Base,
    WorkspaceScoped,
    created_at_column,
    enum_check,
    length_check,
    updated_at_column,
    uuid_pk_column,
)

__all__ = ['SHARED_LAYOUT_USER_ID', 'ErdLayout', 'ReviewDecision', 'UserPreference']

#: ``erd_layouts.user_id`` is null for a layout shared by the whole workspace. A unique index
#: cannot treat two nulls as equal, so the index keys on ``coalesce(user_id, <this uuid>)``.
SHARED_LAYOUT_USER_ID = '00000000-0000-0000-0000-000000000000'


class ReviewDecision(WorkspaceScoped, Base):
    """A recorded decision about one finding (data-model.md 3.12)."""

    __tablename__ = 'review_decisions'
    __table_args__ = (
        UniqueConstraint('project_id', 'finding_id'),
        enum_check('decision', REVIEW_DECISIONS),
        length_check('finding_id', FINDING_ID_CAP),
        length_check('note', TEXT_CAP),
        Index('ix_review_decisions_workspace_id_project_id', 'workspace_id', 'project_id'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: Decisions follow the project, not a single snapshot.
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('projects.id'), nullable=False)
    #: Opaque, length-capped identifier of the finding the decision is about.
    finding_id: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_by: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id'), nullable=False)
    #: The snapshot in which the decision was made, for provenance.
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('snapshots.id'),
        nullable=True,
    )
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()


class ErdLayout(WorkspaceScoped, Base):
    """Persisted node positions for a view of one snapshot (data-model.md 3.13)."""

    __tablename__ = 'erd_layouts'
    __table_args__ = (
        length_check('view', NAME_CAP),
        length_check('fingerprint', NAME_CAP),
        # One layout per snapshot, view, and user, counting the shared layout as one owner.
        Index(
            'uq_erd_layouts_snapshot_id_view_user_id',
            'snapshot_id',
            'view',
            text(f"coalesce(user_id, '{SHARED_LAYOUT_USER_ID}'::uuid)"),
            unique=True,
        ),
        Index('ix_erd_layouts_workspace_id_snapshot_id', 'workspace_id', 'snapshot_id'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey('snapshots.id'),
        nullable=False,
    )
    #: Null means a layout shared with the whole workspace.
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('users.id'), nullable=True)
    #: ``living`` at MVP; other views may persist a layout later without a migration.
    view: Mapped[str] = mapped_column(Text, nullable=False)
    #: Graph fingerprint, so a layout is not reapplied to a structurally different graph.
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    #: ``{version: 1, positions: {id: {x, y, pinned}}}``, validated by the API with the same
    #: bounds the browser applies.
    positions: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()


class UserPreference(WorkspaceScoped, Base):
    """Per-user, per-workspace preferences (data-model.md 3.14).

    The primary key is ``(user_id, workspace_id)``, so the index leading with ``workspace_id``
    is declared explicitly rather than inherited from the key.
    """

    __tablename__ = 'user_preferences'
    __workspace_primary_key__: ClassVar[bool] = True
    # data-model.md 3.14 lists user_id first, so the key reads (user_id, workspace_id).
    __workspace_sort_order__: ClassVar[int] = 50
    __table_args__ = (
        enum_check('theme', THEMES),
        Index('ix_user_preferences_workspace_id', 'workspace_id'),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey('users.id'),
        primary_key=True,
        nullable=False,
    )
    theme: Mapped[str] = mapped_column(Text, nullable=False, server_default='system')
    #: Null means "follow the operating system".
    reduced_motion: Mapped[bool | None] = mapped_column(nullable=True)
    #: Allowlisted keys only, validated in the API.
    prefs: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()
