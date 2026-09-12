Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Documentation map

**[HANDOFF.md](HANDOFF.md)** — current state, next step, and known gaps. Start here after a break.

This directory is the single source of product, architecture, engineering, and QA documentation for Backend Buddy. Documentation is part of every deliverable: a work package is not done until the documents it touches are updated (see `docs/engineering/definition-of-done.md` once D03 lands).

## Tree

A `(D0x)`, `(R0x)`, `(O0x)`, or `(Q0x)` marker names the work package that produces the file; it records provenance, not whether the file exists yet. Phase 0 packages land in parallel and out of order, so this tree is not an existence list: check the directory, and the docs lint (`scripts/docs_lint.mjs`, Q05) will assert the tree against the files on every PR. Files without a marker were carried over from the pre-repo baseline or authored with this map.

```
README.md  CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  LICENSE  THIRD_PARTY_NOTICES.md  AGENTS.md   (D06 / R00)
docs/README.md                                   this map, status legend, registry relationships
docs/business/business-case.md                   (D01) problem, market and alternatives (marked "to be validated"),
                                                 differentiators, stakeholders with RACI, personas P1-P6,
                                                 jobs-to-be-done, value proposition, licensing options, success metrics, risks
docs/business/product-vision-and-scope.md        (D01)
docs/architecture/overview.md                    (D02)
docs/architecture/data-model.md                  (D02)
docs/architecture/schema-graph-contract.md       (D02)
docs/architecture/drill-through-contract.md      (D02)
docs/architecture/security-architecture.md       (D02)
docs/architecture/deployment-architecture.md     (D02)
docs/architecture/legacy-handoff.md              baseline handoff carried over from the pre-repo project
docs/architecture/adr/0000-template.md           (D02) + ADR-0001..0008
docs/engineering/standards.md                    (D03)
docs/engineering/code-layout.md                  (D03)
docs/engineering/security-policy.md              (D03)
docs/engineering/testing-policy.md               (D03)
docs/engineering/accessibility-standards.md      (D03)
docs/engineering/definition-of-done.md           (D03)
docs/developer/setup.md, run.md, test.md, contribute.md, release.md   (D07)
docs/developer/troubleshooting.md                (D07; added beyond the plan's D07 list, to be accepted at G0)
docs/product-management/ctq.md                   (D04) CTQ registry CTQ-01..16
docs/product-management/roadmap.md               (D04) Now/Next/Later, gates G0-G2, MVP definition
docs/product-management/risk-register.md         (D04)
docs/product-management/traceability.md          (D04)
docs/product-management/agent-briefs/README.md   (D04/D08) + WP-*.md, one per build work package
docs/features/README.md                          Feature registry F01-F22
docs/features/_template.md                       14-section feature template
docs/features/F01..F22-<slug>.md                 (D05) one document per feature
docs/reference/caveats.md                        Caveats C01-C16, canonical wording
docs/reference/limits-and-caps.md                every numeric cap with source file:line
docs/reference/glossary.md                       terms used across the documentation
docs/releases/v<version>.md                      one per tagged release: what works, how to upgrade,
                                                 what ships unfinished, limits, security and licensing notes
docs/operations/deployment.md, rollback.md       (D06; runbook, backup/restore land with O01)
docs/qa/ux-testing-protocol.md                   (Q04)
docs/qa/release-checklist.md                     (Q04)
docs/qa/perf-baselines.md                        (Q01)
```

## Status header

Every document starts with one line:

```
Status: <draft|reviewed|approved> | Owner: <role> | Last verified against code: <commit or "pre-repo (YYYY-MM-DD)">
```

| Status | Meaning |
|---|---|
| draft | Written, not yet reviewed against the code by a second person. Facts may be incomplete. |
| reviewed | An adversarial review (facts vs. code, caveat wording, scope) has passed. |
| approved | Signed off at a gate (G0 for Phase 0 documents). Changes require a new review. |

"Last verified against code" names the commit the file:line citations were checked against. Until the repository has its first commit the value is `pre-repo (2026-09-07)`; the docs lint (`scripts/docs_lint.mjs`, Q05) will later require a commit hash. Owner is a role, never a person's name.

## The three registries

Traceability rests on three registries. Every feature document, ADR, work package, test name, and PR title refers to their ids.

| Registry | Ids | Where | What it answers |
|---|---|---|---|
| Features | F01-F22 | `docs/features/README.md` | What the product does, per surface, with its current state and intended behaviour (B-numbered). |
| Critical-to-quality | CTQ-01..16 | `docs/product-management/ctq.md` (D04) | How we know a feature is good enough: metric, target, measurement command, owner, gate. |
| Caveats | C01-C16 | `docs/reference/caveats.md` | What the product must never claim or do, so that analytical output is not mistaken for proof. |

How they relate:

- A feature document lists the CTQs it must satisfy (section 8 acceptance criteria are tagged with B# and CTQ ids) and the caveats it must surface (section 7).
- A CTQ names the features it measures; the gate (G0/G1/G2) at which it is enforced; and the test or script that measures it.
- A caveat names the views and documents that must show it ("Where surfaced" in `caveats.md`). UI copy for a caveat comes only from `packages/explorer/src/caveat-strings.ts` (C03 work package), which mirrors `caveats.md`.
- `docs/product-management/traceability.md` (D04) is the cross-matrix: feature x CTQ x caveat x work package x test.

## Canonical caveat wording

`docs/reference/caveats.md` is the only place a caveat is authored. Every other document and every UI string quotes a caveat by id and verbatim text; nobody paraphrases a caveat. Rationale: before this repository the sixteen caveats existed only as scattered paraphrases in `skill/references/*.md`, `skill/SKILL.md`, and UI copy, so "quote the legacy wording" was not possible. Decision D8 in the approved plan freezes the wording in `caveats.md` at gate G0; `caveats.test.ts` and the docs lint assert that docs and UI match it.

## Reference material and private data

- `docs/reference/limits-and-caps.md` lists every numeric cap in the code with a file:line citation, plus the MVP budgets that are targets rather than code.
- Line numbers are cited against `packages/explorer/src` and `packages/explorer/server`; `skill/assets/extensions/` is a generated copy and is never cited.
- The product's former example project is private and must never be named in this repository. Where a document has to refer to it, it says "the original private example". Example counts from that project are not used as fixtures or assertions (plan, "Private data").

## Conventions

- Markdown, one sentence per claim, no marketing language, no invented numbers. Unknown market, pricing, or performance facts are written as "to be validated".
- Paths are repo-relative. File:line citations are written `path:line` and are only valid for the commit named in the status header.
- Section 14 (implementation map and change log) of a feature document is appended on every merge that touches the feature (CTQ-13).
