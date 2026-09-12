"""Rate limits on the two routes that mint credentials (work package A02).

``security-architecture.md`` section 3 asks for slowapi limits on login; ADR-0005 decision 7 adds
API-key creation. Both are the same shape of risk: a route that turns guesses or requests into
credentials.

The limit is keyed by client address, taken from ``X-Forwarded-For`` only when the request came
from a trusted proxy (:mod:`app.core.logging` resolved that) and from the socket peer otherwise. A
key derived from a header any client can set would let an attacker rotate their way out of the
limit with a header, which is worse than no limit because it looks like one.

Two structural notes.

**The limiter is a module-level singleton, configured by :func:`configure`.** slowapi's decorator
binds to the limiter object at import time, so a per-application instance would mean building the
routers inside the application factory. A singleton is not a compromise here: the storage is
in-process anyway, so a limit is per process by construction, and one process runs one API. The
limit *values* still come from settings, through the callables :func:`login_limit` and
:func:`api_key_limit`, which slowapi evaluates per request.

**Storage is in-process.** Honest for the deployment this MVP targets: one API container
(``deployment-architecture.md`` section 1). If the API is ever scaled out, each instance gets its
own window and a shared backend is needed; the note is here so that is a decision rather than a
surprise.

The limit is a brake, not the control. Every failed login is audited (CTQ-16) and
``users.failed_login_count`` is incremented, so an attack that stays under the limit is still
visible. A 429 tells the client the same fixed string as every other failure
(:mod:`app.core.errors`).
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.requests import Request
from starlette.responses import Response

from app.core.errors import ApiError, ErrorCode, error_response
from app.core.settings import Settings

__all__ = [
    'api_key_limit',
    'client_key',
    'configure',
    'limiter',
    'login_limit',
    'rate_limit_handler',
]


def client_key(request: Request) -> str:
    """The rate-limit key: the caller's address, or ``'unknown'`` for a client without one."""
    state = request.scope.get('state')
    address = state.get('client_address') if isinstance(state, dict) else None
    if isinstance(address, str) and address:
        return address
    client = request.client
    return client.host if client is not None else 'unknown'


#: The process's limiter. :func:`configure` gives it the settings' values.
limiter = Limiter(key_func=client_key, default_limits=[], headers_enabled=True)

#: Current rule strings. Replaced wholesale by :func:`configure`; read per request by the two
#: provider functions below, which is how a setting reaches a decorator applied at import time.
_RULES: dict[str, str] = {'login': '10/minute', 'api_key': '20/hour'}


def configure(settings: Settings) -> None:
    """Apply ``settings`` to the process limiter, and clear any window from a previous run."""
    _RULES['login'] = settings.rate_limit_login
    _RULES['api_key'] = settings.rate_limit_api_key
    limiter.enabled = settings.rate_limit_enabled
    limiter.reset()


def login_limit() -> str:
    """``BB_RATE_LIMIT_LOGIN``, evaluated per request."""
    return _RULES['login']


def api_key_limit() -> str:
    """``BB_RATE_LIMIT_API_KEY``, evaluated per request."""
    return _RULES['api_key']


def rate_limit_handler(request: Request, exception: Exception) -> Response:
    """Render slowapi's own exception through the API's error envelope."""
    retry_after: str | None = None
    if isinstance(exception, RateLimitExceeded) and exception.limit is not None:
        retry_after = str(int(exception.limit.limit.get_expiry()))
    headers = {'retry-after': retry_after} if retry_after else None
    return error_response(
        request,
        ApiError(ErrorCode.RATE_LIMITED, detail=str(exception), headers=headers),
    )
