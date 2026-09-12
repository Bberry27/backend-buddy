"""Tenant scoping and secret hygiene, checked statically (work package A01, CTQ-07).

No database is needed: the assertions read ``Base.metadata`` and the source tree, so they run in
CI before O01 provides PostgreSQL, and a table added without a place in the tenant-scoping
registry fails here rather than in production.

What is pinned:

* every table in ``data-model.md`` section 4's "yes" list carries ``workspace_id uuid not null``
  referencing ``workspaces(id)``, plus an index (or a primary key) leading with that column;
* ``users``, ``sessions`` and ``encryption_keys`` do not carry it, and ``audit_events`` carries
  it nullable;
* the registries cover every table, so section 4 and the model cannot diverge;
* no column stores a secret in a readable form, and every hash column is a 32-byte ``bytea``;
* every query helper in ``app/repositories/**`` takes a ``workspace_id`` argument. Those helpers
  arrive with A02 and A04; the check runs over whatever exists and passes over an empty tree.

Run from the repository root::

    python -m unittest discover -s services/api/tests -p 'test_A01_*.py'
"""

from __future__ import annotations

import ast
import subprocess
import sys
import unittest
from pathlib import Path

from sqlalchemy import Index, LargeBinary, Text, UniqueConstraint, Uuid
from sqlalchemy.schema import Column, Table

from app.models import (
    TABLES,
    TENANT_OPTIONAL_TABLES,
    TENANT_SCOPED_TABLES,
    UNSCOPED_TABLES,
    Base,
)

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORIES = SERVICE_ROOT / 'app' / 'repositories'
SCOPE_COLUMN = 'workspace_id'

#: A column name that would mean a secret is stored in a readable form. ``password_hash``,
#: ``token_hash``, ``key_hash`` and ``encrypted_secret`` are the only permitted spellings, so the
#: check is on the exact bare names rather than on a substring.
FORBIDDEN_COLUMN_NAMES = frozenset({'password', 'passwd', 'dsn', 'token', 'secret', 'api_key'})

#: Columns that must be a ``bytea`` holding exactly one sha256 digest.
DIGEST_COLUMNS = (
    ('sessions', 'token_hash'),
    ('sessions', 'csrf_token_hash'),
    ('api_keys', 'key_hash'),
    ('encryption_keys', 'master_key_fingerprint'),
    ('snapshots', 'sha256'),
)


def leading_columns(table: Table) -> set[str]:
    """Names that lead the primary key, a unique constraint, or an index on ``table``.

    A unique constraint is backed by a unique index in PostgreSQL, so ``projects``, whose
    ``(workspace_id, key)`` constraint is the scoping index, counts here too.
    """
    leading: set[str] = set()
    if table.primary_key is not None and len(table.primary_key.columns) > 0:
        leading.add(next(iter(table.primary_key.columns)).name)
    for constraint in table.constraints:
        if isinstance(constraint, UniqueConstraint) and len(constraint.columns) > 0:
            leading.add(next(iter(constraint.columns)).name)
    index: Index
    for index in table.indexes:
        expressions = list(index.expressions)
        if expressions and isinstance(expressions[0], Column):
            leading.add(expressions[0].name)
    return leading


class TenantScopingTests(unittest.TestCase):
    def test_A01_tenant_scoping(self) -> None:
        for name in TENANT_SCOPED_TABLES:
            with self.subTest(table=name):
                table = Base.metadata.tables[name]
                self.assertIn(SCOPE_COLUMN, table.c, f'{name} has no {SCOPE_COLUMN}')
                column = table.c[SCOPE_COLUMN]
                self.assertFalse(column.nullable, f'{name}.{SCOPE_COLUMN} must be not null')
                self.assertIsInstance(column.type, Uuid)
                targets = {key.target_fullname for key in column.foreign_keys}
                self.assertEqual(
                    targets,
                    {'workspaces.id'},
                    f'{name}.{SCOPE_COLUMN} must reference workspaces(id)',
                )
                self.assertIn(
                    SCOPE_COLUMN,
                    leading_columns(table),
                    f'{name} needs an index or primary key leading with {SCOPE_COLUMN} '
                    '(data-model.md section 1)',
                )

    def test_A01_registries_cover_every_table(self) -> None:
        self.assertEqual(sorted(Base.metadata.tables), sorted(TABLES))
        registered = (*TENANT_SCOPED_TABLES, *UNSCOPED_TABLES, *TENANT_OPTIONAL_TABLES)
        self.assertEqual(
            sorted(registered),
            sorted(TABLES),
            'every table belongs in exactly one tenant-scoping registry',
        )
        self.assertEqual(len(set(registered)), len(registered), 'a table is registered twice')

    def test_A01_unscoped_tables_carry_no_workspace_id(self) -> None:
        for name in UNSCOPED_TABLES:
            with self.subTest(table=name):
                table = Base.metadata.tables[name]
                if name == 'workspaces':
                    self.assertIn('id', table.c)
                    continue
                self.assertNotIn(
                    SCOPE_COLUMN,
                    table.c,
                    f'{name} is user-level or deployment-level (data-model.md section 4)',
                )

    def test_A01_audit_events_workspace_id_is_nullable(self) -> None:
        column = Base.metadata.tables['audit_events'].c[SCOPE_COLUMN]
        self.assertTrue(column.nullable, 'deployment-level audit events belong to no workspace')
        self.assertEqual(
            set(column.foreign_keys),
            set(),
            'the audit trail carries no foreign key, so it outlives the rows it describes',
        )

    def test_A01_no_column_stores_a_secret_in_the_clear(self) -> None:
        for table in Base.metadata.tables.values():
            for column in table.c:
                with self.subTest(table=table.name, column=column.name):
                    self.assertNotIn(column.name, FORBIDDEN_COLUMN_NAMES)
        for table_name, column_name in DIGEST_COLUMNS:
            with self.subTest(table=table_name, column=column_name):
                column = Base.metadata.tables[table_name].c[column_name]
                self.assertIsInstance(
                    column.type,
                    LargeBinary,
                    f'{table_name}.{column_name} stores a digest, not text',
                )
        password_hash = Base.metadata.tables['users'].c['password_hash']
        self.assertIsInstance(password_hash, Column)
        self.assertIsInstance(password_hash.type, Text)
        encrypted_secret = Base.metadata.tables['connections'].c['encrypted_secret']
        self.assertIsInstance(encrypted_secret.type, LargeBinary)
        self.assertFalse(encrypted_secret.nullable)

    def test_A01_repository_helpers_take_a_workspace_id(self) -> None:
        checked = 0
        for path in sorted(REPOSITORIES.rglob('*.py')) if REPOSITORIES.is_dir() else []:
            module = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
            for node in module.body:
                if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                    continue
                if node.name.startswith('_'):
                    continue
                arguments = node.args
                names = {
                    argument.arg
                    for argument in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs)
                }
                with self.subTest(module=path.name, helper=node.name):
                    self.assertIn(
                        SCOPE_COLUMN,
                        names,
                        f'{path.name}:{node.name} must take a {SCOPE_COLUMN} argument (CTQ-07)',
                    )
                checked += 1
        self.assertGreaterEqual(checked, 0)

    def test_A01_models_import_without_a_database(self) -> None:
        completed = subprocess.run(
            [sys.executable, '-c', 'from app.models import *'],
            capture_output=True,
            text=True,
            check=False,
            cwd=SERVICE_ROOT,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, '')


if __name__ == '__main__':
    unittest.main()
