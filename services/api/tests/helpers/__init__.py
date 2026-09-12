"""Test harness for the A02 suites (unittest, per ADR-0008).

:class:`ApiTestCase` gives each test class its own throwaway PostgreSQL database, migrated to
head, its own master-key file, and a :class:`~fastapi.testclient.TestClient` over an application
built from settings that point at both. Nothing is shared with another class, so the suites are
order-independent and can be run singly.

Three deliberate choices in the settings every case starts from:

* ``BB_COOKIE_SECURE=false``, because ``TestClient`` speaks plain HTTP and a browser -- or
  httpx's cookie jar -- would refuse to return a ``Secure`` cookie over it. The cases that must
  see the real ``__Host-`` name set ``BB_PUBLIC_ORIGIN`` to an HTTPS origin instead
  (``test_A02_cookie_flags_and_csrf``), which forces ``Secure`` back on.
* ``BB_RATE_LIMIT_ENABLED=false``, because most cases log in more than ten times a minute. The
  rate-limit cases turn it back on with a tiny rule.
* a random master key per class, written to a temporary file, so the fingerprint checks are real
  and no key material is ever committed or shared between classes.

The factories below insert rows directly rather than through the API on purpose: A02 has no route
that creates an account, so a test that needs three users with three roles has to make them, and
making them through the database keeps the test about the thing it is testing.
"""

from __future__ import annotations

import datetime as dt
import secrets
import sys
import tempfile
import unittest
import uuid
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, ClassVar

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import URL, select
from sqlalchemy.orm import Session as OrmSession

from alembic import command
from app.auth.passwords import hash_password
from app.auth.tokens import mint_api_key
from app.core.settings import Settings
from app.main import create_app
from app.models import ApiKey, AuditEvent, EncryptionKey, User, Workspace, WorkspaceMember

# ``tests`` is not part of the installed distribution (``app*`` only), so the service root goes on
# the path before the sibling module is imported. Same pattern as the A01 suites.
if str(Path(__file__).resolve().parents[2]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tests.conftest_db import alembic_config, temporary_database  # noqa: E402

__all__ = ['DEFAULT_PASSWORD', 'ApiTestCase', 'unique_email']

#: A password that satisfies the policy: twelve or more characters, not on the deny list, not a
#: repeated character or a keyboard row. Random, so it cannot accidentally become a fixture that
#: some other test depends on the value of.
DEFAULT_PASSWORD = f'harbour-lantern-{secrets.token_hex(4)}'


def unique_email(label: str = 'user') -> str:
    """An address no other case will use. ``users.email`` is unique across the deployment."""
    return f'{label}-{uuid.uuid4().hex[:12]}@example.test'


class ApiTestCase(unittest.TestCase):
    """Base class: one database, one application, one client per test class."""

    #: Extra ``BB_*`` values for this class's application.
    overrides: ClassVar[dict[str, str]] = {}

    #: The client's base URL. A class that tests ``Secure`` cookies must use ``https``, because
    #: httpx's cookie jar -- like a browser -- refuses to store or return a ``Secure`` cookie over
    #: plain HTTP, and the cookie would silently never come back.
    base_url: ClassVar[str] = 'http://testserver'

    url: ClassVar[URL]
    settings: ClassVar[Settings]
    application: ClassVar[FastAPI]
    client: ClassVar[TestClient]
    master_key: ClassVar[bytes]
    master_key_file: ClassVar[Path]
    _stack: ClassVar[ExitStack]

    @classmethod
    def setUpClass(cls) -> None:
        cls._stack = ExitStack()
        try:
            cls.url = cls._stack.enter_context(temporary_database('backend-buddy_a02'))
            command.upgrade(alembic_config(cls.url), 'head')
            directory = Path(cls._stack.enter_context(tempfile.TemporaryDirectory()))
            cls.master_key = secrets.token_bytes(32)
            cls.master_key_file = directory / 'backend-buddy_master_key'
            cls.master_key_file.write_bytes(cls.master_key)
            cls.settings = Settings.from_environment(
                {
                    'BB_DATABASE_URL': cls.url.render_as_string(hide_password=False),
                    'BB_MASTER_KEY_FILE': str(cls.master_key_file),
                    'BB_COOKIE_SECURE': 'false',
                    'BB_RATE_LIMIT_ENABLED': 'false',
                    **cls.overrides,
                }
            )
            cls.application = create_app(cls.settings)
            cls.client = cls._stack.enter_context(
                TestClient(cls.application, base_url=cls.base_url, raise_server_exceptions=False)
            )
        except BaseException:
            cls._stack.close()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls._stack.close()

    # -- direct database access ----------------------------------------------------------------

    @contextmanager
    def session(self) -> Iterator[OrmSession]:
        """A committing session on the class's database, for arranging and asserting."""
        database = self.application.state.database
        with database.session() as session:
            yield session

    def new_client(self) -> TestClient:
        """A second client with its own cookie jar, for a second principal in the same test."""
        return TestClient(
            self.application, base_url=self.base_url, raise_server_exceptions=False
        )

    # -- factories -----------------------------------------------------------------------------

    def make_user(
        self,
        *,
        email: str | None = None,
        password: str = DEFAULT_PASSWORD,
        display_name: str | None = None,
        is_active: bool = True,
    ) -> uuid.UUID:
        """Insert an account and return its id."""
        address = email or unique_email()
        with self.session() as session:
            user = User(
                email=address,
                password_hash=hash_password(password),
                display_name=display_name,
                is_active=is_active,
            )
            session.add(user)
            session.flush()
            return user.id

    def make_workspace(self, *, slug: str | None = None, name: str = 'Test workspace') -> uuid.UUID:
        """Insert a workspace and return its id."""
        with self.session() as session:
            workspace = Workspace(slug=slug or f'ws-{uuid.uuid4().hex[:10]}', name=name)
            session.add(workspace)
            session.flush()
            return workspace.id

    def make_member(self, workspace_id: uuid.UUID, user_id: uuid.UUID, role: str) -> None:
        """Grant ``user_id`` ``role`` in ``workspace_id``."""
        with self.session() as session:
            session.add(
                WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role)
            )

    def make_principal(self, role: str = 'owner') -> tuple[uuid.UUID, uuid.UUID, str]:
        """A workspace, an account holding ``role`` in it, and the account's email."""
        email = unique_email(role)
        user_id = self.make_user(email=email)
        workspace_id = self.make_workspace()
        self.make_member(workspace_id, user_id, role)
        return workspace_id, user_id, email

    def make_api_key(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        role: str = 'viewer',
        expires_at: dt.datetime | None = None,
        revoked: bool = False,
    ) -> str:
        """Insert a key directly and return the bearer token to present."""
        material = mint_api_key()
        with self.session() as session:
            session.add(
                ApiKey(
                    workspace_id=workspace_id,
                    user_id=user_id,
                    name='test key',
                    key_prefix=material.key_prefix,
                    key_hash=material.key_hash,
                    role=role,
                    expires_at=expires_at,
                    revoked_at=dt.datetime.now(dt.UTC) if revoked else None,
                )
            )
        return material.token

    def email_of(self, user_id: uuid.UUID) -> str:
        """The email address of an account made by :meth:`make_user`."""
        with self.session() as session:
            user = session.get(User, user_id)
            assert user is not None
            return user.email

    def failure_count(self, user_id: uuid.UUID) -> int:
        """``users.failed_login_count``, which only a separate transaction ever increments."""
        with self.session() as session:
            user = session.get(User, user_id)
            assert user is not None
            return user.failed_login_count

    def api_key_ids(self, workspace_id: uuid.UUID) -> list[uuid.UUID]:
        """The ids of every key in ``workspace_id``, newest first."""
        with self.session() as session:
            return list(
                session.scalars(
                    select(ApiKey.id)
                    .where(ApiKey.workspace_id == workspace_id)
                    .order_by(ApiKey.created_at.desc())
                )
            )

    # -- API helpers ---------------------------------------------------------------------------

    def login(
        self,
        email: str,
        password: str = DEFAULT_PASSWORD,
        *,
        client: TestClient | None = None,
    ) -> tuple[Any, str]:
        """Log in and return the response and the CSRF token it issued."""
        used = client or self.client
        response = used.post('/auth/login', json={'email': email, 'password': password})
        token = response.json().get('csrfToken', '') if response.status_code == 200 else ''
        return response, token

    @staticmethod
    def csrf(token: str) -> dict[str, str]:
        """The header a state-changing cookie request must carry."""
        return {'X-CSRF-Token': token}

    def audit_actions(self) -> list[str]:
        """Every audit action written so far, oldest first."""
        with self.session() as session:
            return list(
                session.scalars(select(AuditEvent.action).order_by(AuditEvent.id))
            )

    def audit_rows(self, action: str) -> list[AuditEvent]:
        """Every audit row for ``action``, oldest first."""
        with self.session() as session:
            return list(
                session.scalars(
                    select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
                )
            )

    def register_master_key(self, fingerprint: bytes) -> None:
        """Insert an ``encryption_keys`` row with ``fingerprint``, as bootstrap would."""
        with self.session() as session:
            session.add(
                EncryptionKey(algorithm='AES-256-GCM', master_key_fingerprint=fingerprint)
            )
