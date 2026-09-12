"""Migration round trip and model-to-migration drift (work package A01, CTQ-15).

``upgrade -> downgrade -> upgrade`` runs against a freshly created, empty PostgreSQL 16 database,
so "empty" is a property of the test rather than of the operator's luck. Each phase asserts what
the database actually contains: the fifteen tables, the audit trigger and its function after an
upgrade; none of them and an empty version table after a downgrade.

``test_A01_migration_matches_models`` closes the gap a hand-written revision leaves: Alembic's
own comparison of the migrated database against ``Base.metadata`` must find no table or column
difference, so ``0001`` and ``app.models`` cannot drift apart.

Run from the repository root::

    python -m unittest discover -s services/api/tests -p 'test_A01_*.py'
"""

from __future__ import annotations

import sys
import time
import unittest
from inspect import getsource
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import URL, create_engine, inspect, text

from alembic import command
from app.models import AUDIT_TRIGGER_FUNCTION, AUDIT_TRIGGER_NAME, TABLES, Base

# `unittest discover -s services/api/tests` puts only that directory on the path, so the helper
# package is added here rather than relying on how discovery was invoked.
if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.conftest_db import alembic_config, temporary_database  # noqa: E402  (path set up above)

#: The only revision A01 ships.
EXPECTED_REVISION = '0001'

#: Differences ``compare_metadata`` may report that are not drift in the schema itself: reflected
#: expression indexes and reflected server defaults are normalised by PostgreSQL, so they compare
#: unequal without anything being wrong. Table and column differences are never tolerated.
TOLERATED_DIFFERENCE_KINDS = frozenset({
    'add_index',
    'remove_index',
    'add_constraint',
    'remove_constraint',
    'modify_default',
})


def difference_kind(difference: object) -> str:
    """The operation name of one ``compare_metadata`` entry."""
    if isinstance(difference, tuple) and difference and isinstance(difference[0], str):
        return difference[0]
    if isinstance(difference, list) and difference:
        return difference_kind(difference[0])
    return repr(difference)


class MigrationTests(unittest.TestCase):
    def assertSchemaPresent(self, url: URL) -> None:
        engine = create_engine(url)
        try:
            inspector = inspect(engine)
            self.assertEqual(sorted(set(TABLES) - set(inspector.get_table_names())), [])
            with engine.connect() as connection:
                trigger = connection.execute(
                    text('select tgname from pg_trigger where tgname = :name'),
                    {'name': AUDIT_TRIGGER_NAME},
                ).scalar_one_or_none()
                function = connection.execute(
                    text('select proname from pg_proc where proname = :name'),
                    {'name': AUDIT_TRIGGER_FUNCTION},
                ).scalar_one_or_none()
                extension = connection.execute(
                    text("select extname from pg_extension where extname = 'citext'")
                ).scalar_one_or_none()
            self.assertEqual(trigger, AUDIT_TRIGGER_NAME)
            self.assertEqual(function, AUDIT_TRIGGER_FUNCTION)
            self.assertEqual(extension, 'citext')
        finally:
            engine.dispose()

    def assertSchemaAbsent(self, url: URL) -> None:
        engine = create_engine(url)
        try:
            inspector = inspect(engine)
            remaining = sorted(set(TABLES) & set(inspector.get_table_names()))
            self.assertEqual(remaining, [], f'downgrade left {remaining} behind')
            with engine.connect() as connection:
                self.assertIsNone(
                    connection.execute(
                        text('select tgname from pg_trigger where tgname = :name'),
                        {'name': AUDIT_TRIGGER_NAME},
                    ).scalar_one_or_none(),
                )
                self.assertIsNone(
                    connection.execute(
                        text('select proname from pg_proc where proname = :name'),
                        {'name': AUDIT_TRIGGER_FUNCTION},
                    ).scalar_one_or_none(),
                )
                version = connection.execute(text('select count(*) from alembic_version')).scalar_one()
            self.assertEqual(version, 0, 'the version table still records a revision')
        finally:
            engine.dispose()

    def test_A01_upgrade_downgrade_upgrade(self) -> None:
        with temporary_database() as url:
            config = alembic_config(url)

            started = time.perf_counter()
            command.upgrade(config, 'head')
            first_upgrade_seconds = time.perf_counter() - started
            self.assertSchemaPresent(url)

            command.downgrade(config, 'base')
            self.assertSchemaAbsent(url)

            started = time.perf_counter()
            command.upgrade(config, 'head')
            second_upgrade_seconds = time.perf_counter() - started
            self.assertSchemaPresent(url)

            # Recorded for O01's `docker compose up` to `/readyz` budget of five minutes (CTQ-15).
            print(
                f'A01 upgrade wall time: first {first_upgrade_seconds:.2f} s, '
                f'after downgrade {second_upgrade_seconds:.2f} s'
            )
            self.assertLess(first_upgrade_seconds, 60.0, 'revision 0001 must not dominate startup')

    def test_A01_history_has_one_revision(self) -> None:
        with temporary_database() as url:
            script = ScriptDirectory.from_config(alembic_config(url))
            revisions = list(script.walk_revisions())
            self.assertEqual([revision.revision for revision in revisions], [EXPECTED_REVISION])
            self.assertIsNone(revisions[0].down_revision)

    def test_A01_migration_matches_models(self) -> None:
        with temporary_database() as url:
            command.upgrade(alembic_config(url), 'head')
            engine = create_engine(url)
            try:
                with engine.connect() as connection:
                    context = MigrationContext.configure(connection)
                    differences = compare_metadata(context, Base.metadata)
            finally:
                engine.dispose()
        structural = [
            difference
            for difference in differences
            if difference_kind(difference) not in TOLERATED_DIFFERENCE_KINDS
        ]
        self.assertEqual(
            structural,
            [],
            'revision 0001 and app.models describe different tables or columns',
        )

    def test_A01_every_revision_has_a_real_downgrade(self) -> None:
        """A ``downgrade()`` that is only ``pass`` would pass the round trip and lose the schema."""
        with temporary_database() as url:
            script = ScriptDirectory.from_config(alembic_config(url))
            for revision in script.walk_revisions():
                with self.subTest(revision=revision.revision):
                    downgrade = getattr(revision.module, 'downgrade', None)
                    if not callable(downgrade):
                        self.fail(f'revision {revision.revision} defines no downgrade()')
                    body = getsource(downgrade)
                    self.assertIn('op.', body, 'downgrade() reverses nothing')
                    self.assertRegex(body, r'op\.drop_table\(')


if __name__ == '__main__':
    unittest.main()
