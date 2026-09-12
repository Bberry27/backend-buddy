"""Alembic environment for the metadata store (work package A01).

The URL is never read from ``alembic.ini``: :func:`app.db.database_url` resolves it, so the
migration entry point, the API, and the worker all agree on where the metadata store is and all
read the password from the same secret file. That is also why a URL never appears in a log line
here -- ``app.db.safe_url`` masks the password.

Online mode is what ``alembic upgrade head`` uses in the ``migrate`` one-shot service; offline
mode (``--sql``) emits the statements for an operator who applies migrations by hand.

Two ``config.attributes`` keys exist for programmatic callers -- the A01 test suite drives
migrations against a throwaway database rather than the deployment's:

* ``url``: a :class:`~sqlalchemy.URL` to migrate instead of the resolved one;
* ``configure_logger``: set ``False`` to leave logging alone.
"""

from __future__ import annotations

import logging
from logging.config import fileConfig

from sqlalchemy import URL, create_engine, pool
from sqlalchemy.engine import Connection

from alembic import context
from app.db import create_engine_from_env, database_url, safe_url
from app.models import Base

log = logging.getLogger('alembic.env')

config = context.config
if config.config_file_name is not None and config.attributes.get('configure_logger', True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

#: Autogenerate and ``compare_metadata()`` (``test_A01_migration_matches_models``) compare against
#: the declarative model, so the migration and the model cannot drift apart unnoticed.
target_metadata = Base.metadata


def _url() -> URL:
    """The URL to migrate: a caller-supplied one, else the deployment's resolved locator."""
    supplied = config.attributes.get('url')
    return supplied if isinstance(supplied, URL) else database_url()


def run_migrations_offline() -> None:
    """Emit SQL for the resolved URL without connecting to it."""
    context.configure(
        url=_url().render_as_string(hide_password=False),
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        literal_binds=True,
        dialect_opts={'paramstyle': 'named'},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against the resolved URL in one transaction."""
    supplied = config.attributes.get('url')
    engine = (
        create_engine(supplied, poolclass=pool.NullPool)
        if isinstance(supplied, URL)
        else create_engine_from_env(poolclass=pool.NullPool)
    )
    try:
        with engine.connect() as connection:
            _run(connection)
    finally:
        engine.dispose()


def _run(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    # Recorded once, with the password masked, so an operator can see which database was migrated.
    log.info('metadata store %s', safe_url(_url()))
    run_migrations_online()
