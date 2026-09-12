"""initial

Revision id: 0001
Revises: nothing; this is the first revision of the metadata store
Created: 2026-09-08

Work package A01. Creates the fifteen tables of ``docs/architecture/data-model.md`` section 3 with
every check constraint, unique constraint, and index that document specifies, plus two objects
that are not tables:

* the ``citext`` extension, which ``users.email`` needs so two accounts cannot differ only in
  letter case;
* the trigger ``audit_events_no_update_delete`` and its function ``audit_events_immutable``,
  which make the audit trail insert-only by raising SQLSTATE ``42501`` on UPDATE and DELETE
  (data-model.md 3.15, CTQ-16). ``ops/sql/roles.sql`` withholds those privileges from the
  application role as well, so the trigger is defence in depth rather than the only control.

The body of ``upgrade()`` was generated from ``app.models`` by ``alembic revision
--autogenerate`` and is kept equal to it by ``test_A01_migration_matches_models``; the extension,
the trigger, and ``downgrade()`` are written by hand.

``downgrade()`` reverses everything this revision creates except the extension: an extension is
a database-level object that another schema in the same database may depend on, so dropping it
would reach outside this migration's scope. ``create extension if not exists`` makes the upgrade
idempotent against a database that already has it.

``test_A01_upgrade_downgrade_upgrade`` proves upgrade -> downgrade -> upgrade against an empty
PostgreSQL 16 (CTQ-15, ``docs/architecture/deployment-architecture.md`` section 8).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Verbatim from ``data-model.md`` 3.15, minus the statement terminator, because ``op.execute``
#: sends one statement. The message names the rejected operation and the SQLSTATE is ``42501``
#: (``insufficient_privilege``), which is what the API surfaces as 403.
AUDIT_IMMUTABLE_FUNCTION = """
create or replace function audit_events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is insert-only (% rejected)', tg_op
    using errcode = '42501';
end $$
"""

AUDIT_IMMUTABLE_TRIGGER = """
create trigger audit_events_no_update_delete
  before update or delete on audit_events
  for each row execute function audit_events_immutable()
"""


def upgrade() -> None:
    # citext first: users.email is declared with it.
    op.execute('create extension if not exists citext')

    op.create_table('audit_events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=True), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=True),
    sa.Column('actor_user_id', sa.Uuid(), nullable=True),
    sa.Column('actor_api_key_id', sa.Uuid(), nullable=True),
    sa.Column('action', sa.Text(), nullable=False),
    sa.Column('target_type', sa.Text(), nullable=True),
    sa.Column('target_id', sa.Text(), nullable=True),
    sa.Column('request_id', sa.Text(), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('details', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('occurred_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('char_length(action) between 1 and 256', name=op.f('ck_audit_events_action_length')),
    sa.CheckConstraint('char_length(request_id) between 1 and 256', name=op.f('ck_audit_events_request_id_length')),
    sa.CheckConstraint('char_length(target_id) between 1 and 256', name=op.f('ck_audit_events_target_id_length')),
    sa.CheckConstraint('char_length(target_type) between 1 and 256', name=op.f('ck_audit_events_target_type_length')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_events'))
    )
    op.create_index('ix_audit_events_workspace_id_occurred_at', 'audit_events', ['workspace_id', sa.literal_column('occurred_at desc')], unique=False)
    op.create_table('encryption_keys',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('algorithm', sa.Text(), nullable=False),
    sa.Column('master_key_fingerprint', sa.LargeBinary(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('retired_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("algorithm in ('AES-256-GCM')", name=op.f('ck_encryption_keys_algorithm')),
    sa.CheckConstraint('octet_length(master_key_fingerprint) = 32', name=op.f('ck_encryption_keys_master_key_fingerprint_sha256')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_encryption_keys'))
    )
    op.create_table('users',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('email', postgresql.CITEXT(), nullable=False),
    sa.Column('password_hash', sa.Text(), nullable=False),
    sa.Column('display_name', sa.Text(), nullable=True),
    sa.Column('is_active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('password_changed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('failed_login_count', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('char_length(display_name) between 1 and 256', name=op.f('ck_users_display_name_length')),
    sa.CheckConstraint('char_length(password_hash) between 1 and 4096', name=op.f('ck_users_password_hash_length')),
    sa.CheckConstraint('failed_login_count >= 0', name=op.f('ck_users_failed_login_count_non_negative')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('email', name=op.f('uq_users_email'))
    )
    op.create_table('workspaces',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('slug', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("slug ~ '^[a-z0-9][a-z0-9-]*$'", name=op.f('ck_workspaces_slug_pattern')),
    sa.CheckConstraint('char_length(name) between 1 and 256', name=op.f('ck_workspaces_name_length')),
    sa.CheckConstraint('char_length(slug) between 1 and 64', name=op.f('ck_workspaces_slug_length')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_workspaces')),
    sa.UniqueConstraint('slug', name=op.f('uq_workspaces_slug'))
    )
    op.create_table('api_keys',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('key_prefix', sa.Text(), nullable=False),
    sa.Column('key_hash', sa.LargeBinary(), nullable=False),
    sa.Column('role', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("role in ('owner', 'admin', 'reviewer', 'viewer')", name=op.f('ck_api_keys_role')),
    sa.CheckConstraint('char_length(key_prefix) = 8', name=op.f('ck_api_keys_key_prefix_length')),
    sa.CheckConstraint('char_length(name) between 1 and 256', name=op.f('ck_api_keys_name_length')),
    sa.CheckConstraint('octet_length(key_hash) = 32', name=op.f('ck_api_keys_key_hash_sha256')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_api_keys_user_id_users')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_api_keys_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_api_keys')),
    sa.UniqueConstraint('key_hash', name=op.f('uq_api_keys_key_hash'))
    )
    op.create_index('ix_api_keys_workspace_id_user_id', 'api_keys', ['workspace_id', 'user_id'], unique=False)
    op.create_table('projects',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('default_dialect', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("key ~ '^[a-z0-9][a-z0-9_-]*$'", name=op.f('ck_projects_key_pattern')),
    sa.CheckConstraint('char_length(default_dialect) between 1 and 256', name=op.f('ck_projects_default_dialect_length')),
    sa.CheckConstraint('char_length(key) between 1 and 256', name=op.f('ck_projects_key_length')),
    sa.CheckConstraint('char_length(name) between 1 and 256', name=op.f('ck_projects_name_length')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_projects_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_projects')),
    sa.UniqueConstraint('workspace_id', 'key', name=op.f('uq_projects_workspace_id_key'))
    )
    op.create_table('sessions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('token_hash', sa.LargeBinary(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('csrf_token_hash', sa.LargeBinary(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('user_agent', sa.Text(), nullable=True),
    sa.Column('ip', sa.Text(), nullable=True),
    sa.CheckConstraint('octet_length(csrf_token_hash) = 32', name=op.f('ck_sessions_csrf_token_hash_sha256')),
    sa.CheckConstraint('octet_length(token_hash) = 32', name=op.f('ck_sessions_token_hash_sha256')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_sessions_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_sessions_token_hash'))
    )
    op.create_index('ix_sessions_expires_at', 'sessions', ['expires_at'], unique=False)
    op.create_index('ix_sessions_user_id', 'sessions', ['user_id'], unique=False)
    op.create_table('user_preferences',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('theme', sa.Text(), server_default='system', nullable=False),
    sa.Column('reduced_motion', sa.Boolean(), nullable=True),
    sa.Column('prefs', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("theme in ('dark', 'light', 'system')", name=op.f('ck_user_preferences_theme')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_preferences_user_id_users')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_user_preferences_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('user_id', 'workspace_id', name=op.f('pk_user_preferences'))
    )
    op.create_index('ix_user_preferences_workspace_id', 'user_preferences', ['workspace_id'], unique=False)
    op.create_table('workspace_members',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('role', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("role in ('owner', 'admin', 'reviewer', 'viewer')", name=op.f('ck_workspace_members_role')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_workspace_members_user_id_users')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_workspace_members_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('workspace_id', 'user_id', name=op.f('pk_workspace_members'))
    )
    op.create_table('connections',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('dialect', sa.Text(), nullable=False),
    sa.Column('mode', sa.Text(), server_default='direct', nullable=False),
    sa.Column('host', sa.Text(), nullable=True),
    sa.Column('port', sa.Integer(), nullable=True),
    sa.Column('database', sa.Text(), nullable=True),
    sa.Column('username', sa.Text(), nullable=True),
    sa.Column('tls_mode', sa.Text(), server_default='verify-full', nullable=False),
    sa.Column('encrypted_secret', sa.LargeBinary(), nullable=False),
    sa.Column('key_id', sa.Uuid(), nullable=False),
    sa.Column('allow_sample_values', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('allow_string_extremes', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('last_tested_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_test_status', sa.Text(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("dialect in ('postgresql', 'sqlite')", name=op.f('ck_connections_dialect')),
    sa.CheckConstraint("mode in ('direct', 'agent')", name=op.f('ck_connections_mode')),
    sa.CheckConstraint('char_length(database) between 1 and 4096', name=op.f('ck_connections_database_length')),
    sa.CheckConstraint('char_length(host) between 1 and 256', name=op.f('ck_connections_host_length')),
    sa.CheckConstraint('char_length(last_test_status) between 1 and 4096', name=op.f('ck_connections_last_test_status_length')),
    sa.CheckConstraint('char_length(name) between 1 and 256', name=op.f('ck_connections_name_length')),
    sa.CheckConstraint('char_length(tls_mode) between 1 and 256', name=op.f('ck_connections_tls_mode_length')),
    sa.CheckConstraint('char_length(username) between 1 and 256', name=op.f('ck_connections_username_length')),
    sa.CheckConstraint('port is null or port between 1 and 65535', name=op.f('ck_connections_port_range')),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_connections_created_by_users')),
    sa.ForeignKeyConstraint(['key_id'], ['encryption_keys.id'], name=op.f('fk_connections_key_id_encryption_keys'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_connections_project_id_projects')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_connections_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_connections'))
    )
    op.create_index('ix_connections_workspace_id_project_id', 'connections', ['workspace_id', 'project_id'], unique=False)
    op.create_table('snapshots',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('graph', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('sha256', sa.LargeBinary(), nullable=False),
    sa.Column('contract_version', sa.Text(), nullable=False),
    sa.Column('origin', sa.Text(), nullable=False),
    sa.Column('parent_snapshot_id', sa.Uuid(), nullable=True),
    sa.Column('source', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('table_count', sa.Integer(), nullable=False),
    sa.Column('column_count', sa.Integer(), nullable=False),
    sa.Column('link_count', sa.Integer(), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("contract_version ~ '^[0-9]+\\.[0-9]+$'", name=op.f('ck_snapshots_contract_version_pattern')),
    sa.CheckConstraint("origin in ('upload', 'extraction', 'profile', 'import')", name=op.f('ck_snapshots_origin')),
    sa.CheckConstraint('column_count >= 0', name=op.f('ck_snapshots_column_count_non_negative')),
    sa.CheckConstraint('link_count >= 0', name=op.f('ck_snapshots_link_count_non_negative')),
    sa.CheckConstraint('octet_length(sha256) = 32', name=op.f('ck_snapshots_sha256_digest')),
    sa.CheckConstraint('size_bytes >= 0', name=op.f('ck_snapshots_size_bytes_non_negative')),
    sa.CheckConstraint('table_count >= 0', name=op.f('ck_snapshots_table_count_non_negative')),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_snapshots_created_by_users')),
    sa.ForeignKeyConstraint(['parent_snapshot_id'], ['snapshots.id'], name=op.f('fk_snapshots_parent_snapshot_id_snapshots')),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_snapshots_project_id_projects')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_snapshots_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_snapshots'))
    )
    op.create_index('ix_snapshots_sha256', 'snapshots', ['sha256'], unique=False)
    op.create_index('ix_snapshots_workspace_id_project_id_created_at', 'snapshots', ['workspace_id', 'project_id', sa.literal_column('created_at desc')], unique=False)
    op.create_table('erd_layouts',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('snapshot_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('view', sa.Text(), nullable=False),
    sa.Column('fingerprint', sa.Text(), nullable=False),
    sa.Column('positions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('char_length(fingerprint) between 1 and 256', name=op.f('ck_erd_layouts_fingerprint_length')),
    sa.CheckConstraint('char_length(view) between 1 and 256', name=op.f('ck_erd_layouts_view_length')),
    sa.ForeignKeyConstraint(['snapshot_id'], ['snapshots.id'], name=op.f('fk_erd_layouts_snapshot_id_snapshots')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_erd_layouts_user_id_users')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_erd_layouts_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_erd_layouts'))
    )
    op.create_index('ix_erd_layouts_workspace_id_snapshot_id', 'erd_layouts', ['workspace_id', 'snapshot_id'], unique=False)
    op.create_index('uq_erd_layouts_snapshot_id_view_user_id', 'erd_layouts', ['snapshot_id', 'view', sa.literal_column("coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)")], unique=True)
    op.create_table('jobs',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('connection_id', sa.Uuid(), nullable=True),
    sa.Column('snapshot_id', sa.Uuid(), nullable=True),
    sa.Column('result_snapshot_id', sa.Uuid(), nullable=True),
    sa.Column('params', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('per_table_seconds', sa.Integer(), server_default=sa.text('5'), nullable=False),
    sa.Column('cap_seconds', sa.Integer(), server_default=sa.text('600'), nullable=False),
    sa.Column('requested_by', sa.Uuid(), nullable=False),
    sa.Column('claimed_by', sa.Text(), nullable=True),
    sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancel_requested_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('retain_until', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("kind in ('extract', 'profile', 'export')", name=op.f('ck_jobs_kind')),
    sa.CheckConstraint("status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')", name=op.f('ck_jobs_status')),
    sa.CheckConstraint('cap_seconds between 1 and 3600', name=op.f('ck_jobs_cap_seconds_range')),
    sa.CheckConstraint('char_length(claimed_by) between 1 and 256', name=op.f('ck_jobs_claimed_by_length')),
    sa.CheckConstraint('char_length(error) between 1 and 4096', name=op.f('ck_jobs_error_length')),
    sa.CheckConstraint('per_table_seconds between 1 and 60', name=op.f('ck_jobs_per_table_seconds_range')),
    sa.ForeignKeyConstraint(['connection_id'], ['connections.id'], name=op.f('fk_jobs_connection_id_connections')),
    sa.ForeignKeyConstraint(['requested_by'], ['users.id'], name=op.f('fk_jobs_requested_by_users')),
    sa.ForeignKeyConstraint(['result_snapshot_id'], ['snapshots.id'], name=op.f('fk_jobs_result_snapshot_id_snapshots')),
    sa.ForeignKeyConstraint(['snapshot_id'], ['snapshots.id'], name=op.f('fk_jobs_snapshot_id_snapshots')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_jobs_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs'))
    )
    op.create_index('ix_jobs_status_created_at', 'jobs', ['status', 'created_at'], unique=False)
    op.create_index('ix_jobs_workspace_id_created_at', 'jobs', ['workspace_id', 'created_at'], unique=False)
    op.create_index('uq_jobs_active_connection', 'jobs', ['connection_id'], unique=True, postgresql_where="status in ('queued', 'running')")
    op.create_table('review_decisions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('finding_id', sa.Text(), nullable=False),
    sa.Column('decision', sa.Text(), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('decided_by', sa.Uuid(), nullable=False),
    sa.Column('snapshot_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("decision in ('open', 'investigate', 'intentional', 'resolved')", name=op.f('ck_review_decisions_decision')),
    sa.CheckConstraint('char_length(finding_id) between 1 and 512', name=op.f('ck_review_decisions_finding_id_length')),
    sa.CheckConstraint('char_length(note) between 1 and 4096', name=op.f('ck_review_decisions_note_length')),
    sa.ForeignKeyConstraint(['decided_by'], ['users.id'], name=op.f('fk_review_decisions_decided_by_users')),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_review_decisions_project_id_projects')),
    sa.ForeignKeyConstraint(['snapshot_id'], ['snapshots.id'], name=op.f('fk_review_decisions_snapshot_id_snapshots')),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_review_decisions_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_review_decisions')),
    sa.UniqueConstraint('project_id', 'finding_id', name=op.f('uq_review_decisions_project_id_finding_id'))
    )
    op.create_index('ix_review_decisions_workspace_id_project_id', 'review_decisions', ['workspace_id', 'project_id'], unique=False)
    op.create_table('job_items',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('job_id', sa.Uuid(), nullable=False),
    sa.Column('table_id', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('queries_used', sa.Integer(), nullable=True),
    sa.Column('elapsed_ms', sa.Integer(), nullable=True),
    sa.Column('rows_sampled', sa.Integer(), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('retain_until', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("status in ('pending', 'running', 'done', 'partial', 'skipped', 'failed')", name=op.f('ck_job_items_status')),
    sa.CheckConstraint('char_length(reason) between 1 and 4096', name=op.f('ck_job_items_reason_length')),
    sa.CheckConstraint('char_length(table_id) between 1 and 256', name=op.f('ck_job_items_table_id_length')),
    sa.CheckConstraint('elapsed_ms >= 0', name=op.f('ck_job_items_elapsed_ms_non_negative')),
    sa.CheckConstraint('queries_used >= 0', name=op.f('ck_job_items_queries_used_non_negative')),
    sa.CheckConstraint('rows_sampled >= 0', name=op.f('ck_job_items_rows_sampled_non_negative')),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_job_items_job_id_jobs'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], name=op.f('fk_job_items_workspace_id_workspaces')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_job_items'))
    )
    op.create_index('ix_job_items_job_id_status', 'job_items', ['job_id', 'status'], unique=False)
    op.create_index('ix_job_items_workspace_id_retain_until', 'job_items', ['workspace_id', 'retain_until'], unique=False)

    # The audit trail is insert-only (CTQ-16). Created after audit_events exists.
    op.execute(AUDIT_IMMUTABLE_FUNCTION)
    op.execute(AUDIT_IMMUTABLE_TRIGGER)


def downgrade() -> None:
    # Trigger before function, function before the table it guards.
    op.execute('drop trigger if exists audit_events_no_update_delete on audit_events')
    op.execute('drop function if exists audit_events_immutable()')

    op.drop_index('ix_job_items_workspace_id_retain_until', table_name='job_items')
    op.drop_index('ix_job_items_job_id_status', table_name='job_items')
    op.drop_table('job_items')
    op.drop_index('ix_review_decisions_workspace_id_project_id', table_name='review_decisions')
    op.drop_table('review_decisions')
    op.drop_index('uq_jobs_active_connection', table_name='jobs', postgresql_where="status in ('queued', 'running')")
    op.drop_index('ix_jobs_workspace_id_created_at', table_name='jobs')
    op.drop_index('ix_jobs_status_created_at', table_name='jobs')
    op.drop_table('jobs')
    op.drop_index('uq_erd_layouts_snapshot_id_view_user_id', table_name='erd_layouts')
    op.drop_index('ix_erd_layouts_workspace_id_snapshot_id', table_name='erd_layouts')
    op.drop_table('erd_layouts')
    op.drop_index('ix_snapshots_workspace_id_project_id_created_at', table_name='snapshots')
    op.drop_index('ix_snapshots_sha256', table_name='snapshots')
    op.drop_table('snapshots')
    op.drop_index('ix_connections_workspace_id_project_id', table_name='connections')
    op.drop_table('connections')
    op.drop_table('workspace_members')
    op.drop_index('ix_user_preferences_workspace_id', table_name='user_preferences')
    op.drop_table('user_preferences')
    op.drop_index('ix_sessions_user_id', table_name='sessions')
    op.drop_index('ix_sessions_expires_at', table_name='sessions')
    op.drop_table('sessions')
    op.drop_table('projects')
    op.drop_index('ix_api_keys_workspace_id_user_id', table_name='api_keys')
    op.drop_table('api_keys')
    op.drop_table('workspaces')
    op.drop_table('users')
    op.drop_table('encryption_keys')
    op.drop_index('ix_audit_events_workspace_id_occurred_at', table_name='audit_events')
    op.drop_table('audit_events')

    # The citext extension is deliberately not dropped: see the module docstring.
