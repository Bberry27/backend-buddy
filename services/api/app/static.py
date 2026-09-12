"""Serving the built SPA (work package A02; the SPA itself is W01).

``packages/web/dist`` is a Vite build: one ``index.html`` plus content-hashed assets. Three
decisions:

**Explicit routes, not a mount.** A Starlette ``Mount`` has no dependency graph, so it could not
declare a role and ``test_rbac_matrix`` would have nothing to read. Two ordinary routes, both
declaring ``public``, keep the rule "every route declares its role" literally true.

**No path escapes the root.** The requested path is resolved and checked with
``is_relative_to``, so ``../../etc/passwd`` -- and its encoded and symlinked variants, because the
check is on the resolved path -- answers 404. This is the one route family that turns a URL into a
file name, so it is the one place traversal can happen.

**The SPA fallback answers HTML requests only.** An unknown path from a browser navigation gets
``index.html``, because client-side routing owns the URL space. An unknown path from a fetch or a
curl gets a 404 in the API's own error shape: answering an XHR with a page of HTML is how a
mistyped endpoint turns into ten minutes of confusion.

Caching follows the build: a hashed asset is immutable for a year, ``index.html`` is never cached,
because it is the file that names the current hashes. The security-headers middleware
(:mod:`app.core.http`) gives the HTML response the strict SPA policy and leaves these
``Cache-Control`` values alone.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse

from app.auth.rbac import PUBLIC_ROUTE
from app.core.dependencies import SettingsDep
from app.core.errors import ApiError, ErrorCode

__all__ = ['DEFAULT_STATIC_DIR', 'INDEX_CACHE_CONTROL', 'router', 'static_root']

#: ``packages/web/dist`` relative to the repository root, which is three levels above ``app``.
DEFAULT_STATIC_DIR: Final = Path(__file__).resolve().parents[3] / 'packages' / 'web' / 'dist'

#: The shell names the current asset hashes, so it must never be cached.
INDEX_CACHE_CONTROL: Final = 'no-cache, must-revalidate'
#: A content-hashed asset can be cached forever: a new build has a new name.
ASSET_CACHE_CONTROL: Final = 'public, max-age=31536000, immutable'

router = APIRouter(include_in_schema=False, dependencies=[Depends(PUBLIC_ROUTE)])


def static_root(settings: SettingsDep) -> Path | None:
    """The directory the SPA is served from, or ``None`` when there is no build to serve."""
    root = settings.static_dir or DEFAULT_STATIC_DIR
    resolved = root.expanduser().resolve()
    return resolved if (resolved / 'index.html').is_file() else None


@router.get('/', summary='The SPA shell')
def index(settings: SettingsDep) -> FileResponse:
    """``index.html``, or 404 when no SPA has been built into the image."""
    return _index_response(static_root(settings))


@router.get('/{spa_path:path}', summary='An SPA asset, or the shell for a client-side route')
def asset(spa_path: str, request: Request, settings: SettingsDep) -> FileResponse:
    """One built file, the shell for an HTML navigation, or 404."""
    root = static_root(settings)
    if root is None:
        raise ApiError(ErrorCode.NOT_FOUND, detail='no SPA build is present')
    candidate = (root / spa_path).resolve()
    if candidate.is_file() and candidate.is_relative_to(root):
        return FileResponse(
            candidate,
            headers={
                'cache-control': (
                    INDEX_CACHE_CONTROL if candidate.name == 'index.html' else ASSET_CACHE_CONTROL
                )
            },
        )
    if 'text/html' in request.headers.get('accept', ''):
        return _index_response(root)
    raise ApiError(ErrorCode.NOT_FOUND, detail=f'no route and no asset for {spa_path!r}')


def _index_response(root: Path | None) -> FileResponse:
    """``index.html`` from ``root``, or the API's own 404."""
    if root is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            detail=(
                'no SPA build is present; the API serves whatever packages/web/dist contains '
                'and W01 builds it'
            ),
        )
    return FileResponse(root / 'index.html', headers={'cache-control': INDEX_CACHE_CONTROL})
