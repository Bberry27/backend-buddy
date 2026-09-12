"""The request transaction commits before the response leaves (work package A02).

This suite exists because of a defect the test client cannot see. With the obvious implementation
-- a dependency that ``yield``s the session and commits in its teardown -- the commit happens
*after* the response has been sent, because that is when FastAPI runs teardown. A test client runs
the whole application, teardown included, before it hands back the response object, so every
assertion still passes; a real ASGI server does not, and the window is observable:

    DELETE /workspaces/{id}/api-keys/{key}   -> 200
    GET    /workspaces/{id}   with that key  -> 200   (the revoked key worked once more)

That is exactly what a live ``uvicorn`` run produced during A02. The fix is
:class:`app.core.database.UnitOfWorkMiddleware`, which commits when the status line is known and
before it is forwarded.

So the case below does not use the test client. It drives the ASGI application directly and reads
the database **from another connection, inside the ``http.response.start`` hook** -- the instant
the client would first learn the outcome. A committed row must already be visible there.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
import unittest
import uuid
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

from sqlalchemy import text

from app.core.database import UnitOfWorkMiddleware, session_dependency

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402


class UnitOfWorkTests(ApiTestCase):
    def test_A02_the_transaction_is_not_a_dependency_teardown(self) -> None:
        """Structural: a generator dependency would commit after the response again."""
        self.assertFalse(
            inspect.isgeneratorfunction(session_dependency),
            'session_dependency must not commit in a teardown; see UnitOfWorkMiddleware',
        )
        installed = [middleware.cls for middleware in self.application.user_middleware]
        self.assertIn(UnitOfWorkMiddleware, installed)

    def test_A02_a_write_is_visible_when_its_response_is_sent(self) -> None:
        """Behavioural: the revocation is committed before the 200 reaches the client."""
        workspace_id, user_id, email = self.make_principal('admin')
        client = self.new_client()
        _, csrf_token = self.login(email, client=client)
        created = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'commit timing', 'role': 'viewer'},
            headers=self.csrf(csrf_token),
        )
        self.assertEqual(created.status_code, 201, created.text)
        key_id = created.json()['key']['id']

        cookies = '; '.join(f'{name}={value}' for name, value in client.cookies.items())
        observed = self._drive_delete(
            path=f'/workspaces/{workspace_id}/api-keys/{key_id}',
            cookies=cookies,
            csrf_token=csrf_token,
            key_id=uuid.UUID(key_id),
        )
        self.assertEqual(observed['status'], 200, observed)
        self.assertIsNotNone(
            observed['revoked_at'],
            'revoked_at must be committed before the 200 is forwarded, or the revoked key keeps '
            'working for as long as the commit takes',
        )

    def _drive_delete(
        self,
        *,
        path: str,
        cookies: str,
        csrf_token: str,
        key_id: uuid.UUID,
    ) -> dict[str, Any]:
        """Send one DELETE through the raw ASGI application and observe the commit point."""
        observed: dict[str, Any] = {'status': None, 'revoked_at': 'not-read'}
        engine = self.application.state.database.engine

        def revoked_at() -> object:
            # A connection of its own: it sees committed rows only.
            with engine.connect() as connection:
                return connection.execute(
                    text('select revoked_at from api_keys where id = :id'),
                    {'id': key_id},
                ).scalar()

        scope: dict[str, Any] = {
            'type': 'http',
            'asgi': {'version': '3.0', 'spec_version': '2.3'},
            'http_version': '1.1',
            'method': 'DELETE',
            'scheme': 'http',
            'path': path,
            'raw_path': path.encode('ascii'),
            'query_string': b'',
            'root_path': '',
            'headers': [
                (b'host', b'testserver'),
                (b'cookie', cookies.encode('latin-1')),
                (b'x-csrf-token', csrf_token.encode('ascii')),
                (b'accept', b'application/json'),
            ],
            'client': ('testclient', 50000),
            'server': ('testserver', 80),
            'state': {},
        }

        async def receive() -> MutableMapping[str, Any]:
            return {'type': 'http.request', 'body': b'', 'more_body': False}

        async def send(message: MutableMapping[str, Any]) -> None:
            if message['type'] == 'http.response.start':
                observed['status'] = message['status']
                observed['revoked_at'] = await asyncio.to_thread(revoked_at)

        asyncio.run(self.application(scope, receive, send))
        return observed


class RollbackTests(ApiTestCase):
    def test_A02_a_failed_request_leaves_no_row(self) -> None:
        """A 4xx rolls the request's transaction back, whatever the handler wrote first."""
        workspace_id, _, admin_email = self.make_principal('admin')
        member_id = self.make_user()
        self.make_member(workspace_id, member_id, 'viewer')
        client = self.new_client()
        _, token = self.login(admin_email, client=client)

        # An admin may not grant owner: the role change is refused after the row was looked up.
        refused = client.put(
            f'/workspaces/{workspace_id}/members/{member_id}',
            json={'role': 'owner'},
            headers=self.csrf(token),
        )
        self.assertEqual(refused.status_code, 403)
        with self.session() as session:
            role = session.execute(
                text(
                    'select role from workspace_members '
                    'where workspace_id = :w and user_id = :u'
                ),
                {'w': workspace_id, 'u': member_id},
            ).scalar()
        self.assertEqual(role, 'viewer', 'the refused change must not have been stored')

    def test_A02_the_audit_row_survives_the_rollback(self) -> None:
        """The other half of the same rule: the trail is written in its own transaction."""
        _, _, email = self.make_principal('viewer')
        before = len(self.audit_rows('login.failure'))
        response = self.client.post(
            '/auth/login',
            json={'email': email, 'password': 'not-the-right-password'},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(len(self.audit_rows('login.failure')), before + 1)

    def test_A02_the_failure_counter_survives_the_rollback(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        payload = json.dumps({'email': email, 'password': 'still-not-the-password'})
        self.client.post('/auth/login', content=payload, headers={'Content-Type': 'application/json'})
        self.assertEqual(self.failure_count(user_id), 1)


if __name__ == '__main__':
    unittest.main()
