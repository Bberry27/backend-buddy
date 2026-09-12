"""Projects and snapshots (``docs/architecture/data-model.md`` 3.6-3.7).

``snapshots`` is immutable after insert except for ``deleted_at``: ``graph`` is the output of
``normalize()``, contract-valid, and ``sha256`` is the digest of the canonical JSON bytes as
stored, so a row can be verified without re-normalising it. ``contract_version`` is copied from
``graph.contractVersion`` (ADR-0003); the listing columns are computed at insert by A04 and are
never taken from anywhere but the graph in hand.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, Text, UniqueConstraint, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    CONTRACT_VERSION_PATTERN,
    JSONB,
    NAME_CAP,
    PROJECT_KEY_PATTERN,
    SNAPSHOT_ORIGINS,
    Base,
    WorkspaceScoped,
    created_at_column,
    digest_check,
    digest_column,
    enum_check,
    length_check,
    non_negative_check,
    timestamp_column,
    updated_at_column,
    uuid_pk_column,
)

__all__ = ['Project', 'Snapshot']


class Project(WorkspaceScoped, Base):
    """A project inside a workspace (data-model.md 3.6).

    ``key`` is the SchemaGraph ``project.key`` and keeps the character set ``normalize()``
    enforces, because browser-side storage isolation continues to key on it (C13). The unique
    constraint ``(workspace_id, key)`` is also the index leading with ``workspace_id``.
    """

    __tablename__ = 'projects'
    __table_args__ = (
        UniqueConstraint('workspace_id', 'key'),
        CheckConstraint(f"key ~ '{PROJECT_KEY_PATTERN}'", name='key_pattern'),
        length_check('key', NAME_CAP),
        length_check('name', NAME_CAP),
        length_check('default_dialect', NAME_CAP),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    key: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    #: Hint for uploads only; a snapshot's own ``project.dialect`` wins.
    default_dialect: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()
    #: Retention: soft delete, cascading logically (not by constraint) to snapshots.
    deleted_at: Mapped[dt.datetime | None] = timestamp_column()


class Snapshot(WorkspaceScoped, Base):
    """One immutable SchemaGraph version (data-model.md 3.7)."""

    __tablename__ = 'snapshots'
    __table_args__ = (
        enum_check('origin', SNAPSHOT_ORIGINS),
        digest_check('sha256', name='sha256_digest'),
        CheckConstraint(
            f"contract_version ~ '{CONTRACT_VERSION_PATTERN}'",
            name='contract_version_pattern',
        ),
        non_negative_check('table_count'),
        non_negative_check('column_count'),
        non_negative_check('link_count'),
        non_negative_check('size_bytes'),
        # Listing query: newest snapshots of one project inside one workspace.
        Index(
            'ix_snapshots_workspace_id_project_id_created_at',
            'workspace_id',
            'project_id',
            text('created_at desc'),
        ),
        # Upload dedupe by content digest.
        Index('ix_snapshots_sha256', 'sha256'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    project_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('projects.id'), nullable=False)
    #: The normalized SchemaGraph. Validated against the contract and by ``normalize()`` (A04).
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: sha256 of the canonical JSON bytes as stored.
    sha256: Mapped[bytes] = digest_column()
    #: Copied from ``graph.contractVersion``, for example ``1.0``.
    contract_version: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    #: Merge base for a ``profile`` result, and the left side of a diff.
    parent_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('snapshots.id'),
        nullable=True,
    )
    #: Copy of ``graph.source`` so a listing needs no ``graph`` read (C09).
    source: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    table_count: Mapped[int] = mapped_column(Integer, nullable=False)
    column_count: Mapped[int] = mapped_column(Integer, nullable=False)
    link_count: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Size of the stored canonical JSON. The upload cap itself is an A04 decision.
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Null when the row came from an API key or from a job rather than from a signed-in user.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('users.id'),
        nullable=True,
    )
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Retention: soft delete; the purge job removes ``graph`` after a grace period (A04).
    deleted_at: Mapped[dt.datetime | None] = timestamp_column()
