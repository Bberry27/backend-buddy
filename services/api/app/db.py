"""Metadata store URL and engine (work package A01).

The locator comes from the environment contract in ``docs/architecture/deployment-architecture.md``
section 4; the password comes from a secret *file*, never from an environment variable, because
``docs/architecture/security-architecture.md`` section 9 forbids a secret in the environment or a
log. Two rules follow from that and are enforced here:

* :func:`database_url` renders the password only into the URL object it returns; every message this
  module raises or logs uses :func:`safe_url`, which renders the URL with the password masked.
* Importing this module performs no I/O. The secret file is read by :func:`database_url` and the
  server is contacted only by :func:`create_engine_from_env`.

Resolution order for the URL:

1. ``BB_DATABASE_URL`` -- a complete SQLAlchemy or libpq URL. The escape hatch for tooling that
   already holds a DSN (Alembic run by hand, a one-shot ``psql``-equivalent script).
2. ``BB_TEST_DATABASE_URL`` -- the same, reserved for test databases so the A01 suite and the
   ``alembic`` acceptance commands share one entry point (``docs/product-management/agent-briefs/
   WP-A01.md`` section 9). A deployment sets neither variable.
3. ``BB_DB_HOST``, ``BB_DB_PORT``, ``BB_DB_NAME``, ``BB_DB_USER`` with the password read
   from the file named by ``BB_DB_PASSWORD_FILE`` -- what ``deploy/compose.yml`` provides.

A ``postgresql://`` URL is rewritten to ``postgresql+psycopg://`` so SQLAlchemy always loads the
psycopg 3 driver this package pins, rather than falling back to its psycopg2 default.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sqlalchemy import URL, Engine, create_engine, make_url

__all__ = [
    'DEFAULTS',
    'DRIVER',
    'PASSWORD_FILE_VARIABLE',
    'TEST_URL_VARIABLE',
    'URL_VARIABLE',
    'ConfigError',
    'create_engine_from_env',
    'database_url',
    'safe_url',
]

#: SQLAlchemy dialect and driver. Pinned so a bare ``postgresql://`` URL cannot select psycopg2.
DRIVER = 'postgresql+psycopg'

URL_VARIABLE = 'BB_DATABASE_URL'
TEST_URL_VARIABLE = 'BB_TEST_DATABASE_URL'
PASSWORD_FILE_VARIABLE = 'BB_DB_PASSWORD_FILE'

#: Locator defaults from ``deployment-architecture.md`` section 4. The password has no default.
DEFAULTS: Mapping[str, str] = {
    'BB_DB_HOST': 'db',
    'BB_DB_PORT': '5432',
    'BB_DB_NAME': 'backend-buddy',
    'BB_DB_USER': 'backend-buddy',
    PASSWORD_FILE_VARIABLE: '/run/secrets/backend-buddy_db_password',
}


class ConfigError(RuntimeError):
    """The metadata store configuration is incomplete or unusable.

    The message names the variable or the path at fault and never contains a secret.
    """


def safe_url(url: URL) -> str:
    """Render ``url`` for a message or a log line with the password masked."""
    return url.render_as_string(hide_password=True)


def _with_driver(url: URL) -> URL:
    """Force the psycopg 3 driver on a PostgreSQL URL, and reject any other dialect."""
    if url.get_backend_name() != 'postgresql':
        raise ConfigError(
            f'the metadata store must be PostgreSQL, not {url.get_backend_name()!r} '
            f'(URL {safe_url(url)})'
        )
    return url.set(drivername=DRIVER)


def _read_password(path_text: str) -> str:
    """Read the metadata store password from a secret file.

    Only the file's content is used, with one trailing newline removed so an editor-written file
    works. The content is never included in an exception message.
    """
    path = Path(path_text)
    try:
        raw = path.read_text(encoding='utf-8')
    except OSError as error:
        raise ConfigError(
            f'{PASSWORD_FILE_VARIABLE} points at {path_text!r}, which could not be read '
            f'({error.__class__.__name__})'
        ) from None
    password = raw.removesuffix('\n').removesuffix('\r')
    if not password:
        raise ConfigError(f'{PASSWORD_FILE_VARIABLE} points at {path_text!r}, which is empty')
    return password


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise ConfigError(f'BB_DB_PORT must be an integer, not {value!r}') from None
    if not 1 <= port <= 65535:
        raise ConfigError(f'BB_DB_PORT must be between 1 and 65535, not {port}')
    return port


def database_url(env: Mapping[str, str] | None = None) -> URL:
    """Resolve the metadata store URL from ``env`` (the process environment by default).

    Raises :class:`ConfigError` when no variable in the resolution order yields a usable URL.
    """
    environ = os.environ if env is None else env
    for variable in (URL_VARIABLE, TEST_URL_VARIABLE):
        candidate = (environ.get(variable) or '').strip()
        if candidate:
            try:
                return _with_driver(make_url(candidate))
            except ConfigError:
                raise
            except Exception:
                raise ConfigError(f'{variable} is not a valid database URL') from None

    password_file = environ.get(PASSWORD_FILE_VARIABLE) or DEFAULTS[PASSWORD_FILE_VARIABLE]
    return URL.create(
        drivername=DRIVER,
        username=environ.get('BB_DB_USER') or DEFAULTS['BB_DB_USER'],
        password=_read_password(password_file),
        host=environ.get('BB_DB_HOST') or DEFAULTS['BB_DB_HOST'],
        port=_port(environ.get('BB_DB_PORT') or DEFAULTS['BB_DB_PORT']),
        database=environ.get('BB_DB_NAME') or DEFAULTS['BB_DB_NAME'],
    )


def create_engine_from_env(env: Mapping[str, str] | None = None, **options: Any) -> Engine:
    """Build an :class:`~sqlalchemy.Engine` for the resolved URL.

    ``pool_pre_ping`` is on because the metadata store may be restarted under the API, and
    ``future``-style 2.0 semantics are the SQLAlchemy 2 default. Nothing connects until the engine
    is first used.
    """
    options.setdefault('pool_pre_ping', True)
    return create_engine(database_url(env), **options)
