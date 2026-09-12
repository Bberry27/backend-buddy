"""The metadata model: fifteen tables from ``docs/architecture/data-model.md`` section 3.

Importing this package registers every table on ``Base.metadata`` and opens no connection, so
``python -c "from app.models import *"`` works without a database.

It also re-exports the frozen value sets and caps from :mod:`app.models.base`, so a caller that
needs the ``jobs.status`` enumeration or the profiling budgets imports them from one place.

The three registries at the bottom are the machine-readable form of section 4's tenant-scoping
table and of the insert-only rule in section 3.15. ``test_A01_tenant_scoping`` reads them, so a
table added later without a place in one of them fails the suite rather than shipping unscoped.
"""

from __future__ import annotations

from app.models.audit import (
    AUDIT_TRIGGER_ERRCODE,
    AUDIT_TRIGGER_FUNCTION,
    AUDIT_TRIGGER_NAME,
    AuditEvent,
)
from app.models.base import (
    ALGORITHMS,
    CAP_SECONDS_DEFAULT,
    CAP_SECONDS_MAX,
    CONNECTION_DIALECTS,
    CONNECTION_MODES,
    FINDING_ID_CAP,
    JOB_ACTIVE_STATUSES,
    JOB_ITEM_STATUSES,
    JOB_KINDS,
    JOB_STATUSES,
    PER_TABLE_SECONDS_DEFAULT,
    PER_TABLE_SECONDS_MAX,
    REVIEW_DECISIONS,
    SNAPSHOT_ORIGINS,
    THEMES,
    WORKSPACE_ROLES,
    Base,
    WorkspaceScoped,
)
from app.models.connections import Connection, EncryptionKey
from app.models.jobs import ACTIVE_JOB_INDEX, ACTIVE_JOB_PREDICATE, Job, JobItem
from app.models.projects import Project, Snapshot
from app.models.reviews import SHARED_LAYOUT_USER_ID, ErdLayout, ReviewDecision, UserPreference
from app.models.tenancy import ApiKey, Session, User, Workspace, WorkspaceMember

__all__ = [
    'ACTIVE_JOB_INDEX',
    'ACTIVE_JOB_PREDICATE',
    'ALGORITHMS',
    'AUDIT_TRIGGER_ERRCODE',
    'AUDIT_TRIGGER_FUNCTION',
    'AUDIT_TRIGGER_NAME',
    'CAP_SECONDS_DEFAULT',
    'CAP_SECONDS_MAX',
    'CONNECTION_DIALECTS',
    'CONNECTION_MODES',
    'FINDING_ID_CAP',
    'INSERT_ONLY_TABLES',
    'JOB_ACTIVE_STATUSES',
    'JOB_ITEM_STATUSES',
    'JOB_KINDS',
    'JOB_STATUSES',
    'PER_TABLE_SECONDS_DEFAULT',
    'PER_TABLE_SECONDS_MAX',
    'REVIEW_DECISIONS',
    'SHARED_LAYOUT_USER_ID',
    'SNAPSHOT_ORIGINS',
    'TABLES',
    'TENANT_OPTIONAL_TABLES',
    'TENANT_SCOPED_TABLES',
    'THEMES',
    'UNSCOPED_TABLES',
    'WORKSPACE_ROLES',
    'ApiKey',
    'AuditEvent',
    'Base',
    'Connection',
    'EncryptionKey',
    'ErdLayout',
    'Job',
    'JobItem',
    'Project',
    'ReviewDecision',
    'Session',
    'Snapshot',
    'User',
    'UserPreference',
    'Workspace',
    'WorkspaceMember',
    'WorkspaceScoped',
]

#: Every table, in the order ``data-model.md`` section 3 lists them.
TABLES: tuple[str, ...] = (
    'workspaces',
    'users',
    'workspace_members',
    'sessions',
    'api_keys',
    'projects',
    'snapshots',
    'connections',
    'encryption_keys',
    'jobs',
    'job_items',
    'review_decisions',
    'erd_layouts',
    'user_preferences',
    'audit_events',
)

#: Section 4, "yes": ``workspace_id uuid not null references workspaces(id)`` plus an index
#: leading with it. Every API query filters by the caller's workspace (CTQ-07).
TENANT_SCOPED_TABLES: tuple[str, ...] = (
    'workspace_members',
    'api_keys',
    'projects',
    'snapshots',
    'connections',
    'jobs',
    'job_items',
    'review_decisions',
    'erd_layouts',
    'user_preferences',
)

#: Section 4, "no": user-level or deployment-level. ``workspaces`` is the tenant itself.
UNSCOPED_TABLES: tuple[str, ...] = ('workspaces', 'users', 'sessions', 'encryption_keys')

#: Section 4, "nullable": deployment-level audit events belong to no workspace.
TENANT_OPTIONAL_TABLES: tuple[str, ...] = ('audit_events',)

#: Tables the application role may only insert into and select from (``ops/sql/roles.sql``).
INSERT_ONLY_TABLES: tuple[str, ...] = ('audit_events',)
