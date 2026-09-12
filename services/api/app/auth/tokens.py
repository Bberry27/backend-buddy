"""Opaque tokens: minting, hashing, and constant-time comparison (work package A02).

Three token kinds exist, and all three obey the same three rules
(``docs/architecture/security-architecture.md`` section 4):

* the token is 256 bits from :mod:`secrets`, so it cannot be guessed and carries no structure to
  reverse;
* only its sha256 digest is stored (``sessions.token_hash``, ``sessions.csrf_token_hash``,
  ``api_keys.key_hash``), so a database dump does not yield a working credential;
* a comparison against a stored digest uses :func:`hmac.compare_digest`, the pattern already
  proven at ``packages/explorer/server/serve_explorer.py:79``.

An API key is additionally given a human-visible shape: ``backend-buddy_`` followed by the secret, whose
first eight characters are stored as ``api_keys.key_prefix`` so the UI and the audit trail can
name a key without holding it. The prefix is an identifier, not a credential -- 8 of 43 characters
is 48 bits of a 256-bit secret, and lookup is by digest, never by prefix.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Final

from app.models.base import API_KEY_PREFIX_LENGTH

__all__ = [
    'API_KEY_LABEL',
    'TOKEN_BYTES',
    'ApiKeyMaterial',
    'digest',
    'matches',
    'mint_api_key',
    'mint_token',
    'split_api_key',
]

#: 256 bits, the width ``data-model.md`` 3.4 specifies for the session cookie's token.
TOKEN_BYTES: Final = 32

#: Prefix that makes a leaked key recognisable in a log or a paste, so it can be revoked.
API_KEY_LABEL: Final = 'backend-buddy_'


def mint_token() -> str:
    """A new URL-safe 256-bit token. Returned once, to the caller, and never stored."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def digest(token: str) -> bytes:
    """The sha256 of ``token``: exactly what the ``*_hash`` columns hold."""
    return hashlib.sha256(token.encode('utf-8')).digest()


def matches(stored: bytes, token: str) -> bool:
    """Whether ``token`` hashes to ``stored``, compared in constant time."""
    return hmac.compare_digest(stored, digest(token))


class ApiKeyMaterial:
    """A freshly minted API key: what to show once, and what to store.

    ``token`` is the only copy of the secret that will ever exist. It is returned to the caller
    that created the key, in the creation response and nowhere else.
    """

    __slots__ = ('key_hash', 'key_prefix', 'token')

    def __init__(self, token: str, key_prefix: str, key_hash: bytes) -> None:
        self.token = token
        self.key_prefix = key_prefix
        self.key_hash = key_hash

    def __repr__(self) -> str:
        """Deliberately without the token: a repr ends up in tracebacks and logs."""
        return f'ApiKeyMaterial(key_prefix={self.key_prefix!r})'


def mint_api_key() -> ApiKeyMaterial:
    """Mint an API key: the display token, its stored prefix, and its stored digest."""
    secret = secrets.token_urlsafe(TOKEN_BYTES)
    return ApiKeyMaterial(
        token=f'{API_KEY_LABEL}{secret}',
        key_prefix=secret[:API_KEY_PREFIX_LENGTH],
        key_hash=digest(secret),
    )


def split_api_key(presented: str) -> str | None:
    """The secret inside a presented API key, or ``None`` when it is not one of ours.

    Rejecting a token that lacks the label saves a database round trip on every request that
    carries some other kind of bearer token.
    """
    candidate = presented.strip()
    if not candidate.startswith(API_KEY_LABEL):
        return None
    secret = candidate[len(API_KEY_LABEL) :]
    return secret if len(secret) >= API_KEY_PREFIX_LENGTH else None
