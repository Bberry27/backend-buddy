"""Authentication by API key (work package A02; ADR-0005 decision 4).

Only the *authentication* half lives here, because looking a key up by its digest is a
deployment-level query: the request has not yet said which workspace it is for, and the answer is
what tells it. Creating, listing and revoking keys are workspace-scoped and live in
:mod:`app.repositories.api_keys`.

A key is usable when its digest matches a row that is neither revoked nor past ``expires_at``, and
whose owning account is still active. It then acts with the role recorded on the row, in the
workspace recorded on the row, and nowhere else -- a key is never widened by its owner's other
memberships, which is what makes it safe to hand to a script.

``last_used_at`` is updated on every successful authentication. It is the only thing that lets an
owner answer "is this key still in use before I revoke it".
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.auth import tokens
from app.models import ApiKey, User

__all__ = ['authenticate']


def authenticate(
    session: OrmSession,
    presented: str,
    *,
    now: dt.datetime,
) -> tuple[ApiKey, User] | None:
    """The key and its owner for a presented ``Authorization: Bearer`` value, or ``None``.

    ``None`` for every failure -- not ours, unknown, revoked, expired, owner deactivated -- so the
    caller has one branch and the client one answer.
    """
    secret = tokens.split_api_key(presented)
    if secret is None:
        return None
    row = session.scalars(
        select(ApiKey).where(ApiKey.key_hash == tokens.digest(secret))
    ).one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    if row.expires_at is not None and row.expires_at <= now:
        return None
    owner = session.get(User, row.user_id)
    if owner is None or not owner.is_active:
        return None
    row.last_used_at = now
    return row, owner
