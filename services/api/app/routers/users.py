"""``/users/me`` (work package A02).

One route, and deliberately only one. The SPA needs three things after a reload -- who am I, which
workspaces may I open and with what role, and what does the password policy require -- and this
returns exactly those. It declares ``authenticated`` rather than a workspace role because a user
who belongs to no workspace yet must still be able to see themselves; see :mod:`app.auth.rbac`.

There is no route here that lists or searches accounts. A02 creates no account except the first
owner (``python -m app.bootstrap``), so a directory would be an enumeration surface with nothing
to enumerate. An invitation flow, account deactivation, and password change belong with the
``user.*`` audit actions that ``data-model.md`` 3.15 does not yet define; they are recorded as
open questions in ``docs/features/F20-auth-and-workspaces.md``.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.auth import users as user_store
from app.auth.rbac import AnyPrincipal
from app.core.api_models import MeResponse, PasswordSpecification
from app.core.dependencies import SessionDep
from app.core.errors import ApiError, ErrorCode
from app.core.presenters import user_response, workspace_response

__all__ = ['router']

router = APIRouter(prefix='/users', tags=['users'])


@router.get('/me', response_model=MeResponse, summary='The current principal and its workspaces')
def me(principal: AnyPrincipal, session: SessionDep) -> MeResponse:
    """Who is calling, where they may go, and the password rules."""
    user = user_store.get_user(session, principal.user_id)
    if user is None:
        # The principal resolved a moment ago, so this means the account was deleted between the
        # dependency and here. Answering 404 is more honest than serving a half-empty object.
        raise ApiError(ErrorCode.NOT_FOUND, detail=f'account {principal.user_id} disappeared')
    memberships = user_store.list_memberships(session, user.id)
    if principal.api_key_workspace_id is not None:
        # A key acts in one workspace with one role, so that is what it may see -- not the
        # owner's other memberships.
        memberships = [
            (workspace, principal.api_key_role or role)
            for workspace, role in memberships
            if workspace.id == principal.api_key_workspace_id
        ]
    return MeResponse(
        user=user_response(user),
        workspaces=[workspace_response(workspace, role) for workspace, role in memberships],
        credential='api_key' if principal.api_key_id is not None else 'session',
        password_policy=PasswordSpecification(),
    )
