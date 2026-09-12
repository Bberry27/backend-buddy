"""The audit trail for auth events (work package A02; CTQ-16).

``test_A02_audit_rows_for_auth_events`` is the named case: a row exists for login, failed login,
logout, revoke-all, key create and key revoke, and a role change. The rest of the suite pins the
three properties that make the trail worth having:

* the failure row survives the request that failed (:mod:`app.audit` writes in its own
  transaction);
* ``details`` never carries a secret, because it is redacted on the way in;
* the vocabulary is closed, and closed against ``data-model.md`` 3.15 rather than against itself.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

from app.audit import ACTIONS
from app.models import AuditEvent

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import DEFAULT_PASSWORD, ApiTestCase  # noqa: E402

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DATA_MODEL_DOC = REPOSITORY_ROOT / 'docs' / 'architecture' / 'data-model.md'


def documented_actions() -> tuple[set[str], set[str]]:
    """The literal action names and the wildcard prefixes in ``data-model.md`` 3.15."""
    text = DATA_MODEL_DOC.read_text(encoding='utf-8')
    section = text[text.index('### 3.15 `audit_events`') :]
    row = next(line for line in section.splitlines() if '`login.success`' in line)
    # Only the cell that lists the actions: the same row also names the column itself.
    cell = next(part for part in row.split('|') if '`login.success`' in part)
    names = set(re.findall(r'`([a-z_]+(?:\.[a-z_*]+)?)`', cell))
    literals = {name for name in names if not name.endswith('.*')}
    wildcards = {name[:-1] for name in names if name.endswith('.*')}
    return literals, wildcards


class VocabularyTests(unittest.TestCase):
    def test_A02_audit_vocabulary_matches_the_data_model(self) -> None:
        """Every action this package can write is one the document defines."""
        literals, wildcards = documented_actions()
        self.assertIn('login.success', literals)
        self.assertIn('workspace.', wildcards)
        undocumented = sorted(
            action
            for action in ACTIONS
            if action not in literals
            and not any(action.startswith(prefix) for prefix in wildcards)
        )
        self.assertEqual(
            undocumented,
            [],
            'app.audit.ACTIONS contains an action data-model.md section 3.15 does not define',
        )
        missing = sorted(literals - ACTIONS)
        self.assertEqual(missing, [], 'the document defines an action app.audit does not accept')


class AuditWriteTests(ApiTestCase):
    def test_A02_audit_rows_for_auth_events(self) -> None:
        """One row per event in the CTQ-16 list, with the actor and the target recorded."""
        workspace_id, owner_id, owner_email = self.make_principal('owner')
        member_id = self.make_user()
        self.make_member(workspace_id, member_id, 'viewer')

        client = self.new_client()
        # login.failure, then login.success
        self.login(owner_email, 'wrong-password-entirely', client=client)
        _, token = self.login(owner_email, client=client)
        # member.role_change
        client.put(
            f'/workspaces/{workspace_id}/members/{member_id}',
            json={'role': 'reviewer'},
            headers=self.csrf(token),
        )
        # api_key.create then api_key.revoke
        created = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'audited', 'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(created.status_code, 201, created.text)
        key_id = created.json()['key']['id']
        client.delete(f'/workspaces/{workspace_id}/api-keys/{key_id}', headers=self.csrf(token))
        # session.revoke_all, then logout on a fresh session
        client.post('/auth/sessions/revoke-all', headers=self.csrf(token))
        _, token = self.login(owner_email, client=client)
        client.post('/auth/logout', headers=self.csrf(token))

        actions = self.audit_actions()
        for expected in (
            'login.failure',
            'login.success',
            'member.role_change',
            'api_key.create',
            'api_key.revoke',
            'session.revoke_all',
            'logout',
        ):
            with self.subTest(action=expected):
                self.assertIn(expected, actions)

        success = self.audit_rows('login.success')[0]
        self.assertEqual(success.actor_user_id, owner_id)
        self.assertEqual(success.target_type, 'session')
        self.assertTrue(success.request_id)
        self.assertIsNotNone(success.occurred_at)

        change = self.audit_rows('member.role_change')[-1]
        self.assertEqual(change.workspace_id, workspace_id)
        self.assertEqual(change.target_id, str(member_id))
        self.assertEqual(change.details.get('from'), 'viewer')
        self.assertEqual(change.details.get('to'), 'reviewer')

    def test_A02_a_failed_login_is_recorded_without_the_password(self) -> None:
        """The row survives the rejected request, and carries no credential."""
        _, user_id, email = self.make_principal('viewer')
        secret = 'a-password-nobody-should-store'
        self.client.post('/auth/login', json={'email': email, 'password': secret})
        # The newest row: this class shares one database, so other cases have written before it.
        row = self.audit_rows('login.failure')[-1]
        self.assertEqual(row.target_id, str(user_id))
        self.assertEqual(row.details.get('reason'), 'wrong_password')
        self.assertEqual(row.details.get('failed_login_count'), 1)
        self.assertNotIn(secret, str(row.details))
        self.assertNotIn('password', {key for key in row.details})

    def test_A02_an_unknown_address_is_recorded_without_naming_it(self) -> None:
        """The row says a login failed, not which address was guessed."""
        self.client.post(
            '/auth/login',
            json={'email': 'harvested@example.test', 'password': DEFAULT_PASSWORD},
        )
        row = self.audit_rows('login.failure')[-1]
        self.assertEqual(row.details.get('reason'), 'unknown_email')
        self.assertIsNone(row.target_id)
        self.assertNotIn('harvested', str(row.details))

    def test_A02_audit_details_are_redacted(self) -> None:
        """A caller that hands over something sensitive cannot put it in the trail."""
        from app import audit

        database = self.application.state.database
        audit.record(
            database,
            action='workspace.create',
            target_type='workspace',
            target_id='synthetic',
            details={
                'dsn': 'postgresql://user:hunter2@db.example/app',
                'note': 'connect with postgresql://user:hunter2@db.example/app',
                'password': 'hunter2',
                'nested': {'token': 'abc123'},
            },
        )
        row = self.audit_rows('workspace.create')[-1]
        serialised = str(row.details)
        self.assertNotIn('hunter2', serialised)
        self.assertNotIn('abc123', serialised)
        self.assertIn('[REDACTED]', serialised)

    def test_A02_an_unknown_action_is_a_programming_error(self) -> None:
        from app import audit

        with self.assertRaises(ValueError) as raised:
            audit.record(self.application.state.database, action='login.faliure')
        self.assertIn('data-model.md', str(raised.exception))

    def test_A02_the_trail_is_insert_only(self) -> None:
        """A01's trigger, exercised through the same connection the API uses (CTQ-16)."""
        from sqlalchemy import text
        from sqlalchemy.exc import DBAPIError

        _, _, email = self.make_principal('viewer')
        self.login(email, client=self.new_client())
        database = self.application.state.database
        with (
            self.assertRaises(DBAPIError) as raised,
            database.separate_transaction() as connection,
        ):
            connection.execute(text("update audit_events set action = 'tampered'"))
        self.assertEqual(getattr(raised.exception.orig, 'sqlstate', None), '42501')

    def test_A02_client_address_is_recorded_when_known(self) -> None:
        _, _, email = self.make_principal('viewer')
        self.login(email, client=self.new_client())
        row = self.audit_rows('login.success')[0]
        # TestClient's peer is not an address, so ip is null rather than a made-up value.
        self.assertIsNone(row.ip)


class AuditIsolationTests(ApiTestCase):
    def test_A02_audit_rows_outlive_a_rolled_back_request(self) -> None:
        """The separate transaction, proved: nothing else from the failed request persisted."""
        from sqlalchemy import func, select

        _, user_id, email = self.make_principal('viewer')
        self.client.post('/auth/login', json={'email': email, 'password': 'wrong-one-here'})
        with self.session() as session:
            rows = session.scalar(select(func.count()).select_from(AuditEvent))
        self.assertEqual(rows, 1)


if __name__ == '__main__':
    unittest.main()
