"""The audit service (work package A02; ``data-model.md`` 3.15; CTQ-16).

One function, :func:`record`, and four properties that make it worth having as a service rather
than an insert statement copied into every router:

1. **Its own transaction.** The row is written through
   :meth:`app.core.database.Database.separate_transaction`, not through the request's session. A
   rejected login rolls the request's transaction back, and an audit trail that recorded only the
   requests that succeeded would be worse than none: it would look complete. ``audit_events`` is
   insert-only, so committing early is safe -- there is nothing to undo.
2. **A closed vocabulary.** ``action`` must be in :data:`ACTIONS`, which is the list in
   ``data-model.md`` 3.15 with its ``workspace.*`` wildcard spelled out. A typo in an action name
   is a silent hole in the trail (a query for ``login.failure`` would simply not find
   ``login.faliure``), so it fails loudly, in tests, as a :class:`ValueError`.
3. **Redacted details.** ``details`` passes through :func:`app.core.logging.redact` before it is
   stored, so a caller that hands over a whole request body cannot put a password or a DSN in the
   database. The trail is exported and read by people; it is not a debug dump.
4. **A best-effort write that never breaks the request.** :func:`record` logs and swallows a
   database failure. An audit insert that raises would turn a successful logout into a 500, and
   the log line still carries the event. The trade-off is recorded here because it is a real one:
   a store that is up enough to answer the request but not the audit insert loses that row.

``request_id`` is what joins a row to the structured log (RK-21). ``ip`` is stored as ``inet``, so
an unparsable value is dropped rather than failing the insert.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import uuid
from dataclasses import dataclass
from typing import Any, Final

from sqlalchemy import insert

from app.core.database import Database
from app.core.logging import get_logger, redact
from app.models import AuditEvent
from app.models.base import ACTION_CAP

__all__ = ['ACTIONS', 'Actor', 'record']

log = get_logger('app.audit')

#: The audit vocabulary. ``data-model.md`` 3.15 lists these, ending with ``workspace.*``; the four
#: workspace events are named here so the set is closed and a test can compare it with the
#: document. A05 and later packages add their own actions to the document first.
ACTIONS: Final[frozenset[str]] = frozenset(
    {
        'login.success',
        'login.failure',
        'logout',
        'session.revoke_all',
        'api_key.create',
        'api_key.revoke',
        'member.role_change',
        'connection.create',
        'connection.update',
        'connection.test',
        'connection.delete',
        'job.submit',
        'job.cancel',
        'job.finish',
        'snapshot.upload',
        'snapshot.delete',
        'export.download',
        'review.decide',
        'workspace.create',
        'workspace.rename',
        'workspace.delete',
        'workspace.bootstrap',
    }
)


@dataclass(frozen=True, slots=True)
class Actor:
    """Who acted: an account, an API key, or neither (a deployment-level event)."""

    user_id: uuid.UUID | None = None
    api_key_id: uuid.UUID | None = None


def record(
    database: Database,
    *,
    action: str,
    actor: Actor | None = None,
    workspace_id: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    request_id: str | None = None,
    ip: str | None = None,
    details: dict[str, Any] | None = None,
    occurred_at: dt.datetime | None = None,
) -> None:
    """Write one audit row. Raises only for a programming error (an unknown ``action``)."""
    if action not in ACTIONS:
        raise ValueError(
            f'{action!r} is not in the audit vocabulary; add it to data-model.md section 3.15 '
            'and to app.audit.ACTIONS in the same change'
        )
    acted_by = actor or Actor()
    payload: dict[str, Any] = {
        'workspace_id': workspace_id,
        'actor_user_id': acted_by.user_id,
        'actor_api_key_id': acted_by.api_key_id,
        'action': action,
        'target_type': _capped(target_type),
        'target_id': _capped(target_id),
        'request_id': _capped(request_id),
        'ip': _inet(ip),
        'details': _details(details),
    }
    if occurred_at is not None:
        payload['occurred_at'] = occurred_at
    try:
        with database.separate_transaction() as connection:
            connection.execute(insert(AuditEvent).values(**payload))
    except Exception:
        # See point 4 in the module docstring: the request survives, the log keeps the event.
        log.exception('audit.write_failed', action=action, target_type=target_type)


def _capped(value: str | None) -> str | None:
    """Text for a ``text`` column with a ``between 1 and 256`` check: cap it, or use ``NULL``."""
    if value is None:
        return None
    text = value.strip()[:ACTION_CAP]
    return text or None


def _inet(value: str | None) -> str | None:
    """An address for the ``inet`` column, or ``None`` when it is not one."""
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def _details(details: dict[str, Any] | None) -> dict[str, Any]:
    """The redacted ``details`` object; ``{}`` when there is nothing to say."""
    if not details:
        return {}
    redacted = redact(details)
    return redacted if isinstance(redacted, dict) else {}
