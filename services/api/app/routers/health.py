"""``/healthz`` and ``/readyz`` (work package A02; CTQ-15; ``deployment-architecture.md`` 6).

The two answer different questions, and conflating them is how a rolling restart takes a
deployment down.

* ``GET /healthz`` -- *is this process alive?* It touches nothing: no database, no secret, no
  file. It is the container ``HEALTHCHECK``, so it must stay green while a dependency is down;
  otherwise Docker restarts a perfectly healthy API because PostgreSQL is being upgraded.
* ``GET /readyz`` -- *can this process serve requests?* Three checks, exactly the ones the
  deployment document names: the metadata store answers, Alembic is at the head revision this
  image ships, and the master key matches the fingerprint recorded in ``encryption_keys``. Not
  ready is **503**, so a proxy stops sending traffic.

The master-key check is the mitigation for RK-08 (master-key loss). A restored database plus the
wrong key file is otherwise discovered much later, by a decryption failure on one connection; the
fingerprint turns it into a startup-time answer. The reason is redacted: it says *that* the
fingerprint differs, never either value.

**Decision recorded here** (A02 brief, open question 3: which component creates the
``encryption_keys`` row). ``python -m app.bootstrap`` creates it, because bootstrap is the one
step that already reads the master key and already runs before anything else. A03's first
connection write may also create one if bootstrap did not. Consequence for this endpoint: an
**empty** registry is *ready* -- a fresh deployment has no key row yet, and CTQ-15 requires
``docker compose up`` to reach ``/readyz`` 200 in under five minutes, before any human has run
bootstrap. A **mismatching** registry is not ready. The distinction is in the response: an empty
registry sets ``masterKey`` true with a reason saying it is unregistered.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select

from app.auth.rbac import PUBLIC_ROUTE
from app.core.api_models import Health, Readiness
from app.core.database import Database, expected_head, installed_head
from app.core.logging import get_logger
from app.core.settings import Settings
from app.db import ConfigError
from app.models import EncryptionKey

__all__ = ['router']

router = APIRouter(tags=['health'], dependencies=[Depends(PUBLIC_ROUTE)])

log = get_logger('app.health')


@router.get('/healthz', response_model=Health, summary='Liveness: the process is running')
def healthz() -> Health:
    """Answer 200 as long as this process can serve a request at all."""
    return Health()


@router.get(
    '/readyz',
    response_model=Readiness,
    summary='Readiness: store reachable, migrations at head, master key matching',
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {'model': Readiness}},
)
def readyz(request: Request, response: Response) -> Readiness:
    """Run the three readiness checks and answer 200 or 503."""
    settings: Settings = request.app.state.settings
    database: Database = request.app.state.database

    database_ok = True
    reason: str | None = None
    try:
        database.reachable()
    except Exception:
        database_ok = False
        reason = 'the metadata store did not answer'
        log.warning('readyz.database_unreachable', store=database.safe_url)

    migrations_ok = False
    if database_ok:
        try:
            with database.engine.connect() as connection:
                installed = installed_head(connection)
            head = expected_head()
            migrations_ok = bool(head) and installed == head
            if not migrations_ok:
                reason = reason or 'the metadata store is not at the head migration'
                log.warning('readyz.migration_mismatch', installed=installed, expected=head)
        except Exception:
            reason = reason or 'the migration state could not be read'
            log.exception('readyz.migration_check_failed')

    master_key_ok, key_reason = _master_key_state(settings, database, database_ok=database_ok)
    reason = reason or key_reason

    ready = database_ok and migrations_ok and master_key_ok
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return Readiness(
        status='ready' if ready else 'not_ready',
        database=database_ok,
        migrations=migrations_ok,
        master_key=master_key_ok,
        reason=reason,
    )


def _master_key_state(
    settings: Settings,
    database: Database,
    *,
    database_ok: bool,
) -> tuple[bool, str | None]:
    """Whether the master key matches the registry, and a redacted reason when it does not."""
    try:
        fingerprint = settings.master_key_fingerprint()
    except ConfigError as error:
        log.error('readyz.master_key_unreadable', detail=str(error))
        return False, 'the master key file is missing or not a 256-bit key'
    if not database_ok:
        return False, None
    try:
        with database.engine.connect() as connection:
            registered = connection.execute(
                select(EncryptionKey.master_key_fingerprint)
                .where(EncryptionKey.retired_at.is_(None))
                .order_by(EncryptionKey.created_at.desc())
                .limit(1)
            ).scalar()
    except Exception:
        log.exception('readyz.key_registry_unreadable')
        return False, 'the encryption key registry could not be read'
    if registered is None:
        # See the decision in the module docstring: nothing to disagree with yet.
        return True, 'no encryption key is registered yet; run python -m app.bootstrap'
    if bytes(registered) != fingerprint:
        log.error('readyz.master_key_mismatch')
        return False, (
            'the master key does not match the fingerprint recorded in this database; '
            'connection secrets cannot be decrypted with it'
        )
    return True, None
