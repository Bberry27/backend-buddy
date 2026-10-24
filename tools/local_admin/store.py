"""Local connection store: encrypted credentials on disk, no environment variables.

Work package A03 replaces this with the same behaviour behind the API's connections
router. Until then this is what makes the admin area real: a person types credentials
into a form and they persist, encrypted, on their own machine.

Design notes that are requirements, not preferences:

- The password is encrypted with AES-256-GCM under a key generated on first run and kept
  in a separate file with owner-only permissions. Losing the key file means re-entering
  credentials, which is the correct failure: it must not be recoverable from the store.
- The connection id is the additional authenticated data, so a ciphertext moved between
  records fails to decrypt rather than silently authenticating as another connection.
- Nothing here ever returns a plaintext secret to a caller that renders a page. The only
  accessor is `dsn_for`, used at the moment a connection is opened.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TLS_MODES = ('verify-full', 'verify-ca', 'require', 'prefer', 'disable')
DEFAULT_TLS = 'verify-full'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


@dataclass
class Connection:
    """One saved connection. `secret` holds ciphertext; plaintext never lives here."""

    id: str
    name: str
    host: str
    port: int
    database: str
    username: str
    tls_mode: str = DEFAULT_TLS
    ca_cert_pem: str = ''
    secret: str = ''            # base64 nonce + ciphertext
    created_at: str = field(default_factory=_now)
    last_verified_at: str = ''
    last_error: str = ''
    last_snapshot: str = ''
    server_version: str = ''

    def public(self) -> dict[str, Any]:
        """The shape safe to render. Never includes the secret or the certificate body."""
        data = asdict(self)
        data.pop('secret', None)
        data['has_secret'] = bool(self.secret)
        data['has_ca_cert'] = bool(self.ca_cert_pem)
        data.pop('ca_cert_pem', None)
        return data


class ConnectionStore:
    """Connections in a JSON file beside an owner-only key file."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.path = directory / 'connections.json'
        self.key_path = directory / 'master.key'
        directory.mkdir(parents=True, exist_ok=True)
        self._restrict(directory)

    # -- key handling ----------------------------------------------------------

    @staticmethod
    def _restrict(path: Path) -> None:
        """Owner-only permissions. A no-op on Windows, where the ACL governs instead."""
        try:
            path.chmod(stat.S_IRWXU if path.is_dir() else stat.S_IRUSR | stat.S_IWUSR)
        except (OSError, NotImplementedError):
            pass

    def _key(self) -> bytes:
        if self.key_path.exists():
            key = self.key_path.read_bytes()
            if len(key) != 32:
                raise RuntimeError(
                    f'{self.key_path} is not a 32-byte key. Delete it to start over; '
                    'saved passwords will need re-entering.'
                )
            return key
        key = AESGCM.generate_key(bit_length=256)
        self.key_path.write_bytes(key)
        self._restrict(self.key_path)
        return key

    def _encrypt(self, connection_id: str, plaintext: str) -> str:
        nonce = secrets.token_bytes(12)
        sealed = AESGCM(self._key()).encrypt(nonce, plaintext.encode(), connection_id.encode())
        return (nonce + sealed).hex()

    def _decrypt(self, connection_id: str, blob: str) -> str:
        raw = bytes.fromhex(blob)
        return AESGCM(self._key()).decrypt(raw[:12], raw[12:], connection_id.encode()).decode()

    # -- persistence -----------------------------------------------------------

    def _load(self) -> dict[str, Connection]:
        if not self.path.exists():
            return {}
        raw = json.loads(self.path.read_text(encoding='utf-8'))
        known = {f.name for f in Connection.__dataclass_fields__.values()}
        return {
            key: Connection(**{k: v for k, v in value.items() if k in known})
            for key, value in raw.items()
        }

    def _save(self, records: dict[str, Connection]) -> None:
        payload = json.dumps({k: asdict(v) for k, v in records.items()}, indent=1)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(payload, encoding='utf-8')
        temporary.replace(self.path)          # atomic, so a crash cannot truncate the store
        self._restrict(self.path)

    # -- operations ------------------------------------------------------------

    def list(self) -> list[dict[str, Any]]:
        return [c.public() for c in sorted(self._load().values(), key=lambda c: c.name.lower())]

    def get(self, connection_id: str) -> Connection | None:
        return self._load().get(connection_id)

    @staticmethod
    def _check(*, name: str, host: str, port: int, database: str, username: str,
               tls_mode: str) -> None:
        """What a saved connection must satisfy, whether it is being added or edited."""
        if tls_mode not in TLS_MODES:
            raise ValueError(f'tls_mode must be one of {", ".join(TLS_MODES)}')
        for label, value in (('name', name), ('host', host), ('database', database),
                             ('username', username)):
            if not str(value).strip():
                raise ValueError(f'{label} is required')
        if not 1 <= int(port) <= 65535:
            raise ValueError('port must be between 1 and 65535')

    def add(self, *, name: str, host: str, port: int, database: str, username: str,
            password: str, tls_mode: str = DEFAULT_TLS, ca_cert_pem: str = '') -> Connection:
        self._check(name=name, host=host, port=port, database=database, username=username,
                    tls_mode=tls_mode)
        if not str(password).strip():
            raise ValueError('password is required')

        records = self._load()
        connection_id = secrets.token_hex(8)
        entry = Connection(
            id=connection_id, name=name.strip(), host=host.strip(), port=int(port),
            database=database.strip(), username=username.strip(),
            tls_mode=tls_mode, ca_cert_pem=ca_cert_pem.strip(),
            secret=self._encrypt(connection_id, password),
        )
        records[connection_id] = entry
        self._save(records)
        return entry

    def update(self, connection_id: str, *, name: str, host: str, port: int, database: str,
               username: str, password: str = '', tls_mode: str = DEFAULT_TLS,
               ca_cert_pem: str = '', drop_ca_cert: bool = False) -> Connection:
        """Change a saved connection in place, so a typo is corrected rather than retyped.

        The two write-only fields keep what is stored unless something replaces them: an
        empty `password` keeps the encrypted one, an empty `ca_cert_pem` keeps the stored
        authority, and `drop_ca_cert` is the explicit way to remove it. Neither is ever
        rendered, so a blank field in the form means "unchanged", not "cleared".

        What was recorded about the old settings does not survive them. The verification
        outcome is cleared every time, because it vouched for the previous credentials,
        and the snapshot marker is cleared when the server, port or database changed:
        a structure populated from one database must never be presented as another's.
        """
        records = self._load()
        entry = records.get(connection_id)
        if entry is None:
            raise KeyError(connection_id)
        self._check(name=name, host=host, port=port, database=database, username=username,
                    tls_mode=tls_mode)

        retargeted = (entry.host, entry.port, entry.database) != (
            host.strip(), int(port), database.strip())
        entry.name = name.strip()
        entry.host = host.strip()
        entry.port = int(port)
        entry.database = database.strip()
        entry.username = username.strip()
        entry.tls_mode = tls_mode
        if drop_ca_cert:
            entry.ca_cert_pem = ''
        elif ca_cert_pem.strip():
            entry.ca_cert_pem = ca_cert_pem.strip()
        if password:
            entry.secret = self._encrypt(connection_id, password)
        entry.last_verified_at = ''
        entry.last_error = ''
        entry.server_version = ''
        if retargeted:
            entry.last_snapshot = ''
        self._save(records)
        return entry

    def update_status(self, connection_id: str, **fields: str) -> None:
        records = self._load()
        entry = records.get(connection_id)
        if entry is None:
            return
        for key, value in fields.items():
            if hasattr(entry, key):
                setattr(entry, key, value)
        self._save(records)

    def delete(self, connection_id: str) -> bool:
        records = self._load()
        if records.pop(connection_id, None) is None:
            return False
        self._save(records)
        return True

    def dsn_for(self, connection_id: str) -> tuple[str, str]:
        """Build a libpq connection string. Returns (dsn, ca_cert_pem).

        The only path that decrypts. Callers must not log or return the result.
        """
        entry = self._load().get(connection_id)
        if entry is None:
            raise KeyError(connection_id)
        password = self._decrypt(connection_id, entry.secret)
        parts = [
            f'host={entry.host}',
            f'port={entry.port}',
            f'dbname={entry.database}',
            f'user={entry.username}',
            f'password={password}',
            f'sslmode={entry.tls_mode}',
        ]
        return ' '.join(parts), entry.ca_cert_pem
