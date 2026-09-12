"""Security headers and the two Content Security Policies (work package A02; RK-04).

``docs/architecture/security-architecture.md`` section 6.2 fixes the strict policy for the served
SPA. :data:`SPA_CSP` reproduces it **byte for byte**, and ``test_A02_security_headers`` compares
it against the document rather than against a copy of itself, so the two cannot drift. The policy
is not loosened to make a library work: the library is isolated or replaced (section 6.2, and the
W01 CSP end-to-end test is the arbiter).

Two policies, chosen by content type:

* an HTML response is the SPA shell, and gets :data:`SPA_CSP`;
* everything else is an API response -- JSON, an export stream, a 404 -- and gets
  :data:`API_CSP`, which is stricter still: an API response has no legitimate reason to load or
  execute anything at all.

The remaining headers are the ones section 6.2 lists for A02: ``X-Content-Type-Options``,
``Referrer-Policy``, a minimal ``Permissions-Policy``, ``Cross-Origin-Opener-Policy``, and HSTS
when ``BB_PUBLIC_ORIGIN`` is HTTPS. ``Cache-Control: no-store`` is added to API responses
because a session-bearing JSON response must not be written to a shared cache; the SPA's own
caching is set per file by :mod:`app.static`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Final

from starlette.requests import Request

from app.auth.csrf import SAFE_METHODS, expected_origin
from app.core.errors import ApiError, ErrorCode, error_response
from app.core.settings import Settings

__all__ = [
    'API_CSP',
    'HSTS',
    'PERMISSIONS_POLICY',
    'SPA_CSP',
    'OriginGuardMiddleware',
    'SecurityHeadersMiddleware',
    'security_headers',
]

#: The strict SPA policy from ``security-architecture.md`` section 6.2, byte for byte.
SPA_CSP: Final = (
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
    "form-action 'self'; object-src 'none'; upgrade-insecure-requests"
)

#: The API policy: an API response loads nothing, frames nothing, and is framed by nothing.
API_CSP: Final = (
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

#: Minimal permissions policy: every powerful feature is denied to every origin.
PERMISSIONS_POLICY: Final = (
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), '
    'fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), '
    'payment=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()'
)

#: One year, subdomains included. Emitted only when the public origin is HTTPS, because a browser
#: that receives it over plain HTTP ignores it and an operator who sees it may believe TLS is on.
HSTS: Final = 'max-age=31536000; includeSubDomains'


def security_headers(settings: Settings, *, html: bool) -> list[tuple[bytes, bytes]]:
    """The header list to append to a response.

    ``html`` selects the SPA policy over the API policy.
    """
    headers: list[tuple[str, str]] = [
        ('content-security-policy', SPA_CSP if html else API_CSP),
        ('x-content-type-options', 'nosniff'),
        ('referrer-policy', 'no-referrer'),
        ('permissions-policy', PERMISSIONS_POLICY),
        ('cross-origin-opener-policy', 'same-origin'),
    ]
    if settings.origin_is_https:
        headers.append(('strict-transport-security', HSTS))
    if not html:
        headers.append(('cache-control', 'no-store'))
    return [(name.encode('latin-1'), value.encode('latin-1')) for name, value in headers]


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware appending :func:`security_headers` to every response.

    A header the application already set wins, so :mod:`app.static` can give a hashed asset its
    own ``Cache-Control`` without this middleware overwriting it.
    """

    def __init__(self, app: Callable[..., Awaitable[None]], settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            if message['type'] != 'http.response.start':
                await send(message)
                return
            raw = list(message.get('headers', []))
            present = {name.lower() for name, _ in raw}
            content_type = next(
                (value.decode('latin-1') for name, value in raw if name.lower() == b'content-type'),
                '',
            )
            html = content_type.split(';')[0].strip().lower() == 'text/html'
            raw.extend(
                (name, value)
                for name, value in security_headers(self.settings, html=html)
                if name not in present
            )
            await send({**message, 'headers': raw})

        await self.app(scope, receive, send_wrapper)


class OriginGuardMiddleware:
    """Reject a state-changing request that comes from another origin.

    Middleware rather than a dependency, for a reason worth stating: a dependency has to be added
    to each router, and the one that gets forgotten is the hole. This runs before any route is
    matched, so it also covers ``POST /auth/login``, which has no session yet and therefore cannot
    be protected by the double-submit token (:mod:`app.auth.csrf`).

    A request with no ``Origin`` header passes -- non-browser clients do not send one -- and an
    authenticated one still has to satisfy the CSRF token check. What this closes is the case a
    token cannot: a form on another origin posting to an endpoint that has no session to bind a
    token to.
    """

    def __init__(self, app: Callable[..., Awaitable[None]], settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        origin = request.headers.get('origin')
        if request.method.upper() in SAFE_METHODS or not origin:
            await self.app(scope, receive, send)
            return
        allowed = expected_origin(request, self.settings)
        if allowed is not None and origin.rstrip('/') == allowed.rstrip('/'):
            await self.app(scope, receive, send)
            return
        response = error_response(
            request,
            ApiError(
                ErrorCode.CSRF_REQUIRED,
                detail=f'cross-origin state change from {origin!r}; this origin is {allowed!r}',
            ),
        )
        await response(scope, receive, send)
