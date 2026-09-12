# The local product, on one port.
#
# The container serves the admin area, where a user adds a database connection and
# populates its structure, and the schema explorer that renders from it. A snapshot
# mounted at /snapshots is pre-rendered so an existing one shows immediately; otherwise
# the explorer appears once a connection is populated. Nothing shows sample data unless
# BB_SERVE_SAMPLE=1 asks for it, so a fixture is never mistaken for a real database.
#
# Row-level profiling (measured row counts and column statistics) is still a separate
# step outside this image. Work package A03 brings it into the same flow, alongside the
# metadata database, sessions and an audit trail; see
# docs/product-management/agent-briefs/WP-A03.md.

# ---------------------------------------------------------------------------
# Stage 1: bundle the nine React views with the locked dependency tree.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS bundle

WORKDIR /build

# Copy only what the bundle needs, so an unrelated edit does not invalidate this layer.
COPY packages/explorer/package.json packages/explorer/package-lock.json ./packages/explorer/
RUN npm --prefix packages/explorer ci --no-audit --no-fund

COPY packages/explorer/tsconfig.json packages/explorer/build.mjs ./packages/explorer/
COPY packages/explorer/src ./packages/explorer/src
RUN npm --prefix packages/explorer run build

# ---------------------------------------------------------------------------
# Stage 2: render the fallback sample. The renderer is standard library only,
# so this stage installs nothing.
# ---------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS render

WORKDIR /build

COPY skill ./skill
COPY fixtures/schemas ./fixtures/schemas
COPY --from=bundle /build/packages/explorer/dist ./skill/assets/extensions/dist

# Only the fallback sample. A mounted snapshot or a live connection always wins.
ARG SCHEMA=fixtures/schemas/medium.json

RUN python skill/scripts/build_explorer.py --schema "${SCHEMA}" --output /srv/sample.html \
    && test -s /srv/sample.html \
    && grep -q "connect-src 'none'" /srv/sample.html

# ---------------------------------------------------------------------------
# Stage 3: serve the admin area and the explorer. Carries the renderer, the
# admin tool and two pinned libraries; no source tree and no fixture beyond
# the sample already rendered.
# ---------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS serve

# A dedicated unprivileged account. Everything it serves is root-owned and read-only to
# it; /state is the only writable path and is created here with the right ownership,
# because a named volume would otherwise be root-owned and unwritable.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin viewer \
    && mkdir -p /state /snapshots \
    && chown 10001:10001 /state

# The fallback sample, rendered at build time.
COPY --from=render --chown=root:root --chmod=444 /srv/sample.html /srv/sample.html

# The renderer and its assets: the template, the icon data and the compiled view bundle.
COPY --from=render --chown=root:root /build/skill /app/skill

# The admin area: the connections form, the credential store, and the catalog
# introspection. This is what makes the container the product rather than a file server.
COPY --chown=root:root tools /app/tools
COPY --chown=root:root scripts/introspect_pg.py /app/scripts/introspect_pg.py
COPY --chown=root:root --chmod=555 deploy/entrypoint.sh /app/entrypoint.sh

# The admin area's third-party libraries, and the only ones in the serving stage: psycopg reaches
# the customer database, cryptography encrypts the stored password. Installed from the requirements
# file rather than named here, so the declaration the notices generator and pip-audit read is the
# same list the image installs. tools/ is copied above, so the file is already present.
RUN pip install --no-cache-dir --no-compile -r /app/tools/local_admin/requirements.txt \
    && find /usr/local -type d -name '__pycache__' -prune -exec rm -rf {} +

ENV BB_STATE_DIR=/state \
    PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 10001:10001
WORKDIR /app
EXPOSE 8080

# The admin area's own landing page is the probe: it exercises the credential store and
# the template rendering, so a container that answers here is genuinely usable. The
# start period allows for pre-rendering a large mounted snapshot first.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["/app/entrypoint.sh"]
