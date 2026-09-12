"""Passwords, login, sessions, and rotation (work package A02; CTQ-07; limits-and-caps B).

Two halves. :class:`PasswordPolicyTests` needs no database and pins the frozen policy -- argon2id,
minimum 12, common-password deny list. :class:`LoginTests` and the classes after it drive the real
routes against a real PostgreSQL, because session rotation, expiry and revocation are all row
behaviour and a mock would prove nothing about them.
"""

from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from sqlalchemy import select

from app.auth import passwords
from app.auth import sessions as session_store
from app.auth import users as user_store
from app.auth.cookies import SESSION_COOKIE_INSECURE
from app.auth.tokens import mint_api_key
from app.core.errors import ApiError, ErrorCode
from app.models import Session, User

# ``tests`` is not part of the installed distribution (``app*`` only), so the service root goes on
# the path before the shared harness is imported. Same pattern as the A01 suites.
if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import DEFAULT_PASSWORD, ApiTestCase, unique_email  # noqa: E402


class PasswordPolicyTests(unittest.TestCase):
    """The policy, gate by gate. No database, so this runs everywhere."""

    def test_A02_password_minimum_length_is_twelve(self) -> None:
        """``limits-and-caps.md`` section B: 12 characters."""
        self.assertEqual(passwords.MINIMUM_LENGTH, 12)
        for candidate in ('short', 'elevenchars', 'a' * 11):
            with self.subTest(candidate=candidate):
                with self.assertRaises(ApiError) as raised:
                    passwords.check_password_policy(candidate)
                self.assertIn('12 characters', raised.exception.message)
        passwords.check_password_policy('twelvechars!')

    def test_A02_password_denylist_rejects_common_passwords(self) -> None:
        """A long password that is still one of the first guesses anybody makes."""
        for candidate in (
            'password1234',
            'Password1234',
            'p@ssword1234',
            'qwertyuiop123',
            'iloveyou123456',
            'administrator123',
            'correcthorsebatterystaple',
            'letmein123456',
        ):
            with self.subTest(candidate=candidate), self.assertRaises(ApiError):
                passwords.check_password_policy(candidate)

    def test_A02_password_structural_rules(self) -> None:
        """Shapes that pass a length check and are worthless."""
        for candidate in (
            'aaaaaaaaaaaaaa',
            '123456789012',
            # A keyboard row long enough to pass the length gate, which is the only way the row
            # rule can ever fire: a bare row is ten characters and is refused for being short.
            'qwertyuiopqwerty',
            'abcabcabcabc',
            '  spacedout  ',
        ):
            with self.subTest(candidate=candidate), self.assertRaises(ApiError):
                passwords.check_password_policy(candidate)

    def test_A02_password_is_bounded_above(self) -> None:
        """Hashing is memory-hard, so a multi-megabyte body is not a valid password."""
        with self.assertRaises(ApiError) as raised:
            passwords.check_password_policy('x' * (passwords.MAXIMUM_LENGTH + 1))
        self.assertIn('at most', raised.exception.message)

    def test_A02_a_minted_api_key_never_reprs_its_secret(self) -> None:
        """A repr ends up in tracebacks and log lines."""
        material = mint_api_key()
        self.assertIn(material.key_prefix, repr(material))
        self.assertNotIn(material.token, repr(material))

    def test_A02_setting_a_password_hash_moves_the_rotation_reference(self) -> None:
        """``users.password_changed_at`` is what a later session-rotation rule reads."""
        user = User(email='rotation@example.test', password_hash='old')
        moment = dt.datetime.now(dt.UTC)
        user_store.set_password_hash(user, 'new-hash', now=moment)
        self.assertEqual(user.password_hash, 'new-hash')
        self.assertEqual(user.password_changed_at, moment)

    def test_A02_password_may_not_contain_the_account_identity(self) -> None:
        with self.assertRaises(ApiError):
            passwords.check_password_policy(
                'reviewer-at-example',
                email='reviewer@example.test',
            )
        with self.assertRaises(ApiError):
            passwords.check_password_policy('daphne-mcallister-1', display_name='Daphne McAllister')

    def test_A02_operator_denylist_file_is_used_in_addition(self) -> None:
        """``BB_PASSWORD_DENYLIST_FILE`` adds to the shipped list; it does not replace it."""
        directory = Path(tempfile.mkdtemp())
        extra = directory / 'top10k.txt'
        extra.write_text('# comment\nlocal-house-style-password\n\n', encoding='utf-8')
        passwords.check_password_policy('local-house-style-password')
        with self.assertRaises(ApiError):
            passwords.check_password_policy('local-house-style-password', denylist_file=extra)
        with self.assertRaises(ApiError):
            passwords.check_password_policy('password1234', denylist_file=extra)

    def test_A02_password_hashing_is_argon2id(self) -> None:
        hashed = passwords.hash_password(DEFAULT_PASSWORD)
        self.assertTrue(hashed.startswith('$argon2id$'))
        self.assertTrue(passwords.verify_password(hashed, DEFAULT_PASSWORD))
        self.assertFalse(passwords.verify_password(hashed, DEFAULT_PASSWORD + 'x'))
        self.assertFalse(passwords.needs_rehash(hashed))

    def test_A02_verify_password_never_raises(self) -> None:
        """A malformed stored hash is a false, not a 500."""
        self.assertFalse(passwords.verify_password('not-a-hash', DEFAULT_PASSWORD))
        self.assertFalse(passwords.verify_password('', DEFAULT_PASSWORD))
        self.assertTrue(passwords.needs_rehash('not-a-hash'))

    def test_A02_password_is_normalised_before_hashing(self) -> None:
        """NFKC, so a composed and a decomposed passphrase are the same password."""
        composed = 'långtrådsbuss-42'
        decomposed = 'långtrådsbuss-42'
        self.assertTrue(passwords.verify_password(passwords.hash_password(composed), decomposed))

    def test_A02_dummy_hash_is_stable_and_verifiable(self) -> None:
        """The unknown-account branch must cost a real verification."""
        self.assertEqual(passwords.dummy_hash(), passwords.dummy_hash())
        self.assertFalse(passwords.verify_password(passwords.dummy_hash(), DEFAULT_PASSWORD))


class LoginTests(ApiTestCase):
    def test_A02_login_succeeds_and_returns_no_secret(self) -> None:
        workspace_id, user_id, email = self.make_principal('owner')
        response, csrf_token = self.login(email)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body['user']['email'], email)
        self.assertEqual(body['user']['id'], str(user_id))
        self.assertEqual([w['id'] for w in body['workspaces']], [str(workspace_id)])
        self.assertEqual(body['workspaces'][0]['role'], 'owner')
        self.assertTrue(csrf_token)
        self.assertNotIn('passwordHash', str(body))
        self.assertNotIn('password_hash', str(body))
        self.assertNotIn(DEFAULT_PASSWORD, response.text)

    def test_A02_login_rejects_a_wrong_password_with_a_fixed_string(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        response, _ = self.login(email, 'this-is-not-the-password')
        self.assertEqual(response.status_code, 401)
        body = response.json()
        self.assertEqual(body['error']['code'], ErrorCode.INVALID_CREDENTIALS.value)
        self.assertEqual(body['error']['message'], 'The email address or password is incorrect.')
        self.assertTrue(body['error']['requestId'])
        self.assertEqual(self.failure_count(user_id), 1)

    def test_A02_login_answers_the_same_for_an_unknown_address(self) -> None:
        """No user enumeration: the code, the message and the status all match."""
        known = self.make_principal('viewer')[2]
        wrong = self.login(known, 'definitely-wrong-password')[0]
        unknown = self.login(unique_email('nobody'), 'definitely-wrong-password')[0]
        self.assertEqual(wrong.status_code, unknown.status_code)
        self.assertEqual(wrong.json()['error']['code'], unknown.json()['error']['code'])
        self.assertEqual(wrong.json()['error']['message'], unknown.json()['error']['message'])

    def test_A02_login_of_an_inactive_account_is_refused(self) -> None:
        email = unique_email('inactive')
        self.make_user(email=email, is_active=False)
        response, _ = self.login(email)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['error']['code'], ErrorCode.ACCOUNT_DISABLED.value)

    def test_A02_login_resets_the_failure_counter(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        self.login(email, 'wrong-password-here')
        self.login(email, 'wrong-password-also')
        self.assertEqual(self.failure_count(user_id), 2)
        self.assertEqual(self.login(email)[0].status_code, 200)
        self.assertEqual(self.failure_count(user_id), 0)

    def test_A02_login_rotates_the_session(self) -> None:
        """Session fixation: the token the browser arrived with is revoked."""
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        first = client.cookies.get(SESSION_COOKIE_INSECURE)
        self.login(email, client=client)
        second = client.cookies.get(SESSION_COOKIE_INSECURE)
        self.assertNotEqual(first, second)
        with self.session() as session:
            rows = list(
                session.scalars(
                    select(Session).where(Session.user_id == user_id).order_by(Session.created_at)
                )
            )
        self.assertEqual(len(rows), 2)
        self.assertIsNotNone(rows[0].revoked_at, 'the first session must be revoked')
        self.assertIsNone(rows[1].revoked_at)

    def test_A02_login_stores_only_a_digest_of_the_token(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        token = client.cookies.get(SESSION_COOKIE_INSECURE) or ''
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
        self.assertEqual(len(row.token_hash), 32)
        self.assertNotIn(token.encode('utf-8'), row.token_hash)
        self.assertEqual(len(row.csrf_token_hash), 32)

    def test_A02_body_validation_never_echoes_the_password(self) -> None:
        """FastAPI's default validation handler would put the rejected input in the response."""
        secret = 'echo-me-if-you-can'
        response = self.client.post('/auth/login', json={'email': 'not-an-email', 'password': secret})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(secret, response.text)
        self.assertEqual(response.json()['error']['code'], ErrorCode.VALIDATION_FAILED.value)

    def test_A02_login_body_rejects_unknown_fields(self) -> None:
        _, _, email = self.make_principal('viewer')
        response = self.client.post(
            '/auth/login',
            json={'email': email, 'password': DEFAULT_PASSWORD, 'role': 'owner'},
        )
        self.assertEqual(response.status_code, 422)


class SessionLifetimeTests(ApiTestCase):
    overrides = {'BB_SESSION_IDLE_MINUTES': '1', 'BB_SESSION_ABSOLUTE_HOURS': '1'}

    def test_A02_idle_session_stops_authenticating(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        self.assertEqual(client.get('/users/me').status_code, 200)
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
            row.last_seen_at = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=5)
        self.assertEqual(client.get('/users/me').status_code, 401)

    def test_A02_expired_session_stops_authenticating(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
            row.expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        self.assertEqual(client.get('/users/me').status_code, 401)

    def test_A02_absolute_expiry_is_recorded_at_creation(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        self.login(email, client=self.new_client())
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
        self.assertAlmostEqual(
            (row.expires_at - row.created_at).total_seconds(),
            3600,
            delta=5,
        )

    def test_A02_activity_moves_last_seen_at(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
            row.last_seen_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=30)
            stale = row.last_seen_at
        self.assertEqual(client.get('/users/me').status_code, 200)
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
        self.assertGreater(row.last_seen_at, stale)


class RevocationTests(ApiTestCase):
    def test_A02_logout_revokes_only_this_session(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        first = self.new_client()
        second = self.new_client()
        _, first_csrf = self.login(email, client=first)
        self.login(email, client=second)
        response = first.post('/auth/logout', headers=self.csrf(first_csrf))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(first.get('/users/me').status_code, 401)
        self.assertEqual(second.get('/users/me').status_code, 200)

    def test_A02_revoke_all_ends_every_session_including_the_caller(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        first = self.new_client()
        second = self.new_client()
        _, first_csrf = self.login(email, client=first)
        self.login(email, client=second)
        response = first.post('/auth/sessions/revoke-all', headers=self.csrf(first_csrf))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['revokedSessions'], 2)
        self.assertEqual(first.get('/users/me').status_code, 401)
        self.assertEqual(second.get('/users/me').status_code, 401)
        with self.session() as session:
            rows = list(session.scalars(select(Session).where(Session.user_id == user_id)))
        self.assertTrue(all(row.revoked_at is not None for row in rows))

    def test_A02_a_revoked_session_cannot_be_reused(self) -> None:
        _, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        with self.session() as session:
            row = session.scalars(select(Session).where(Session.user_id == user_id)).one()
            session_store.revoke(row, now=dt.datetime.now(dt.UTC))
        self.assertEqual(client.get('/users/me').status_code, 401)

    def test_A02_unknown_token_is_unauthenticated(self) -> None:
        client = self.new_client()
        client.cookies.set(SESSION_COOKIE_INSECURE, 'a-token-that-was-never-minted')
        self.assertEqual(client.get('/users/me').status_code, 401)


class MeTests(ApiTestCase):
    def test_A02_me_returns_the_principal_and_the_policy(self) -> None:
        workspace_id, user_id, email = self.make_principal('reviewer')
        client = self.new_client()
        self.login(email, client=client)
        body = client.get('/users/me').json()
        self.assertEqual(body['user']['id'], str(user_id))
        self.assertEqual(body['credential'], 'session')
        self.assertEqual(body['workspaces'][0]['role'], 'reviewer')
        self.assertEqual(body['passwordPolicy']['minimumLength'], passwords.MINIMUM_LENGTH)

    def test_A02_me_requires_authentication(self) -> None:
        response = self.client.get('/users/me')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()['error']['code'], ErrorCode.UNAUTHENTICATED.value)

    def test_A02_an_api_key_sees_only_its_own_workspace(self) -> None:
        first, user_id, _ = self.make_principal('admin')
        second = self.make_workspace()
        self.make_member(second, user_id, 'owner')
        token = self.make_api_key(workspace_id=first, user_id=user_id, role='viewer')
        body = self.client.get('/users/me', headers={'Authorization': f'Bearer {token}'}).json()
        self.assertEqual(body['credential'], 'api_key')
        self.assertEqual([w['id'] for w in body['workspaces']], [str(first)])
        self.assertEqual(body['workspaces'][0]['role'], 'viewer')
        self.assertNotIn(str(second), str(body))


class ApiKeyAuthenticationTests(ApiTestCase):
    def test_A02_api_key_authenticates_and_records_last_used(self) -> None:
        workspace_id, user_id, _ = self.make_principal('admin')
        token = self.make_api_key(workspace_id=workspace_id, user_id=user_id, role='admin')
        response = self.client.get(
            f'/workspaces/{workspace_id}',
            headers={'Authorization': f'Bearer {token}'},
        )
        self.assertEqual(response.status_code, 200, response.text)
        from app.models import ApiKey

        with self.session() as session:
            key = session.scalars(select(ApiKey).where(ApiKey.workspace_id == workspace_id)).one()
        self.assertIsNotNone(key.last_used_at)

    def test_A02_revoked_expired_and_foreign_keys_do_not_authenticate(self) -> None:
        workspace_id, user_id, _ = self.make_principal('admin')
        past = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1)
        cases = {
            'revoked': self.make_api_key(
                workspace_id=workspace_id, user_id=user_id, role='admin', revoked=True
            ),
            'expired': self.make_api_key(
                workspace_id=workspace_id, user_id=user_id, role='admin', expires_at=past
            ),
            'unknown': 'backend-buddy_' + 'A' * 43,
            'not-ours': 'some-other-bearer-token',
        }
        for label, token in cases.items():
            with self.subTest(case=label):
                response = self.client.get(
                    '/users/me', headers={'Authorization': f'Bearer {token}'}
                )
                self.assertEqual(response.status_code, 401)

    def test_A02_a_bearer_header_never_falls_back_to_the_cookie(self) -> None:
        workspace_id, user_id, email = self.make_principal('admin')
        client = self.new_client()
        self.login(email, client=client)
        self.assertEqual(client.get('/users/me').status_code, 200)
        response = client.get('/users/me', headers={'Authorization': 'Bearer backend-buddy_revoked-key'})
        self.assertEqual(response.status_code, 401)

    def test_A02_deactivating_an_account_disables_its_keys(self) -> None:
        workspace_id, user_id, _ = self.make_principal('admin')
        token = self.make_api_key(workspace_id=workspace_id, user_id=user_id, role='admin')
        with self.session() as session:
            owner = session.get(User, user_id)
            assert owner is not None
            owner.is_active = False
        response = self.client.get('/users/me', headers={'Authorization': f'Bearer {token}'})
        self.assertEqual(response.status_code, 401)


class RateLimitTests(ApiTestCase):
    overrides = {'BB_RATE_LIMIT_ENABLED': 'true', 'BB_RATE_LIMIT_LOGIN': '3/minute'}

    def test_A02_login_is_rate_limited(self) -> None:
        _, _, email = self.make_principal('viewer')
        statuses = [self.login(email, 'wrong-password-here')[0].status_code for _ in range(5)]
        self.assertEqual(statuses[:3], [401, 401, 401])
        self.assertIn(429, statuses)
        limited = self.login(email, 'wrong-password-here')[0]
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()['error']['code'], ErrorCode.RATE_LIMITED.value)
        self.assertIn('retry-after', {key.lower() for key in limited.headers})

    def test_A02_rate_limited_login_is_still_audited(self) -> None:
        """A brake is not a blindfold: the failures before it are in the trail."""
        _, _, email = self.make_principal('viewer')
        for _ in range(4):
            self.login(email, 'wrong-password-here')
        self.assertGreaterEqual(len(self.audit_rows('login.failure')), 1)


class RateLimitedSuccessTests(ApiTestCase):
    """The success path of a rate-limited route, with the limiter actually enabled.

    This class exists because of a real failure: slowapi with ``headers_enabled`` writes the
    rate-limit headers into the endpoint's own ``Response`` parameter and raises when the handler
    has none, so a decorated route that answers 200 in a suite with the limiter disabled can still
    answer 500 in a deployment. Every rate-limited route is exercised here with the limiter on.
    """

    overrides = {
        'BB_RATE_LIMIT_ENABLED': 'true',
        'BB_RATE_LIMIT_LOGIN': '30/minute',
        'BB_RATE_LIMIT_API_KEY': '30/minute',
    }

    def test_A02_a_rate_limited_route_succeeds_with_headers(self) -> None:
        workspace_id, _, email = self.make_principal('admin')
        client = self.new_client()
        response, token = self.login(email, client=client)
        self.assertEqual(response.status_code, 200, response.text)

        created = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'with the limiter on', 'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertTrue(created.json()['apiKey'].startswith('backend-buddy_'))
        headers = {key.lower() for key in created.headers}
        self.assertIn('x-ratelimit-limit', headers)
        self.assertIn('x-ratelimit-remaining', headers)


class UuidRoutingTests(ApiTestCase):
    def test_A02_a_malformed_workspace_id_is_not_a_server_error(self) -> None:
        _, _, email = self.make_principal('owner')
        client = self.new_client()
        self.login(email, client=client)
        response = client.get('/workspaces/not-a-uuid')
        self.assertIn(response.status_code, (404, 422))
        self.assertNotEqual(response.status_code, 500)

    def test_A02_a_random_workspace_id_is_not_found(self) -> None:
        _, _, email = self.make_principal('owner')
        client = self.new_client()
        self.login(email, client=client)
        response = client.get(f'/workspaces/{uuid.uuid4()}')
        self.assertEqual(response.status_code, 404)


if __name__ == '__main__':
    unittest.main()
