"""``/healthz`` and ``/readyz`` (work package A02; CTQ-15; ``deployment-architecture.md`` 6).

``test_A02_readyz_master_key_mismatch`` is the named case, and it is the RK-08 mitigation: a
restored database with the wrong master key file is caught at readiness rather than by a
decryption failure on the first connection write.

The empty-registry case is the decision this package made and is asserted here so it cannot be
changed by accident: a fresh deployment, before anybody has run ``python -m app.bootstrap``, is
**ready**, because CTQ-15 requires ``docker compose up`` to reach ``/readyz`` 200 within five
minutes and bootstrap is a human step that happens afterwards.
"""

from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402


class HealthTests(ApiTestCase):
    def test_A02_healthz_touches_nothing(self) -> None:
        """Liveness must stay green while a dependency is down, or Docker restarts a good API."""
        response = self.client.get('/healthz')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})

    def test_A02_healthz_needs_no_credential(self) -> None:
        self.assertEqual(self.client.get('/healthz').status_code, 200)
        self.assertEqual(self.client.get('/readyz').status_code, 200)


class EmptyRegistryTests(ApiTestCase):
    """Its own database: the ``encryption_keys`` registry has to still be empty."""

    def test_A02_readyz_is_ready_with_an_empty_key_registry(self) -> None:
        """CTQ-15: ready before bootstrap has run, with the reason saying why."""
        response = self.client.get('/readyz')
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body['status'], 'ready')
        self.assertTrue(body['database'])
        self.assertTrue(body['migrations'])
        self.assertTrue(body['masterKey'])
        self.assertIn('bootstrap', body['reason'])


class MatchingKeyTests(ApiTestCase):
    """Its own database: exactly one registry row, and it is the right one."""

    def test_A02_readyz_is_ready_when_the_fingerprint_matches(self) -> None:
        self.register_master_key(hashlib.sha256(self.master_key).digest())
        body = self.client.get('/readyz').json()
        self.assertEqual(body['status'], 'ready')
        self.assertIsNone(body['reason'])


class ReadinessTests(ApiTestCase):
    def test_A02_readyz_master_key_mismatch(self) -> None:
        """A different key than the one this database was initialised with: 503, redacted."""
        self.register_master_key(hashlib.sha256(b'a-completely-different-master-key').digest())
        response = self.client.get('/readyz')
        self.assertEqual(response.status_code, 503)
        body = response.json()
        self.assertEqual(body['status'], 'not_ready')
        self.assertTrue(body['database'])
        self.assertTrue(body['migrations'])
        self.assertFalse(body['masterKey'])
        self.assertIn('does not match', body['reason'])
        # Redacted: neither fingerprint, nor the key, nor the file path is in the response.
        self.assertNotIn(self.master_key.hex(), response.text)
        self.assertNotIn(str(self.master_key_file), response.text)

    def test_A02_readyz_reports_an_unreadable_master_key(self) -> None:
        original = self.master_key_file.read_bytes()
        try:
            self.master_key_file.write_bytes(b'too-short')
            response = self.client.get('/readyz')
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.json()['masterKey'])
            self.assertIn('256-bit', response.json()['reason'])
        finally:
            self.master_key_file.write_bytes(original)

    def test_A02_readyz_carries_the_security_headers(self) -> None:
        """The acceptance command greps this response for them."""
        headers = {key.lower() for key in self.client.get('/readyz').headers}
        self.assertIn('content-security-policy', headers)
        self.assertIn('x-content-type-options', headers)
        self.assertIn('referrer-policy', headers)


class MigrationStateTests(ApiTestCase):
    def test_A02_readyz_is_not_ready_below_the_head_revision(self) -> None:
        """An API that starts against an unmigrated schema is the failure this prevents."""
        from sqlalchemy import text

        database = self.application.state.database
        with database.separate_transaction() as connection:
            connection.execute(text("update alembic_version set version_num = '0000'"))
        try:
            response = self.client.get('/readyz')
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.json()['migrations'])
            self.assertIn('head migration', response.json()['reason'])
        finally:
            with database.separate_transaction() as connection:
                connection.execute(text("update alembic_version set version_num = '0001'"))
        self.assertEqual(self.client.get('/readyz').status_code, 200)


if __name__ == '__main__':
    unittest.main()
