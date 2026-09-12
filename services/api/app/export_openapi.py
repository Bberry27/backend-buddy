"""``python -m app.export_openapi``: write or check ``services/api/openapi.json`` (A02).

The document is committed, for two reasons that have nothing to do with documentation:

* W01 generates the SPA's client types from it, so it is a build input, and a build input that is
  regenerated at build time from a running server is a build that needs a database;
* it is the exhaustive statement of what the API can return, which is what makes
  ``test_A02_no_secret_fields_in_responses`` and the RBAC matrix reviewable as a diff rather than
  as a test log.

``--check`` regenerates and compares, and exits 1 on any difference. It runs in the acceptance
commands and, from O02, in CI, so a route added without regenerating the document fails there
rather than at the next SPA build.

Every operation carries ``x-backend-buddy-role``: the declaration :mod:`app.auth.rbac` enforces, read out
of the assembled application's dependency graph rather than written down again here. The RBAC
matrix is therefore part of the committed document.

The output is deterministic -- sorted keys, two-space indent, one trailing newline -- because a
document whose key order changes between runs cannot be diffed, and a diff is the whole point.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Final

from fastapi import FastAPI

from app.auth.rbac import route_declarations
from app.core.settings import Settings
from app.main import create_app

__all__ = ['OPENAPI_PATH', 'build_document', 'main', 'render']

#: ``services/api/openapi.json``.
OPENAPI_PATH: Final = Path(__file__).resolve().parents[1] / 'openapi.json'

#: The extension key carrying each operation's declared minimum role.
ROLE_EXTENSION: Final = 'x-backend-buddy-role'


def _export_settings() -> Settings:
    """Settings for a document build: the environment, with the parts that must not matter fixed.

    Generating the document must not depend on a deployment's secrets or on reaching a database,
    and it must produce the same bytes on every machine. Both hold here: the engine is lazy
    (:class:`app.core.database.Database`), and nothing in the document is derived from a setting.
    """
    return Settings.from_environment()


def build_document(application: FastAPI | None = None) -> dict[str, Any]:
    """The OpenAPI document, with ``x-backend-buddy-role`` added to every operation."""
    app = application or create_app(_export_settings())
    document: dict[str, Any] = app.openapi()
    declarations = {
        (method, path): declaration for method, path, declaration in route_declarations(app.routes)
    }
    paths: dict[str, Any] = document.get('paths', {})
    for path, operations in paths.items():
        for method, operation in operations.items():
            declaration = declarations.get((method.upper(), path))
            if declaration is not None and isinstance(operation, dict):
                operation[ROLE_EXTENSION] = declaration
    return document


def render(document: dict[str, Any]) -> str:
    """The document as the bytes that belong in the file."""
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def main(argv: list[str] | None = None) -> int:
    """Write the document, or check it. Returns the process exit code."""
    parser = argparse.ArgumentParser(
        prog='python -m app.export_openapi',
        description='Write services/api/openapi.json, or check it for drift.',
    )
    parser.add_argument(
        '--check',
        action='store_true',
        help='exit 1 when the committed document differs from the generated one',
    )
    parser.add_argument(
        '--output',
        type=Path,
        default=OPENAPI_PATH,
        help='where to write (default: services/api/openapi.json)',
    )
    arguments = parser.parse_args(argv)

    generated = render(build_document())
    if not arguments.check:
        arguments.output.write_text(generated, encoding='utf-8', newline='\n')
        print(f'wrote {arguments.output} ({len(generated)} bytes)')
        return 0

    if not arguments.output.is_file():
        print(f'{arguments.output} does not exist; run python -m app.export_openapi', file=sys.stderr)
        return 1
    committed = arguments.output.read_text(encoding='utf-8')
    if committed == generated:
        print(f'{arguments.output} is up to date')
        return 0
    print(
        f'{arguments.output} is stale. Run `python -m app.export_openapi` from services/api and '
        'commit the result.',
        file=sys.stderr,
    )
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
