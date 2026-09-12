"""The audit trail (``docs/architecture/data-model.md`` 3.15, CTQ-16).

``audit_events`` is insert-only, and that is enforced twice, in depth:

1. the trigger ``audit_events_no_update_delete`` raises SQLSTATE ``42501`` on any UPDATE or
   DELETE, whichever role attempts it (created by migration ``0001``, dropped by its downgrade);
2. ``ops/sql/roles.sql`` grants the application role ``insert, select`` only, so the statement is
   normally refused before the trigger is ever reached.

The table carries no foreign keys. A trail that could be broken by deleting a referenced row is
not a trail, and ``workspace_id`` is nullable because deployment-level events (bootstrap, key
rotation) belong to no workspace (data-model.md section 4). ``details`` is redacted by the audit
service: never a secret, a DSN, or a sampled value.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import BigInteger, Identity, Index, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    ACTION_CAP,
    INET,
    JSONB,
    NAME_CAP,
    TIMESTAMPTZ,
    Base,
    length_check,
)

__all__ = ['AUDIT_TRIGGER_ERRCODE', 'AUDIT_TRIGGER_FUNCTION', 'AUDIT_TRIGGER_NAME', 'AuditEvent']

#: Names the migration creates and drops, and the test asserts.
AUDIT_TRIGGER_NAME = 'audit_events_no_update_delete'
AUDIT_TRIGGER_FUNCTION = 'audit_events_immutable'
#: ``insufficient_privilege``: the SQLSTATE the trigger raises (CTQ-16).
AUDIT_TRIGGER_ERRCODE = '42501'


class AuditEvent(Base):
    """One append-only audit row (data-model.md 3.15)."""

    __tablename__ = 'audit_events'
    __table_args__ = (
        length_check('action', ACTION_CAP),
        length_check('target_type', NAME_CAP),
        length_check('target_id', NAME_CAP),
        length_check('request_id', NAME_CAP),
        Index('ix_audit_events_workspace_id_occurred_at', 'workspace_id', text('occurred_at desc')),
    )

    #: Monotonic, so an export can page without a cursor table.
    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    #: Null for deployment-level events. Not a foreign key: the trail outlives its subjects.
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    actor_api_key_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    #: For example ``login.success``, ``connection.test``, ``job.submit``, ``review.decide``.
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Correlates with the structlog JSON request id (RK-21).
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(INET, nullable=True)
    #: Redacted detail object; never a secret, a DSN, or a sampled value.
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    occurred_at: Mapped[dt.datetime] = mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
    )
