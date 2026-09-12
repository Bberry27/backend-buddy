"""Synthetic HTTP/CLI integration checks. No real databases or credentials are used.

Run: python -m unittest discover -s packages/explorer/server
     -p test_explorer_http.py -v

Security regression assertions intentionally fail while the corresponding wrapper
bug remains; they are not expectedFailure tests and never modify parent code.
"""
from contextlib import closing, contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
SERVER = HERE / 'serve_explorer.py'
SNAPSHOT = HERE / 'profile_snapshot.py'
HOST_TEMPLATE = HERE.parents[1] / 'explorer-host-template.html'
if not HOST_TEMPLATE.is_file():
    HOST_TEMPLATE = HERE.parents[1] / 'explorer.html'
if not HOST_TEMPLATE.is_file():
    HOST_TEMPLATE = HERE.parents[2] / 'skill' / 'assets' / 'explorer.html'
CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
SENTINEL = 'synthetic-secret-not-a-real-credential-7391'


def table(name, columns):
    return {'id': name, 'name': name, 'primaryKey': ['id'], 'pk': 'id',
            'className': name, 'domain': 'Synthetic', 'type': 'table',
            'indexes': [], 'uniques': [], 'allColumns': [
                {'name': column, 'type': 'INTEGER' if column == 'id' or column.endswith('_id') else 'TEXT',
                 'pk': column == 'id', 'fk': '', 'nullable': 'False' if column == 'id' else 'True',
                 'index': column == 'id', 'unique': column == 'id'}
                for column in columns]}


class ExplorerHTTPTests(unittest.TestCase):
    maxDiff = 1200

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='schema-http-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.database = self.directory / 'synthetic.sqlite'
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript('''
                PRAGMA journal_mode=DELETE;
                CREATE TABLE parent(id INTEGER PRIMARY KEY, label TEXT, optional TEXT);
                CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), label TEXT);
                INSERT INTO parent VALUES(1, 'alpha', NULL), (2, 'beta', 'present');
                INSERT INTO child VALUES(10, 1, 'a'), (11, 1, 'b'), (12, 1, 'c'), (13, 2, 'd');
            ''')
        self.database_hash = self.digest(self.database)
        self.graph = {'project': {'name': 'Synthetic only', 'key': 'http-tests', 'dialect': 'sqlite'},
                      'tables': [table('parent', ['id', 'label', 'optional']), table('child', ['id', 'parent_id', 'label'])],
                      'links': [{'source': 'child', 'column': 'parent_id', 'target': 'parent', 'targetColumn': 'id', 'kind': 'declared FK'}]}
        self.schema = self.directory / 'schema.json'
        self.schema.write_text(json.dumps(self.graph), encoding='utf-8')
        self.html = self.directory / 'explorer.html'
        self.original_html = ('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'
                              + CSP + '"></head><body><script id="schema-data" type="application/json">'
                              + json.dumps(self.graph)
                              + '</script><script>window.fixtureReady=true;</script></body></html>')
        self.html.write_text(self.original_html, encoding='utf-8')
        self.process_count = 0

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def capability(page):
        match = re.search(r'window\.__SCHEMA_LIVE__\s*=\s*(\{[^<]+\});', page)
        if not match:
            raise AssertionError('No live capability found in the served HTML')
        return json.loads(match.group(1))

    def assert_sources_unchanged(self):
        self.assertEqual(self.digest(self.database), self.database_hash, 'Synthetic input database was mutated or truncated')
        self.assertEqual(self.html.read_text(encoding='utf-8'), self.original_html, 'Standalone HTML/CSP changed on disk')
        self.assertEqual(json.loads(self.schema.read_text(encoding='utf-8')), self.graph, 'Input graph was mutated')

    @contextmanager
    def server(self, live=True, extra=(), allow_startup_rejection=False):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        self.process_count += 1
        log = self.directory / f'server-{self.process_count}.log'
        command = [sys.executable, '-u', str(SERVER), '--html', str(self.html), '--schema', str(self.schema), '--port', str(port)]
        if live:
            command += ['--dialect', 'sqlite', '--database', str(self.database)]
        command += list(map(str, extra))
        env = dict(os.environ, SCHEMA_HTTP_TEST_DSN=SENTINEL)
        with log.open('w+', encoding='utf-8') as output:
            process = subprocess.Popen(command, stdout=output, stderr=output, env=env)
            try:
                deadline = time.monotonic() + 8
                while True:
                    if process.poll() is not None:
                        if allow_startup_rejection and process.returncode != 0:
                            yield None, None, log
                            return
                        self.fail(f'Server exited during startup: {log.read_text(encoding="utf-8")}')
                    try:
                        status, _, page = self.request(port, 'GET', '/')
                        if status == 200:
                            break
                    except (OSError, http.client.HTTPException):
                        pass
                    if time.monotonic() >= deadline:
                        self.fail('Synthetic HTTP server did not start in eight seconds')
                    time.sleep(.03)
                yield port, page, log
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    def request(self, port, method, path, payload=None, headers=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            body = raw if raw is not None else None if payload is None else json.dumps(payload).encode('utf-8')
            request_headers = {'Host': f'127.0.0.1:{port}'}
            if body is not None:
                request_headers['Content-Type'] = 'application/json'
            request_headers.update(headers or {})
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode('utf-8')
        finally:
            connection.close()

    def authorized(self, port, page, **extra):
        return {'Origin': f'http://127.0.0.1:{port}', 'X-Schema-Token': self.capability(page)['token'], **extra}

    def cli(self, extra=(), code=None, env=None):
        args = ['--schema', str(self.schema), '--output', str(self.directory / 'snapshot.json'),
                '--dialect', 'sqlite', '--database', str(self.database)]
        command = [sys.executable, str(SNAPSHOT)] if code is None else [sys.executable, '-c', code]
        return subprocess.run(command + args + list(map(str, extra)), cwd=HERE, env=env, capture_output=True, text=True, timeout=10)

    def test_metadata_only_page_is_byte_identical_and_api_disabled(self):
        with self.server(live=False) as (port, page, log):
            self.assertEqual(page, self.original_html)
            self.assertNotIn('__SCHEMA_LIVE__', page)
            status, headers, body = self.request(port, 'POST', '/api/profile', {'tables': ['parent']},
                                                 {'Origin': f'http://127.0.0.1:{port}', 'X-Schema-Token': 'anything'})
            self.assertEqual(status, 403)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertNotIn(SENTINEL, page + body + log.read_text(encoding='utf-8'))
        self.assert_sources_unchanged()

    def test_metadata_only_does_not_open_a_supplied_database_or_environment_dsn(self):
        missing = self.directory / 'must-not-be-created.sqlite'
        with self.server(live=False, extra=['--database', missing, '--dsn-env', 'SCHEMA_HTTP_TEST_DSN']) as (_, page, log):
            self.assertEqual(page, self.original_html)
            self.assertNotIn(SENTINEL, page + log.read_text(encoding='utf-8'))
        self.assertFalse(missing.exists())
        self.assert_sources_unchanged()

    def test_served_capability_precedes_bridge_and_only_served_csp_changes(self):
        with self.server() as (port, page, log):
            capability = self.capability(page)
            self.assertEqual(set(capability), {'token'})
            self.assertGreaterEqual(len(capability['token']), 32)
            self.assertEqual(page.count('window.__SCHEMA_LIVE__='), 1)
            self.assertLess(page.index('window.__SCHEMA_LIVE__'), page.index('<script id="schema-data"'))
            self.assertIn(CSP.replace("connect-src 'none'", "connect-src 'self'"), page)
            for forbidden in (SENTINEL, str(self.database), str(self.schema)):
                self.assertNotIn(forbidden, page)
            status, headers, second_page = self.request(port, 'GET', '/')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertNotIn('Access-Control-Allow-Origin', headers)
            self.assertEqual(self.capability(second_page), capability)
            self.assertNotIn(capability['token'], log.read_text(encoding='utf-8'))
        self.assert_sources_unchanged()

    def test_tokens_are_process_scoped(self):
        with self.server() as (_, first, _):
            first_token = self.capability(first)['token']
        with self.server() as (port, second, _):
            self.assertNotEqual(first_token, self.capability(second)['token'])
            status, _, _ = self.request(port, 'POST', '/api/profile', {'tables': ['parent']},
                                        self.authorized(port, second, **{'X-Schema-Token': first_token}))
            self.assertEqual(status, 403)

    def test_get_rejects_other_hosts_and_file_paths(self):
        with self.server() as (port, _, _):
            for host in ('localhost:' + str(port), 'attacker.invalid', '127.0.0.1:1'):
                with self.subTest(host=host):
                    status, _, body = self.request(port, 'GET', '/', headers={'Host': host})
                    self.assertEqual(status, 404)
                    self.assertNotIn('__SCHEMA_LIVE__', body)
            for path in ('/schema.json', '/synthetic.sqlite', '/explorer.html', '/../schema.json'):
                with self.subTest(path=path):
                    self.assertEqual(self.request(port, 'GET', path)[0], 404)

    def test_post_requires_exact_host_origin_and_token(self):
        with self.server() as (port, page, _):
            valid = self.authorized(port, page)
            cases = [{}, {'Origin': valid['Origin']}, {'X-Schema-Token': valid['X-Schema-Token']},
                     {**valid, 'Origin': 'null'}, {**valid, 'Origin': 'http://attacker.invalid'},
                     {**valid, 'Origin': f'http://localhost:{port}'}, {**valid, 'Origin': valid['Origin'] + '/'},
                     {**valid, 'Host': 'attacker.invalid'}, {**valid, 'X-Schema-Token': 'wrong'}]
            for headers in cases:
                with self.subTest(headers={key: value if key != 'X-Schema-Token' else '<redacted>' for key, value in headers.items()}):
                    self.assertEqual(self.request(port, 'POST', '/api/profile', {'tables': ['parent']}, headers)[0], 403)
        self.assert_sources_unchanged()

    def test_non_ascii_token_is_rejected_without_dropping_connection(self):
        with self.server() as (port, page, _):
            try:
                status, _, _ = self.request(port, 'POST', '/api/profile', {'tables': ['parent']},
                                            self.authorized(port, page, **{'X-Schema-Token': 'invalid-\xe9'}))
            except http.client.RemoteDisconnected:
                self.fail('Non-ASCII token crashed the request handler instead of returning 403')
            self.assertEqual(status, 403)

    def test_profile_persists_stats_without_mutating_inputs(self):
        snapshot = self.directory / 'nested' / 'persisted.json'
        with self.server(extra=['--snapshot-output', snapshot]) as (port, page, _):
            status, _, body = self.request(port, 'POST', '/api/profile', {'tables': ['parent'], 'maxRowsPerTable': 10}, self.authorized(port, page))
            self.assertEqual(status, 200, body)
            result = json.loads(body)
            self.assertEqual(json.loads(snapshot.read_text(encoding='utf-8')), result['graph'])
            parent, child = result['graph']['tables']
            self.assertEqual(parent['rowCount'], 2)
            self.assertTrue(parent['rowCountExact'])
            self.assertEqual(parent['allColumns'][2]['profiling']['nullFraction'], .5)
            self.assertNotIn('rowCount', child)
            self.assertNotIn('sampleValues', body)
            status, _, second = self.request(port, 'POST', '/api/profile', {'tables': ['child'], 'maxRowsPerTable': 2}, self.authorized(port, page))
            self.assertEqual(status, 200, second)
            persisted = json.loads(snapshot.read_text(encoding='utf-8'))
            self.assertEqual(persisted['tables'][0]['rowCount'], 2)
            self.assertIsNone(persisted['tables'][1]['rowCount'])
            self.assertFalse(persisted['tables'][1]['rowCountExact'])
            self.assertEqual(persisted['tables'][1]['rowCountLowerBound'], 3)
            self.assertEqual(persisted['tables'][1]['sampleSize'], 2)
            self.assertNotIn('sampleValues', second)
            self.assertEqual(self.request(port, 'GET', '/')[0], 200)
        self.assert_sources_unchanged()

    def test_subtree_reports_local_counts_truncation_and_does_not_persist_rows(self):
        snapshot = self.directory / 'not-written.json'
        with self.server(extra=['--snapshot-output', snapshot]) as (port, page, _):
            request = {'rootTable': 'parent', 'pkValue': 1, 'depth': 1, 'maxRowsPerHop': 2}
            status, _, body = self.request(port, 'POST', '/api/subtree', request, self.authorized(port, page))
            self.assertEqual(status, 200, body)
            result = json.loads(body)
            self.assertTrue(result['truncated'])
            self.assertEqual(result['limit'], 2)
            child = next(node for node in result['nodes'] if node['tableId'] == 'child')
            self.assertEqual(child['rowCount'], 2)
            self.assertTrue(child['truncated'])
            self.assertEqual(result['links'][0]['ratio'], 2)
            self.assertEqual(result['links'][0]['count'], 2)
            self.assertTrue(result['links'][0]['truncated'])
            self.assertNotIn('label', body)
            self.assertFalse(snapshot.exists())
            request['maxRowsPerHop'] = 10000
            status, _, body = self.request(port, 'POST', '/api/subtree', request, self.authorized(port, page))
            self.assertEqual(status, 200, body)
            self.assertFalse(json.loads(body)['truncated'])
            self.assertEqual(json.loads(body)['links'][0]['count'], 3)
        self.assert_sources_unchanged()

    def test_bound_sql_injection_values_and_unlisted_tables_cannot_mutate_db(self):
        with self.server() as (port, page, _):
            request = {'rootTable': 'parent', 'pkValue': "1'; DROP TABLE child; --", 'depth': 1}
            status, _, body = self.request(port, 'POST', '/api/subtree', request, self.authorized(port, page))
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['nodes'][0]['rowCount'], 0)
            for payload in ({'tables': ['sqlite_master']}, {'tables': ['parent; DROP TABLE child; --']}, {'tables': ['parent'], 'maxRowsPerTable': -1}):
                self.assertEqual(self.request(port, 'POST', '/api/profile', payload, self.authorized(port, page))[0], 400)
        self.assert_sources_unchanged()

    def test_bad_json_empty_oversized_and_unknown_routes_fail_closed(self):
        with self.server() as (port, page, _):
            for raw in (b'{bad', b'', b'x' * 65537):
                with self.subTest(length=len(raw)):
                    self.assertEqual(self.request(port, 'POST', '/api/profile', headers=self.authorized(port, page), raw=raw)[0], 400)
            self.assertEqual(self.request(port, 'POST', '/api/delete', {}, self.authorized(port, page))[0], 400)
        self.assert_sources_unchanged()

    def test_non_object_json_is_a_client_error_not_server_failure(self):
        with self.server() as (port, page, _):
            for raw in (b'[]', b'null', b'1', b'"text"'):
                with self.subTest(body=raw):
                    status, _, body = self.request(port, 'POST', '/api/profile', headers=self.authorized(port, page), raw=raw)
                    self.assertEqual(status, 400, body)

    def test_missing_database_http_error_is_redacted_and_does_not_create_file(self):
        missing = self.directory / (SENTINEL + '.sqlite')
        with self.server(extra=['--database', missing]) as (port, page, log):
            status, _, body = self.request(port, 'POST', '/api/profile', {'tables': ['parent']}, self.authorized(port, page))
            self.assertEqual(status, 500)
            self.assertNotIn(SENTINEL, body + page + log.read_text(encoding='utf-8'))
        self.assertFalse(missing.exists())
        self.assert_sources_unchanged()

    def test_cli_snapshot_is_bounded_and_does_not_mutate_inputs(self):
        result = self.cli(['--tables', 'child', '--limit', '2'])
        self.assertEqual(result.returncode, 0, result.stderr)
        graph = json.loads((self.directory / 'snapshot.json').read_text(encoding='utf-8'))
        self.assertNotIn('rowCount', graph['tables'][0])
        child = graph['tables'][1]
        self.assertIsNone(child['rowCount'])
        self.assertEqual(child['sampleSize'], 2)
        self.assertFalse(child['rowCountExact'])
        self.assertNotIn('sampleValues', json.dumps(graph))
        self.assertNotIn(str(self.database), result.stdout + result.stderr)
        self.assert_sources_unchanged()

    def test_sample_values_require_explicit_opt_in(self):
        result = self.cli(['--tables', 'child', '--include-sample-values'])
        self.assertEqual(result.returncode, 0, result.stderr)
        graph = json.loads((self.directory / 'snapshot.json').read_text(encoding='utf-8'))
        child = graph['tables'][1]
        self.assertIn('sampleValues', json.dumps(child))
        self.assertLessEqual(len(child['allColumns'][2]['sampleValues']), 3)
        self.assert_sources_unchanged()

    def test_cli_output_cannot_overwrite_the_input_database(self):
        result = self.cli(['--output', self.database])
        self.assertEqual(self.digest(self.database), self.database_hash,
                         f'CLI overwrote its input SQLite database with JSON (exit {result.returncode})')
        self.assertNotEqual(result.returncode, 0)

    def test_http_snapshot_output_cannot_overwrite_the_input_database(self):
        with self.server(extra=['--snapshot-output', self.database], allow_startup_rejection=True) as (port, page, _):
            if port is None:
                self.assert_sources_unchanged()
                return
            status, _, _ = self.request(port, 'POST', '/api/profile', {'tables': ['parent']}, self.authorized(port, page))
            self.assertEqual(self.digest(self.database), self.database_hash,
                             f'HTTP snapshot output overwrote its input SQLite database (status {status})')
            self.assertNotEqual(status, 200)

    def test_cli_connection_error_never_prints_credentials(self):
        # Inject an exception in the child process, so this test cannot connect to PostgreSQL.
        code = (
            'import os,runpy,sys; from unittest.mock import patch; import schema_profiler; '
            'failure=RuntimeError("connection failed: "+os.environ["SCHEMA_HTTP_TEST_DSN"]); '
            f'sys.argv[0]={str(SNAPSHOT)!r}; '
            'guard=patch.object(schema_profiler,"connect_readonly",side_effect=failure);guard.start(); '
            f'runpy.run_path({str(SNAPSHOT)!r},run_name="__main__")'
        )
        env = dict(os.environ, SCHEMA_HTTP_TEST_DSN='postgresql://synthetic:' + SENTINEL + '@invalid.invalid/synthetic')
        result = self.cli(['--dialect', 'postgresql', '--dsn-env', 'SCHEMA_HTTP_TEST_DSN'], code=code, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(SENTINEL in result.stdout + result.stderr, 'CLI leaked a connection exception containing credentials')
        self.assertFalse((self.directory / 'snapshot.json').exists())
        self.assert_sources_unchanged()

    @unittest.skipUnless(shutil.which('node'), 'Node is required to execute the real host bridge in an isolated VM')
    def test_actual_host_bridge_uses_capability_signal_and_updates_exported_graph(self):
        # Exercise the exact bridge source with a fake fetch, never a real URL.
        template = HOST_TEMPLATE.read_text(encoding='utf-8')
        self.assertIn("connect-src 'none'", template)
        start = template.index('let live;')
        end = template.index('function renderExtension', start)
        bridge = template[start:end]
        script = r'''
const vm=require('node:vm'),assert=require('node:assert/strict');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
(async()=>{
  for(const [protocol,capability] of [['file:',true],['http:',false],['http:',true]]){
    const calls=[],original=structuredClone(input.graph),signal={synthetic:true};
    const updated=structuredClone(original);updated.tables[0].rowCount=2;
    const context={window:capability?{__SCHEMA_LIVE__:{token:'synthetic-token'}}:{},location:{protocol},
      data:original,byId:new Map(original.tables.map(t=>[t.id,t])),structuredClone,
      fetch:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({graph:updated,sampled:true,limit:10})}}};
    vm.createContext(context);vm.runInContext(input.bridge+';window.testLive=live;',context);
    if(protocol==='file:'||!capability){assert.equal(context.window.testLive,undefined);assert.equal(calls.length,0);continue;}
    await context.window.testLive.profile({tables:['parent'],maxRowsPerTable:10},signal);
    assert.equal(calls[0].url,'/api/profile');assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[0].options.headers['X-Schema-Token'],'synthetic-token');assert.equal(calls[0].options.signal,signal);
    assert.equal(context.window.schemaSnapshot().tables[0].rowCount,2);assert.equal(context.byId.get('parent').rowCount,2);
    await context.window.testLive.subtree({rootTable:'parent',pkValue:1,depth:1,maxRowsPerHop:2},signal);
    assert.equal(calls[1].url,'/api/subtree');assert.equal(calls[1].options.signal,signal);
    assert.equal(calls[1].options.body,JSON.stringify({rootTable:'parent',pkValue:1,depth:1,maxRowsPerHop:2}));
    context.fetch=async()=>({ok:false,json:async()=>({error:'Synthetic operation rejected'})});
    await assert.rejects(()=>context.window.testLive.profile({tables:['parent']}),/Synthetic operation rejected/);
  }
})().catch(error=>{console.error(error);process.exitCode=1});
'''
        result = subprocess.run([shutil.which('node'), '-e', script], input=json.dumps({'bridge': bridge, 'graph': self.graph}),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
