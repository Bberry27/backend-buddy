#!/usr/bin/env python
"""Read a PostgreSQL catalog and write a contract-valid SchemaGraph JSON.

INTERIM TOOL. Work package A03 productises this as `introspect()` on the PostgreSQL
driver, reachable from the Connections page. Until that lands there is nowhere in the
product to enter credentials, and this script is the bridge: it turns a real database
into a snapshot the existing renderer and all thirteen views can display.

It reads catalog metadata only. It issues no query against a user table, so no row,
value, minimum, or maximum is read. Row counts are deliberately absent: the catalog's
`reltuples` is a planner estimate, and the contract requires an unmeasured count to stay
unknown rather than be filled with something that looks measured. Use
`packages/explorer/server/profile_snapshot.py` afterwards to add measured statistics.

Credentials come from an environment variable, never from the command line, so they do
not reach the process list or the shell history.

    export BB_PG_DSN="host=myserver.postgres.database.azure.com port=5432 \\
        dbname=mydb user=readonly_user password=... sslmode=verify-full"
    python scripts/introspect_pg.py --dsn-env BB_PG_DSN --output my-schema.json
    npm run up -- --schema my-schema.json

Requires psycopg 3: python -m pip install "psycopg[binary]>=3.2,<4"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# The catalog queries. Each is read-only, parameterised on the schema list, and ordered
# so the output is deterministic for the same database.

TABLES_SQL = """
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relkind AS kind,
       obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND n.nspname = ANY(%s)
 ORDER BY n.nspname, c.relname
"""

COLUMNS_SQL = """
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attname AS column_name,
       a.attnum AS position,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS column_default,
       a.attidentity <> '' OR a.attgenerated <> '' AS is_generated
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attnum > 0
   AND NOT a.attisdropped
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND n.nspname = ANY(%s)
 ORDER BY n.nspname, c.relname, a.attnum
"""

# Constraints: primary keys, uniques, checks, and foreign keys with their ordered column
# pairs. conkey and confkey are attribute-number arrays, so the ordinal position within
# them is what preserves a composite key's declared order.
CONSTRAINTS_SQL = """
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       con.conname AS constraint_name,
       con.contype AS constraint_type,
       pg_get_constraintdef(con.oid) AS definition,
       con.conkey AS local_attnums,
       fn.nspname AS foreign_schema,
       fc.relname AS foreign_table,
       con.confkey AS foreign_attnums,
       con.confdeltype AS on_delete
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
 WHERE con.contype IN ('p', 'u', 'c', 'f')
   AND n.nspname = ANY(%s)
 ORDER BY n.nspname, c.relname, con.conname
"""

INDEXES_SQL = """
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       ic.relname AS index_name,
       i.indisunique AS is_unique,
       i.indpred IS NOT NULL AS is_partial,
       i.indexprs IS NOT NULL AS has_expression,
       i.indkey AS key_attnums
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY(%s)
 ORDER BY n.nspname, c.relname, ic.relname
"""

ON_DELETE = {'a': 'NO ACTION', 'r': 'RESTRICT', 'c': 'CASCADE', 'n': 'SET NULL', 'd': 'SET DEFAULT'}

# Districts in Schema City, colours on the relational map, and the Domains view all group
# by `table.domain`. A single-schema database would put every table in one district,
# which removes the point of those views. Group by the table name's leading token instead,
# marked inferred in source.basis, which skill/references/extraction.md permits:
# "Prefix heuristics are acceptable when marked inferred."
MIN_PREFIX_GROUP = 3        # below this a prefix is noise rather than a domain
MAX_PREFIX_DOMAINS = 14     # beyond this the palette and the legend stop being readable


def _prefix(name: str, depth: int) -> str:
    parts = name.split('_')
    return '_'.join(parts[:depth]) if len(parts) > depth else parts[0]


def infer_domains(names: list[str]) -> dict[str, str]:
    """Map each table name to an inferred domain taken from its leading token.

    Two-token prefixes are preferred where they are shared widely enough, so
    tracking_email_* groups separately from tracking_request_*. A name whose prefix is
    too rare to be a group, or which has no separator, lands in 'Other'. Deterministic.
    """
    counts: dict[str, dict[str, int]] = {1: {}, 2: {}}
    for name in names:
        for depth in (1, 2):
            key = _prefix(name, depth)
            counts[depth][key] = counts[depth].get(key, 0) + 1

    groups = {key for depth in (2, 1) for key, n in counts[depth].items() if n >= MIN_PREFIX_GROUP}
    ranked = sorted(groups, key=lambda key: (-max(counts[1].get(key, 0), counts[2].get(key, 0)), key))
    allowed = set(ranked[:MAX_PREFIX_DOMAINS])

    mapping: dict[str, str] = {}
    for name in names:
        two, one = _prefix(name, 2), _prefix(name, 1)
        chosen = two if two in allowed else (one if one in allowed else '')
        mapping[name] = chosen.replace('_', ' ') if chosen else 'Other'

    # A district holding one or two tables is a colour in the legend that explains
    # nothing, so fold it into Other rather than spending a hue on it.
    sizes: dict[str, int] = {}
    for domain in mapping.values():
        sizes[domain] = sizes.get(domain, 0) + 1
    return {
        name: ('Other' if domain != 'Other' and sizes[domain] < MIN_PREFIX_GROUP else domain)
        for name, domain in mapping.items()
    }



def project_key(dbname: str) -> str:
    """A stable lowercase key the renderer accepts, derived from the database name.

    The key namespaces this project's browser storage, so it must be stable for one
    database and different from another's.
    """
    key = re.sub(r'[^a-z0-9_-]+', '-', dbname.lower()).strip('-')
    return key or 'postgresql'


def connect(dsn: str):
    """Open a read-only session. Mirrors the guarantees in schema_profiler.connect_readonly."""
    try:
        import psycopg
        from psycopg import conninfo
    except ModuleNotFoundError:
        sys.exit('psycopg 3 is required: python -m pip install "psycopg[binary]>=3.2,<4"')

    config = conninfo.conninfo_to_dict(dsn)
    missing = [k for k in ('host', 'dbname', 'user') if not config.get(k)]
    if missing:
        sys.exit(f'The connection string is missing: {", ".join(missing)}')
    if any(k in config for k in ('service', 'passfile')):
        sys.exit('service and passfile are not supported: pass an explicit connection string')
    if not config.get('sslmode'):
        # libpq's default is `prefer`, which accepts an unencrypted session silently.
        config['sslmode'] = 'verify-full'
        print('sslmode was not set; using verify-full', file=sys.stderr)

    # libpq looks for ~/.postgresql/root.crt, which does not exist for an account without
    # a home directory, so a verifying mode fails even where the authority is trusted.
    if config['sslmode'] in ('verify-full', 'verify-ca') and not config.get('sslrootcert'):
        for bundle in ('/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt',
                       '/etc/ssl/ca-bundle.pem', '/etc/ssl/cert.pem'):
            if Path(bundle).is_file():
                config['sslrootcert'] = bundle
                break

    config.update(connect_timeout=10, options='-c default_transaction_read_only=on -c statement_timeout=30000')
    try:
        connection = psycopg.connect(**config, autocommit=True)
    except Exception as error:  # noqa: BLE001 - the message is shaped for a human, not re-raised
        sys.exit(diagnose(error, config))
    connection.read_only = True
    return connection


def diagnose(error: Exception, config: dict[str, Any]) -> str:
    """Turn a connection failure into something actionable, without echoing the password."""
    text = str(error)
    host = config.get('host', '')
    user = config.get('user', '')
    lines = [f'Could not connect to {host}: {text.strip().splitlines()[0] if text.strip() else type(error).__name__}']

    lowered = text.lower()
    if 'resolve host' in lowered or 'name or service not known' in lowered \
            or 'nodename nor servname' in lowered or 'name does not resolve' in lowered:
        # A name that does not resolve is almost always a typo, and the raw errno says
        # nothing useful. Nothing was contacted, so this is not a firewall or a password.
        lines.append('That hostname does not resolve, so nothing was contacted: this is not '
                     'a firewall rule or a wrong password. Check the spelling.')
        if host.endswith('.postgres.database.azure.com'):
            server = host[:-len('.postgres.database.azure.com')]
            lines.append(f'The server name read as {server!r}. Copy it from the Azure portal '
                         'overview page, where it appears as the full server name; a missing '
                         'prefix or a dropped character is the usual cause.')
        elif '.' not in host:
            lines.append('It has no domain part, which a managed database always has.')
    elif 'root certificate file' in lowered:
        lines.append('Full verification needs a certificate authority and libpq found none. '
                     'It looks in ~/.postgresql/root.crt by default, which does not exist for '
                     'an account without a home directory. Install the system CA bundle, paste '
                     'the authority into the connection, or use require to encrypt without '
                     'verifying identity.')
    elif 'certificate' in lowered or 'ssl' in lowered:
        lines.append('This looks like certificate verification. Supply the authority with '
                     'sslrootcert=<path>, or use sslmode=require to encrypt without verifying identity.')
    elif 'timeout' in lowered or 'timed out' in lowered:
        if host.endswith('.postgres.database.azure.com'):
            lines.append("A timeout against Azure usually means no firewall rule permits this machine's "
                         'public address. Add one in the server\'s Networking settings.')
        else:
            lines.append('A timeout means the host was unreachable rather than the credential rejected. '
                         'Check the address, the port, and any firewall between here and it.')
        if os.environ.get('BB_IN_CONTAINER') and host in ('localhost', '127.0.0.1', '::1'):
            lines.append('Running inside a container, localhost is the container itself. '
                         'Use host.docker.internal to reach a database on your own machine.')
    elif 'password' in lowered or 'authentication' in lowered:
        lines.append('The host was reached and the credential was rejected.')
        if host.endswith('.postgres.database.azure.com') and '@' not in user:
            lines.append('On the legacy Azure Single Server the username is user@servername. '
                         'Flexible Server uses a plain username.')
    elif 'does not exist' in lowered:
        lines.append('The host was reached; the database or role named does not exist.')
    return '\n'.join(lines)


def introspect(connection, schemas: list[str]) -> dict[str, Any]:
    """Build a SchemaGraph from the catalog. Reads metadata only."""
    with connection.cursor() as cursor:
        cursor.execute(TABLES_SQL, (schemas,))
        raw_tables = cursor.fetchall()
        cursor.execute(COLUMNS_SQL, (schemas,))
        raw_columns = cursor.fetchall()
        cursor.execute(CONSTRAINTS_SQL, (schemas,))
        raw_constraints = cursor.fetchall()
        cursor.execute(INDEXES_SQL, (schemas,))
        raw_indexes = cursor.fetchall()

    # One schema means a qualified id is pure noise on every label, and the id only has
    # to be unique. SQL generation uses the separate schema and name fields, never the id,
    # so dropping the prefix here is safe and matches how a single-schema database reads.
    single_schema = len({row[0] for row in raw_tables}) == 1

    def table_id(schema: str, name: str) -> str:
        return name if single_schema else f'{schema}.{name}'

    # Inferred districts, so Schema City and Domains have something to group by.
    domain_of = infer_domains([row[1] for row in raw_tables])

    # attnum -> column name, per table, so constraint arrays can be resolved to names.
    attnames: dict[str, dict[int, str]] = {}
    tables: dict[str, dict[str, Any]] = {}

    for schema, name, kind, comment, view_definition in raw_tables:
        identifier = table_id(schema, name)
        entry: dict[str, Any] = {
            'id': identifier,
            'schema': schema,
            'name': name,
            'className': name,
            'domain': domain_of.get(name, 'Other'),
            'type': 'Unclassified',
            'allColumns': [],
            'indexes': [],
            'uniques': [],
            'checks': [],
        }
        if kind in ('v', 'm'):
            entry['kind'] = 'view'
            if view_definition:
                entry['definition'] = view_definition.strip()
        if comment:
            entry['comment'] = comment
        tables[identifier] = entry
        attnames[identifier] = {}

    for schema, name, column, position, data_type, is_nullable, default, generated in raw_columns:
        identifier = table_id(schema, name)
        if identifier not in tables:
            continue
        attnames[identifier][position] = column
        entry: dict[str, Any] = {
            'name': column,
            'type': data_type,
            'nullable': bool(is_nullable),
            'typeBasis': 'PostgreSQL catalog',
        }
        if default is not None:
            entry['serverDefault'] = default
        if generated:
            entry['generated'] = True
        tables[identifier]['allColumns'].append(entry)

    links: list[dict[str, Any]] = []
    for row in raw_constraints:
        (schema, name, constraint, ctype, definition, local_attnums,
         foreign_schema, foreign_table, foreign_attnums, on_delete) = row
        identifier = table_id(schema, name)
        table = tables.get(identifier)
        if table is None:
            continue
        names = attnames[identifier]
        local = [names[n] for n in (local_attnums or []) if n in names]

        if ctype == 'p':
            table['primaryKey'] = local
        elif ctype == 'u':
            table['uniques'].append({'name': constraint, 'columns': local})
        elif ctype == 'c':
            table['checks'].append({'name': constraint, 'definition': definition})
        elif ctype == 'f' and foreign_table:
            target = table_id(foreign_schema, foreign_table)
            target_names = attnames.get(target, {})
            remote = [target_names[n] for n in (foreign_attnums or []) if n in target_names]
            action = ON_DELETE.get(on_delete or 'a', 'NO ACTION')
            # One link per ordered column pair, all sharing the constraint id, so a
            # composite foreign key keeps its pair-level evidence and counts once.
            for local_column, remote_column in zip(local, remote):
                links.append({
                    'source': identifier,
                    'column': local_column,
                    'target': target,
                    'targetColumn': remote_column,
                    'kind': 'declared FK',
                    'constraintId': constraint,
                    'name': constraint,
                    'ondelete': action,
                })

    for schema, name, index_name, is_unique, is_partial, has_expression, key_attnums in raw_indexes:
        identifier = table_id(schema, name)
        table = tables.get(identifier)
        if table is None:
            continue
        names = attnames[identifier]
        # indkey is a space-separated int2vector; 0 marks an expression, which has no name.
        parts = [int(p) for p in str(key_attnums).split()] if key_attnums is not None else []
        columns = [names[p] for p in parts if p in names]
        entry: dict[str, Any] = {'name': index_name, 'columns': columns, 'unique': bool(is_unique)}
        if is_partial:
            entry['partial'] = True
        if has_expression or 0 in parts:
            entry['expression'] = True
        table['indexes'].append(entry)

    # Drop links whose target fell outside the selected schemas: the contract requires a
    # declared target to resolve, and a dangling one would fail validation.
    resolvable = [l for l in links if l['target'] in tables]
    dropped = len(links) - len(resolvable)

    # Mark per-column foreign-key membership the way the contract expects.
    for link in resolvable:
        for column in tables[link['source']]['allColumns']:
            if column['name'] == link['column']:
                column['fk'] = f"{link['target']}.{link['targetColumn']}"

    for table in tables.values():
        primary = set(table.get('primaryKey') or [])
        for column in table['allColumns']:
            column['pk'] = column['name'] in primary

    return {'tables': list(tables.values()), 'links': resolvable, 'droppedLinks': dropped}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dsn-env', required=True,
                        help='NAME of the environment variable holding the connection string')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--schemas', nargs='*', default=['public'],
                        help='Schemas to read (default: public)')
    parser.add_argument('--name', help='Project display name (default: the database name)')
    args = parser.parse_args()

    dsn = os.environ.get(args.dsn_env)
    if not dsn:
        sys.exit(f'{args.dsn_env} is not set or is empty. Export the connection string into it first.')

    connection = connect(dsn)
    try:
        from psycopg import conninfo
        config = conninfo.conninfo_to_dict(dsn)
        with connection.cursor() as cursor:
            cursor.execute('SELECT current_database(), version()')
            dbname, version = cursor.fetchone()
        graph = introspect(connection, list(args.schemas))
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
        'Domains are INFERRED from table-name prefixes, not declared by the database. '
        'They group the views and are not an ownership model.',
        f'Schemas read: {", ".join(args.schemas)}.',
    ]
    if dropped:
        basis.append(f'{dropped} foreign-key column pairs referenced a table outside the '
                     'selected schemas and were omitted; widen --schemas to include them.')

    snapshot = {
        'contractVersion': '1.0',
        'project': {
            'name': args.name or dbname,
            'key': project_key(dbname),
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

    # Validate through the renderer's normalizer, which is the contract's oracle, so a
    # snapshot that would fail at render time fails here with a specific message instead.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'skill/scripts'))
    try:
        from build_explorer import normalize
        normalize(snapshot)
    except ImportError:
        print('skill/scripts/build_explorer.py not importable; wrote without validating', file=sys.stderr)
    except ValueError as error:
        sys.exit(f'The introspected schema does not satisfy the contract: {error}')

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, indent=1), encoding='utf-8')

    print(json.dumps({
        'output': str(args.output),
        'database': dbname,
        'tables': len(graph['tables']),
        'views': views,
        'columns': columns,
        'foreignKeyColumnPairs': len(graph['links']),
        'droppedLinks': dropped,
    }, indent=1))
    print(f'\nRender it:  npm run up -- --schema {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
