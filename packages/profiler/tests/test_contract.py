"""Contract validation tests (work package C01, CTQ-01 / CTQ-07 / CTQ-13).

The shared corpus is exercised from both sides. Here, on the Python side:

* every ``fixtures/schemas/*.json`` and every valid corpus document passes both stages;
* every invalid corpus document is rejected, with the wording the corpus records for the stage
  that rejects it first: ``$structuralError`` (the JSON Schema instance path) when the schema
  rejects it, otherwise ``$expectedError`` (``normalize()``'s own message);
* the caps in the schema equal the caps in the code they mirror, so the schema cannot drift into
  accepting a document the renderer would reject.

Run from the repository root::

    python -m unittest discover -s packages/profiler/tests -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'fixtures'
RENDERER = ROOT / 'skill' / 'scripts' / 'build_explorer.py'
CORPUS_ROOTS = (FIXTURES / 'contract', FIXTURES / 'contract' / 'v1')
# Invalid corpus documents that only normalize() can reject: cross-document rules the JSON Schema
# cannot express, so the oracle is the only place they live.
SEMANTIC_ONLY = frozenset({
    'duplicate-table-id',
    'duplicate-column-name',
    'unresolved-declared-fk',
})

# The suite runs from a checkout without installing anything but requirements.txt, so the package
# under test and the two modules whose caps it mirrors are added to the path here.
for _source in (ROOT / 'packages' / 'profiler', ROOT / 'skill' / 'scripts', ROOT / 'packages' / 'explorer' / 'server'):
    if str(_source) not in sys.path:
        sys.path.insert(0, str(_source))

import build_explorer  # noqa: E402  (path set up above)
import schema_profiler  # noqa: E402  (path set up above; nothing connects on import)
from jsonschema import Draft202012Validator  # noqa: E402

from bb_profiler import CONTRACT_VERSION  # noqa: E402
from bb_profiler.contract import (  # noqa: E402
    CONTRACT_PATH_VARIABLE,
    ContractError,
    contract_path,
    contract_schema,
    validate_document,
)


def load(path: Path) -> dict[str, Any]:
    document: Any = json.loads(path.read_text(encoding='utf-8'))
    return dict(document)


def schema_fixtures() -> list[Path]:
    return sorted((FIXTURES / 'schemas').glob('*.json'))


def corpus(outcome: str) -> Iterator[Path]:
    """Every corpus document of one outcome, from both the Part A and the contract v1 trees."""
    for root in CORPUS_ROOTS:
        yield from sorted((root / outcome).glob('*.json'))


def minimal(**graph: object) -> dict[str, Any]:
    """The smallest document both stages accept, with overrides merged in."""
    document: dict[str, Any] = {
        'project': {'name': 'Contract unit', 'key': 'contract-unit', 'dialect': 'postgresql'},
        'tables': [{'id': 'w.items', 'allColumns': [{'name': 'id', 'pk': True}]}],
        'links': [],
    }
    document.update(graph)
    return document


def properties_of(definition: str) -> dict[str, Any]:
    node: Any = contract_schema()['$defs'][definition]['properties']
    return dict(node)


def resolve(node: dict[str, Any]) -> dict[str, Any]:
    """Follows one local ``$ref`` so a cap can be read from the definition that declares it."""
    reference = node.get('$ref')
    if not isinstance(reference, str):
        return node
    name = reference.rsplit('/', 1)[-1]
    resolved: Any = contract_schema()['$defs'][name]
    return dict(resolved)


class ContractSchemaTests(unittest.TestCase):
    def test_C01_schema_is_a_valid_draft_2020_12_schema_carrying_v1(self) -> None:
        schema = contract_schema()
        Draft202012Validator.check_schema(schema)
        self.assertIn('v1', schema['$id'])
        self.assertEqual(schema['$ref'], '#/$defs/SchemaGraph')
        version = properties_of('SchemaGraph')['contractVersion']
        self.assertEqual(version['default'], CONTRACT_VERSION)
        self.assertEqual(version['pattern'], r'^1\.[0-9]+$')

    def test_C01_all_fixture_schemas_validate(self) -> None:
        self.assertGreaterEqual(len(schema_fixtures()), 7)
        for path in schema_fixtures():
            with self.subTest(fixture=path.name):
                raw = load(path)
                self.assertNotIn('contractVersion', raw, 'fixtures predate the field on purpose')
                normalized = validate_document(raw)
                self.assertEqual(normalized['contractVersion'], CONTRACT_VERSION)
                self.assertEqual(len(normalized['tables']), len(raw['tables']))

    def test_C01_valid_corpus_documents_pass_both_stages(self) -> None:
        paths = list(corpus('valid'))
        self.assertEqual(len(paths), 8)
        for path in paths:
            with self.subTest(fixture=path.name):
                raw = load(path)
                self.assertNotIn('$expectedError', raw)
                self.assertNotIn('$structuralError', raw)
                normalized = validate_document(raw)
                self.assertGreater(len(normalized['tables']), 0)

    def test_C01_invalid_corpus_documents_are_rejected_with_the_expected_error(self) -> None:
        paths = list(corpus('invalid'))
        self.assertEqual(len(paths), 10)
        for path in paths:
            with self.subTest(fixture=path.name):
                raw = load(path)
                structural = raw.get('$structuralError')
                expected = raw.get('$expectedError')
                self.assertTrue(structural or expected, 'an invalid case must record at least one stage')
                with self.assertRaises(ContractError) as caught:
                    validate_document(raw)
                message = str(caught.exception)
                if structural is None:
                    self.assertIn(expected, message)
                else:
                    self.assertTrue(message.startswith(f'{structural}: '), message)
                if expected is not None:
                    with self.assertRaises(ValueError) as oracle:
                        build_explorer.normalize(raw)
                    self.assertIn(expected, str(oracle.exception))

    def test_C01_structural_and_semantic_stages_partition_the_invalid_corpus(self) -> None:
        """Each invalid document is rejected by the stage its corpus fields claim, and by no other."""
        validator = Draft202012Validator(contract_schema())
        structural: set[str] = set()
        semantic: set[str] = set()
        for path in corpus('invalid'):
            raw = load(path)
            (structural if '$structuralError' in raw else semantic).add(path.stem)
            self.assertEqual(validator.is_valid(raw), '$structuralError' not in raw, path.name)
        self.assertEqual(semantic, set(SEMANTIC_ONLY))
        self.assertEqual(structural, {p.stem for p in corpus('invalid')} - SEMANTIC_ONLY)
        self.assertEqual(structural & semantic, set())


class ContractVersionTests(unittest.TestCase):
    def test_C01_contract_version_absent_defaults_to_one_zero(self) -> None:
        normalized = validate_document(minimal())
        self.assertEqual(normalized['contractVersion'], '1.0')

    def test_C01_contract_version_minor_is_accepted_and_unknown_fields_survive(self) -> None:
        normalized = validate_document(minimal(contractVersion='1.7', futureField={'note': 'kept'}))
        self.assertEqual(normalized['contractVersion'], '1.7')
        self.assertEqual(normalized['futureField'], {'note': 'kept'})

    def test_C01_contract_version_major_mismatch_is_rejected_by_both_stages(self) -> None:
        document = minimal(contractVersion='2.0')
        with self.assertRaises(ContractError) as caught:
            validate_document(document)
        self.assertIn('contractVersion:', str(caught.exception))
        # The oracle carries the same rule, so removing the schema pattern would not open a hole.
        with self.assertRaises(ValueError) as oracle:
            build_explorer.normalize(document)
        self.assertIn('not compatible with contract version', str(oracle.exception))

    def test_C01_semantic_rejection_comes_from_normalize(self) -> None:
        """A structurally valid document that only the oracle rejects reports the oracle's words."""
        raw = load(FIXTURES / 'contract' / 'invalid' / 'unresolved-declared-fk.json')
        self.assertTrue(Draft202012Validator(contract_schema()).is_valid(raw))
        with self.assertRaises(ContractError) as caught:
            validate_document(raw)
        message = str(caught.exception)
        self.assertEqual(message, 'Unresolved declared FK target: w.items.id')
        self.assertIn('Unresolved declared FK target', RENDERER.read_text(encoding='utf-8'))


class ContractFieldRuleTests(unittest.TestCase):
    def test_C01_lower_bound_requires_null_rowcount(self) -> None:
        table = {'id': 'w.items', 'allColumns': [{'name': 'id'}], 'rowCountLowerBound': 10}
        self.assertEqual(validate_document(minimal(tables=[dict(table)]))['tables'][0]['rowCountLowerBound'], 10)
        unknown = validate_document(minimal(tables=[{**table, 'rowCount': None}]))
        self.assertIsNone(unknown['tables'][0]['rowCount'])
        with self.assertRaises(ContractError) as caught:
            validate_document(minimal(tables=[{**table, 'rowCount': 10}]))
        self.assertIn('tables/0/rowCount:', str(caught.exception))
        # Zero is a measured value, so it is rejected next to a lower bound just like any other count.
        with self.assertRaises(ContractError):
            validate_document(minimal(tables=[{**table, 'rowCount': 0}]))

    def test_C01_legacy_flags_and_nullable_forms_are_accepted(self) -> None:
        raw = load(FIXTURES / 'contract' / 'valid' / 'legacy-flags.json')
        columns = validate_document(raw)['tables'][0]['allColumns']
        self.assertEqual([column['pk'] for column in columns], [True, False, False])
        self.assertEqual([column['nullable'] for column in columns], ['False', '', ''])
        for form in (True, False, None, '', 'True', 'False', 'true', 'false', 0, 1):
            with self.subTest(form=form):
                document = minimal(tables=[{'id': 'w.items', 'allColumns': [{'name': 'id', 'nullable': form}]}])
                coerced = validate_document(document)['tables'][0]['allColumns'][0]['nullable']
                self.assertIn(coerced, ('', 'True', 'False'))

    def test_C01_enumerations_are_the_frozen_contract_values(self) -> None:
        self.assertEqual(properties_of('SchemaTable')['kind']['enum'], ['table', 'view'])
        self.assertEqual(properties_of('SchemaLink')['kind']['enum'], ['declared FK', 'inferred by naming'])
        self.assertEqual(properties_of('TableProfiling')['status']['enum'], ['complete', 'incomplete'])
        self.assertEqual(properties_of('SchemaLink')['cardinality']['enum'], ['one-to-many', 'one-to-one', 'unknown'])

    def test_C01_length_caps_equal_the_renderer_and_profiler_caps(self) -> None:
        table = properties_of('SchemaTable')
        column = properties_of('SchemaColumn')
        self.assertEqual(resolve(table['name'])['maxLength'], build_explorer.NAME_CAP)
        self.assertEqual(resolve(table['id'])['maxLength'], build_explorer.NAME_CAP)
        self.assertEqual(resolve(table['definition'])['maxLength'], build_explorer.TEXT_CAP)
        self.assertEqual(resolve(column['typeDefinition'])['maxLength'], build_explorer.TEXT_CAP)
        for holder in (column['sampleValues'], properties_of('ColumnProfiling')['sampleValues']):
            self.assertEqual(holder['maxItems'], 3)
            self.assertEqual(resolve(holder['items'])['maxLength'], schema_profiler.MAX_SCALAR_LENGTH)
        for field in ('line',):
            self.assertEqual(resolve(table[field]), {'type': 'integer', 'minimum': 0})

    def test_C01_oversized_and_wrongly_typed_values_are_rejected_before_normalize(self) -> None:
        long_name = 'x' * (build_explorer.NAME_CAP + 1)
        cases = {
            'tables/0/name:': minimal(tables=[{'id': 'w.items', 'name': long_name, 'allColumns': [{'name': 'id'}]}]),
            'tables/0/line:': minimal(tables=[{'id': 'w.items', 'line': '12', 'allColumns': [{'name': 'id'}]}]),
            'tables/0/allColumns/0/line:': minimal(
                tables=[{'id': 'w.items', 'allColumns': [{'name': 'id', 'line': -1}]}]
            ),
            'links/0/kind:': minimal(
                links=[{'source': 'w.items', 'column': 'id', 'target': 'w.items', 'targetColumn': 'id', 'kind': 'fk'}]
            ),
        }
        for expected, document in cases.items():
            with self.subTest(expected=expected), self.assertRaises(ContractError) as caught:
                validate_document(document)
            self.assertIn(expected, str(caught.exception))

    def test_C01_validation_does_not_mutate_the_input(self) -> None:
        raw = load(FIXTURES / 'schemas' / 'small.json')
        before = json.dumps(raw, sort_keys=True)
        validate_document(raw)
        self.assertEqual(json.dumps(raw, sort_keys=True), before)


class ContractLocationTests(unittest.TestCase):
    def test_C01_contract_path_resolves_to_the_committed_schema(self) -> None:
        self.assertEqual(contract_path(), ROOT / 'packages' / 'contract' / 'schema-graph.v1.json')

    def test_C01_contract_path_honours_the_environment_override(self) -> None:
        previous = os.environ.get(CONTRACT_PATH_VARIABLE)
        os.environ[CONTRACT_PATH_VARIABLE] = str(RENDERER)
        try:
            self.assertEqual(contract_path(), RENDERER)
            os.environ[CONTRACT_PATH_VARIABLE] = str(ROOT / 'packages' / 'contract' / 'absent.json')
            with self.assertRaises(ContractError) as caught:
                contract_path()
            self.assertIn(CONTRACT_PATH_VARIABLE, str(caught.exception))
        finally:
            if previous is None:
                del os.environ[CONTRACT_PATH_VARIABLE]
            else:
                os.environ[CONTRACT_PATH_VARIABLE] = previous


if __name__ == '__main__':
    unittest.main()
