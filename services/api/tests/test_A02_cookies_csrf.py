"""Cookie flags, CSRF, and the security headers (work package A02; frozen contracts).

``test_A02_cookie_flags_and_csrf`` and ``test_A02_security_headers`` are the named cases. Both
compare against the document rather than against a copy of the implementation: the CSP is read out
of ``security-architecture.md`` section 6.2, so the header and the architecture cannot drift apart
without one of them failing.

The ``SameSite`` case is worth reading twice. The shipped default is ``Strict``, which is a
tightening of the ``Lax`` in section 7 and was instructed by the work-package owner; the report
proposes the same edit to the document. Both halves are pinned here: ``Strict`` is what a default
deployment sends, and ``Lax`` is still reachable through ``BB_COOKIE_SAMESITE`` for a deployment
that later needs a cross-site top-level navigation to keep its session.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from uuid import uuid4

from starlette.requests import Request

from app.auth.cookies import (
    CSRF_COOKIE,
    CSRF_COOKIE_INSECURE,
    SESSION_COOKIE,
    SESSION_COOKIE_INSECURE,
    CookiePolicy,
    insecure_cookie_warning,
)
from app.auth.csrf import expected_origin, require_csrf
from app.auth.tokens import digest
from app.core.errors import ApiError, ErrorCode
from app.core.http import API_CSP, HSTS, PERMISSIONS_POLICY, SPA_CSP
from app.core.settings import Settings
from app.models import Session

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SECURITY_DOC = REPOSITORY_ROOT / 'docs' / 'architecture' / 'security-architecture.md'


def documented_spa_csp() -> str:
    """The strict SPA policy as ``security-architecture.md`` section 6.2 writes it."""
    text = SECURITY_DOC.read_text(encoding='utf-8')
    section = text[text.index('### 6.2 Served SPA') :]
    block = re.search(r'```\n(default-src[^`]+?)\n```', section)
    assert block is not None, 'the SPA CSP code block moved in security-architecture.md 6.2'
    return block.group(1).strip()


class CookiePolicyTests(unittest.TestCase):
    def test_A02_host_prefix_requires_secure(self) -> None:
        """There is no configuration that yields a ``__Host-`` name without ``Secure``."""
        secure = CookiePolicy.from_settings(Settings.from_environment({'BB_COOKIE_SECURE': 'true'}))
        self.assertEqual(secure.session_name, SESSION_COOKIE)
        self.assertEqual(secure.csrf_name, CSRF_COOKIE)
        self.assertTrue(secure.secure)

        insecure = CookiePolicy.from_settings(
            Settings.from_environment({'BB_COOKIE_SECURE': 'false'})
        )
        self.assertEqual(insecure.session_name, SESSION_COOKIE_INSECURE)
        self.assertEqual(insecure.csrf_name, CSRF_COOKIE_INSECURE)
        self.assertFalse(insecure.secure)
        self.assertFalse(insecure.session_name.startswith('__Host-'))

    def test_A02_dev_fallback_warns_and_says_what_is_lost(self) -> None:
        insecure = Settings.from_environment({'BB_COOKIE_SECURE': 'false'})
        warning = insecure_cookie_warning(insecure)
        self.assertIsNotNone(warning)
        assert warning is not None
        self.assertIn(SESSION_COOKIE_INSECURE, warning)
        self.assertIn('BB_COOKIE_SECURE=true', warning)
        self.assertIsNone(
            insecure_cookie_warning(Settings.from_environment({'BB_COOKIE_SECURE': 'true'}))
        )


def scope(
    *,
    method: str = 'POST',
    host: str | None = 'schema.example.test',
    origin: str | None = None,
    forwarded_proto: str | None = None,
) -> dict[str, object]:
    """A minimal ASGI scope, so the origin helpers can be exercised without a route."""
    headers = []
    if host:
        headers.append((b'host', host.encode('latin-1')))
    if origin:
        headers.append((b'origin', origin.encode('latin-1')))
    return {
        'type': 'http',
        'method': method,
        'path': '/auth/logout',
        'headers': headers,
        'scheme': 'http',
        'query_string': b'',
        'state': {'forwarded_proto': forwarded_proto} if forwarded_proto else {},
    }


def _session_row() -> Session:
    """A session row with a known CSRF token, built without a database."""
    return Session(token_hash=b'0' * 32, csrf_token_hash=digest('a-token'), user_id=uuid4())


class OriginResolutionTests(unittest.TestCase):
    """``expected_origin`` without ``BB_PUBLIC_ORIGIN``: the dev case, reached directly."""

    def test_A02_origin_falls_back_to_the_request_host(self) -> None:
        settings = Settings.from_environment({})
        request = Request(scope(host='localhost:8000'))
        self.assertEqual(expected_origin(request, settings), 'http://localhost:8000')

    def test_A02_origin_honours_a_forwarded_scheme(self) -> None:
        settings = Settings.from_environment({})
        request = Request(scope(host='schema.example.test', forwarded_proto='https'))
        self.assertEqual(expected_origin(request, settings), 'https://schema.example.test')

    def test_A02_origin_is_unknown_without_a_host(self) -> None:
        settings = Settings.from_environment({})
        self.assertIsNone(expected_origin(Request(scope(host=None)), settings))

    def test_A02_public_origin_wins_over_the_host_header(self) -> None:
        """Behind a proxy the request own Host is whatever the proxy passed on."""
        settings = Settings.from_environment({'BB_PUBLIC_ORIGIN': 'https://schema.example.test'})
        request = Request(scope(host='internal-api:8000'))
        self.assertEqual(expected_origin(request, settings), 'https://schema.example.test')

    def test_A02_require_csrf_refuses_a_foreign_origin(self) -> None:
        """The token check has its own origin comparison, independent of the middleware."""
        settings = Settings.from_environment({'BB_PUBLIC_ORIGIN': 'https://schema.example.test'})
        request = Request(scope(origin='https://attacker.example'))
        with self.assertRaises(ApiError) as raised:
            require_csrf(request, _session_row(), settings)
        self.assertEqual(raised.exception.code, ErrorCode.CSRF_REQUIRED)

    def test_A02_require_csrf_passes_a_safe_method(self) -> None:
        settings = Settings.from_environment({})
        require_csrf(Request(scope(method='GET')), _session_row(), settings)


class CookieFlagTests(ApiTestCase):
    overrides = {
        'BB_COOKIE_SECURE': 'true',
        'BB_PUBLIC_ORIGIN': 'https://schema.example.test',
    }
    base_url = 'https://testserver'

    def test_A02_cookie_flags_and_csrf(self) -> None:
        """The frozen contract: one session cookie, ``__Host-``, HttpOnly, SameSite, Path=/."""
        _, _, email = self.make_principal('owner')
        client = self.new_client()
        response = client.post(
            '/auth/login',
            json={'email': email, 'password': self._password()},
            headers={'Origin': 'https://schema.example.test'},
        )
        self.assertEqual(response.status_code, 200, response.text)

        cookies = response.headers.get_list('set-cookie')
        session_cookies = [value for value in cookies if value.startswith(f'{SESSION_COOKIE}=')]
        self.assertEqual(len(session_cookies), 1, f'expected exactly one session cookie: {cookies}')
        attributes = session_cookies[0]
        self.assertIn('Secure', attributes)
        self.assertIn('HttpOnly', attributes)
        # The attribute value is case-insensitive (RFC 6265bis section 5.4.7); Starlette emits it
        # as configured, so the comparison is folded rather than the value cosmetically capitalised.
        self.assertIn('samesite=strict', attributes.lower())
        self.assertIn('Path=/', attributes)
        self.assertNotIn('Domain', attributes)

        csrf_cookies = [value for value in cookies if value.startswith(f'{CSRF_COOKIE}=')]
        self.assertEqual(len(csrf_cookies), 1)
        self.assertNotIn('HttpOnly', csrf_cookies[0], 'the SPA has to read the CSRF cookie')
        self.assertIn('Secure', csrf_cookies[0])
        self.assertIn('samesite=strict', csrf_cookies[0].lower())

        token = response.json()['csrfToken']
        # A state-changing request without the header is refused ...
        self.assertEqual(client.post('/auth/logout').status_code, 403)
        # ... with the wrong token too ...
        wrong = client.post('/auth/logout', headers={'X-CSRF-Token': 'not-the-token'})
        self.assertEqual(wrong.status_code, 403)
        self.assertEqual(wrong.json()['error']['code'], 'csrf_required')
        # ... and accepted with the right one.
        self.assertEqual(client.post('/auth/logout', headers={'X-CSRF-Token': token}).status_code, 200)

    def test_A02_safe_methods_need_no_token(self) -> None:
        _, _, email = self.make_principal('viewer')
        client = self.new_client()
        self.login(email, client=client)
        self.assertEqual(client.get('/users/me').status_code, 200)

    def test_A02_a_token_from_another_session_is_refused(self) -> None:
        """Double submit is bound to the session, not merely to the deployment."""
        _, _, first_email = self.make_principal('viewer')
        _, _, second_email = self.make_principal('viewer')
        first = self.new_client()
        second = self.new_client()
        _, first_token = self.login(first_email, client=first)
        self.login(second_email, client=second)
        response = second.post('/auth/logout', headers={'X-CSRF-Token': first_token})
        self.assertEqual(response.status_code, 403)

    def test_A02_rotating_the_csrf_token_invalidates_the_old_one(self) -> None:
        _, _, email = self.make_principal('viewer')
        client = self.new_client()
        _, first = self.login(email, client=client)
        rotated = client.get('/auth/csrf').json()['csrfToken']
        self.assertNotEqual(first, rotated)
        self.assertEqual(client.post('/auth/logout', headers={'X-CSRF-Token': first}).status_code, 403)
        self.assertEqual(
            client.post('/auth/logout', headers={'X-CSRF-Token': rotated}).status_code, 200
        )

    def test_A02_cross_origin_state_change_is_refused(self) -> None:
        """The origin guard covers login itself, which has no session to bind a token to."""
        _, _, email = self.make_principal('viewer')
        response = self.client.post(
            '/auth/login',
            json={'email': email, 'password': self._password()},
            headers={'Origin': 'https://attacker.example'},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['error']['code'], 'csrf_required')

    def test_A02_api_keys_are_exempt_from_csrf(self) -> None:
        workspace_id, user_id, _ = self.make_principal('admin')
        token = self.make_api_key(workspace_id=workspace_id, user_id=user_id, role='admin')
        response = self.client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'ci', 'role': 'viewer'},
            headers={'Authorization': f'Bearer {token}'},
        )
        self.assertEqual(response.status_code, 201, response.text)

    def test_A02_logout_clears_both_cookies(self) -> None:
        _, _, email = self.make_principal('viewer')
        client = self.new_client()
        _, token = self.login(email, client=client)
        response = client.post('/auth/logout', headers={'X-CSRF-Token': token})
        cleared = ' '.join(response.headers.get_list('set-cookie'))
        for name in (SESSION_COOKIE, CSRF_COOKIE, SESSION_COOKIE_INSECURE, CSRF_COOKIE_INSECURE):
            self.assertIn(f'{name}=', cleared)

    @staticmethod
    def _password() -> str:
        from tests.helpers import DEFAULT_PASSWORD

        return DEFAULT_PASSWORD


class SameSiteLaxTests(ApiTestCase):
    overrides = {'BB_COOKIE_SAMESITE': 'lax'}

    def test_A02_samesite_lax_remains_reachable(self) -> None:
        """The documented ``Lax`` value is one setting away, not a code change."""
        _, _, email = self.make_principal('viewer')
        response, _ = self.login(email, client=self.new_client())
        cookies = ' '.join(response.headers.get_list('set-cookie'))
        self.assertIn('samesite=lax', cookies.lower())
        self.assertNotIn('samesite=strict', cookies.lower())


class SecurityHeaderTests(ApiTestCase):
    overrides = {'BB_PUBLIC_ORIGIN': 'https://schema.example.test', 'BB_COOKIE_SECURE': 'true'}
    base_url = 'https://testserver'

    def test_A02_security_headers(self) -> None:
        """The header set from ``security-architecture.md`` section 6.2, on a real response."""
        response = self.client.get('/healthz')
        self.assertEqual(response.status_code, 200)
        headers = {key.lower(): value for key, value in response.headers.items()}
        self.assertEqual(headers['x-content-type-options'], 'nosniff')
        self.assertEqual(headers['referrer-policy'], 'no-referrer')
        self.assertEqual(headers['cross-origin-opener-policy'], 'same-origin')
        self.assertEqual(headers['permissions-policy'], PERMISSIONS_POLICY)
        self.assertEqual(headers['strict-transport-security'], HSTS)
        self.assertEqual(headers['content-security-policy'], API_CSP)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertTrue(headers['x-request-id'])

    def test_A02_spa_csp_matches_the_architecture_document(self) -> None:
        """Byte for byte, and not against a copy of itself (RK-04)."""
        self.assertEqual(SPA_CSP, documented_spa_csp())
        self.assertNotIn('unsafe-eval', SPA_CSP)
        self.assertNotIn('*', SPA_CSP)
        self.assertIn("script-src 'self'", SPA_CSP)

    def test_A02_api_csp_is_at_least_as_strict(self) -> None:
        self.assertIn("default-src 'none'", API_CSP)
        self.assertIn("frame-ancestors 'none'", API_CSP)
        self.assertIn("base-uri 'none'", API_CSP)
        self.assertIn("form-action 'none'", API_CSP)

    def test_A02_headers_are_present_on_a_failure_too(self) -> None:
        """An error response is still a response an attacker can reach."""
        response = self.client.get('/users/me')
        self.assertEqual(response.status_code, 401)
        headers = {key.lower() for key in response.headers}
        self.assertIn('content-security-policy', headers)
        self.assertIn('x-content-type-options', headers)
        self.assertIn('x-request-id', headers)


class HstsTests(ApiTestCase):
    def test_A02_no_hsts_without_an_https_origin(self) -> None:
        """A header a browser would ignore is a header that misleads the operator who sees it."""
        response = self.client.get('/healthz')
        self.assertNotIn('strict-transport-security', {key.lower() for key in response.headers})


if __name__ == '__main__':
    unittest.main()
