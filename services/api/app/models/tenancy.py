"""Tenancy and identity (``docs/architecture/data-model.md`` 3.1-3.5).

``workspaces`` is the tenant; ``users`` and ``sessions`` are deliberately *not* tenant-scoped,
because a user may belong to several workspaces through ``workspace_members`` and a session is
user-level (data-model.md section 4).

No secret is stored in a readable form. ``users.password_hash`` holds an argon2id hash (A02);
``sessions.token_hash``, ``sessions.csrf_token_hash`` and ``api_keys.key_hash`` hold sha256
digests of tokens that are shown once and never stored (security-architecture.md section 4).
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import ClassVar

from sqlalchemy import CheckConstraint, ForeignKey, Index, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    API_KEY_PREFIX_LENGTH,
    CITEXT,
    NAME_CAP,
    TEXT_CAP,
    TIMESTAMPTZ,
    WORKSPACE_ROLES,
    WORKSPACE_SLUG_CAP,
    WORKSPACE_SLUG_PATTERN,
    Base,
    WorkspaceScoped,
    created_at_column,
    digest_check,
    digest_column,
    enum_check,
    flag_column,
    integer_column,
    length_check,
    non_negative_check,
    timestamp_column,
    updated_at_column,
    uuid_pk_column,
)

__all__ = ['ApiKey', 'Session', 'User', 'Workspace', 'WorkspaceMember']


class Workspace(Base):
    """The tenant (data-model.md 3.1). A self-hosted deployment bootstraps exactly one row."""

    __tablename__ = 'workspaces'
    __table_args__ = (
        CheckConstraint(f"slug ~ '{WORKSPACE_SLUG_PATTERN}'", name='slug_pattern'),
        length_check('slug', WORKSPACE_SLUG_CAP),
        length_check('name', NAME_CAP),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()
    #: Retention: soft delete (data-model.md section 5).
    deleted_at: Mapped[dt.datetime | None] = timestamp_column()


class User(Base):
    """A local account (data-model.md 3.2). Not tenant-scoped."""

    __tablename__ = 'users'
    __table_args__ = (
        length_check('password_hash', TEXT_CAP),
        length_check('display_name', NAME_CAP),
        non_negative_check('failed_login_count'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: Case-insensitive login identifier, so two accounts cannot differ only in letter case.
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    #: argon2id (ADR-0005). Minimum length and the deny list are enforced by the API, not here.
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Disable an account without deleting it, so audit rows keep a resolvable actor.
    is_active: Mapped[bool] = flag_column(default=True)
    #: Reference point for session rotation after a password change (ADR-0005).
    password_changed_at: Mapped[dt.datetime] = mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
    )
    #: Lockout and audit support; rate limiting itself is slowapi's job (A02).
    failed_login_count: Mapped[int] = integer_column(nullable=False, default=0)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()


class WorkspaceMember(WorkspaceScoped, Base):
    """Membership and role of a user in a workspace (data-model.md 3.3).

    The primary key ``(workspace_id, user_id)`` is itself the index leading with ``workspace_id``.
    """

    __tablename__ = 'workspace_members'
    __workspace_primary_key__: ClassVar[bool] = True
    __table_args__ = (enum_check('role', WORKSPACE_ROLES),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey('users.id'),
        primary_key=True,
        nullable=False,
    )
    #: A role change rotates the user's sessions (ADR-0005) and writes an audit row.
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()


class Session(Base):
    """A server-side session (data-model.md 3.4). The cookie carries only an opaque token."""

    __tablename__ = 'sessions'
    __table_args__ = (
        digest_check('token_hash'),
        digest_check('csrf_token_hash'),
        Index('ix_sessions_user_id', 'user_id'),
        Index('ix_sessions_expires_at', 'expires_at'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: sha256 of the 256-bit cookie token. The token itself is never stored.
    token_hash: Mapped[bytes] = digest_column(unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id'), nullable=False)
    #: sha256 of the double-submit CSRF token bound to this session (A02).
    csrf_token_hash: Mapped[bytes] = digest_column()
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Idle-timeout reference.
    last_seen_at: Mapped[dt.datetime] = mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
    )
    #: Retention: absolute lifetime; the purge job removes rows past it.
    expires_at: Mapped[dt.datetime] = mapped_column(TIMESTAMPTZ, nullable=False)
    revoked_at: Mapped[dt.datetime | None] = timestamp_column()
    #: Audit only, truncated by the API before it is written.
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(Text, nullable=True)


class ApiKey(WorkspaceScoped, Base):
    """A workspace-scoped API key (data-model.md 3.5). Shown once, stored as a sha256 digest."""

    __tablename__ = 'api_keys'
    __table_args__ = (
        enum_check('role', WORKSPACE_ROLES),
        digest_check('key_hash'),
        length_check('name', NAME_CAP),
        length_check('key_prefix', API_KEY_PREFIX_LENGTH, minimum=API_KEY_PREFIX_LENGTH),
        Index('ix_api_keys_workspace_id_user_id', 'workspace_id', 'user_id'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: The acting principal. A key never exceeds this user's role in the workspace.
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id'), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    #: The first eight characters of the secret, for identification in the UI and in audit rows.
    key_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    key_hash: Mapped[bytes] = digest_column(unique=True)
    #: Capped at the creating principal's role by the API (ADR-0005).
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Retention: an expired or revoked key is unusable, but the row stays as an audit reference.
    expires_at: Mapped[dt.datetime | None] = timestamp_column()
    revoked_at: Mapped[dt.datetime | None] = timestamp_column()
    last_used_at: Mapped[dt.datetime | None] = timestamp_column()
