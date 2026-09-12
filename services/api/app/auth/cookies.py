"""The session and CSRF cookies, and their flags (work package A02; frozen contract).

``docs/architecture/security-architecture.md`` section 7 fixes the session cookie:

    Session cookie ``__Host-backend-buddy_session``: ``Secure; HttpOnly; SameSite=Lax; Path=/``. Dev
    overlay falls back to a non-``__Host-`` name over plain HTTP with a startup warning.

Two points about how that is implemented here.

**The ``__Host-`` prefix is a promise, not a name.** A browser accepts a ``__Host-`` cookie only
when it is ``Secure``, has ``Path=/``, and carries no ``Domain``; over plain HTTP it is silently
dropped, which would make a dev deployment look as though login did nothing. So the name is
chosen by :attr:`CookiePolicy.secure`, not written down twice: with TLS the cookie is
``__Host-backend-buddy_session``; without it, the fallback name ``backend-buddy_session`` plus a startup warning
(:func:`insecure_cookie_warning`) that says exactly what is weaker. There is no configuration
that produces a ``__Host-`` name without ``Secure``.

**``SameSite`` ships as ``Strict``, not ``Lax``.** This is a deliberate, recorded deviation from
section 7, made on instruction from the work-package owner, and it is a tightening: the SPA is
served from the same origin as the API, and nothing in the MVP depends on a cookie surviving a
cross-site top-level navigation -- there is no OAuth callback, no email deep link into an
authenticated view, no payment return. ``Lax`` would send the session on a cross-site GET
navigation; ``Strict`` does not, which removes the residual class of attacks that begins with a
link. ``BB_COOKIE_SAMESITE=lax`` restores the documented value for a deployment that later
needs it, so the change is one setting rather than a rewrite. The report proposes the same edit to
``security-architecture.md`` section 7 and to the brief's frozen-contract row; until that is
accepted, ``test_A02_cookie_flags_and_csrf`` pins ``Strict`` as shipped **and** pins that ``Lax``
remains reachable.

The CSRF cookie is the readable half of the double-submit pair: same name discipline, same
``SameSite``, but **not** ``HttpOnly``, because the SPA has to read it to put it in a header. It
is not a credential on its own -- the request also needs the session cookie, and the token is
compared against ``sessions.csrf_token_hash``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from starlette.responses import Response

from app.core.settings import Settings

__all__ = [
    'CSRF_COOKIE',
    'CSRF_COOKIE_INSECURE',
    'SESSION_COOKIE',
    'SESSION_COOKIE_INSECURE',
    'CookiePolicy',
    'insecure_cookie_warning',
]

#: The cookie names. The ``__Host-`` forms are the only ones a TLS deployment ever sets.
SESSION_COOKIE: Final = '__Host-backend-buddy_session'
SESSION_COOKIE_INSECURE: Final = 'backend-buddy_session'
CSRF_COOKIE: Final = '__Host-backend-buddy_csrf'
CSRF_COOKIE_INSECURE: Final = 'backend-buddy_csrf'


@dataclass(frozen=True, slots=True)
class CookiePolicy:
    """How this process names and flags its cookies."""

    secure: bool
    samesite: Literal['strict', 'lax']

    @classmethod
    def from_settings(cls, settings: Settings) -> CookiePolicy:
        """Derive the policy from the environment contract."""
        return cls(secure=settings.secure_cookies, samesite=settings.cookie_samesite)

    @property
    def session_name(self) -> str:
        """``__Host-backend-buddy_session``, or the fallback name when cookies are not ``Secure``."""
        return SESSION_COOKIE if self.secure else SESSION_COOKIE_INSECURE

    @property
    def csrf_name(self) -> str:
        """``__Host-backend-buddy_csrf``, or the fallback name when cookies are not ``Secure``."""
        return CSRF_COOKIE if self.secure else CSRF_COOKIE_INSECURE

    def set_session(self, response: Response, token: str, *, max_age_seconds: int) -> None:
        """Set the session cookie. ``HttpOnly``, so no script can read the token."""
        response.set_cookie(
            self.session_name,
            token,
            max_age=max_age_seconds,
            path='/',
            secure=self.secure,
            httponly=True,
            samesite=self.samesite,
        )

    def set_csrf(self, response: Response, token: str, *, max_age_seconds: int) -> None:
        """Set the CSRF cookie. Readable by the SPA, which echoes it in ``X-CSRF-Token``."""
        response.set_cookie(
            self.csrf_name,
            token,
            max_age=max_age_seconds,
            path='/',
            secure=self.secure,
            httponly=False,
            samesite=self.samesite,
        )

    def clear(self, response: Response) -> None:
        """Delete both cookies, with the same attributes they were set with.

        Both names are deleted, not just the current one: a deployment that has just been put
        behind TLS must still be able to log out a browser holding the fallback cookie.
        """
        for name in (SESSION_COOKIE, SESSION_COOKIE_INSECURE, CSRF_COOKIE, CSRF_COOKIE_INSECURE):
            response.delete_cookie(
                name,
                path='/',
                secure=name.startswith('__Host-'),
                httponly='session' in name,
                samesite=self.samesite,
            )


def insecure_cookie_warning(settings: Settings) -> str | None:
    """The startup warning for a deployment running without ``Secure`` cookies, or ``None``.

    Required by ``security-architecture.md`` section 7 and by the dev overlay in
    ``deployment-architecture.md`` section 3.1. It names what is lost rather than saying
    "insecure": an operator who sees this line in production needs to know what to fix.
    """
    if settings.secure_cookies:
        return None
    return (
        f'cookies are not Secure (BB_COOKIE_SECURE=false), so the session cookie is named '
        f'{SESSION_COOKIE_INSECURE!r} instead of {SESSION_COOKIE!r}: the __Host- prefix requires '
        f'HTTPS and a browser would silently drop the prefixed name over plain HTTP. This is the '
        f'development fallback. In this mode the session token travels in the clear and any '
        f'process that can read the loopback traffic can replay it; do not use it for a '
        f'deployment anyone else can reach. Set BB_COOKIE_SECURE=true and '
        f'BB_PUBLIC_ORIGIN=https://... behind the reverse proxy.'
    )
