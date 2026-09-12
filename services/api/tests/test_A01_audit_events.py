"""The audit trail is insert-only (work package A01, CTQ-16).

``audit_events`` is the record an incident review depends on, so the database itself refuses to
change it. Both rejected operations are proved, not just one: an UPDATE and a DELETE of a row
that exists must each raise SQLSTATE ``42501`` from the trigger
``audit_events_no_update_delete``, and the message must name the rejected operation.

The trigger is ``for each row``, which is why ``update audit_events set action='x' where false``
succeeds with ``UPDATE 0``: no row is affected, so no trigger fires. That behaviour is asserted
here as well, so nobody later mistakes it for a hole in the control.

``ops/sql/roles.sql`` withholds UPDATE and DELETE from the application role too. That is the
first line of defence; this trigger is the one that holds even when a role is misconfigured.

Run from the repository root::

    python -m unittest discover -s services/api/tests -p 'test_A01_*.py'
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import cast

from sqlalchemy import insert, select, text

from app.models import (
    AUDIT_TRIGGER_ERRCODE,
    AUDIT_TRIGGER_FUNCTION,
    AUDIT_TRIGGER_NAME,
    Base,
)

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.conftest_db import DatabaseTestCase  # noqa: E402  (path set up above)

AUDIT = Base.metadata.tables['audit_events']


class AuditEventsTests(DatabaseTestCase):
    def insert_event(self, action: str = 'login.success') -> int:
        event_id = self.connection.execute(
            insert(AUDIT).values(action=action, details={'source': 'test'}).returning(AUDIT.c.id)
        ).scalar_one()
        return cast(int, event_id)

    def test_A01_audit_update_delete_rejected(self) -> None:
        event_id = self.insert_event()

        update_message = self.assertRejected(
            f"update audit_events set action = 'tampered' where id = {event_id}",
            sqlstate=AUDIT_TRIGGER_ERRCODE,
        )
        self.assertIn('audit_events is insert-only', update_message)
        self.assertIn('UPDATE rejected', update_message)

        delete_message = self.assertRejected(
            f'delete from audit_events where id = {event_id}',
            sqlstate=AUDIT_TRIGGER_ERRCODE,
        )
        self.assertIn('audit_events is insert-only', delete_message)
        self.assertIn('DELETE rejected', delete_message)

        surviving = self.connection.execute(
            select(AUDIT.c.action).where(AUDIT.c.id == event_id)
        ).scalar_one()
        self.assertEqual(surviving, 'login.success', 'the row must be untouched')

    def test_A01_audit_insert_is_allowed_and_defaults_are_applied(self) -> None:
        event_id = self.insert_event('connection.test')
        row = self.connection.execute(
            select(AUDIT.c.action, AUDIT.c.details, AUDIT.c.occurred_at, AUDIT.c.workspace_id)
            .where(AUDIT.c.id == event_id)
        ).one()
        self.assertEqual(row.action, 'connection.test')
        self.assertEqual(row.details, {'source': 'test'})
        self.assertIsNotNone(row.occurred_at, 'occurred_at defaults to now()')
        self.assertIsNone(row.workspace_id, 'a deployment-level event belongs to no workspace')

    def test_A01_audit_ids_are_monotonic_and_not_writable(self) -> None:
        first = self.insert_event('job.submit')
        second = self.insert_event('job.finish')
        self.assertGreater(second, first, 'ids must increase so an export can page by id')
        self.assertRejected(
            "insert into audit_events (id, action) values (1, 'login.success')",
            sqlstate='428C9',  # generated_always
        )

    def test_A01_audit_trigger_fires_before_update_or_delete_for_each_row(self) -> None:
        row = self.connection.execute(
            text(
                """
                select t.tgname, p.proname, t.tgtype
                from pg_trigger t
                join pg_proc p on p.oid = t.tgfoid
                where t.tgname = :name
                """
            ),
            {'name': AUDIT_TRIGGER_NAME},
        ).one()
        self.assertEqual(row.tgname, AUDIT_TRIGGER_NAME)
        self.assertEqual(row.proname, AUDIT_TRIGGER_FUNCTION)
        # pg_trigger.tgtype bit 0 = row-level, bit 1 = before, bit 3 = delete, bit 4 = update.
        self.assertTrue(row.tgtype & (1 << 0), 'must be a row-level trigger')
        self.assertTrue(row.tgtype & (1 << 1), 'must fire before the statement takes effect')
        self.assertTrue(row.tgtype & (1 << 3), 'must cover delete')
        self.assertTrue(row.tgtype & (1 << 4), 'must cover update')
        self.assertFalse(row.tgtype & (1 << 2), 'must not fire on insert')

    def test_A01_audit_update_affecting_no_row_is_not_an_error(self) -> None:
        """The documented psql probe: a row-level trigger cannot fire for zero rows."""
        self.insert_event()
        result = self.connection.execute(
            text("update audit_events set action = 'x' where false")
        )
        self.assertEqual(result.rowcount, 0)


if __name__ == '__main__':
    unittest.main()
