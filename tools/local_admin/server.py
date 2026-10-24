"""Local admin area: add a database connection in a browser and see your own schema.

    python -m tools.local_admin.server --port 8765
    open http://127.0.0.1:8765/

INTERIM. Work package A03 delivers the same experience inside the API, backed by the
metadata database, with sessions and an audit trail. This exists because the product
owner needed somewhere in the interface to enter credentials before that landed, and an
environment variable is not a product. It is deliberately small: standard library plus
psycopg and cryptography, no framework, no build step.

What it does:
  GET  /                              the workspace: menu bar over the current schema
  GET  /connections                   the connections page, from File or Connection
  GET  /connections/new               the credentials form
  POST /connections                   save, then test
  GET  /connections/{id}/edit         the same form, prefilled, secrets left blank
  POST /connections/{id}/edit         save the changes, then test
  POST /connections/{id}/test         verify and record the outcome
  POST /connections/{id}/introspect   read the catalog, write a snapshot, render the views
  GET  /connections/{id}/measure      state what counting rows will do, before it runs
  POST /connections/{id}/measure      count rows, merge the counts, re-render the views
  GET  /connections/{id}/activity     state what reading server activity does, before it runs
  POST /connections/{id}/activity     read statement timing and lock holds, storing nothing
  GET  /connections/{id}/statistics   state what column statistics will read, before it runs
  POST /connections/{id}/statistics   gather column statistics, merge them, re-render
  POST /connections/{id}/activate     show this connection in the workspace
  POST /connections/{id}/delete       remove it
  GET  /view                          the rendered explorer for the current snapshot
  GET  /view/{id}                     the rendered explorer for one connection

Security posture, matching serve_explorer.py:
  - binds the loopback interface only, and the Host header must match an allowlist
  - a POST must carry the hidden token from the page the server rendered, and a
    present Origin header must name this server
  - no secret is ever rendered, logged, or returned
  - requests are not logged at all, because a URL here can name a database
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.local_admin import activity                     # noqa: E402
from tools.local_admin import pages                       # noqa: E402
from tools.local_admin import introspection                 # noqa: E402
from tools.local_admin.introspection import introspect_to_snapshot  # noqa: E402
from tools.build_id import build_id                        # noqa: E402
from tools.local_admin.store import ConnectionStore        # noqa: E402

MAX_BODY = 256 * 1024          # a certificate is the largest legitimate field
# BB_STATE_DIR is set in the container, where /app is read-only and /state is the only
# writable path. Outside a container it defaults beside the repository. Snapshots are
# written into the state directory for the same reason: introspection must not depend on
# the source tree being writable.
STATE_DIR = Path(os.environ.get('BB_STATE_DIR') or (ROOT / '.backend-buddy'))
SNAPSHOT_DIR = STATE_DIR / 'snapshots'
ARTIFACT = STATE_DIR / 'view.html'
# One rendered page per connection, so switching between them is a toggle rather than a
# re-render, and a snapshot populated months ago is still one click away.
VIEWS = STATE_DIR / 'views'
# Which connection the workspace is showing. A file rather than session state: closing the
# browser is not a decision to forget which database you were looking at.
ACTIVE = STATE_DIR / 'active.json'
# What the rendered artifact currently holds. Without this the interface cannot say
# whose schema is on screen, and a stale render is indistinguishable from a fresh one.
CURRENT = STATE_DIR / 'current.json'


def build_artifact(snapshot: Path, output: Path = ARTIFACT) -> None:
    """Render the explorer from a snapshot using the project's own renderer."""
    output.parent.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(
        [sys.executable, str(ROOT / 'skill/scripts/build_explorer.py'),
         '--schema', str(snapshot), '--output', str(output)],
        capture_output=True, text=True, timeout=600,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip().splitlines()[-1] if done.stderr.strip()
                           else 'the renderer failed')

    # Stamp what drew it, so a later start can tell a stale page from a current one and
    # re-render rather than serving an interface older than the image.
    try:
        output.with_suffix('.build').write_text(build_id(ROOT), encoding='utf-8')
    except OSError:
        # A page that renders but cannot record its build id is still a good page; the next
        # start simply re-renders it once more.
        pass


def view_path(connection_id: str) -> Path:
    return VIEWS / f'{connection_id}.html'


def rendered_view(connection_id: str) -> Path | None:
    """This connection's explorer page, rendered if it is missing or out of date.

    A page goes stale two ways: the snapshot behind it changed, or the views that drew it
    did. Both are checked here rather than at start-up, because the workspace can be asked
    for any connection at any time and a page older than the interface around it reads as a
    feature that quietly stopped working.
    """
    snapshot = SNAPSHOT_DIR / f'{connection_id}.json'
    if not snapshot.is_file():
        return None
    page = view_path(connection_id)
    stamp = page.with_suffix('.build')
    current = build_id(ROOT)
    try:
        drawn_with = stamp.read_text(encoding='utf-8')
    except OSError:
        drawn_with = ''
    if (page.is_file() and page.stat().st_size > 0
            and page.stat().st_mtime >= snapshot.stat().st_mtime
            and drawn_with == current):
        return page
    build_artifact(snapshot, page)
    return page if page.is_file() and page.stat().st_size else None


def make_handler(store: ConnectionStore, allowed_hosts: set[str], session: dict[str, str]):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'backend-buddy-admin'
        sys_version = ''

        # A URL here can name a database, so nothing is logged.
        def log_message(self, *args: object) -> None:
            return

        # -- helpers ----------------------------------------------------------

        def send_page(self, html: str, code: int = 200) -> None:
            body = html.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Length', str(len(body)))
            if not self.headers.get('Cookie', '').find('bb_admin=') >= 0:
                self.send_header('Set-Cookie',
                                 f'bb_admin={session["token"]}; HttpOnly; SameSite=Strict; Path=/')
            self.end_headers()
            self.wfile.write(body)

        def redirect(self, location: str, message: str = '', kind: str = '') -> None:
            if message:
                session['flash'] = message
                session['flash_kind'] = kind
            self.send_response(303)
            self.send_header('Location', location)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def take_flash(self) -> tuple[str, str]:
            return session.pop('flash', ''), session.pop('flash_kind', '')

        def host_allowed(self) -> bool:
            return (self.headers.get('Host') or '') in allowed_hosts

        def origin_ok(self) -> bool:
            """True when the Origin header, if present, names this server.

            Absence is not treated as failure: an embedded or proxied browser context may
            omit it, and the token in the form body is the check that actually gates the
            request. A present but foreign Origin is refused outright.
            """
            origin = self.headers.get('Origin')
            if not origin or origin == 'null':
                return True
            return any(origin == f'http://{h}' for h in allowed_hosts)

        @staticmethod
        def token_ok(fields: dict[str, str]) -> bool:
            """The hidden token must match the one this server put in the page."""
            return hmac.compare_digest(fields.get('_csrf', ''), session['token'])

        def read_form(self) -> dict[str, str]:
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > MAX_BODY:
                raise ValueError('the submitted form was empty or too large')
            raw = self.rfile.read(length).decode('utf-8')
            parsed = urllib.parse.parse_qs(raw, keep_blank_values=True)
            return {k: v[0] for k, v in parsed.items()}

        def artifact_ready(self) -> bool:
            return ARTIFACT.exists() and ARTIFACT.stat().st_size > 0

        def active_connection(self) -> dict[str, object] | None:
            """The connection the workspace is showing, or None when none is saved.

            A recorded choice wins while that connection still exists. Otherwise the most
            recently populated one, so a populate lands on its own schema without anyone
            having to pick it out of a menu first.
            """
            records = store.list()
            if not records:
                return None
            known = {str(record['id']): record for record in records}
            try:
                chosen = json.loads(ACTIVE.read_text(encoding='utf-8')).get('connection_id')
            except (OSError, ValueError, AttributeError):
                chosen = None
            if chosen in known:
                return known[chosen]
            populated = [record for record in records if record['last_snapshot']]
            return max(populated, key=lambda record: str(record['last_snapshot'])) if populated \
                else records[0]

        @staticmethod
        def set_active(connection_id: str) -> None:
            try:
                STATE_DIR.mkdir(parents=True, exist_ok=True)
                ACTIVE.write_text(json.dumps({'connection_id': connection_id}), encoding='utf-8')
            except OSError:
                # Losing the marker costs the workspace its memory of which schema was open,
                # which the fallback above already answers. It is not worth failing an action.
                pass

        def publish(self, connection_id: str, snapshot: Path) -> None:
            """Render this connection's page, and leave a copy at the single-page path.

            The copy is what `/view`, the container's start-up re-render and anything else
            holding the old single-page assumption keep reading. Rendering is the expensive
            part, so it happens once and the copy follows.
            """
            page = view_path(connection_id)
            build_artifact(snapshot, page)
            try:
                shutil.copyfile(page, ARTIFACT)
                shutil.copyfile(page.with_suffix('.build'), ARTIFACT.with_suffix('.build'))
            except OSError:
                pass

        def send_artifact(self, page: Path) -> None:
            body = page.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            # Populating replaces this file in place at the same URL, so any cached copy
            # shows a previous database. no-store alone is respected unevenly on a
            # back-navigation, hence the older directives alongside it.
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        @staticmethod
        def view_for(connection_id: str) -> tuple[Path | None, str]:
            """This connection's rendered page, or the reason there is not one.

            Returns the reason rather than redirecting, because the workspace itself asks
            this question: a redirect to the workspace on a failure in the workspace is a
            loop, and the reason belongs on the page the user is already looking at.
            """
            try:
                page = rendered_view(connection_id)
            except Exception as error:  # noqa: BLE001 - message is shaped for a person
                return None, f'The schema could not be rendered.\n\n{error}'
            if page is None:
                return None, 'No structure has been populated for this connection yet.'
            return page, ''

        @staticmethod
        def current() -> dict[str, object] | None:
            """What the explorer currently holds, or None when nothing is rendered.

            Falls back to the newest snapshot on disk, so state populated before this
            marker existed still names itself rather than showing an unlabelled link.
            """
            try:
                return json.loads(CURRENT.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                pass
            try:
                newest = max(SNAPSHOT_DIR.glob('*.json'), key=lambda f: f.stat().st_mtime)
                graph = json.loads(newest.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return None
            return {
                'connection': graph.get('project', {}).get('name', 'unknown'),
                'tables': len(graph.get('tables', [])),
                'columns': sum(len(t.get('allColumns', [])) for t in graph.get('tables', [])),
                'populated_at': graph.get('source', {}).get('generated', 'unknown'),
            }

        # -- routes -----------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 - the base class defines the name
            if not self.host_allowed():
                self.send_page('<h1>404</h1>', 404)
                return
            path = urllib.parse.urlsplit(self.path).path
            message, kind = self.take_flash()

            if path == '/':
                # The workspace is the schema, with the connection machinery in the menu bar
                # above it. Nothing here opens a database: the page shows what was already
                # populated, and every action that reaches one is a menu item.
                active = self.active_connection()
                page, reason = self.view_for(str(active['id'])) if active else (None, '')
                frame = (f'/view/{active["id"]}' if page
                         else '/view' if not active and self.artifact_ready() else '')
                self.send_page(pages.workspace(
                    store.list(), active=active, token=session['token'],
                    message=message or (reason if active and not page else ''),
                    kind=kind or ('error' if active and not page and reason else ''),
                    view=frame, current=self.current()))
            elif path == '/connections':
                self.send_page(pages.index(store.list(), token=session['token'],
                                           message=message, kind=kind,
                                           artifact_ready=self.artifact_ready(),
                                           current=self.current()))
            elif path == '/connections/new':
                self.send_page(pages.form(token=session['token'], message=message, kind=kind,
                                          artifact_ready=self.artifact_ready(),
                                          current=self.current()))
            elif path.startswith('/connections/') and path.endswith('/edit'):
                entry = store.get(path.split('/')[2])
                if entry is None:
                    self.redirect('/', 'That connection no longer exists.', 'error')
                    return
                self.send_page(pages.form(token=session['token'], message=message, kind=kind,
                                          connection=entry.public(),
                                          artifact_ready=self.artifact_ready(),
                                          current=self.current()))
            elif path.startswith('/connections/') and path.endswith('/measure'):
                entry = store.get(path.split('/')[2])
                if entry is None:
                    self.redirect('/', 'That connection no longer exists.', 'error')
                    return
                self.send_page(pages.measure_consent(
                    entry.public(), token=session['token'], message=message, kind=kind,
                    statement_timeout_ms=introspection.COUNT_STATEMENT_TIMEOUT_MS,
                    deadline_seconds=introspection.COUNT_DEADLINE_SECONDS,
                    artifact_ready=self.artifact_ready(), current=self.current()))
            elif path.startswith('/connections/') and path.endswith('/activity'):
                entry = store.get(path.split('/')[2])
                if entry is None:
                    self.redirect('/', 'That connection no longer exists.', 'error')
                    return
                self.send_page(pages.activity_consent(
                    entry.public(), token=session['token'], message=message, kind=kind,
                    statement_timeout_ms=activity.ACTIVITY_STATEMENT_TIMEOUT_MS,
                    top_statements=activity.TOP_STATEMENTS, max_sessions=activity.MAX_SESSIONS,
                    text_cap=activity.QUERY_TEXT_CAP,
                    artifact_ready=self.artifact_ready(), current=self.current()))
            elif path.startswith('/connections/') and path.endswith('/statistics'):
                entry = store.get(path.split('/')[2])
                if entry is None:
                    self.redirect('/', 'That connection no longer exists.', 'error')
                    return
                self.send_page(pages.statistics_consent(
                    entry.public(), token=session['token'], message=message, kind=kind,
                    statement_timeout_ms=introspection.STATS_STATEMENT_TIMEOUT_MS,
                    deadline_seconds=introspection.STATS_DEADLINE_SECONDS,
                    scalar_cap=introspection.STATS_SCALAR_CAP,
                    artifact_ready=self.artifact_ready(), current=self.current()))
            elif path.startswith('/view/'):
                identifier = path.split('/')[2]
                if store.get(identifier) is None:
                    self.redirect('/', 'That connection no longer exists.', 'error')
                    return
                page, reason = self.view_for(identifier)
                if page is None:
                    self.redirect('/', reason, 'error')
                    return
                self.send_artifact(page)
            elif path == '/view':
                active = self.active_connection()
                page = self.view_for(str(active['id']))[0] if active else None
                # Falling back to the single-page copy keeps a mounted snapshot and the
                # bundled sample reachable, which is all that path holds without a connection.
                if page is None and self.artifact_ready():
                    page = ARTIFACT
                if page is None:
                    self.redirect('/', 'No schema has been populated yet.', 'error')
                    return
                self.send_artifact(page)
            else:
                self.send_page('<h1>404</h1>', 404)

        def do_POST(self) -> None:  # noqa: N802
            if not self.host_allowed():
                self.send_page('<h1>404</h1>', 404)
                return
            if not self.origin_ok():
                self.send_page('<h1>403</h1><p>Cross-origin form submission refused.</p>', 403)
                return

            path = urllib.parse.urlsplit(self.path).path
            try:
                fields = self.read_form()
            except ValueError as error:
                self.redirect('/', str(error), 'error')
                return
            if not self.token_ok(fields):
                self.send_page('<h1>403</h1><p>This form is stale. Reload the page and try again.</p>', 403)
                return

            try:
                if path == '/connections':
                    self.create(fields)
                elif path.startswith('/connections/') and path.endswith('/edit'):
                    self.edit(path.split('/')[2], fields)
                elif path.startswith('/connections/') and path.endswith('/test'):
                    self.test(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/introspect'):
                    self.introspect(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/measure'):
                    self.measure(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/activity'):
                    self.server_activity(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/statistics'):
                    self.statistics(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/activate'):
                    self.activate(path.split('/')[2])
                elif path.startswith('/connections/') and path.endswith('/delete'):
                    self.remove(path.split('/')[2])
                else:
                    self.send_page('<h1>404</h1>', 404)
            except ValueError as error:
                self.redirect('/connections/new', str(error), 'error')

        def create(self, fields: dict[str, str]) -> None:
            try:
                port = int(fields.get('port') or 5432)
            except ValueError:
                raise ValueError('port must be a number') from None
            entry = store.add(
                name=fields.get('name', ''), host=fields.get('host', ''), port=port,
                database=fields.get('database', ''), username=fields.get('username', ''),
                password=fields.get('password', ''),
                tls_mode=fields.get('tls_mode', 'verify-full'),
                ca_cert_pem=fields.get('ca_cert_pem', ''),
            )
            self.set_active(entry.id)
            ok, detail = self.verify(entry.id)
            if ok:
                self.redirect('/', f'{entry.name} saved and verified. '
                                   'Choose "Populate structure" to load its schema.', 'success')
            else:
                self.redirect('/', f'{entry.name} was saved, but the connection test failed.\n\n{detail}',
                              'error')

        def edit(self, connection_id: str, fields: dict[str, str]) -> None:
            """Save a change to a saved connection, then test it as saving a new one does.

            A wrong database name or a rotated password was previously a delete and a full
            retype, which also threw away everything the connection had already recorded.
            """
            before = store.get(connection_id)
            if before is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            back = f'/connections/{connection_id}/edit'
            try:
                port = int(fields.get('port') or 5432)
            except ValueError:
                self.redirect(back, 'port must be a number', 'error')
                return
            try:
                entry = store.update(
                    connection_id, name=fields.get('name', ''), host=fields.get('host', ''),
                    port=port, database=fields.get('database', ''),
                    username=fields.get('username', ''), password=fields.get('password', ''),
                    tls_mode=fields.get('tls_mode', 'verify-full'),
                    ca_cert_pem=fields.get('ca_cert_pem', ''),
                    drop_ca_cert=fields.get('drop_ca_cert', '') == 'on',
                )
            except ValueError as error:
                self.redirect(back, str(error), 'error')
                return
            except KeyError:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return

            note = ''
            if (before.host, before.port, before.database) != (entry.host, entry.port,
                                                               entry.database):
                note = self.discard_populated(connection_id, before.name)
            ok, detail = self.verify(connection_id)
            if ok:
                self.redirect('/', f'{entry.name} updated and verified.{note}', 'success')
            else:
                self.redirect('/', f'{entry.name} was updated, but the connection test '
                                   f'failed.{note}\n\n{detail}', 'error')

        def discard_populated(self, connection_id: str, previous_name: str) -> str:
            """Drop what was read from the database this connection no longer points at.

            The connection keeps its name on screen, so a snapshot left behind would be read
            as the new target's schema. Populating again rebuilds both the snapshot and the
            page; nothing here touches the database.
            """
            note = ''
            snapshot = SNAPSHOT_DIR / f'{connection_id}.json'
            page = view_path(connection_id)
            if snapshot.is_file():
                snapshot.unlink()
                # The page drawn from it goes with it, or the workspace keeps showing the
                # database this connection no longer points at.
                page.unlink(missing_ok=True)
                page.with_suffix('.build').unlink(missing_ok=True)
                note = (' The structure populated from the previous database was discarded; '
                        'choose "Populate structure" to load the new one.')
            try:
                marker = json.loads(CURRENT.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                marker = {}
            # Markers written before connection_id was recorded carry the name instead, which
            # is what the explorer link shows, so it is the right fallback.
            rendered_here = (marker.get('connection_id') == connection_id
                             or ('connection_id' not in marker
                                 and marker.get('connection') == previous_name))
            if rendered_here:
                for path in (ARTIFACT, ARTIFACT.with_suffix('.build'), CURRENT):
                    path.unlink(missing_ok=True)
                note += ' The schema explorer was showing it, so that page was cleared too.'
            return note

        def verify(self, connection_id: str) -> tuple[bool, str]:
            """Open a bounded connection and record the outcome. Returns (ok, detail)."""
            from tools.local_admin.introspection import check_connection
            dsn, ca = store.dsn_for(connection_id)
            ok, detail, version = check_connection(dsn, ca)
            stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            if ok:
                store.update_status(connection_id, last_verified_at=stamp, last_error='',
                                    server_version=version)
            else:
                store.update_status(connection_id, last_error=detail)
            return ok, detail

        def test(self, connection_id: str) -> None:
            if store.get(connection_id) is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            ok, detail = self.verify(connection_id)
            self.redirect('/', 'Connection verified.' if ok else detail,
                          'success' if ok else 'error')

        def introspect(self, connection_id: str) -> None:
            entry = store.get(connection_id)
            if entry is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            dsn, ca = store.dsn_for(connection_id)
            SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
            target = SNAPSHOT_DIR / f'{connection_id}.json'
            try:
                summary = introspect_to_snapshot(dsn, ca, target, display_name=entry.name)
            except Exception as error:  # noqa: BLE001 - message is shaped for a person
                store.update_status(connection_id, last_error=str(error))
                self.redirect('/', f'Could not read the catalog.\n\n{error}', 'error')
                return
            try:
                self.publish(connection_id, target)
            except Exception as error:  # noqa: BLE001
                self.redirect('/', f'The schema was read but could not be rendered.\n\n{error}',
                              'error')
                return
            stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            store.update_status(connection_id, last_snapshot=stamp, last_error='',
                                last_verified_at=stamp)
            self.set_active(connection_id)
            CURRENT.write_text(json.dumps({
                'connection': entry.name,
                # Which connection drew this, so retargeting one can tell whether the page on
                # screen is the database it just stopped pointing at.
                'connection_id': connection_id,
                'database': summary['database'],
                'tables': summary['tables'],
                'columns': summary['columns'],
                'populated_at': stamp,
            }, indent=1), encoding='utf-8')
            # Re-reading the structure says nothing new about row counts, so a populate that
            # kept them says so rather than leaving the city at baseline with no explanation.
            counts = ('Row counts are absent because introspection reads catalog metadata only.'
                      if not summary['carried'] else
                      f'Row counts and column statistics measured earlier were kept for '
                      f'{summary["carried"]} of {summary["tables"]} tables; measure again to '
                      'refresh them.')
            self.redirect('/', (
                f'{entry.name}: {summary["tables"]} tables, {summary["columns"]} columns and '
                f'{summary["foreignKeyColumnPairs"]} foreign-key column pairs loaded. '
                f'Open the schema explorer to see them. {counts}'
            ), 'success')

        def measure(self, connection_id: str) -> None:
            """
            Count rows for a populated connection and merge the counts into its snapshot.

            Separate from introspect() deliberately: that reads catalog metadata, this queries the
            user's tables. The consent page states the scope and the caps before this runs.
            """
            entry = store.get(connection_id)
            if entry is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            target = SNAPSHOT_DIR / f'{connection_id}.json'
            if not target.is_file():
                self.redirect('/', 'Populate the structure before measuring row counts.', 'error')
                return
            dsn, ca = store.dsn_for(connection_id)
            try:
                summary = introspection.measure_row_counts(dsn, ca, target)
            except Exception as error:  # noqa: BLE001 - message is shaped for a person
                store.update_status(connection_id, last_error=str(error))
                self.redirect('/', f'Could not count rows.\n\n{error}', 'error')
                return
            try:
                self.publish(connection_id, target)
            except Exception as error:  # noqa: BLE001
                self.redirect('/', 'Rows were counted but the schema could not be rendered.'
                                   f'\n\n{error}', 'error')
                return
            stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            store.update_status(connection_id, last_snapshot=stamp, last_error='',
                                last_verified_at=stamp)
            if CURRENT.is_file():
                # Keep the overview page's summary in step with what was just measured.
                try:
                    overview = json.loads(CURRENT.read_text(encoding='utf-8'))
                    overview['measured_at'] = stamp
                    overview['counted_tables'] = summary['counted']
                    CURRENT.write_text(json.dumps(overview, indent=1), encoding='utf-8')
                except (OSError, ValueError):
                    pass
            unknown = summary['failed'] + summary['views']
            rows = format(summary['rows'], ',')
            detail = (f'{entry.name}: counted {summary["counted"]} of {summary["tables"]} tables '
                      f'({rows} rows) in {summary["seconds"]}s.')
            if unknown:
                views = f' ({summary["views"]} of them views)' if summary['views'] else ''
                detail += (f' {unknown} kept an unknown count{views} and each says why in the '
                           'inspector.')
            detail += ' Schema City now sizes its buildings by measured rows.'
            self.redirect('/', detail, 'success')

        def statistics(self, connection_id: str) -> None:
            """
            Gather column statistics for a populated connection and merge them into its snapshot.

            A further step beyond measure(): counting rows returns numbers, this reads column
            values. The consent page states what is kept and what is withheld before it runs.
            """
            entry = store.get(connection_id)
            if entry is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            target = SNAPSHOT_DIR / f'{connection_id}.json'
            if not target.is_file():
                self.redirect('/', 'Populate the structure before gathering column statistics.',
                              'error')
                return
            dsn, ca = store.dsn_for(connection_id)
            try:
                summary = introspection.measure_column_stats(dsn, ca, target)
            except Exception as error:  # noqa: BLE001 - message is shaped for a person
                store.update_status(connection_id, last_error=str(error))
                self.redirect('/', f'Could not gather column statistics.\n\n{error}', 'error')
                return
            try:
                self.publish(connection_id, target)
            except Exception as error:  # noqa: BLE001
                self.redirect('/', 'Statistics were gathered but the schema could not be '
                                   f'rendered.\n\n{error}', 'error')
                return
            stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            store.update_status(connection_id, last_snapshot=stamp, last_error='',
                                last_verified_at=stamp)
            detail = (f'{entry.name}: profiled {summary["profiled"]} of {summary["tables"]} tables '
                      f'and {summary["columns"]} columns in {summary["seconds"]}s. '
                      f'Extremes kept for {summary["extremes"]} columns, withheld for '
                      f'{summary["withheld"]} whose type could carry free text, a secret or an '
                      'identifier.')
            if summary['failed'] or summary['views']:
                detail += (f' {summary["failed"] + summary["views"]} tables were skipped or timed '
                           'out and say why in the inspector.')
            self.redirect('/', detail, 'success')

        def activate(self, connection_id: str) -> None:
            """Show this connection in the workspace. The toggle the menu bar is there for."""
            entry = store.get(connection_id)
            if entry is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            self.set_active(connection_id)
            if not (SNAPSHOT_DIR / f'{connection_id}.json').is_file():
                self.redirect('/', f'{entry.name} has no populated structure yet. Choose Tools, '
                                   'then Populate structure.', 'error')
                return
            self.redirect('/', f'Showing {entry.name}.', 'success')

        def server_activity(self, connection_id: str) -> None:
            """Read what the server is doing and render it. Nothing is stored anywhere.

            The odd one out among the actions: it answers about the server rather than about
            the data, so there is no snapshot to merge into and no page to re-render. The
            report is rendered straight back, which is also why this one does not redirect.
            """
            entry = store.get(connection_id)
            if entry is None:
                self.redirect('/', 'That connection no longer exists.', 'error')
                return
            dsn, ca = store.dsn_for(connection_id)
            try:
                report = activity.read_activity(dsn, ca)
            except Exception as error:  # noqa: BLE001 - message is shaped for a person
                store.update_status(connection_id, last_error=str(error))
                self.redirect('/', f'Could not read the server activity.\n\n{error}', 'error')
                return
            self.send_page(pages.activity_report(
                entry.public(), report, token=session['token'],
                artifact_ready=self.artifact_ready(), current=self.current()))

        def remove(self, connection_id: str) -> None:
            name = getattr(store.get(connection_id), 'name', 'That connection')
            removed = store.delete(connection_id)
            if removed:
                # Nothing can reach the snapshot or its page once the connection is gone, and
                # leaving them behind would let a later connection with the same id inherit
                # another database's schema.
                for path in (SNAPSHOT_DIR / f'{connection_id}.json', view_path(connection_id),
                             view_path(connection_id).with_suffix('.build')):
                    path.unlink(missing_ok=True)
                try:
                    if json.loads(ACTIVE.read_text(encoding='utf-8')).get('connection_id') == connection_id:
                        ACTIVE.unlink(missing_ok=True)
                except (OSError, ValueError, AttributeError):
                    pass
            self.redirect('/', f'{name} removed.' if removed else 'That connection no longer exists.',
                          'success' if removed else 'error')

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--bind', default='127.0.0.1',
                        help='Interface to bind. Use 0.0.0.0 only inside a container.')
    parser.add_argument('--allowed-host', action='append', default=[],
                        help='Extra Host header to accept, repeatable')
    parser.add_argument('--state-dir', type=Path, default=STATE_DIR,
                        help='Where the encrypted connection store lives')
    args = parser.parse_args()

    store = ConnectionStore(args.state_dir)
    allowed = {f'127.0.0.1:{args.port}', f'localhost:{args.port}', f'[::1]:{args.port}'}
    allowed.update(args.allowed_host)
    session = {'token': secrets.token_urlsafe(32)}

    server = ThreadingHTTPServer((args.bind, args.port), make_handler(store, allowed, session))
    print(f'Local admin on http://127.0.0.1:{args.port}/')
    print(f'  connections: {store.path}')
    print(f'  key:         {store.key_path}  (losing this means re-entering passwords)')
    print('  add a connection in the browser; no environment variable is needed')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
