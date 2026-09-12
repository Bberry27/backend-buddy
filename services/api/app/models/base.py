"""Declarative base, shared column helpers, and the frozen value sets (work package A01).

Every constant here mirrors a value that is already written down somewhere else, so the schema
cannot drift from the documents that freeze it:

* the enumerations are ``docs/architecture/data-model.md`` section 3 (``text`` columns with a
  ``check`` constraint rather than PostgreSQL enums, so a downgrade stays trivial -- section 1);
* the profiling budgets are ``docs/reference/limits-and-caps.md`` section B;
* ``NAME_CAP`` and ``TEXT_CAP`` are the renderer's display-text caps
  (``skill/scripts/build_explorer.py``), recorded in ``limits-and-caps.md`` section A5;
* ``PROJECT_KEY_PATTERN`` is the character set ``normalize()`` enforces for ``project.key``.

``test_A01_check_constraints`` asserts the database really rejects a value outside these sets, and
``test_A01_tenant_scoping`` asserts every tenant-scoped table carries ``workspace_id``.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from typing import Any, ClassVar

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Integer,
    LargeBinary,
    MetaData,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, INET, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column
from sqlalchemy.sql.elements import TextClause

__all__ = [
    'ACTION_CAP',
    'ALGORITHMS',
    'API_KEY_PREFIX_LENGTH',
    'CAP_SECONDS_DEFAULT',
    'CAP_SECONDS_MAX',
    'CITEXT',
    'CONNECTION_DIALECTS',
    'CONNECTION_MODES',
    'CONTRACT_VERSION_PATTERN',
    'DEFAULT_TLS_MODE',
    'FINDING_ID_CAP',
    'ID_SORT_ORDER',
    'INET',
    'JOB_ACTIVE_STATUSES',
    'JOB_ITEM_STATUSES',
    'JOB_KINDS',
    'JOB_STATUSES',
    'JSONB',
    'NAME_CAP',
    'NAMING_CONVENTION',
    'PER_TABLE_SECONDS_DEFAULT',
    'PER_TABLE_SECONDS_MAX',
    'PROJECT_KEY_PATTERN',
    'REVIEW_DECISIONS',
    'SHA256_BYTES',
    'SNAPSHOT_ORIGINS',
    'TEXT_CAP',
    'THEMES',
    'TIMESTAMPTZ',
    'WORKSPACE_ROLES',
    'WORKSPACE_SLUG_CAP',
    'WORKSPACE_ID_SORT_ORDER',
    'WORKSPACE_SLUG_PATTERN',
    'Base',
    'BigInteger',
    'Boolean',
    'CheckConstraint',
    'DateTime',
    'ForeignKey',
    'Identity',
    'Integer',
    'LargeBinary',
    'Text',
    'Uuid',
    'WorkspaceScoped',
    'created_at_column',
    'digest_check',
    'digest_column',
    'enum_check',
    'flag_column',
    'integer_column',
    'length_check',
    'non_negative_check',
    'timestamp_column',
    'updated_at_column',
    'uuid_pk_column',
]

# --------------------------------------------------------------------------------------------
# Frozen value sets and caps
# --------------------------------------------------------------------------------------------

#: ``workspace_members.role`` and ``api_keys.role`` (data-model.md 3.3, 3.5; ADR-0005).
WORKSPACE_ROLES: Sequence[str] = ('owner', 'admin', 'reviewer', 'viewer')
#: ``snapshots.origin`` (data-model.md 3.7).
SNAPSHOT_ORIGINS: Sequence[str] = ('upload', 'extraction', 'profile', 'import')
#: ``connections.dialect`` (data-model.md 3.8; D6, other dialects are post-MVP).
CONNECTION_DIALECTS: Sequence[str] = ('postgresql', 'sqlite')
#: ``connections.mode``; ``agent`` is reserved for the customer-side connector (L-08).
CONNECTION_MODES: Sequence[str] = ('direct', 'agent')
#: ``jobs.kind`` (data-model.md 3.10).
JOB_KINDS: Sequence[str] = ('extract', 'profile', 'export')
#: ``jobs.status``; ``partial`` means some items were incomplete.
JOB_STATUSES: Sequence[str] = ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')
#: The two statuses the one-running-job-per-connection partial unique index covers.
JOB_ACTIVE_STATUSES: Sequence[str] = ('queued', 'running')
#: ``job_items.status`` (data-model.md 3.11).
JOB_ITEM_STATUSES: Sequence[str] = ('pending', 'running', 'done', 'partial', 'skipped', 'failed')
#: ``review_decisions.decision`` (data-model.md 3.12).
REVIEW_DECISIONS: Sequence[str] = ('open', 'investigate', 'intentional', 'resolved')
#: ``user_preferences.theme``, mirroring the host theme select (data-model.md 3.14).
THEMES: Sequence[str] = ('dark', 'light', 'system')
#: ``encryption_keys.algorithm`` (data-model.md 3.9). A second algorithm is a reviewed migration.
ALGORITHMS: Sequence[str] = ('AES-256-GCM',)

#: ``connections.tls_mode`` default; ``BB_DEFAULT_TLS_MODE`` overrides it per deployment. The
#: allowed set is deliberately not constrained here: ``targets.py`` (A03) owns the mapping to
#: libpq ``sslmode`` and is the single place that decides which modes exist.
DEFAULT_TLS_MODE = 'verify-full'

#: Per-table profiling budget: default 5 s, maximum 60 s (limits-and-caps.md B; RK-06).
PER_TABLE_SECONDS_DEFAULT = 5
PER_TABLE_SECONDS_MAX = 60
#: Job-level cap: default 600 s, hard maximum 3,600 s (limits-and-caps.md B; RK-06).
CAP_SECONDS_DEFAULT = 600
CAP_SECONDS_MAX = 3600

#: Renderer display-text caps (``build_explorer.py`` ``NAME_CAP`` and ``TEXT_CAP``).
NAME_CAP = 256
TEXT_CAP = 4096
#: ``review_decisions.finding_id``: opaque text, capped so the unique index on
#: ``(project_id, finding_id)`` stays inside PostgreSQL's btree key limit even at four bytes per
#: character. Proposed by A01 and recorded in data-model.md section 6; A04 may widen it.
FINDING_ID_CAP = 512
#: ``audit_events.action`` and its target and request identifiers reuse ``NAME_CAP``.
ACTION_CAP = NAME_CAP
#: ``api_keys.key_prefix``: the first eight characters of the secret (data-model.md 3.5).
API_KEY_PREFIX_LENGTH = 8
#: ``workspaces.slug``: the URL segment ``:ws`` (data-model.md 3.1).
WORKSPACE_SLUG_CAP = 64
WORKSPACE_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]*$'
#: ``projects.key``: the character set ``normalize()`` enforces for ``project.key``.
PROJECT_KEY_PATTERN = '^[a-z0-9][a-z0-9_-]*$'
#: ``snapshots.contract_version``: ``MAJOR.MINOR``, copied from ``graph.contractVersion``. The
#: major is not pinned here, so a contract major bump needs no column migration (ADR-0003).
CONTRACT_VERSION_PATTERN = r'^[0-9]+\.[0-9]+$'
#: Length of a sha256 digest in bytes; every hash and fingerprint column stores exactly one.
SHA256_BYTES = 32

# --------------------------------------------------------------------------------------------
# Declarative base
# --------------------------------------------------------------------------------------------

#: Every timestamp in the model is ``timestamptz`` (data-model.md section 1).
TIMESTAMPTZ = DateTime(timezone=True)

#: Column ordering. ``id`` first, then ``workspace_id``, then the table's own columns, so the
#: physical column list reads like the table in ``data-model.md`` section 3.
ID_SORT_ORDER = -100
WORKSPACE_ID_SORT_ORDER = -50

#: Deterministic constraint and index names, so a migration can drop an object by name and a
#: reflected schema compares equal to the models.
NAMING_CONVENTION = {
    'ix': 'ix_%(table_name)s_%(column_0_N_name)s',
    'uq': 'uq_%(table_name)s_%(column_0_N_name)s',
    'ck': 'ck_%(table_name)s_%(constraint_name)s',
    'fk': 'fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s',
    'pk': 'pk_%(table_name)s',
}


class Base(DeclarativeBase):
    """Declarative base for every metadata table."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class WorkspaceScoped:
    """Mixin for the tenant-scoped tables in ``data-model.md`` section 4's "yes" list.

    It contributes ``workspace_id uuid not null references workspaces(id)``. The index leading with
    ``workspace_id`` that section 1 requires is declared by each table, because most of them want a
    composite that also serves their listing query; ``test_A01_tenant_scoping`` fails when a table
    carries the column without such an index.

    Two knobs keep the column where ``data-model.md`` section 3 puts it:

    * ``__workspace_primary_key__`` makes it part of the primary key (``workspace_members``,
      ``user_preferences``);
    * ``__workspace_sort_order__`` places it in the column list. The default puts it directly
      after ``id``; ``user_preferences`` moves it after ``user_id`` so its key reads
      ``(user_id, workspace_id)`` as the document specifies.
    """

    __workspace_primary_key__: ClassVar[bool] = False
    __workspace_sort_order__: ClassVar[int] = WORKSPACE_ID_SORT_ORDER

    @declared_attr
    @classmethod
    def workspace_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(
            Uuid,
            ForeignKey('workspaces.id'),
            nullable=False,
            primary_key=cls.__workspace_primary_key__,
            sort_order=cls.__workspace_sort_order__,
        )


# --------------------------------------------------------------------------------------------
# Column helpers
# --------------------------------------------------------------------------------------------


def uuid_pk_column() -> Mapped[uuid.UUID]:
    """``id uuid primary key default gen_random_uuid()`` (data-model.md section 1)."""
    return mapped_column(
        Uuid,
        primary_key=True,
        server_default=text('gen_random_uuid()'),
        sort_order=ID_SORT_ORDER,
    )


def integer_column(*, nullable: bool = True, default: int | None = None) -> Mapped[Any]:
    """An ``integer`` column whose server default, when it has one, is an unquoted literal.

    The return annotation is deliberately wide: the caller's own ``Mapped[int]`` or
    ``Mapped[int | None]`` annotation is what the mapper reads.
    """
    return mapped_column(
        Integer,
        nullable=nullable,
        server_default=None if default is None else text(str(default)),
    )


def created_at_column() -> Mapped[dt.datetime]:
    """``created_at timestamptz not null default now()``, on every table."""
    return mapped_column(TIMESTAMPTZ, nullable=False, server_default=func.now())


def updated_at_column() -> Mapped[dt.datetime]:
    """``updated_at timestamptz not null default now()``, on every mutable table."""
    return mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


def timestamp_column(server_default: TextClause | None = None) -> Mapped[dt.datetime | None]:
    """A nullable ``timestamptz``: a retention field, a lifecycle mark, or an audit mark.

    A column that must always hold a value is declared with :data:`TIMESTAMPTZ` directly, so its
    ``Mapped`` annotation states that it is not optional.
    """
    return mapped_column(TIMESTAMPTZ, nullable=True, server_default=server_default)


def flag_column(*, default: bool) -> Mapped[bool]:
    """A ``boolean not null`` column with a server default, used by the opt-in flags."""
    return mapped_column(
        Boolean,
        nullable=False,
        server_default=text('true' if default else 'false'),
    )


def digest_column(*, unique: bool = False, nullable: bool = False) -> Mapped[bytes]:
    """A ``bytea`` column holding exactly one sha256 digest."""
    return mapped_column(LargeBinary, nullable=nullable, unique=unique)


def enum_check(column: str, values: Sequence[str], *, name: str | None = None) -> CheckConstraint:
    """``check (column in (...))``. Enumerations are text plus a check, never a PostgreSQL enum."""
    literals = ', '.join(f"'{value}'" for value in values)
    return CheckConstraint(f'{column} in ({literals})', name=name or column)


def length_check(
    column: str,
    cap: int,
    *,
    minimum: int = 1,
    name: str | None = None,
) -> CheckConstraint:
    """``check (char_length(column) between minimum and cap)``, or ``= cap`` for a fixed length."""
    condition = (
        f'char_length({column}) = {cap}'
        if minimum == cap
        else f'char_length({column}) between {minimum} and {cap}'
    )
    return CheckConstraint(condition, name=name or f'{column}_length')


def non_negative_check(column: str) -> CheckConstraint:
    """``check (column >= 0)`` for a count or a measured duration."""
    return CheckConstraint(f'{column} >= 0', name=f'{column}_non_negative')


def digest_check(column: str, *, name: str | None = None) -> CheckConstraint:
    """``check (octet_length(column) = 32)``: the column holds one sha256 digest, nothing else."""
    return CheckConstraint(
        f'octet_length({column}) = {SHA256_BYTES}',
        name=name or f'{column}_sha256',
    )
