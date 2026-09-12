"""Serving the built SPA (work package A02; the SPA is W01).

Two things are worth testing before there is an SPA to serve: that a path cannot escape the
directory, and that an unknown path answers differently to a browser and to a fetch. Both are
behaviour A02 owns whatever W01 later builds.

The fixture writes a two-file "build" into a temporary directory and points ``BB_STATIC_DIR``
at it, so the case does not depend on ``packages/web/dist`` existing.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from app.core.http import SPA_CSP

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402

_BUILD = Path(tempfile.mkdtemp(prefix='backend-buddy-spa-')) / 'dist'
_BUILD.mkdir(parents=True, exist_ok=True)
(_BUILD / 'index.html').write_text('<!doctype html><title>shell</title>', encoding='utf-8')
(_BUILD / 'assets').mkdir(exist_ok=True)
(_BUILD / 'assets' / 'app-abc123.js').write_text('console.log(1)', encoding='utf-8')
_OUTSIDE = _BUILD.parent / 'secret.txt'
_OUTSIDE.write_text('not for the browser', encoding='utf-8')


class ServedSpaTests(ApiTestCase):
    overrides = {'BB_STATIC_DIR': str(_BUILD)}

    def test_A02_the_shell_is_served_with_the_strict_csp(self) -> None:
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('shell', response.text)
        self.assertEqual(response.headers['content-security-policy'], SPA_CSP)
        self.assertEqual(response.headers['cache-control'], 'no-cache, must-revalidate')

    def test_A02_a_hashed_asset_is_cacheable_forever(self) -> None:
        response = self.client.get('/assets/app-abc123.js')
        self.assertEqual(response.status_code, 200)
        self.assertIn('immutable', response.headers['cache-control'])

    def test_A02_a_client_side_route_falls_back_to_the_shell(self) -> None:
        response = self.client.get('/w/some-workspace/p/project', headers={'Accept': 'text/html'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('shell', response.text)

    def test_A02_an_unknown_path_is_a_json_404_for_a_fetch(self) -> None:
        """Answering an XHR with a page of HTML is how a mistyped endpoint wastes an afternoon."""
        response = self.client.get('/nope', headers={'Accept': 'application/json'})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()['error']['code'], 'not_found')

    def test_A02_a_path_cannot_escape_the_static_root(self) -> None:
        for candidate in (
            '/../secret.txt',
            '/assets/../../secret.txt',
            '/%2e%2e/secret.txt',
            '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
        ):
            with self.subTest(path=candidate):
                response = self.client.get(candidate, headers={'Accept': 'application/json'})
                self.assertNotEqual(response.status_code, 200)
                self.assertNotIn('not for the browser', response.text)


class MissingBuildTests(ApiTestCase):
    overrides = {'BB_STATIC_DIR': str(_BUILD.parent / 'absent')}

    def test_A02_without_a_build_the_api_still_works(self) -> None:
        """A02 serves whatever ``packages/web/dist`` contains, including nothing."""
        self.assertEqual(self.client.get('/').status_code, 404)
        self.assertEqual(self.client.get('/healthz').status_code, 200)


if __name__ == '__main__':
    unittest.main()
