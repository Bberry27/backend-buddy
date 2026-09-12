"""Workspaces and their members (work packages A02, F16 skeleton for A04).

Five routes, and three rules that hold across them.

**Nobody may grant a role above their own.** An admin manages members "below owner"
(``security-architecture.md`` section 2), so an admin can neither create an owner nor change an
owner's role. Without this, "admin" and "owner" are the same role with different names, because
an admin could promote themselves.

**A workspace always keeps an owner.** :func:`app.repositories.members.set_member_role` refuses
the change that would remove the last one, and this router turns that refusal into 409. A
workspace with no owner cannot grant a role again, so the operation would be irreversible through
the API.

**A role change revokes the affected user's sessions**, and rotates the caller's own if the
caller is the affected user (ADR-0005 decision 2). The role itself is read from
``workspace_members`` on every request, so this is not what makes the new role take effect; it is
what makes the *old* session unable to keep acting under a decision that has been reversed --
including the case where the demotion is a response to a compromise.

``POST /workspaces`` declares ``authenticated`` rather than a workspace role, because the caller
is creating the workspace they will own. The creator becomes its owner in the same transaction:
a workspace with no members would be unreachable and undeletable.
"""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, status
from sqlalchemy.orm import Session as OrmSession
from starlette.responses import Response

from app import audit
from app.auth import sessions as session_store
from app.auth import users as user_store
from app.auth.cookies import CookiePolicy
from app.auth.principals import Principal
from app.auth.rbac import (
    ROLE_LADDER,
    AdminPrincipal,
    AnyPrincipal,
    ViewerPrincipal,
    role_in_workspace,
)
from app.core.api_models import (
    MemberAddRequest,
    MemberResponse,
    MemberRoleRequest,
    WorkspaceCreateRequest,
    WorkspaceResponse,
)
from app.core.dependencies import (
    ClientAddress,
    DatabaseDep,
    Now,
    RequestId,
    SessionDep,
    SettingsDep,
)
from app.core.errors import ApiError, ErrorCode
from app.core.presenters import member_response, workspace_response
from app.core.settings import Settings
from app.repositories import members as member_repository
from app.repositories import workspaces as workspace_repository

__all__ = ['router']

router = APIRouter(prefix='/workspaces', tags=['workspaces'])

_RANK = {role: index for index, role in enumerate(ROLE_LADDER)}


@router.get('', response_model=list[WorkspaceResponse], summary='Workspaces the caller may open')
def list_workspaces(principal: AnyPrincipal, session: SessionDep) -> list[WorkspaceResponse]:
    """Every workspace the caller is a member of, with the role held in each.

    An API key sees only the workspace recorded on it, at the role recorded on it.
    """
    memberships = user_store.list_memberships(session, principal.user_id)
    if principal.api_key_workspace_id is not None:
        memberships = [
            (workspace, principal.api_key_role or role)
            for workspace, role in memberships
            if workspace.id == principal.api_key_workspace_id
        ]
    return [workspace_response(workspace, role) for workspace, role in memberships]


@router.post(
    '',
    response_model=WorkspaceResponse,
    status_code=status.HTTP_201_CREATED,
    summary='Create a workspace and become its owner',
    responses={status.HTTP_409_CONFLICT: {'description': 'The slug is already in use'}},
)
def create_workspace(
    body: WorkspaceCreateRequest,
    principal: AnyPrincipal,
    session: SessionDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
) -> WorkspaceResponse:
    """Create a workspace with the caller as its owner."""
    if workspace_repository.workspace_slug_taken(session, workspace_id=None, slug=body.slug):
        raise ApiError(
            ErrorCode.CONFLICT,
            detail=f'slug {body.slug!r} is taken',
            reason='That workspace address is already in use.',
        )
    workspace_id = uuid.uuid4()
    workspace = workspace_repository.create_workspace(
        session,
        workspace_id=workspace_id,
        slug=body.slug,
        name=body.name,
    )
    member_repository.add_member(
        session,
        workspace_id=workspace_id,
        user_id=principal.user_id,
        role='owner',
    )
    audit.record(
        database,
        action='workspace.create',
        actor=principal.actor,
        workspace_id=workspace_id,
        target_type='workspace',
        target_id=str(workspace_id),
        request_id=request_id,
        ip=client,
        details={'slug': body.slug},
    )
    return workspace_response(workspace, 'owner')


@router.get(
    '/{workspace_id}',
    response_model=WorkspaceResponse,
    summary='One workspace',
    responses={status.HTTP_404_NOT_FOUND: {'description': 'No such workspace for this caller'}},
)
def get_workspace(
    workspace_id: uuid.UUID,
    principal: ViewerPrincipal,
    session: SessionDep,
) -> WorkspaceResponse:
    """The workspace, with the caller's role. A workspace they cannot see answers 404."""
    workspace = workspace_repository.get_workspace(session, workspace_id=workspace_id)
    if workspace is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'workspace {workspace_id} is absent')
    return workspace_response(workspace, role_in_workspace(session, principal, workspace_id))


@router.get(
    '/{workspace_id}/members',
    response_model=list[MemberResponse],
    summary='Members of a workspace and their roles',
)
def list_members(
    workspace_id: uuid.UUID,
    principal: ViewerPrincipal,
    session: SessionDep,
) -> list[MemberResponse]:
    """Every membership of the workspace. Readable by any member: roles are not a secret."""
    return [
        member_response(member, user)
        for member, user in member_repository.list_members(session, workspace_id=workspace_id)
    ]


@router.post(
    '/{workspace_id}/members',
    response_model=MemberResponse,
    status_code=status.HTTP_201_CREATED,
    summary='Grant an existing account a role in this workspace',
    responses={
        status.HTTP_404_NOT_FOUND: {'description': 'No such account'},
        status.HTTP_409_CONFLICT: {'description': 'The account is already a member'},
    },
)
def add_member(
    workspace_id: uuid.UUID,
    body: MemberAddRequest,
    principal: AdminPrincipal,
    session: SessionDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> MemberResponse:
    """Add a member.

    The account must already exist: A02 creates none beyond the first owner, and an unknown
    address answers 404 -- which also means this route cannot be used to discover whether an
    address has an account here.
    """
    _require_grantable(session, principal, workspace_id, body.role)
    user = user_store.get_user_by_email(session, body.email)
    if user is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'no account for {body.email!r}')
    existing = member_repository.get_member(session, workspace_id=workspace_id, user_id=user.id)
    if existing is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            detail=f'{user.id} is already a member of {workspace_id}',
            reason='That account is already a member.',
        )
    member = member_repository.add_member(
        session,
        workspace_id=workspace_id,
        user_id=user.id,
        role=body.role,
    )
    # Modelled as a role change from "none": data-model.md 3.15 has member.role_change and no
    # separate member.add, and the change this records is exactly which role the user now holds.
    audit.record(
        database,
        action='member.role_change',
        actor=principal.actor,
        workspace_id=workspace_id,
        target_type='user',
        target_id=str(user.id),
        request_id=request_id,
        ip=client,
        details={'from': None, 'to': body.role},
    )
    session_store.revoke_all(session, user_id=user.id, now=now)
    return member_response(member, user)


@router.put(
    '/{workspace_id}/members/{user_id}',
    response_model=MemberResponse,
    summary='Change a member role (rotates that member sessions)',
    responses={
        status.HTTP_404_NOT_FOUND: {'description': 'No such member'},
        status.HTTP_409_CONFLICT: {'description': 'The change would leave no owner'},
    },
)
def set_member_role(
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    body: MemberRoleRequest,
    principal: AdminPrincipal,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> MemberResponse:
    """Change one member's role, then rotate that member's sessions."""
    target = member_repository.get_member(session, workspace_id=workspace_id, user_id=user_id)
    if target is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'{user_id} is not a member of {workspace_id}')
    # Both the role being granted and the role being taken away are capped at the caller's own:
    # demoting an owner is an owner's decision.
    _require_grantable(session, principal, workspace_id, body.role)
    _require_grantable(session, principal, workspace_id, target.role)
    previous = target.role
    try:
        member = member_repository.set_member_role(
            session,
            workspace_id=workspace_id,
            user_id=user_id,
            role=body.role,
            now=now,
        )
    except ValueError as error:
        raise ApiError(
            ErrorCode.CONFLICT,
            detail=str(error),
            reason='A workspace must keep at least one owner.',
        ) from None
    if member is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'{user_id} vanished from {workspace_id}')
    user = user_store.get_user(session, user_id)
    if user is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'account {user_id} disappeared')

    audit.record(
        database,
        action='member.role_change',
        actor=principal.actor,
        workspace_id=workspace_id,
        target_type='user',
        target_id=str(user_id),
        request_id=request_id,
        ip=client,
        details={'from': previous, 'to': body.role},
    )
    _rotate_after_role_change(
        session,
        principal=principal,
        target_user_id=user_id,
        response=response,
        settings=settings,
        client=client,
        now=now,
    )
    return member_response(member, user)


def _require_grantable(
    session: OrmSession,
    principal: Principal,
    workspace_id: uuid.UUID,
    role: str,
) -> None:
    """Refuse a role at or above the caller's own position on the ladder."""
    own = role_in_workspace(session, principal, workspace_id)
    if own is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail='the caller has no role in this workspace')
    if _RANK[role] > _RANK[own]:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            detail=f'{own} may not grant or change {role}',
            reason='You cannot grant a role above your own.',
        )


def _rotate_after_role_change(
    session: OrmSession,
    *,
    principal: Principal,
    target_user_id: uuid.UUID,
    response: Response,
    settings: Settings,
    client: str | None,
    now: dt.datetime,
) -> None:
    """Revoke the affected member's sessions; rotate the caller's own if they are that member."""
    session_store.revoke_all(session, user_id=target_user_id, now=now)
    if principal.user_id != target_user_id or principal.session_row is None:
        return
    minted = session_store.create(
        session,
        user_id=target_user_id,
        settings=settings,
        now=now,
        user_agent=principal.session_row.user_agent,
        ip=client,
    )
    policy = CookiePolicy.from_settings(settings)
    max_age = settings.session_absolute_hours * 3600
    policy.set_session(response, minted.token, max_age_seconds=max_age)
    policy.set_csrf(response, minted.csrf_token, max_age_seconds=max_age)
