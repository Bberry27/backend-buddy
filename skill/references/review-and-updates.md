# Schema Review and Refreshes

## Review Candidates, Not Verdicts

Normalization depends on functional dependencies and business semantics, not naming alone. Each candidate must identify its columns, observable evidence, why it might matter, and what would confirm or dismiss it.

| Category | Candidate | Validation |
| --- | --- | --- |
| Normalization | Numbered slots or repeated field groups | Determine whether slots represent the same repeating fact; address lines and origin/destination roles may intentionally differ. |
| Normalization | JSON/array or JSON-in-text payload | Check whether nested facts need independent joins, keys, constraints, or updates. Raw capture and immutable snapshots may be intentional. |
| Normalization | Copied entity attributes beside reference IDs | Verify the dependency and whether the values should remain historical or always match their source. |
| Normalization | Junction tuple uniqueness absent | Determine whether duplicates are meaningful history or line items. Include version/discriminator columns where business identity requires them. |
| Integrity | Name-based reference with no declared FK | Confirm the target entity, compatible types, unique target key, lifecycle, and orphan counts before proposing a constraint. |
| Integrity | PK or target missing | First rule out extraction gaps, mixins, helpers, incomplete scope, and migrations. |
| Index coverage | FK not a leading indexed column | Inspect actual indexes and query plans. This is not a normal-form violation. |

Avoid automatic schema mutations. The explorer may generate read-only, dialect-correct validation SQL but does not execute it. An inferred reference is not a reason to query or constrain an unrelated table. Support qualified identifier quoting, composite joins, and explicit null semantics. For unsupported dialects show evidence and next steps, leaving SQL absent.

## Refresh the Existing Artifact

- Re-extract the requested source/environment. Do not scrape the old visualization as the authoritative database schema.
- Preserve project branding, dark-mode preference, stable table IDs, customized domain mappings, output location, CSP, and sandbox wrappers. Never reuse one project's review storage key for another.
- Compare old/new canonical JSON for added/removed tables, columns, keys, and relationship targets. Report meaningful count changes and discovered extraction corrections; do not silently redefine totals.
- Use stable candidate signatures derived from evidence. A column/constraint/relationship change should not inherit an old resolved decision. Browser decisions are local; exports can be used as review records.
- Re-run affected extraction tests and browser workflows. Generate related catalogs or Word documents only when part of the requested deliverable, from the same canonical snapshot.
- Do not publish a different project merely because an inspiration artifact has a deployment ID. Reuse hosting only for the same artifact and within existing authorization.
