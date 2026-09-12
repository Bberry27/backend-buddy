"""CSRF: double submit bound to the session, plus an origin check (work package A02).

Frozen contract (``security-architecture.md`` section 7): *CSRF double-submit token bound to the
session (``sessions.csrf_token_hash``), required on every state-changing request; API-key requests
are exempt because they carry no cookie.*

Two checks run, in this order, on every state-changing request that authenticated with a cookie:

1. **Origin.** When the request carries an ``Origin`` (every browser sends one on a
   cross-origin request and on any non-``GET``), it must equal this deployment's origin. This is
   the check that costs an attacker their whole class of attack, because a page on another origin
   cannot suppress or forge the header. A request without ``Origin`` is not rejected on that
   basis alone -- non-browser clients exist, and step 2 still has to pass.
2. **Token.** The ``X-CSRF-Token`` header must hash to ``sessions.csrf_token_hash``. Bound to the
   session, so a token from another session, or one minted before a rotation, does not work; and
   it lives in a readable cookie, so the SPA can echo it without the server keeping any
   per-form state.

``SameSite=Strict`` on the session cookie already prevents most of what this defends against.
Both are here because they fail differently: ``SameSite`` is a browser promise about when to send
a cookie, and the token is a server-side check that the caller could read a value from this
origin. A browser that mishandles the first still fails the second.

The exemption is narrow and explicit: a request authenticated by ``Authorization: Bearer`` carries
no ambient credential, so there is nothing for another site to ride on, and requiring a token
would only mean every API-key client had to fetch one first.
"""

from __future__ import annotations

from typing import Final

from starlette.requests import Request

from app.auth import tokens
from app.core.errors import ApiError, ErrorCode
from app.core.settings import Settings
from app.models import Session

__all__ = ['CSRF_HEADER', 'SAFE_METHODS', 'expected_origin', 'require_csrf']

#: The header the SPA echoes the readable CSRF cookie in.
CSRF_HEADER: Final = 'x-csrf-token'

#: Methods that change nothing and therefore need no token (RFC 9110 safe methods).
SAFE_METHODS: Final = frozenset({'GET', 'HEAD', 'OPTIONS', 'TRACE'})


def expected_origin(request: Request, settings: Settings) -> str | None:
    """The origin this deployment answers on, or ``None`` when it cannot be determined.

    ``BB_PUBLIC_ORIGIN`` is authoritative when set, because behind a proxy the request's own
    ``Host`` is whatever the proxy passed on. Without it -- a dev run reached directly -- the
    request's scheme and host are used, with the forwarded scheme honoured only from a trusted
    proxy (:mod:`app.core.logging` resolved that already).
    """
    if settings.public_origin:
        return settings.public_origin
    host = request.headers.get('host')
    if not host:
        return None
    state = request.scope.get('state')
    proto = state.get('forwarded_proto') if isinstance(state, dict) else None
    scheme = proto if isinstance(proto, str) and proto in {'http', 'https'} else request.url.scheme
    return f'{scheme}://{host}'


def require_csrf(request: Request, session_row: Session, settings: Settings) -> None:
    """Raise :class:`app.core.errors.ApiError` unless the request passes both CSRF checks.

    Safe methods return immediately.
    """
    if request.method.upper() in SAFE_METHODS:
        return

    origin = request.headers.get('origin')
    if origin:
        allowed = expected_origin(request, settings)
        if allowed is None or origin.rstrip('/') != allowed.rstrip('/'):
            raise ApiError(
                ErrorCode.CSRF_REQUIRED,
                detail=f'origin {origin!r} does not match {allowed!r}',
            )

    presented = request.headers.get(CSRF_HEADER, '')
    if not presented:
        raise ApiError(
            ErrorCode.CSRF_REQUIRED,
            detail=f'no {CSRF_HEADER} header on a state-changing cookie request',
        )
    if not tokens.matches(session_row.csrf_token_hash, presented):
        raise ApiError(
            ErrorCode.CSRF_REQUIRED,
            detail='the presented CSRF token does not belong to this session',
        )
