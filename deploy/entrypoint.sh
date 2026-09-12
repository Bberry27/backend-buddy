#!/bin/sh
# One entry point for the whole local product: the admin area where connections are added,
# and the schema explorer it renders, on a single port.
#
# The admin area is the landing page. It serves:
#   /        connections, with the form to add one
#   /view    the schema explorer for whichever snapshot is current
#
# A snapshot mounted at /snapshots is rendered on start so a user who already has one sees
# it immediately; otherwise the explorer appears once a connection is populated. The
# bundled sample is served only when explicitly asked for, so nobody mistakes a fixture
# for their own database.
set -eu

STATE_DIR=${BB_STATE_DIR:-/state}
DROP=/snapshots
SAMPLE=/srv/sample.html
PORT=${PORT:-8080}

mkdir -p "$STATE_DIR"

# Pre-render a mounted snapshot so the explorer is available before any connection exists.
# The admin area re-renders after each populate, so this only covers the first page load.
if [ -z "${BB_SCHEMA:-}" ] && [ -d "$DROP" ]; then
    found=$(find "$DROP" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort | head -1 || true)
    [ -n "$found" ] && BB_SCHEMA="$found" && export BB_SCHEMA
fi

# The rendered page is a build artifact kept across restarts, so an upgraded image leaves it
# frozen at whatever the views looked like when the schema was populated: a new control simply
# never appears and the upgrade looks like it did nothing. Re-rendering the same snapshot with a
# newer renderer is not the same act as replacing the snapshot -- the data is untouched, only the
# code that draws it is newer -- so it is safe here, and only here.
BUILD_ID=$(python /app/tools/build_id.py 2>/dev/null || echo unknown)
POPULATED=$(ls -1t "$STATE_DIR"/snapshots/*.json 2>/dev/null | head -1 || true)
RENDERED_WITH=$(cat "$STATE_DIR/view.build" 2>/dev/null || echo none)

if [ -s "$STATE_DIR/view.html" ] && [ -n "$POPULATED" ] && [ "$RENDERED_WITH" != "$BUILD_ID" ] \
        && [ "$BUILD_ID" != "unknown" ]; then
    echo "the views changed since this page was rendered ($RENDERED_WITH -> $BUILD_ID)"
    echo "  re-rendering your populated schema; the data is unchanged, only the interface"
    if python /app/skill/scripts/build_explorer.py --schema "$POPULATED" \
            --output "$STATE_DIR/view.html"; then
        printf '%s' "$BUILD_ID" > "$STATE_DIR/view.build"
        echo "  the schema explorer is up to date at /view"
    else
        echo "WARNING: could not re-render the populated snapshot; the previous page is kept." >&2
    fi
fi

if [ -s "$STATE_DIR/view.html" ] && [ "${BB_RERENDER:-0}" != "1" ]; then
    # A populated connection already produced this. Pre-rendering a mounted file over it
    # would silently replace the user's own database with whatever sits in /snapshots,
    # which reads as "the explorer is showing old data" and is very hard to attribute.
    # BB_RERENDER=1 forces the mounted snapshot to win.
    echo "keeping the schema already populated in $STATE_DIR"
    echo "  a snapshot in /snapshots is NOT pre-rendered over it; set BB_RERENDER=1 to override"
elif [ -n "${BB_SCHEMA:-}" ] && [ -r "${BB_SCHEMA}" ]; then
    echo "pre-rendering the mounted snapshot: $BB_SCHEMA"
    if python /app/skill/scripts/build_explorer.py --schema "$BB_SCHEMA" \
            --output "$STATE_DIR/view.html"; then
        echo "the schema explorer is ready at /view"
    else
        echo "WARNING: $BB_SCHEMA did not satisfy the schema contract; see above." >&2
        echo "         The admin area still starts; add a connection instead." >&2
    fi
elif [ "${BB_SERVE_SAMPLE:-0}" = "1" ]; then
    echo "serving the bundled SAMPLE schema because BB_SERVE_SAMPLE=1"
    echo "  this is synthetic data, not your database"
    cp "$SAMPLE" "$STATE_DIR/view.html"
else
    echo "no snapshot yet: open the admin area and add a database connection"
fi

echo "listening on 0.0.0.0:$PORT (published to the host loopback by compose)"

# --allowed-host covers the Host header a browser sends through a published port, which
# is the host's address and not the container's.
exec python -m tools.local_admin.server \
    --bind 0.0.0.0 \
    --port "$PORT" \
    --state-dir "$STATE_DIR" \
    --allowed-host "127.0.0.1:${BB_PUBLISHED_PORT:-$PORT}" \
    --allowed-host "localhost:${BB_PUBLISHED_PORT:-$PORT}" \
    --allowed-host "host.docker.internal:${BB_PUBLISHED_PORT:-$PORT}"
