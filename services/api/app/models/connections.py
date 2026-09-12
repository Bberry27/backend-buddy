"""Connections and the wrapping-key registry (``docs/architecture/data-model.md`` 3.8-3.9).

The only long-lived secret the platform stores on a user's behalf is a connection secret, and it
exists here only as ciphertext: ``connections.encrypted_secret`` is AES-256-GCM output with the
96-bit nonce prepended, and ``connections.key_id`` names the wrapping key. There is no read path
(security-architecture.md section 4): the API never returns either column, and only the worker
decrypts, immediately before it opens a read-only session.

``encryption_keys`` is deployment-level, not tenant-scoped, and holds no key material: only the
algorithm and the sha256 fingerprint of the master key, so a swapped secret file is detected at
startup rather than by a decryption failure much later (RK-08).
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, LargeBinary, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    ALGORITHMS,
    CONNECTION_DIALECTS,
    CONNECTION_MODES,
    DEFAULT_TLS_MODE,
    NAME_CAP,
    TEXT_CAP,
    Base,
    WorkspaceScoped,
    created_at_column,
    digest_check,
    digest_column,
    enum_check,
    flag_column,
    length_check,
    timestamp_column,
    updated_at_column,
    uuid_pk_column,
)

__all__ = ['Connection', 'EncryptionKey']


class EncryptionKey(Base):
    """One wrapping key in the envelope-encryption registry (data-model.md 3.9).

    Rows are never deleted while a connection references them, so old ciphertext stays
    decryptable until the rewrap CLI (L-04) has moved it.
    """

    __tablename__ = 'encryption_keys'
    __table_args__ = (
        enum_check('algorithm', ALGORITHMS),
        digest_check('master_key_fingerprint'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    algorithm: Mapped[str] = mapped_column(Text, nullable=False)
    #: sha256 of the master key read from ``BB_MASTER_KEY_FILE``. Never the key itself.
    master_key_fingerprint: Mapped[bytes] = digest_column()
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Set by the rewrap CLI; a retired key still decrypts until its ciphertext has moved.
    retired_at: Mapped[dt.datetime | None] = timestamp_column()


class Connection(WorkspaceScoped, Base):
    """A registered, explicitly selected read-only database connection (data-model.md 3.8).

    The row holds the non-secret locator fields the UI shows plus the ciphertext of the secret.
    ``id`` is the additional authenticated data of the envelope, so a ciphertext cannot be moved
    to another connection.
    """

    __tablename__ = 'connections'
    __table_args__ = (
        enum_check('dialect', CONNECTION_DIALECTS),
        enum_check('mode', CONNECTION_MODES),
        CheckConstraint('port is null or port between 1 and 65535', name='port_range'),
        length_check('name', NAME_CAP),
        length_check('tls_mode', NAME_CAP),
        length_check('host', NAME_CAP),
        length_check('database', TEXT_CAP),
        length_check('username', NAME_CAP),
        length_check('last_test_status', TEXT_CAP),
        Index('ix_connections_workspace_id_project_id', 'workspace_id', 'project_id'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: Optional default project for extractions started from this connection.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('projects.id'),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    dialect: Mapped[str] = mapped_column(Text, nullable=False)
    #: ``agent`` is reserved for the customer-side connector (L-08); only ``direct`` at MVP.
    mode: Mapped[str] = mapped_column(Text, nullable=False, server_default='direct')
    host: Mapped[str | None] = mapped_column(Text, nullable=True)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: For ``sqlite`` this is the file path inside the worker container.
    database: Mapped[str | None] = mapped_column(Text, nullable=True)
    username: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Mapped to libpq ``sslmode`` by ``targets.py`` (A03); a downgrade is an audited admin choice.
    tls_mode: Mapped[str] = mapped_column(Text, nullable=False, server_default=DEFAULT_TLS_MODE)
    #: AES-256-GCM ciphertext with the nonce prepended. Write-only: no route returns it.
    encrypted_secret: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey('encryption_keys.id', ondelete='RESTRICT'),
        nullable=False,
    )
    #: Connection-level part of the triple opt-in for sample values.
    allow_sample_values: Mapped[bool] = flag_column(default=False)
    #: String minimum and maximum are off unless a connection opts in.
    allow_string_extremes: Mapped[bool] = flag_column(default=False)
    last_tested_at: Mapped[dt.datetime | None] = timestamp_column()
    #: ``ok`` or a redacted reason; never a driver message that could carry a DSN or a value.
    last_test_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Admin or owner only (ADR-0005).
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id'), nullable=False)
    created_at: Mapped[dt.datetime] = created_at_column()
    updated_at: Mapped[dt.datetime] = updated_at_column()
    #: Retention: soft delete; ``encrypted_secret`` is zeroed at the same moment.
    deleted_at: Mapped[dt.datetime | None] = timestamp_column()
