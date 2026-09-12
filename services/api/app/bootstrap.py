"""``python -m app.bootstrap``: the first owner (work package A02; ADR-0005 decision 1).

A fresh deployment has no account, and there is no self-service sign-up: this command is the only
way in, and it can be used exactly once.

    python -m app.bootstrap --email owner@example.test

What it does, in one transaction:

1. refuses if any account already exists, so it cannot be used to add a second owner or to reset
   the first one -- that would be a password reset with no authentication in front of it;
2. creates the workspace (``--workspace-slug``, ``--workspace-name``) and the owner account,
   generates a 144-bit random password, hashes it with argon2id, and makes the account the
   workspace's owner;
3. registers the master key's fingerprint in ``encryption_keys`` if the registry is empty. **This
   is the decision the A02 brief left open** (open question 3: which component creates that row).
   Bootstrap does, because it is the one step that already reads the master key and runs before
   anything else; A03's first connection write may create one if bootstrap never ran, and
   ``/readyz`` treats an empty registry as ready and a mismatching one as not ready
   (:mod:`app.routers.health`);
4. writes ``workspace.create`` and ``workspace.bootstrap`` audit rows.

The password is printed **once**, to stdout, with :func:`print` rather than through the logger --
deliberately, and in both directions: the logger would redact it (its redaction processor matches
any key named like a password), and a credential does not belong in a log file that gets shipped
to a collector. There is no second chance to read it: it is not stored anywhere in plaintext.

Exit codes: ``0`` created; ``2`` refused or misconfigured (the message says which); anything else
is an unhandled failure.
"""

from __future__ import annotations

import argparse
import secrets
import sys
import uuid
from typing import Final

from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.audit import Actor, record
from app.auth import passwords
from app.auth import users as user_store
from app.core.database import Database
from app.core.logging import configure_logging, get_logger
from app.core.settings import Settings
from app.db import ConfigError
from app.models import ALGORITHMS, EncryptionKey
from app.repositories import members as member_repository
from app.repositories import workspaces as workspace_repository

__all__ = ['REFUSED', 'main']

log = get_logger('app.bootstrap')

#: Exit code for "this deployment is already bootstrapped, or is not configured".
REFUSED: Final = 2

#: 24 URL-safe characters from 18 random bytes: 144 bits, comfortably past the policy's minimum
#: and impossible to be on a deny list.
_PASSWORD_BYTES: Final = 18


def build_parser() -> argparse.ArgumentParser:
    """The command line."""
    parser = argparse.ArgumentParser(
        prog='python -m app.bootstrap',
        description='Create the first workspace and its owner account. Runs once.',
    )
    parser.add_argument('--email', required=True, help='the owner account email address')
    parser.add_argument('--display-name', default=None, help='the owner display name')
    parser.add_argument('--workspace-slug', default='default', help='URL segment, [a-z0-9-]')
    parser.add_argument('--workspace-name', default='Default workspace', help='display name')
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command. Returns the process exit code."""
    arguments = build_parser().parse_args(argv)
    try:
        settings = Settings.from_environment()
        configure_logging(settings)
        fingerprint = settings.master_key_fingerprint()
    except ConfigError as error:
        print(f'bootstrap refused: {error}', file=sys.stderr)
        return REFUSED

    database = Database(settings)
    password = secrets.token_urlsafe(_PASSWORD_BYTES)
    # The generated password must satisfy the policy the user will face on their next change; if
    # it ever did not, that is a policy bug and it fails here rather than at first login.
    passwords.check_password_policy(
        password,
        email=arguments.email,
        denylist_file=settings.password_denylist_file,
    )

    owner_id: uuid.UUID | None = None
    workspace_id = uuid.uuid4()
    registered = False
    try:
        with database.session() as session:
            if user_store.any_user_exists(session):
                print(
                    'bootstrap refused: this deployment already has an account. Bootstrap runs '
                    'once; use the API to manage members, or restore from a backup if the owner '
                    'credential is lost.',
                    file=sys.stderr,
                )
                return REFUSED
            workspace_repository.create_workspace(
                session,
                workspace_id=workspace_id,
                slug=arguments.workspace_slug,
                name=arguments.workspace_name,
            )
            owner = user_store.create_user(
                session,
                email=arguments.email,
                password_hash=passwords.hash_password(password),
                display_name=arguments.display_name,
            )
            member_repository.add_member(
                session,
                workspace_id=workspace_id,
                user_id=owner.id,
                role='owner',
            )
            owner_id = owner.id
            registered = _register_master_key(session, fingerprint)
    except Exception as error:
        # The operator gets a sentence; the traceback goes to the log, redacted.
        print(f'bootstrap failed: {error.__class__.__name__}', file=sys.stderr)
        log.exception('bootstrap.failed')
        return REFUSED

    actor = Actor(user_id=owner_id)
    record(
        database,
        action='workspace.create',
        actor=actor,
        workspace_id=workspace_id,
        target_type='workspace',
        target_id=str(workspace_id),
        details={'slug': arguments.workspace_slug},
    )
    record(
        database,
        action='workspace.bootstrap',
        actor=actor,
        workspace_id=workspace_id,
        target_type='user',
        target_id=str(owner_id),
        details={'encryption_key_registered': registered},
    )
    _announce(arguments.email, arguments.workspace_slug, password)
    database.dispose()
    return 0


def _register_master_key(session: OrmSession, fingerprint: bytes) -> bool:
    """Record the master key's fingerprint if the registry is empty. Returns whether it did.

    The row holds the algorithm and a sha256 -- never key material (``data-model.md`` 3.9). Its
    purpose is that a restored database plus the wrong key file is caught by ``/readyz`` instead
    of by a decryption failure much later (RK-08).
    """
    existing = session.scalars(select(EncryptionKey).limit(1)).first()
    if existing is not None:
        return False
    session.add(
        EncryptionKey(algorithm=ALGORITHMS[0], master_key_fingerprint=fingerprint)
    )
    session.flush()
    return True


def _announce(email: str, slug: str, password: str) -> None:
    """Print the credential once, in a block an operator cannot miss or half-copy."""
    line = '-' * 72
    print(line)
    print('Bootstrap complete. This password is shown once and is not stored anywhere.')
    print(line)
    print(f'  workspace : {slug}')
    print(f'  email     : {email}')
    print(f'  password  : {password}')
    print(line)
    print('Store it in a password manager now: there is no recovery path for it, and')
    print('bootstrap refuses to run a second time.')


if __name__ == '__main__':
    raise SystemExit(main())
