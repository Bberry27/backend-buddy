"""``python -m app.bootstrap`` (work package A02; ADR-0005 decision 1).

``test_A02_bootstrap_once`` is the named case: the first run creates the workspace, the owner and
the encryption-key registry row and prints a password; the second run refuses. That refusal is the
whole security property -- a bootstrap that could run twice would be an unauthenticated password
reset for the only account that can do anything.

The command is called in-process, with its ``argv``, rather than through a subprocess: it has to
be pointed at this class's throwaway database, and its settings come from the environment. The
environment is patched for the duration of the call and restored afterwards.
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

from sqlalchemy import func, select

from app import bootstrap
from app.auth import passwords
from app.models import AuditEvent, EncryptionKey, User, Workspace, WorkspaceMember

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase, unique_email  # noqa: E402


class BootstrapTests(ApiTestCase):
    @contextlib.contextmanager
    def _environment(self) -> Iterator[None]:
        """Point ``Settings.from_environment`` at this class's database and key file."""
        with mock.patch.dict(
            'os.environ',
            {
                'BB_DATABASE_URL': self.url.render_as_string(hide_password=False),
                'BB_MASTER_KEY_FILE': str(self.master_key_file),
            },
            clear=False,
        ):
            yield

    def _run(self, *argv: str) -> tuple[int, str, str]:
        """Run the command, capturing its exit code and both streams."""
        out, err = io.StringIO(), io.StringIO()
        with self._environment(), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bootstrap.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_A02_bootstrap_once(self) -> None:
        """The first run creates everything and prints the password; the second refuses."""
        email = unique_email('owner')
        code, out, err = self._run('--email', email, '--workspace-slug', 'bootstrapped')
        self.assertEqual(code, 0, err)

        password = self._printed_password(out)
        self.assertGreaterEqual(len(password), passwords.MINIMUM_LENGTH)
        self.assertIn('shown once', out)
        self.assertIn(email, out)

        with self.session() as session:
            owner = session.scalars(select(User).where(User.email == email)).one()
            workspace = session.scalars(
                select(Workspace).where(Workspace.slug == 'bootstrapped')
            ).one()
            member = session.scalars(
                select(WorkspaceMember).where(WorkspaceMember.user_id == owner.id)
            ).one()
            keys = list(session.scalars(select(EncryptionKey)))
            actions = list(session.scalars(select(AuditEvent.action).order_by(AuditEvent.id)))
        self.assertEqual(member.role, 'owner')
        self.assertEqual(member.workspace_id, workspace.id)
        self.assertTrue(owner.password_hash.startswith('$argon2id$'))
        self.assertTrue(passwords.verify_password(owner.password_hash, password))
        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0].master_key_fingerprint, self.settings.master_key_fingerprint())
        self.assertIn('workspace.create', actions)
        self.assertIn('workspace.bootstrap', actions)

        # The credential works, which is the only proof that what was printed is usable.
        response, _ = self.login(email, password, client=self.new_client())
        self.assertEqual(response.status_code, 200, response.text)

        # And the second run refuses, without touching anything.
        code, out, err = self._run('--email', unique_email('second'))
        self.assertEqual(code, bootstrap.REFUSED)
        self.assertIn('already has an account', err)
        self.assertEqual(out, '')
        with self.session() as session:
            self.assertEqual(session.scalar(select(func.count()).select_from(User)), 1)

    @staticmethod
    def _printed_password(out: str) -> str:
        line = next(line for line in out.splitlines() if line.strip().startswith('password'))
        return line.split(':', 1)[1].strip()


class BootstrapConfigurationTests(ApiTestCase):
    def test_A02_bootstrap_refuses_without_a_usable_master_key(self) -> None:
        """The registry row it writes is the fingerprint, so the key has to be readable first."""
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.dict(
                'os.environ',
                {
                    'BB_DATABASE_URL': self.url.render_as_string(hide_password=False),
                    'BB_MASTER_KEY_FILE': str(self.master_key_file.parent / 'absent'),
                },
                clear=False,
            ),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = bootstrap.main(['--email', unique_email('nokey')])
        self.assertEqual(code, bootstrap.REFUSED)
        self.assertIn('BB_MASTER_KEY_FILE', err.getvalue())
        self.assertEqual(out.getvalue(), '')

    def test_A02_bootstrap_requires_an_email(self) -> None:
        with self.assertRaises(SystemExit):
            bootstrap.main([])


if __name__ == '__main__':
    unittest.main()
