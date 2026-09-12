"""Database helper for the A01 suites (unittest, per ADR-0008).

The suites need a real PostgreSQL 16 -- a partial unique index, a ``plpgsql`` trigger, ``citext``
and a regular-expression check constraint have no SQLite equivalent -- so the URL comes from the
environment and nothing is assumed about the host (RK-09):

    BB_TEST_DATABASE_URL=postgresql://backend-buddy:backend-buddy@127.0.0.1:55432/backend-buddy_test

Every database test runs against its own throwaway database created from that server, so
"upgrade -> downgrade -> upgrade against an empty database" is true by construction and the
suite never touches a database an operator cares about. :func:`temporary_database` creates it,
migrates nothing, and drops it afterwards.

When the variable is unset the suites skip locally and **fail** under ``CI``: a silently skipped
suite is a failure by CTQ-12, and O01 is the work package that gives CI the database.
"""

from __future__ import annotations

import os
import unittest
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from alembic.config import Config
from sqlalchemy import URL, Engine, NullPool, create_engine, insert, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError

from alembic import command
from app.db import ConfigError, database_url
from app.models import Base

__all__ = [
    'ALEMBIC_INI',
    'DatabaseTestCase',
    'REQUIRED_VARIABLE',
    'SERVICE_ROOT',
    'alembic_config',
    'require_database_url',
    'seed_reference_rows',
    'sha256_placeholder',
    'temporary_database',
]

#: ``services/api``.
SERVICE_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = SERVICE_ROOT / 'alembic.ini'

REQUIRED_VARIABLE = 'BB_TEST_DATABASE_URL'
_INSTRUCTIONS = (
    f'{REQUIRED_VARIABLE} is not set. Start a throwaway PostgreSQL 16 and point the suite at it:\n'
    '  docker run -d --name backend-buddy-a01-pg -e POSTGRES_USER=backend-buddy -e POSTGRES_PASSWORD=backend-buddy \\\n'
    '    -e POSTGRES_DB=backend-buddy_test -p 127.0.0.1:55432:5432 postgres:16\n'
    f'  export {REQUIRED_VARIABLE}=postgresql://backend-buddy:backend-buddy@127.0.0.1:55432/backend-buddy_test'
)


def require_database_url() -> URL:
    """The test server's URL, or a skip locally and a failure under ``CI`` (CTQ-12)."""
    raw = (os.environ.get(REQUIRED_VARIABLE) or '').strip()
    if not raw:
        if os.environ.get('CI'):
            raise AssertionError(_INSTRUCTIONS)
        raise unittest.SkipTest(_INSTRUCTIONS)
    try:
        # Reuse the application's own resolution, so the suite exercises the URL normalisation
        # (`postgresql://` -> `postgresql+psycopg://`) that the deployment relies on.
        return database_url({REQUIRED_VARIABLE: raw})
    except ConfigError as error:
        raise AssertionError(str(error)) from None


def alembic_config(url: URL) -> Config:
    """An Alembic config for ``url``, quiet enough to run inside a test."""
    config = Config(str(ALEMBIC_INI))
    config.set_main_option('script_location', str(SERVICE_ROOT / 'alembic'))
    config.attributes['url'] = url
    config.attributes['configure_logger'] = False
    return config


@contextmanager
def temporary_database(prefix: str = 'backend-buddy_a01') -> Iterator[URL]:
    """Create an empty database on the test server, yield its URL, and drop it afterwards."""
    server = require_database_url()
    name = f'{prefix}_{uuid.uuid4().hex[:12]}'
    # `create database` cannot run inside a transaction block, hence AUTOCOMMIT, and it cannot
    # run against the database being created, hence the maintenance connection to `postgres`.
    maintenance = create_engine(
        server.set(database='postgres'),
        isolation_level='AUTOCOMMIT',
        poolclass=NullPool,
    )
    try:
        with maintenance.connect() as connection:
            connection.execute(text(f'create database "{name}"'))
        try:
            yield server.set(database=name)
        finally:
            with maintenance.connect() as connection:
                connection.execute(text(f'drop database if exists "{name}" with (force)'))
    finally:
        maintenance.dispose()


def sha256_placeholder(seed: int = 0) -> bytes:
    """32 distinct bytes: a stand-in digest for a column that stores exactly one sha256."""
    return bytes((seed + index) % 256 for index in range(32))


def seed_reference_rows(connection: Connection) -> dict[str, Any]:
    """Insert one workspace, user, project, snapshot, encryption key, and connection.

    Returns the generated ids so a test can build the row it actually wants to assert on. Every
    value is synthetic and carries no count or name from any real schema (ADR-0007).
    """
    tables = Base.metadata.tables
    workspace_id = connection.execute(
        insert(tables['workspaces'])
        .values(slug='test-workspace', name='Test workspace')
        .returning(tables['workspaces'].c.id)
    ).scalar_one()
    user_id = connection.execute(
        insert(tables['users'])
        .values(email='reviewer@example.test', password_hash='argon2id$placeholder')
        .returning(tables['users'].c.id)
    ).scalar_one()
    project_id = connection.execute(
        insert(tables['projects'])
        .values(workspace_id=workspace_id, key='sample-project', name='Sample project')
        .returning(tables['projects'].c.id)
    ).scalar_one()
    snapshot_id = connection.execute(
        insert(tables['snapshots'])
        .values(
            workspace_id=workspace_id,
            project_id=project_id,
            graph={'contractVersion': '1.0', 'project': {'key': 'sample-project'}},
            sha256=sha256_placeholder(1),
            contract_version='1.0',
            origin='upload',
            source={'file': 'sample.json'},
            table_count=0,
            column_count=0,
            link_count=0,
            size_bytes=64,
            created_by=user_id,
        )
        .returning(tables['snapshots'].c.id)
    ).scalar_one()
    key_id = connection.execute(
        insert(tables['encryption_keys'])
        .values(algorithm='AES-256-GCM', master_key_fingerprint=sha256_placeholder(2))
        .returning(tables['encryption_keys'].c.id)
    ).scalar_one()
    connection_id = connection.execute(
        insert(tables['connections'])
        .values(
            workspace_id=workspace_id,
            name='Sample connection',
            dialect='postgresql',
            encrypted_secret=b'ciphertext-placeholder',
            key_id=key_id,
            created_by=user_id,
        )
        .returning(tables['connections'].c.id)
    ).scalar_one()
    second_connection_id = connection.execute(
        insert(tables['connections'])
        .values(
            workspace_id=workspace_id,
            name='Second connection',
            dialect='sqlite',
            database='/var/lib/worker/sample.sqlite',
            encrypted_secret=b'ciphertext-placeholder',
            key_id=key_id,
            created_by=user_id,
        )
        .returning(tables['connections'].c.id)
    ).scalar_one()
    return {
        'workspace_id': workspace_id,
        'user_id': user_id,
        'project_id': project_id,
        'snapshot_id': snapshot_id,
        'key_id': key_id,
        'connection_id': connection_id,
        'second_connection_id': second_connection_id,
    }


class DatabaseTestCase(unittest.TestCase):
    """Base class for the suites that need the schema at head.

    One throwaway database per class, migrated once; one transaction per test, rolled back, so
    the cases are order-independent. A statement expected to fail is wrapped in a savepoint by
    :meth:`assertRejected`, because a failed statement otherwise aborts the whole transaction.
    """

    url: URL
    engine: Engine
    _database: Any

    @classmethod
    def setUpClass(cls) -> None:
        cls._database = temporary_database()
        cls.url = cls._database.__enter__()
        command.upgrade(alembic_config(cls.url), 'head')
        cls.engine = create_engine(cls.url)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.engine.dispose()
        cls._database.__exit__(None, None, None)

    def setUp(self) -> None:
        self.connection = self.engine.connect()
        self.transaction = self.connection.begin()
        self.addCleanup(self._rollback)

    def _rollback(self) -> None:
        self.transaction.rollback()
        self.connection.close()

    def assertRejected(self, statement: str, *, sqlstate: str) -> str:
        """Run ``statement``, assert it fails with ``sqlstate``, and return the error message.

        The statement runs inside a savepoint, so the surrounding transaction survives and the
        next assertion in the same test still works.
        """
        with self.assertRaises(DBAPIError) as raised, self.connection.begin_nested():
            self.connection.execute(text(statement))
        code = getattr(getattr(raised.exception, 'orig', None), 'sqlstate', None)
        self.assertEqual(
            code,
            sqlstate,
            f'expected SQLSTATE {sqlstate}, got {code}: {raised.exception}',
        )
        return str(raised.exception)
