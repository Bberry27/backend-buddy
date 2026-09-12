"""Connection checking and catalog introspection for the local admin area.

The catalog queries and the snapshot shape are the ones verified in
`scripts/introspect_pg.py`; this module imports them rather than restating them, so there
is one definition. Work package A03 moves both into the PostgreSQL driver and this module
becomes a thin call into it.
"""
from __future__ import annotations

import hashlib
import json
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'skill/scripts'))

from introspect_pg import diagnose, introspect, project_key  # noqa: E402

CONNECT_TIMEOUT = 10
STATEMENT_TIMEOUT_MS = 30_000

# Row counting is its own, separately consented step, so it carries its own bounds. Counting a very
# large table is a sequential scan on most PostgreSQL configurations, which is why one table is
# allowed to give up without taking the whole run with it.
COUNT_STATEMENT_TIMEOUT_MS = 15_000
COUNT_DEADLINE_SECONDS = 180

# Column statistics are heavier again: one pass per table, but that pass carries a count(DISTINCT)
# per column. Same shape of bound, more generous per table and for the run.
STATS_STATEMENT_TIMEOUT_MS = 60_000
STATS_DEADLINE_SECONDS = 900
# The contract caps a retained scalar at 256 characters (MAX_SCALAR_LENGTH), and the database is
# asked to do the truncation so an oversized value never crosses the wire.
STATS_SCALAR_CAP = 256


# libpq defaults sslrootcert to ~/.postgresql/root.crt. A container account created
# without a home directory has no such file, so verify-full fails with "root certificate
# file does not exist" even though the machine trusts the authority perfectly well. Point
# it at the distribution's bundle instead. Ordered by likelihood on the images we ship.
SYSTEM_CA_BUNDLES = (
    '/etc/ssl/certs/ca-certificates.crt',      # Debian, Ubuntu, Alpine
    '/etc/pki/tls/certs/ca-bundle.crt',        # Fedora, RHEL
    '/etc/ssl/ca-bundle.pem',                  # openSUSE
    '/etc/ssl/cert.pem',                       # macOS via Homebrew, some BSDs
)
VERIFYING_MODES = ('verify-full', 'verify-ca')


def system_ca_bundle() -> str:
    """The first CA bundle present, or '' when none is."""
    for candidate in SYSTEM_CA_BUNDLES:
        if Path(candidate).is_file():
            return candidate
    return ''


def _with_ca(dsn: str, ca_cert_pem: str) -> tuple[str, Path | None]:
    """Write a supplied authority to an owner-only temporary file and point libpq at it.

    With no authority supplied, a verifying mode is pointed at the system bundle, which is
    what makes a managed PostgreSQL work unmodified: its certificate chains to a root the
    image already trusts.
    """
    if not ca_cert_pem.strip():
        from psycopg import conninfo
        mode = conninfo.conninfo_to_dict(dsn).get('sslmode', '')
        if mode in VERIFYING_MODES and 'sslrootcert' not in dsn:
            bundle = system_ca_bundle()
            if bundle:
                return f'{dsn} sslrootcert={bundle}', None
        return dsn, None
    handle = tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False, encoding='utf-8')
    try:
        handle.write(ca_cert_pem if ca_cert_pem.endswith('\n') else ca_cert_pem + '\n')
    finally:
        handle.close()
    path = Path(handle.name)
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return f'{dsn} sslrootcert={path}', path


def _connect(dsn: str, ca_cert_pem: str):
    """Open a read-only session, mirroring schema_profiler.connect_readonly's guarantees."""
    import psycopg
    from psycopg import conninfo

    # A supplied authority is written to an owner-only file. It is not deleted here:
    # libpq reads it during the handshake and again on a reconnect, and in the container
    # it lands in a tmpfs that is discarded when the container stops.
    effective, _ = _with_ca(dsn, ca_cert_pem)
    config = conninfo.conninfo_to_dict(effective)
    if any(key in config for key in ('service', 'passfile')):
        raise ValueError('service and passfile are not supported; supply explicit fields')
    config.update(
        connect_timeout=CONNECT_TIMEOUT,
        options=f'-c default_transaction_read_only=on -c statement_timeout={STATEMENT_TIMEOUT_MS}',
    )
    try:
        connection = psycopg.connect(**config, autocommit=True)
    except Exception as error:  # noqa: BLE001 - re-raised as a readable message
        raise ConnectionError(diagnose(error, config)) from None
    connection.read_only = True
    return connection


def check_connection(dsn: str, ca_cert_pem: str) -> tuple[bool, str, str]:
    """Authenticate and confirm catalog read access. Returns (ok, detail, server_version)."""
    try:
        connection = _connect(dsn, ca_cert_pem)
    except ConnectionError as error:
        return False, str(error), ''
    except ValueError as error:
        return False, str(error), ''
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT version()')
            version = (cursor.fetchone() or [''])[0]
            # Prove the role can actually read the catalog, which is what introspection needs.
            cursor.execute("SELECT count(*) FROM information_schema.tables "
                           "WHERE table_schema NOT IN ('pg_catalog','information_schema')")
            visible = (cursor.fetchone() or [0])[0]
        short = version.split(' on ')[0] if version else 'unknown'
        if visible == 0:
            return (True, f'Connected to {short}, but this role can see no tables. '
                          'Grant USAGE on the schema and SELECT on its tables.', short)
        return True, f'Connected to {short}; {visible} tables visible.', short
    finally:
        connection.close()


def list_schemas(dsn: str, ca_cert_pem: str) -> list[str]:
    """Schemas holding at least one relation, excluding the system ones."""
    connection = _connect(dsn, ca_cert_pem)
    try:
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT n.nspname
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r','p','v','m','f')
                   AND n.nspname NOT IN ('pg_catalog','information_schema')
                   AND n.nspname NOT LIKE 'pg_%'
                 GROUP BY n.nspname
                 ORDER BY n.nspname
            """)
            return [row[0] for row in cursor.fetchall()]
    finally:
        connection.close()


def introspect_to_snapshot(dsn: str, ca_cert_pem: str, output: Path, *,
                           display_name: str, schemas: list[str] | None = None) -> dict[str, Any]:
    """Read the catalog and write a contract-valid snapshot. Returns a summary."""
    chosen = schemas or list_schemas(dsn, ca_cert_pem)
    if not chosen:
        raise RuntimeError('No readable schemas found. Grant USAGE on at least one schema.')

    connection = _connect(dsn, ca_cert_pem)
    try:
        from psycopg import conninfo
        config = conninfo.conninfo_to_dict(dsn)
        with connection.cursor() as cursor:
            cursor.execute('SELECT current_database(), version()')
            dbname, version = cursor.fetchone()
        graph = introspect(connection, chosen)
    finally:
        connection.close()

    dropped = graph.pop('droppedLinks')
    columns = sum(len(t['allColumns']) for t in graph['tables'])
    views = sum(1 for t in graph['tables'] if t.get('kind') == 'view')

    basis = [
        'Live PostgreSQL catalog introspection: tables, views, columns, primary keys, '
        'unique and check constraints, indexes, and declared foreign keys.',
        'No user table was queried, so no row counts or column statistics are present; '
        'unmeasured values are absent rather than estimated.',
        f'Schemas read: {", ".join(chosen)}.',
    ]
    if dropped:
        basis.append(f'{dropped} foreign-key column pairs referenced a table outside the '
                     'selected schemas and were omitted.')

    snapshot = {
        'contractVersion': '1.0',
        'project': {
            'name': display_name or dbname,
            'key': project_key(f'{dbname}-{config.get("host", "local")}'),
            'dialect': 'postgresql',
        },
        'source': {
            'file': f"{config.get('host', 'unknown')}/{dbname}",
            'commit': 'live-catalog',
            'sha256': hashlib.sha256(
                json.dumps(graph, sort_keys=True, default=str).encode()).hexdigest(),
            'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'basis': ' '.join(basis),
            'serverVersion': version.split(' on ')[0] if version else 'unknown',
        },
        'tables': graph['tables'],
        'links': graph['links'],
    }

    # The renderer's normalizer is the contract's oracle: fail here with a specific
    # message rather than at render time with a broken page.
    from build_explorer import normalize
    normalize(snapshot)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, indent=1), encoding='utf-8')
    return {
        'output': str(output),
        'database': dbname,
        'schemas': chosen,
        'tables': len(graph['tables']),
        'views': views,
        'columns': columns,
        'foreignKeyColumnPairs': len(graph['links']),
        'droppedLinks': dropped,
    }


# Fixed wording: `profiling.reason` is display text the caller chooses, and a person reads it in the
# inspector next to the table whose count is missing.
_COUNT_TIMEOUT_REASON = "Not counted: the count exceeded its per-table time limit."
_COUNT_DEADLINE_REASON = "Not counted: the run reached its overall time limit first."
_COUNT_VIEW_REASON = "Not counted: a view has no stored rows of its own."
_COUNT_ADDRESS_REASON = "Not counted: the snapshot carries no schema and table name to address."
_COUNT_SCOPE = "Row count only; no column values were read."
# Opening words of the sentence a run adds to source.basis, so a re-run replaces its own previous
# sentence instead of appending another.
_BASIS_MARKER = "Row counts measured for"


class CountTimedOut(RuntimeError):
    """The per-table statement timeout fired. The table keeps an unknown count."""


class CountFailed(RuntimeError):
    """The driver refused the count. ``str(self)`` is the reason a person will read."""


def merge_row_counts(document: dict[str, Any], count_table: Any, *,
                     deadline_seconds: float = COUNT_DEADLINE_SECONDS,
                     clock: Any = monotonic) -> dict[str, Any]:
    """
    Merge exact row counts into a snapshot in place, and report what happened.

    ``count_table(schema, name)`` returns the exact count, raises :class:`CountTimedOut` when the
    per-table limit fired, or :class:`CountFailed` with the reason. Everything that decides what
    reaches the snapshot lives here, with no database and no driver, because these are the rules
    that matter: an uncounted table keeps an **unknown** count and is labelled with the reason; it
    is never back-filled with zero, never given a planner estimate, and never left holding a count
    from an earlier run.
    """
    tables = document.get("tables") or []
    if not tables:
        raise RuntimeError("That snapshot holds no tables. Populate the structure first.")

    counted = skipped_views = failed = 0
    total_rows = 0
    started = clock()
    for table in tables:
        profiling = dict(table.get("profiling") or {})
        profiling["scope"] = _COUNT_SCOPE
        profiling["sampled"] = False

        if table.get("kind") == "view":
            # Counting a view executes it. That is a query result, not stored rows, and on an
            # expensive view it would be the slowest thing in the run.
            skipped_views += 1
            _mark_uncounted(table, profiling, _COUNT_VIEW_REASON)
            continue
        if clock() - started > deadline_seconds:
            failed += 1
            _mark_uncounted(table, profiling, _COUNT_DEADLINE_REASON)
            continue

        schema, name = table.get("schema"), table.get("name")
        if not schema or not name:
            failed += 1
            _mark_uncounted(table, profiling, _COUNT_ADDRESS_REASON)
            continue
        try:
            count = int(count_table(str(schema), str(name)))
        except CountTimedOut:
            failed += 1
            _mark_uncounted(table, profiling, _COUNT_TIMEOUT_REASON)
            continue
        except CountFailed as error:
            failed += 1
            _mark_uncounted(table, profiling, f"Not counted: {error}")
            continue

        counted += 1
        total_rows += count
        table["rowCount"] = count
        table["rowCountExact"] = True
        # A lower bound is meaningful only while the count is unknown, and the contract forbids
        # one beside a known count.
        table.pop("rowCountLowerBound", None)
        profiling["status"] = "complete"
        profiling.pop("reason", None)
        table["profiling"] = profiling

    elapsed = round(clock() - started, 1)
    source = document.setdefault("source", {})
    measured = (f"{_BASIS_MARKER} {counted} of {len(tables)} tables by exact count(*); "
                "no column value was read.")
    if skipped_views:
        measured += f" {skipped_views} views were not counted."
    if failed:
        measured += (f" {failed} tables could not be counted and keep an unknown count, each "
                     "labelled with the reason.")
    kept = source.get("basis", "").split(_BASIS_MARKER)[0].strip()
    source["basis"] = f"{kept} {measured}".strip()
    source["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    source["sha256"] = hashlib.sha256(
        json.dumps(tables, sort_keys=True, default=str).encode()).hexdigest()

    return {"tables": len(tables), "counted": counted, "views": skipped_views,
            "failed": failed, "rows": total_rows, "seconds": elapsed}


def _mark_uncounted(table: dict[str, Any], profiling: dict[str, Any], reason: str) -> None:
    """Leave the count unknown and say why. Never writes a zero, never keeps a stale count."""
    table.pop("rowCount", None)
    table.pop("rowCountExact", None)
    profiling["status"] = "incomplete"
    profiling["reason"] = reason
    table["profiling"] = profiling


def measure_row_counts(dsn: str, ca_cert_pem: str, snapshot: Path, *,
                       statement_timeout_ms: int = COUNT_STATEMENT_TIMEOUT_MS,
                       deadline_seconds: int = COUNT_DEADLINE_SECONDS) -> dict[str, Any]:
    """
    Count the rows of every table in an existing snapshot and merge the counts into it.

    This queries table data, which introspection deliberately does not, so it is a separate action
    behind its own consent. What it reads is only the count: ``SELECT count(*)`` returns one number
    and no column value, so nothing from inside a row can reach the snapshot.

    The rules about what is written live in :func:`merge_row_counts`; this function is the driver
    half -- a short-lived read-only session, one counting statement per table, closed in a finally.
    """
    import psycopg
    from psycopg import sql

    document = json.loads(snapshot.read_text(encoding="utf-8"))
    connection = _connect(dsn, ca_cert_pem)
    try:
        with connection.cursor() as cursor:
            # Per-table ceiling for this session only; the connection is short-lived and read-only,
            # so this outlives nothing.
            cursor.execute(sql.SQL("SET statement_timeout = {}").format(
                sql.Literal(int(statement_timeout_ms))))

            def count_table(schema: str, name: str) -> int:
                try:
                    # Composed identifiers, never string interpolation: as far as this process is
                    # concerned a table name is untrusted input (S01).
                    cursor.execute(sql.SQL("SELECT count(*) FROM {}").format(
                        sql.Identifier(schema, name)))
                    return int((cursor.fetchone() or [0])[0])
                except psycopg.errors.QueryCanceled as error:
                    raise CountTimedOut from error
                except psycopg.Error as error:
                    # The driver names the relation and the missing privilege, which is what a
                    # person needs. Collapse it to one line inside the field's length cap.
                    raise CountFailed(" ".join(str(error).split())[:150]) from error

            summary = merge_row_counts(document, count_table, deadline_seconds=deadline_seconds)
    finally:
        connection.close()

    # The renderer's normalizer is the contract's oracle: fail here with a specific message rather
    # than writing a snapshot that breaks the page.
    from build_explorer import normalize
    normalize(document)

    snapshot.write_text(json.dumps(document, indent=1), encoding="utf-8")
    return summary

# Types whose extremes are safe to retain by default. A minimum and a maximum are real values out
# of the user's table, so only the classes that cannot carry free text, a secret or an identifier
# are included: numbers, times and booleans. Text, binary, JSON, arrays, enums and UUIDs are
# excluded, which is the "string min/max off by default" rule from WP-A03. A UUID is excluded
# because it identifies a row even though it is not free text.
_EXTREME_SAFE_TYPES = (
    'smallint', 'integer', 'bigint', 'int2', 'int4', 'int8', 'serial', 'smallserial', 'bigserial',
    'numeric', 'decimal', 'real', 'double', 'float', 'money',
    'date', 'time', 'timestamp', 'interval',
)
_EXTREME_EXCLUDED_TOKENS = ('[]', 'array', 'json', 'xml', 'bytea', 'blob', 'uuid', 'char', 'text',
                            'enum', 'name', 'citext', 'vector', 'geometry', 'tsvector',
                            # No min()/max() aggregate exists for these in PostgreSQL, and their
                            # extremes would say nothing a distinct count does not.
                            'bool')

_STATS_SCOPE = 'Whole table; counts and, where the type allows it, extremes. No row was retained.'
_STATS_REDUCED_REASON = ('Null fractions only: this table has a column whose type supports no '
                         'distinct count or extreme, which the database refuses for the whole '
                         'statement.')
_STATS_TIMEOUT_REASON = 'Statistics not gathered: the scan exceeded its per-table time limit.'
_STATS_DEADLINE_REASON = 'Statistics not gathered: the run reached its overall time limit first.'
_STATS_BASIS_MARKER = 'Column statistics measured for'


def extremes_allowed(column_type: str) -> bool:
    """
    Whether a minimum and maximum may be retained for a column of this type.

    Extremes are real values from the table, so the default is to keep them only for types that
    cannot carry free text, a secret, or an identifier. Everything else gets counts alone.
    """
    kind = str(column_type or '').lower()
    if any(token in kind for token in _EXTREME_EXCLUDED_TOKENS):
        return False
    return any(kind.startswith(safe) or f' {safe}' in kind for safe in _EXTREME_SAFE_TYPES)


def merge_column_stats(document: dict[str, Any], profile_table: Any, *,
                       deadline_seconds: float = STATS_DEADLINE_SECONDS,
                       clock: Any = monotonic) -> dict[str, Any]:
    """
    Merge whole-table column statistics into a snapshot in place, and report what happened.

    ``profile_table(schema, name, columns)`` returns ``{'rows': int, 'columns': {name: {...}}}``
    where each column carries ``nonNull``, ``distinct`` and optionally ``min``/``max``. It raises
    :class:`CountTimedOut` or :class:`CountFailed`, exactly as the row counter does.

    These statistics are computed by the database over the whole table, not from a sample, so they
    are labelled ``sampled: False``. That also means the row count the same pass produces is exact
    and may be written as ``rowCount``; a sampling profiler could not do that, which is why this
    path does not go through one. A table that fails keeps whatever it had -- an exact row count
    from an earlier run is preserved, and no statistic is invented for it.
    """
    tables = document.get('tables') or []
    if not tables:
        raise RuntimeError('That snapshot holds no tables. Populate the structure first.')

    profiled = skipped_views = failed = reduced_tables = 0
    columns_profiled = extremes_kept = extremes_withheld = 0
    started = clock()
    for table in tables:
        profiling = dict(table.get('profiling') or {})
        if table.get('kind') == 'view':
            skipped_views += 1
            profiling['status'] = 'incomplete'
            profiling['reason'] = _COUNT_VIEW_REASON
            table['profiling'] = profiling
            continue
        if clock() - started > deadline_seconds:
            failed += 1
            profiling['status'] = 'incomplete'
            profiling['reason'] = _STATS_DEADLINE_REASON
            table['profiling'] = profiling
            continue

        schema, name = table.get('schema'), table.get('name')
        columns = table.get('allColumns') or []
        if not schema or not name or not columns:
            failed += 1
            profiling['status'] = 'incomplete'
            profiling['reason'] = _COUNT_ADDRESS_REASON if not (schema and name) else (
                'Statistics not gathered: the snapshot lists no columns for this table.')
            table['profiling'] = profiling
            continue

        wanted = [{'name': column['name'], 'extremes': extremes_allowed(column.get('type', ''))}
                  for column in columns]
        try:
            measured = profile_table(str(schema), str(name), wanted)
        except CountTimedOut:
            failed += 1
            profiling['status'] = 'incomplete'
            profiling['reason'] = _STATS_TIMEOUT_REASON
            table['profiling'] = profiling
            continue
        except CountFailed as error:
            failed += 1
            profiling['status'] = 'incomplete'
            profiling['reason'] = f'Statistics not gathered: {error}'
            table['profiling'] = profiling
            continue

        profiled += 1
        reduced = bool(measured.get('reduced'))
        reduced_tables += int(reduced)
        rows = int(measured['rows'])
        # The same pass counted the rows, over the whole table, so this count is exact.
        table['rowCount'] = rows
        table['rowCountExact'] = True
        table.pop('rowCountLowerBound', None)
        table['sampled'] = False
        table['sampleSize'] = rows
        # A reduced profile really is partial, and the contract's word for that is incomplete:
        # it keeps whatever was gathered and carries the reason.
        profiling['status'] = 'incomplete' if reduced else 'complete'
        profiling['scope'] = _STATS_SCOPE
        profiling['sampled'] = False
        profiling['sampleSize'] = rows
        if reduced:
            profiling['reason'] = _STATS_REDUCED_REASON
        else:
            profiling.pop('reason', None)
        table['profiling'] = profiling

        for column in columns:
            stats = (measured.get('columns') or {}).get(column['name'])
            if stats is None:
                continue
            columns_profiled += 1
            non_null = int(stats['nonNull'])
            entry: dict[str, Any] = {
                'nullFraction': (rows - non_null) / rows if rows else None,
                'sampleSize': rows,
                'sampled': False,
                'scope': 'table',
            }
            if 'distinct' in stats:
                entry['distinctCount'] = int(stats['distinct'])
            if 'min' in stats or 'max' in stats:
                entry['min'] = stats.get('min')
                entry['max'] = stats.get('max')
                extremes_kept += 1
            else:
                extremes_withheld += 1
            # stats is the legacy sibling of profiling; leaving both would show two answers.
            column.pop('stats', None)
            # Sample values are a further opt-in this action does not offer, so any left by an
            # earlier run must not survive a refresh that did not gather them.
            column.pop('sampleValues', None)
            column['profiling'] = entry

    elapsed = round(clock() - started, 1)
    source = document.setdefault('source', {})
    measured_note = (f'{_STATS_BASIS_MARKER} {profiled} of {len(tables)} tables over the whole '
                     f'table, not a sample: null fractions and distinct counts for '
                     f'{columns_profiled} columns, with extremes retained for {extremes_kept} of '
                     f'them and withheld for {extremes_withheld} whose type could carry free text, '
                     'a secret or an identifier. No row and no sample value was retained.')
    if skipped_views:
        measured_note += f' {skipped_views} views were skipped.'
    if reduced_tables:
        measured_note += (f' {reduced_tables} tables have a column type the database will not '
                          'aggregate and carry null fractions only.')
    if failed:
        measured_note += (f' {failed} tables could not be scanned and keep whatever they had, each '
                          'labelled with the reason.')
    kept = source.get('basis', '').split(_STATS_BASIS_MARKER)[0].strip()
    source['basis'] = f'{kept} {measured_note}'.strip()
    source['generated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    source['sha256'] = hashlib.sha256(
        json.dumps(tables, sort_keys=True, default=str).encode()).hexdigest()

    return {'tables': len(tables), 'profiled': profiled, 'views': skipped_views, 'failed': failed,
            'columns': columns_profiled, 'extremes': extremes_kept, 'reduced': reduced_tables,
            'withheld': extremes_withheld, 'seconds': elapsed}


def measure_column_stats(dsn: str, ca_cert_pem: str, snapshot: Path, *,
                         statement_timeout_ms: int = STATS_STATEMENT_TIMEOUT_MS,
                         deadline_seconds: int = STATS_DEADLINE_SECONDS) -> dict[str, Any]:
    """
    Gather column statistics for every table in a snapshot and merge them in.

    One pass per table, computed by the database: the aggregates come back, the rows do not. Only a
    minimum and a maximum are values out of the table, and those are retained only for types that
    cannot carry free text, a secret or an identifier, and are truncated by the database to the
    contract's scalar cap so an oversized value never crosses the wire.
    """
    import psycopg
    from psycopg import sql

    document = json.loads(snapshot.read_text(encoding='utf-8'))
    connection = _connect(dsn, ca_cert_pem)
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL('SET statement_timeout = {}').format(
                sql.Literal(int(statement_timeout_ms))))

            def build(schema: str, name: str, columns: list[dict[str, Any]], *,
                      full: bool) -> tuple[Any, list[tuple[str, bool, bool]]]:
                # One statement, one scan: count(*) plus, per column, a non-null count and --
                # when the statement is the full one -- a distinct count and the extremes.
                parts = [sql.SQL('count(*)')]
                order: list[tuple[str, bool, bool]] = []
                for column in columns:
                    identifier = sql.Identifier(column['name'])
                    parts.append(sql.SQL('count({})').format(identifier))
                    extremes = full and bool(column['extremes'])
                    if full:
                        parts.append(sql.SQL('count(DISTINCT {})').format(identifier))
                    if extremes:
                        cap = sql.Literal(STATS_SCALAR_CAP)
                        parts.append(sql.SQL('left(min({})::text, {})').format(identifier, cap))
                        parts.append(sql.SQL('left(max({})::text, {})').format(identifier, cap))
                    order.append((column['name'], full, extremes))
                statement = sql.SQL('SELECT {} FROM {}').format(
                    sql.SQL(', ').join(parts), sql.Identifier(schema, name))
                return statement, order

            def run(statement: Any) -> list[Any]:
                try:
                    cursor.execute(statement)
                    return list(cursor.fetchone() or [])
                except psycopg.errors.QueryCanceled as error:
                    raise CountTimedOut from error
                except psycopg.Error as error:
                    raise CountFailed(' '.join(str(error).split())[:150]) from error

            def profile_table(schema: str, name: str, columns: list[dict[str, Any]]) -> dict[str, Any]:
                reduced = False
                try:
                    statement, order = build(schema, name, columns, full=True)
                    row = run(statement)
                except CountFailed:
                    # One column of a type the database will not aggregate -- json and xml have no
                    # equality operator, some user-defined types have no ordering -- fails the whole
                    # statement. Rather than cost the table every statistic, fall back to the counts
                    # that work for any type. The caller labels the result as partial.
                    connection.rollback()
                    reduced = True
                    statement, order = build(schema, name, columns, full=False)
                    row = run(statement)

                result: dict[str, Any] = {'rows': int(row[0]), 'columns': {}, 'reduced': reduced}
                cursor_index = 1
                for column_name, distinct, extremes in order:
                    entry: dict[str, Any] = {'nonNull': int(row[cursor_index])}
                    cursor_index += 1
                    if distinct:
                        entry['distinct'] = int(row[cursor_index])
                        cursor_index += 1
                    if extremes:
                        entry['min'] = row[cursor_index]
                        entry['max'] = row[cursor_index + 1]
                        cursor_index += 2
                    result['columns'][column_name] = entry
                return result

            summary = merge_column_stats(document, profile_table, deadline_seconds=deadline_seconds)
    finally:
        connection.close()

    from build_explorer import normalize
    normalize(document)

    snapshot.write_text(json.dumps(document, indent=1), encoding='utf-8')
    return summary
