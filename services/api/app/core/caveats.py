"""Canonical caveat wording for server-side messages (work package A02).

``docs/reference/caveats.md`` is the only place a caveat is authored (decision D8), and nobody
paraphrases one. The browser side has a generated mirror, ``packages/explorer/src/
caveat-strings.ts`` (C03); the API had none, which is open question 1 in the A02 brief. This
module is A02's answer, and the smallest one that keeps the rule true on the server: the two
caveats the platform surfaces from Python, quoted verbatim, with
``test_A02_caveats_quote_the_canonical_file`` comparing each string against the blockquote in
``caveats.md``. A paraphrase, a reflowed line, or a changed caveat file fails that test.

Only the ids a server-side surface actually shows are here. C14 is quoted in the OpenAPI
description of this API, which is the document a licensee's security reviewer reads before they
believe anything else about connections; C13 is quoted by the workspace and preferences surfaces
(A04) and is included now so that package has no reason to write its own copy.
"""

from __future__ import annotations

from typing import Final

__all__ = ['CAVEATS', 'C13', 'C14']

#: C13 Browser storage is convenience state; project isolation is mandatory.
C13: Final = (
    'Browser storage holds convenience state only: theme, layouts, camera, and local decisions. '
    'It is not a team review database. Every stored key is scoped by the project\'s stable key '
    '(and, where the data depends on the schema, by the snapshot fingerprint) so that different '
    'projects and environments never read or overwrite each other\'s state.'
)

#: C14 Never connect to production implicitly; read-only and explicitly selected only.
C14: Final = (
    'The product never discovers or connects to a database implicitly, and never to production '
    'to make a view look populated. Live access uses only a connection the user explicitly '
    'selected, opened read-only with bounded queries, and a metadata request never authorizes '
    'scanning customer rows.'
)

#: Every caveat this package quotes, by id.
CAVEATS: Final[dict[str, str]] = {'C13': C13, 'C14': C14}
