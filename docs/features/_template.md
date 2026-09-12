Status: draft | Owner: <role> | Last verified against code: pre-repo (2026-09-07)

# F## <Feature name>

| Field | Value |
|---|---|
| Status | existing \| partial \| planned (must match `docs/features/README.md`) |
| Owner | <role, never a person> |
| Surfaces | <view ids from `index.tsx`, host view ids, API routes, SPA routes> |
| CTQs | CTQ-xx, CTQ-yy (resolve in `docs/product-management/ctq.md`) |
| Caveats | Cxx, Cyy (resolve in `docs/reference/caveats.md`) |
| Last verified | <commit hash, or `pre-repo (YYYY-MM-DD)`> |

Instructions for authors (delete this paragraph in a real feature document): keep all fourteen headings, numbered and in this order, even when a section is a stub; the docs lint (Q05) checks heading count and order. A stub reads `Stubbed until <WP id>.` Planned features (F16-F22 in the plan) may stub sections 8-12 until their build work package. Every file:line citation must be valid at the commit named in "Last verified". Caveat text is quoted from `caveats.md`, never paraphrased.

## 1. Purpose

The point of the feature in two to four sentences: which question a user answers with it, and what it must never be mistaken for.

## 2. Driver

- **Persona**: P1 architect, P2 DBA/performance engineer, P3 backend developer, P4 data analyst, P5 engineering manager, P6 licensee security reviewer (definitions in `docs/business/business-case.md`).
- **Job to be done**: one sentence in the persona's words.
- **Business metric**: the success metric this feature moves (from the business case), or "to be validated".

## 3. Current state

Verified facts only, each with a `path:line` citation. What exists, what is partial, what is missing or broken. Cite `packages/explorer/src`, `packages/explorer/server`, `skill/assets/explorer.html`, `skill/scripts/build_explorer.py`. Never cite `skill/assets/extensions/` (generated copy).

## 4. Intended behaviour

Numbered behaviours, stable once published (never renumber; retire with "withdrawn").

### MVP

- **B1** ...
- **B2** ...

### Later

- **B10** ... (mark the roadmap item, e.g. L-02)

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

Which `Selection` fields the view honours (`selected.tableId`, `selected.columnId`, `selected.relationshipRef`, multi-select), how it highlights (`data-selected="true"`, `is-selected`), and what it does once per selection change (scroll, pan, fly-to).

### Outbound

Which callbacks the view emits and when: `onSelectTable`, `onSelectTables`, `onSelectColumn`, `onSelectRelationship`, `onNavigate(target)`. State the rule that a drill-through may prefill a live query but never runs it without a click.

### URL state

Which query keys the view reads and writes: shared keys `t c r ts f q d k` and the view-local `v.*` keys it registers (allowlisted, values capped at 200 characters). Which state is deliberately not in the URL (camera pose, pan offsets, loaded diff snapshots) and where it lives instead (`viewState` slice keyed by graph fingerprint).

## 6. Data contract dependencies

Fields of the SchemaGraph contract (`packages/contract/schema-graph.v1.json` after C01; `packages/explorer/src/types.ts` today) the feature reads, which are optional, and what the feature shows when they are absent. Name any `LiveConnection` method used (`profile`, `subtree`).

## 7. Caveats

For each caveat id in the header: the id, the canonical text quoted from `docs/reference/caveats.md`, and where in this feature it is shown (legend, tooltip, banner, inspector section, export footer).

> C0x: "<quoted canonical sentence>"
> Shown: ...

## 8. Acceptance criteria

Given/When/Then, each tagged with the behaviour and CTQ it proves.

- **AC1** (B1, CTQ-xx) Given ... When ... Then ...

## 9. Test expectations

Unit (node:test in `packages/explorer`, Vitest in `packages/web`, unittest in Python), component, e2e (`tests/e2e`), a11y (`tests/a11y`), perf (`tests/perf`), security (`tests/security`). Name test files and the id prefix (`F##`) tests carry. Fixtures used (`fixtures/schemas/*.json`).

## 10. Security and privacy

Inputs the feature accepts and how they are validated; what it renders from untrusted data; what it stores (browser storage keys, server tables); what it exports and which fields are stripped by default (`sampleValues`, string min/max); which CTQ-07 checks apply.

## 11. Performance budget

Budgets from `docs/reference/limits-and-caps.md` that apply (bundle chunk, TTI on the medium fixture, frame time, API p95) and the caps the feature enforces itself, each with its file:line.

## 12. Accessibility

Keyboard model, roles and names, live regions, reduced motion, colour independence, the flat or text alternative for any canvas or WebGL surface (C16), and which axe runs cover it (CTQ-11).

## 13. Open questions

Numbered, each with an owner role and the gate by which it must be answered.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/<View>.tsx` |
| Logic | `packages/explorer/src/<view>-logic.ts` |
| Styles | `packages/explorer/src/<View>.css` |
| Tests | ... |

### Change log

Appended on every merge that touches the feature (CTQ-13). Newest first.

| Date | PR | WP | Change |
|---|---|---|---|
| YYYY-MM-DD | #n | W0x | ... |
