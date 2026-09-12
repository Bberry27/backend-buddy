"""Serve a local schema explorer with an optional explicitly configured read-only adapter."""
import argparse
import hmac
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from schema_profiler import connect_readonly, profile, subtree
from snapshot_io import validate_output


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--html', type=Path, required=True)
    p.add_argument('--schema', type=Path, required=True)
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--dialect', choices=['sqlite', 'postgresql'])
    p.add_argument('--database', help='Explicit SQLite file; never creates a database')
    p.add_argument('--dsn-env', help='Name of an explicitly selected PostgreSQL DSN environment variable')
    p.add_argument('--snapshot-output', type=Path, help='Optional destination for updated profiling snapshot')
    p.add_argument('--include-sample-values', action='store_true', help='Include up to three sampled column values in snapshot')
    args = p.parse_args()
    try:
        validate_output(args.snapshot_output, [args.html, args.schema, args.database if args.dialect == 'sqlite' else None])
    except ValueError:
        p.error('Snapshot output must be separate from source files')
    if args.dialect == 'sqlite' and not args.database:
        p.error('--database is required for SQLite')
    if args.dialect == 'postgresql' and not args.dsn_env:
        p.error('--dsn-env is required for PostgreSQL')
    dsn = args.database if args.dialect == 'sqlite' else os.environ.get(args.dsn_env or '')
    if args.dialect and not dsn:
        p.error('The selected connection configuration is empty')
    graph = json.loads(args.schema.read_text(encoding='utf-8-sig'))
    page = args.html.read_text(encoding='utf-8')
    token = secrets.token_urlsafe(32)
    operation_lock = threading.Lock()
    address = f'127.0.0.1:{args.port}'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code, content, content_type='application/json'):
            body = content.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') == address

        def do_GET(self):
            if not self.valid_host() or urlsplit(self.path).path != '/':
                self.send(404, '{}')
                return
            result = page
            if args.dialect:
                # Only this served copy receives the same-origin capability; the artifact stays offline.
                result = result.replace("connect-src 'none'", "connect-src 'self'")
                capability = '<script>window.__SCHEMA_LIVE__=' + json.dumps({'token': token}) + ';</script>'
                result = result.replace('<script id="schema-data"', capability + '<script id="schema-data"')
            self.send(200, result, 'text/html;charset=utf-8')

        def do_POST(self):
            nonlocal graph
            if not self.valid_host() or self.headers.get('Origin') != 'http://' + address:
                self.send(403, '{"error":"Invalid origin"}')
                return
            supplied_token = self.headers.get('X-Schema-Token', '')
            if not args.dialect or not supplied_token.isascii() or not hmac.compare_digest(supplied_token, token):
                self.send(403, '{"error":"Read-only connection unavailable"}')
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 65536:
                    raise ValueError('Request too large or empty')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError('Expected a JSON object')
                if not operation_lock.acquire(blocking=False):
                    self.send(409, '{"error":"A read-only job is already running"}')
                    return
                try:
                    with connect_readonly(args.dialect, dsn) as connection:
                        if self.path == '/api/profile':
                            result = profile(graph, connection, body.get('tables', []), max_rows=body.get('maxRowsPerTable', 10000), include_sample_values=args.include_sample_values)
                            graph = result['graph']
                            if args.snapshot_output:
                                args.snapshot_output.parent.mkdir(parents=True, exist_ok=True)
                                args.snapshot_output.write_text(json.dumps(graph, indent=2), encoding='utf-8')
                        elif self.path == '/api/subtree':
                            result = subtree(graph, connection, body['rootTable'], body['pkValue'], body.get('depth', 4), max_rows=body.get('maxRowsPerHop', 10000))
                        else:
                            raise ValueError('Unknown operation')
                finally:
                    operation_lock.release()
                self.send(200, json.dumps(result))
            except (ValueError, KeyError, TypeError):
                self.send(400, '{"error":"Invalid profiling request or schema"}')
            except Exception:
                # Connection exceptions may contain DSNs or sample values.
                self.send(500, '{"error":"Read-only operation failed or exceeded its time budget"}')

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'http://{address}/ (read-only connection {"enabled" if args.dialect else "disabled"})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
