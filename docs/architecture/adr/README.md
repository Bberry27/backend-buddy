Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Architecture decision records

One file per decision, numbered, never rewritten after acceptance (a superseding ADR gets a new number). Use `0000-template.md`. Status values: proposed, accepted, superseded by ADR-XXXX, deprecated. Every ADR carries the standard document status header on line 1 and its own ADR status in the metadata list. The docs lint (Q05) checks that every `ADR-*.md` appears in this index with a matching status.

| ADR | Title | ADR status | Decisions | Work packages |
|---|---|---|---|---|
| [ADR-0001](ADR-0001-monorepo-layout.md) | Monorepo layout | proposed | D7 (layout part) | R00, R01, C01, A01, O01 |
| [ADR-0002](ADR-0002-frontend-spa-and-iife-export-path.md) | Frontend stack with the esbuild IIFE kept as the artifact export path | proposed | D1 | C02, C03, W01, W02, W03, W05 |
| [ADR-0003](ADR-0003-backend-fastapi-and-contract-oracle.md) | FastAPI backend with a worker; JSON Schema plus `normalize()` as the contract oracle | proposed | D2, D3, D6 | C01, A01, A02, A03, A04 |
| [ADR-0004](ADR-0004-selection-and-routing-contract.md) | Selection and routing contract for drill-through | proposed | drill-through contract | C03, W02, W04, W05 |
| [ADR-0005](ADR-0005-auth-and-credential-encryption.md) | Local accounts, sessions, RBAC, API keys, envelope-encrypted connection secrets | proposed | D5 | A01, A02, A03, S03, Q02 |
| [ADR-0006](ADR-0006-deployment-topology-and-artifact-csp.md) | Single-tenant Docker Compose topology and the byte-identical artifact CSP | proposed | D4, D9 | O01, O02, O03, S01, S02, S03 |
| [ADR-0007](ADR-0007-private-data-and-fixture-policy.md) | Private-data and fixture policy | proposed | D7 (privacy part) | R00, R01, S02, Q05 |
| [ADR-0008](ADR-0008-testing-strategy.md) | Testing strategy | proposed | CTQ-12 and the browser matrix | S02, Q01, Q02, Q03, Q04, Q05, O02 |

Not yet written (decisions the plan defers): OIDC/SAML and multi-tenancy (L-08), additional dialects (L-03), observability stack (L-04), artifact host bridge (L-05), release signing and SBOM (L-07). Each gets an ADR when its work package is scheduled.

Note on numbering: the approved plan's prose refers to the drill-through contract as "ADR-0005"; the plan's enumerated ADR list, followed here, places it at ADR-0004 and auth at ADR-0005.
