"""API-key rows (work package A02; ``data-model.md`` 3.5).

Workspace-scoped, so every helper takes ``workspace_id`` and a key from another workspace reads
as absent -- the 404 the IDOR negatives require rather than a 403 that would confirm the id.

The secret itself never appears here: :func:`app.auth.tokens.mint_api_key` produced it, the
creation response showed it once, and this module stores only ``key_prefix`` (an identifier) and
``key_hash`` (a digest). Authentication by digest is :mod:`app.auth.api_keys`, because that lookup
does not yet know a workspace.

Revocation is a timestamp, never a delete: ``api_keys`` rows are audit references
(``data-model.md`` section 5) and a deleted row would leave ``api_key.revoke`` pointing at
nothing.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.auth.tokens import ApiKeyMaterial
from app.models import ApiKey
from app.models.base import NAME_CAP

__all__ = ['create_api_key', 'get_api_key', 'list_api_keys', 'revoke_api_key']


def create_api_key(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    name: str,
    role: str,
    material: ApiKeyMaterial,
    expires_at: dt.datetime | None = None,
) -> ApiKey:
    """Insert a key for ``user_id`` in ``workspace_id`` with the role the caller may grant."""
    row = ApiKey(
        workspace_id=workspace_id,
        user_id=user_id,
        name=name[:NAME_CAP],
        key_prefix=material.key_prefix,
        key_hash=material.key_hash,
        role=role,
        expires_at=expires_at,
    )
    session.add(row)
    session.flush()
    return row


def get_api_key(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    api_key_id: uuid.UUID,
) -> ApiKey | None:
    """The key with ``api_key_id`` **in** ``workspace_id``, or ``None``."""
    return session.scalars(
        select(ApiKey).where(ApiKey.id == api_key_id, ApiKey.workspace_id == workspace_id)
    ).one_or_none()


def list_api_keys(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID | None = None,
) -> list[ApiKey]:
    """Keys in ``workspace_id``, newest first; restricted to ``user_id`` when given."""
    statement = select(ApiKey).where(ApiKey.workspace_id == workspace_id)
    if user_id is not None:
        statement = statement.where(ApiKey.user_id == user_id)
    return list(session.scalars(statement.order_by(ApiKey.created_at.desc())))


def revoke_api_key(
    session: OrmSession,
    *,
    workspace_id: uuid.UUID,
    api_key_id: uuid.UUID,
    now: dt.datetime,
) -> ApiKey | None:
    """Revoke a key and return it, or ``None`` when it is not in this workspace.

    Idempotent: an already revoked key keeps its first ``revoked_at``, so the audit trail records
    when it actually stopped working.
    """
    row = get_api_key(session, workspace_id=workspace_id, api_key_id=api_key_id)
    if row is None:
        return None
    if row.revoked_at is None:
        row.revoked_at = now
        session.flush()
    return row
