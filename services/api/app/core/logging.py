"""Structured logging, the request id, and the redaction processor (work package A02, CTQ-16).

Three things live here, in the order a log line meets them:

1. :class:`RequestContextMiddleware` gives every request an id, binds it (and the method, path and
   client address) into the structlog context, times the request, writes one access line, and
   echoes the id back in ``X-Request-Id`` so an operator can quote it from a browser's network
   tab. An inbound ``X-Request-Id`` is honoured **only** from a trusted proxy
   (``deployment-architecture.md`` section 5) and only when it looks like an id; anything else is
   replaced, because a request id that a client controls can forge or merge two audit trails.
2. :func:`redact_processor` rewrites the event dictionary before it is rendered: any key that
   names a secret loses its value, any string that carries URL credentials or a bearer token
   loses the credential, and the recursion is depth- and size-bounded so a hostile payload cannot
   turn a log line into a denial of service.
3. :func:`configure_logging` renders the result as one JSON object per line on stdout, which is
   what the compose deployment collects.

The redaction list is the one named in the brief -- ``secret``, ``password``, ``dsn``, ``token``,
``sample`` -- matched as substrings, plus a short list of names that are a secret *exactly*
(``cookie``, ``authorization``, ``api_key``, ``master_key``). The two rules differ on purpose:
``cookie_samesite`` and ``cookie_secure`` are configuration flags, and a redaction that swallowed
them would blank the startup line while protecting nothing. What is deliberately *not* redacted is
an identifier: ``request_id``, ``api_key_id``, ``key_prefix`` and ``workspace_id`` are how an
incident is reconstructed (RK-21), and none of them is a credential.

Nothing here decides *whether* to log a value. That is the caller's job, and the rule from
``packages/explorer/server/serve_explorer.py:109-111`` still holds: client-facing strings are
fixed, and detail belongs in the log, redacted.
"""

from __future__ import annotations

import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, MutableMapping, Sequence
from typing import Any, Final

import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars
from structlog.typing import EventDict, WrappedLogger

from app.core.settings import Settings

__all__ = [
    'REDACTED',
    'REQUEST_ID_HEADER',
    'RequestContextMiddleware',
    'configure_logging',
    'get_logger',
    'redact',
    'redact_processor',
    'request_id',
    'silence_uvicorn_handlers',
]

#: What replaces a redacted value. Asserted verbatim by ``test_A02_log_redaction``.
REDACTED: Final = '[REDACTED]'

REQUEST_ID_HEADER: Final = 'x-request-id'

#: A key whose *name* contains one of these is a secret whatever its value looks like. Substring
#: matching is deliberate: it catches ``csrf_token``, ``token_hash``, ``db_password`` and
#: ``sample_values`` without listing them.
_SECRET_SUBSTRING = re.compile(r'(secret|password|passwd|dsn|token|sample|credential)', re.I)

#: Names that are a secret exactly, and only exactly. ``cookie`` is the header's value; but
#: ``cookie_secure`` and ``cookie_samesite`` are configuration flags, and redacting those would
#: make the startup line useless while protecting nothing. Compared after stripping separators.
_SECRET_EXACT = frozenset(
    {
        'cookie',
        'cookies',
        'setcookie',
        'authorization',
        'auth',
        'apikey',
        'key',
        'masterkey',
        'privatekey',
    }
)


def _is_secret_key(name: str) -> bool:
    """Whether a log field named ``name`` must lose its value."""
    if _SECRET_SUBSTRING.search(name):
        return True
    return re.sub(r'[^a-z0-9]', '', name.lower()) in _SECRET_EXACT

#: ``scheme://user:password@host`` -- a DSN or any other URL carrying credentials.
_URL_CREDENTIALS = re.compile(r'(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*://)[^\s/?#@]*:[^\s/?#@]*@')

#: ``Authorization: Bearer <token>`` and the same shape inside a message.
_BEARER = re.compile(r'\b(?P<scheme>Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', re.IGNORECASE)

#: A request id we are willing to adopt from a proxy.
_REQUEST_ID = re.compile(r'\A[A-Za-z0-9_.:-]{1,64}\Z')

#: Recursion and size bounds for :func:`redact`. A log line is not a data structure dump.
_MAX_DEPTH: Final = 6
_MAX_ITEMS: Final = 64
_MAX_STRING: Final = 2048


def redact(value: object, *, depth: int = 0) -> object:
    """Return ``value`` with secrets removed, recursively and within bounds.

    Mappings are walked by key, so ``{'dsn': ...}`` loses its value whatever its type; sequences
    are walked by element; strings lose URL credentials and bearer tokens wherever they appear,
    which is what catches a DSN interpolated into a message.
    """
    if depth >= _MAX_DEPTH:
        return '[TRUNCATED]'
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, bytes):
        return f'<{len(value)} bytes>'
    if isinstance(value, Mapping):
        redacted: dict[str, object] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_ITEMS:
                redacted['...'] = '[TRUNCATED]'
                break
            name = str(key)
            redacted[name] = (
                REDACTED if _is_secret_key(name) else redact(item, depth=depth + 1)
            )
        return redacted
    if isinstance(value, Sequence):
        return [redact(item, depth=depth + 1) for item in value[:_MAX_ITEMS]]
    if isinstance(value, set | frozenset):
        return [redact(item, depth=depth + 1) for item in sorted(value, key=repr)[:_MAX_ITEMS]]
    return value


def _redact_string(value: str) -> str:
    """Remove URL credentials and bearer tokens from ``value`` and cap its length."""
    text = _URL_CREDENTIALS.sub(lambda match: f'{match.group("scheme")}{REDACTED}@', value)
    text = _BEARER.sub(lambda match: f'{match.group("scheme")} {REDACTED}', text)
    if len(text) > _MAX_STRING:
        return f'{text[:_MAX_STRING]}...[TRUNCATED]'
    return text


def redact_processor(_logger: WrappedLogger, _name: str, event_dict: EventDict) -> EventDict:
    """structlog processor applying :func:`redact` to the whole event dictionary."""
    result = redact(dict(event_dict))
    return dict(result) if isinstance(result, dict) else event_dict


def configure_logging(settings: Settings) -> None:
    """Send **every** log line, from this package or from a dependency, to stdout as JSON.

    The foreign-log path matters as much as ours. A library that logs through the standard library
    -- uvicorn, SQLAlchemy, slowapi -- would otherwise emit plain text into a stream that a
    collector parses as JSON, and CTQ-16 asks for JSON logs with a request id. So the stdlib
    handler uses structlog's :class:`~structlog.stdlib.ProcessorFormatter` with the same
    processor chain, redaction included: one shape, one redaction policy, no exceptions.

    Idempotent: calling it again (a second application in the same test process) reconfigures
    rather than stacking handlers.
    """
    level = logging.getLevelNamesMapping()[settings.log_level.upper()]
    # Order matters: the exception text is rendered *before* redaction, because a traceback is one
    # of the likeliest places for a DSN to appear (``RuntimeError: could not connect to
    # postgresql://user:pw@host/db``) and a processor that runs earlier would never see it.
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt='iso', utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        redact_processor,
    ]
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.processors.JSONRenderer(sort_keys=True),
            ],
        )
    )
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
    silence_uvicorn_handlers()
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=False,
    )


def silence_uvicorn_handlers() -> None:
    """Send uvicorn's own log lines through this configuration, or drop them.

    uvicorn installs its own handlers with ``dictConfig`` and sets ``propagate = False``, so
    without this its lines ("Started server process", "Application startup complete") arrive as
    plain text in a stream a collector parses as JSON. Its **access** log is dropped outright: it
    would duplicate the line :class:`RequestContextMiddleware` writes, without the request id and
    without redaction.

    Called from :func:`configure_logging` and again from the application's lifespan, because
    whether uvicorn configures logging before or after it imports the application is uvicorn's
    business, and the lifespan is the one hook guaranteed to run afterwards.
    """
    for name in ('uvicorn', 'uvicorn.error'):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
    access = logging.getLogger('uvicorn.access')
    access.handlers = []
    access.propagate = False


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """A bound logger for ``name``."""
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    return logger


def request_id(scope: Mapping[str, Any]) -> str:
    """The request id bound to ``scope``, or ``'-'`` outside a request."""
    state = scope.get('state')
    if isinstance(state, dict):
        value = state.get('request_id')
        if isinstance(value, str):
            return value
    return '-'


class RequestContextMiddleware:
    """Pure-ASGI middleware binding the request id and writing the access line.

    Pure ASGI rather than :class:`starlette.middleware.base.BaseHTTPMiddleware` because this
    middleware needs neither the request body nor a response object, and buffering both to add a
    header would be a needless copy on every request.
    """

    def __init__(self, app: Callable[..., Awaitable[None]], settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self.log = get_logger('app.request')

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        headers = {
            key.decode('latin-1').lower(): value.decode('latin-1')
            for key, value in scope.get('headers', ())
        }
        client = scope.get('client')
        peer = client[0] if isinstance(client, tuple) and client else None
        trusted = self.settings.is_trusted_proxy(peer)
        identifier = self._inbound_id(headers) if trusted else None
        identifier = identifier or uuid.uuid4().hex
        state = scope.setdefault('state', {})
        if isinstance(state, dict):
            state['request_id'] = identifier
            state['client_address'] = self._client_address(headers, peer, trusted=trusted)
            state['forwarded_proto'] = self._forwarded_proto(headers, scope, trusted=trusted)

        clear_contextvars()
        bind_contextvars(
            request_id=identifier,
            method=scope.get('method', '-'),
            path=scope.get('path', '-'),
            client=state.get('client_address') if isinstance(state, dict) else None,
        )
        status_holder: dict[str, int] = {'status': 500}
        started = time.perf_counter()

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            if message['type'] == 'http.response.start':
                status_holder['status'] = int(message['status'])
                raw = list(message.get('headers', []))
                raw.append((REQUEST_ID_HEADER.encode('latin-1'), identifier.encode('latin-1')))
                message = {**message, 'headers': raw}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            self.log.exception(
                'request.failed',
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
            )
            raise
        else:
            self.log.info(
                'request.completed',
                status=status_holder['status'],
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
            )
        finally:
            clear_contextvars()

    @staticmethod
    def _inbound_id(headers: Mapping[str, str]) -> str | None:
        candidate = headers.get(REQUEST_ID_HEADER, '').strip()
        return candidate if _REQUEST_ID.fullmatch(candidate) else None

    @staticmethod
    def _client_address(
        headers: Mapping[str, str],
        peer: str | None,
        *,
        trusted: bool,
    ) -> str | None:
        """The caller's address: the first ``X-Forwarded-For`` hop behind a trusted proxy."""
        if trusted:
            forwarded = headers.get('x-forwarded-for', '')
            first = forwarded.split(',')[0].strip()
            if first:
                return first
        return peer

    @staticmethod
    def _forwarded_proto(
        headers: Mapping[str, str],
        scope: Mapping[str, Any],
        *,
        trusted: bool,
    ) -> str:
        """``https`` when the edge terminated TLS, else the scheme this process was reached on."""
        if trusted:
            proto = headers.get('x-forwarded-proto', '').split(',')[0].strip().lower()
            if proto in {'http', 'https'}:
                return proto
        scheme = scope.get('scheme')
        return scheme if isinstance(scheme, str) else 'http'
