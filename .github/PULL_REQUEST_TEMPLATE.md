## Work package / Feature id

<!-- Required. One id per PR (R00, S01, F08, ...). The PR title must carry the same id as its Conventional Commit scope, e.g. `feat(F08): Schema City search`. -->

Work package / Feature id:

Brief: `docs/product-management/agent-briefs/WP-<id>.md`

## Summary

<!-- What changed and why, in two or three sentences. -->

## Definition of done

- [ ] Code stays inside the brief's `may-modify` globs; no generated path (`skill/assets/extensions/**`, `fixtures/**` outputs, `THIRD_PARTY_NOTICES.md`) edited by hand
- [ ] Tests added or updated, names prefixed with the F/CTQ id, green locally
- [ ] Feature doc sections 3 (current state) and 14 (implementation map) updated, or n/a: no feature affected
- [ ] Migration with a tested downgrade, or "none because ..."
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line provided below
- [ ] Security review recorded against `docs/architecture/security-architecture.md` (sections 3 and 9); the release security checklist arrives with D03
- [ ] Accessibility result recorded, or n/a: no UI change
- [ ] Performance number recorded where a budget exists (CTQ-09), or n/a
- [ ] `npm run guard` green; no private schemas, snapshots, screenshots, or QA reports added
- [ ] `npm test` green; `npm run build` run and the mirror committed if `packages/explorer` changed

## Release-note line

<!-- One user-facing line, prefixed with the id. -->

## Acceptance commands

<!-- Paste the acceptance commands from the brief and their results. -->

## Notes for reviewers

<!-- Risks, follow-ups, decisions that need confirming, screenshots of synthetic fixtures only. -->
