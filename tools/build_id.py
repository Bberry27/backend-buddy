"""
A fingerprint of everything that decides how a snapshot is drawn.

The rendered explorer is a build artifact, but it is written once -- when a connection is
populated -- and then kept. That is deliberate: re-rendering a mounted snapshot over a populated
one would silently replace the user's own database, which reads as "the explorer is showing old
data" and is very hard to attribute. But it also means upgrading the image leaves the served page
frozen at whatever the views looked like when the schema was populated, with nothing on screen to
say so. A new toolbar control simply never appears, and the natural conclusion is that the upgrade
did nothing.

Re-rendering the *same* snapshot with a newer renderer is a different act from replacing the
snapshot: the data does not change, only the code that draws it. Comparing this fingerprint tells
the two apart, so the page can be refreshed on start without touching what it is a picture of.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

# Everything whose contents change the rendered page: the renderer, the host template it fills,
# the icon geometry it inlines, and the compiled view bundle.
RENDER_INPUTS = (
    'skill/scripts/build_explorer.py',
    'skill/assets/explorer.html',
    'skill/assets/icons.json',
    'skill/assets/extensions/dist',
)


def render_inputs(root: Path) -> list[Path]:
    """Every existing file that feeds the renderer, in a stable order."""
    found: list[Path] = []
    for entry in RENDER_INPUTS:
        path = root / entry
        if path.is_file():
            found.append(path)
        elif path.is_dir():
            found.extend(sorted(item for item in path.rglob('*') if item.is_file()))
    return found


def build_id(root: Path | None = None) -> str:
    """
    A short, stable digest of the render inputs under `root`.

    Both the name and the bytes go into the digest, so adding or removing a file changes it even
    when the remaining contents do not. Absent inputs simply contribute nothing rather than
    raising: a partial tree should still produce a usable id, and the comparison that uses it
    treats "different" as "re-render", which is the safe direction.
    """
    base = root or Path(__file__).resolve().parent.parent
    digest = hashlib.sha256()
    for path in render_inputs(base):
        digest.update(str(path.relative_to(base)).replace('\\', '/').encode('utf-8'))
        digest.update(b'\0')
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


if __name__ == '__main__':
    print(build_id())
