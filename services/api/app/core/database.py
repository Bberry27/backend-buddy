"""The engine, the request-scoped session, and the two readiness probes (work package A02).

:class:`Database` wraps :func:`app.db.create_engine_from_env` (A01) and adds what the API needs:

* a request-scoped :class:`~sqlalchemy.orm.Session`, created and committed by
  :class:`UnitOfWorkMiddleware` and handed to a route by :func:`session_dependency`. One
  transaction per request, committed on a success status and rolled back on a failure one, so a
  handler that fails half way through leaves no partial row behind;
* a **separate** short transaction for the audit trail and the failed-login counter.
  :mod:`app.audit` must not share the request's transaction: a rejected login rolls that
  transaction back, and an audit trail that disappears whenever the request failed would record
  only the successes (CTQ-16). ``audit_events`` is insert-only, so a committed row is safe to
  write early;
* the readiness probes: the store answers, and Alembic is at the head revision the shipped
  ``alembic/versions`` directory declares.

**Why a middleware rather than a dependency with a ``yield``.** The obvious implementation --
``yield`` the session and commit in the teardown -- commits *after* the response has been sent,
because that is when FastAPI runs dependency teardown. The window is small and it is real: a
client that acts on a ``200`` from ``DELETE /workspaces/{id}/api-keys/{key}`` can use the revoked
key one more time, and a client that acts on a ``200`` from ``POST /auth/logout`` can use the
ended session one more time. A test client never sees it, because it runs the whole application
including teardown before it returns the response object; a real ASGI server does. So the commit
happens here, when the response's status line is known but before it is forwarded, which is the
last moment that is still inside the request.

Nothing here connects on import. ``create_engine`` is lazy, and the first connection is opened by
the first request, the first audit row, or ``/readyz``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator, MutableMapping
from contextlib import contextmanager
from functools import cached_property
from pathlib import Path
from typing import Any, Final

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import Request
from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session, sessionmaker
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.db import create_engine_from_env, database_url, safe_url

__all__ = [
    'SERVICE_ROOT',
    'SESSION_STATE_KEY',
    'Database',
    'UnitOfWorkMiddleware',
    'expected_head',
    'installed_head',
    'session_dependency',
]

#: Where the request's session lives on the ASGI scope's ``state``.
SESSION_STATE_KEY: Final = 'db_session'

#: ``services/api``, the directory that holds ``alembic.ini`` and the revision scripts.
SERVICE_ROOT: Final = Path(__file__).resolve().parents[2]


class Database:
    """The metadata store as the API sees it."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._environment = settings.database_environment()

    @cached_property
    def engine(self) -> Engine:
        """The engine, built on first use.

        Lazy for one concrete reason: building it resolves the URL, which reads the password from
        the secret file. ``python -m app.export_openapi`` and any other tool that only wants the
        assembled application must not need the deployment's secrets to run.
        """
        return create_engine_from_env(self._environment, pool_pre_ping=True)

    @cached_property
    def _sessions(self) -> sessionmaker[Session]:
        return sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=True)

    def new_session(self) -> Session:
        """An unopened session. Creating one performs no I/O; the first query connects."""
        return self._sessions()

    @property
    def safe_url(self) -> str:
        """The store's URL with the password masked, for a log line or an error message."""
        return safe_url(database_url(self._environment))

    @contextmanager
    def session(self) -> Iterator[Session]:
        """One transaction: commit on success, roll back on any exception."""
        session = self._sessions()
        try:
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise
        finally:
            session.close()

    @contextmanager
    def separate_transaction(self) -> Iterator[Connection]:
        """A short transaction of its own, independent of the request's.

        Two callers need this, and for the same reason: they record *that something was
        attempted*, and must survive the rollback of the attempt.

        * :mod:`app.audit` -- a ``login.failure`` row that disappeared with the rejected request
          would leave a trail of successes only (CTQ-16).
        * ``users.failed_login_count`` -- the counter exists so an operator can see an attack
          (``data-model.md`` 3.2), which it cannot do if every failure rolls it back.

        Nothing else may use it: a write that belongs to the request belongs in the request's
        transaction, where a later failure can still undo it.
        """
        with self.engine.begin() as connection:
            yield connection

    def reachable(self) -> None:
        """Raise the driver's own exception when the store does not answer ``select 1``."""
        with self.engine.connect() as connection:
            connection.execute(text('select 1'))

    def dispose(self) -> None:
        """Close every pooled connection. Called from the application's shutdown.

        Nothing is built here that was not built already: an application that never touched the
        store has no engine to dispose of.
        """
        if 'engine' in self.__dict__:
            self.engine.dispose()


def expected_head() -> str:
    """The head revision of the shipped ``alembic/versions`` directory."""
    config = Config(str(SERVICE_ROOT / 'alembic.ini'))
    config.set_main_option('script_location', str(SERVICE_ROOT / 'alembic'))
    config.attributes['configure_logger'] = False
    return ScriptDirectory.from_config(config).get_current_head() or ''


def installed_head(connection: Connection) -> str:
    """The revision recorded in ``alembic_version``, or ``''`` when the table is absent.

    The application role holds ``select`` on ``alembic_version`` and nothing more
    (``ops/sql/roles.sql``), which is exactly what this needs.
    """
    exists = connection.execute(
        text("select to_regclass('public.alembic_version') is not null")
    ).scalar_one()
    if not exists:
        return ''
    revision = connection.execute(text('select version_num from alembic_version')).scalar()
    return str(revision) if revision else ''


def session_dependency(request: Request) -> Session:
    """The session :class:`UnitOfWorkMiddleware` opened for this request."""
    state = request.scope.get('state')
    session = state.get(SESSION_STATE_KEY) if isinstance(state, dict) else None
    if not isinstance(session, Session):
        raise RuntimeError(
            'no request session: UnitOfWorkMiddleware must be installed for every route that '
            'depends on session_dependency'
        )
    return session


class UnitOfWorkMiddleware:
    """One transaction per HTTP request, committed before the response leaves.

    The status line decides: below 400 the session commits, from 400 up it rolls back, and either
    way it is closed when the request ends. A commit that fails raises before anything has been
    forwarded, so the request fails with a 500 rather than reporting a success it did not store.

    The session is created for every HTTP request but connects only when a route actually queries,
    so ``/healthz`` still touches no database.
    """

    def __init__(self, app: Callable[..., Awaitable[None]], database: Database) -> None:
        self.app = app
        self.database = database

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        session = self.database.new_session()
        state = scope.setdefault('state', {})
        if isinstance(state, dict):
            state[SESSION_STATE_KEY] = session
        settled = False

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            nonlocal settled
            if message['type'] == 'http.response.start' and not settled:
                settled = True
                if int(message['status']) < 400:
                    await run_in_threadpool(session.commit)
                else:
                    await run_in_threadpool(session.rollback)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except BaseException:
            if not settled:
                settled = True
                await run_in_threadpool(session.rollback)
            raise
        finally:
            await run_in_threadpool(session.close)
