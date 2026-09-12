"""Optional, explicitly configured, read-only SchemaGraph services.

Use ``with connect_readonly('sqlite', '/absolute/catalog.sqlite') as db:``
and call ``profile(graph, db, ['table-id'])`` or
``subtree(graph, db, 'table-id', {'pk1': value, 'pk2': value}, depth=2)``.
SQLite connections supplied directly are also accepted (do not share a connection
concurrently or install a custom progress handler). PostgreSQL requires optional psycopg 3 and an explicit DSN string
or mapping containing host, dbname, user and password; nothing connects on import
and this module never discovers credentials from the environment.

Graph tables are a list with unique id, optional physical name/schema,
allColumns and optional primaryKey. Only graph-allowlisted identifiers are used;
all identifiers are quoted and all values are bound. Links have source (child
table id), column, target (parent table id), targetColumn and kind='declared FK'.
constraintId groups composite links within the same table pair. Other links are
ignored. Physical database objects and the connection itself must be trusted.

profile returns {graph: deep copy, sampled: True, limit: effective cap}. Selected
tables gain sampleSize, sampled, rowCountLowerBound and rowCountExact; rowCount
is exact only after exhaustion or when supplied as a nonnegative exact integer.
Each column gains profiling={nullFraction, distinctCount, min, max, sampleSize,
scope: 'sampled'}. Distinct counts exclude NULL; extrema are bounded JSON scalars
(date/time ISO strings, Decimal strings, binary hex strings). No rows are exported.
profile(..., include_sample_values=True) additionally stores at most three
distinct, non-NULL, bounded scalars in each selected column's sampleValues.
This keyword-only opt-in is for the HTTP wrapper's --include-sample-values flag.
Previously exported column sampleValues are removed from the returned graph
before profiling, including on unselected tables; the input is never mutated.

table.profiling includes sampleSize, sampled=True and scope='sampled'. Its
functionalDependencies contains single-column sample candidates
{determinant: column name, dependent: column name, distinctDeterminant,
distinctPair, sampleSize}, where distinct(A) == distinct(A,B). At most the first
32 eligible columns in graph order are compared: binary, structured, nonfinite,
and long (>256 character) values are excluded. NULL is one distinct category in
these comparisons (unlike the non-NULL column distinctCount). Constant and
sample-unique determinants are skipped; A == B is excluded. Profiling metadata
records scope='sampled', candidateColumns and these policies. These observations
are sample-only, not established database constraints, even after exhaustion.
No additional database queries are needed. View kind/definition metadata never
changes permissions or supplies executable SQL; existing views are SELECTed by
their quoted, allowlisted name under the same read-only guards as tables.

subtree returns aggregate nodes and links, truncated and limit. Root PK accepts
a scalar for a single key, an ordered list/tuple, or an exact-key mapping.
Nodes are qualified by relationship path, including cycles and converging DAG
paths; depth is limited to four. At each depth ALL edges share a row budget.
Links point from parent to child; count is retained child rows and ratio is
count / retained parent rows (0 for an empty parent). Truncated propagates from
incomplete parents, budget overflow, or an unexpanded depth boundary. A row may
appear on different relationship paths and consumes budget on each path.
Only retained rows provide next-hop keys. A single extra row detects overflow,
but is never retained or expanded. Counts/ratios are sample aggregates, not
whole-database estimates. Empty nodes are reported but never expanded.

Queries use SELECT only, with no graph-supplied SQL. SQLite query_only guards and
progress deadlines, PostgreSQL read-only transactions and statement timeouts,
and operation-wide time/query budgets bound work. Timeout/budget errors raise;
no partial success is returned. Sampling is unordered, not statistically random.
"""

from collections import defaultdict
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, time as datetime_time
from decimal import Decimal
import math
from pathlib import Path
import sqlite3
import time


MAX_ROWS = 10_000
MAX_DEPTH = 4
MAX_PARAMETERS = 400
MAX_BATCH_KEYS = 100
MAX_QUERIES = 512
DEADLINE_SECONDS = 5.0
MAX_SCALAR_LENGTH = 256
MAX_FD_COLUMNS = 32


class ProfileLimitError(RuntimeError):
    """The bounded service could not finish within its query/time budget."""


def _quote(identifier):
    if not isinstance(identifier, str) or not identifier or '\x00' in identifier:
        raise ValueError('Identifiers must be nonempty strings without NUL')
    return '"' + identifier.replace('"', '""') + '"'


def _cap(value):
    if type(value) is not int or value < 1:
        raise ValueError('max_rows must be a positive integer')
    return min(value, MAX_ROWS)


def _scalar(value):
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (date, datetime, datetime_time)):
        value = value.isoformat()
    elif isinstance(value, (bytes, bytearray, memoryview)):
        value = 'hex:' + bytes(value[:MAX_SCALAR_LENGTH // 2]).hex()
    else:
        value = str(value)
    return value[:MAX_SCALAR_LENGTH]


def _key(values):
    # Preserve full values for matching/deduplication; output bounding is separate.
    return tuple((type(v).__name__, bytes(v) if isinstance(v, memoryview)
                  else repr(v) if isinstance(v, (dict, list)) else v) for v in values)


class _Graph:
    def __init__(self, graph):
        self.tables = {}
        self.columns = {}
        for table in graph['tables']:
            table_id = table['id']
            _quote(table_id)
            if table_id in self.tables:
                raise ValueError('Duplicate table id')
            self.tables[table_id] = table
            columns = [c['name'] for c in table['allColumns']]
            if not columns or len(set(columns)) != len(columns):
                raise ValueError('Tables must have unique, nonempty columns')
            for column in columns:
                _quote(column)
            self.columns[table_id] = columns
            self.sql_table(table_id)
            self.pk(table_id)
        groups = {}
        for index, link in enumerate(graph.get('links', [])):
            if link.get('kind') != 'declared FK':
                continue
            child, parent = link['source'], link['target']
            self.column(child, link['column'])
            self.column(parent, link['targetColumn'])
            constraint = link.get('constraintId')
            if constraint is not None and not isinstance(constraint, str):
                raise ValueError('constraintId must be a string')
            group = (child, parent, ('constraint', constraint) if constraint
                     else ('link', index))
            groups.setdefault(group, []).append((link['column'], link['targetColumn']))
        self.reverse = defaultdict(list)
        for index, ((child, parent, _), pairs) in enumerate(groups.items()):
            if (len({p[0] for p in pairs}) != len(pairs)
                    or len({p[1] for p in pairs}) != len(pairs)):
                raise ValueError('Ambiguous composite foreign key')
            if len(pairs) >= MAX_PARAMETERS:
                raise ValueError('Foreign key exceeds parameter budget')
            self.reverse[parent].append((index, child, pairs))

    def column(self, table_id, column):
        if table_id not in self.tables or column not in self.columns[table_id]:
            raise ValueError('Table or column is not in the graph allowlist')
        return _quote(column)

    def sql_table(self, table_id):
        if table_id not in self.tables:
            raise ValueError('Table is not in the graph allowlist')
        table = self.tables[table_id]
        name = _quote(table.get('name') or table_id)
        schema = table.get('schema')
        return _quote(schema) + '.' + name if schema else name

    def pk(self, table_id):
        table = self.tables[table_id]
        keys = table.get('primaryKey')
        if keys is None:
            keys = [c['name'] for c in table['allColumns'] if c.get('pk') is True]
        if not isinstance(keys, list) or len(keys) != len(set(keys)):
            raise ValueError('primaryKey must be a list of unique columns')
        for column in keys:
            self.column(table_id, column)
        return keys


class _Connection:
    def __init__(self, raw, dialect):
        self.raw, self.dialect = raw, dialect


@contextmanager
def connect_readonly(dialect, dsn):
    """Open an explicit SQLite file or psycopg DSN; always close on exit."""
    if dialect == 'sqlite':
        if not isinstance(dsn, (str, Path)) or str(dsn) == ':memory:':
            raise ValueError('SQLite requires an explicit existing file path')
        path = Path(dsn).expanduser().resolve(strict=True)
        raw = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True,
                              timeout=DEADLINE_SECONDS)
        try:
            raw.execute('PRAGMA query_only = ON')
            yield _Connection(raw, 'sqlite')
        finally:
            raw.close()
    elif dialect in ('postgres', 'postgresql'):
        # Optional dependency is deliberately imported only on explicit opt-in.
        import psycopg
        from psycopg.conninfo import conninfo_to_dict

        config = dict(dsn) if isinstance(dsn, dict) else conninfo_to_dict(dsn)
        if any(k not in config for k in ('host', 'dbname', 'user', 'password')):
            raise ValueError('PostgreSQL requires explicit host, dbname, user, password')
        if any(not config[k] for k in ('host', 'dbname', 'user', 'password')):
            raise ValueError('PostgreSQL host, dbname, user and password must be nonempty')
        if any(k in config for k in ('service', 'passfile')):
            raise ValueError('Credential discovery is not supported')
        config.update(connect_timeout=5, options='-c default_transaction_read_only=on '
                      '-c statement_timeout=5000', autocommit=True)
        raw = psycopg.connect(**config)
        try:
            raw.read_only = True
            yield _Connection(raw, 'postgresql')
        finally:
            raw.close()
    else:
        raise ValueError('Supported dialects: sqlite, postgresql')


class _Reader:
    def __init__(self, connection):
        if isinstance(connection, sqlite3.Connection):
            connection = _Connection(connection, 'sqlite')
        if not isinstance(connection, _Connection):
            raise TypeError('Use connect_readonly or an explicit sqlite3.Connection')
        self.raw, self.dialect = connection.raw, connection.dialect
        self.marker = '?' if self.dialect == 'sqlite' else '%s'
        self.deadline = time.monotonic() + DEADLINE_SECONDS
        self.queries = 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise ProfileLimitError('Schema service deadline exceeded')

    def identifier(self, quoted):
        # psycopg's parameter parser also processes percent signs inside quotes.
        return quoted.replace('%', '%%') if self.dialect != 'sqlite' else quoted

    def select(self, graph, table_id, limit, where='', params=()):
        self.check()
        if self.queries >= MAX_QUERIES:
            raise ProfileLimitError('Schema service query budget exceeded')
        self.queries += 1
        columns = ', '.join(self.identifier(graph.column(table_id, c))
                            for c in graph.columns[table_id])
        sql = 'SELECT ' + columns + ' FROM ' + self.identifier(graph.sql_table(table_id))
        if where:
            sql += ' WHERE ' + where
        sql += ' LIMIT ' + self.marker
        cursor = self.raw.cursor()
        try:
            if self.dialect == 'sqlite':
                cursor.row_factory = None
            else:
                milliseconds = max(1, int((self.deadline - time.monotonic()) * 1000))
                cursor.execute("SELECT set_config('statement_timeout', %s, true)",
                               (str(milliseconds),))
            cursor.execute(sql, (*params, limit))
            rows = cursor.fetchmany(limit)
            self.check()
            return [dict(zip(graph.columns[table_id], row)) for row in rows]
        finally:
            cursor.close()


@contextmanager
def _reader(connection):
    reader = _Reader(connection)
    if reader.dialect == 'sqlite':
        prior = reader.raw.execute('PRAGMA query_only').fetchone()[0]
        reader.raw.execute('PRAGMA query_only = ON')
        reader.raw.set_progress_handler(lambda: int(time.monotonic() >= reader.deadline), 1000)
        try:
            yield reader
        finally:
            reader.raw.set_progress_handler(None, 0)
            reader.raw.execute('PRAGMA query_only = ' + ('ON' if prior else 'OFF'))
    else:
        with reader.raw.transaction():
            with reader.raw.cursor() as cursor:
                cursor.execute('SET TRANSACTION READ ONLY')
                cursor.execute("SELECT set_config('statement_timeout', %s, true)",
                               (str(int(DEADLINE_SECONDS * 1000)),))
            yield reader


def _stats(values):
    nonnull = [v for v in values if v is not None]
    try:
        minimum, maximum = (min(nonnull), max(nonnull)) if nonnull else (None, None)
    except TypeError:
        minimum = maximum = None  # SQLite mixed storage classes are not comparable.
    return {'nullFraction': (len(values) - len(nonnull)) / len(values) if values else None,
            'distinctCount': len({_key((v,)) for v in nonnull}),
            'min': _scalar(minimum), 'max': _scalar(maximum),
            'sampleSize': len(values), 'scope': 'sampled'}


def _fd_codes(column, rows):
    kind = str(column.get('type', '')).lower()
    if any(token in kind for token in ('binary', 'blob', 'bytea', 'json', 'array', '[]', 'xml')):
        return None
    codes, categories = [], {}
    for row in rows:
        value = row[column['name']]
        if value is not None:
            if not isinstance(value, (str, bool, int, float, Decimal, date, datetime_time)):
                return None
            if isinstance(value, str) and len(value) > MAX_SCALAR_LENGTH:
                return None
            if isinstance(value, float) and not math.isfinite(value):
                return None
            if isinstance(value, Decimal) and not value.is_finite():
                return None
        key = _key((value,))
        codes.append(categories.setdefault(key, len(categories)))
    return codes, len(categories)


def _dependencies(table, rows, reader):
    candidates = {}
    for column in table['allColumns']:
        reader.check()
        encoded = _fd_codes(column, rows)
        if encoded is not None:
            candidates[column['name']] = encoded
            if len(candidates) == MAX_FD_COLUMNS:
                break
    dependencies = []
    for determinant, (codes, distinct) in candidates.items():
        if distinct <= 1 or distinct == len(rows):
            continue
        for dependent, (other, _) in candidates.items():
            reader.check()
            if determinant == dependent:
                continue
            distinct_pair = len(set(zip(codes, other)))
            if distinct == distinct_pair:
                dependencies.append({'determinant': determinant, 'dependent': dependent,
                                     'distinctDeterminant': distinct, 'distinctPair': distinct_pair,
                                     'sampleSize': len(rows)})
    reader.check()
    return {'scope': 'sampled', 'sampled': True, 'sampleSize': len(rows),
            'candidateColumns': list(candidates), 'maxCandidateColumns': MAX_FD_COLUMNS,
            'nullPolicy': 'null-as-value', 'constantDeterminants': 'skipped',
            'uniqueDeterminants': 'skipped', 'functionalDependencies': dependencies}


def _sample_values(values):
    samples = []
    for value in values:
        if value is not None:
            scalar = _scalar(value)
            if scalar not in samples:
                samples.append(scalar)
                if len(samples) == 3:
                    break
    return samples


def profile(graph, connection, tables, max_rows=MAX_ROWS, *, include_sample_values=False):
    """Return a graph copy with bounded per-column sample statistics."""
    if type(include_sample_values) is not bool:
        raise ValueError('include_sample_values must be an explicit boolean')
    limit = _cap(max_rows)
    catalog = _Graph(graph)
    if isinstance(tables, str):
        raise ValueError('tables must be a sequence of table ids')
    selected = set(tables)
    for table_id in selected:
        catalog.sql_table(table_id)
    result = deepcopy(graph)
    for table in result['tables']:
        for column in table['allColumns']:
            column.pop('sampleValues', None)
            for metadata in ('stats', 'profiling'):
                if isinstance(column.get(metadata), dict):
                    column[metadata].pop('sampleValues', None)
    with _reader(connection) as reader:
        for table in result['tables']:
            if table['id'] not in selected:
                continue
            rows = reader.select(catalog, table['id'], limit + 1)
            overflow = len(rows) > limit
            rows = rows[:limit]
            exact = table.get('rowCount')
            known = type(exact) is int and exact >= 0
            table.update(sampleSize=len(rows), sampled=True,
                         rowCountLowerBound=len(rows) + int(overflow),
                         rowCountExact=not overflow or known,
                         rowCount=exact if overflow and known else None if overflow else len(rows))
            for column in table['allColumns']:
                reader.check()
                values = [row[column['name']] for row in rows]
                column.pop('stats', None)
                column['profiling'] = _stats(values)
                if include_sample_values:
                    column['sampleValues'] = _sample_values(values)
            table['profiling'] = _dependencies(table, rows, reader)
    return {'graph': result, 'sampled': True, 'limit': limit}


def _pk_values(keys, value):
    if not keys or len(keys) >= MAX_PARAMETERS:
        raise ValueError('Root requires a primary key within the parameter budget')
    if isinstance(value, dict):
        if set(value) != set(keys):
            raise ValueError('PK mapping must contain exactly the primary key columns')
        values = [value[k] for k in keys]
    elif isinstance(value, (tuple, list)):
        values = list(value)
    elif len(keys) == 1:
        values = [value]
    else:
        raise ValueError('Composite PK requires a mapping or ordered sequence')
    if len(values) != len(keys) or any(v is None or not isinstance(
            v, (str, int, float, bytes, Decimal, date, datetime_time)) for v in values):
        raise ValueError('Invalid primary key values')
    if any(isinstance(v, float) and not math.isfinite(v) for v in values):
        raise ValueError('Primary key values must be finite')
    return values


def _children(reader, catalog, child, pairs, parents, remaining):
    keys, seen = [], set()
    for parent in parents:
        values = tuple(parent[p] for _, p in pairs)
        if any(v is None for v in values):
            continue
        key = _key(values)
        if key not in seen:
            keys.append(values)
            seen.add(key)
    batch_size = min(MAX_BATCH_KEYS, (MAX_PARAMETERS - 1) // len(pairs))
    retained = []
    # Distinct referenced key tuples partition child rows across batches.
    for start in range(0, len(keys), batch_size):
        batch = keys[start:start + batch_size]
        term = '(' + ' AND '.join(reader.identifier(catalog.column(child, c)) + ' = ' + reader.marker
                                  for c, _ in pairs) + ')'
        where = ' OR '.join([term] * len(batch))
        rows = reader.select(catalog, child, remaining - len(retained) + 1,
                             where, [v for key in batch for v in key])
        available = remaining - len(retained)
        retained.extend(rows[:available])
        if len(rows) > available:
            return retained, True
    return retained, False


def subtree(graph, connection, root_table, pk_value, depth, max_rows=MAX_ROWS):
    """Aggregate reverse declared-FK paths with one retained-row cap per depth."""
    limit = _cap(max_rows)
    if type(depth) is not int or not 0 <= depth <= MAX_DEPTH:
        raise ValueError('depth must be an integer from 0 through 4')
    catalog = _Graph(graph)
    catalog.sql_table(root_table)
    keys = catalog.pk(root_table)
    values = _pk_values(keys, pk_value)
    nodes, links = [], []
    with _reader(connection) as reader:
        predicate = ' AND '.join(reader.identifier(catalog.column(root_table, k)) + ' = ' + reader.marker
                                 for k in keys)
        roots = reader.select(catalog, root_table, 2, predicate, values)
        if len(roots) > 1:
            raise ValueError('Graph primary key does not uniquely identify the root')
        root = {'id': 'root', 'tableId': root_table, 'depth': 0,
                'rowCount': len(roots), 'truncated': False}
        nodes.append(root)
        frontier = [(root, roots)]
        for level in range(1, depth + 1):
            remaining = limit
            next_frontier = []
            for parent, parent_rows in frontier:
                if not parent_rows:
                    continue
                for edge_id, child, pairs in catalog.reverse[parent['tableId']]:
                    rows, overflow = _children(reader, catalog, child, pairs, parent_rows, remaining)
                    remaining -= len(rows)
                    truncated = overflow or parent['truncated']
                    node = {'id': parent['id'] + '/' + str(edge_id), 'tableId': child,
                            'depth': level, 'rowCount': len(rows), 'truncated': truncated}
                    nodes.append(node)
                    links.append({'source': parent['id'], 'target': node['id'],
                                  'ratio': len(rows) / len(parent_rows), 'count': len(rows),
                                  'truncated': truncated})
                    next_frontier.append((node, rows))
            frontier = next_frontier
        for node, rows in frontier:
            if rows and catalog.reverse[node['tableId']]:
                node['truncated'] = True
        truncated_ids = {n['id'] for n in nodes if n['truncated']}
        for link in links:
            link['truncated'] |= link['target'] in truncated_ids
    return {'nodes': nodes, 'links': links,
            'truncated': bool(truncated_ids), 'limit': limit}
