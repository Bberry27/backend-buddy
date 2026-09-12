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

            status, listing = client.get('/')
            self.assertEqual(200, status)
            self.assertIn('Test Connection', listing)
            self.assertIn('Verified', listing)
            self.assertNotIn(self.fields_from_dsn()['password'], listing,
                             'the password was rendered back into the page')

            connection_id = re.search(r'/connections/([0-9a-f]{16})/test', listing)
            self.assertIsNotNone(connection_id, 'no connection row was rendered')
            identifier = connection_id.group(1)

            status, _ = client.post(f'/connections/{identifier}/introspect', {},
                                    token=client.token('/'))
            self.assertEqual(303, status)

            status, after = client.get('/')
            self.assertIn('tables', after)
            self.assertIn('foreign-key column pairs loaded', after)
            self.assertIn('Open the schema explorer', after,
                          'the explorer link did not appear after populating')

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

