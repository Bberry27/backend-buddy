"""HTML for the local admin area. Server-rendered, no build step, no bundle.

Every value that reaches markup goes through `E`. The pages use the same 16 design tokens
as the explorer so the admin area looks like the product rather than a debug console.
"""
from __future__ import annotations

from html import escape as _escape
from typing import Any

from .store import DEFAULT_TLS, TLS_MODES


def E(value: Any) -> str:
    """Escape for HTML. Everything interpolated into a page goes through this."""
    return _escape('' if value is None else str(value), quote=True)


# The token values are copied from skill/assets/explorer.html so the two surfaces match.
STYLE = """
:root{color-scheme:dark;--bg:#131718;--panel:#1b2022;--raised:#242b2e;--ink:#edf2f3;
--muted:#a8b7bd;--line:#3a4549;--accent:#71d5c2;--soft:#253e38;--edge:#64767d;
--focus:#a4eee0;--blue:#7fb6f0;--orange:#edb571;--green:#8fd3a5;--red:#ee99aa}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--ink)}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;
align-items:baseline;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:19px;letter-spacing:.2px}
header p{margin:0;color:var(--muted)}
nav a{color:var(--accent);text-decoration:none;margin-right:14px}
nav a:hover{text-decoration:underline}
main{padding:24px;max-width:900px}
h2{font-size:16px;margin:0 0 4px}
.hint{color:var(--muted);margin:0 0 18px}
form{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:20px}
fieldset{border:0;padding:0;margin:0 0 18px}
legend{padding:0;font-weight:600;margin-bottom:8px}
label{display:block;margin-bottom:14px}
label span{display:block;margin-bottom:5px}
label small{display:block;color:var(--muted);font-weight:400;margin-top:4px}
input,select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);
border-radius:5px;background:var(--bg);color:inherit;font:inherit}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--focus);
outline-offset:1px}
textarea{min-height:76px;font-family:Consolas,ui-monospace,monospace;font-size:12px}
.row{display:grid;grid-template-columns:2fr 1fr;gap:14px}
button{padding:9px 14px;border:1px solid var(--line);border-radius:5px;background:var(--raised);
color:inherit;font:inherit;cursor:pointer;min-height:36px}
button:hover{border-color:var(--accent)}
button.primary{background:var(--soft);border-color:var(--accent);font-weight:600}
button.danger:hover{border-color:var(--red);color:var(--red)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--raised);font-size:12px;text-transform:uppercase;letter-spacing:.4px;
color:var(--muted)}
tr:last-child td{border-bottom:0}
td form{display:inline;background:0;border:0;padding:0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.badge{display:inline-block;padding:2px 7px;border-radius:99px;font-size:12px;
border:1px solid var(--line);background:var(--bg)}
.ok{color:var(--green);border-color:var(--green)}
.bad{color:var(--red);border-color:var(--red)}
.idle{color:var(--muted)}
.notice{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);
padding:12px 14px;border-radius:6px;margin-bottom:18px;white-space:pre-wrap}
.notice.error{border-left-color:var(--red)}
.notice.success{border-left-color:var(--green)}
.empty{background:var(--panel);border:1px dashed var(--edge);border-radius:8px;padding:28px;
text-align:center;color:var(--muted)}
.empty strong{color:var(--ink);display:block;margin-bottom:6px;font-size:15px}
.consent{background:var(--panel);border:1px dashed var(--edge);border-radius:8px;padding:24px}
.consent>strong{color:var(--ink);display:block;margin-bottom:4px;font-size:15px}
.consent ul{margin:8px 0 0 20px;line-height:1.65}
.consent p{margin:14px 0 0}
.consent code{background:var(--raised);border-radius:3px;padding:1px 5px}
details{margin-top:16px;color:var(--muted)}
summary{cursor:pointer;color:var(--accent)}
details ul{margin:10px 0 0;padding-left:20px}
details li{margin-bottom:7px}
code{background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:1px 5px;
font-size:12px}
footer{padding:16px 24px;color:var(--muted);border-top:1px solid var(--line);margin-top:32px}
"""


def shell(title: str, body: str, *, artifact_ready: bool,
          current: dict[str, Any] | None = None) -> str:
    """The page frame. No external request: the policy forbids one and none is needed."""
    if artifact_ready and current:
        label = (f'Open the schema explorer: {current.get("connection", "unknown")}, '
                 f'{current.get("tables", "?")} tables')
        view = (f'<a href="/view">{E(label)}</a>'
                f'<div class="hint" style="margin:2px 0 0;text-align:right">'
                f'populated {E(current.get("populated_at", "unknown"))}</div>')
    elif artifact_ready:
        view = '<a href="/view">Open the schema explorer</a>'
    else:
        view = '<span class="idle">Explorer appears once a database is populated</span>' 
    return f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'">
<title>{E(title)} | Backend Buddy admin</title>
<style>{STYLE}</style>
</head>
<body>
<header>
  <h1>Backend Buddy</h1>
  <p>Local admin</p>
  <nav style="margin-left:auto">
    <a href="/">Connections</a>
    {view}
  </nav>
</header>
<main>
{body}
</main>
<footer>
Credentials are encrypted with a key held only on this machine and are never sent anywhere.
Introspection reads catalog metadata only and issues no query against your tables.
</footer>
</body>
</html>
"""


def csrf_field(token: str) -> str:
    """A hidden token in every form.

    Relying on the Origin header or a SameSite cookie is not enough: an embedded or
    proxied browser context may send neither, which reads to the user as the product
    being broken. A token the server put in the page it rendered is the check that
    works everywhere, and it is what the API uses too.
    """
    return f'<input type="hidden" name="_csrf" value="{E(token)}">'


def notice(message: str, kind: str = '') -> str:
    if not message:
        return ''
    css = f'notice {kind}'.strip()
    return f'<div class="{E(css)}" role="status">{E(message)}</div>'


def connection_rows(connections: list[dict[str, Any]], token: str) -> str:
    rows = []
    field = csrf_field(token)
    for c in connections:
        if c['last_error']:
            status = f'<span class="badge bad">Failed</span>'
            detail = f'<div class="hint" style="margin:6px 0 0">{E(c["last_error"])}</div>'
        elif c['last_verified_at']:
            status = '<span class="badge ok">Verified</span>'
            detail = f'<div class="hint" style="margin:6px 0 0">{E(c["last_verified_at"])}</div>'
        else:
            status = '<span class="badge idle">Not tested</span>'
            detail = ''
        snapshot = (f'<div class="hint" style="margin:6px 0 0">Snapshot: {E(c["last_snapshot"])}</div>'
                    if c['last_snapshot'] else '')
        # Row counts need a structure to merge into, and reading rows is its own consent, so this
        # is a link to a page that states the scope rather than a button that runs a query.
        if c['last_snapshot']:
            measure = (f'<a href="/connections/{E(c["id"])}/measure"><button type="button">'
                       'Measure row counts</button></a>'
                       f'<a href="/connections/{E(c["id"])}/statistics"><button type="button">'
                       'Gather column statistics</button></a>')
        else:
            measure = ('<button type="button" disabled title="Populate the structure first">'
                       'Measure row counts</button>'
                       '<button type="button" disabled title="Populate the structure first">'
                       'Gather column statistics</button>')
        rows.append(f"""<tr>
  <td><strong>{E(c['name'])}</strong>
      <div class="hint" style="margin:4px 0 0">{E(c['username'])}@{E(c['host'])}:{E(c['port'])}/{E(c['database'])}</div>
      <div class="hint" style="margin:2px 0 0">TLS {E(c['tls_mode'])}{' · certificate supplied' if c['has_ca_cert'] else ''}</div></td>
  <td>{status}{detail}{snapshot}</td>
  <td><div class="actions">
    <form method="post" action="/connections/{E(c['id'])}/test">{field}<button type="submit">Test</button></form>
    <form method="post" action="/connections/{E(c['id'])}/introspect">{field}<button type="submit" class="primary">Populate structure</button></form>
    {measure}
    <form method="post" action="/connections/{E(c['id'])}/delete">{field}<button type="submit" class="danger">Delete</button></form>
  </div></td>
</tr>""")
    return '\n'.join(rows)


def index(connections: list[dict[str, Any]], *, token: str, message: str = '', kind: str = '',
          artifact_ready: bool = False, current: dict[str, Any] | None = None) -> str:
    if connections:
        body = f"""{notice(message, kind)}
<h2>Connections</h2>
<p class="hint">Populate structure reads your catalog and loads your schema into the thirteen views.
It touches no table rows, so row counts and column statistics stay unknown. Measuring row counts
and gathering column statistics are separate steps, each asked for on its own, because each
queries your tables.</p>
<table>
<thead><tr><th>Connection</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>
{connection_rows(connections, token)}
</tbody>
</table>
<p style="margin-top:20px"><a href="/connections/new"><button type="button">Add another connection</button></a></p>
"""
    else:
        body = f"""{notice(message, kind)}
<div class="empty">
  <strong>No database connected</strong>
  Nothing here is your data yet. Add a connection and populate its structure to see your own schema.
  <p style="margin:18px 0 0"><a href="/connections/new"><button type="button" class="primary">Add a connection</button></a></p>
</div>
"""
    return shell('Connections', body, artifact_ready=artifact_ready, current=current)


def form(*, token: str, message: str = '', kind: str = '', values: dict[str, Any] | None = None,
         artifact_ready: bool = False, current: dict[str, Any] | None = None) -> str:
    v = values or {}

    def value_of(name: str, default: str = '') -> str:
        return E(v.get(name, default))

    options = '\n'.join(
        f'<option value="{E(mode)}"{" selected" if v.get("tls_mode", DEFAULT_TLS) == mode else ""}>'
        f'{E(mode)}{" (recommended)" if mode == DEFAULT_TLS else ""}</option>'
        for mode in TLS_MODES
    )
    body = f"""{notice(message, kind)}
<h2>Add a PostgreSQL connection</h2>
<p class="hint">Credentials are encrypted on this machine. Nothing is sent anywhere but the database you name.</p>
<form method="post" action="/connections">
  {csrf_field(token)}
  <fieldset>
    <legend>Server</legend>
    <label><span>Display name</span>
      <input name="name" required autocomplete="off" value="{value_of('name')}"
             placeholder="Production reporting">
    </label>
    <div class="row">
      <label><span>Host</span>
        <input name="host" required autocomplete="off" value="{value_of('host')}"
               placeholder="myserver.postgres.database.azure.com">
        <small>For a database on this machine while the app runs in Docker, use <code>host.docker.internal</code>.</small>
      </label>
      <label><span>Port</span>
        <input name="port" type="number" min="1" max="65535" required value="{value_of('port', '5432')}">
      </label>
    </div>
    <label><span>Database</span>
      <input name="database" required autocomplete="off" value="{value_of('database')}">
    </label>
  </fieldset>
  <fieldset>
    <legend>Credentials</legend>
    <label><span>Username</span>
      <input name="username" required autocomplete="off" value="{value_of('username')}">
      <small>Use a role with read access only. A managed PostgreSQL may require
      <code>user@servername</code> on its legacy single-server tier.</small>
    </label>
    <label><span>Password</span>
      <input name="password" type="password" required autocomplete="new-password" spellcheck="false">
      <small>Encrypted immediately and never shown again.</small>
    </label>
  </fieldset>
  <fieldset>
    <legend>Encryption in transit</legend>
    <label><span>TLS mode</span>
      <select name="tls_mode">{options}</select>
      <small>Full verification checks the certificate and the hostname. Lower it only if
      verification fails and you understand why.</small>
    </label>
    <label><span>Certificate authority, optional</span>
      <textarea name="ca_cert_pem" spellcheck="false"
                placeholder="-----BEGIN CERTIFICATE-----">{value_of('ca_cert_pem')}</textarea>
      <small>Only needed for a private or self-signed authority. A managed PostgreSQL
      usually chains to a root your machine already trusts.</small>
    </label>
  </fieldset>
  <div class="actions">
    <button type="submit" class="primary">Save and test</button>
    <a href="/"><button type="button">Cancel</button></a>
  </div>
</form>
<details>
  <summary>If the connection fails</summary>
  <ul>
    <li><strong>Timeout</strong> against a managed database usually means its firewall has no
    rule for this machine's public address. The database never sees the container's private address.</li>
    <li><strong>Certificate error</strong> means verification failed. Supply the authority above,
    or lower the TLS mode deliberately.</li>
    <li><strong>Password rejected</strong> means the host was reached. Check the role, and on a
    legacy managed tier try <code>user@servername</code>.</li>
    <li><strong>Connection refused to localhost</strong> means this app is in a container, where
    localhost is the container. Use <code>host.docker.internal</code>.</li>
  </ul>
</details>
"""
    return shell('Add a connection', body, artifact_ready=artifact_ready, current=current)

def measure_consent(connection: dict[str, Any], *, token: str, message: str = '', kind: str = '',
                    statement_timeout_ms: int, deadline_seconds: int,
                    artifact_ready: bool = False, current: dict[str, Any] | None = None) -> str:
    """
    State what measuring row counts does before it runs. Reading rows is a different decision from
    reading the catalog, so the product asks rather than assuming, and says exactly what it will do.
    """
    body = f"""{notice(message, kind)}
<h2>Measure row counts</h2>
<p class="hint">{E(connection['name'])} &middot; {E(connection['username'])}@{E(connection['host'])}:{E(connection['port'])}/{E(connection['database'])}</p>

<div class="consent">
  <strong>This step queries your tables. Populating the structure did not.</strong>
  <p>What runs, exactly:</p>
  <ul>
    <li><code>SELECT count(*)</code> once per table, inside a read-only session.</li>
    <li>A count returns one number. <strong>No column value is read</strong>, so nothing from
        inside a row can reach the snapshot, the artifact, or this screen.</li>
    <li>Counts are exact, not planner estimates. A table that cannot be counted keeps an
        <strong>unknown</strong> count and is labelled with the reason &mdash; it is never
        recorded as zero.</li>
    <li>Views are skipped: counting one executes it, and a view has no stored rows of its own.</li>
  </ul>
  <p>The bounds:</p>
  <ul>
    <li>{statement_timeout_ms // 1000} seconds per table, then that table is left unknown.</li>
    <li>{deadline_seconds // 60} minutes for the whole run, then the rest are left unknown.</li>
    <li>Read-only session, short-lived connection, closed when the run ends.</li>
  </ul>
  <p class="hint">On a large table a count is a sequential scan, so this
     costs your database real work. It is safe to re-run, and re-running replaces the counts.</p>
</div>

<div class="actions" style="margin-top:20px">
  <form method="post" action="/connections/{E(connection['id'])}/measure">{csrf_field(token)}
    <button type="submit" class="primary">Count rows now</button></form>
  <a href="/"><button type="button">Cancel</button></a>
</div>
"""
    return shell('Measure row counts', body, artifact_ready=artifact_ready, current=current)

def statistics_consent(connection: dict[str, Any], *, token: str, message: str = '', kind: str = '',
                       statement_timeout_ms: int, deadline_seconds: int, scalar_cap: int,
                       artifact_ready: bool = False,
                       current: dict[str, Any] | None = None) -> str:
    """
    State what gathering column statistics does before it runs.

    A step further than counting rows: a count returns one number, while a minimum or a maximum is
    a real value out of a column. So this page says which columns will have their extremes kept and
    which will not, before anything is read.
    """
    body = f"""{notice(message, kind)}
<h2>Gather column statistics</h2>
<p class="hint">{E(connection['name'])} &middot; {E(connection['username'])}@{E(connection['host'])}:{E(connection['port'])}/{E(connection['database'])}</p>

<div class="consent">
  <strong>This reads column values, not just a count of rows.</strong>
  <p>What runs, exactly:</p>
  <ul>
    <li>One <code>SELECT</code> per table, computed by your database in a read-only session: a row
        count, and per column a non-NULL count and a <code>count(DISTINCT)</code>.</li>
    <li><strong>The aggregates come back; the rows do not.</strong> No row is retained, and this
        action offers no sample values at all.</li>
    <li>Statistics cover the <strong>whole table</strong>, not a sample, so the counts are exact
        rather than a floor.</li>
  </ul>
  <p>The one place a real value is kept:</p>
  <ul>
    <li>A minimum and a maximum are values out of your column. They are retained
        <strong>only</strong> for numeric, date, time and boolean columns.</li>
    <li>They are <strong>withheld</strong> for text, character, JSON, XML, array, binary, enum and
        UUID columns &mdash; anything whose type could carry free text, a secret, or an identifier.
        Those columns get counts alone.</li>
    <li>Retained extremes are truncated to {scalar_cap} characters by the database, so an
        oversized value never crosses the wire.</li>
  </ul>
  <p>The bounds:</p>
  <ul>
    <li>{statement_timeout_ms // 1000} seconds per table, then that table is left as it was.</li>
    <li>{deadline_seconds // 60} minutes for the whole run, then the rest are left as they were.</li>
    <li>Read-only session, short-lived connection, closed when the run ends.</li>
  </ul>
  <p class="hint">This is heavier than counting rows: a <code>count(DISTINCT)</code> per column
     means a full scan that sorts or hashes each column. On a large database run it when you can
     afford the load. It is safe to re-run, and re-running replaces the statistics.</p>
</div>

<div class="actions" style="margin-top:20px">
  <form method="post" action="/connections/{E(connection['id'])}/statistics">{csrf_field(token)}
    <button type="submit" class="primary">Gather statistics now</button></form>
  <a href="/"><button type="button">Cancel</button></a>
</div>
"""
    return shell('Gather column statistics', body, artifact_ready=artifact_ready, current=current)

