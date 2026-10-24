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
/* An action that only navigates is a link wrapped around a button (Measure, Gather, Edit).
   Inheriting the colour meant inheriting the browser's link and visited-link colours, so
   those buttons sat beside Delete in two shades of blue. The token is explicit instead. */
button{padding:9px 14px;border:1px solid var(--line);border-radius:5px;background:var(--raised);
color:var(--ink);font:inherit;cursor:pointer;min-height:36px}
.actions a{text-decoration:none}
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

/* The workspace: a menu bar over the schema, the way an application looks rather than a
   landing page you leave. Menus are <details>, so they open and close with no script at
   all, which keeps the page policy free of script-src. */
body.app{height:100vh;display:flex;flex-direction:column;overflow:hidden}
.menubar{display:flex;align-items:stretch;gap:2px;padding:0 8px;background:var(--panel);
border-bottom:1px solid var(--line);flex-shrink:0}
.menubar-brand{display:flex;align-items:center;padding:0 10px 0 4px;font-weight:600;
letter-spacing:.2px;white-space:nowrap}
.menubar-status{display:flex;align-items:center;gap:8px;margin-left:auto;padding:0 6px;
color:var(--muted);font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.menubar-status a{color:var(--accent);text-decoration:none}
.menubar-status a:hover{text-decoration:underline}
.menu{position:relative}
.menu>summary{list-style:none;padding:9px 11px;cursor:pointer;user-select:none;
border:1px solid transparent;border-radius:4px 4px 0 0}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary:hover{background:var(--raised)}
.menu>summary:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.menu[open]>summary{background:var(--raised);border-color:var(--line);border-bottom-color:var(--raised)}
.menu-panel{position:absolute;top:100%;left:0;z-index:5;min-width:260px;max-width:min(380px,90vw);
padding:5px;background:var(--panel);border:1px solid var(--line);border-radius:0 4px 4px 4px;
box-shadow:0 8px 24px var(--bg)}
.menu-panel a,.menu-panel button,.menu-panel .menu-disabled{display:block;width:100%;padding:7px 9px;
border:0;border-radius:3px;background:0;color:var(--ink);font:inherit;text-align:left;
text-decoration:none;cursor:pointer}
.menu-panel a:hover,.menu-panel button:hover{background:var(--raised)}
.menu-panel a:focus-visible,.menu-panel button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.menu-panel .menu-disabled{color:var(--edge);cursor:default}
.menu-panel form{display:block;padding:0;margin:0;background:0;border:0;border-radius:0}
.menu-panel button{min-height:0}
.menu-panel button:hover{border-color:transparent}
.menu-panel hr{margin:5px 2px;border:0;border-top:1px solid var(--line)}
.menu-panel small{display:block;padding:0 9px 6px;color:var(--muted);font-size:11px;line-height:1.45}
.menu-item-note{display:block;color:var(--muted);font-size:11px}
.menu-current{color:var(--accent)}
.workspace{flex:1;min-height:0;position:relative;display:flex}
.workspace-frame{flex:1;border:0;width:100%;height:100%;background:var(--bg)}
.workspace .empty{margin:auto;max-width:560px}
.workspace-notice{margin:10px 12px 0}
.activity-heading{font-size:14px;margin:22px 0 6px}
"""


def document(title: str, body: str, *, body_class: str = '', frame_src: bool = False) -> str:
    """The frame every page here shares: one inline stylesheet, no script, no network.

    `frame_src` widens the policy by exactly one directive, for the workspace page that
    embeds the rendered explorer. Nothing else is relaxed, and the explorer keeps its own
    strict policy inside that frame: this page may frame it, and that is all.
    """
    policy = ("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
              "base-uri 'none'")
    if frame_src:
        policy += "; frame-src 'self'"
    return f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{E(policy)}">
<title>{E(title)} | Backend Buddy admin</title>
<style>{STYLE}</style>
</head>
<body{f' class="{E(body_class)}"' if body_class else ''}>
{body}
</body>
</html>
"""


def shell(title: str, body: str, *, artifact_ready: bool,
          current: dict[str, Any] | None = None) -> str:
    """A page of the connection machinery: header, one column, footer."""
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
    return document(title, f"""<header>
  <h1>Backend Buddy</h1>
  <p>Local admin</p>
  <nav style="margin-left:auto">
    <a href="/">Workspace</a>
    <a href="/connections">Connections</a>
    {view}
  </nav>
</header>
<main>
{body}
</main>
<footer>
Credentials are encrypted with a key held only on this machine and are never sent anywhere.
Introspection reads catalog metadata only and issues no query against your tables.
</footer>""")


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
    <a href="/connections/{E(c['id'])}/edit"><button type="button">Edit</button></a>
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
         connection: dict[str, Any] | None = None,
         artifact_ready: bool = False, current: dict[str, Any] | None = None) -> str:
    """The credentials form. Given a `connection`, the same form in edit mode.

    Editing prefills every field the store hands back, which is every field except the two
    it keeps write-only: the password and the certificate body. Those stay blank and mean
    "leave what is stored alone", so correcting a database name does not require retyping
    a password that was right all along.
    """
    editing = connection is not None
    v = {**(connection or {}), **(values or {})}

    def value_of(name: str, default: str = '') -> str:
        return E(v.get(name, default))

    options = '\n'.join(
        f'<option value="{E(mode)}"{" selected" if v.get("tls_mode", DEFAULT_TLS) == mode else ""}>'
        f'{E(mode)}{" (recommended)" if mode == DEFAULT_TLS else ""}</option>'
        for mode in TLS_MODES
    )
    action = f'/connections/{E(v.get("id", ""))}/edit' if editing else '/connections'
    heading = 'Edit connection' if editing else 'Add a PostgreSQL connection'
    submit_label = 'Save changes and test' if editing else 'Save and test'
    password_label = 'New password' if editing else 'Password'
    password_required = '' if editing else ' required'
    password_hint = ('Leave blank to keep the password already stored.' if editing
                     else 'Encrypted immediately and never shown again.')
    # A populated structure belongs to the database it was read from. Say so before the edit,
    # not only in the message afterwards.
    retarget_warning = ''
    if editing and v.get('last_snapshot'):
        retarget_warning = (
            '<p class="hint">A structure is populated for this connection. Changing the host, '
            'port or database discards it, because a schema read from one database must never '
            'be shown under another. Populate structure again to load the new one.</p>')
    if editing and v.get('has_ca_cert'):
        ca_hint = ('A certificate is already stored. Leave this blank to keep it, or paste '
                   'another to replace it.')
        ca_drop = """
    <label style="display:flex;gap:8px;align-items:center">
      <input type="checkbox" name="drop_ca_cert" value="on" style="width:auto">
      <span style="margin:0">Remove the stored certificate</span>
    </label>"""
    else:
        ca_hint = ('Only needed for a private or self-signed authority. A managed PostgreSQL '
                   'usually chains to a root your machine already trusts.')
        ca_drop = ''
    body = f"""{notice(message, kind)}
<h2>{E(heading)}</h2>
<p class="hint">Credentials are encrypted on this machine. Nothing is sent anywhere but the database you name.</p>
{retarget_warning}
<form method="post" action="{action}">
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
    <label><span>{password_label}</span>
      <input name="password" type="password"{password_required} autocomplete="new-password" spellcheck="false">
      <small>{password_hint}</small>
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
      <small>{ca_hint}</small>
    </label>{ca_drop}
  </fieldset>
  <div class="actions">
    <button type="submit" class="primary">{submit_label}</button>
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
    return shell('Edit connection' if editing else 'Add a connection', body,
                 artifact_ready=artifact_ready, current=current)

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



def menu_link(href: str, label: str, *, note: str = '', new_tab: bool = False) -> str:
    """A menu item that navigates."""
    target = ' target="_blank" rel="noopener"' if new_tab else ''
    inner = f'{E(label)}{f"<small class=menu-item-note>{E(note)}</small>" if note else ""}'
    return f'<a href="{E(href)}"{target}>{inner}</a>'


def menu_action(action: str, label: str, token: str, *, note: str = '') -> str:
    """A menu item that does something, which here always means a form post with a token."""
    inner = f'{E(label)}{f"<small class=menu-item-note>{E(note)}</small>" if note else ""}'
    return (f'<form method="post" action="{E(action)}">{csrf_field(token)}'
            f'<button type="submit">{inner}</button></form>')


def menu_disabled(label: str, reason: str) -> str:
    """An item that is not available yet, kept visible so the menu does not change shape."""
    return (f'<span class="menu-disabled" title="{E(reason)}">{E(label)}'
            f'<small class="menu-item-note">{E(reason)}</small></span>')


def menu(title: str, items: list[str]) -> str:
    return (f'<details class="menu"><summary>{E(title)}</summary>'
            f'<div class="menu-panel">{"".join(items)}</div></details>')


def workspace(connections: list[dict[str, Any]], *, active: dict[str, Any] | None, token: str,
              message: str = '', kind: str = '', view: str = '',
              current: dict[str, Any] | None = None) -> str:
    """
    The landing page: the schema, with the connection machinery in a menu bar above it.

    The connections list used to be the front door, which put a credential form between a
    person and their own data on every visit and left the schema one tab away. Here the
    schema is the document and a connection is something you switch, from a menu bar that
    behaves like one: File, Connection, Tools, Help. Nothing on this page opens a database.
    Every action that reaches one is an explicit menu item, and the two that read table data
    still go through their own consent page first.
    """
    identifier = str(active['id']) if active else ''
    populated = bool(active and active['last_snapshot'])
    first_note = 'Populate the structure first'

    switch = []
    for connection in connections:
        mark = '\u2713 ' if active and connection['id'] == active['id'] else '\u2007 '
        note = '' if connection['last_snapshot'] else 'no structure populated yet'
        switch.append(menu_action(f'/connections/{connection["id"]}/activate',
                                  f'{mark}{connection["name"]}', token, note=note))
    if not switch:
        switch.append(menu_disabled('No connections', 'Add one from the File menu'))

    file_menu = menu('File', [
        menu_link('/connections/new', 'New connection...'),
        menu_link('/connections', 'Manage connections...'),
        '<hr>',
        menu_link(view or '/view', 'Open the schema in a new tab', new_tab=True) if view
        else menu_disabled('Open the schema in a new tab', 'Nothing is populated yet'),
    ])
    connection_menu = menu('Connection', switch + ['<hr>'] + ([
        menu_action(f'/connections/{identifier}/test', 'Test connection', token),
        menu_link(f'/connections/{identifier}/edit', 'Edit connection...'),
        menu_action(f'/connections/{identifier}/delete', 'Delete connection', token,
                    note='Removes its saved credentials and populated structure'),
    ] if active else [menu_disabled('Test connection', 'No connection selected')]))
    tools_menu = menu('Tools', [
        menu_action(f'/connections/{identifier}/introspect', 'Populate structure', token,
                    note='Reads catalog metadata only') if active
        else menu_disabled('Populate structure', 'No connection selected'),
        menu_link(f'/connections/{identifier}/measure', 'Measure row counts...',
                  note='Queries your tables; asks first') if populated
        else menu_disabled('Measure row counts...', first_note),
        menu_link(f'/connections/{identifier}/statistics', 'Gather column statistics...',
                  note='Reads column values; asks first') if populated
        else menu_disabled('Gather column statistics...', first_note),
        '<hr>',
        # Asks about the server rather than the data, so it needs no structure first.
        menu_link(f'/connections/{identifier}/activity', 'Query time and locks...',
                  note='Reads server views only; stores nothing') if active
        else menu_disabled('Query time and locks...', 'No connection selected'),
    ])
    help_menu = menu('Help', [
        '<small>Credentials are encrypted with a key held only on this machine. Nothing is '
        'uploaded, exported or sent anywhere by any action here.</small>',
        '<small>Populating reads catalog metadata and queries no table. Row counts and column '
        'statistics are separate steps because each one queries your tables.</small>',
        '<small>A missing row count stays unknown. It is never shown as zero and never stood '
        'in for by another number.</small>',
    ])

    if active:
        where = f'{active["username"]}@{active["host"]}:{active["port"]}/{active["database"]}'
        tables = (f' \u00b7 {current["tables"]} tables'
                  if current and current.get('connection_id') == active['id'] else '')
        status = (f'<span title="{E(where)}"><strong>{E(str(active["name"]))}</strong>'
                  f'{E(tables)}</span>')
        if populated:
            status += f'<span>populated {E(str(active["last_snapshot"]))}</span>'
        else:
            status += '<span>not populated</span>'
    else:
        status = '<span>No connection selected</span>'

    if not connections:
        body = """<div class="empty">
  <strong>No database connected</strong>
  Nothing here is your data yet. Add a connection and populate its structure to see your own schema.
  <p style="margin:18px 0 0"><a href="/connections/new"><button type="button" class="primary">Add a connection</button></a></p>
</div>"""
    elif view:
        body = f'<iframe class="workspace-frame" src="{E(view)}" title="Schema explorer"></iframe>'
    else:
        body = f"""<div class="empty">
  <strong>{E(str(active["name"])) if active else 'Nothing to show'} has no populated structure yet</strong>
  Populating reads the catalog: tables, columns, keys, constraints and indexes. It queries no table,
  so row counts stay unknown until you measure them from the Tools menu.
  <form method="post" action="/connections/{E(identifier)}/introspect" style="margin:18px 0 0;background:0;border:0;padding:0">
    {csrf_field(token)}<button type="submit" class="primary">Populate structure</button></form>
</div>"""

    return document('Workspace', f"""<nav class="menubar" aria-label="Application menu">
  <span class="menubar-brand">Backend Buddy</span>
  {file_menu}
  {connection_menu}
  {tools_menu}
  {help_menu}
  <span class="menubar-status">{status}</span>
</nav>
{f'<div class="workspace-notice">{notice(message, kind)}</div>' if message else ''}
<div class="workspace">
{body}
</div>""", body_class='app', frame_src=True)


def activity_consent(connection: dict[str, Any], *, token: str, message: str = '', kind: str = '',
                     statement_timeout_ms: int, top_statements: int, max_sessions: int,
                     text_cap: int, artifact_ready: bool = False,
                     current: dict[str, Any] | None = None) -> str:
    """
    State what reading the server's activity does before it runs.

    Lighter than the other two consent pages, and it says so: this reads server views and no
    table, so nothing from inside a row of yours can appear on it. What it does have to say
    plainly is which statement text is shown and which is not, because "query text" sounds
    like one thing and is really two.
    """
    body = f"""{notice(message, kind)}
<h2>Query time and locks</h2>
<p class="hint">{E(connection['name'])} &middot; {E(connection['username'])}@{E(connection['host'])}:{E(connection['port'])}/{E(connection['database'])}</p>

<div class="consent">
  <strong>This reads what the server is doing. It reads no table of yours.</strong>
  <p>What runs, exactly:</p>
  <ul>
    <li><code>pg_stat_activity</code>: the sessions connected to this database &mdash; state, wait
        event, age, and which sessions stand in front of which, from
        <code>pg_blocking_pids()</code>.</li>
    <li><code>pg_locks</code>: which relations are held, in which mode, and whether the lock was
        granted or is still being waited for.</li>
    <li><code>pg_stat_statements</code>: cumulative timing per statement, <strong>if that
        extension is installed</strong>. When it is not, this page says so rather than showing
        an empty table.</li>
  </ul>
  <p>What is shown, and what is withheld:</p>
  <ul>
    <li><strong>No statement text from a live session.</strong> <code>pg_stat_activity.query</code>
        holds the statement as it was typed, literals and all, so this page never selects that
        column. A session is identified by process id, state, age and the relations it holds.</li>
    <li>Statement text from <code>pg_stat_statements</code> <strong>is</strong> shown: there the
        server has already replaced the constants with <code>$1</code> placeholders. It is
        truncated to {text_cap} characters even so.</li>
    <li>The top {top_statements} statements by total time, and up to {max_sessions} sessions.</li>
  </ul>
  <p>The bounds:</p>
  <ul>
    <li>{statement_timeout_ms // 1000} seconds per query, in a read-only session closed when the
        read ends.</li>
    <li><strong>Nothing is written.</strong> No snapshot changes, no file is created, and the
        report exists only on the page it is drawn into. Read it again whenever you like.</li>
  </ul>
  <p class="hint">Locks are this instant and not a history. Statement timing is cumulative since
     the extension was last reset or the server started, which is rarely the period you have in
     mind when you ask what is slow.</p>
</div>

<div class="actions" style="margin-top:20px">
  <form method="post" action="/connections/{E(connection['id'])}/activity">{csrf_field(token)}
    <button type="submit" class="primary">Read activity now</button></form>
  <a href="/"><button type="button">Cancel</button></a>
</div>
"""
    return shell('Query time and locks', body, artifact_ready=artifact_ready, current=current)


def age(value: Any) -> str:
    """An age a person reads, or the unknown it actually is. An idle session has no query age."""
    if value is None:
        return '<span class="idle">unknown</span>'
    seconds = float(value)
    if seconds < 90:
        return f'{seconds:.1f}s'
    if seconds < 5400:
        return f'{seconds / 60:.1f}m'
    return f'{seconds / 3600:.1f}h'


def activity_report(connection: dict[str, Any], report: dict[str, Any], *, token: str,
                    message: str = '', kind: str = '', artifact_ready: bool = False,
                    current: dict[str, Any] | None = None) -> str:
    """
    The report: holds first, then what is running, then cumulative statement timing.

    Holds come first because they are the thing that is wrong right now. Statement timing is
    cumulative and will still be there in an hour; a session waiting behind another will not.
    """
    summary = report['summary']
    chips = ' '.join(
        f'<span class="badge{" bad" if bad else ""}">{E(label)}: {E(str(value))}</span>'
        for label, value, bad in (
            ('Sessions', summary['sessions'], False),
            ('Active', summary['active'], False),
            ('Blocked', summary['blocked'], summary['blocked'] > 0),
            ('Idle in transaction', summary['idle_in_transaction'],
             summary['idle_in_transaction'] > 0),
        ))

    blocked = [session for session in report['sessions'] if session['blocked_by']]
    if blocked:
        rows = ''.join(
            '<tr><td><strong>' + E(session['pid']) + '</strong>'
            '<div class="hint" style="margin:4px 0 0">' + E(session['state'])
            + (' &middot; ' + E(session['wait']) if session['wait'] else '') + '</div></td>'
            '<td>' + age(session['query_seconds']) + '</td>'
            '<td>' + E(', '.join(session['waiting_for']) or 'not a relation lock') + '</td>'
            '<td>' + E(', '.join(str(pid) for pid in session['blocked_by'])) + '</td></tr>'
            for session in blocked)
        holds_block = ('<table><thead><tr><th>Waiting session</th><th>Waiting</th>'
                       '<th>On</th><th>Behind</th></tr></thead><tbody>' + rows
                       + '</tbody></table>')
    else:
        holds_block = ('<p class="hint">No session in this database is waiting on another right '
                       'now. Locks are an instant and not a history: a hold that cleared a second '
                       'ago leaves nothing here.</p>')

    idle = [session for session in report['sessions']
            if session['state'].startswith('idle in transaction')]
    if idle:
        rows = ''.join(
            '<tr><td><strong>' + E(session['pid']) + '</strong>'
            '<div class="hint" style="margin:4px 0 0">' + E(session['user'])
            + (' &middot; ' + E(session['application']) if session['application'] else '')
            + '</div></td>'
            '<td>' + age(session['xact_seconds']) + '</td>'
            '<td>' + E(', '.join(session['holds']) or 'no relation lock held') + '</td></tr>'
            for session in idle)
        idle_block = (
            '<h3 class="activity-heading">Open transactions doing nothing</h3>'
            '<p class="hint">A session idle inside a transaction keeps every lock it has taken '
            'and pins the oldest transaction id, which is what stops cleanup. The age is the '
            'age of the transaction, not of a statement.</p>'
            '<table><thead><tr><th>Session</th><th>Transaction age</th><th>Holds</th></tr></thead>'
            '<tbody>' + rows + '</tbody></table>')
    else:
        idle_block = ''

    running = [session for session in report['sessions'] if session['state'] == 'active'][:12]
    if running:
        rows = ''.join(
            '<tr><td><strong>' + E(session['pid']) + '</strong>'
            '<div class="hint" style="margin:4px 0 0">' + E(session['user'])
            + (' &middot; ' + E(session['application']) if session['application'] else '')
            + '</div></td>'
            '<td>' + age(session['query_seconds']) + '</td>'
            '<td>' + E(session['wait'] or 'running') + '</td>'
            '<td>' + E(', '.join(session['holds']) or 'none') + '</td></tr>'
            for session in running)
        running_block = ('<table><thead><tr><th>Session</th><th>Running for</th>'
                         '<th>Waiting on</th><th>Holds</th></tr></thead><tbody>' + rows
                         + '</tbody></table>')
    else:
        running_block = '<p class="hint">Nothing is running in this database at this instant.</p>'

    statements = report['statements']
    if statements['available'] and statements['rows']:
        rows = ''.join(
            '<tr><td><code>' + E(entry['statement']) + ('...' if entry['truncated'] else '')
            + '</code></td>'
            '<td>' + E(f"{entry['calls']:,}") + '</td>'
            '<td>' + E(f"{entry['mean_ms']:,.2f}") + ' ms</td>'
            '<td>' + E(f"{entry['total_ms']:,.0f}") + ' ms'
            + ('' if entry['share'] is None else ' &middot; ' + E(f"{entry['share']:.0%}"))
            + '</td>'
            '<td>' + E('unknown' if entry['rows_per_call'] is None
                       else f"{entry['rows_per_call']:,}") + '</td></tr>'
            for entry in statements['rows'])
        scope = ('every statement on this server' if statements['scope'] == 'all'
                 else 'the statements of this role alone, because it is not a member of '
                      'pg_read_all_stats')
        statements_block = (
            '<p class="hint">Cumulative since pg_stat_statements was last reset or the server '
            'started, covering ' + E(scope) + '. A share is a share of these '
            + E(str(len(statements['rows']))) + ' rows and not of the whole workload, and a mean '
            'says nothing about the slowest call.</p>'
            '<table><thead><tr><th>Statement</th><th>Calls</th><th>Mean</th><th>Total</th>'
            '<th>Rows per call</th></tr></thead><tbody>' + rows + '</tbody></table>')
    elif statements['available']:
        statements_block = ('<p class="hint">pg_stat_statements is installed and has recorded '
                            'nothing yet.</p>')
    else:
        statements_block = ('<div class="consent"><strong>No statement timing</strong><p>'
                            + E(statements['reason']) + '</p></div>')

    body = f"""{notice(message, kind)}
<h2>Query time and locks</h2>
<p class="hint">{E(connection['name'])} &middot; {E(report['database'])} &middot;
{E(report['server_version'])} &middot; read {E(report['read_at'])}</p>
<p style="margin:0 0 18px">{chips}</p>

<h3 class="activity-heading" style="margin-top:0">Holds</h3>
{holds_block}
{idle_block}

<h3 class="activity-heading">Longest running now</h3>
{running_block}

<h3 class="activity-heading">Statement timing</h3>
{statements_block}

<div class="actions" style="margin-top:22px">
  <form method="post" action="/connections/{E(connection['id'])}/activity">{csrf_field(token)}
    <button type="submit" class="primary">Read again</button></form>
  <a href="/"><button type="button">Back to the workspace</button></a>
</div>
<p class="hint" style="margin-top:18px">Nothing on this page was written anywhere: not into the
snapshot, not into the explorer, not onto disk. Closing it is all it takes to be rid of it.
Statement text, where there is any, comes from pg_stat_statements, where the server has already
replaced the constants with placeholders; the text of a live session is never read.</p>
"""
    return shell('Query time and locks', body, artifact_ready=artifact_ready, current=current)
