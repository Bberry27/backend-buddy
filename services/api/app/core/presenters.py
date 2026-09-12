"""Model row to response model (work package A02).

One place, so no router can accidentally return a column that the response model happens to
tolerate. Each function names every field it copies; nothing is passed through by ``**row``, which
is how ``password_hash`` ends up in a response in every codebase where it has ever happened.
"""

from __future__ import annotations

from app.core.api_models import (
    ApiKeyResponse,
    MemberResponse,
    Role,
    UserResponse,
    WorkspaceResponse,
)
from app.models import ApiKey, User, Workspace, WorkspaceMember

__all__ = ['api_key_response', 'member_response', 'user_response', 'workspace_response']


def user_response(user: User) -> UserResponse:
    """An account. Without ``password_hash``, ``password_changed_at`` or the failure counter."""
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_active=user.is_active,
        created_at=user.created_at,
    )


def workspace_response(workspace: Workspace, role: str | None = None) -> WorkspaceResponse:
    """A workspace, with the caller's role in it when there is one."""
    return WorkspaceResponse(
        id=workspace.id,
        slug=workspace.slug,
        name=workspace.name,
        role=_role(role),
        created_at=workspace.created_at,
    )


def member_response(member: WorkspaceMember, user: User) -> MemberResponse:
    """One membership, joined with the account it belongs to."""
    return MemberResponse(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=_role(member.role) or 'viewer',
        created_at=member.created_at,
        updated_at=member.updated_at,
    )


def api_key_response(key: ApiKey) -> ApiKeyResponse:
    """An API key's metadata. ``key_hash`` is not a field of the response model at all."""
    return ApiKeyResponse(
        id=key.id,
        name=key.name,
        key_prefix=key.key_prefix,
        role=_role(key.role) or 'viewer',
        user_id=key.user_id,
        created_at=key.created_at,
        expires_at=key.expires_at,
        revoked_at=key.revoked_at,
        last_used_at=key.last_used_at,
    )


#: The stored role values, as the response type. The database's check constraint already limits
#: the column to these four, so the lookup is a type narrowing rather than a validation; a value
#: outside it would be a schema change that got past a migration review, and reading it as
#: ``None`` is the safe direction.
_ROLES: dict[str, Role] = {
    'viewer': 'viewer',
    'reviewer': 'reviewer',
    'admin': 'admin',
    'owner': 'owner',
}


def _role(role: str | None) -> Role | None:
    """Narrow a stored role to the response type."""
    return _ROLES.get(role) if role is not None else None
