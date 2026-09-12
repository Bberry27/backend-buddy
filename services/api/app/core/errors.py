"""Fixed client-facing error strings (work package A02; RK-21).

The rule comes from the baseline and is worth keeping verbatim: every database and driver error
in ``packages/explorer/server/serve_explorer.py:109-111`` collapses to a fixed string, so a DSN,
a sampled value, or a schema name cannot travel out in an error message. This module generalises
it to the whole API.

How it works:

* every failure the API raises is an :class:`ApiError` carrying an :class:`ErrorCode`; the code
  selects one of the strings in :data:`MESSAGES` and nothing else reaches the client;
* the ``detail`` argument is for the log, which is redacted (:mod:`app.core.logging`), and is
  never rendered into the response;
* the response carries the request id, so a user can quote it and an operator can find the line
  that has the detail. An identifier is not a disclosure;
* FastAPI's own validation handler is replaced, because the default one echoes the offending
  input back to the caller and into the log -- which for ``POST /auth/login`` would be the
  submitted password.

The shape is stable, because the SPA switches on ``error.code``::

    {"error": {"code": "invalid_credentials", "message": "...", "requestId": "..."}}
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Final

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger, request_id

__all__ = [
    'MESSAGES',
    'ApiError',
    'ErrorCode',
    'error_response',
    'install_error_handlers',
]

log = get_logger('app.error')


class ErrorCode(StrEnum):
    """Machine-readable failure codes. The SPA switches on these; humans read the message."""

    UNAUTHENTICATED = 'unauthenticated'
    INVALID_CREDENTIALS = 'invalid_credentials'
    ACCOUNT_DISABLED = 'account_disabled'
    PASSWORD_REJECTED = 'password_rejected'
    CSRF_REQUIRED = 'csrf_required'
    FORBIDDEN = 'forbidden'
    NOT_FOUND = 'not_found'
    CONFLICT = 'conflict'
    VALIDATION_FAILED = 'validation_failed'
    RATE_LIMITED = 'rate_limited'
    NOT_READY = 'not_ready'
    INTERNAL_ERROR = 'internal_error'


#: The only strings a client ever sees. Deliberately free of anything server-specific: no table
#: name, no host, no driver text, no hint about which half of a credential pair was wrong.
MESSAGES: Final[dict[ErrorCode, str]] = {
    ErrorCode.UNAUTHENTICATED: 'Authentication is required.',
    ErrorCode.INVALID_CREDENTIALS: 'The email address or password is incorrect.',
    ErrorCode.ACCOUNT_DISABLED: 'This account is not active.',
    ErrorCode.PASSWORD_REJECTED: 'The password does not meet the password policy.',
    ErrorCode.CSRF_REQUIRED: 'A valid CSRF token is required for this request.',
    ErrorCode.FORBIDDEN: 'Your role does not permit this action.',
    ErrorCode.NOT_FOUND: 'Not found.',
    ErrorCode.CONFLICT: 'The request conflicts with the current state.',
    ErrorCode.VALIDATION_FAILED: 'The request is not valid.',
    ErrorCode.RATE_LIMITED: 'Too many requests. Try again later.',
    ErrorCode.NOT_READY: 'The service is not ready.',
    ErrorCode.INTERNAL_ERROR: 'The request could not be completed.',
}

#: The HTTP status each code answers with.
_STATUS: Final[dict[ErrorCode, int]] = {
    ErrorCode.UNAUTHENTICATED: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.INVALID_CREDENTIALS: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.ACCOUNT_DISABLED: status.HTTP_403_FORBIDDEN,
    ErrorCode.PASSWORD_REJECTED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.CSRF_REQUIRED: status.HTTP_403_FORBIDDEN,
    ErrorCode.FORBIDDEN: status.HTTP_403_FORBIDDEN,
    ErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.CONFLICT: status.HTTP_409_CONFLICT,
    ErrorCode.VALIDATION_FAILED: status.HTTP_422_UNPROCESSABLE_CONTENT,
    ErrorCode.RATE_LIMITED: status.HTTP_429_TOO_MANY_REQUESTS,
    ErrorCode.NOT_READY: status.HTTP_503_SERVICE_UNAVAILABLE,
    ErrorCode.INTERNAL_ERROR: status.HTTP_500_INTERNAL_SERVER_ERROR,
}


class ApiError(Exception):
    """A failure with a fixed client-facing string and a detail that stays in the log.

    ``reason`` is an optional short, non-sensitive clarification appended to the message. It
    exists for exactly one case that would otherwise be unusable: a rejected password has to say
    whether it was too short or on the deny list. Never put a value, a host, or a driver message
    in it.
    """

    def __init__(
        self,
        code: ErrorCode,
        *,
        detail: str | None = None,
        reason: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.code = code
        self.status_code = _STATUS[code]
        self.reason = reason
        self.detail = detail
        self.headers = headers or {}
        super().__init__(MESSAGES[code])

    @property
    def message(self) -> str:
        """What the client is told."""
        base = MESSAGES[self.code]
        return f'{base} {self.reason}' if self.reason else base


def error_response(request: Request, error: ApiError) -> JSONResponse:
    """Render ``error`` as the API's error envelope."""
    body: dict[str, Any] = {
        'error': {
            'code': str(error.code),
            'message': error.message,
            'requestId': request_id(request.scope),
        }
    }
    return JSONResponse(status_code=error.status_code, content=body, headers=error.headers)


def install_error_handlers(app: FastAPI) -> None:
    """Register the four handlers that keep every failure inside :data:`MESSAGES`."""

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exception: Exception) -> JSONResponse:
        error = exception if isinstance(exception, ApiError) else ApiError(ErrorCode.INTERNAL_ERROR)
        if error.detail:
            log.warning('request.rejected', code=str(error.code), detail=error.detail)
        return error_response(request, error)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exception: Exception) -> JSONResponse:
        assert isinstance(exception, StarletteHTTPException)
        code = {
            status.HTTP_401_UNAUTHORIZED: ErrorCode.UNAUTHENTICATED,
            status.HTTP_403_FORBIDDEN: ErrorCode.FORBIDDEN,
            status.HTTP_404_NOT_FOUND: ErrorCode.NOT_FOUND,
            status.HTTP_405_METHOD_NOT_ALLOWED: ErrorCode.NOT_FOUND,
            status.HTTP_409_CONFLICT: ErrorCode.CONFLICT,
            status.HTTP_429_TOO_MANY_REQUESTS: ErrorCode.RATE_LIMITED,
        }.get(exception.status_code, ErrorCode.INTERNAL_ERROR)
        # A framework exception's own detail is discarded: it is written for a developer and may
        # quote the request.
        return error_response(request, ApiError(code, detail=str(exception.detail)))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exception: Exception) -> JSONResponse:
        assert isinstance(exception, RequestValidationError)
        # Only the *locations* of the offending fields are logged. FastAPI's default handler puts
        # the rejected input in the response and the log; for a login body that is the password.
        locations = ['.'.join(str(part) for part in item.get('loc', ())) for item in exception.errors()]
        return error_response(
            request,
            ApiError(ErrorCode.VALIDATION_FAILED, detail=f'invalid fields: {locations}'),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exception: Exception) -> JSONResponse:
        log.exception('request.unhandled', error_type=exception.__class__.__name__)
        return error_response(request, ApiError(ErrorCode.INTERNAL_ERROR))
