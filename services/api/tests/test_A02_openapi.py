"""The OpenAPI document: no secret fields, the RBAC matrix, and no drift (A02; CTQ-07).

``test_A02_no_secret_fields_in_responses`` is the frozen-contract case, and it asserts on the
**schema** rather than on a handler. A handler can only be tested for the cases somebody thought
of; the schema is the exhaustive statement of what the API *can* return, so a field that would leak
a secret fails here the moment it is declared, whether or not any test calls the route that
returns it.

Four exceptions exist, each named individually with the reason it is required: the API key's
plaintext at creation (``data-model.md`` 3.5; ADR-0005 decision 4), the double-submit CSRF token
on the login and CSRF responses (``security-architecture.md`` section 7), the password *policy*
object, and the boolean master-key readiness flag. Anything else matching the pattern is a
failure, including in a schema A03 or A04 adds later.
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any

from app.core.caveats import CAVEATS
from app.export_openapi import OPENAPI_PATH, ROLE_EXTENSION, build_document, render

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CAVEATS_DOC = REPOSITORY_ROOT / 'docs' / 'reference' / 'caveats.md'

#: A property name matching any of these could carry a credential.
FORBIDDEN_FRAGMENTS = (
    'password',
    'dsn',
    'secret',
    'token',
    'hash',
    'encrypted',
    'key_id',
    'keyid',
    'masterkey',
    'master_key',
)

#: ``(schema, property)`` pairs allowed to match, each because the design requires it.
PERMITTED = {
    ('ApiKeyCreated', 'apiKey'): 'the key plaintext, shown once at creation (ADR-0005 decision 4)',
    ('LoginResponse', 'csrfToken'): 'the double-submit token the SPA must read (section 7)',
    ('CsrfResponse', 'csrfToken'): 'the double-submit token the SPA must read (section 7)',
    ('MeResponse', 'passwordPolicy'): 'the policy rules (minimum length), not a credential',
    ('Readiness', 'masterKey'): 'a boolean readiness flag; the key and its fingerprint stay server-side',
}


def response_schemas(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every component schema reachable from a *response* body, by name.

    Requests are excluded deliberately: ``LoginRequest.password`` is the whole point of a login
    body, and the contract is about what the API *returns*. The walk follows ``$ref``, ``items``,
    ``properties``, ``additionalProperties``, ``anyOf``, ``allOf`` and ``oneOf``, so a secret
    nested three models deep is still found.
    """
    components = document.get('components', {})
    schemas = components.get('schemas', {}) if isinstance(components, dict) else {}
    assert isinstance(schemas, dict)
    reachable: dict[str, dict[str, Any]] = {}

    def visit(node: object) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        reference = node.get('$ref')
        if isinstance(reference, str) and reference.startswith('#/components/schemas/'):
            name = reference.rsplit('/', 1)[-1]
            if name not in reachable and name in schemas:
                reachable[name] = schemas[name]
                visit(schemas[name])
            return
        for key in ('items', 'additionalProperties', 'anyOf', 'allOf', 'oneOf', 'properties'):
            if key in node:
                visit(node[key])
        return

    paths = document.get('paths', {})
    assert isinstance(paths, dict)
    for operations in paths.values():
        for operation in operations.values():
            for response in operation.get('responses', {}).values():
                for media in response.get('content', {}).values():
                    visit(media.get('schema'))
    return reachable


class DocumentTests(ApiTestCase):
    def setUp(self) -> None:
        self.document = build_document(self.application)

    def test_A02_no_secret_fields_in_responses(self) -> None:
        """No response schema may declare a field that could carry a credential."""
        offending: list[str] = []
        schemas = response_schemas(self.document)
        self.assertGreater(len(schemas), 5, 'the response schemas could not be walked')
        for name, schema in schemas.items():
            for field in schema.get('properties', {}):
                lowered = field.lower()
                if not any(fragment in lowered for fragment in FORBIDDEN_FRAGMENTS):
                    continue
                if (name, field) in PERMITTED:
                    continue
                offending.append(f'{name}.{field}')
        self.assertEqual(
            offending,
            [],
            'a response schema declares a field that could carry a secret; if it is genuinely '
            'required, add it to PERMITTED with the reason',
        )

    def test_A02_the_permitted_exceptions_still_exist(self) -> None:
        """A stale exception is as bad as a missing check: it hides the next real one."""
        schemas = self.document.get('components', {}).get('schemas', {})
        for (name, field), reason in PERMITTED.items():
            with self.subTest(schema=name, field=field, reason=reason):
                self.assertIn(name, schemas)
                self.assertIn(field, schemas[name].get('properties', {}))

    def test_A02_readiness_master_key_is_a_boolean_flag(self) -> None:
        """The one permitted ``masterKey`` field must be a flag, never a value."""
        readiness = self.document['components']['schemas']['Readiness']
        self.assertEqual(readiness['properties']['masterKey']['type'], 'boolean')

    def test_A02_request_models_forbid_unknown_fields(self) -> None:
        """A body field the model does not declare is rejected, not ignored."""
        schemas = self.document.get('components', {}).get('schemas', {})
        for name in ('LoginRequest', 'WorkspaceCreateRequest', 'ApiKeyCreateRequest'):
            with self.subTest(schema=name):
                self.assertFalse(
                    schemas[name].get('additionalProperties', False),
                    f'{name} must not accept unknown fields',
                )

    def test_A02_every_operation_declares_its_role(self) -> None:
        """``x-backend-buddy-role`` makes the RBAC matrix reviewable as a diff."""
        for path, operations in self.document['paths'].items():
            for method, operation in operations.items():
                with self.subTest(route=f'{method.upper()} {path}'):
                    self.assertIn(ROLE_EXTENSION, operation)
                    self.assertIn(
                        operation[ROLE_EXTENSION],
                        ('public', 'authenticated', 'viewer', 'reviewer', 'admin', 'owner'),
                    )

    def test_A02_no_interactive_documentation_is_served(self) -> None:
        """Swagger UI needs an inline script and a CDN; the strict SPA CSP forbids both."""
        for path in ('/docs', '/redoc', '/openapi.json'):
            with self.subTest(path=path):
                self.assertNotIn(path, self.document['paths'])

    def test_A02_the_description_quotes_caveat_c14(self) -> None:
        """The document a security reviewer reads carries the canonical wording, verbatim."""
        self.assertIn(CAVEATS['C14'], self.document['info']['description'])


class CaveatMirrorTests(unittest.TestCase):
    def test_A02_caveats_quote_the_canonical_file(self) -> None:
        """``app.core.caveats`` is a mirror, and a mirror that drifts is a paraphrase."""
        text = CAVEATS_DOC.read_text(encoding='utf-8')
        for identifier, quoted in CAVEATS.items():
            with self.subTest(caveat=identifier):
                section = text[text.index(f'## {identifier} ') :]
                blockquote = next(
                    line[2:].strip()
                    for line in section.splitlines()
                    if line.startswith('> ')
                )
                self.assertEqual(quoted, blockquote)


class DriftTests(unittest.TestCase):
    def test_A02_committed_openapi_document_is_current(self) -> None:
        """What ``python -m app.export_openapi --check`` asserts, as a unit test."""
        self.assertTrue(OPENAPI_PATH.is_file(), 'run python -m app.export_openapi')
        committed = OPENAPI_PATH.read_text(encoding='utf-8')
        self.assertEqual(
            committed,
            render(build_document()),
            'services/api/openapi.json is stale; run python -m app.export_openapi and commit it',
        )

    def test_A02_export_openapi_check_exits_zero(self) -> None:
        """The acceptance command itself, run as a subprocess from ``services/api``."""
        completed = subprocess.run(
            [sys.executable, '-m', 'app.export_openapi', '--check'],
            cwd=SERVICE_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == '__main__':
    unittest.main()
