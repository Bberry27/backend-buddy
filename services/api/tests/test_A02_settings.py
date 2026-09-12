"""The environment contract (work package A02; ``deployment-architecture.md`` section 4).

No database is needed here, so these cases run in CI before O01 provides PostgreSQL.

``test_A02_settings_reject_unknown`` is the named CTQ case. The companion
``test_A02_every_documented_variable_is_declared`` reads the contract table out of
``deployment-architecture.md`` and fails when a name in the document is not a field of
:class:`app.core.settings.Settings` -- which is the failure mode that matters in practice: an
undeclared name would be rejected as a typo and stop the API from starting on a machine that sets
it legitimately.

Run from the repository root::

    python -m unittest discover -s services/api/tests -p 'test_A02_*.py'
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from app.core.settings import MASTER_KEY_BYTES, Settings, declared_variables, unknown_variables
from app.db import ConfigError

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEPLOYMENT_DOC = REPOSITORY_ROOT / 'docs' / 'architecture' / 'deployment-architecture.md'

#: Names the document lists that belong to another process and are not API settings.
NOT_API_SETTINGS = frozenset({'BB_SCHEMA'})


def documented_variables() -> set[str]:
    """Every ``BB_*`` name in section 4 of the deployment architecture."""
    text = DEPLOYMENT_DOC.read_text(encoding='utf-8')
    start = text.index('## 4. Environment contract')
    end = text.index('## 5. TLS and network')
    return set(re.findall(r'BB_[A-Z0-9_]+', text[start:end]))


class SettingsTests(unittest.TestCase):
    def test_A02_settings_reject_unknown(self) -> None:
        """An unknown ``BB_*`` variable fails startup, and the message names it."""
        environment = {'BB_LOG_LEVEL': 'debug', 'BB_COOKIE_SECRUE': 'true'}
        self.assertEqual(unknown_variables(environment), ('BB_COOKIE_SECRUE',))
        with self.assertRaises(ConfigError) as raised:
            Settings.from_environment(environment)
        self.assertIn('BB_COOKIE_SECRUE', str(raised.exception))
        self.assertIn('deployment-architecture.md', str(raised.exception))

    def test_A02_settings_accept_the_whole_contract(self) -> None:
        """Every documented name is accepted, together, in one construction."""
        settings = Settings.from_environment(
            {
                'BB_DB_HOST': 'db',
                'BB_DB_PORT': '5432',
                'BB_DB_NAME': 'backend-buddy',
                'BB_DB_USER': 'backend-buddy',
                'BB_DB_PASSWORD_FILE': '/run/secrets/backend-buddy_db_password',
                'BB_MASTER_KEY_FILE': '/run/secrets/backend-buddy_master_key',
                'BB_PUBLIC_ORIGIN': 'https://schema.example.test',
                'BB_COOKIE_SECURE': 'true',
                'BB_SESSION_IDLE_MINUTES': '30',
                'BB_SESSION_ABSOLUTE_HOURS': '8',
                'BB_ALLOW_PRIVATE_TARGETS': 'false',
                'BB_DEFAULT_TLS_MODE': 'verify-full',
                'BB_JOB_TABLE_SECONDS_DEFAULT': '5',
                'BB_JOB_TABLE_SECONDS_MAX': '60',
                'BB_JOB_CAP_SECONDS_DEFAULT': '600',
                'BB_JOB_CAP_SECONDS_MAX': '3600',
                'BB_SNAPSHOT_MAX_BYTES': '20971520',
                'BB_LOG_LEVEL': 'info',
                'BB_RATE_LIMIT_LOGIN': '10/minute',
                'BB_WORKER_CONCURRENCY': '1',
                'BB_DENYLIST_FILE': '/etc/backend-buddy/denylist.txt',
                'BB_DEPLOYMENT_MODE': 'self-hosted',
            }
        )
        self.assertEqual(settings.session_idle_minutes, 30)
        self.assertEqual(settings.session_absolute_hours, 8)
        self.assertTrue(settings.origin_is_https)
        self.assertTrue(settings.secure_cookies)

    def test_A02_every_documented_variable_is_declared(self) -> None:
        """A name in the contract table that this module does not know would block startup."""
        declared = declared_variables()
        missing = sorted(documented_variables() - declared - NOT_API_SETTINGS)
        self.assertEqual(
            missing,
            [],
            'deployment-architecture.md section 4 lists variables app.core.settings does not '
            'declare; an undeclared BB_* name fails startup',
        )

    def test_A02_https_origin_forces_secure_cookies(self) -> None:
        """A deployment cannot serve over TLS and hand out a cookie that travels in the clear."""
        settings = Settings.from_environment(
            {'BB_PUBLIC_ORIGIN': 'https://schema.example.test', 'BB_COOKIE_SECURE': 'false'}
        )
        self.assertTrue(settings.secure_cookies)

    def test_A02_defaults_are_the_proposed_values(self) -> None:
        """The values A02 chose, pinned so a change to any of them is a visible one."""
        settings = Settings.from_environment({})
        self.assertEqual(settings.session_idle_minutes, 60)
        self.assertEqual(settings.session_absolute_hours, 12)
        self.assertEqual(settings.rate_limit_login, '10/minute')
        self.assertEqual(settings.rate_limit_api_key, '20/hour')
        self.assertEqual(settings.cookie_samesite, 'strict')
        self.assertEqual(settings.deployment_mode, 'self-hosted')
        self.assertTrue(settings.cookie_secure)

    def test_A02_rejects_a_malformed_origin_or_rate_rule(self) -> None:
        for variable, value in (
            ('BB_PUBLIC_ORIGIN', 'https://host/path'),
            ('BB_PUBLIC_ORIGIN', 'ftp://host'),
            ('BB_RATE_LIMIT_LOGIN', 'lots'),
            ('BB_RATE_LIMIT_API_KEY', '10/fortnight'),
            ('BB_TRUSTED_PROXY_CIDRS', '10.0.0.0/99'),
            ('BB_DEPLOYMENT_MODE', 'multi-tenant'),
            ('BB_SESSION_IDLE_MINUTES', '0'),
        ):
            with (
                self.subTest(variable=variable, value=value),
                self.assertRaises((ConfigError, ValidationError)),
            ):
                Settings.from_environment({variable: value})

    def test_A02_trusted_proxy_ranges(self) -> None:
        settings = Settings.from_environment({'BB_TRUSTED_PROXY_CIDRS': '10.1.0.0/16'})
        self.assertTrue(settings.is_trusted_proxy('10.1.2.3'))
        self.assertFalse(settings.is_trusted_proxy('10.2.2.3'))
        self.assertFalse(settings.is_trusted_proxy('not-an-address'))
        self.assertFalse(settings.is_trusted_proxy(None))


class MasterKeyTests(unittest.TestCase):
    def _settings(self, content: bytes) -> Settings:
        directory = tempfile.mkdtemp()
        path = Path(directory) / 'backend-buddy_master_key'
        path.write_bytes(content)
        return Settings.from_environment({'BB_MASTER_KEY_FILE': str(path)})

    def test_A02_master_key_accepts_raw_and_hex(self) -> None:
        raw = bytes(range(MASTER_KEY_BYTES))
        self.assertEqual(self._settings(raw).read_master_key(), raw)
        self.assertEqual(self._settings(raw + b'\n').read_master_key(), raw)
        self.assertEqual(self._settings(raw.hex().encode('ascii')).read_master_key(), raw)
        self.assertEqual(self._settings(raw.hex().encode('ascii') + b'\n').read_master_key(), raw)

    def test_A02_master_key_rejects_the_wrong_length(self) -> None:
        for content in (b'', b'short', bytes(31), bytes(33), b'zz' * 32):
            with self.subTest(length=len(content)), self.assertRaises(ConfigError) as raised:
                self._settings(content).read_master_key()
            self.assertIn('BB_MASTER_KEY_FILE', str(raised.exception))

    def test_A02_master_key_error_never_carries_the_key(self) -> None:
        """The message names the path and the length, never the content."""
        secret = b'S' * 31
        with self.assertRaises(ConfigError) as raised:
            self._settings(secret).read_master_key()
        self.assertNotIn('SSS', str(raised.exception))

    def test_A02_missing_master_key_file_is_a_config_error(self) -> None:
        settings = Settings.from_environment({'BB_MASTER_KEY_FILE': '/nonexistent/key'})
        with self.assertRaises(ConfigError):
            settings.read_master_key()

    def test_A02_fingerprint_is_sha256_of_the_key(self) -> None:
        import hashlib

        raw = bytes(range(MASTER_KEY_BYTES))
        settings = self._settings(raw)
        self.assertEqual(settings.master_key_fingerprint(), hashlib.sha256(raw).digest())
        self.assertEqual(len(settings.master_key_fingerprint()), 32)


if __name__ == '__main__':
    unittest.main()
