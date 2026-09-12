"""RBAC completeness, the role ladder, and the IDOR negatives (A02; CTQ-07; frozen contracts).

``test_rbac_matrix`` is the case the CTQ registry names, and it is the reason the declaration and
the enforcement are the same object (:mod:`app.auth.rbac`): it walks the assembled application and
fails on a route that declares nothing. Adding a router without a role therefore breaks this suite
rather than shipping an unguarded endpoint.

``test_A02_idor_returns_404`` is the other named case. Every cross-workspace identifier answers
404 -- never 403 -- because a 403 confirms that the id exists, which is the one fact a
cross-tenant probe is looking for.

The matrix is printed by ``test_rbac_matrix`` when it is run verbosely, and the same declarations
are written into ``openapi.json`` as ``x-backend-buddy-role``, so a reviewer can read the matrix without
running anything.
"""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path

from starlette.routing import Route

from app.auth.rbac import (
    AUTHENTICATED,
    DECLARATIONS,
    PUBLIC,
    ROLE_LADDER,
    PublicRoute,
    RoleRequirement,
    declaration_of,
    route_declarations,
)
from app.models import WORKSPACE_ROLES

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.helpers import ApiTestCase  # noqa: E402


class RbacDeclarationTests(unittest.TestCase):
    def test_A02_role_ladder_matches_the_data_model(self) -> None:
        """``owner > admin > reviewer > viewer``, and the same four values as the check constraint."""
        self.assertEqual(ROLE_LADDER, ('viewer', 'reviewer', 'admin', 'owner'))
        self.assertEqual(set(ROLE_LADDER), set(WORKSPACE_ROLES))
        self.assertEqual(DECLARATIONS, (PUBLIC, AUTHENTICATED, *ROLE_LADDER))

    def test_A02_declarations_describe_themselves(self) -> None:
        """The matrix output and any failure message name the declaration they found."""
        self.assertEqual(repr(PublicRoute()), 'PublicRoute()')
        self.assertIn('admin', repr(RoleRequirement('admin')))

    def test_A02_a_route_without_a_dependency_graph_declares_nothing(self) -> None:
        """A plain Starlette route -- a mount, say -- is undeclared, and the matrix says so."""
        plain = Route('/legacy', endpoint=lambda request: None)
        self.assertIsNone(declaration_of(plain))
        self.assertEqual(route_declarations([plain]), [('GET', '/legacy', None)])

    def test_A02_require_role_refuses_a_nonsense_declaration(self) -> None:
        for candidate in ('public', 'superuser', 'Owner', ''):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                RoleRequirement(candidate)


class RbacMatrixTests(ApiTestCase):
    def test_rbac_matrix(self) -> None:
        """Every route declares a role, and the matrix is the list this prints."""
        matrix = route_declarations(self.application.routes)
        self.assertGreater(len(matrix), 0, 'no routes were mounted')
        lines = [f'{method:7} {path:52} {declaration}' for method, path, declaration in matrix]
        print('\nRBAC matrix (route, method, role):\n' + '\n'.join(lines))
        undeclared = [f'{method} {path}' for method, path, declaration in matrix if declaration is None]
        self.assertEqual(
            undeclared,
            [],
            'every non-public route must declare a role through app.auth.rbac, and a public one '
            'must say so explicitly',
        )
        for method, path, declaration in matrix:
            with self.subTest(route=f'{method} {path}'):
                self.assertIn(declaration, DECLARATIONS)

    def test_A02_matrix_covers_the_expected_routes(self) -> None:
        """The route set itself, so a route that disappears is as loud as one that appears."""
        matrix = {
            (method, path): declaration
            for method, path, declaration in route_declarations(self.application.routes)
        }
        expected = {
            ('GET', '/healthz'): 'public',
            ('GET', '/readyz'): 'public',
            ('POST', '/auth/login'): 'public',
            ('POST', '/auth/logout'): 'authenticated',
            ('POST', '/auth/sessions/revoke-all'): 'authenticated',
            ('GET', '/auth/csrf'): 'authenticated',
            ('GET', '/users/me'): 'authenticated',
            ('GET', '/workspaces'): 'authenticated',
            ('POST', '/workspaces'): 'authenticated',
            ('GET', '/workspaces/{workspace_id}'): 'viewer',
            ('GET', '/workspaces/{workspace_id}/members'): 'viewer',
            ('POST', '/workspaces/{workspace_id}/members'): 'admin',
            ('PUT', '/workspaces/{workspace_id}/members/{user_id}'): 'admin',
            ('GET', '/workspaces/{workspace_id}/api-keys'): 'admin',
            ('POST', '/workspaces/{workspace_id}/api-keys'): 'admin',
            ('DELETE', '/workspaces/{workspace_id}/api-keys/{api_key_id}'): 'admin',
            ('GET', '/'): 'public',
            ('GET', '/{spa_path:path}'): 'public',
        }
        self.assertEqual(matrix, expected)

    def test_A02_router_mounting_preserves_declarations(self) -> None:
        """The prefix and the router-level dependency survive :func:`app.main._mount`.

        FastAPI bakes both into each route as it is declared, which is what makes mounting by
        extending the route table equivalent to ``include_router`` here (see ``app/main.py``).
        """
        paths = {path for _, path, _ in route_declarations(self.application.routes)}
        self.assertIn('/auth/login', paths, 'the router prefix was lost')
        self.assertIn('/workspaces/{workspace_id}/api-keys', paths)


class RoleEnforcementTests(ApiTestCase):
    def test_A02_a_viewer_may_read_but_not_administer(self) -> None:
        workspace_id, user_id, email = self.make_principal('viewer')
        client = self.new_client()
        _, token = self.login(email, client=client)
        self.assertEqual(client.get(f'/workspaces/{workspace_id}').status_code, 200)
        self.assertEqual(client.get(f'/workspaces/{workspace_id}/members').status_code, 200)
        self.assertEqual(client.get(f'/workspaces/{workspace_id}/api-keys').status_code, 403)
        created = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'nope', 'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(created.status_code, 403)
        self.assertEqual(created.json()['error']['code'], 'forbidden')

    def test_A02_an_admin_may_administer(self) -> None:
        workspace_id, _, email = self.make_principal('admin')
        client = self.new_client()
        _, token = self.login(email, client=client)
        self.assertEqual(client.get(f'/workspaces/{workspace_id}/api-keys').status_code, 200)
        created = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'ci', 'role': 'reviewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(created.status_code, 201, created.text)

    def test_A02_nobody_may_grant_a_role_above_their_own(self) -> None:
        """Otherwise admin and owner are the same role with different names."""
        workspace_id, _, admin_email = self.make_principal('admin')
        member = self.make_user()
        self.make_member(workspace_id, member, 'viewer')
        client = self.new_client()
        _, token = self.login(admin_email, client=client)
        response = client.put(
            f'/workspaces/{workspace_id}/members/{member}',
            json={'role': 'owner'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 403)
        key = client.post(
            f'/workspaces/{workspace_id}/api-keys',
            json={'name': 'escalate', 'role': 'owner'},
            headers=self.csrf(token),
        )
        self.assertEqual(key.status_code, 403)

    def test_A02_an_admin_may_not_demote_an_owner(self) -> None:
        workspace_id, owner_id, _ = self.make_principal('owner')
        admin_id = self.make_user()
        admin_email = self.email_of(admin_id)
        self.make_member(workspace_id, admin_id, 'admin')
        client = self.new_client()
        _, token = self.login(admin_email, client=client)
        response = client.put(
            f'/workspaces/{workspace_id}/members/{owner_id}',
            json={'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 403)

    def test_A02_the_last_owner_cannot_be_demoted(self) -> None:
        workspace_id, owner_id, email = self.make_principal('owner')
        client = self.new_client()
        _, token = self.login(email, client=client)
        response = client.put(
            f'/workspaces/{workspace_id}/members/{owner_id}',
            json={'role': 'admin'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['error']['code'], 'conflict')

    def test_A02_a_role_change_revokes_the_members_sessions(self) -> None:
        workspace_id, owner_id, owner_email = self.make_principal('owner')
        member_id = self.make_user()
        member_email = self.email_of(member_id)
        self.make_member(workspace_id, member_id, 'reviewer')

        member_client = self.new_client()
        self.login(member_email, client=member_client)
        self.assertEqual(member_client.get('/users/me').status_code, 200)

        owner_client = self.new_client()
        _, token = self.login(owner_email, client=owner_client)
        changed = owner_client.put(
            f'/workspaces/{workspace_id}/members/{member_id}',
            json={'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(
            member_client.get('/users/me').status_code,
            401,
            'a demoted session must not survive the decision that demoted it',
        )

    def test_A02_changing_your_own_role_rotates_your_session(self) -> None:
        """An owner who edits their own membership is not thrown out by their own click."""
        workspace_id, owner_id, email = self.make_principal('owner')
        second_owner = self.make_user()
        self.make_member(workspace_id, second_owner, 'owner')
        client = self.new_client()
        _, token = self.login(email, client=client)
        response = client.put(
            f'/workspaces/{workspace_id}/members/{owner_id}',
            json={'role': 'admin'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(client.get('/users/me').status_code, 200)

    def test_A02_an_api_key_never_exceeds_its_recorded_role(self) -> None:
        workspace_id, user_id, _ = self.make_principal('owner')
        viewer_key = self.make_api_key(workspace_id=workspace_id, user_id=user_id, role='viewer')
        headers = {'Authorization': f'Bearer {viewer_key}'}
        self.assertEqual(self.client.get(f'/workspaces/{workspace_id}', headers=headers).status_code, 200)
        self.assertEqual(
            self.client.get(f'/workspaces/{workspace_id}/api-keys', headers=headers).status_code,
            403,
            'a viewer key must not inherit its owner role',
        )


class IdorTests(ApiTestCase):
    def test_A02_idor_returns_404(self) -> None:
        """A workspace the caller is not a member of is absent, not forbidden."""
        theirs, _, _ = self.make_principal('owner')
        _, _, my_email = self.make_principal('owner')
        client = self.new_client()
        _, token = self.login(my_email, client=client)

        for method, path in (
            ('GET', f'/workspaces/{theirs}'),
            ('GET', f'/workspaces/{theirs}/members'),
            ('GET', f'/workspaces/{theirs}/api-keys'),
        ):
            with self.subTest(route=f'{method} {path}'):
                response = client.request(method, path)
                self.assertEqual(response.status_code, 404, response.text)
                self.assertEqual(response.json()['error']['code'], 'not_found')

        for method, path, body in (
            ('POST', f'/workspaces/{theirs}/members', {'email': my_email, 'role': 'viewer'}),
            ('POST', f'/workspaces/{theirs}/api-keys', {'name': 'x', 'role': 'viewer'}),
            ('PUT', f'/workspaces/{theirs}/members/{uuid.uuid4()}', {'role': 'viewer'}),
        ):
            with self.subTest(route=f'{method} {path}'):
                response = client.request(method, path, json=body, headers=self.csrf(token))
                self.assertEqual(response.status_code, 404, response.text)

    def test_A02_a_foreign_api_key_id_is_absent(self) -> None:
        """Even for an admin of *a* workspace, another workspace's key id is a 404."""
        theirs, their_user, _ = self.make_principal('admin')
        mine, _, my_email = self.make_principal('admin')
        self.make_api_key(workspace_id=theirs, user_id=their_user, role='viewer')
        foreign_id = self.api_key_ids(theirs)[0]
        client = self.new_client()
        _, token = self.login(my_email, client=client)
        response = client.delete(
            f'/workspaces/{mine}/api-keys/{foreign_id}',
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 404)

    def test_A02_workspace_listing_shows_only_your_own(self) -> None:
        theirs, _, _ = self.make_principal('owner')
        mine, _, my_email = self.make_principal('owner')
        client = self.new_client()
        self.login(my_email, client=client)
        listed = {entry['id'] for entry in client.get('/workspaces').json()}
        self.assertIn(str(mine), listed)
        self.assertNotIn(str(theirs), listed)


class WorkspaceCreationTests(ApiTestCase):
    def test_A02_creating_a_workspace_makes_you_its_owner(self) -> None:
        email = self.email_of(self.make_user())
        client = self.new_client()
        _, token = self.login(email, client=client)
        self.assertEqual(client.get('/workspaces').json(), [])
        created = client.post(
            '/workspaces',
            json={'slug': f'ws-{uuid.uuid4().hex[:8]}', 'name': 'My workspace'},
            headers=self.csrf(token),
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()['role'], 'owner')
        workspace_id = created.json()['id']
        self.assertEqual(client.get(f'/workspaces/{workspace_id}').status_code, 200)

    def test_A02_a_duplicate_slug_is_a_conflict(self) -> None:
        email = self.email_of(self.make_user())
        client = self.new_client()
        _, token = self.login(email, client=client)
        slug = f'ws-{uuid.uuid4().hex[:8]}'
        first = client.post('/workspaces', json={'slug': slug, 'name': 'One'}, headers=self.csrf(token))
        self.assertEqual(first.status_code, 201)
        second = client.post('/workspaces', json={'slug': slug, 'name': 'Two'}, headers=self.csrf(token))
        self.assertEqual(second.status_code, 409)

    def test_A02_a_malformed_slug_is_rejected(self) -> None:
        email = self.email_of(self.make_user())
        client = self.new_client()
        _, token = self.login(email, client=client)
        # The pattern is A01's frozen check constraint, ``^[a-z0-9][a-z0-9-]*$`` with a 64
        # character cap, so a trailing hyphen is legal and is deliberately not in this list.
        for slug in ('Has Capitals', '-leading', 'under_score', 'x' * 100, ''):
            with self.subTest(slug=slug):
                response = client.post(
                    '/workspaces',
                    json={'slug': slug, 'name': 'x'},
                    headers=self.csrf(token),
                )
                self.assertEqual(response.status_code, 422)


class MembershipTests(ApiTestCase):
    def test_A02_adding_a_member_needs_an_existing_account(self) -> None:
        workspace_id, _, owner_email = self.make_principal('owner')
        client = self.new_client()
        _, token = self.login(owner_email, client=client)
        response = client.post(
            f'/workspaces/{workspace_id}/members',
            json={'email': 'nobody-here@example.test', 'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 404)

    def test_A02_adding_a_member_grants_the_role(self) -> None:
        workspace_id, _, owner_email = self.make_principal('owner')
        newcomer_email = self.email_of(self.make_user())
        client = self.new_client()
        _, token = self.login(owner_email, client=client)
        response = client.post(
            f'/workspaces/{workspace_id}/members',
            json={'email': newcomer_email, 'role': 'reviewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()['role'], 'reviewer')
        again = client.post(
            f'/workspaces/{workspace_id}/members',
            json={'email': newcomer_email, 'role': 'viewer'},
            headers=self.csrf(token),
        )
        self.assertEqual(again.status_code, 409)


if __name__ == '__main__':
    unittest.main()
