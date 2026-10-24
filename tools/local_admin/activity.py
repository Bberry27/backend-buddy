"""Live server activity for the local admin area: statement timing and lock holds.

What this answers is "what is the database doing right now, and what is waiting on what",
which is a different question from everything else here. Introspection describes a schema,
row counts and column statistics measure stored data; all three end up in a snapshot. This
ends up nowhere. It reads three server views, renders one page, and keeps nothing:

  pg_stat_statements   cumulative timing per normalized statement, when the extension is
                       installed. Optional on every managed PostgreSQL, so its absence is
                       reported as a fact about the server rather than as an empty table.
  pg_stat_activity     the sessions connected to this database: state, wait event, age.
  pg_locks             which relations are held, by which session, and whether granted.

What it deliberately does not read:

- **No table data.** Every query here reads a server view. Nothing touches a user table, so
  no row, column value or sample can reach the page.
- **No raw statement text from live sessions.** `pg_stat_activity.query` is the statement as
  typed, literals and all: an email address in a WHERE clause is sitting in that column.
  This module never selects it. The text it does show comes from `pg_stat_statements`, where
  the server itself has already replaced constants with `$1` placeholders, and even that is
  truncated to a cap before it reaches a page.
- **Nothing cumulative is presented as current.** `pg_stat_statements` counts since the last
  reset or server start, which is not "today"; locks are this instant and not a history. The
  page says which is which, because a mean of unknown age is a number people act on.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from tools.local_admin.introspection import _connect

# This runs while someone waits on a page, against a server that may be the one having a bad
# day, so the bounds are tighter than introspection's.
ACTIVITY_STATEMENT_TIMEOUT_MS = 10_000
# Enough of the top of the distribution to recognise the shape, few enough to read at a glance.
TOP_STATEMENTS = 20
MAX_SESSIONS = 50
MAX_LOCKS = 200
# A normalized statement is still a statement: long enough to identify, short enough that a
# page is not a dump.
QUERY_TEXT_CAP = 240

# PostgreSQL 13 renamed the timing columns. Both names are asked for in that order.
_MODERN_TIMING = ('total_exec_time', 'mean_exec_time')
_LEGACY_TIMING = ('total_time', 'mean_time')

_SESSIONS_SQL = """
    SELECT pid, state, wait_event_type, wait_event, backend_type, usename, application_name,
           EXTRACT(EPOCH FROM (now() - query_start))::float8 AS query_seconds,
           EXTRACT(EPOCH FROM (now() - xact_start))::float8 AS xact_seconds,
           EXTRACT(EPOCH FROM (now() - state_change))::float8 AS state_seconds,
           pg_blocking_pids(pid) AS blocked_by
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
     ORDER BY query_seconds DESC NULLS LAST
     LIMIT %s
"""

_LOCKS_SQL = """
    SELECT l.pid, l.mode, l.granted, n.nspname, c.relname
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE l.locktype = 'relation'
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY l.granted, l.pid
     LIMIT %s
"""


def _rows(cursor, sql: str, *parameters: Any) -> list[dict[str, Any]]:
    """Run a statement and return dictionaries, so the shaping below reads as prose."""
    cursor.execute(sql, parameters or None)
    names = [column.name for column in cursor.description or []]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def statements_unavailable(reason: str) -> dict[str, Any]:
    return {'available': False, 'reason': reason, 'rows': [], 'scope': ''}


def read_statements(cursor, *, limit: int = TOP_STATEMENTS,
                    cap: int = QUERY_TEXT_CAP) -> dict[str, Any]:
    """Cumulative timing per statement, or a specific reason there is none.

    The reason matters more than the table. "pg_stat_statements is not installed" is a thing
    an operator can act on in a minute; an empty panel is a thing they file a bug about.
    """
    import psycopg

    cursor.execute("SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'")
    if not (cursor.fetchone() or [0])[0]:
        return statements_unavailable(
            'pg_stat_statements is not installed in this database, so no statement timing is '
            'recorded. An operator enables it by loading the library on the server '
            '(shared_preload_libraries, or the managed equivalent) and running '
            'CREATE EXTENSION pg_stat_statements.')

    for total_column, mean_column in (_MODERN_TIMING, _LEGACY_TIMING):
        try:
            rows = _rows(cursor, f"""
                SELECT queryid, calls, rows,
                       {total_column}::float8 AS total_ms, {mean_column}::float8 AS mean_ms,
                       left(query, {int(cap)}) AS statement,
                       length(query) > {int(cap)} AS truncated
                  FROM pg_stat_statements
                 ORDER BY {total_column} DESC
                 LIMIT %s
            """, limit)
            break
        except psycopg.errors.UndefinedColumn:
            # PostgreSQL 12 and earlier. Roll back the aborted statement and try its names.
            continue
        except psycopg.errors.InsufficientPrivilege:
            return statements_unavailable(
                'This role may not read pg_stat_statements. Granting it membership of '
                'pg_read_all_stats makes the whole server visible; without it a role sees '
                'only its own statements.')
        except psycopg.Error as error:
            return statements_unavailable(
                f'pg_stat_statements could not be read: {" ".join(str(error).split())[:200]}')
    else:
        return statements_unavailable(
            'pg_stat_statements is installed but carries neither total_exec_time nor '
            'total_time, so this server reports timing in a shape this page does not know.')

    cursor.execute("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'member')")
    everyone = bool((cursor.fetchone() or [False])[0])
    return {'available': True, 'reason': '', 'rows': shape_statements(rows),
            'scope': 'all' if everyone else 'own'}


def shape_statements(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per statement, with the per-call figures a person actually compares."""
    shaped = []
    for row in rows:
        calls = int(row.get('calls') or 0)
        total = float(row.get('total_ms') or 0.0)
        returned = int(row.get('rows') or 0)
        shaped.append({
            'queryid': row.get('queryid'),
            'calls': calls,
            'total_ms': round(total, 1),
            'mean_ms': round(float(row.get('mean_ms') or 0.0), 2),
            'rows_per_call': round(returned / calls, 1) if calls else None,
            'share': None,
            'statement': ' '.join(str(row.get('statement') or '').split()),
            'truncated': bool(row.get('truncated')),
        })
    grand = sum(entry['total_ms'] for entry in shaped)
    for entry in shaped:
        # A share of the top N is not a share of the server's whole workload, and the page
        # says so; it is here because "which of these dominates" is the first question.
        entry['share'] = round(entry['total_ms'] / grand, 4) if grand else None
    return shaped


def shape_sessions(sessions: list[dict[str, Any]],
                   locks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sessions with the relations they hold, longest first, with the waits resolved.

    `pg_blocking_pids` answers which sessions stand in front of this one; the relations come
    from pg_locks. Together they are the hold: who waits, on what, behind whom.
    """
    held: dict[int, list[str]] = {}
    waiting_for: dict[int, list[str]] = {}
    for lock in locks:
        pid = lock.get('pid')
        if pid is None:
            continue
        name = f'{lock.get("nspname")}.{lock.get("relname")}'
        entry = f'{name} ({lock.get("mode")})'
        (held if lock.get('granted') else waiting_for).setdefault(int(pid), [])
        (held if lock.get('granted') else waiting_for)[int(pid)].append(entry)

    shaped = []
    for session in sessions:
        pid = int(session.get('pid') or 0)
        blocked_by = [int(other) for other in (session.get('blocked_by') or [])]
        shaped.append({
            'pid': pid,
            'state': session.get('state') or 'unknown',
            'wait': ' / '.join(part for part in (session.get('wait_event_type'),
                                                 session.get('wait_event')) if part),
            'backend_type': session.get('backend_type') or '',
            'user': session.get('usename') or '',
            'application': session.get('application_name') or '',
            'query_seconds': _seconds(session.get('query_seconds')),
            'xact_seconds': _seconds(session.get('xact_seconds')),
            'state_seconds': _seconds(session.get('state_seconds')),
            'blocked_by': blocked_by,
            'holds': sorted(set(held.get(pid, [])))[:6],
            'waiting_for': sorted(set(waiting_for.get(pid, [])))[:6],
        })
    return shaped


def _seconds(value: Any) -> float | None:
    """Ages are reported only when the server reported one. An idle session has no query age."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 1) if number >= 0 else None


def summarize(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    """The three numbers worth seeing before any table: busy, blocked, and held open.

    Idle in transaction is its own count because it is the hold people forget: the session
    is doing nothing at all and still holding everything it has touched.
    """
    active = [s for s in sessions if s['state'] == 'active']
    blocked = [s for s in sessions if s['blocked_by']]
    idle_in_transaction = [s for s in sessions if s['state'].startswith('idle in transaction')]
    longest = max((s['query_seconds'] or 0 for s in active), default=0.0)
    longest_idle = max((s['xact_seconds'] or 0 for s in idle_in_transaction), default=0.0)
    return {
        'sessions': len(sessions),
        'active': len(active),
        'blocked': len(blocked),
        'idle_in_transaction': len(idle_in_transaction),
        'longest_active_seconds': round(longest, 1),
        'longest_idle_transaction_seconds': round(longest_idle, 1),
    }


def read_activity(dsn: str, ca_cert_pem: str, *, limit: int = TOP_STATEMENTS,
                  sessions_limit: int = MAX_SESSIONS) -> dict[str, Any]:
    """Read the server's current activity. Returns a report; writes nothing anywhere."""
    import psycopg
    from psycopg import sql

    connection = _connect(dsn, ca_cert_pem)
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL('SET statement_timeout = {}').format(
                sql.Literal(int(ACTIVITY_STATEMENT_TIMEOUT_MS))))
            cursor.execute('SELECT current_database(), version()')
            database, version = cursor.fetchone()
            sessions = _rows(cursor, _SESSIONS_SQL, sessions_limit)
            try:
                locks = _rows(cursor, _LOCKS_SQL, MAX_LOCKS)
            except psycopg.Error:
                # A role without the privilege to read pg_locks still gets the session view,
                # which is most of the answer; the relations simply stay unnamed.
                locks = []
            shaped = shape_sessions(sessions, locks)
            statements = read_statements(cursor, limit=limit)
    finally:
        connection.close()

    return {
        'database': database,
        'server_version': version.split(' on ')[0] if version else 'unknown',
        'read_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'sessions': shaped,
        'summary': summarize(shaped),
        'statements': statements,
    }
