import json
import tempfile
import unittest
from pathlib import Path

from build_explorer import normalize, render


def fixture():
    def col(name, **kw):
        return {'name': name, 'type': 'Integer', 'nullable': False, **kw}
    return {
        'project': {'name': 'Warehouse QA', 'key': 'warehouse-qa', 'dialect': 'postgresql'},
        'tables': [
            {'id': 'warehouse.items', 'schema': 'warehouse', 'name': 'items', 'primaryKey': ['tenant_id', 'id'], 'rowCount': 4, 'allColumns': [col('id'), col('tenant_id'), col('metadata_json', type='Text')]},
            {'id': 'warehouse.moves', 'schema': 'warehouse', 'name': 'moves', 'rowCount': 20, 'allColumns': [col('id', pk=True), col('tenant_id'), col('item_id'), col('amount', type='Numeric', profiling={'nullFraction': 0.1, 'distinctCount': 8, 'sampleSize': 20, 'sampled': False})]},
        ],
        'links': [
            {'source': 'warehouse.moves', 'column': 'tenant_id', 'target': 'warehouse.items', 'targetColumn': 'tenant_id', 'kind': 'declared FK', 'constraintId': 'fk_item'},
            {'source': 'warehouse.moves', 'column': 'item_id', 'target': 'warehouse.items', 'targetColumn': 'id', 'kind': 'declared FK', 'constraintId': 'fk_item'},
        ],
    }


class RendererTests(unittest.TestCase):
    def test_composite_order_and_fk_membership(self):
        result = normalize(fixture())
        self.assertEqual(result['tables'][0]['primaryKey'], ['tenant_id', 'id'])
        self.assertEqual(result['tables'][0]['pk'], 'tenant_id, id')
        self.assertEqual(result['tables'][1]['allColumns'][2]['fk'], 'warehouse.items.id')

    def test_unresolved_declared_key_rejected(self):
        data = fixture()
        data['links'][0]['targetColumn'] = 'missing'
        with self.assertRaises(ValueError):
            render(data)

    def test_inferred_unresolved_reference_is_not_promoted(self):
        data = fixture()
        data['links'] = [{**data['links'][0], 'target': 'unresolved', 'kind': 'inferred by naming'}]
        result = normalize(data)
        self.assertEqual(result['tables'][1]['allColumns'][1]['fk'], '')

    def test_duplicate_columns_rejected(self):
        data = fixture()
        data['tables'][0]['allColumns'].append({'name': 'id'})
        with self.assertRaises(ValueError):
            normalize(data)

    def test_partial_indexes_remain_labeled(self):
        data = fixture()
        data['tables'][1]['indexes'] = [{'columns': ['item_id'], 'partial': True}]
        self.assertTrue(normalize(data)['tables'][1]['indexes'][0]['partial'])

    def test_unknown_constraint_names_are_not_invented(self):
        data = fixture()
        data['tables'][1]['uniques'] = [{'columns': ['tenant_id', 'item_id']}]
        self.assertEqual(normalize(data)['tables'][1]['uniques'][0]['name'], '')

    def test_markup_cannot_break_script_or_project_title(self):
        data = fixture()
        data['project']['name'] = '<img src=x onerror=alert(1)>'
        data['tables'][0]['className'] = '</script><script>alert(1)</script>__ICON_DATA__'
        output = render(data)
        self.assertNotIn('<img src=x', output)
        self.assertNotIn('</script><script>alert(1)', output)
        self.assertIn('\\u003c/script>', output)
        self.assertIn('__ICON_DATA__', output)

    def test_empty_schema_and_unknown_dialect_supported(self):
        data = {'project': {'name': 'Empty', 'key': 'empty'}, 'tables': [], 'links': []}
        self.assertEqual(normalize(data)['project']['dialect'], 'unknown')
        self.assertIn('Empty', render(data))

    def test_project_key_is_preserved(self):
        data = fixture()
        data['project']['key'] = 'separate-project'
        self.assertEqual(normalize(data)['project']['key'], 'separate-project')


if __name__ == '__main__':
    unittest.main()
