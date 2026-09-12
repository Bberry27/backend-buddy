"""API keys (work package A02; ``data-model.md`` 3.5; ADR-0005 decision 4).

Keys are workspace-scoped, so they live under ``/workspaces/{workspace_id}/api-keys`` and every
query passes through :mod:`app.repositories.api_keys` with that id. Administration of credentials
is an admin act, so all three routes declare ``admin``.

Four properties:

* **Shown once.** The plaintext exists in exactly one response, at creation
  (``ApiKeyCreated.apiKey``). Only ``key_prefix`` and the sha256 are stored, so nothing -- not
  this API, not a database dump, not the operator -- can produce it again. The UI says so.
* **Role-capped at the creator's.** A key may not exceed the role of the account creating it,
  because a key is a way to act, and no principal may create a way to act that they do not have.
* **Revocable, and expiring if asked.** ``revoked_at`` is set, never deleted: the row stays as the
  audit reference for ``api_key.revoke``.
* **Rate limited.** ``BB_RATE_LIMIT_API_KEY`` per client address: key creation is an occasional
  administrative act, and each key is a long-lived credential. The handler takes a ``Response``
  parameter for slowapi's sake; see the comment on the signature.

The keys listed are the whole workspace's, not only the caller's. An admin who cannot see the
keys that can act in their workspace cannot audit them, and the listing carries no secret.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, Response, status
from sqlalchemy.orm import Session as OrmSession

from app import audit
from app.auth.principals import Principal
from app.auth.rbac import ROLE_LADDER, AdminPrincipal, role_in_workspace
from app.auth.tokens import mint_api_key
from app.core.api_models import ApiKeyCreated, ApiKeyCreateRequest, ApiKeyResponse
from app.core.dependencies import (
    ClientAddress,
    DatabaseDep,
    Now,
    RequestId,
    SessionDep,
)
from app.core.errors import ApiError, ErrorCode
from app.core.presenters import api_key_response
from app.core.rate_limit import api_key_limit, limiter
from app.repositories import api_keys as api_key_repository

__all__ = ['router']

router = APIRouter(prefix='/workspaces/{workspace_id}/api-keys', tags=['api-keys'])

_RANK = {role: index for index, role in enumerate(ROLE_LADDER)}


@router.get('', response_model=list[ApiKeyResponse], summary='API keys of this workspace')
def list_api_keys(
    workspace_id: uuid.UUID,
    principal: AdminPrincipal,
    session: SessionDep,
) -> list[ApiKeyResponse]:
    """Every key that can act in this workspace, newest first. No secret is included."""
    return [
        api_key_response(key)
        for key in api_key_repository.list_api_keys(session, workspace_id=workspace_id)
    ]


@router.post(
    '',
    response_model=ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
    summary='Create an API key and return its secret once',
)
@limiter.limit(api_key_limit)
def create_api_key(
    request: Request,
    # ``response`` is required by slowapi, not by this handler: with ``headers_enabled`` it writes
    # the rate-limit headers into the endpoint's own response object and raises if there is none.
    # A rate-limited route without both parameters answers 500 on the *success* path, which is why
    # ``test_A02_a_rate_limited_route_succeeds_with_headers`` exercises it with the limiter on.
    response: Response,
    workspace_id: uuid.UUID,
    body: ApiKeyCreateRequest,
    principal: AdminPrincipal,
    session: SessionDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> ApiKeyCreated:
    """Mint a key for the calling account, at or below the caller's own role."""
    _require_grantable(session, principal, workspace_id, body.role)
    if body.expires_at is not None and body.expires_at <= now:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            detail=f'expires_at {body.expires_at.isoformat()} is in the past',
            reason='The expiry must be in the future.',
        )
    material = mint_api_key()
    key = api_key_repository.create_api_key(
        session,
        workspace_id=workspace_id,
        user_id=principal.user_id,
        name=body.name,
        role=body.role,
        material=material,
        expires_at=body.expires_at,
    )
    audit.record(
        database,
        action='api_key.create',
        actor=principal.actor,
        workspace_id=workspace_id,
        target_type='api_key',
        target_id=str(key.id),
        request_id=request_id,
        ip=client,
        details={
            'key_prefix': material.key_prefix,
            'role': body.role,
            'expires_at': body.expires_at.isoformat() if body.expires_at else None,
        },
    )
    return ApiKeyCreated(key=api_key_response(key), api_key=material.token)


@router.delete(
    '/{api_key_id}',
    response_model=ApiKeyResponse,
    summary='Revoke an API key',
    responses={status.HTTP_404_NOT_FOUND: {'description': 'No such key in this workspace'}},
)
def revoke_api_key(
    workspace_id: uuid.UUID,
    api_key_id: uuid.UUID,
    principal: AdminPrincipal,
    session: SessionDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> ApiKeyResponse:
    """Revoke a key. Idempotent; a key from another workspace answers 404."""
    key = api_key_repository.revoke_api_key(
        session,
        workspace_id=workspace_id,
        api_key_id=api_key_id,
        now=now,
    )
    if key is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'{api_key_id} is not in {workspace_id}')
    audit.record(
        database,
        action='api_key.revoke',
        actor=principal.actor,
        workspace_id=workspace_id,
        target_type='api_key',
        target_id=str(key.id),
        request_id=request_id,
        ip=client,
        details={'key_prefix': key.key_prefix},
    )
    return api_key_response(key)


def _require_grantable(
    session: OrmSession,
    principal: Principal,
    workspace_id: uuid.UUID,
    role: str,
) -> None:
    """Refuse a key whose role would exceed the caller's own."""
    own = role_in_workspace(session, principal, workspace_id)
    if own is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail='the caller has no role in this workspace')
    if _RANK[role] > _RANK[own]:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            detail=f'{own} may not create a {role} key',
            reason='A key cannot hold a role above your own.',
        )
