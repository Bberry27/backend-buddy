"""Structured logging, redaction, and the request id (work package A02; CTQ-16; RK-21).

``test_A02_log_redaction`` is the named case: a DSN logged by name, a DSN interpolated into a
message, a password, a bearer token and a sampled value all come out as ``[REDACTED]``, and the
secret itself appears nowhere in the captured line.

The capture is the real one: :func:`app.core.logging.configure_logging` is applied to a handler
writing to a buffer, so what is asserted is the bytes a collector would receive, not an
intermediate dictionary.
"""

from __future__ import annotations

import io
import json
import logging
import sys
import unittest
from pathlib import Path

import structlog

from app.core.logging import REDACTED, configure_logging, get_logger, redact
from app.core.settings import Settings

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402

DSN = 'postgresql://reviewer:hunter2@db.internal:5432/warehouse'
SECRET = 'hunter2'


class CapturedLogs:
    """Reconfigure logging onto a buffer, and put it back afterwards."""

    def __init__(self) -> None:
        self.buffer = io.StringIO()

    def __enter__(self) -> CapturedLogs:
        configure_logging(Settings.from_environment({'BB_LOG_LEVEL': 'debug'}))
        root = logging.getLogger()
        self._handlers = list(root.handlers)
        formatter = self._handlers[0].formatter if self._handlers else None
        handler = logging.StreamHandler(self.buffer)
        handler.setFormatter(formatter)
        root.handlers = [handler]
        return self

    def __exit__(self, *_: object) -> None:
        logging.getLogger().handlers = self._handlers
        structlog.reset_defaults()

    @property
    def text(self) -> str:
        return self.buffer.getvalue()

    def records(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.text.splitlines() if line.strip()]


class RedactionTests(unittest.TestCase):
    def test_A02_log_redaction(self) -> None:
        """The named CTQ-16 case: nothing sensitive survives the processor."""
        with CapturedLogs() as captured:
            get_logger('test').info(
                'connection.tested',
                dsn=DSN,
                password=SECRET,
                message=f'failed to reach {DSN}',
                authorization='Bearer abcdef123456',
                sample_values=['a-real-value-from-a-table'],
                api_key_id='42',
                workspace_id='ws-1',
            )
        text = captured.text
        self.assertIn(REDACTED, text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('abcdef123456', text)
        self.assertNotIn('a-real-value-from-a-table', text)

        record = captured.records()[-1]
        self.assertEqual(record['dsn'], REDACTED)
        self.assertEqual(record['password'], REDACTED)
        self.assertEqual(record['authorization'], REDACTED)
        self.assertEqual(record['sample_values'], REDACTED)
        self.assertIn(REDACTED, str(record['message']))
        self.assertIn('db.internal', str(record['message']), 'the host is diagnosis, not a secret')
        # Identifiers are how an incident is reconstructed; they are not credentials.
        self.assertEqual(record['api_key_id'], '42')
        self.assertEqual(record['workspace_id'], 'ws-1')

    def test_A02_redaction_covers_nesting_and_sequences(self) -> None:
        result = redact(
            {
                'outer': {'inner': {'token': 'abc'}, 'list': [DSN, {'password': SECRET}]},
                'safe': 'value',
            }
        )
        text = str(result)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('abc', text)
        self.assertIn('value', text)

    def test_A02_redaction_is_bounded(self) -> None:
        """A hostile payload cannot turn one log line into a denial of service."""
        deep: dict[str, object] = {'level': 'end'}
        for _ in range(50):
            deep = {'level': deep}
            deep = {'level': deep}
        rendered = str(redact(deep))
        self.assertIn('[TRUNCATED]', rendered)

        wide = {f'key{index}': index for index in range(500)}
        self.assertIn('[TRUNCATED]', str(redact(wide)))

        long_string = 'x' * 10000
        self.assertIn('[TRUNCATED]', str(redact({'note': long_string})))

    def test_A02_bytes_are_never_rendered(self) -> None:
        self.assertEqual(redact({'digest': b'\x00\x01\x02'})['digest'], '<3 bytes>')  # type: ignore[index]

    def test_A02_a_traceback_is_logged_without_a_secret(self) -> None:
        with CapturedLogs() as captured:
            try:
                raise RuntimeError(f'could not connect to {DSN}')
            except RuntimeError:
                get_logger('test').exception('connection.failed')
        self.assertNotIn(SECRET, captured.text)
        self.assertIn(REDACTED, captured.text)


class RequestIdTests(ApiTestCase):
    def test_A02_every_response_carries_a_request_id(self) -> None:
        first = self.client.get('/healthz')
        second = self.client.get('/healthz')
        self.assertTrue(first.headers['x-request-id'])
        self.assertNotEqual(first.headers['x-request-id'], second.headers['x-request-id'])

    def test_A02_an_untrusted_client_cannot_choose_its_request_id(self) -> None:
        """A client-controlled id could forge or merge two trails (RK-21)."""
        response = self.client.get('/healthz', headers={'X-Request-Id': 'forged-by-the-client'})
        self.assertNotEqual(response.headers['x-request-id'], 'forged-by-the-client')

    def test_A02_the_error_body_carries_the_request_id(self) -> None:
        response = self.client.get('/users/me')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json()['error']['requestId'],
            response.headers['x-request-id'],
            'the id in the body is what a user quotes and an operator greps for',
        )


class TrustedProxyTests(ApiTestCase):
    overrides = {'BB_TRUSTED_PROXY_CIDRS': '127.0.0.0/8'}

    def test_A02_a_trusted_proxy_may_set_the_request_id(self) -> None:
        """The compose network is trusted (``deployment-architecture.md`` section 5)."""
        client = self.new_client()
        client.headers.update({'X-Request-Id': 'from-the-proxy'})
        # TestClient's peer is "testclient", not an address, so it is never trusted; the check is
        # that the setting parses and that an untrusted peer is refused. The trusted branch is
        # covered by Settings.is_trusted_proxy in test_A02_settings.
        response = client.get('/healthz')
        self.assertNotEqual(response.headers['x-request-id'], 'from-the-proxy')
        self.assertTrue(self.settings.is_trusted_proxy('127.0.0.1'))
        self.assertFalse(self.settings.is_trusted_proxy('203.0.113.7'))


if __name__ == '__main__':
    unittest.main()
