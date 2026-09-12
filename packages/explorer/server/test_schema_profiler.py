"""Offline synthetic coverage; no environment credentials or remote connections."""

from copy import deepcopy
from datetime import date
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import schema_profiler as service


def table(table_id, columns, pk=('id',), **extra):
    return {'id': table_id, 'primaryKey': list(pk), 'allColumns': [
        {'name': c, 'type': 'TEXT', 'pk': c in pk, 'nullable': 'False' if c in pk else 'True'}
        for c in columns], **extra}


def edge(child, column, parent, target='id', constraint=None):
    result = {'source': child, 'column': column, 'target': parent,
              'targetColumn': target, 'kind': 'declared FK'}
    if constraint:
        result['constraintId'] = constraint
    return result


class SchemaProfilerTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE parent(id INTEGER PRIMARY KEY, label TEXT, optional INTEGER);
            CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER, label TEXT);
            CREATE TABLE other(id INTEGER PRIMARY KEY, parent_id INTEGER);
            CREATE TABLE leaf(id INTEGER PRIMARY KEY, child_id INTEGER);
            INSERT INTO parent VALUES(1, 'first', NULL), (2, 'second', 9);
            INSERT INTO child VALUES(10, 1, 'a'), (11, 1, 'b'), (12, 1, 'b'), (13, 2, 'z');
            INSERT INTO other VALUES(20, 1), (21, 1);
            INSERT INTO leaf VALUES(100, 10), (101, 11), (102, 12), (103, 13);
        ''')
        self.graph = {'tables': [table('parent', ['id', 'label', 'optional']),
                                 table('child', ['id', 'parent_id', 'label']),
                                 table('other', ['id', 'parent_id']),
                                 table('leaf', ['id', 'child_id'])],
                      'links': [edge('child', 'parent_id', 'parent'),
                                edge('other', 'parent_id', 'parent'),
                                edge('leaf', 'child_id', 'child')]}

    def test_profile_copy_stats_exhaustion_and_no_row_dataset(self):
        original = deepcopy(self.graph)
        result = service.profile(self.graph, self.db, ['parent'])
        self.assertEqual(self.graph, original)
        profiled = result['graph']['tables'][0]
        self.assertEqual(profiled['rowCount'], 2)
        self.assertTrue(profiled['rowCountExact'])
        self.assertEqual(profiled['allColumns'][2]['profiling'], {
            'nullFraction': .5, 'distinctCount': 1, 'min': 9, 'max': 9,
            'sampleSize': 2, 'scope': 'sampled'})
        self.assertEqual(result['graph']['tables'][1], original['tables'][1])
        self.assertNotIn('rows', json.dumps(result))
        self.assertTrue(result['sampled'])

    def test_profile_limit_never_uses_count_scan(self):
        statements = []
        self.db.set_trace_callback(statements.append)
        result = service.profile(self.graph, self.db, ['child'], max_rows=2)
        child = result['graph']['tables'][1]
        self.assertIsNone(child['rowCount'])
        self.assertFalse(child['rowCountExact'])
        self.assertEqual(child['rowCountLowerBound'], 3)
        self.assertEqual(child['sampleSize'], 2)
        self.assertEqual(child['allColumns'][2]['profiling']['max'], 'b')
        self.assertFalse(any('COUNT(' in s.upper() for s in statements))
        self.assertTrue(all('LIMIT' in s for s in statements if s.startswith('SELECT ')))

    def test_exact_supplied_count_is_preserved_on_overflow(self):
        self.graph['tables'][1]['rowCount'] = 4
        result = service.profile(self.graph, self.db, ['child'], 2)['graph']['tables'][1]
        self.assertEqual(result['rowCount'], 4)
        self.assertTrue(result['rowCountExact'])
        self.assertEqual(result['rowCountLowerBound'], 3)

    def test_empty_and_exact_cap_are_not_overflow(self):
        self.db.execute('DELETE FROM leaf')
        result = service.profile(self.graph, self.db, ['parent', 'leaf'], 2)
        parent, leaf = result['graph']['tables'][0], result['graph']['tables'][3]
        self.assertEqual(parent['rowCount'], 2)
        self.assertEqual(leaf['rowCount'], 0)
        self.assertIsNone(leaf['allColumns'][0]['profiling']['nullFraction'])

    def test_fanout_all_edges_and_retained_key_expansion(self):
        result = service.subtree(self.graph, self.db, 'parent', 1, 2, 2)
        by_table = {n['tableId']: n for n in result['nodes']}
        self.assertEqual(by_table['child']['rowCount'], 2)
        self.assertEqual(by_table['other']['rowCount'], 0)
        self.assertTrue(by_table['other']['truncated'])
        self.assertEqual(by_table['leaf']['rowCount'], 2)
        self.assertTrue(by_table['leaf']['truncated'])
        self.assertEqual(result['links'][0]['ratio'], 2)
        for depth in (1, 2):
            self.assertLessEqual(sum(n['rowCount'] for n in result['nodes'] if n['depth'] == depth), 2)

    def test_probe_row_cannot_seed_next_hop(self):
        self.db.execute('DELETE FROM leaf WHERE child_id != 12')
        result = service.subtree(self.graph, self.db, 'parent', 1, 2, 2)
        leaf = next(n for n in result['nodes'] if n['tableId'] == 'leaf')
        self.assertEqual(leaf['rowCount'], 0)

    def test_aggregate_fanout_without_truncation(self):
        result = service.subtree(self.graph, self.db, 'parent', 1, 2)
        self.assertEqual([n['rowCount'] for n in result['nodes']], [1, 3, 2, 3])
        self.assertEqual([l['ratio'] for l in result['links']], [3, 2, 1])
        self.assertFalse(result['truncated'])

    def test_composite_pk_and_fk_do_not_cross_product(self):
        self.db.executescript('''
            CREATE TABLE cp(a INTEGER, b TEXT, PRIMARY KEY(a,b));
            CREATE TABLE cc(id INTEGER PRIMARY KEY, a INTEGER, b TEXT);
            INSERT INTO cp VALUES(1,'x'),(1,'y');
            INSERT INTO cc VALUES(1,1,'x'),(2,1,'y'),(3,2,'x');
        ''')
        graph = {'tables': [table('cp', ['a', 'b'], ('a', 'b')),
                            table('cc', ['id', 'a', 'b'])],
                 'links': [edge('cc', 'a', 'cp', 'a', 'pair'),
                           edge('cc', 'b', 'cp', 'b', 'pair')]}
        for pk in ({'b': 'x', 'a': 1}, [1, 'x']):
            result = service.subtree(graph, self.db, 'cp', pk, 1)
            self.assertEqual(len(result['links']), 1)
            self.assertEqual(result['nodes'][1]['rowCount'], 1)
        with self.assertRaises(ValueError):
            service.subtree(graph, self.db, 'cp', 1, 1)
        with self.assertRaises(ValueError):
            service.subtree(graph, self.db, 'cp', {'a': 1, 'extra': 'x'}, 1)

    def test_invalid_and_injection_pk_values(self):
        for pk in (None, {'unknown': 1}, [1, 2], object(), float('nan')):
            with self.subTest(pk=pk), self.assertRaises(ValueError):
                service.subtree(self.graph, self.db, 'parent', pk, 1)
        result = service.subtree(self.graph, self.db, 'parent', "1 OR 1=1; DROP TABLE child;--", 1)
        self.assertEqual(result['nodes'][0]['rowCount'], 0)
        self.assertEqual(self.db.execute('SELECT id FROM child').fetchall(), [(10,), (11,), (12,), (13,)])

    def test_graph_identifier_allowlist_and_quoted_identifiers(self):
        with self.assertRaises(ValueError):
            service.profile(self.graph, self.db, ['parent; DROP TABLE child'])
        self.graph['links'][0]['column'] = 'parent_id) OR 1=1 --'
        with self.assertRaises(ValueError):
            service.subtree(self.graph, self.db, 'parent', 1, 1)
        self.db.execute('CREATE TABLE "odd"";name" ("pk""value" TEXT PRIMARY KEY)')
        self.db.execute('INSERT INTO "odd"";name" VALUES (?)', ("x'; DROP TABLE parent;--",))
        graph = {'tables': [table('alias', ['pk"value'], ('pk"value',), name='odd";name', schema='main')], 'links': []}
        result = service.subtree(graph, self.db, 'alias', "x'; DROP TABLE parent;--", 0)
        self.assertEqual(result['nodes'][0]['rowCount'], 1)

    def test_cycle_and_dag_have_qualified_nodes(self):
        self.graph['links'].extend([edge('parent', 'id', 'child', 'parent_id'),
                                    edge('leaf', 'id', 'other', 'id')])
        result = service.subtree(self.graph, self.db, 'parent', 1, 4, 10)
        ids = [n['id'] for n in result['nodes']]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertLessEqual(max(n['depth'] for n in result['nodes']), 4)
        self.assertGreater(sum(n['tableId'] == 'leaf' for n in result['nodes']), 1)
        self.assertTrue(result['truncated'])

    def test_inferred_edges_are_not_followed(self):
        for link in self.graph['links']:
            link['kind'] = 'inferred by naming'
        result = service.subtree(self.graph, self.db, 'parent', 1, 4)
        self.assertEqual(len(result['nodes']), 1)
        self.assertFalse(result['truncated'])

    def test_hard_cap_and_batch_query_bounds(self):
        self.db.executemany('INSERT INTO child VALUES (?, 1, NULL)', [(i,) for i in range(1000, 12001)])
        self.db.executemany('INSERT INTO leaf VALUES (?, ?)', [(i, i) for i in range(1000, 12001)])
        sizes = []
        original = service._Reader.select

        def recording(reader, graph, table_id, limit, where='', params=()):
            sizes.append((limit, len(params)))
            return original(reader, graph, table_id, limit, where, params)

        with patch.object(service._Reader, 'select', recording):
            result = service.subtree(self.graph, self.db, 'parent', 1, 2, 99999)
        self.assertEqual(result['limit'], 10000)
        self.assertEqual(sum(n['rowCount'] for n in result['nodes'] if n['depth'] == 1), 10000)
        self.assertTrue(all(limit <= 10001 and params + 1 <= service.MAX_PARAMETERS for limit, params in sizes))
        self.assertLess(len(sizes), service.MAX_QUERIES)

    def test_profile_hard_cap(self):
        self.db.executemany('INSERT INTO other VALUES (?, 1)', [(i,) for i in range(1000, 11001)])
        result = service.profile(self.graph, self.db, ['other'], 20000)
        self.assertEqual(result['limit'], 10000)
        sampled = result['graph']['tables'][2]
        self.assertEqual(sampled['sampleSize'], 10000)
        self.assertIsNone(sampled['rowCount'])

    def test_budget_and_deadline_fail_closed(self):
        with patch.object(service, 'MAX_QUERIES', 1), self.assertRaises(service.ProfileLimitError):
            service.subtree(self.graph, self.db, 'parent', 1, 1)
        with patch.object(service, 'DEADLINE_SECONDS', -1), self.assertRaises(service.ProfileLimitError):
            service.profile(self.graph, self.db, ['parent'])
        self.assertEqual(self.db.execute('PRAGMA query_only').fetchone()[0], 0)

    def test_sqlite_progress_interrupts_expensive_select(self):
        self.db.execute('CREATE VIEW slow AS WITH RECURSIVE nums(n) AS '
                        '(SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 100000000) '
                        'SELECT sum(n) AS id FROM nums')
        graph = {'tables': [table('slow', ['id'])], 'links': []}
        with patch.object(service, 'DEADLINE_SECONDS', .02), self.assertRaises(sqlite3.OperationalError):
            service.profile(graph, self.db, ['slow'])
        self.assertEqual(self.db.execute('SELECT 1').fetchone(), (1,))

    def test_no_writes_even_from_sqlite_function(self):
        attempts = []

        def attempt_write():
            try:
                self.db.execute('INSERT INTO parent VALUES(99, NULL, NULL)')
            except sqlite3.OperationalError:
                attempts.append('blocked')
            return 1

        self.db.create_function('attempt_write', 0, attempt_write)
        self.db.execute('CREATE VIEW guarded AS SELECT attempt_write() AS id')
        service.profile({'tables': [table('guarded', ['id'])], 'links': []}, self.db, ['guarded'])
        self.assertEqual(attempts, ['blocked'])
        self.assertEqual(self.db.execute('SELECT id FROM parent WHERE id=99').fetchall(), [])

    def test_file_adapter_readonly_and_close(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'catalog #%.sqlite'
            raw = sqlite3.connect(path)
            raw.execute('CREATE TABLE item(id INTEGER PRIMARY KEY)')
            raw.commit()
            raw.close()
            with service.connect_readonly('sqlite', path) as connection:
                with self.assertRaises(sqlite3.OperationalError):
                    connection.raw.execute('INSERT INTO item VALUES(1)')
                service.profile({'tables': [table('item', ['id'])]}, connection, ['item'])
                with self.assertRaises(sqlite3.OperationalError):
                    connection.raw.execute('DROP TABLE item')
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.raw.execute('SELECT 1')
            with self.assertRaises(FileNotFoundError):
                with service.connect_readonly('sqlite', Path(folder) / 'missing.sqlite'):
                    self.fail('Should not create missing database')

    def test_serializable_bounded_scalars(self):
        values = [date(2026, 1, 2), Decimal('1.2500'), b'\xff' * 999, 'x' * 999, float('inf')]
        for value in values:
            stats = service._stats([None, value])
            json.dumps(stats, allow_nan=False)
            self.assertLessEqual(len(str(stats['max'])), service.MAX_SCALAR_LENGTH)
        self.assertEqual(service._stats([1, 'a'])['min'], None)

    def test_postgres_requires_explicit_credentials_and_sets_readonly(self):
        psycopg = MagicMock()
        conninfo = MagicMock()
        config = {'host': 'offline.invalid', 'dbname': 'synthetic',
                  'user': 'test', 'password': 'fake-password'}
        with patch.dict(sys.modules, {'psycopg': psycopg, 'psycopg.conninfo': conninfo}):
            for bad in ({}, {**config, 'password': ''}, {**config, 'service': 'ambient'}):
                with self.assertRaises(ValueError):
                    with service.connect_readonly('postgresql', bad):
                        self.fail('Invalid configuration connected')
            psycopg.connect.assert_not_called()
            with service.connect_readonly('postgresql', config) as connection:
                self.assertTrue(connection.raw.read_only)
                self.assertEqual(connection.dialect, 'postgresql')
            kwargs = psycopg.connect.call_args.kwargs
            self.assertIn('default_transaction_read_only=on', kwargs['options'])
            self.assertIn('statement_timeout=5000', kwargs['options'])
            psycopg.connect.return_value.close.assert_called_once()

    def test_postgres_select_values_are_bound_and_transaction_readonly(self):
        raw = MagicMock()
        raw.cursor.return_value.fetchmany.return_value = []
        raw.cursor.return_value.__enter__.return_value = raw.cursor.return_value
        connection = service._Connection(raw, 'postgresql')
        injection = "1' OR TRUE --"
        result = service.subtree(self.graph, connection, 'parent', injection, 0)
        self.assertEqual(result['nodes'][0]['rowCount'], 0)
        statements = raw.cursor.return_value.execute.call_args_list
        self.assertTrue(any(call.args[0] == 'SET TRANSACTION READ ONLY' for call in statements))
        query = next(call for call in statements if 'FROM "parent"' in call.args[0])
        self.assertNotIn(injection, query.args[0])
        self.assertEqual(query.args[1], (injection, 2))
        raw.transaction.assert_called_once()

    def test_postgres_percent_identifiers_preserve_bound_placeholders(self):
        raw = MagicMock()
        raw.cursor.return_value.fetchmany.return_value = []
        connection = service._Connection(raw, 'postgresql')
        graph = {'tables': [table('odd%table', ['pk%s'], ('pk%s',))], 'links': []}
        service.subtree(graph, connection, 'odd%table', 'literal', 0)
        query = next(call for call in raw.cursor.return_value.execute.call_args_list
                     if ' FROM ' in call.args[0])
        self.assertEqual(query.args[0], 'SELECT "pk%%s" FROM "odd%%table" '
                         'WHERE "pk%%s" = %s LIMIT %s')
        self.assertEqual(query.args[1], ('literal', 2))

    def test_dag_convergence_is_path_qualified_with_real_rows(self):
        self.db.executescript('''
            CREATE TABLE joined(id INTEGER PRIMARY KEY, child_id INTEGER, other_id INTEGER);
            INSERT INTO joined VALUES(1, 10, 20);
        ''')
        self.graph['tables'].append(table('joined', ['id', 'child_id', 'other_id']))
        self.graph['links'].extend([edge('joined', 'child_id', 'child'),
                                    edge('joined', 'other_id', 'other')])
        result = service.subtree(self.graph, self.db, 'parent', 1, 2)
        joined = [n for n in result['nodes'] if n['tableId'] == 'joined']
        self.assertEqual([n['rowCount'] for n in joined], [1, 1])
        self.assertNotEqual(joined[0]['id'], joined[1]['id'])

    def test_invalid_caps_depth_and_duplicate_pk(self):
        for cap in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                service.profile(self.graph, self.db, ['parent'], cap)
        for depth in (-1, 5, True, 1.5):
            with self.assertRaises(ValueError):
                service.subtree(self.graph, self.db, 'parent', 1, depth)
        self.graph['tables'][1]['primaryKey'] = ['parent_id']
        with self.assertRaises(ValueError):
            service.subtree(self.graph, self.db, 'child', 1, 1)

    def fd_fixture(self):
        self.db.executescript('''
            CREATE TABLE fd(id INTEGER PRIMARY KEY, a TEXT, b TEXT, changing TEXT, constant TEXT);
            INSERT INTO fd VALUES
                (1, 'north', 'N', 'x', 'fixed'), (2, 'north', 'N', 'y', 'fixed'),
                (3, 'south', 'S', 'x', 'fixed'), (4, 'south', 'S', 'y', 'fixed');
        ''')
        return {'tables': [table('fd', ['id', 'a', 'b', 'changing', 'constant'])], 'links': []}

    def test_functional_dependencies_and_vacuous_determinants(self):
        graph = self.fd_fixture()
        original = deepcopy(graph)
        statements = []
        self.db.set_trace_callback(statements.append)
        result = service.profile(graph, self.db, ['fd'])['graph']['tables'][0]['profiling']
        candidates = result['functionalDependencies']
        self.assertIn({'determinant': 'a', 'dependent': 'b', 'distinctDeterminant': 2,
                       'distinctPair': 2, 'sampleSize': 4}, candidates)
        self.assertFalse(any(c['determinant'] in ('id', 'constant') for c in candidates))
        self.assertFalse(any(c['determinant'] == c['dependent'] for c in candidates))
        self.assertFalse(any(c['determinant'] == 'a' and c['dependent'] == 'changing'
                             for c in candidates))
        self.assertEqual(result['scope'], 'sampled')
        self.assertTrue(result['sampled'])
        self.assertEqual(result['uniqueDeterminants'], 'skipped')
        self.assertEqual(graph, original)
        self.assertEqual(sum(s.startswith('SELECT ') for s in statements), 1)

    def test_dependencies_only_use_retained_sample_and_ignore_probe(self):
        graph = self.fd_fixture()
        self.db.execute("INSERT INTO fd VALUES(5, 'north', 'wrong', 'z', 'fixed')")
        bounded = service.profile(graph, self.db, ['fd'], 4)['graph']['tables'][0]
        full = service.profile(graph, self.db, ['fd'])['graph']['tables'][0]
        pair = lambda p: any(c['determinant'] == 'a' and c['dependent'] == 'b'
                             for c in p['profiling']['functionalDependencies'])
        self.assertTrue(pair(bounded))
        self.assertFalse(pair(full))
        self.assertEqual(bounded['profiling']['sampleSize'], 4)
        self.assertIsNone(bounded['rowCount'])

    def test_dependency_nulls_are_one_category_including_null_conflicts(self):
        graph = self.fd_fixture()
        self.db.execute("UPDATE fd SET a=NULL, b=NULL WHERE a='north'")
        result = service.profile(graph, self.db, ['fd'])['graph']['tables'][0]['profiling']
        self.assertEqual(result['nullPolicy'], 'null-as-value')
        self.assertIn({'determinant': 'a', 'dependent': 'b', 'distinctDeterminant': 2,
                       'distinctPair': 2, 'sampleSize': 4}, result['functionalDependencies'])
        self.db.execute("UPDATE fd SET b='conflict' WHERE id=1")
        result = service.profile(graph, self.db, ['fd'])['graph']['tables'][0]['profiling']
        self.assertFalse(any(c['determinant'] == 'a' and c['dependent'] == 'b'
                             for c in result['functionalDependencies']))

    def test_dependency_column_cap_and_ineligible_values(self):
        names = ['id', 'blob', 'long', 'structured'] + ['c' + str(i) for i in range(35)]
        self.db.execute('CREATE TABLE wide (' + ', '.join('"' + c + '"' for c in names) + ')')
        self.db.executemany('INSERT INTO wide VALUES (' + ','.join('?' for _ in names) + ')', [
            [i, b'bytes', 'x' * 257, '{"a":1}'] + [i % 2] * 35 for i in range(4)])
        wide = table('wide', names)
        wide['allColumns'][3]['type'] = 'JSONB'
        graph = {'tables': [wide], 'links': []}
        result = service.profile(graph, self.db, ['wide'])['graph']['tables'][0]['profiling']
        self.assertEqual(len(result['candidateColumns']), 32)
        self.assertFalse(set(('blob', 'long', 'structured', 'c34')) & set(result['candidateColumns']))
        self.assertLessEqual(len(result['functionalDependencies']), 32 * 31)

    def test_empty_or_single_row_has_no_dependency_candidates(self):
        graph = self.fd_fixture()
        for where in ('id > 1', '1=1'):
            self.db.execute('DELETE FROM fd WHERE ' + where)
            result = service.profile(graph, self.db, ['fd'])['graph']['tables'][0]
            self.assertEqual(result['profiling']['functionalDependencies'], [])

    def test_sample_values_require_current_explicit_opt_in(self):
        graph = self.fd_fixture()
        result = service.profile(graph, self.db, ['fd'], include_sample_values=True)
        sampled = result['graph']['tables'][0]
        self.assertEqual(sampled['allColumns'][0]['sampleValues'], [1, 2, 3])
        self.assertEqual(sampled['allColumns'][1]['sampleValues'], ['north', 'south'])
        self.assertEqual(sampled['allColumns'][4]['sampleValues'], ['fixed'])
        snapshot = deepcopy(result['graph'])
        snapshot['tables'][0]['allColumns'][0]['profiling']['sampleValues'] = ['stale']
        snapshot['tables'][0]['allColumns'][0]['stats'] = {'sampleValues': ['legacy']}
        original = deepcopy(snapshot)
        for selected in ([], ['fd']):
            scrubbed = service.profile(snapshot, self.db, selected)['graph']
            self.assertNotIn('sampleValues', json.dumps(scrubbed))
        self.assertEqual(snapshot, original)
        self.assertNotIn('sampleValues', json.dumps(graph))
        for invalid in ('false', 'true', 1, None):
            with self.assertRaises(ValueError):
                service.profile(graph, self.db, ['fd'], include_sample_values=invalid)

    def test_sample_values_are_bounded_serializable_and_skip_null(self):
        self.db.execute('CREATE TABLE samples(id INTEGER PRIMARY KEY, value)')
        self.db.executemany('INSERT INTO samples VALUES (?, ?)', [
            (1, None), (2, b'x' * 1000), (3, 'y' * 1000), (4, 42), (5, 'omitted')])
        graph = {'tables': [table('samples', ['id', 'value'])], 'links': []}
        result = service.profile(graph, self.db, ['samples'], include_sample_values=True)
        values = result['graph']['tables'][0]['allColumns'][1]['sampleValues']
        self.assertEqual(len(values), 3)
        self.assertNotIn(None, values)
        self.assertNotIn('omitted', values)
        self.assertTrue(all(len(str(v)) <= service.MAX_SCALAR_LENGTH for v in values))
        json.dumps(result, allow_nan=False)

    def test_view_kind_and_definition_never_execute_supplied_sql(self):
        self.db.execute('CREATE VIEW fd_view AS SELECT * FROM child')
        view = table('fd_view', ['id', 'parent_id', 'label'], kind='view',
                     definition='DROP TABLE parent; INSERT INTO child VALUES(99, 1, NULL);')
        statements = []
        self.db.set_trace_callback(statements.append)
        result = service.profile({'tables': [view], 'links': []}, self.db, ['fd_view'])
        self.assertEqual(result['graph']['tables'][0]['rowCount'], 4)
        self.assertFalse(any('DROP TABLE' in sql or 'INSERT INTO' in sql for sql in statements))
        self.assertEqual(self.db.execute('SELECT id FROM parent').fetchall(), [(1,), (2,)])
        self.assertTrue(result['graph']['tables'][0]['profiling']['functionalDependencies'])


if __name__ == '__main__':
    unittest.main()
