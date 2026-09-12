"""``bb_profiler``: contract validation today, bounded read-only profiling from A03 onward.

Work package C01 creates the package with one module, :mod:`bb_profiler.contract`. Nothing here
opens a database connection, and nothing discovers credentials: profiling arrives with A03, which
moves ``schema_profiler`` in behind a driver protocol and keeps its caps unchanged.

Importing this package imports no optional dependency and performs no I/O.
"""

from __future__ import annotations

__all__ = ['CONTRACT_VERSION', '__version__']

#: Package version, kept in step with ``packages/profiler/pyproject.toml``.
__version__ = '0.1.0'

#: Contract version this package validates against (``packages/contract/schema-graph.v1.json``).
#: A document without ``contractVersion`` is treated as this version; a different major is rejected.
CONTRACT_VERSION = '1.0'
