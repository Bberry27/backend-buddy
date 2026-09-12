"""Jobs and job items (``docs/architecture/data-model.md`` 3.10-3.11).

Two storage-layer guards live here and nowhere else:

* the partial unique index ``(connection_id) where status in ('queued','running')`` allows one
  active job per connection (RK-06, CTQ-08), so two submissions cannot race past an application
  check;
* ``per_table_seconds`` and ``cap_seconds`` carry the budgets from
  ``docs/reference/limits-and-caps.md`` section B as defaults *and* as check constraints, so the
  per-table budget cannot be raised past 60 s or the job cap past 3,600 s by any writer.

``job_items`` never records a fabricated count: ``queries_used``, ``elapsed_ms`` and
``rows_sampled`` are nullable and stay null for an item that did not run (CTQ-01).
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    CAP_SECONDS_DEFAULT,
    CAP_SECONDS_MAX,
    JOB_ACTIVE_STATUSES,
    JOB_ITEM_STATUSES,
    JOB_KINDS,
    JOB_STATUSES,
    JSONB,
    NAME_CAP,
    PER_TABLE_SECONDS_DEFAULT,
    PER_TABLE_SECONDS_MAX,
    TEXT_CAP,
    TIMESTAMPTZ,
    Base,
    WorkspaceScoped,
    created_at_column,
    enum_check,
    integer_column,
    length_check,
    non_negative_check,
    timestamp_column,
    uuid_pk_column,
)

__all__ = ['ACTIVE_JOB_INDEX', 'ACTIVE_JOB_PREDICATE', 'Job', 'JobItem']

#: SQL predicate of the partial unique index. Kept next to the model so the migration, the model,
#: and ``test_A01_one_running_job_per_connection`` all read the same text.
ACTIVE_JOB_PREDICATE = 'status in ({})'.format(
    ', '.join(f"'{status}'" for status in JOB_ACTIVE_STATUSES)
)
#: Name of that index, asserted by the test and dropped by name in ``downgrade()``.
ACTIVE_JOB_INDEX = 'uq_jobs_active_connection'


class Job(WorkspaceScoped, Base):
    """One queued or finished unit of work (data-model.md 3.10)."""

    __tablename__ = 'jobs'
    __table_args__ = (
        enum_check('kind', JOB_KINDS),
        enum_check('status', JOB_STATUSES),
        CheckConstraint(
            f'per_table_seconds between 1 and {PER_TABLE_SECONDS_MAX}',
            name='per_table_seconds_range',
        ),
        CheckConstraint(f'cap_seconds between 1 and {CAP_SECONDS_MAX}', name='cap_seconds_range'),
        length_check('claimed_by', NAME_CAP),
        length_check('error', TEXT_CAP),
        # Claim query: `... where status = 'queued' order by created_at for update skip locked`.
        Index('ix_jobs_status_created_at', 'status', 'created_at'),
        Index('ix_jobs_workspace_id_created_at', 'workspace_id', 'created_at'),
        # One active job per connection (RK-06).
        Index(
            ACTIVE_JOB_INDEX,
            'connection_id',
            unique=True,
            postgresql_where=ACTIVE_JOB_PREDICATE,
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    #: Required for ``extract`` and ``profile``; null for ``export``.
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('connections.id'),
        nullable=True,
    )
    #: Input snapshot for ``profile`` and ``export``.
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('snapshots.id'),
        nullable=True,
    )
    #: Output snapshot for ``extract`` and ``profile``.
    result_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey('snapshots.id'),
        nullable=True,
    )
    #: Table selection, per-table budget, and opt-ins, validated against a pydantic model (A04).
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: Per-table profiling budget: default 5 s, maximum 60 s.
    per_table_seconds: Mapped[int] = integer_column(
        nullable=False,
        default=PER_TABLE_SECONDS_DEFAULT,
    )
    #: Job-level cap: default 600 s, hard maximum 3,600 s.
    cap_seconds: Mapped[int] = integer_column(nullable=False, default=CAP_SECONDS_DEFAULT)
    requested_by: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id'), nullable=False)
    #: Worker instance id, set by the claim.
    claimed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    claimed_at: Mapped[dt.datetime | None] = timestamp_column()
    started_at: Mapped[dt.datetime | None] = timestamp_column()
    finished_at: Mapped[dt.datetime | None] = timestamp_column()
    #: The worker checks this between items, so a cancel never interrupts a running query.
    cancel_requested_at: Mapped[dt.datetime | None] = timestamp_column()
    #: Redacted message only: no DSN, no sampled value (security-architecture.md section 4).
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Retention: the purge job removes finished jobs past this point (A04).
    retain_until: Mapped[dt.datetime | None] = timestamp_column()


class JobItem(WorkspaceScoped, Base):
    """One table of a ``profile`` job, or one object class of an ``extract`` (data-model.md 3.11)."""

    __tablename__ = 'job_items'
    __table_args__ = (
        enum_check('status', JOB_ITEM_STATUSES),
        length_check('table_id', NAME_CAP),
        length_check('reason', TEXT_CAP),
        non_negative_check('queries_used'),
        non_negative_check('elapsed_ms'),
        non_negative_check('rows_sampled'),
        Index('ix_job_items_job_id_status', 'job_id', 'status'),
        Index('ix_job_items_workspace_id_retain_until', 'workspace_id', 'retain_until'),
    )

    id: Mapped[uuid.UUID] = uuid_pk_column()
    #: Items are deleted with their job, so the retention purge can drop a job in one statement.
    job_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey('jobs.id', ondelete='CASCADE'),
        nullable=False,
    )
    #: The SchemaGraph ``table.id``, which may contain dots and other separators.
    table_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    #: Why an item is ``partial`` or ``skipped``; becomes the ``profiling.status`` reason (C05).
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    queries_used: Mapped[int | None] = integer_column()
    elapsed_ms: Mapped[int | None] = integer_column()
    #: Rows actually sampled. A capped sample is a lower bound, never a row count (CTQ-01).
    rows_sampled: Mapped[int | None] = integer_column()
    started_at: Mapped[dt.datetime | None] = timestamp_column()
    finished_at: Mapped[dt.datetime | None] = timestamp_column()
    created_at: Mapped[dt.datetime] = created_at_column()
    #: Retention: required, because the A04 purge job is the only thing that removes these rows.
    retain_until: Mapped[dt.datetime] = mapped_column(TIMESTAMPTZ, nullable=False)
