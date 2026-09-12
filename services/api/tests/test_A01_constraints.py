"""Check constraints, defaults, and the uniqueness rules (work package A01, CTQ-08 / CTQ-16).

These are the storage-layer guards the plan asks for, proved against a real PostgreSQL 16 rather
than against the model objects that declare them:

* the status and kind enumerations frozen by ``data-model.md`` 3.7, 3.10, 3.11, 3.12, 3.14 reject
  a value outside their set with SQLSTATE ``23514``;
* ``jobs.per_table_seconds`` and ``jobs.cap_seconds`` default to 5 and 600 and refuse 61 and 3601,
  which is where the profiling budgets in ``limits-and-caps.md`` section B stop being advice
  (RK-06);
* the partial unique index allows one queued-or-running job per connection and lets a finished
  one coexist with a new queued one;
* a review decision is unique per project and finding, and ``finding_id`` is capped;
* an ERD layout is unique per snapshot, view, and user, counting the shared layout as one owner;
* every hash and fingerprint column refuses anything but 32 bytes.

Run from the repository root::

    python -m unittest discover -s services/api/tests -p 'test_A01_*.py'
"""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from typing import Any, cast

from sqlalchemy import insert, select

from app.models import (
    ACTIVE_JOB_INDEX,
    CAP_SECONDS_DEFAULT,
    CAP_SECONDS_MAX,
    FINDING_ID_CAP,
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
)

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.conftest_db import DatabaseTestCase, seed_reference_rows, sha256_placeholder  # noqa: E402

#: ``check_violation``: PostgreSQL's SQLSTATE for a failed check constraint.
CHECK_VIOLATION = '23514'
#: ``unique_violation``.
UNIQUE_VIOLATION = '23505'

TABLES = Base.metadata.tables


class ConstraintTests(DatabaseTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.ids = seed_reference_rows(self.connection)

    def insert_job(self, **overrides: Any) -> uuid.UUID:
        values: dict[str, Any] = {
            'workspace_id': self.ids['workspace_id'],
            'kind': 'profile',
            'status': 'queued',
            'connection_id': self.ids['connection_id'],
            'params': {'tables': []},
            'requested_by': self.ids['user_id'],
        }
        values.update(overrides)
        job_id = self.connection.execute(
            insert(TABLES['jobs']).values(**values).returning(TABLES['jobs'].c.id)
        ).scalar_one()
        return cast(uuid.UUID, job_id)

    def insert_job_item(self, job_id: uuid.UUID, **overrides: Any) -> None:
        values: dict[str, Any] = {
            'workspace_id': self.ids['workspace_id'],
            'job_id': job_id,
            'table_id': 'public.sample_table',
            'status': 'pending',
            'retain_until': '2027-01-01T00:00:00+00:00',
        }
        values.update(overrides)
        self.connection.execute(insert(TABLES['job_items']).values(**values))

    def assertValueRejected(self, table: str, column: str, value: str, statement: str) -> None:
        """``statement`` must fail with ``23514`` and name the table and column at fault."""
        message = self.assertRejected(statement, sqlstate=CHECK_VIOLATION)
        self.assertIn(table, message)
        self.assertIn(column, message, f'{table}.{column} must reject {value!r}')

    # -- enumerations ---------------------------------------------------------------------------

    def test_A01_check_constraints(self) -> None:
        workspace = self.ids['workspace_id']
        user = self.ids['user_id']
        project = self.ids['project_id']
        connection = self.ids['connection_id']
        rejected = (
            (
                'jobs',
                'status',
                f"insert into jobs (workspace_id, kind, status, connection_id, params, "
                f"requested_by) values ('{workspace}', 'profile', 'pending', '{connection}', "
                f"'{{}}'::jsonb, '{user}')",
            ),
            (
                'jobs',
                'kind',
                f"insert into jobs (workspace_id, kind, status, params, requested_by) "
                f"values ('{workspace}', 'analyse', 'queued', '{{}}'::jsonb, '{user}')",
            ),
            (
                'snapshots',
                'origin',
                f"insert into snapshots (workspace_id, project_id, graph, sha256, "
                f"contract_version, origin, source, table_count, column_count, link_count, "
                f"size_bytes) values ('{workspace}', '{project}', '{{}}'::jsonb, "
                f"repeat('a', 32)::bytea, '1.0', 'scraped', '{{}}'::jsonb, 0, 0, 0, 0)",
            ),
            (
                'review_decisions',
                'decision',
                f"insert into review_decisions (workspace_id, project_id, finding_id, decision, "
                f"decided_by) values ('{workspace}', '{project}', 'finding-1', 'maybe', '{user}')",
            ),
            (
                'workspace_members',
                'role',
                f"insert into workspace_members (workspace_id, user_id, role) "
                f"values ('{workspace}', '{user}', 'superuser')",
            ),
            (
                'user_preferences',
                'theme',
                f"insert into user_preferences (workspace_id, user_id, theme) "
                f"values ('{workspace}', '{user}', 'sepia')",
            ),
            (
                'encryption_keys',
                'algorithm',
                "insert into encryption_keys (algorithm, master_key_fingerprint) "
                "values ('ROT13', repeat('a', 32)::bytea)",
            ),
            (
                'connections',
                'dialect',
                f"insert into connections (workspace_id, name, dialect, encrypted_secret, key_id, "
                f"created_by) values ('{workspace}', 'Other', 'mysql', 'x'::bytea, "
                f"'{self.ids['key_id']}', '{user}')",
            ),
            (
                'connections',
                'mode',
                f"insert into connections (workspace_id, name, dialect, mode, encrypted_secret, "
                f"key_id, created_by) values ('{workspace}', 'Other', 'sqlite', 'proxy', "
                f"'x'::bytea, '{self.ids['key_id']}', '{user}')",
            ),
            (
                'projects',
                'key',
                f"insert into projects (workspace_id, key, name) "
                f"values ('{workspace}', 'Not_A_Key', 'Rejected')",
            ),
            (
                'workspaces',
                'slug',
                "insert into workspaces (slug, name) values ('-leading-dash', 'Rejected')",
            ),
            (
                'snapshots',
                'contract_version',
                f"insert into snapshots (workspace_id, project_id, graph, sha256, "
                f"contract_version, origin, source, table_count, column_count, link_count, "
                f"size_bytes) values ('{workspace}', '{project}', '{{}}'::jsonb, "
                f"repeat('a', 32)::bytea, 'one-point-oh', 'upload', '{{}}'::jsonb, 0, 0, 0, 0)",
            ),
            (
                'snapshots',
                'sha256',
                f"insert into snapshots (workspace_id, project_id, graph, sha256, "
                f"contract_version, origin, source, table_count, column_count, link_count, "
                f"size_bytes) values ('{workspace}', '{project}', '{{}}'::jsonb, "
                f"'short'::bytea, '1.0', 'upload', '{{}}'::jsonb, 0, 0, 0, 0)",
            ),
            (
                'review_decisions',
                'finding_id',
                f"insert into review_decisions (workspace_id, project_id, finding_id, decision, "
                f"decided_by) values ('{workspace}', '{project}', "
                f"repeat('f', {FINDING_ID_CAP + 1}), 'open', '{user}')",
            ),
        )
        for table, column, statement in rejected:
            with self.subTest(table=table, column=column):
                self.assertValueRejected(table, column, column, statement)

        # The profiling budgets in limits-and-caps.md section B are column defaults here, and the
        # round trip that proves the database applies them is test_A01_budget_defaults_and_caps.
        self.assertEqual((PER_TABLE_SECONDS_DEFAULT, PER_TABLE_SECONDS_MAX), (5, 60))
        self.assertEqual((CAP_SECONDS_DEFAULT, CAP_SECONDS_MAX), (600, 3600))
        self.assertEqual(FINDING_ID_CAP, 512, 'decided in A01; data-model.md section 6')

    def test_A01_every_documented_enumeration_value_is_accepted(self) -> None:
        """The mirror of the rejection test: the frozen sets must all be insertable."""
        for status in JOB_STATUSES:
            with self.subTest(job_status=status):
                # A finished job frees the connection, so only the active ones need a distinct one.
                self.insert_job(status=status, connection_id=None)
        for kind in JOB_KINDS:
            with self.subTest(job_kind=kind):
                self.insert_job(kind=kind, connection_id=None)
        job_id = self.insert_job(connection_id=None)
        for status in JOB_ITEM_STATUSES:
            with self.subTest(item_status=status):
                self.insert_job_item(job_id, status=status)
        for origin in SNAPSHOT_ORIGINS:
            with self.subTest(origin=origin):
                self.connection.execute(
                    insert(TABLES['snapshots']).values(
                        workspace_id=self.ids['workspace_id'],
                        project_id=self.ids['project_id'],
                        graph={},
                        sha256=sha256_placeholder(3),
                        contract_version='1.0',
                        origin=origin,
                        source={},
                        table_count=0,
                        column_count=0,
                        link_count=0,
                        size_bytes=0,
                    )
                )
        for role in WORKSPACE_ROLES:
            with self.subTest(role=role):
                self.connection.execute(
                    insert(TABLES['api_keys']).values(
                        workspace_id=self.ids['workspace_id'],
                        user_id=self.ids['user_id'],
                        name=f'key for {role}',
                        key_prefix='backend-buddy_ab1',
                        key_hash=sha256_placeholder(WORKSPACE_ROLES.index(role) + 10),
                        role=role,
                    )
                )
        for decision in REVIEW_DECISIONS:
            with self.subTest(decision=decision):
                self.connection.execute(
                    insert(TABLES['review_decisions']).values(
                        workspace_id=self.ids['workspace_id'],
                        project_id=self.ids['project_id'],
                        finding_id=f'finding-{decision}',
                        decision=decision,
                        decided_by=self.ids['user_id'],
                    )
                )
        self.assertEqual(sorted(THEMES), ['dark', 'light', 'system'])

    # -- budgets --------------------------------------------------------------------------------

    def test_A01_budget_defaults_and_caps(self) -> None:
        job_id = self.insert_job(connection_id=None)
        row = self.connection.execute(
            select(TABLES['jobs'].c.per_table_seconds, TABLES['jobs'].c.cap_seconds)
            .where(TABLES['jobs'].c.id == job_id)
        ).one()
        self.assertEqual(row.per_table_seconds, PER_TABLE_SECONDS_DEFAULT)
        self.assertEqual(row.cap_seconds, CAP_SECONDS_DEFAULT)
        self.assertEqual((PER_TABLE_SECONDS_DEFAULT, PER_TABLE_SECONDS_MAX), (5, 60))
        self.assertEqual((CAP_SECONDS_DEFAULT, CAP_SECONDS_MAX), (600, 3600))

        # The maximum is accepted; one second past it is not (RK-06).
        self.insert_job(connection_id=None, per_table_seconds=PER_TABLE_SECONDS_MAX)
        self.insert_job(connection_id=None, cap_seconds=CAP_SECONDS_MAX)
        base = (
            f"insert into jobs (workspace_id, kind, status, params, requested_by, "
            f"{{column}}) values ('{self.ids['workspace_id']}', 'profile', 'queued', "
            f"'{{{{}}}}'::jsonb, '{self.ids['user_id']}', {{value}})"
        )
        self.assertValueRejected(
            'jobs',
            'per_table_seconds',
            str(PER_TABLE_SECONDS_MAX + 1),
            base.format(column='per_table_seconds', value=PER_TABLE_SECONDS_MAX + 1),
        )
        self.assertValueRejected(
            'jobs',
            'cap_seconds',
            str(CAP_SECONDS_MAX + 1),
            base.format(column='cap_seconds', value=CAP_SECONDS_MAX + 1),
        )
        self.assertValueRejected(
            'jobs',
            'per_table_seconds',
            '0',
            base.format(column='per_table_seconds', value=0),
        )

    # -- uniqueness -----------------------------------------------------------------------------

    def test_A01_one_running_job_per_connection(self) -> None:
        connection_id = self.ids['connection_id']
        other_id = self.ids['second_connection_id']
        self.insert_job(status='queued', connection_id=connection_id)

        for status in ('queued', 'running'):
            with self.subTest(second_status=status):
                message = self.assertRejected(
                    f"insert into jobs (workspace_id, kind, status, connection_id, params, "
                    f"requested_by) values ('{self.ids['workspace_id']}', 'profile', '{status}', "
                    f"'{connection_id}', '{{}}'::jsonb, '{self.ids['user_id']}')",
                    sqlstate=UNIQUE_VIOLATION,
                )
                self.assertIn(ACTIVE_JOB_INDEX, message)

        # Another connection may run at the same time.
        self.insert_job(status='running', connection_id=other_id)

        # A finished job does not hold the slot: the index covers queued and running only.
        for status in ('succeeded', 'partial', 'failed', 'cancelled'):
            with self.subTest(finished_status=status):
                self.insert_job(status=status, connection_id=connection_id)

    def test_A01_review_decision_is_unique_per_project_and_finding(self) -> None:
        values = {
            'workspace_id': self.ids['workspace_id'],
            'project_id': self.ids['project_id'],
            'finding_id': 'table|rule|columns|signature',
            'decision': 'investigate',
            'decided_by': self.ids['user_id'],
        }
        self.connection.execute(insert(TABLES['review_decisions']).values(**values))
        message = self.assertRejected(
            f"insert into review_decisions (workspace_id, project_id, finding_id, decision, "
            f"decided_by) values ('{values['workspace_id']}', '{values['project_id']}', "
            f"'{values['finding_id']}', 'resolved', '{values['decided_by']}')",
            sqlstate=UNIQUE_VIOLATION,
        )
        self.assertIn('uq_review_decisions_project_id_finding_id', message)

    def test_A01_erd_layout_is_unique_per_snapshot_view_and_user(self) -> None:
        shared = {
            'workspace_id': self.ids['workspace_id'],
            'snapshot_id': self.ids['snapshot_id'],
            'view': 'living',
            'fingerprint': 'fingerprint-1',
            'positions': {'version': 1, 'positions': {}},
        }
        self.connection.execute(insert(TABLES['erd_layouts']).values(**shared))
        # A per-user layout coexists with the shared one.
        self.connection.execute(
            insert(TABLES['erd_layouts']).values(**shared, user_id=self.ids['user_id'])
        )
        message = self.assertRejected(
            f"insert into erd_layouts (workspace_id, snapshot_id, view, fingerprint, positions) "
            f"values ('{shared['workspace_id']}', '{shared['snapshot_id']}', 'living', "
            f"'fingerprint-2', '{{}}'::jsonb)",
            sqlstate=UNIQUE_VIOLATION,
        )
        self.assertIn('uq_erd_layouts_snapshot_id_view_user_id', message)

    def test_A01_encryption_key_cannot_be_deleted_while_referenced(self) -> None:
        """``data-model.md`` 3.9: old ciphertext stays decryptable until it is rewrapped."""
        self.assertRejected(
            f"delete from encryption_keys where id = '{self.ids['key_id']}'",
            sqlstate='23503',  # foreign_key_violation
        )

    def test_A01_job_items_are_removed_with_their_job(self) -> None:
        job_id = self.insert_job(connection_id=None)
        self.insert_job_item(job_id)
        self.connection.execute(
            TABLES['jobs'].delete().where(TABLES['jobs'].c.id == job_id)
        )
        remaining = self.connection.execute(
            select(TABLES['job_items'].c.id).where(TABLES['job_items'].c.job_id == job_id)
        ).all()
        self.assertEqual(remaining, [], 'the retention purge deletes a job in one statement')


if __name__ == '__main__':
    unittest.main()
