"""Login, logout, CSRF, and revoke-all (work package A02; F20 accounts and sessions).

The login handler is the one place in the API where several security properties have to hold at
once, so they are spelled out here:

* **No user enumeration.** An unknown address still costs one argon2id verification
  (:func:`app.auth.passwords.dummy_hash`), and answers with the same string as a wrong password.
  The one deliberate exception is an address whose *password was correct* but whose account is
  deactivated: that caller has proved they own the account, so telling them it is disabled
  discloses nothing they did not already know, and leaving them to guess is unkind.
* **No session fixation.** The session is rotated, not reused: whatever token the browser arrived
  with is revoked and a new one is minted (``security-architecture.md`` section 7).
* **Both cookies, one lifetime.** The session cookie and the readable CSRF cookie are set with
  the same ``max-age``, so a browser never holds one without the other.
* **The failure is recorded before the response is written.** :mod:`app.audit` writes in its own
  transaction, so the ``login.failure`` row survives the rejection that rolls this request back
  (CTQ-16).
* **Rate limited.** ``BB_RATE_LIMIT_LOGIN`` per client address (:mod:`app.core.rate_limit`).

``GET /auth/csrf`` exists for one case: an SPA reload where the readable CSRF cookie is gone but
the session cookie is not. It cannot return the stored token -- only the sha256 is stored -- so it
*rotates* the token: a new one is minted, ``sessions.csrf_token_hash`` is replaced, the cookie is
set, and the value is returned. Two tabs calling it will invalidate each other's token, which is
why the SPA reads the cookie first and calls this only when there is none.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status

from app import audit
from app.auth import passwords
from app.auth import sessions as session_store
from app.auth import users as user_store
from app.auth.cookies import CookiePolicy
from app.auth.rbac import PUBLIC_ROUTE, AnyPrincipal
from app.auth.tokens import digest, mint_token
from app.core.api_models import (
    Acknowledgement,
    CsrfResponse,
    LoginRequest,
    LoginResponse,
    RevokeAllResponse,
)
from app.core.database import Database
from app.core.dependencies import (
    ClientAddress,
    DatabaseDep,
    Now,
    RequestId,
    SessionDep,
    SettingsDep,
)
from app.core.errors import ApiError, ErrorCode
from app.core.logging import get_logger
from app.core.presenters import user_response, workspace_response
from app.core.rate_limit import limiter, login_limit
from app.core.settings import Settings

__all__ = ['router']

router = APIRouter(prefix='/auth', tags=['authentication'])

log = get_logger('app.auth')


@router.post(
    '/login',
    response_model=LoginResponse,
    dependencies=[Depends(PUBLIC_ROUTE)],
    summary='Exchange an email address and password for a session',
    responses={status.HTTP_401_UNAUTHORIZED: {'description': 'Invalid credentials'}},
)
@limiter.limit(login_limit)
def login(
    request: Request,
    response: Response,
    body: LoginRequest,
    session: SessionDep,
    settings: SettingsDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> LoginResponse:
    """Authenticate and start a session."""
    user = user_store.get_user_by_email(session, body.email)
    if user is None:
        # Same work, same answer: an unknown address must not be cheaper than a known one.
        passwords.verify_password(passwords.dummy_hash(), body.password)
        _audit_failure(database, request_id, client, reason='unknown_email')
        raise ApiError(ErrorCode.INVALID_CREDENTIALS, detail=f'no account for {body.email!r}')

    if not passwords.verify_password(user.password_hash, body.password):
        with database.separate_transaction() as connection:
            count = user_store.increment_failed_login(connection, user_id=user.id)
        _audit_failure(
            database,
            request_id,
            client,
            reason='wrong_password',
            user_id=str(user.id),
            failed_login_count=count,
        )
        raise ApiError(ErrorCode.INVALID_CREDENTIALS, detail=f'wrong password for {user.id}')

    if not user.is_active:
        _audit_failure(database, request_id, client, reason='inactive', user_id=str(user.id))
        raise ApiError(ErrorCode.ACCOUNT_DISABLED, detail=f'{user.id} is not active')

    if passwords.needs_rehash(user.password_hash):
        # The password was just proved correct, so this is the only moment it can be re-hashed
        # under the current cost parameters without asking the user for anything.
        user_store.set_password_hash(user, passwords.hash_password(body.password), now=now)
        log.info('auth.password_rehashed', user_id=str(user.id))

    user_store.record_successful_login(user)
    presented = request.cookies.get(CookiePolicy.from_settings(settings).session_name)
    previous = (
        session_store.resolve(session, presented, settings=settings, now=now)
        if presented
        else None
    )
    minted = session_store.rotate(
        session,
        user_id=user.id,
        settings=settings,
        now=now,
        previous=previous,
        user_agent=request.headers.get('user-agent'),
        ip=client,
    )
    _set_cookies(response, settings, minted.token, minted.csrf_token)

    memberships = user_store.list_memberships(session, user.id)
    audit.record(
        database,
        action='login.success',
        actor=audit.Actor(user_id=user.id),
        target_type='session',
        target_id=str(minted.row.id),
        request_id=request_id,
        ip=client,
        details={'rotated': previous is not None, 'workspaces': len(memberships)},
    )
    return LoginResponse(
        user=user_response(user),
        workspaces=[workspace_response(workspace, role) for workspace, role in memberships],
        csrf_token=minted.csrf_token,
        session_expires_at=minted.row.expires_at,
    )


@router.post(
    '/logout',
    response_model=Acknowledgement,
    summary='End the current session and clear its cookies',
)
def logout(
    response: Response,
    principal: AnyPrincipal,
    settings: SettingsDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> Acknowledgement:
    """Revoke this session. Idempotent, and harmless for an API-key caller."""
    if principal.session_row is not None:
        session_store.revoke(principal.session_row, now=now)
        audit.record(
            database,
            action='logout',
            actor=principal.actor,
            target_type='session',
            target_id=str(principal.session_row.id),
            request_id=request_id,
            ip=client,
        )
    CookiePolicy.from_settings(settings).clear(response)
    return Acknowledgement()


@router.post(
    '/sessions/revoke-all',
    response_model=RevokeAllResponse,
    summary='Revoke every session of the current account',
)
def revoke_all(
    response: Response,
    principal: AnyPrincipal,
    session: SessionDep,
    settings: SettingsDep,
    database: DatabaseDep,
    request_id: RequestId,
    client: ClientAddress,
    now: Now,
) -> RevokeAllResponse:
    """Revoke every session of the caller's account, including the one making the request.

    This is the control a user reaches for when they think a device is compromised, so it takes
    effect immediately and everywhere, and it does not spare the caller.
    """
    revoked = session_store.revoke_all(session, user_id=principal.user_id, now=now)
    audit.record(
        database,
        action='session.revoke_all',
        actor=principal.actor,
        target_type='user',
        target_id=str(principal.user_id),
        request_id=request_id,
        ip=client,
        details={'revoked_sessions': revoked},
    )
    CookiePolicy.from_settings(settings).clear(response)
    return RevokeAllResponse(revoked_sessions=revoked)


@router.get(
    '/csrf',
    response_model=CsrfResponse,
    summary='Mint a fresh CSRF token for the current session',
)
def csrf(
    response: Response,
    principal: AnyPrincipal,
    settings: SettingsDep,
) -> CsrfResponse:
    """Rotate this session's CSRF token, set the readable cookie, and return the token."""
    if principal.session_row is None:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            detail='an API-key request needs no CSRF token',
            reason='API-key requests do not use a CSRF token.',
        )
    token = mint_token()
    principal.session_row.csrf_token_hash = digest(token)
    CookiePolicy.from_settings(settings).set_csrf(
        response,
        token,
        max_age_seconds=settings.session_absolute_hours * 3600,
    )
    return CsrfResponse(csrf_token=token)


def _set_cookies(response: Response, settings: Settings, token: str, csrf_token: str) -> None:
    """Set both cookies with one lifetime, so neither can outlive the other."""
    policy = CookiePolicy.from_settings(settings)
    max_age = settings.session_absolute_hours * 3600
    policy.set_session(response, token, max_age_seconds=max_age)
    policy.set_csrf(response, csrf_token, max_age_seconds=max_age)


def _audit_failure(
    database: Database,
    request_id: str,
    client: str | None,
    *,
    reason: str,
    user_id: str | None = None,
    failed_login_count: int | None = None,
) -> None:
    """Write ``login.failure``. The password is not among the arguments, so it cannot be logged."""
    details: dict[str, object] = {'reason': reason}
    if failed_login_count is not None:
        details['failed_login_count'] = failed_login_count
    audit.record(
        database,
        action='login.failure',
        target_type='user' if user_id else None,
        target_id=user_id,
        request_id=request_id,
        ip=client,
        details=details,
    )
