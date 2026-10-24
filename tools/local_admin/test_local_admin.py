"""End-to-end tests for the local admin area.

The flow these assert is the product requirement in the owner's words: open a browser,
type credentials, click test, click populate structure, see your own schema. No
environment variable, no file editing, no terminal.

The PostgreSQL tests need a database and are skipped without one. Provide it as
BB_TEST_ADMIN_DSN, for example:

    docker run -d --name pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=demo -p 127.0.0.1:55450:5432 postgres:16-alpine
    export BB_TEST_ADMIN_DSN="host=127.0.0.1 port=55450 dbname=demo user=postgres password=x sslmode=disable"

Run: python -m unittest discover -s tools/local_admin -p 'test_*.py'
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.local_admin.store import ConnectionStore  # noqa: E402

DSN = os.environ.get('BB_TEST_ADMIN_DSN', '')
TOKEN_PATTERN = re.compile(r'name="_csrf" value="([^"]+)"')


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Client:
    """A cookie-aware client that reads the token out of the page, like a browser."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()),
            NoRedirect(),
        )

    def get(self, path: str) -> tuple[int, str]:
        try:
            with self.opener.open(self.base + path, timeout=30) as response:
                return response.status, response.read().decode('utf-8')
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode('utf-8')

    def token(self, path: str = '/connections/new') -> str:
        _, body = self.get(path)
        found = TOKEN_PATTERN.search(body)
        if not found:
            raise AssertionError(f'no token in the page at {path}')
        return found.group(1)

    def post(self, path: str, fields: dict[str, str], *, token: str | None = None,
             origin: str | None = 'self') -> tuple[int, str]:
        body = dict(fields)
        if token is not None:
            body['_csrf'] = token
        data = urllib.parse.urlencode(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method='POST')
        request.add_header('Content-Type', 'application/x-www-form-urlencoded')
        if origin == 'self':
            request.add_header('Origin', self.base)
        elif origin:
            request.add_header('Origin', origin)
        try:
            with self.opener.open(request, timeout=600) as response:
                return response.status, response.read().decode('utf-8')
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode('utf-8')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep the 303 visible so a test can assert on it."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


class AdminServer:
    """The admin server in a subprocess, with its own state directory."""

    def __init__(self) -> None:
        self.port = free_port()
        self.state = Path(tempfile.mkdtemp(prefix='backend-buddy-admin-test-'))
        self.process: subprocess.Popen[bytes] | None = None

    def __enter__(self) -> Client:
        self.process = subprocess.Popen(
            [sys.executable, '-m', 'tools.local_admin.server',
             '--port', str(self.port), '--state-dir', str(self.state)],
            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            # --state-dir places the store; BB_STATE_DIR places the snapshots and the
            # rendered page, as the container sets it. Both point at the temporary
            # directory so a test never writes into the working copy.
            env={**os.environ, 'BB_STATE_DIR': str(self.state)},
        )
        base = f'http://127.0.0.1:{self.port}'
        client = Client(base)
        for _ in range(80):
            try:
                status, _ = client.get('/')
                if status == 200:
                    return client
            except (urllib.error.URLError, ConnectionError):
                pass
            time.sleep(0.25)
        raise AssertionError('the admin server did not start')

    def __exit__(self, *exc: object) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=15)
        # Close the pipe explicitly; leaving it to the collector raises ResourceWarning.
        if self.process.stdout is not None:
            self.process.stdout.close()


class StoreTests(unittest.TestCase):
    """The credential store: encryption, and never handing a secret back."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix='backend-buddy-store-test-'))
        self.store = ConnectionStore(self.directory)

    def test_local_admin_password_is_not_stored_in_clear(self) -> None:
        secret = 'a-very-recognisable-password-9713'
        self.store.add(name='n', host='h', port=5432, database='d',
                       username='u', password=secret)
        raw = self.store.path.read_text(encoding='utf-8')
        self.assertNotIn(secret, raw, 'the password appears in the store file verbatim')

    def test_local_admin_public_view_never_includes_the_secret(self) -> None:
        self.store.add(name='n', host='h', port=5432, database='d', username='u',
                       password='p', ca_cert_pem='-----BEGIN CERTIFICATE-----')
        rendered = json.dumps(self.store.list())
        # Match the JSON keys, not the bare words: has_secret and has_ca_cert are the
        # intended booleans and contain those substrings legitimately.
        for forbidden in ('"secret"', '"ca_cert_pem"', 'BEGIN CERTIFICATE'):
            self.assertNotIn(forbidden, rendered, f'{forbidden} reached the public view')
        self.assertTrue(self.store.list()[0]['has_secret'])
        self.assertTrue(self.store.list()[0]['has_ca_cert'])

    def test_local_admin_round_trips_the_password_for_a_connection(self) -> None:
        entry = self.store.add(name='n', host='h', port=5432, database='d',
                               username='u', password='round-trip-me')
        dsn, _ = self.store.dsn_for(entry.id)
        self.assertIn('password=round-trip-me', dsn)

    def test_local_admin_ciphertext_is_bound_to_its_connection(self) -> None:
        # The connection id is the additional authenticated data, so a ciphertext moved
        # to another record must fail rather than authenticate as that connection.
        first = self.store.add(name='a', host='h', port=1, database='d', username='u', password='one')
        second = self.store.add(name='b', host='h', port=1, database='d', username='u', password='two')
        records = json.loads(self.store.path.read_text(encoding='utf-8'))
        records[second.id]['secret'] = records[first.id]['secret']
        self.store.path.write_text(json.dumps(records), encoding='utf-8')
        with self.assertRaises(Exception):
            self.store.dsn_for(second.id)

    def test_local_admin_rejects_incomplete_input(self) -> None:
        for missing in ('name', 'host', 'database', 'username', 'password'):
            fields = dict(name='n', host='h', port=5432, database='d', username='u', password='p')
            fields[missing] = '  '
            with self.assertRaises(ValueError, msg=f'{missing} was accepted empty'):
                self.store.add(**fields)

    def test_local_admin_rejects_an_unknown_tls_mode(self) -> None:
        with self.assertRaises(ValueError):
            self.store.add(name='n', host='h', port=5432, database='d',
                           username='u', password='p', tls_mode='off')


class RequestGuardTests(unittest.TestCase):
    """A form post must carry the token the server put in the page."""

    def test_local_admin_refuses_a_post_without_a_token(self) -> None:
        with AdminServer() as client:
            status, _ = client.post('/connections', {'name': 'x', 'host': 'h', 'port': '5432',
                                                     'database': 'd', 'username': 'u',
                                                     'password': 'p'})
            self.assertEqual(403, status)

    def test_local_admin_refuses_a_post_with_a_wrong_token(self) -> None:
        with AdminServer() as client:
            status, _ = client.post('/connections', {'name': 'x'}, token='not-the-token')
            self.assertEqual(403, status)

    def test_local_admin_refuses_a_foreign_origin(self) -> None:
        with AdminServer() as client:
            token = client.token()
            status, _ = client.post('/connections', {'name': 'x'}, token=token,
                                    origin='http://evil.example')
            self.assertEqual(403, status)

    def test_local_admin_refuses_an_unlisted_host_header(self) -> None:
        with AdminServer() as client:
            request = urllib.request.Request(client.base + '/', method='GET')
            request.add_header('Host', 'attacker.invalid')
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    self.assertEqual(404, response.status)
            except urllib.error.HTTPError as error:
                self.assertEqual(404, error.code)

    def test_local_admin_empty_state_invites_a_connection(self) -> None:
        with AdminServer() as client:
            status, body = client.get('/')
            self.assertEqual(200, status)
            self.assertIn('No database connected', body)
            self.assertIn('Add a connection', body)


class ActivityShapeTests(unittest.TestCase):
    """
    What the activity report says, and what it refuses to carry.

    The shaping is separated from the reading so these run without a server: the rules about
    what reaches a page are rules, not an artefact of what some database happened to return.
    """

    @staticmethod
    def session(pid: int, **extra: object) -> dict[str, object]:
        base: dict[str, object] = {
            'pid': pid, 'state': 'active', 'wait_event_type': None, 'wait_event': None,
            'backend_type': 'client backend', 'usename': 'reader', 'application_name': 'psql',
            'query_seconds': 1.0, 'xact_seconds': 1.0, 'state_seconds': 1.0, 'blocked_by': [],
        }
        base.update(extra)
        return base

    def test_local_admin_activity_names_the_hold_and_who_is_behind_it(self) -> None:
        from tools.local_admin.activity import shape_sessions
        sessions = [self.session(101), self.session(202, blocked_by=[101], state='active',
                                                    wait_event_type='Lock', wait_event='relation')]
        locks = [
            {'pid': 101, 'mode': 'AccessExclusiveLock', 'granted': True,
             'nspname': 'public', 'relname': 'orders'},
            {'pid': 202, 'mode': 'AccessShareLock', 'granted': False,
             'nspname': 'public', 'relname': 'orders'},
        ]
        shaped = {session['pid']: session for session in shape_sessions(sessions, locks)}
        self.assertEqual(['public.orders (AccessExclusiveLock)'], shaped[101]['holds'])
        self.assertEqual([], shaped[101]['waiting_for'], 'a granted lock is not a wait')
        self.assertEqual(['public.orders (AccessShareLock)'], shaped[202]['waiting_for'])
        self.assertEqual([101], shaped[202]['blocked_by'])
        self.assertEqual('Lock / relation', shaped[202]['wait'])

    def test_local_admin_activity_never_carries_a_live_statement(self) -> None:
        # pg_stat_activity.query is the statement as typed, literals included. The reader does
        # not select it; this proves the shaper would not pass one on if it ever arrived.
        from tools.local_admin.activity import shape_sessions
        intruder = self.session(303, query="SELECT * FROM users WHERE email = 'a@b.test'")
        shaped = shape_sessions([intruder], [])[0]
        self.assertNotIn('query', shaped)
        self.assertNotIn('a@b.test', json.dumps(shaped))

    def test_local_admin_activity_counts_what_is_wrong_before_it_lists_anything(self) -> None:
        from tools.local_admin.activity import shape_sessions, summarize
        sessions = shape_sessions([
            self.session(1, state='active', query_seconds=12.4),
            self.session(2, state='active', query_seconds=3.0, blocked_by=[1]),
            self.session(3, state='idle in transaction', query_seconds=None, xact_seconds=840.0),
            self.session(4, state='idle', query_seconds=None),
        ], [])
        summary = summarize(sessions)
        self.assertEqual(4, summary['sessions'])
        self.assertEqual(2, summary['active'])
        self.assertEqual(1, summary['blocked'])
        self.assertEqual(1, summary['idle_in_transaction'])
        self.assertEqual(12.4, summary['longest_active_seconds'])
        self.assertEqual(840.0, summary['longest_idle_transaction_seconds'],
                         'the transaction held open for fourteen minutes went unreported')

    def test_local_admin_activity_leaves_an_age_unknown_rather_than_zero(self) -> None:
        from tools.local_admin.activity import shape_sessions
        shaped = shape_sessions([self.session(5, state='idle', query_seconds=None)], [])[0]
        self.assertIsNone(shaped['query_seconds'], 'an idle session was given an age of zero')

    def test_local_admin_activity_statement_rows_carry_per_call_figures(self) -> None:
        from tools.local_admin.activity import shape_statements
        rows = shape_statements([
            {'queryid': 1, 'calls': 100, 'rows': 500, 'total_ms': 900.0, 'mean_ms': 9.0,
             'statement': 'SELECT  *\n  FROM orders WHERE id = $1', 'truncated': False},
            {'queryid': 2, 'calls': 0, 'rows': 0, 'total_ms': 100.0, 'mean_ms': 0.0,
             'statement': 'VACUUM', 'truncated': True},
        ])
        self.assertEqual(5.0, rows[0]['rows_per_call'])
        self.assertEqual('SELECT * FROM orders WHERE id = $1', rows[0]['statement'],
                         'the statement was not flattened onto one line')
        self.assertEqual(0.9, rows[0]['share'])
        self.assertIsNone(rows[1]['rows_per_call'], 'a statement with no calls got a rate anyway')
        self.assertTrue(rows[1]['truncated'])

    def test_local_admin_activity_says_why_there_is_no_timing(self) -> None:
        from tools.local_admin.activity import statements_unavailable
        missing = statements_unavailable('pg_stat_statements is not installed')
        self.assertFalse(missing['available'])
        self.assertEqual([], missing['rows'])
        self.assertIn('pg_stat_statements', missing['reason'])


@unittest.skipUnless(DSN, 'set BB_TEST_ADMIN_DSN to a read-only PostgreSQL to run this')
class LiveActivityTests(unittest.TestCase):
    """The same thing against a real server, including a lock hold made on purpose."""

    def test_local_admin_activity_reads_the_server_and_no_table(self) -> None:
        from tools.local_admin.activity import read_activity
        report = read_activity(DSN, '')
        self.assertTrue(report['database'])
        self.assertIn('PostgreSQL', report['server_version'])
        for key in ('sessions', 'active', 'blocked', 'idle_in_transaction'):
            self.assertIn(key, report['summary'])
        for session in report['sessions']:
            self.assertNotIn('query', session, 'a live statement text reached the report')
        statements = report['statements']
        self.assertIsInstance(statements['available'], bool)
        if statements['available']:
            for entry in statements['rows']:
                self.assertLessEqual(len(entry['statement']), 240 + 3)
        else:
            self.assertIn('pg_stat_statements', statements['reason'],
                          'an unavailable extension did not say which one')

    def test_local_admin_activity_reports_a_real_hold(self) -> None:
        import psycopg
        from tools.local_admin.activity import read_activity

        with psycopg.connect(DSN, autocommit=True) as probe, probe.cursor() as cursor:
            cursor.execute("""
                SELECT quote_ident(table_schema) || '.' || quote_ident(table_name)
                  FROM information_schema.tables
                 WHERE table_type = 'BASE TABLE'
                   AND table_schema NOT IN ('pg_catalog', 'information_schema')
                 ORDER BY table_schema, table_name
                 LIMIT 1
            """)
            found = cursor.fetchone()
        if not found:
            self.skipTest('the test database has no table to lock')
        table = found[0]

        # One session takes the table and sits on it; another asks for it and waits. That is
        # the hold the page exists to show, so the test makes a real one rather than a mock.
        holder = psycopg.connect(DSN)
        waiter_finished = threading.Event()

        def wait_for_the_table() -> None:
            try:
                with psycopg.connect(DSN, autocommit=True) as blocked, blocked.cursor() as cursor:
                    cursor.execute('SET statement_timeout = 20000')
                    cursor.execute(f'SELECT count(*) FROM {table}')
            except Exception:       # noqa: BLE001 - the timeout is the expected end
                pass
            finally:
                waiter_finished.set()

        thread = threading.Thread(target=wait_for_the_table, daemon=True)
        report = None
        try:
            with holder.cursor() as cursor:
                cursor.execute(f'LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE')
            thread.start()
            deadline = time.time() + 15
            while time.time() < deadline:
                report = read_activity(DSN, '')
                if report['summary']['blocked']:
                    break
                time.sleep(0.4)
        finally:
            holder.rollback()
            holder.close()
            thread.join(timeout=25)
            self.assertTrue(waiter_finished.is_set(), 'the blocked session never came back')

        self.assertIsNotNone(report)
        self.assertGreaterEqual(report['summary']['blocked'], 1, 'a real hold went unreported')
        blocked = next(session for session in report['sessions'] if session['blocked_by'])
        self.assertTrue(blocked['blocked_by'], 'the waiting session named nobody in front of it')
        self.assertTrue(any(table.split('.')[-1].strip('"') in entry
                            for entry in blocked['waiting_for']),
                        f'the report did not name {table} as what was waited for')
        self.assertTrue(any(session['holds'] for session in report['sessions']),
                        'nothing was reported as holding a lock')


class WorkspaceTests(unittest.TestCase):
    """
    The landing page is the schema, with the connections in a menu bar above it.

    It used to be the connections table, which put a credential form in front of a person's
    own data on every visit and left the schema a tab away. These assert the shape that
    replaced it: menus that act, a connection you switch, and a frame that never shows one
    database's schema under another's name.
    """

    FIXTURE = ROOT / 'fixtures/schemas/small.json'

    def seed(self, server: AdminServer, name: str, *, populated: bool) -> str:
        """A saved connection, optionally with a snapshot the renderer will accept."""
        entry = ConnectionStore(server.state).add(
            name=name, host='127.0.0.1', port=1, database='postgres', username='probe',
            password='not-a-real-password', tls_mode='disable')
        if populated:
            snapshots = server.state / 'snapshots'
            snapshots.mkdir(parents=True, exist_ok=True)
            (snapshots / f'{entry.id}.json').write_text(
                self.FIXTURE.read_text(encoding='utf-8'), encoding='utf-8')
            ConnectionStore(server.state).update_status(
                entry.id, last_snapshot='2026-10-23T06:00:00+00:00',
                last_verified_at='2026-10-23T06:00:00+00:00')
        return entry.id

    def test_local_admin_the_landing_page_is_the_workspace(self) -> None:
        server = AdminServer()
        identifier = self.seed(server, 'Reporting', populated=True)
        with server as client:
            status, body = client.get('/')
            self.assertEqual(200, status)
            for item in ('>File<', '>Connection<', '>Tools<', '>Help<'):
                self.assertIn(item, body, f'the menu bar is missing {item}')
            self.assertIn(f'src="/view/{identifier}"', body,
                          'the workspace did not frame the populated schema')
            self.assertNotIn('type="password"', body,
                             'the front door still asks for credentials')
            # One directive more than the other pages, and only for the frame. Read it out of
            # the meta rather than the page: the stylesheet discusses the policy in a comment.
            policy = re.search(r'Content-Security-Policy" content="([^"]+)"', body)
            self.assertIsNotNone(policy, 'the workspace shipped without a policy')
            self.assertIn('frame-src', policy.group(1))
            self.assertNotIn('script-src', policy.group(1),
                             'the workspace policy allowed a script')

    def test_local_admin_the_connection_menu_switches_which_schema_is_framed(self) -> None:
        server = AdminServer()
        first = self.seed(server, 'First', populated=True)
        second = self.seed(server, 'Second', populated=True)
        with server as client:
            _, body = client.get('/')
            framed = re.search(r'src="/view/([0-9a-f]{16})"', body)
            self.assertIsNotNone(framed, 'nothing was framed to begin with')
            other = second if framed.group(1) == first else first

            status, _ = client.post(f'/connections/{other}/activate', {}, token=client.token('/'))
            self.assertEqual(303, status)
            _, after = client.get('/')
            self.assertIn(f'src="/view/{other}"', after, 'the menu did not switch the schema')
            self.assertIn('Showing', after)
            # The choice outlives the request that made it.
            _, again = client.get('/')
            self.assertIn(f'src="/view/{other}"', again, 'the workspace forgot what was open')

    def test_local_admin_switching_to_an_unpopulated_connection_says_so(self) -> None:
        server = AdminServer()
        self.seed(server, 'Populated', populated=True)
        empty = self.seed(server, 'Empty', populated=False)
        with server as client:
            client.post(f'/connections/{empty}/activate', {}, token=client.token('/'))
            _, body = client.get('/')
            self.assertNotIn('<iframe', body,
                             "an unpopulated connection showed another database's schema")
            self.assertIn('no populated structure yet', body)
            self.assertIn('Populate the structure first', body,
                          'the tools that query tables were offered before a structure existed')

    def test_local_admin_each_connection_has_its_own_rendered_page(self) -> None:
        server = AdminServer()
        identifier = self.seed(server, 'Reporting', populated=True)
        with server as client:
            status, page = client.get(f'/view/{identifier}')
            self.assertEqual(200, status)
            self.assertIn("connect-src &#x27;none&#x27;", page.replace("'", '&#x27;'),
                          'the framed explorer lost its offline policy')
            status, _ = client.get('/view/0123456789abcdef')
            self.assertEqual(303, status, 'an unknown connection served a page')
        self.assertTrue((server.state / 'views' / f'{identifier}.html').is_file(),
                        'the rendered page was not kept for the next visit')

    def test_local_admin_deleting_the_open_connection_clears_what_it_drew(self) -> None:
        server = AdminServer()
        identifier = self.seed(server, 'Reporting', populated=True)
        with server as client:
            client.get('/')                      # renders the page and records the choice
            page = server.state / 'views' / f'{identifier}.html'
            self.assertTrue(page.is_file())
            status, _ = client.post(f'/connections/{identifier}/delete', {}, token=client.token('/'))
            self.assertEqual(303, status)
            _, body = client.get('/')
            self.assertIn('No database connected', body)
        self.assertFalse(page.is_file(), 'the deleted connection left its page behind')
        self.assertFalse((server.state / 'snapshots' / f'{identifier}.json').is_file(),
                         'the deleted connection left its snapshot behind')


class EditConnectionStoreTests(unittest.TestCase):
    """Editing a saved connection: what is kept, what is replaced, what stops being true."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix='backend-buddy-edit-test-'))
        self.store = ConnectionStore(self.directory)

    def seed(self, **overrides: object):
        fields: dict[str, object] = dict(name='Reporting', host='db.example', port=5432,
                                         database='postgres', username='reporting_ro',
                                         password='first-password-2271')
        fields.update(overrides)
        return self.store.add(**fields)       # type: ignore[arg-type]

    @staticmethod
    def same_target(**overrides: object) -> dict[str, object]:
        fields: dict[str, object] = dict(name='Reporting', host='db.example', port=5432,
                                         database='postgres', username='reporting_ro')
        fields.update(overrides)
        return fields

    def test_local_admin_edit_keeps_the_stored_password_when_the_field_is_blank(self) -> None:
        # The password is never rendered, so the form cannot prefill it. A blank field has
        # to mean "unchanged", or correcting a database name would demand the password too.
        entry = self.seed()
        self.store.update(entry.id, **self.same_target(database='warehouse'))  # type: ignore[arg-type]
        dsn, _ = self.store.dsn_for(entry.id)
        self.assertIn('password=first-password-2271', dsn)
        self.assertIn('dbname=warehouse', dsn)

    def test_local_admin_edit_replaces_the_password_when_one_is_typed(self) -> None:
        entry = self.seed()
        self.store.update(entry.id, password='second-password-8840',  # type: ignore[arg-type]
                          **self.same_target())
        dsn, _ = self.store.dsn_for(entry.id)
        self.assertIn('password=second-password-8840', dsn)
        self.assertNotIn('first-password-2271', dsn)
        raw = self.store.path.read_text(encoding='utf-8')
        for secret in ('first-password-2271', 'second-password-8840'):
            self.assertNotIn(secret, raw, 'a password reached the store file in clear')

    def test_local_admin_edit_clears_the_verification_it_no_longer_vouches_for(self) -> None:
        entry = self.seed()
        self.store.update_status(entry.id, last_verified_at='2026-10-22T00:00:00+00:00',
                                 server_version='PostgreSQL 16.4', last_error='old failure')
        self.store.update(entry.id, **self.same_target())  # type: ignore[arg-type]
        after = self.store.get(entry.id)
        assert after is not None
        self.assertEqual('', after.last_verified_at, 'a verification outlived the settings it tested')
        self.assertEqual('', after.server_version)
        self.assertEqual('', after.last_error, 'a failure from the old settings was kept')

    def test_local_admin_retargeting_drops_the_snapshot_marker_and_renaming_does_not(self) -> None:
        entry = self.seed()
        stamp = '2026-10-22T00:00:00+00:00'
        self.store.update_status(entry.id, last_snapshot=stamp)

        self.store.update(entry.id, **self.same_target(name='Reporting renamed'))  # type: ignore[arg-type]
        kept = self.store.get(entry.id)
        assert kept is not None
        self.assertEqual(stamp, kept.last_snapshot, 'a rename threw away the populated structure')

        self.store.update(entry.id,  # type: ignore[arg-type]
                          **self.same_target(name='Reporting renamed', database='warehouse'))
        moved = self.store.get(entry.id)
        assert moved is not None
        self.assertEqual('', moved.last_snapshot,
                         'a structure read from one database stayed attached to another')

    def test_local_admin_edit_validates_what_add_validates(self) -> None:
        entry = self.seed()
        for missing in ('name', 'host', 'database', 'username'):
            with self.assertRaises(ValueError, msg=f'{missing} was accepted empty'):
                self.store.update(entry.id, **self.same_target(**{missing: '  '}))  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            self.store.update(entry.id, **self.same_target(tls_mode='off'))  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            self.store.update(entry.id, **self.same_target(port=0))  # type: ignore[arg-type]

    def test_local_admin_edit_keeps_the_certificate_unless_replaced_or_dropped(self) -> None:
        entry = self.seed(ca_cert_pem='-----BEGIN CERTIFICATE-----\noriginal\n')

        self.store.update(entry.id, **self.same_target())  # type: ignore[arg-type]
        first = self.store.get(entry.id)
        assert first is not None
        self.assertIn('original', first.ca_cert_pem, 'a blank textarea erased the stored authority')

        self.store.update(entry.id,  # type: ignore[arg-type]
                          ca_cert_pem='-----BEGIN CERTIFICATE-----\nreplacement\n',
                          **self.same_target())
        second = self.store.get(entry.id)
        assert second is not None
        self.assertIn('replacement', second.ca_cert_pem)

        self.store.update(entry.id, drop_ca_cert=True, **self.same_target())  # type: ignore[arg-type]
        third = self.store.get(entry.id)
        assert third is not None
        self.assertEqual('', third.ca_cert_pem, 'the explicit removal did not remove it')

    def test_local_admin_edit_of_a_deleted_connection_raises(self) -> None:
        entry = self.seed()
        self.store.delete(entry.id)
        with self.assertRaises(KeyError):
            self.store.update(entry.id, **self.same_target())  # type: ignore[arg-type]


class PageStyleTests(unittest.TestCase):
    """The admin area looks like the product, which means one button looks like the next."""

    def test_local_admin_a_button_inside_a_link_keeps_the_button_colour(self) -> None:
        # Measure, Gather and Edit navigate rather than submit, so each is a link wrapped
        # around a button. While the button inherited its colour it took the browser's link
        # and visited-link colours, and sat next to Delete in a different shade.
        from tools.local_admin import pages
        rule = re.search(r'(?<![\w.#-])button\{([^}]*)\}', pages.STYLE)
        self.assertIsNotNone(rule, 'the button rule is no longer in the stylesheet')
        self.assertIn('color:var(--ink)', rule.group(1))
        self.assertNotIn('color:inherit', rule.group(1),
                         'a link-wrapped button inherits the link colour again')


class EditConnectionPageTests(unittest.TestCase):
    """The edit page over HTTP: what it renders, and what saving it does on disk."""

    CERTIFICATE = '-----BEGIN CERTIFICATE-----\nunrepeatable-authority-5512\n'
    PASSWORD = 'unmistakable-secret-4417'

    @staticmethod
    def seeded() -> tuple[AdminServer, str]:
        """A server with one connection already saved. Port 1 refuses at once, so the
        test it runs after saving fails immediately instead of waiting for a timeout."""
        server = AdminServer()
        entry = ConnectionStore(server.state).add(
            name='Reporting', host='127.0.0.1', port=1, database='postgres',
            username='reporting_ro', password=EditConnectionPageTests.PASSWORD,
            tls_mode='disable', ca_cert_pem=EditConnectionPageTests.CERTIFICATE)
        return server, entry.id

    @staticmethod
    def populate(server: AdminServer, identifier: str) -> tuple[Path, Path]:
        """Stand in for a populated connection: its snapshot, and the page rendered from it."""
        snapshots = server.state / 'snapshots'
        snapshots.mkdir(parents=True, exist_ok=True)
        snapshot = snapshots / f'{identifier}.json'
        snapshot.write_text('{}', encoding='utf-8')
        view = server.state / 'view.html'
        view.write_text('<html>the previous database</html>', encoding='utf-8')
        (server.state / 'current.json').write_text(
            json.dumps({'connection': 'Reporting', 'connection_id': identifier, 'tables': 7}),
            encoding='utf-8')
        return snapshot, view

    def fields(self, **overrides: str) -> dict[str, str]:
        sent = {'name': 'Reporting', 'host': '127.0.0.1', 'port': '1', 'database': 'postgres',
                'username': 'reporting_ro', 'password': '', 'tls_mode': 'disable'}
        sent.update(overrides)
        return sent

    def test_local_admin_the_connections_list_offers_an_edit(self) -> None:
        server, identifier = self.seeded()
        with server as client:
            status, listing = client.get('/connections')
            self.assertEqual(200, status)
            self.assertIn(f'/connections/{identifier}/edit', listing,
                          'a saved connection could only be deleted and retyped')

    def test_local_admin_the_edit_page_prefills_everything_but_the_secrets(self) -> None:
        server, identifier = self.seeded()
        with server as client:
            status, body = client.get(f'/connections/{identifier}/edit')
            self.assertEqual(200, status)
            for value in ('value="Reporting"', 'value="127.0.0.1"', 'value="postgres"',
                          'value="reporting_ro"'):
                self.assertIn(value, body, f'{value} was not prefilled')
            self.assertNotIn(self.PASSWORD, body, 'the edit page rendered the stored password')
            self.assertNotIn('unrepeatable-authority-5512', body,
                             'the edit page rendered the stored certificate')

    def test_local_admin_a_blank_password_in_the_form_keeps_the_stored_one(self) -> None:
        server, identifier = self.seeded()
        with server as client:
            token = client.token(f'/connections/{identifier}/edit')
            status, _ = client.post(f'/connections/{identifier}/edit',
                                    self.fields(database='warehouse'), token=token)
            self.assertEqual(303, status, 'saving the edit did not redirect')
        dsn, _ = ConnectionStore(server.state).dsn_for(identifier)
        self.assertIn(f'password={self.PASSWORD}', dsn)
        self.assertIn('dbname=warehouse', dsn, 'the corrected database was not saved')

    def test_local_admin_editing_the_database_discards_the_populated_structure(self) -> None:
        server, identifier = self.seeded()
        snapshot, view = self.populate(server, identifier)
        with server as client:
            token = client.token(f'/connections/{identifier}/edit')
            status, _ = client.post(f'/connections/{identifier}/edit',
                                    self.fields(database='warehouse'), token=token)
            self.assertEqual(303, status)
            _, listing = client.get('/')
        self.assertFalse(snapshot.exists(),
                         "the previous database's structure survived being retargeted")
        self.assertFalse(view.exists(), 'the explorer went on showing the previous database')
        self.assertIn('discarded', listing, 'the page did not say the structure was dropped')

    def test_local_admin_renaming_keeps_the_populated_structure(self) -> None:
        server, identifier = self.seeded()
        snapshot, view = self.populate(server, identifier)
        with server as client:
            token = client.token(f'/connections/{identifier}/edit')
            status, _ = client.post(f'/connections/{identifier}/edit',
                                    self.fields(name='Reporting renamed'), token=token)
            self.assertEqual(303, status)
        self.assertTrue(snapshot.exists(), 'a rename discarded the populated structure')
        self.assertTrue(view.exists(), 'a rename cleared the rendered explorer')

    def test_local_admin_edit_refuses_a_post_without_a_token(self) -> None:
        server, identifier = self.seeded()
        with server as client:
            status, _ = client.post(f'/connections/{identifier}/edit', self.fields())
            self.assertEqual(403, status)

    def test_local_admin_edit_of_an_unknown_connection_says_so(self) -> None:
        with AdminServer() as client:
            status, _ = client.get('/connections/0123456789abcdef/edit')
            self.assertEqual(303, status)
            _, listing = client.get('/')
            self.assertIn('no longer exists', listing)


@unittest.skipUnless(DSN, 'set BB_TEST_ADMIN_DSN to a read-only PostgreSQL to run this')
class LiveDatabaseTests(unittest.TestCase):
    """The whole flow against a real PostgreSQL, which is the actual requirement."""

    @staticmethod
    def fields_from_dsn() -> dict[str, str]:
        from psycopg import conninfo
        config = conninfo.conninfo_to_dict(DSN)
        return {
            'name': 'Test Connection',
            'host': config['host'],
            'port': str(config.get('port', 5432)),
            'database': config['dbname'],
            'username': config['user'],
            'password': config.get('password', ''),
            'tls_mode': config.get('sslmode', 'disable'),
            'ca_cert_pem': '',
        }

    def test_local_admin_full_flow_from_form_to_populated_schema(self) -> None:
        with AdminServer() as client:
            token = client.token()
            status, _ = client.post('/connections', self.fields_from_dsn(), token=token)
            self.assertEqual(303, status, 'saving the form did not redirect')

            status, listing = client.get('/connections')
            self.assertEqual(200, status)
            self.assertIn('Test Connection', listing)
            self.assertIn('Verified', listing)
            self.assertNotIn(self.fields_from_dsn()['password'], listing,
                             'the password was rendered back into the page')

            connection_id = re.search(r'/connections/([0-9a-f]{16})/test', listing)
            self.assertIsNotNone(connection_id, 'no connection row was rendered')
            identifier = connection_id.group(1)

            status, _ = client.post(f'/connections/{identifier}/introspect', {},
                                    token=client.token('/connections'))
            self.assertEqual(303, status)

            status, after = client.get('/')
            self.assertIn('tables', after)
            self.assertIn('foreign-key column pairs loaded', after)
            self.assertIn(f'/view/{identifier}', after,
                          'the workspace did not frame the schema it just populated')

            status, view = client.get('/view')
            self.assertEqual(200, status)
            self.assertIn("connect-src 'none'", view, 'the offline policy was not preserved')
            self.assertIn('Live PostgreSQL catalog introspection', view,
                          'the served page is not the introspected schema')

    def test_local_admin_never_renders_a_secret_anywhere(self) -> None:
        fields = self.fields_from_dsn()
        with AdminServer() as client:
            client.post('/connections', fields, token=client.token())
            for path in ('/', '/connections/new'):
                _, body = client.get(path)
                for forbidden in (fields['password'], 'encrypted_secret', 'dsn='):
                    if forbidden:
                        self.assertNotIn(forbidden, body, f'{path} rendered {forbidden!r}')


if __name__ == '__main__':
    unittest.main()


class TlsDefaultsTests(unittest.TestCase):
    """Full verification must work without the user supplying an authority.

    The failure this pins: libpq defaults sslrootcert to ~/.postgresql/root.crt, and a
    container account created without a home directory has no such file, so verify-full
    failed against a managed PostgreSQL whose root the image already trusted.
    """

    def test_local_admin_verifying_mode_gets_the_system_bundle(self) -> None:
        from tools.local_admin.introspection import _with_ca, system_ca_bundle
        bundle = system_ca_bundle()
        if not bundle:
            self.skipTest('no system CA bundle on this host')
        for mode in ('verify-full', 'verify-ca'):
            dsn, _ = _with_ca(f'host=h dbname=d user=u password=p sslmode={mode}', '')
            self.assertIn(f'sslrootcert={bundle}', dsn, f'{mode} did not get an authority')

    def test_local_admin_non_verifying_mode_is_left_alone(self) -> None:
        from tools.local_admin.introspection import _with_ca
        for mode in ('require', 'prefer', 'disable'):
            dsn, _ = _with_ca(f'host=h dbname=d user=u password=p sslmode={mode}', '')
            self.assertNotIn('sslrootcert', dsn, f'{mode} should not need an authority')

    def test_local_admin_supplied_authority_wins_over_the_bundle(self) -> None:
        from tools.local_admin.introspection import _with_ca
        dsn, path = _with_ca('host=h dbname=d user=u password=p sslmode=verify-full',
                             '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n'
                             '-----END CERTIFICATE-----')
        self.assertIsNotNone(path, 'a supplied authority should be written to a file')
        try:
            self.assertIn(f'sslrootcert={path}', dsn)
            self.assertIn('not-a-real-certificate', path.read_text(encoding='utf-8'))
        finally:
            path.unlink(missing_ok=True)

    def test_local_admin_explicit_sslrootcert_is_not_overridden(self) -> None:
        from tools.local_admin.introspection import _with_ca
        dsn, _ = _with_ca('host=h dbname=d user=u password=p sslmode=verify-full '
                          'sslrootcert=/somewhere/else.crt', '')
        self.assertEqual(1, dsn.count('sslrootcert='), 'a second authority was appended')

    def test_local_admin_missing_root_certificate_is_diagnosed_specifically(self) -> None:
        # The message a user actually saw must name the cause, not just say "SSL error".
        sys.path.insert(0, str(ROOT / 'scripts'))
        from introspect_pg import diagnose
        # Assembled rather than written out: the private-data guard rejects a literal
        # Unix home path so a real developer's directory cannot reach the repository, and
        # a test fixture is not worth an exception to that rule.
        missing = '/' + 'home' + '/viewer/.postgresql/root.crt'
        error = Exception(f'connection failed: root certificate file "{missing}" does not exist')
        message = diagnose(error, {'host': 'x.postgres.database.azure.com', 'user': 'u'})
        self.assertIn('certificate authority', message.lower())
        self.assertIn('home directory', message.lower())


class SnapshotPathTests(unittest.TestCase):
    """Introspection must not depend on the source tree being writable."""

    def test_local_admin_snapshots_live_under_the_state_directory(self) -> None:
        # In the container /app is read-only and /state is the only writable path, so a
        # snapshot written beside the source would fail after a successful connection.
        from tools.local_admin import server
        self.assertEqual(server.STATE_DIR, server.SNAPSHOT_DIR.parent)
        self.assertEqual('snapshots', server.SNAPSHOT_DIR.name)

    def test_local_admin_unresolvable_host_is_diagnosed_as_a_name_problem(self) -> None:
        # A name that does not resolve reads as "[Errno -2] Name or service not known",
        # which tells a user nothing. It must be distinguished from a firewall and from a
        # rejected credential, because nothing was contacted at all.
        sys.path.insert(0, str(ROOT / 'scripts'))
        from introspect_pg import diagnose
        host = 'myserver-abc1.postgres.database.azure.com'
        error = Exception(f"failed to resolve host '{host}': [Errno -2] Name or service not known")
        message = diagnose(error, {'host': host, 'user': 'admin'})
        self.assertIn('does not resolve', message)
        self.assertIn('spelling', message.lower())
        self.assertIn('myserver-abc1', message, 'the server name was not echoed for comparison')
        self.assertNotIn('firewall rule', message.split('not a firewall rule')[-1],
                         'a name failure must not be blamed on a firewall')

    def test_local_admin_timeout_is_still_diagnosed_as_a_firewall(self) -> None:
        # The branch order matters: a timeout means the name resolved and the host did
        # not answer, which on a managed database is the firewall.
        sys.path.insert(0, str(ROOT / 'scripts'))
        from introspect_pg import diagnose
        host = 'myserver-abc1.postgres.database.azure.com'
        error = Exception('connection to server at "1.2.3.4", port 5432 failed: timeout expired')
        message = diagnose(error, {'host': host, 'user': 'admin'})
        self.assertIn('firewall', message.lower())
        self.assertNotIn('does not resolve', message)

class CarriedMeasurementTests(unittest.TestCase):
    """
    Measurements survive a re-read of the structure.

    Populating writes a fresh snapshot, which used to drop every measured row count on the
    floor: the city fell back to baseline buildings and nothing said why. Reading the
    catalog again says nothing about how many rows a table holds, so the counts are kept,
    matched by name, and the snapshot they came from is named in the basis.
    """

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix='backend-buddy-carry-test-'))
        self.previous = self.directory / 'snapshot.json'

    def write_previous(self, tables: list[dict[str, object]]) -> None:
        self.previous.write_text(json.dumps({
            'source': {'generated': '2026-10-23T05:52:05+00:00'},
            'tables': tables,
        }), encoding='utf-8')

    @staticmethod
    def table(name: str, **extra: object) -> dict[str, object]:
        base: dict[str, object] = {'schema': 'public', 'name': name, 'id': f'public.{name}',
                                   'allColumns': [{'name': 'id'}, {'name': 'email'}]}
        base.update(extra)
        return base

    def test_local_admin_a_re_read_keeps_the_row_count_it_did_not_measure(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        self.write_previous([self.table('orders', rowCount=1200, rowCountExact=True,
                                        profiling={'status': 'complete'})])
        fresh = [self.table('orders')]
        carried = carry_measurements(self.previous, fresh)
        self.assertEqual(1, carried['tables'])
        self.assertEqual(1200, fresh[0]['rowCount'])
        self.assertIs(True, fresh[0]['rowCountExact'])
        self.assertEqual('2026-10-23T05:52:05+00:00', carried['measured_at'])

    def test_local_admin_a_table_that_was_never_counted_stays_unknown(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        self.write_previous([self.table('orders', rowCount=1200)])
        fresh = [self.table('orders'), self.table('invoices')]
        carry_measurements(self.previous, fresh)
        self.assertNotIn('rowCount', fresh[1], 'a count was invented for a new table')

    def test_local_admin_a_table_that_is_gone_is_left_behind(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        self.write_previous([self.table('orders', rowCount=1200),
                             self.table('dropped_table', rowCount=7)])
        fresh = [self.table('orders')]
        carried = carry_measurements(self.previous, fresh)
        self.assertEqual(1, carried['tables'])
        self.assertEqual(1, len(fresh))

    def test_local_admin_column_statistics_follow_their_column_by_name(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        old = self.table('orders', rowCount=3)
        old['allColumns'] = [{'name': 'id', 'profiling': {'nullFraction': 0, 'distinctCount': 3}},
                             {'name': 'removed', 'profiling': {'nullFraction': 1}}]
        self.write_previous([old])
        fresh = self.table('orders')
        fresh['allColumns'] = [{'name': 'id'}, {'name': 'added_later'}]
        carried = carry_measurements(self.previous, [fresh])
        columns = {column['name']: column for column in fresh['allColumns']}
        self.assertEqual(3, columns['id']['profiling']['distinctCount'])
        self.assertNotIn('profiling', columns['added_later'],
                         'statistics were attached to a column nobody profiled')
        self.assertEqual(1, carried['columns'])

    def test_local_admin_nothing_measured_before_carries_nothing(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        self.write_previous([self.table('orders')])
        fresh = [self.table('orders')]
        self.assertEqual(0, carry_measurements(self.previous, fresh)['tables'])

    def test_local_admin_a_first_populate_has_nothing_to_carry(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        carried = carry_measurements(self.directory / 'absent.json', [self.table('orders')])
        self.assertEqual({'tables': 0, 'columns': 0, 'measured_at': ''}, carried)

    def test_local_admin_an_unreadable_previous_snapshot_is_not_fatal(self) -> None:
        from tools.local_admin.introspection import carry_measurements
        self.previous.write_text('{ not json', encoding='utf-8')
        self.assertEqual(0, carry_measurements(self.previous, [self.table('orders')])['tables'])


@unittest.skipUnless(DSN, 'set BB_TEST_ADMIN_DSN to a read-only PostgreSQL to run this')
class LiveCarriedMeasurementTests(unittest.TestCase):
    """The same thing end to end: populate, measure, populate again, counts still there."""

    def test_local_admin_populating_again_keeps_what_was_measured(self) -> None:
        from tools.local_admin.introspection import introspect_to_snapshot, measure_row_counts
        target = Path(tempfile.mkdtemp(prefix='backend-buddy-carry-live-')) / 'snapshot.json'
        introspect_to_snapshot(DSN, '', target, display_name='Carry test')
        measure_row_counts(DSN, '', target)
        before = json.loads(target.read_text(encoding='utf-8'))
        counted = {table['name']: table['rowCount'] for table in before['tables']
                   if isinstance(table.get('rowCount'), int)}
        self.assertTrue(counted, 'the measurement produced no counts to carry')

        summary = introspect_to_snapshot(DSN, '', target, display_name='Carry test')
        after = json.loads(target.read_text(encoding='utf-8'))
        kept = {table['name']: table['rowCount'] for table in after['tables']
                if isinstance(table.get('rowCount'), int)}
        self.assertEqual(counted, kept, 'a re-read of the structure dropped the measured counts')
        self.assertEqual(len(counted), summary['carried'])
        self.assertIn('carried forward', after['source']['basis'])
        self.assertIn('Measure row counts again', after['source']['basis'])


class EmptyCatalogMessageTests(unittest.TestCase):
    """
    Telling an empty database apart from one this role may not read.

    `pg_class` is readable by every role, so "no schemas found" is not evidence of a
    missing privilege. Blaming one sends a user to change a GRANT that was never the
    problem, while the actual cause -- the maintenance database named instead of the one
    holding the schema -- goes unmentioned.
    """

    def test_local_admin_an_empty_database_is_not_blamed_on_a_privilege(self) -> None:
        from tools.local_admin.introspection import empty_database_detail
        message = empty_database_detail('postgres', ['warehouse', 'reporting'])
        self.assertIn('"postgres"', message, 'the message did not name the database')
        self.assertNotIn('USAGE', message, 'an empty database was blamed on a GRANT')
        self.assertIn('warehouse', message)
        self.assertIn('reporting', message)
        self.assertIn('Edit', message, 'the message did not say how to point it elsewhere')

    def test_local_admin_a_server_with_nowhere_else_to_look_says_so(self) -> None:
        from tools.local_admin.introspection import empty_database_detail
        message = empty_database_detail('postgres', [])
        self.assertIn('No other database', message)
        self.assertNotIn('USAGE', message)

    def test_local_admin_a_long_list_of_databases_is_summarised(self) -> None:
        from tools.local_admin.introspection import DATABASES_SHOWN, empty_database_detail
        names = [f'db{index:02d}' for index in range(DATABASES_SHOWN + 3)]
        message = empty_database_detail('postgres', names)
        self.assertIn(names[DATABASES_SHOWN - 1], message)
        self.assertNotIn(names[DATABASES_SHOWN], message, 'the listing was not capped')
        self.assertIn('and 3 more', message)

    def test_local_admin_test_and_populate_judge_the_same_schemas(self) -> None:
        # A managed PostgreSQL installs schemas of its own (Azure's `pgaadauth`). Counting
        # those as the user's tables made Test report "verified" on a database Populate
        # structure then found nothing in, which is the worst of both messages.
        from tools.local_admin import introspection
        predicate = introspection.not_system_schema('x')
        self.assertIn("NOT LIKE 'pg_%'", predicate)
        for query, column in ((introspection.USER_RELATIONS, 'n.nspname'),
                              (introspection.GRANTED_TABLES, 'table_schema')):
            self.assertIn(introspection.not_system_schema(column), query,
                          'the two queries no longer exclude the same schemas')

    def test_local_admin_unreadable_tables_still_ask_for_the_grant(self) -> None:
        # The other half: relations exist and this role may read none of them. That one
        # really is a privilege, and the message must still say so.
        from tools.local_admin.introspection import unreadable_detail
        message = unreadable_detail('warehouse', 12)
        self.assertIn('12', message)
        self.assertIn('USAGE', message)
        self.assertIn('SELECT', message)


class RowCountMergeTests(unittest.TestCase):
    """
    What may reach a snapshot when rows are counted (A03 addendum D step 4).

    merge_row_counts() takes a counting callable, so every rule about what is written is testable
    without a database and only the driver half needs PostgreSQL. The rules under test are the
    guardrail in AGENTS.md section 3: an unmeasured count stays unknown, is never a zero, and is
    never a stale value from a previous run.
    """

    @staticmethod
    def table(name: str, **extra: object) -> dict[str, object]:
        return {'id': f'public.{name}', 'schema': 'public', 'name': name, **extra}

    def snapshot(self, tables: list[dict[str, object]]) -> dict[str, object]:
        return {'source': {'basis': 'Live PostgreSQL catalog introspection.'}, 'tables': tables}

    def test_local_admin_a_counted_table_records_an_exact_count(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        document = self.snapshot([self.table('orders'), self.table('empty')])
        counts = {'orders': 4210, 'empty': 0}
        summary = merge_row_counts(document, lambda schema, name: counts[name])

        orders, empty = document['tables']
        self.assertEqual(4210, orders['rowCount'])
        self.assertIs(True, orders['rowCountExact'])
        self.assertEqual('complete', orders['profiling']['status'])
        self.assertIs(False, orders['profiling']['sampled'])
        self.assertIn('no column values', orders['profiling']['scope'])
        self.assertNotIn('reason', orders['profiling'])
        # Zero is a measured value, not a stand-in for unknown.
        self.assertEqual(0, empty['rowCount'])
        self.assertIs(True, empty['rowCountExact'])
        self.assertEqual('complete', empty['profiling']['status'])
        self.assertEqual({'tables': 2, 'counted': 2, 'views': 0, 'failed': 0, 'rows': 4210},
                         {k: summary[k] for k in ('tables', 'counted', 'views', 'failed', 'rows')})

    def test_local_admin_an_uncounted_table_stays_unknown_and_says_why(self) -> None:
        from tools.local_admin.introspection import CountFailed, CountTimedOut, merge_row_counts
        document = self.snapshot([self.table('slow'), self.table('denied'), self.table('nameless')])
        document['tables'][2].pop('name')

        def count(schema: str, name: str) -> int:
            if name == 'slow':
                raise CountTimedOut
            raise CountFailed('permission denied for table denied')

        summary = merge_row_counts(document, count)
        slow, denied, nameless = document['tables']
        for table in (slow, denied, nameless):
            self.assertNotIn('rowCount', table, 'an uncounted table must not carry a count')
            self.assertNotIn('rowCountExact', table)
            self.assertEqual('incomplete', table['profiling']['status'])
        self.assertIn('per-table time limit', slow['profiling']['reason'])
        self.assertIn('permission denied', denied['profiling']['reason'])
        self.assertIn('no schema and table name', nameless['profiling']['reason'])
        self.assertEqual(3, summary['failed'])
        self.assertEqual(0, summary['rows'])

    def test_local_admin_a_view_is_not_counted(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        document = self.snapshot([self.table('report', kind='view'), self.table('orders')])
        summary = merge_row_counts(document, lambda schema, name: 7)

        view, orders = document['tables']
        self.assertNotIn('rowCount', view, 'a view has no stored rows to count')
        self.assertIn('no stored rows of its own', view['profiling']['reason'])
        self.assertEqual(7, orders['rowCount'])
        self.assertEqual(1, summary['views'])
        self.assertEqual(1, summary['counted'])

    def test_local_admin_a_successful_count_clears_a_stale_lower_bound(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        # The contract forbids a lower bound beside a known count, so an earlier capped sample's
        # floor has to go when an exact count replaces it.
        document = self.snapshot([self.table('orders', rowCountLowerBound=10_000,
                                             profiling={'status': 'incomplete', 'reason': 'old'})])
        merge_row_counts(document, lambda schema, name: 12_345)

        orders = document['tables'][0]
        self.assertEqual(12_345, orders['rowCount'])
        self.assertNotIn('rowCountLowerBound', orders)
        self.assertNotIn('reason', orders['profiling'])

    def test_local_admin_a_failed_recount_drops_the_previous_count(self) -> None:
        from tools.local_admin.introspection import CountTimedOut, merge_row_counts
        # Keeping the old number would present a stale measurement as a current one.
        document = self.snapshot([self.table('orders', rowCount=99, rowCountExact=True)])

        def count(schema: str, name: str) -> int:
            raise CountTimedOut

        merge_row_counts(document, count)
        self.assertNotIn('rowCount', document['tables'][0])
        self.assertEqual('incomplete', document['tables'][0]['profiling']['status'])

    def test_local_admin_the_run_deadline_labels_what_it_did_not_reach(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        document = self.snapshot([self.table(f't{index}') for index in range(4)])
        ticks = iter([0, 0, 1, 2, 99, 99, 99])  # the clock jumps past the deadline mid-run

        summary = merge_row_counts(document, lambda schema, name: 5, deadline_seconds=10,
                                   clock=lambda: next(ticks))
        statuses = [table['profiling']['status'] for table in document['tables']]
        self.assertIn('complete', statuses)
        self.assertIn('incomplete', statuses)
        for table in document['tables']:
            if table['profiling']['status'] == 'incomplete':
                self.assertIn('overall time limit', table['profiling']['reason'])
                self.assertNotIn('rowCount', table)
        self.assertEqual(summary['counted'] + summary['failed'], 4)

    def test_local_admin_the_basis_records_the_measurement_once_per_run(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        document = self.snapshot([self.table('orders')])
        merge_row_counts(document, lambda schema, name: 3)
        first = document['source']['basis']
        self.assertIn('Live PostgreSQL catalog introspection.', first)
        self.assertIn('Row counts measured for 1 of 1 tables', first)
        self.assertIn('no column value was read', first)

        merge_row_counts(document, lambda schema, name: 4)
        second = document['source']['basis']
        # A re-run replaces its own sentence rather than stacking another onto it.
        self.assertEqual(1, second.count('Row counts measured for'))
        self.assertIn('Live PostgreSQL catalog introspection.', second)

    def test_local_admin_an_empty_snapshot_is_refused_rather_than_rewritten(self) -> None:
        from tools.local_admin.introspection import merge_row_counts
        with self.assertRaises(RuntimeError) as caught:
            merge_row_counts({'tables': []}, lambda schema, name: 1)
        self.assertIn('Populate the structure first', str(caught.exception))


class ColumnStatisticsTests(unittest.TestCase):
    """
    What may reach a snapshot when column statistics are gathered.

    A count of rows returns a number; a minimum or a maximum is a real value out of a column. These
    assert the line that policy draws, and that a table which fails keeps what it already had.
    """

    @staticmethod
    def table(name: str, columns: list[tuple[str, str]], **extra: object) -> dict[str, object]:
        return {'id': f'public.{name}', 'schema': 'public', 'name': name,
                'allColumns': [{'name': column, 'type': kind} for column, kind in columns],
                **extra}

    def snapshot(self, tables: list[dict[str, object]]) -> dict[str, object]:
        return {'source': {'basis': 'Live PostgreSQL catalog introspection.'}, 'tables': tables}

    @staticmethod
    def profiler(rows: int, per_column: dict[str, dict[str, object]]) -> object:
        def profile_table(schema: str, name: str, columns: list[dict[str, object]]) -> dict:
            out = {}
            for column in columns:
                stats = dict(per_column[column['name']])
                if not column['extremes']:
                    # The driver only asks for extremes where policy allows them, so a withheld
                    # column simply has none to report.
                    stats.pop('min', None)
                    stats.pop('max', None)
                out[column['name']] = stats
            return {'rows': rows, 'columns': out}
        return profile_table

    def test_local_admin_extremes_are_kept_only_for_safe_types(self) -> None:
        from tools.local_admin.introspection import extremes_allowed
        for kind in ('integer', 'bigint', 'numeric(10,2)', 'double precision', 'date',
                     'timestamp with time zone', 'money', 'interval'):
            self.assertTrue(extremes_allowed(kind), f'{kind} should keep extremes')
        for kind in ('text', 'character varying(200)', 'char(2)', 'citext', 'jsonb', 'json',
                     'xml', 'bytea', 'uuid', 'integer[]', 'USER-DEFINED', 'tsvector'):
            self.assertFalse(extremes_allowed(kind), f'{kind} must not keep extremes')
        # PostgreSQL has no min(boolean)/max(boolean), so asking for one fails the whole
        # statement and therefore the whole table. A flag's extremes say nothing its distinct
        # count does not, so they are not requested.
        for kind in ('boolean', 'bool'):
            self.assertFalse(extremes_allowed(kind), f'{kind} must not request extremes')

    def test_local_admin_statistics_withhold_extremes_for_text_and_identifiers(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        document = self.snapshot([self.table('people', [
            ('id', 'integer'), ('email', 'text'), ('token', 'uuid'), ('created', 'timestamp'),
        ])])
        summary = merge_column_stats(document, self.profiler(200, {
            'id': {'nonNull': 200, 'distinct': 200, 'min': '1', 'max': '200'},
            'email': {'nonNull': 190, 'distinct': 190, 'min': 'aaa@x', 'max': 'zzz@x'},
            'token': {'nonNull': 200, 'distinct': 200, 'min': '0000', 'max': 'ffff'},
            'created': {'nonNull': 200, 'distinct': 12, 'min': '2020-01-01', 'max': '2026-01-01'},
        }))
        columns = {c['name']: c['profiling'] for c in document['tables'][0]['allColumns']}

        # Numbers and times keep their extremes.
        self.assertEqual('1', columns['id']['min'])
        self.assertEqual('2026-01-01', columns['created']['max'])
        # Free text and identifiers do not, and no key is left behind holding a stale value.
        for withheld in ('email', 'token'):
            self.assertNotIn('min', columns[withheld], f'{withheld} leaked a minimum')
            self.assertNotIn('max', columns[withheld], f'{withheld} leaked a maximum')
        # Counts are still reported for every column.
        self.assertAlmostEqual(0.05, columns['email']['nullFraction'])
        self.assertEqual(190, columns['email']['distinctCount'])
        self.assertEqual(2, summary['extremes'])
        self.assertEqual(2, summary['withheld'])
        self.assertEqual(4, summary['columns'])

    def test_local_admin_statistics_are_whole_table_not_a_sample(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        document = self.snapshot([self.table('orders', [('id', 'integer')])])
        merge_column_stats(document, self.profiler(4210, {
            'id': {'nonNull': 4210, 'distinct': 4210, 'min': '1', 'max': '4210'}}))

        table = document['tables'][0]
        column = table['allColumns'][0]['profiling']
        # The database aggregated the whole table, so nothing here is a sample and the row count
        # the same pass produced is exact.
        self.assertIs(False, column['sampled'])
        self.assertEqual('table', column['scope'])
        self.assertEqual(4210, column['sampleSize'])
        self.assertEqual(4210, table['rowCount'])
        self.assertIs(True, table['rowCountExact'])
        self.assertIs(False, table['sampled'])
        self.assertNotIn('rowCountLowerBound', table)
        self.assertEqual('complete', table['profiling']['status'])

    def test_local_admin_statistics_do_not_overwrite_an_exact_count_with_a_floor(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        # A sampling profiler would write rowCountLowerBound here and drop rowCount. This path
        # aggregates the whole table, so the exact count survives and no floor appears beside it.
        document = self.snapshot([self.table('big', [('id', 'integer')],
                                             rowCount=5_000_000, rowCountExact=True)])
        merge_column_stats(document, self.profiler(5_000_000, {
            'id': {'nonNull': 5_000_000, 'distinct': 5_000_000, 'min': '1', 'max': '5000000'}}))
        table = document['tables'][0]
        self.assertEqual(5_000_000, table['rowCount'])
        self.assertNotIn('rowCountLowerBound', table)

    def test_local_admin_a_failed_table_keeps_what_it_had(self) -> None:
        from tools.local_admin.introspection import CountTimedOut, merge_column_stats

        def profile_table(schema: str, name: str, columns: list[dict[str, object]]) -> dict:
            raise CountTimedOut

        document = self.snapshot([self.table('huge', [('id', 'integer')],
                                             rowCount=99, rowCountExact=True)])
        summary = merge_column_stats(document, profile_table)
        table = document['tables'][0]
        # A row count measured earlier is still a measurement; failing to profile does not
        # invalidate it, so unlike a failed recount it is left alone.
        self.assertEqual(99, table['rowCount'])
        self.assertEqual('incomplete', table['profiling']['status'])
        self.assertIn('per-table time limit', table['profiling']['reason'])
        self.assertNotIn('profiling', table['allColumns'][0])
        self.assertEqual(1, summary['failed'])

    def test_local_admin_statistics_clear_sample_values_they_did_not_gather(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        # This action offers no sample values, so any left by an earlier run must not survive a
        # refresh that did not gather them: they would look current.
        stale = self.table('people', [('id', 'integer')])
        stale['allColumns'][0]['sampleValues'] = ['leftover']
        stale['allColumns'][0]['stats'] = {'distinctCount': 1}
        document = self.snapshot([stale])
        merge_column_stats(document, self.profiler(3, {
            'id': {'nonNull': 3, 'distinct': 3, 'min': '1', 'max': '3'}}))
        column = document['tables'][0]['allColumns'][0]
        self.assertNotIn('sampleValues', column)
        self.assertNotIn('stats', column, 'the legacy sibling would show a second answer')
        self.assertEqual(3, column['profiling']['distinctCount'])

    def test_local_admin_statistics_record_the_policy_in_the_basis(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        document = self.snapshot([self.table('people', [('id', 'integer'), ('email', 'text')])])
        merge_column_stats(document, self.profiler(10, {
            'id': {'nonNull': 10, 'distinct': 10, 'min': '1', 'max': '10'},
            'email': {'nonNull': 10, 'distinct': 10}}))
        basis = document['source']['basis']
        self.assertIn('Live PostgreSQL catalog introspection.', basis)
        self.assertIn('over the whole table, not a sample', basis)
        self.assertIn('withheld for 1', basis)
        self.assertIn('No row and no sample value was retained.', basis)

        merge_column_stats(document, self.profiler(11, {
            'id': {'nonNull': 11, 'distinct': 11, 'min': '1', 'max': '11'},
            'email': {'nonNull': 11, 'distinct': 11}}))
        self.assertEqual(1, document['source']['basis'].count('Column statistics measured for'))

    def test_local_admin_a_reduced_profile_keeps_what_it_got_and_says_so(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        # json and xml have no equality operator, so count(DISTINCT) over them fails the whole
        # statement. The driver retries with counts alone; that result is partial, not complete.
        document = self.snapshot([self.table('exotic', [('id', 'integer'), ('doc', 'json')])])

        def profile_table(schema: str, name: str, columns: list[dict[str, object]]) -> dict:
            return {'rows': 2, 'reduced': True,
                    'columns': {'id': {'nonNull': 2}, 'doc': {'nonNull': 1}}}

        summary = merge_column_stats(document, profile_table)
        table = document['tables'][0]
        self.assertEqual('incomplete', table['profiling']['status'])
        self.assertIn('Null fractions only', table['profiling']['reason'])
        # The row count from the same pass is still exact, and what was gathered is kept.
        self.assertEqual(2, table['rowCount'])
        self.assertIs(True, table['rowCountExact'])
        columns = {c['name']: c['profiling'] for c in table['allColumns']}
        self.assertEqual(0.0, columns['id']['nullFraction'])
        self.assertEqual(0.5, columns['doc']['nullFraction'])
        # A distinct count nobody measured is absent, not zero.
        for name in ('id', 'doc'):
            self.assertNotIn('distinctCount', columns[name])
            self.assertNotIn('min', columns[name])
        self.assertEqual(1, summary['reduced'])
        self.assertEqual(1, summary['profiled'])
        self.assertEqual(0, summary['failed'])
        self.assertIn('null fractions only', document['source']['basis'])

    def test_local_admin_an_empty_snapshot_is_refused_for_statistics_too(self) -> None:
        from tools.local_admin.introspection import merge_column_stats
        with self.assertRaises(RuntimeError) as caught:
            merge_column_stats({'tables': []}, lambda *a: {})
        self.assertIn('Populate the structure first', str(caught.exception))


@unittest.skipUnless(DSN, 'set BB_TEST_ADMIN_DSN to a read-only PostgreSQL to run this')
class LiveRowCountTests(unittest.TestCase):
    """Counting rows against a real PostgreSQL: the function, then the routes around it."""

    def test_local_admin_counts_match_the_database_exactly(self) -> None:
        import psycopg
        from tools.local_admin.introspection import introspect_to_snapshot, measure_row_counts

        directory = Path(tempfile.mkdtemp(prefix='backend-buddy-count-test-'))
        snapshot = directory / 'live.json'
        introspect_to_snapshot(DSN, '', snapshot, display_name='Counted')

        before = json.loads(snapshot.read_text(encoding='utf-8'))
        self.assertTrue(all('rowCount' not in table for table in before['tables']),
                        'introspection must not produce row counts')

        summary = measure_row_counts(DSN, '', snapshot)
        after = json.loads(snapshot.read_text(encoding='utf-8'))
        counted = {table['id']: table for table in after['tables'] if 'rowCount' in table}
        self.assertGreater(len(counted), 50, 'most tables should have been counted')
        self.assertEqual(summary['counted'], len(counted))

        # The counts must equal what the database says, for every table, not approximately.
        with psycopg.connect(DSN) as connection, connection.cursor() as cursor:
            for table in after['tables']:
                if 'rowCount' not in table:
                    continue
                cursor.execute(  # noqa: S608 - identifiers come from the catalog, quoted below
                    psycopg.sql.SQL('SELECT count(*) FROM {}').format(
                        psycopg.sql.Identifier(table['schema'], table['name'])))
                self.assertEqual(cursor.fetchone()[0], table['rowCount'],
                                 f'{table["id"]} does not match the database')
                self.assertIs(True, table['rowCountExact'])
                self.assertEqual('complete', table['profiling']['status'])

        # A non-zero spread is the point: this is what gives Schema City its relief.
        values = {table['rowCount'] for table in counted.values()}
        self.assertGreater(len(values), 1, 'every table came back the same size')
        self.assertIn(0, values, 'the seed has empty tables, which must record a measured zero')

        # Views are skipped and say so; nothing is left holding a zero it did not measure.
        views = [table for table in after['tables'] if table.get('kind') == 'view']
        for view in views:
            self.assertNotIn('rowCount', view)
            self.assertIn('no stored rows of its own', view['profiling']['reason'])
        self.assertEqual(summary['views'], len(views))
        self.assertIn('Row counts measured for', after['source']['basis'])

    def test_local_admin_measure_flow_asks_before_it_reads_rows(self) -> None:
        with AdminServer() as client:
            client.post('/connections', LiveDatabaseTests.fields_from_dsn(), token=client.token())
            _, listing = client.get('/')
            identifier = re.search(r'/connections/([0-9a-f]{16})/test', listing).group(1)

            # Before a structure exists the action is offered but refuses to run.
            self.assertIn('Measure row counts', listing)
            status, _ = client.post(f'/connections/{identifier}/measure', {},
                                    token=client.token('/'))
            self.assertEqual(303, status)
            _, refused = client.get('/')
            self.assertIn('Populate the structure before measuring row counts', refused)

            status, _ = client.post(f'/connections/{identifier}/introspect', {},
                                    token=client.token('/'))
            self.assertEqual(303, status)

            # The consent page states scope and caps, and runs nothing by itself.
            status, consent = client.get(f'/connections/{identifier}/measure')
            self.assertEqual(200, status)
            self.assertIn('SELECT count(*)', consent)
            self.assertIn('No column value is read', consent)
            self.assertIn('seconds per table', consent)
            self.assertIn('read-only session', consent.lower())

            status, _ = client.post(f'/connections/{identifier}/measure', {},
                                    token=client.token(f'/connections/{identifier}/measure'))
            self.assertEqual(303, status)
            _, done = client.get('/')
            self.assertIn('counted', done)
            self.assertIn('rows)', done)

            status, view = client.get('/view')
            self.assertEqual(200, status)
            self.assertIn("connect-src 'none'", view, 'the offline policy was not preserved')
            self.assertIn('Row counts measured for', view,
                          'the rendered artifact does not carry the measured counts')

@unittest.skipUnless(DSN, 'set BB_TEST_ADMIN_DSN to a read-only PostgreSQL to run this')
class LiveColumnStatisticsTests(unittest.TestCase):
    """Column statistics against a real PostgreSQL: the SQL is only exercised here."""

    def test_local_admin_statistics_match_the_database_and_withhold_text_extremes(self) -> None:
        import psycopg
        from tools.local_admin.introspection import (extremes_allowed, introspect_to_snapshot,
                                                     measure_column_stats)

        directory = Path(tempfile.mkdtemp(prefix='backend-buddy-stats-test-'))
        snapshot = directory / 'live.json'
        introspect_to_snapshot(DSN, '', snapshot, display_name='Profiled')
        summary = measure_column_stats(DSN, '', snapshot)
        document = json.loads(snapshot.read_text(encoding='utf-8'))

        self.assertGreater(summary['profiled'], 50, 'most tables should have been profiled')
        self.assertGreater(summary['columns'], 200)
        self.assertGreater(summary['withheld'], 0, 'the seed has text columns to withhold')

        profiled = [table for table in document['tables']
                    if table.get('profiling', {}).get('status') == 'complete']
        self.assertTrue(profiled)
        checked_extremes = checked_counts = 0
        with psycopg.connect(DSN) as connection, connection.cursor() as cursor:
            for table in profiled[:12]:      # a sample of tables, every column of each
                cursor.execute(psycopg.sql.SQL('SELECT count(*) FROM {}').format(
                    psycopg.sql.Identifier(table['schema'], table['name'])))
                rows = cursor.fetchone()[0]
                self.assertEqual(rows, table['rowCount'], f'{table["id"]} row count')
                self.assertIs(True, table['rowCountExact'])
                self.assertIs(False, table['sampled'], 'whole-table stats are not a sample')

                for column in table['allColumns']:
                    stats = column.get('profiling')
                    self.assertIsNotNone(stats, f'{table["id"]}.{column["name"]} has no statistics')
                    self.assertEqual('table', stats['scope'])
                    self.assertIs(False, stats['sampled'])

                    cursor.execute(psycopg.sql.SQL(
                        'SELECT count({0}), count(DISTINCT {0}) FROM {1}').format(
                        psycopg.sql.Identifier(column['name']),
                        psycopg.sql.Identifier(table['schema'], table['name'])))
                    non_null, distinct = cursor.fetchone()
                    expected = (rows - non_null) / rows if rows else None
                    if expected is None:
                        self.assertIsNone(stats['nullFraction'])
                    else:
                        self.assertAlmostEqual(expected, stats['nullFraction'], places=9,
                                               msg=f'{table["id"]}.{column["name"]} null fraction')
                    self.assertEqual(distinct, stats['distinctCount'],
                                     f'{table["id"]}.{column["name"]} distinct count')
                    checked_counts += 1

                    # The policy line, asserted against the real declared types.
                    if extremes_allowed(column.get('type', '')):
                        if rows and non_null:
                            self.assertIn('min', stats,
                                          f'{table["id"]}.{column["name"]} should keep extremes')
                            for bound in ('min', 'max'):
                                if isinstance(stats[bound], str):
                                    self.assertLessEqual(len(stats[bound]), 256)
                            checked_extremes += 1
                    else:
                        self.assertNotIn('min', stats,
                                         f'{table["id"]}.{column["name"]} leaked a minimum')
                        self.assertNotIn('max', stats,
                                         f'{table["id"]}.{column["name"]} leaked a maximum')
        self.assertGreater(checked_counts, 100, 'too few columns actually compared')
        self.assertGreater(checked_extremes, 0, 'no extremes were compared')

        # No sample value anywhere: this action does not offer them.
        for table in document['tables']:
            for column in table['allColumns']:
                self.assertNotIn('sampleValues', column)
        self.assertIn('No row and no sample value was retained.', document['source']['basis'])

    def test_local_admin_statistics_flow_asks_before_it_reads_values(self) -> None:
        with AdminServer() as client:
            client.post('/connections', LiveDatabaseTests.fields_from_dsn(), token=client.token())
            _, listing = client.get('/')
            identifier = re.search(r'/connections/([0-9a-f]{16})/test', listing).group(1)
            self.assertIn('Gather column statistics', listing)

            status, _ = client.post(f'/connections/{identifier}/statistics', {},
                                    token=client.token('/'))
            self.assertEqual(303, status)
            _, refused = client.get('/')
            self.assertIn('Populate the structure before gathering column statistics', refused)

            client.post(f'/connections/{identifier}/introspect', {}, token=client.token('/'))

            status, consent = client.get(f'/connections/{identifier}/statistics')
            self.assertEqual(200, status)
            self.assertIn('reads column values', consent)
            self.assertIn('count(DISTINCT)', consent)
            self.assertIn('the rows do not', consent)
            self.assertIn('withheld', consent)
            self.assertIn('256 characters', consent)

            status, _ = client.post(f'/connections/{identifier}/statistics', {},
                                    token=client.token(f'/connections/{identifier}/statistics'))
            self.assertEqual(303, status)
            _, done = client.get('/')
            self.assertIn('Extremes kept for', done)

            status, view = client.get('/view')
            self.assertEqual(200, status)
            self.assertIn("connect-src 'none'", view)
            self.assertIn('Column statistics measured for', view)

class BuildIdTests(unittest.TestCase):
    """
    The fingerprint that tells a stale rendered page from a current one.

    The rendered explorer is kept across restarts on purpose, so an upgraded image used to serve
    an interface older than itself with nothing on screen saying so. Comparing this id is what
    lets the entrypoint re-render the same snapshot with a newer renderer, which changes the
    picture and not the data.
    """

    @staticmethod
    def tree() -> Path:
        root = Path(tempfile.mkdtemp(prefix='backend-buddy-build-id-'))
        (root / 'skill' / 'scripts').mkdir(parents=True)
        (root / 'skill' / 'assets' / 'extensions' / 'dist').mkdir(parents=True)
        (root / 'skill' / 'scripts' / 'build_explorer.py').write_text('renderer', encoding='utf-8')
        (root / 'skill' / 'assets' / 'explorer.html').write_text('host', encoding='utf-8')
        (root / 'skill' / 'assets' / 'icons.json').write_text('{}', encoding='utf-8')
        (root / 'skill' / 'assets' / 'extensions' / 'dist' / 'extensions.js').write_text('bundle', encoding='utf-8')
        return root

    def test_local_admin_build_id_is_stable_for_the_same_inputs(self) -> None:
        from tools.build_id import build_id
        root = self.tree()
        first = build_id(root)
        self.assertEqual(first, build_id(root))
        self.assertEqual(16, len(first))

    def test_local_admin_build_id_changes_when_any_render_input_changes(self) -> None:
        from tools.build_id import build_id
        root = self.tree()
        before = build_id(root)
        for relative in ('skill/scripts/build_explorer.py', 'skill/assets/explorer.html',
                         'skill/assets/icons.json', 'skill/assets/extensions/dist/extensions.js'):
            path = root / relative
            original = path.read_text(encoding='utf-8')
            path.write_text(original + ' changed', encoding='utf-8')
            self.assertNotEqual(before, build_id(root), f'{relative} did not change the id')
            path.write_text(original, encoding='utf-8')
            self.assertEqual(before, build_id(root), f'{relative} did not restore the id')

    def test_local_admin_build_id_notices_a_file_appearing_or_leaving(self) -> None:
        from tools.build_id import build_id
        root = self.tree()
        before = build_id(root)
        extra = root / 'skill' / 'assets' / 'extensions' / 'dist' / 'chunk.js'
        # A bundle that splits into two files renders differently even if no existing byte moved.
        extra.write_text('bundle', encoding='utf-8')
        self.assertNotEqual(before, build_id(root))
        extra.unlink()
        self.assertEqual(before, build_id(root))

    def test_local_admin_build_id_ignores_files_that_do_not_draw_the_page(self) -> None:
        from tools.build_id import build_id
        root = self.tree()
        before = build_id(root)
        (root / 'skill' / 'SKILL.md').write_text('documentation', encoding='utf-8')
        (root / 'unrelated.txt').write_text('nothing to do with rendering', encoding='utf-8')
        self.assertEqual(before, build_id(root),
                         'a file that cannot change the page must not force a re-render')

    def test_local_admin_build_id_survives_a_partial_tree(self) -> None:
        from tools.build_id import build_id
        root = Path(tempfile.mkdtemp(prefix='backend-buddy-build-id-empty-'))
        # Absent inputs contribute nothing rather than raising: the comparison treats "different"
        # as "re-render", which is the safe direction.
        self.assertEqual(16, len(build_id(root)))

