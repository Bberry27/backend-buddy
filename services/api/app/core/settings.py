"""The ``BB_*`` environment contract (work package A02).

``docs/architecture/deployment-architecture.md`` section 4 is the contract; this module is its
executable form. Four rules shape it:

1. **Every documented name is declared here**, including the ones A03 and A04 consume
   (``BB_ALLOW_PRIVATE_TARGETS``, ``BB_DEFAULT_TLS_MODE``, the job budgets,
   ``BB_SNAPSHOT_MAX_BYTES``) and the local-only tooling names (``BB_DENYLIST_FILE``,
   ``BB_FORBIDDEN_COUNTS``, ``BB_SCHEMA``, ``BB_CONTRACT_PATH``). It has to be that way:
   rule 2 rejects a variable this module does not know, so a name it does not declare would stop
   the API from starting on a machine where another component's variable is exported.
   ``test_A02_settings_reject_unknown`` reads the document's table and fails when a documented
   name is missing here.
2. **An unknown ``BB_*`` variable fails startup** (typo protection).
   :func:`unknown_variables` is the check; ``extra='forbid'`` on the model is the second line.
3. **Secrets are read from files, never from variables**, and only when asked for: the master key
   through :meth:`Settings.read_master_key`, the metadata store password by :mod:`app.db`. No
   secret value is ever stored on the settings object, so a repr, a log line, or a validation
   error cannot carry one.
4. **Nothing here connects to anything.** Importing this module, and constructing ``Settings``,
   perform no network I/O.

Values this package had to choose, proposed to the product owner in the A02 report and recorded
in ``docs/security/authn-authz.md``:

* ``BB_SESSION_IDLE_MINUTES`` = 60 and ``BB_SESSION_ABSOLUTE_HOURS`` = 12. A schema review is
  a working session, not a background tab: an hour of inactivity is generous for a reviewer who
  steps away, and twelve hours guarantees that a forgotten browser is not still authenticated the
  next morning.
* ``BB_RATE_LIMIT_LOGIN`` = ``10/minute`` per client address. Ten attempts a minute is more than
  any human login flow needs and far below what credential stuffing requires to be useful; the
  audit trail records every failure regardless (CTQ-16).
* ``BB_RATE_LIMIT_API_KEY`` = ``20/hour`` per client address. Key creation is an occasional
  administrative act, and each key is a long-lived credential.
* ``BB_COOKIE_SAMESITE`` = ``strict``. See :mod:`app.auth.cookies` for why the shipped default
  is stricter than ``security-architecture.md`` section 7 proposes.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import re
from collections.abc import Mapping
from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.db import DEFAULTS as DB_DEFAULTS
from app.db import PASSWORD_FILE_VARIABLE, TEST_URL_VARIABLE, URL_VARIABLE, ConfigError
from app.models import (
    CAP_SECONDS_DEFAULT,
    CAP_SECONDS_MAX,
    PER_TABLE_SECONDS_DEFAULT,
    PER_TABLE_SECONDS_MAX,
)

# The caps and defaults that ``app.models`` keeps in its ``base`` module rather than re-exporting.
from app.models.base import DEFAULT_TLS_MODE

__all__ = [
    'ENVIRONMENT_PREFIX',
    'MASTER_KEY_BYTES',
    'DeploymentMode',
    'Settings',
    'declared_variables',
    'unknown_variables',
]

#: Prefix of every variable in the contract.
ENVIRONMENT_PREFIX = 'BB_'

#: Length of the envelope master key. 256 bits, because A03 wraps secrets with AES-256-GCM.
MASTER_KEY_BYTES = 32

#: ``self-hosted`` (the default) or ``hosted``; see :attr:`Settings.deployment_mode`.
DeploymentMode = Literal['self-hosted', 'hosted']

_HEX_KEY = re.compile(r'\A[0-9a-fA-F]{64}\Z')

_DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7'


class Settings(BaseSettings):
    """The resolved configuration of one API process.

    Construct it with :meth:`from_environment` in production code, which runs the unknown-variable
    check first, and directly with keyword arguments in a test.
    """

    model_config = SettingsConfigDict(
        env_prefix=ENVIRONMENT_PREFIX,
        case_sensitive=False,
        extra='forbid',
        frozen=True,
    )

    # -- Metadata store locator ----------------------------------------------------------------
    # Resolution itself belongs to app.db (A01); these fields exist so the names are part of the
    # contract, so the unknown-variable check knows them, and so a test can inject a URL without
    # touching os.environ.

    database_url: str | None = Field(default=None, validation_alias=URL_VARIABLE)
    test_database_url: str | None = Field(default=None, validation_alias=TEST_URL_VARIABLE)
    db_host: str = DB_DEFAULTS['BB_DB_HOST']
    db_port: int = int(DB_DEFAULTS['BB_DB_PORT'])
    db_name: str = DB_DEFAULTS['BB_DB_NAME']
    db_user: str = DB_DEFAULTS['BB_DB_USER']
    db_password_file: Path = Path(DB_DEFAULTS[PASSWORD_FILE_VARIABLE])

    # -- Secrets (paths only; the content is read on demand and never stored) -------------------

    master_key_file: Path = Path('/run/secrets/backend-buddy_master_key')

    # -- Public origin, cookies, sessions ------------------------------------------------------

    #: ``https://host``. Required in production: it decides the cookie's ``Secure`` attribute, the
    #: CSRF origin check, HSTS, and absolute links.
    public_origin: str | None = None
    cookie_secure: bool = True
    cookie_samesite: Literal['strict', 'lax'] = 'strict'
    session_idle_minutes: int = Field(default=60, ge=1, le=60 * 24 * 30)
    session_absolute_hours: int = Field(default=12, ge=1, le=24 * 90)

    # -- Rate limits ---------------------------------------------------------------------------

    rate_limit_login: str = '10/minute'
    rate_limit_api_key: str = '20/hour'
    #: A test that must exhaust a limit sets this false; a deployment never does.
    rate_limit_enabled: bool = True

    # -- Logging and proxy trust ---------------------------------------------------------------

    log_level: Literal['critical', 'error', 'warning', 'info', 'debug'] = 'info'
    #: Networks whose ``X-Request-Id``, ``X-Forwarded-For`` and ``X-Forwarded-Proto`` are believed.
    #: The default is the private ranges a compose network is drawn from
    #: (``deployment-architecture.md`` section 5); a public deployment narrows it to the proxy.
    trusted_proxy_cidrs: str = _DEFAULT_TRUSTED_PROXIES

    # -- Passwords -----------------------------------------------------------------------------

    #: An operator-supplied deny list (one password per line) used *in addition* to the list
    #: shipped in ``app/auth/common-passwords.txt``. The image build points it at the full
    #: top-10k list; see :mod:`app.auth.passwords`.
    password_denylist_file: Path | None = None

    # -- Served SPA ----------------------------------------------------------------------------

    #: Directory of the built SPA (``packages/web/dist``). W01 fills it; until then the SPA routes
    #: answer 404 and the API is unaffected.
    static_dir: Path | None = None

    # -- Deployment mode (product-owner addendum to WP-A02, 2026-09-08) ------------------------

    #: ``self-hosted`` (the default) or ``hosted``.
    #:
    #: In ``self-hosted`` mode the operator owns the machine, so a target on ``localhost`` or in a
    #: private VNet is the normal case and is allowed: a default deny would make the product look
    #: broken on the very first connection a user adds. Cloud metadata endpoints stay denied in
    #: every mode, because nothing legitimate profiles those and allowing them buys the user
    #: nothing. In ``hosted`` mode a user-supplied host is an untrusted server-side request, so
    #: A03's full deny list applies and only the connector-agent path may reach a private address.
    #:
    #: Do not "harden" the default: it would break every local connection, which is the case the
    #: MVP exists to serve. The switch is here, in one place, so the hosted edition is a
    #: configuration change rather than a rewrite. A03 owns ``targets.py``, which reads it.
    deployment_mode: DeploymentMode = 'self-hosted'

    # -- Declared for A03 and A04, unused by A02 -----------------------------------------------

    allow_private_targets: bool = False
    default_tls_mode: str = DEFAULT_TLS_MODE
    job_table_seconds_default: int = Field(default=PER_TABLE_SECONDS_DEFAULT, ge=1)
    job_table_seconds_max: int = Field(default=PER_TABLE_SECONDS_MAX, ge=1)
    job_cap_seconds_default: int = Field(default=CAP_SECONDS_DEFAULT, ge=1)
    job_cap_seconds_max: int = Field(default=CAP_SECONDS_MAX, ge=1)
    snapshot_max_bytes: int | None = Field(default=None, ge=1)
    worker_concurrency: int = Field(default=1, ge=1)

    # -- Declared for the build and the local guard, unused by the API -------------------------

    schema_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices('BB_SCHEMA', 'BB_SCHEMA_PATH'),
    )
    contract_path: Path | None = None
    denylist_file: Path | None = None
    forbidden_counts: str | None = None

    @field_validator('public_origin')
    @classmethod
    def _validate_origin(cls, value: str | None) -> str | None:
        """An origin is a scheme and an authority, with no path, query, or trailing slash."""
        if value is None or not value.strip():
            return None
        origin = value.strip()
        if not re.fullmatch(r'https?://[A-Za-z0-9._~%-]+(:\d{1,5})?', origin):
            raise ValueError(
                f'BB_PUBLIC_ORIGIN must be scheme://host[:port] with no path, not {origin!r}'
            )
        return origin

    @field_validator('rate_limit_login', 'rate_limit_api_key')
    @classmethod
    def _validate_rate(cls, value: str) -> str:
        """A slowapi rule: ``<count>/<period>``, optionally several separated by ``;``."""
        for rule in value.split(';'):
            if not re.fullmatch(
                r'\s*\d+\s*(/|\s+per\s+)\s*\d*\s*(second|minute|hour|day)s?\s*',
                rule,
                re.IGNORECASE,
            ):
                raise ValueError(f'not a rate-limit rule: {rule!r} (for example "10/minute")')
        return value

    @field_validator('trusted_proxy_cidrs')
    @classmethod
    def _validate_cidrs(cls, value: str) -> str:
        for entry in filter(None, (part.strip() for part in value.split(','))):
            ipaddress.ip_network(entry, strict=False)
        return value

    # -- Derived values ------------------------------------------------------------------------

    @cached_property
    def origin_is_https(self) -> bool:
        """Whether the public origin is HTTPS. Decides HSTS and forces ``Secure`` cookies."""
        return self.public_origin is not None and self.public_origin.startswith('https://')

    @cached_property
    def secure_cookies(self) -> bool:
        """Whether cookies carry ``Secure`` (and therefore the ``__Host-`` prefix).

        An HTTPS public origin forces it on: a deployment must not be able to serve the SPA over
        TLS while handing out a cookie that also travels in the clear.
        """
        return self.cookie_secure or self.origin_is_https

    @cached_property
    def trusted_proxies(self) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
        """The parsed :attr:`trusted_proxy_cidrs`."""
        return tuple(
            ipaddress.ip_network(entry.strip(), strict=False)
            for entry in self.trusted_proxy_cidrs.split(',')
            if entry.strip()
        )

    def is_trusted_proxy(self, client_host: str | None) -> bool:
        """Whether ``client_host`` may set ``X-Request-Id`` and the forwarding headers."""
        if not client_host:
            return False
        try:
            address = ipaddress.ip_address(client_host)
        except ValueError:
            return False
        return any(address in network for network in self.trusted_proxies)

    def database_environment(self) -> dict[str, str]:
        """The mapping :func:`app.db.database_url` resolves, built from these settings.

        Passing it explicitly rather than letting :mod:`app.db` read ``os.environ`` is what makes
        a test able to point one app at a throwaway database while another runs beside it.
        """
        environment = {
            'BB_DB_HOST': self.db_host,
            'BB_DB_PORT': str(self.db_port),
            'BB_DB_NAME': self.db_name,
            'BB_DB_USER': self.db_user,
            PASSWORD_FILE_VARIABLE: str(self.db_password_file),
        }
        if self.database_url:
            environment[URL_VARIABLE] = self.database_url
        if self.test_database_url:
            environment[TEST_URL_VARIABLE] = self.test_database_url
        return environment

    def read_master_key(self) -> bytes:
        """Read the envelope master key from :attr:`master_key_file`.

        Accepted forms, both 256 bits: exactly 32 raw bytes, or 64 hexadecimal characters, because
        ``openssl rand -hex 32 > backend-buddy_master_key`` is what an operator runbook can honestly ask
        for. One trailing newline is tolerated in either form.

        Raises :class:`app.db.ConfigError` when the file is missing, unreadable, or not a 256-bit
        key. The message names the path and the length; it never contains the content, and no
        caller logs the return value.
        """
        try:
            raw = self.master_key_file.read_bytes()
        except OSError as error:
            raise ConfigError(
                f'BB_MASTER_KEY_FILE points at {str(self.master_key_file)!r}, which could not '
                f'be read ({error.__class__.__name__})'
            ) from None
        material = raw.removesuffix(b'\n').removesuffix(b'\r')
        if len(material) == MASTER_KEY_BYTES:
            return material
        text = material.decode('ascii', errors='ignore')
        if _HEX_KEY.fullmatch(text):
            return bytes.fromhex(text)
        raise ConfigError(
            f'BB_MASTER_KEY_FILE points at {str(self.master_key_file)!r}, which holds '
            f'{len(material)} bytes; it must hold exactly {MASTER_KEY_BYTES} raw bytes or '
            f'{MASTER_KEY_BYTES * 2} hexadecimal characters'
        )

    def master_key_fingerprint(self) -> bytes:
        """sha256 of the master key: what ``encryption_keys.master_key_fingerprint`` stores.

        The fingerprint is safe to compare and store; the key is not. Only this one primitive is
        needed here, so A02 declares no cryptography dependency -- A03, which encrypts, does.
        """
        return hashlib.sha256(self.read_master_key()).digest()

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Build settings from ``env`` (the process environment by default).

        Fails on an unknown ``BB_*`` variable before validating anything else, so a typo is
        reported as a typo rather than as a missing value somewhere else.
        """
        environ: Mapping[str, str] = os.environ if env is None else env
        unknown = unknown_variables(environ)
        if unknown:
            raise ConfigError(
                'unknown environment variable(s) '
                + ', '.join(unknown)
                + '. Every name in the contract is listed in '
                'docs/architecture/deployment-architecture.md section 4; a variable outside it '
                'is a typo, and starting with it would silently ignore whatever it was meant '
                'to configure.'
            )
        if env is None:
            return cls()
        # An explicit mapping is validated directly, so an injected environment is exactly what is
        # used: no process variable leaks into a test's settings, and the result is deterministic.
        return cls.model_validate(_keyword_arguments(environ))


def _keyword_arguments(env: Mapping[str, str]) -> dict[str, str]:
    """Translate ``BB_*`` names in ``env`` into keyword arguments for :class:`Settings`.

    Needed because pydantic-settings strips the prefix in its *environment* source but not in
    ``__init__``: passing ``BB_COOKIE_SECURE=...`` as a keyword argument would be rejected as an
    unknown field. A field with a ``validation_alias`` is passed under that alias, and every other
    field under its own name.
    """
    upper = {key.upper(): value for key, value in env.items()}
    arguments: dict[str, str] = {}
    for name, field in Settings.model_fields.items():
        alias = field.validation_alias
        candidates: tuple[str, ...]
        if isinstance(alias, str):
            candidates = (alias.upper(),)
        elif isinstance(alias, AliasChoices):
            candidates = tuple(str(choice).upper() for choice in alias.choices)
        else:
            candidates = (f'{ENVIRONMENT_PREFIX}{name}'.upper(),)
        for candidate in candidates:
            if candidate in upper:
                # An aliased field is populated by its alias; an ordinary one by its own name.
                arguments[candidate if alias is not None else name] = upper[candidate]
                break
    return arguments


def declared_variables() -> frozenset[str]:
    """Every ``BB_*`` name this module accepts, upper case."""
    names: set[str] = set()
    for name, field in Settings.model_fields.items():
        alias = field.validation_alias
        if isinstance(alias, str):
            names.add(alias.upper())
            continue
        if isinstance(alias, AliasChoices):
            names.update(str(choice).upper() for choice in alias.choices)
            continue
        names.add(f'{ENVIRONMENT_PREFIX}{name}'.upper())
    return frozenset(names)


def unknown_variables(env: Mapping[str, str]) -> tuple[str, ...]:
    """The ``BB_*`` names in ``env`` that :class:`Settings` does not declare, sorted."""
    declared = declared_variables()
    return tuple(
        sorted(
            name
            for name in env
            if name.upper().startswith(ENVIRONMENT_PREFIX) and name.upper() not in declared
        )
    )
