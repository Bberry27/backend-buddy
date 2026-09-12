"""SchemaGraph contract validation: JSON Schema first, then ``normalize()`` as the oracle.

Work package C01 (CTQ-01, CTQ-07, CTQ-13). Two stages, in this order:

1. **Structural** -- ``packages/contract/schema-graph.v1.json`` through
   ``jsonschema.Draft202012Validator``: types, enumerations, required fields, length caps and
   numeric bounds. An oversized or wrongly typed document is rejected here, before any of it is
   used to build a string.
2. **Semantic** -- ``normalize()`` from ``skill/scripts/build_explorer.py``, imported by path and
   never reimplemented (ADR-0003 decision 4). It owns unique ids, declared-target resolution,
   duplicate pairs, composite-group consistency and inferred dedupe, and it returns the
   normalized document every reader consumes.

Both stages raise :class:`ContractError`, a :class:`ValueError`, so a caller that already handles
``normalize()``'s errors needs no change.

Usage::

    from bb_profiler.contract import ContractError, validate_document

    try:
        graph = validate_document(json.loads(payload))
    except ContractError as error:
        ...  # error carries the instance path for a structural failure, or normalize()'s message

The schema file is located relative to the repository root that contains this package. Set
``BB_CONTRACT_PATH`` to point at another copy, for example the one shipped with the skill.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

__all__ = [
    'CONTRACT_PATH_VARIABLE',
    'ContractError',
    'contract_path',
    'contract_schema',
    'format_structural_error',
    'validate_document',
]

CONTRACT_PATH_VARIABLE = 'BB_CONTRACT_PATH'
_SCHEMA_RELATIVE = Path('packages') / 'contract' / 'schema-graph.v1.json'
_RENDERER_RELATIVE = Path('skill') / 'scripts' / 'build_explorer.py'
_ROOT_LABEL = '(document root)'


class ContractError(ValueError):
    """A document that the JSON Schema or ``normalize()`` rejected."""


def _repository_root() -> Path:
    """The first ancestor directory that holds both the schema file and the renderer."""
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / _SCHEMA_RELATIVE).is_file() and (candidate / _RENDERER_RELATIVE).is_file():
            return candidate
    raise ContractError(
        f'Cannot locate {_SCHEMA_RELATIVE.as_posix()} and {_RENDERER_RELATIVE.as_posix()} above '
        f'{here.parent}. Set {CONTRACT_PATH_VARIABLE} to the schema file.'
    )


def contract_path() -> Path:
    """Path of the JSON Schema in force, honouring the ``BB_CONTRACT_PATH`` override."""
    override = os.environ.get(CONTRACT_PATH_VARIABLE)
    if override:
        path = Path(override).expanduser()
        if not path.is_file():
            raise ContractError(f'{CONTRACT_PATH_VARIABLE} does not name a readable file: {path}')
        return path
    return _repository_root() / _SCHEMA_RELATIVE


@lru_cache(maxsize=4)
def _validator(path: Path, mtime: float) -> Draft202012Validator:
    schema: Any = json.loads(path.read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _current_validator() -> Draft202012Validator:
    path = contract_path()
    return _validator(path, path.stat().st_mtime)


def contract_schema() -> dict[str, Any]:
    """The parsed JSON Schema in force."""
    schema = _current_validator().schema
    if not isinstance(schema, dict):
        raise ContractError('The contract schema must be a JSON object.')
    return schema


@lru_cache(maxsize=1)
def _renderer() -> ModuleType:
    """Import ``build_explorer`` by path so the single oracle is used, never a copy of its rules."""
    path = _repository_root() / _RENDERER_RELATIVE
    name = 'bb_profiler._build_explorer'
    existing = sys.modules.get(name)
    if isinstance(existing, ModuleType):
        return existing
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise ContractError(f'Cannot import the contract oracle from {path}.')
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


def _location(error: ValidationError) -> str:
    return '/'.join(str(part) for part in error.absolute_path) or _ROOT_LABEL


def format_structural_error(error: ValidationError) -> str:
    """``<instance path>: <message>``, the wording the invalid corpus records."""
    return f'{_location(error)}: {error.message}'


def _first_error(errors: Iterable[ValidationError]) -> ValidationError | None:
    """The shallowest, then earliest, error, so one document always reports one stable message."""
    ordered = sorted(errors, key=lambda error: (len(error.absolute_path), _location(error), error.message))
    return ordered[0] if ordered else None


def validate_document(raw: object) -> dict[str, Any]:
    """Validate one SchemaGraph document and return it normalized.

    Raises :class:`ContractError` with the structural error's instance path, or with
    ``normalize()``'s own message when the document is structurally valid but semantically wrong.
    The input is never mutated: ``normalize()`` deep-copies it.
    """
    error = _first_error(_current_validator().iter_errors(raw))
    if error is not None:
        raise ContractError(format_structural_error(error))
    try:
        normalized = _renderer().normalize(raw)
    except ValueError as cause:
        raise ContractError(str(cause)) from cause
    if not isinstance(normalized, dict):
        raise ContractError('normalize() must return a JSON object.')
    return normalized
