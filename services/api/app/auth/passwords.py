"""Password hashing and the password policy (work package A02; ADR-0005; limits-and-caps B).

The policy is three independent gates, and a password must pass all of them:

1. **Length.** At least :data:`MINIMUM_LENGTH` = 12 characters, counted in Unicode code points
   after NFKC normalisation, and at most :data:`MAXIMUM_LENGTH` so a multi-megabyte body cannot
   turn one login into a memory-hard denial of service.
2. **Deny list.** The password, and a small set of obvious de-obfuscations of it, must not appear
   in the common-password list. The list shipped in this package
   (``app/auth/common-passwords.txt``) is a curated subset: the twelve-character minimum already
   removes the overwhelming majority of any top-10k list, so what is left is the long entries,
   and those are what the shipped file holds. An operator or an image build points
   ``BB_PASSWORD_DENYLIST_FILE`` at the full top-10k list and it is used *in addition*; see
   ``docs/security/authn-authz.md``. Both files are read once, at first use, and cached.
3. **Structure.** A single repeated character, a run of consecutive digits, and a keyboard row are
   rejected however long they are, because ``aaaaaaaaaaaa`` and ``123456789012`` pass a length
   check and are the first two guesses anybody makes. The user's own email address and display
   name are rejected for the same reason.

Hashing is argon2id through ``argon2-cffi``, with the cost parameters pinned here rather than
inherited from the library's defaults, so an upgrade of the dependency cannot silently change the
work factor. :func:`verify_password` is also the tool for making an unknown account cost the same
as a known one: see :func:`dummy_hash`.

Neither a password nor a hash is ever logged, put in an exception message, or returned. The only
thing that leaves this module is a boolean, a hash string, or a rejection reason from a fixed set.
"""

from __future__ import annotations

import functools
import re
import unicodedata
from collections.abc import Iterator
from pathlib import Path
from typing import Final

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.errors import ApiError, ErrorCode

__all__ = [
    'MAXIMUM_LENGTH',
    'MINIMUM_LENGTH',
    'PASSWORD_DENYLIST_PATH',
    'check_password_policy',
    'common_passwords',
    'dummy_hash',
    'hash_password',
    'needs_rehash',
    'verify_password',
]

#: ``docs/reference/limits-and-caps.md`` section B: "Password minimum length | 12 characters,
#: top-10k deny list".
MINIMUM_LENGTH: Final = 12

#: Hashing is memory-hard, so the input is bounded. Well above any passphrase a human types.
MAXIMUM_LENGTH: Final = 1024

#: The deny list shipped with the package.
PASSWORD_DENYLIST_PATH: Final = Path(__file__).with_name('common-passwords.txt')

#: argon2id cost parameters, pinned. 64 MiB and three passes is the ``argon2-cffi`` default at the
#: version this package requires and is comfortably above the OWASP floor (19 MiB, two passes);
#: writing them down means a dependency upgrade cannot lower them without this line changing.
_TIME_COST: Final = 3
_MEMORY_COST_KIB: Final = 65536
_PARALLELISM: Final = 4
_HASH_LENGTH: Final = 32
_SALT_LENGTH: Final = 16

_HASHER: Final = PasswordHasher(
    time_cost=_TIME_COST,
    memory_cost=_MEMORY_COST_KIB,
    parallelism=_PARALLELISM,
    hash_len=_HASH_LENGTH,
    salt_len=_SALT_LENGTH,
)

_DIGIT_RUN = '01234567890123456789'
_KEYBOARD_ROWS = ('qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'azertyuiop', 'qwertzuiop')
_LEET = str.maketrans({'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's', '@': 'a'})
_TRAILING_NOISE = re.compile(r'[^a-z]+$')
_LEADING_NOISE = re.compile(r'^[^a-z]+')


def _normalise(password: str) -> str:
    """NFKC, so a composed and a decomposed form of the same passphrase behave identically."""
    return unicodedata.normalize('NFKC', password)


@functools.cache
def common_passwords(operator_file: Path | None = None) -> frozenset[str]:
    """The deny list: the shipped file, plus ``operator_file`` when one is configured.

    Entries are case-folded and stripped. Blank lines and ``#`` comments are ignored. A missing
    shipped file is a packaging error and raises; a missing *operator* file raises too, because an
    operator who names a deny list and does not get one has a weaker policy than they asked for.
    """
    entries: set[str] = set()
    for path in (PASSWORD_DENYLIST_PATH, operator_file):
        if path is None:
            continue
        for line in path.read_text(encoding='utf-8').splitlines():
            entry = line.strip()
            if entry and not entry.startswith('#'):
                entries.add(entry.casefold())
    return frozenset(entries)


def _variants(password: str) -> Iterator[str]:
    """The forms of ``password`` compared against the deny list.

    ``Password1234`` and ``p4ssword!!`` are the same guess as ``password``, so the comparison sees
    the case-folded password, a leet-decoded form, and both with leading and trailing non-letters
    removed. Nothing here weakens the check: every variant is an *additional* reason to reject.
    """
    folded = password.casefold()
    seen: set[str] = set()
    for base in (folded, folded.translate(_LEET)):
        for candidate in (
            base,
            _TRAILING_NOISE.sub('', base),
            _LEADING_NOISE.sub('', _TRAILING_NOISE.sub('', base)),
        ):
            if candidate and candidate not in seen:
                seen.add(candidate)
                yield candidate


def _structural_reason(password: str) -> str | None:
    """A reason to reject ``password`` on its shape alone, or ``None``."""
    folded = password.casefold()
    if len(set(folded)) == 1:
        return 'It must not be a single repeated character.'
    if folded in _DIGIT_RUN or folded in _DIGIT_RUN[::-1]:
        return 'It must not be a run of consecutive digits.'
    for row in _KEYBOARD_ROWS:
        if folded in row or folded in row[::-1] or folded in row * 2:
            return 'It must not be a row of adjacent keyboard characters.'
    if len(folded) >= MINIMUM_LENGTH and folded == folded[: len(folded) // 2] * 2:
        return 'It must not be a short string repeated.'
    return None


def check_password_policy(
    password: str,
    *,
    email: str | None = None,
    display_name: str | None = None,
    denylist_file: Path | None = None,
) -> None:
    """Raise :class:`app.core.errors.ApiError` when ``password`` fails the policy.

    The reason is one of a fixed set of sentences and never quotes the password. It has to say
    *which* gate failed: a policy that answers "no" without saying why produces users who append
    ``1`` until it stops complaining.
    """
    candidate = _normalise(password)
    if len(candidate) < MINIMUM_LENGTH:
        raise _rejected(f'It must be at least {MINIMUM_LENGTH} characters long.')
    if len(candidate) > MAXIMUM_LENGTH:
        raise _rejected(f'It must be at most {MAXIMUM_LENGTH} characters long.')
    if candidate != candidate.strip():
        raise _rejected('It must not start or end with whitespace.')
    structural = _structural_reason(candidate)
    if structural:
        raise _rejected(structural)
    denied = common_passwords(denylist_file)
    if any(variant in denied for variant in _variants(candidate)):
        raise _rejected('It is one of the most commonly used passwords.')
    folded = candidate.casefold()
    if any(token in folded for token in _personal_tokens(email, display_name)):
        raise _rejected('It must not contain your email address or display name.')


def _personal_tokens(email: str | None, display_name: str | None) -> set[str]:
    """The parts of an account's identity a password must not contain.

    The whole address, its local part, the display name, and each word of four or more characters
    from either. Four is short enough to catch ``reviewer-at-example`` for
    ``reviewer@example.test`` and ``daphne-...`` for ``Daphne McAllister``, and it does mean a
    four-letter name inside an unrelated word is refused; the rejection says which rule applied,
    which is a better outcome than accepting the one password an attacker guesses first.
    """
    tokens: set[str] = set()
    for value in (email, display_name):
        if not value:
            continue
        folded = value.casefold().strip()
        candidates = [folded, folded.split('@')[0]]
        candidates.extend(re.split(r'[^a-z0-9]+', folded))
        tokens.update(part for part in candidates if len(part) >= 4)
    return tokens


def _rejected(reason: str) -> ApiError:
    return ApiError(ErrorCode.PASSWORD_REJECTED, reason=reason)


def hash_password(password: str) -> str:
    """An argon2id hash of ``password``, as stored in ``users.password_hash``."""
    return _HASHER.hash(_normalise(password))


def verify_password(password_hash: str, password: str) -> bool:
    """Whether ``password`` matches ``password_hash``. Never raises for a wrong password."""
    try:
        return _HASHER.verify(password_hash, _normalise(password))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """Whether ``password_hash`` was made with weaker parameters than the ones pinned here."""
    try:
        return _HASHER.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


@functools.cache
def dummy_hash() -> str:
    """A hash of a value nobody knows, for the unknown-account branch of login.

    Verifying against it costs the same as verifying a real one, so the response time does not
    tell an attacker whether an email address has an account. Computed once, on first use, rather
    than at import, because a memory-hard hash is not something to do while a module loads.
    """
    return _HASHER.hash('unused-placeholder-for-constant-time-login')
