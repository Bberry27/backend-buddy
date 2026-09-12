Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Releasing

How a version is cut from `main`. The first release, `0.1.0-alpha`, followed this procedure; its notes are [`docs/releases/v0.1.0-alpha.md`](../releases/v0.1.0-alpha.md) and its changelog section is `[0.1.0-alpha]`. `SECURITY.md` supports only `main`. Steps marked "after O01" or "after O02" depend on those work packages and are recorded so nobody improvises them.

## 1. Versioning

Semantic Versioning 2.0.0, as `CHANGELOG.md` states. While the major is `0`, minor versions may contain breaking changes and each is announced in the changelog's `Changed` or `Removed` section.

| Change | Bump |
|---|---|
| Breaking change to the SchemaGraph contract (`packages/contract/schema-graph.v1.json` once C01 lands; `contractVersion` major), the REST API, the Compose interface, or a migration that cannot be downgraded | major (minor while `0.x`) |
| New feature, new view, new dialect, additive contract field | minor |
| Bug fix, security fix without interface change, docs, dependency updates | patch |

The single source of the product version is the root `package.json` `version` field. `packages/explorer/package.json` carries its own `version` (`1.0.0` today) as an internal workspace version and is not the product version; whether to align it is an open question for the owner. Tags are `v<major>.<minor>.<patch>`. The artifact `dist/backend-buddy.html` and the skill do not carry a separate version today; the contract gains `contractVersion` with C01.

## 2. Pre-release checklist

On an up-to-date `main`, from a clean clone (this is what CI does at gate G1; `npm run restore` first):

```sh
npm run restore
npm run guard
npm test
npm run build && test -s dist/backend-buddy.html && grep -q "connect-src 'none'" dist/backend-buddy.html
npm run notices:check                                        # THIRD_PARTY_NOTICES.md matches the lockfile (R00)
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host    # counts derive from the embedded snapshot; needs playwright and pngjs (S02 pins them)
```

Also confirm: `security.yml` is green on `main` (gitleaks, `npm audit --omit=dev --audit-level=high`, pip-audit, notices drift); no open item in the Security section of `CHANGELOG.md` is required for this release, or the release notes say plainly that it is still open; the release checklist `docs/qa/release-checklist.md` (Q04) is complete once it exists; every document touched since the last release has a current "Last verified against code" value.

## 3. Promote the changelog

`CHANGELOG.md` follows Keep a Changelog 1.1.0. Release promotion is one commit on a release branch (`r00/release-0.2.0` style naming until a `release/` convention is agreed):

1. Rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>` and add a fresh empty `## [Unreleased]` above it.
2. Keep every line's id prefix; do not reword entries.
3. Move entries in the Security section that the release fixes from "scheduled" wording to `Fixed`, naming the work package that closed them; leave still-open findings in place with their work package.
4. Bump `version` in `package.json` in the same commit (`npm version <version> --no-git-tag-version` does this without tagging).
5. Write the release notes as `docs/releases/v<version>.md`, following the shape of `docs/releases/v0.1.0-alpha.md`: what works, how to upgrade, **what ships unfinished**, other limits, security and licensing notes, and the verification actually run. Anything a reader would be misled by if they demonstrated the build goes in the unfinished section, named. That file is also the GitHub release body.

Open the PR as `chore(R00): release <version>`; it goes through the normal review and CI. O02 adds a `release.yml` check that the tag's changelog section exists.

## 4. Tag

After the release PR is squash-merged:

```sh
git checkout main && git pull --ff-only
git tag -a v<version> -m "Backend Buddy v<version>"
git push origin v<version>
```

Annotated tags only; the tag message is the release title. Never move or delete a pushed tag; a bad release gets a new patch version.

Create the GitHub release from the tag with the release notes from step 3.5. Attach `dist/backend-buddy.html` built from `fixtures/schemas/medium.json` only if the release notes state that it is a fixture demonstration; never attach an artifact built from a private snapshot.

## 5. Image publishing: after O02

O01 delivers the multi-stage image (`deploy/Dockerfile`, non-root user `10001`, read-only rootfs, `HEALTHCHECK`) and O02 delivers `.github/workflows/release.yml`, which on a `v*` tag builds the image, checks that `CHANGELOG.md` has a section for the tag, and pushes to `ghcr.io/cesprototypers/backend-buddy:<version>`. Until O02 there is no image to publish and no manual push is performed. Once it exists: images are pushed only by the workflow from a tag, never from a workstation; the tag and the image version are identical; `docs/operations/deployment.md` names the tag operators pull.

Later hardening (L-07: Trivy gate, SBOM, cosign) is out of MVP scope.

## 6. Rollback

- Documentation and artifact releases today: revert the offending commit on `main` through a normal PR and cut a patch release; a previously tagged commit can always be rebuilt with `npm run build`.
- After O01/A01: rollback is "previous image tag plus Alembic downgrade", rehearsed in CI at CTQ-15 and written up in `docs/operations/rollback.md`. Every migration ships with a tested downgrade or an explicit "none because ...", so the downgrade path exists before it is needed.

## 7. Communication

Post the release notes wherever the team tracks work, with the tag, the changelog link, and any still-open security findings. Do not describe the release in market or pricing terms; those live in `docs/business/business-case.md` and are marked "to be validated" until confirmed.

## 8. Open questions for the owner

- Align `packages/explorer/package.json` `version` with the product version, or leave it as an internal workspace version?
- Branch naming for release PRs (`release/<version>` versus the work-package convention)?
- Is the first tag `v0.1.0` cut at gate G1 (bootstrap and hardening) or only at G2 (MVP)?
