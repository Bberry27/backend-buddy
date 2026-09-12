"""Fixture contract tests (work package R01, CTQ-01 / CTQ-07 / CTQ-14).

Every committed fixture must pass build_explorer.normalize(), the semantic oracle for the
canonical schema contract, and every invalid contract case must be rejected with the message
fragment recorded in its top-level ``$expectedError`` field. The SQLite seed is executed with
foreign-key enforcement to prove that the emitted DDL and inserts are consistent with the
measured snapshot.

Run from the repository root:
    python -m unittest discover -s fixtures -p "test_*.py"
"""
import json
import re
import sqlite3
import sys
import unittest
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
ROOT = FIXTURES.parent
sys.path.insert(0, str(ROOT / 'skill' / 'scripts'))

from build_explorer import normalize, render  # noqa: E402  (path set up above)

KEY = re.compile(r'[a-z0-9][a-z0-9_-]*')
SEED_ROW_CAP = 200
UNKNOWN_SEED_ROWS = 10


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def schema_files():
    return sorted(p for p in (FIXTURES / 'schemas').glob('*.json'))


def expected_seed_rows(table):
    row_count = table.get('rowCount')
    if isinstance(row_count, int):
        return min(row_count, SEED_ROW_CAP)
    if isinstance(table.get('rowCountLowerBound'), int):
        return SEED_ROW_CAP
    return UNKNOWN_SEED_ROWS


def walk_keys(value, key):
    if isinstance(value, list):
        return sum(walk_keys(item, key) for item in value)
    if isinstance(value, dict):
        return sum((1 if k == key else 0) + walk_keys(v, key) for k, v in value.items())
    return 0


class FixtureNormalizeTests(unittest.TestCase):
    def test_R01_fixture_set_is_complete(self):
        names = {p.stem for p in schema_files()}
        self.assertTrue({'small', 'medium', 'medium-measured', 'edge-cases', 'many-domains', 'hostile', 'empty'} <= names)
        self.assertEqual(len(list((FIXTURES / 'contract' / 'valid').glob('*.json'))), 5)
        self.assertEqual(len(list((FIXTURES / 'contract' / 'invalid').glob('*.json'))), 6)

    def test_R01_schema_fixtures_pass_normalize(self):
        for path in schema_files():
            with self.subTest(fixture=path.name):
                raw = load(path)
                data = normalize(raw)
                self.assertEqual(data['project']['key'], raw['project']['key'])
                self.assertRegex(data['project']['key'], KEY)
                self.assertEqual(data['project']['dialect'], 'sqlite' if path.stem == 'small' else 'postgresql')
                self.assertEqual(len(data['tables']), len(raw['tables']))
                for table in data['tables']:
                    self.assertIsInstance(table['pk'], str)
                    for column in table['allColumns']:
                        self.assertIn(column['nullable'], ('', 'True', 'False'))
                # normalize() only drops inferred links that shadow a declared FK; fixtures never rely on that.
                self.assertEqual(len(data['links']), len(raw['links']))

    def test_R01_valid_contract_cases_pass_normalize(self):
        for path in sorted((FIXTURES / 'contract' / 'valid').glob('*.json')):
            with self.subTest(fixture=path.name):
                raw = load(path)
                self.assertNotIn('$expectedError', raw)
                data = normalize(raw)
                self.assertGreater(len(data['tables']), 0)

    def test_R01_invalid_contract_cases_raise_expected_error(self):
        for path in sorted((FIXTURES / 'contract' / 'invalid').glob('*.json')):
            with self.subTest(fixture=path.name):
                raw = load(path)
                expected = raw['$expectedError']
                self.assertIsInstance(expected, str)
                with self.assertRaises(ValueError) as caught:
                    normalize(raw)
                self.assertIn(expected, str(caught.exception))

    def test_R01_composite_evidence_survives_normalize(self):
        data = normalize(load(FIXTURES / 'contract' / 'valid' / 'composite-fk-group.json'))
        moves = next(t for t in data['tables'] if t['id'] == 'w.moves')
        self.assertEqual({c['fk'] for c in moves['allColumns'] if c['fk']}, {'w.items.tenant_id', 'w.items.id'})
        legacy = normalize(load(FIXTURES / 'contract' / 'valid' / 'legacy-flags.json'))['tables'][0]
        self.assertEqual(legacy['primaryKey'], ['id'])
        self.assertEqual(legacy['allColumns'][1]['nullable'], '')
        self.assertTrue(legacy['allColumns'][1]['unique'])

    def test_R01_medium_carries_no_measurements(self):
        raw = load(FIXTURES / 'schemas' / 'medium.json')
        for key in ('rowCount', 'rowCountLowerBound', 'profiling'):
            self.assertEqual(walk_keys(raw, key), 0, key)

    def test_R01_medium_measured_keeps_unknown_distinct_from_zero(self):
        raw = load(FIXTURES / 'schemas' / 'medium-measured.json')
        zero = [t for t in raw['tables'] if t.get('rowCount') == 0]
        unknown = [t for t in raw['tables'] if 'rowCount' not in t and 'rowCountLowerBound' not in t]
        bounded = [t for t in raw['tables'] if 'rowCountLowerBound' in t]
        self.assertGreaterEqual(len(zero), 5)
        self.assertGreaterEqual(len(unknown), 10)
        self.assertTrue(all('rowCount' not in t for t in bounded))
        for table in raw['tables']:
            self.assertNotIn(table.get('rowCount'), (None,) if 'rowCount' in table else ())

    def test_R01_hostile_fixture_renders_without_raw_markup(self):
        output = render(load(FIXTURES / 'schemas' / 'hostile.json'))
        self.assertNotIn('<img src=x', output)
        self.assertNotIn('</script><script>alert(1)', output)
        self.assertIn('\\u003c/script>', output)

    def test_R01_sqlite_seed_executes_with_foreign_keys_enforced(self):
        raw = load(FIXTURES / 'schemas' / 'medium-measured.json')
        connection = sqlite3.connect(':memory:')
        try:
            connection.executescript((FIXTURES / 'sql' / 'sqlite' / 'seed.sql').read_text(encoding='utf-8'))
            self.assertEqual(connection.execute('PRAGMA foreign_key_check').fetchall(), [])
            base = [t for t in raw['tables'] if t.get('kind') != 'view']
            created = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertEqual(created, {t['name'] for t in base})
            zero_row_tables = 0
            for table in base:
                count = connection.execute(f'SELECT count(*) FROM "{table["name"]}"').fetchone()[0]
                self.assertEqual(count, expected_seed_rows(table), table['id'])
                zero_row_tables += count == 0
            self.assertGreaterEqual(zero_row_tables, 1)
            # Deferred cycle edges are back-filled, not left NULL.
            ring = next(l for l in raw['links'] if l.get('constraintId', '').endswith('_ring'))
            source = next(t for t in raw['tables'] if t['id'] == ring['source'])
            filled = connection.execute(f'SELECT count(*) FROM "{source["name"]}" WHERE "{ring["column"]}" IS NOT NULL').fetchone()[0]
            self.assertGreater(filled, 0)
        finally:
            connection.close()

    def test_R01_postgresql_seed_structure(self):
        sql = (FIXTURES / 'sql' / 'pg' / 'seed.sql').read_text(encoding='utf-8')
        raw = load(FIXTURES / 'schemas' / 'medium-measured.json')
        base = [t for t in raw['tables'] if t.get('kind') != 'view']
        self.assertEqual(len(re.findall(r'^CREATE TABLE ', sql, re.M)), len(base))
        self.assertEqual(len(re.findall(r'^CREATE SCHEMA IF NOT EXISTS ', sql, re.M)), len({t['schema'] for t in base}))
        self.assertGreaterEqual(len(re.findall(r'^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY', sql, re.M)), 1)
        self.assertIn('not measured from this seed', sql)
        self.assertNotIn('\r', sql)


if __name__ == '__main__':
    unittest.main()
